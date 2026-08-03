// Shared plumbing for SAML, OIDC, and LDAP authentication: settings reads,
// external-identity provisioning with a well-defined conflict policy, group
// mapping, and SSO session issuance.
import * as bcrypt from "bcryptjs";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "../db";
import {
  organizationMemberships,
  organizations,
  samlSettings,
  teamMemberships,
  teams,
  users,
} from "../db/schema";
import { getSettings } from "./settings";
import { log } from "./log";
import { apiURL, auditLog } from "./utils";
import { isUniqueConstraintError } from "./validation";

export type SsoProvider = "saml" | "oidc" | "ldap";

export type SsoIdentity = Readonly<{
  provider: SsoProvider;
  subject: string;
  username: string;
  email: string | null;
  /** True only when the provider asserts the address is verified (e.g.
   *  OIDC `email_verified`. SAML and LDAP identities are operator-verified
   *  and treated as verified.) */
  emailVerified?: boolean;
  /** Provider-level opt-in for attaching a new external identity by email. */
  allowEmailLinking?: boolean;
  displayName?: string | null;
}>;

export type SsoSettingsSnapshot = Readonly<{
  localAuthEnabled: boolean;
  samlEnabled: boolean;
  oidcEnabled: boolean;
  ldapEnabled: boolean;
}>;

function bool(value: unknown, fallback = false): boolean {  return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function strOr(value: unknown, fallback: string): string {
  return str(value) ?? fallback;
}

export async function ssoSettingsSnapshot(): Promise<SsoSettingsSnapshot> {
  const [general, saml, oidc, ldap] = await Promise.all([
    getSettings("general"),
    db.query.samlSettings.findFirst({ where: eq(samlSettings.id, "saml") }),
    getSettings("oidc"),
    ldapSettings(),
  ]);
  return {
    localAuthEnabled: bool(general["local-auth-enabled"], true),
    samlEnabled: saml?.enabled === true,
    oidcEnabled: bool(oidc.enabled),
    ldapEnabled: ldap.enabled,
  };
}

/** LDAP server configuration as persisted under the admin "ldap" settings group. */
export type LdapSettings = Readonly<{
  enabled: boolean;
  allowEmailLinking: boolean;
  host: string | null;
  port: number;
  encryption: "plain" | "starttls" | "ldaps";
  bindDn: string | null;
  bindPassword: string | null;
  baseDn: string | null;
  userFilter: string;
  attrUsername: string;
  attrEmail: string;
  attrDisplayName: string;
}>;

export async function ldapSettings(): Promise<LdapSettings> {
  const raw = await getSettings("ldap");
  const encryptionValue = typeof raw.encryption === "string" ? raw.encryption : "";
  const encryptionConfigured = ["plain", "starttls", "ldaps"].includes(encryptionValue);
  if (bool(raw.enabled) && !encryptionConfigured) {
    log.warn("LDAP settings are enabled without a valid encryption mode; LDAP login is disabled");
  }
  const encryption = encryptionConfigured
    ? encryptionValue as LdapSettings["encryption"]
    : "plain";
  const port = typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535
    ? raw.port
    : encryption === "ldaps" ? 636 : 389;
  return {
    enabled: bool(raw.enabled) && encryptionConfigured,
    allowEmailLinking: bool(raw["link-by-email"]),
    host: str(raw.host),
    port,
    encryption,
    bindDn: str(raw["bind-dn"]),
    bindPassword: str(raw["bind-password"]),
    baseDn: str(raw["base-dn"]),
    userFilter: strOr(raw["user-filter"], "(uid={{username}})"),
    attrUsername: strOr(raw["attr-username"], "uid"),
    attrEmail: strOr(raw["attr-email"], "mail"),
    attrDisplayName: strOr(raw["attr-display-name"], "cn"),
  };
}

/** A username is usable for auto-provisioned accounts when it survives sanitization. */
export function sanitizeUsername(value: string): string | null {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._-]/g, "");
  if (cleaned === "" || cleaned.length > 100) return null;
  return cleaned;
}

export function validEmail(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Raised when an external identity collides with an existing local account.
 * The caller renders a clear message; no account is silently taken over.
 */
export class SsoConflictError extends Error {
  public readonly provider: SsoProvider;
  public readonly username: string;

  constructor(provider: SsoProvider, username: string, message?: string) {
    super(message ?? (
      `Sign-in blocked: username "${username}" is already in use by a local account. `
      + "Rename the local account or change the identity provider username, then retry."
    ));
    this.provider = provider;
    this.username = username;
  }
}

/**
 * Provision or link a local account for an external identity.
 *
 * Conflict policy (applies to SAML, OIDC, and LDAP alike):
 *  1. Identity match — an account already carrying (provider, subject) wins.
 *  2. Email match — a verified email links the identity to the existing
 *     account only when the provider's link-by-email setting is enabled.
 *  3. Username match — if the username belongs to a DIFFERENT account,
 *     provisioning is refused with SsoConflictError. No silent takeover.
 *  4. Otherwise a new account is created with an unusable password hash, so
 *     the SSO identity can never authenticate with local credentials.
 */
export async function provisionSsoUser(identity: SsoIdentity): Promise<{
  user: typeof users.$inferSelect;
  created: boolean;
}> {
  const subject = identity.subject.trim();
  if (subject === "") {
    throw new SsoConflictError(
      identity.provider,
      identity.username,
      "Sign-in blocked: the identity provider did not return a stable subject identifier.",
    );
  }
  const username = sanitizeUsername(identity.username);
  if (username === null) {
    throw new SsoConflictError(
      identity.provider,
      identity.username,
      `Sign-in blocked: username "${identity.username}" does not contain any usable characters. `
      + "Change the identity provider username, then retry.",
    );
  }
  const email = validEmail(identity.email);

  const byIdentity = await db.query.users.findFirst({
    where: and(eq(users.ssoProvider, identity.provider), eq(users.ssoSubject, subject)),
  });
  if (byIdentity !== undefined) {
    if (byIdentity.email === null && email !== null
      && identity.emailVerified === true && identity.allowEmailLinking === true) {
      try {
        await db.update(users).set({ email }).where(and(
          eq(users.id, byIdentity.id),
          isNull(users.email),
          sql`NOT EXISTS (
            SELECT 1 FROM ${users} AS email_owner
            WHERE email_owner.id <> ${byIdentity.id}
              AND lower(email_owner.email) = ${email}
          )`,
        ));
      } catch (error: unknown) {
        if (!isUniqueConstraintError(error)) throw error;
      }
    }
    const refreshed = await db.query.users.findFirst({ where: eq(users.id, byIdentity.id) });
    if (refreshed === undefined) throw new Error("SSO user is unavailable");
    return { user: refreshed, created: false };
  }

  // Only link by email when the provider asserts the address is verified and
  // the site administrator explicitly enabled linking for that provider.
  // Attaching an external identity to an unverified-email account would let
  // an attacker take over a local account (including site admins) by signing
  // in with an address they can control. SAML and LDAP callers pass
  // emailVerified = true; OIDC derives it from the email_verified claim.
  if (email !== null && identity.emailVerified === true && identity.allowEmailLinking === true) {
    const byEmail = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${email}` });
    if (byEmail !== undefined) {
      const claimed = byEmail.ssoProvider !== null || byEmail.ssoSubject !== null;
      if (claimed) throw new SsoConflictError(identity.provider, username);
      const linked = await db.update(users)
        .set({ ssoProvider: identity.provider, ssoSubject: subject })
        .where(and(eq(users.id, byEmail.id), isNull(users.ssoProvider), isNull(users.ssoSubject)))
        .returning({ id: users.id });
      if (linked.length === 0) throw new SsoConflictError(identity.provider, username);
      const refreshed = await db.query.users.findFirst({ where: eq(users.id, byEmail.id) });
      if (refreshed === undefined) throw new Error("SSO user is unavailable");
      return { user: refreshed, created: false };
    }
  }

  const byUsername = await db.query.users.findFirst({ where: eq(users.username, username) });
  if (byUsername !== undefined) {
    // A user with the same external subject but a different identity record
    // cannot happen (unique index), so any hit here is a genuine conflict.
    const owner = byUsername.ssoProvider === null ? "a local account" : `an account linked to ${byUsername.ssoProvider}`;
    throw new SsoConflictError(
      identity.provider,
      username,
      `Sign-in blocked: username "${username}" is already in use by ${owner}. `
      + "Rename the existing account or change the identity provider username, then retry.",
    );
  }

  let insertEmail = identity.emailVerified === true ? email : null;
  if (insertEmail !== null && identity.allowEmailLinking !== true) {
    const emailOwner = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${email}` });
    if (emailOwner !== undefined) insertEmail = null;
  }

  const userId = `usr-${crypto.randomUUID()}`;
  // Deliberately malformed bcrypt value: bcrypt.compare returns false without
  // spending work deriving a password hash for an account that cannot use one.
  const unusableHash = `$disabled$${randomBytes(32).toString("base64url")}`;
  // Two parallel first logins can both pass the identity/username lookups and
  // both reach this insert; onConflictDoNothing makes the second one a no-op,
  // and the re-read below returns the winning row.
  await db.insert(users).values({
    id: userId,
    username,
    email: insertEmail,
    passwordHash: unusableHash,
    ssoProvider: identity.provider,
    ssoSubject: subject,
    isSiteAdmin: false,
  }).onConflictDoNothing();
  const raced = await db.query.users.findFirst({
    where: and(eq(users.ssoProvider, identity.provider), eq(users.ssoSubject, subject)),
  });
  if (raced === undefined) {
    const usernameCollision = await db.query.users.findFirst({ where: eq(users.username, username) });
    if (usernameCollision !== undefined) throw new SsoConflictError(identity.provider, username);
    if (email !== null) {
      const emailCollision = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${email}` });
      if (emailCollision !== undefined) throw new SsoConflictError(identity.provider, username);
    }
    throw new Error("Failed to provision SSO user");
  }
  if (raced.id !== userId) {
    // Another concurrent login created the identity; reuse that account.
    return { user: raced, created: false };
  }
  await auditLog("create", "users", userId, null, null, {
    source: `sso:${identity.provider}`,
    username,
  });
  return { user: raced, created: true };
}

/**
 * SAML group mapping: groups matching an organization's owners-team-saml-role-id
 * grant the owner role; groups matching existing team names grant team
 * membership; all SAML users of SAML-enabled organizations get basic membership.
 */
type SamlGroupMappingData = Readonly<{
  samlOrgs: readonly (typeof organizations.$inferSelect)[];
  memberships: readonly (typeof organizationMemberships.$inferSelect)[];
  orgTeams: readonly (typeof teams.$inferSelect)[];
  existingTeamIds: ReadonlySet<string>;
}>;

type SsoDatabase = Readonly<Parameters<Parameters<typeof db.transaction>[0]>[0]>;

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle's database client type is mutable by contract
async function loadSamlGroupMappingData(database: SsoDatabase, userId: string): Promise<SamlGroupMappingData> {
  const samlOrgs = await database.query.organizations.findMany({
    where: eq(organizations.samlEnabled, true),
  });
  const orgIds = samlOrgs.map((org): string => org.id);
  if (orgIds.length === 0) return { samlOrgs, memberships: [], orgTeams: [], existingTeamIds: new Set() };
  const [memberships, orgTeams] = await Promise.all([
    database.query.organizationMemberships.findMany({
      where: and(inArray(organizationMemberships.orgId, orgIds), eq(organizationMemberships.userId, userId)),
    }),
    database.query.teams.findMany({ where: inArray(teams.orgId, orgIds) }),
  ]);
  const teamIds = orgTeams.map((team): string => team.id);
  const existingTeamMemberships = teamIds.length === 0
    ? []
    : await database.query.teamMemberships.findMany({
      where: and(eq(teamMemberships.userId, userId), inArray(teamMemberships.teamId, teamIds)),
      columns: { teamId: true },
    });
  return {
    samlOrgs,
    memberships,
    orgTeams,
    existingTeamIds: new Set(existingTeamMemberships.map((membership): string => membership.teamId)),
  };
}

async function applySamlGroupMapping(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle's database client type is mutable by contract
  database: SsoDatabase,
  userId: string,
  groups: readonly string[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- mapping rows are readonly at the aggregate boundary
  mapping: SamlGroupMappingData,
): Promise<void> {
  const groupSet = new Set(groups.map((group): string => group.trim()).filter((group): boolean => group !== ""));
  const { samlOrgs, memberships, orgTeams, existingTeamIds } = mapping;
  const membershipByOrg = new Map(memberships.map((membership) => [membership.orgId, membership]));
  const teamsByOrg = new Map<string, typeof orgTeams[number][]>();
  for (const team of orgTeams) teamsByOrg.set(team.orgId, [...(teamsByOrg.get(team.orgId) ?? []), team]);
  const teamInserts: (typeof teamMemberships.$inferInsert)[] = [];
  const membershipInserts: (typeof organizationMemberships.$inferInsert)[] = [];
  for (const org of samlOrgs) {
    const existing = membershipByOrg.get(org.id);
    const isOwner = org.ownersTeamSamlRoleId !== null && groupSet.has(org.ownersTeamSamlRoleId);
    if (existing === undefined) {
      membershipInserts.push({
        id: `orgmem-${crypto.randomUUID()}`,
        orgId: org.id,
        userId,
        role: isOwner ? "owner" : "member",
        status: "active",
        // Mark the membership as SAML-managed so group pruning can later
        // remove or downgrade it without touching admin-granted rows.
        ssoSource: "saml",
      });
    } else if (isOwner && existing.role !== "owner" && existing.ssoSource === "saml") {
      // Preserve admin-granted provenance so pruning never removes the row.
      await database.update(organizationMemberships).set({ role: "owner" })
        .where(and(
          eq(organizationMemberships.orgId, org.id),
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.ssoSource, "saml"),
        ));
    }

    const matchedTeams = (teamsByOrg.get(org.id) ?? []).filter((team): boolean => team.ssoTeamId !== null
      ? groupSet.has(team.ssoTeamId)
      : groupSet.has(team.name));
    if (matchedTeams.length === 0) continue;
    const inserts = matchedTeams
      .filter((team): boolean => !existingTeamIds.has(team.id))
      .map((team): typeof teamMemberships.$inferInsert => ({
        id: `tmem-${crypto.randomUUID()}`,
        teamId: team.id,
        userId,
        createdAt: Date.now(),
        ssoSource: "saml",
      }));
    teamInserts.push(...inserts);
  }
  if (membershipInserts.length > 0) await database.insert(organizationMemberships).values(membershipInserts).onConflictDoNothing();
  if (teamInserts.length > 0) await database.insert(teamMemberships).values(teamInserts).onConflictDoNothing();
}

/**
 * Update SAML-managed org/team memberships to match the group set. Only rows
 * the SAML mapper created (ssoSource = 'saml') are ever removed or
 * downgraded; admin-granted memberships are left untouched. Called when the
 * same identity logs in with fewer groups. Managed organization memberships
 * are retained as members when their group disappears; only team memberships
 * are removed. Admin-granted memberships remain untouched.
 */
async function pruneSamlGroupMappings(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle's database client type is mutable by contract
  database: SsoDatabase,
  userId: string,
  groups: readonly string[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- mapping rows are readonly at the aggregate boundary
  mapping: SamlGroupMappingData,
): Promise<void> {
  const groupSet = new Set(groups.map((group): string => group.trim()).filter((group): boolean => group !== ""));
  const { samlOrgs, memberships, orgTeams } = mapping;
  const teamByOrg = new Map<string, typeof orgTeams[number][]>();
  for (const team of orgTeams) {
    const list = teamByOrg.get(team.orgId) ?? [];
    list.push(team);
    teamByOrg.set(team.orgId, list);
  }
  for (const org of samlOrgs) {
    const teamsForOrg = teamByOrg.get(org.id) ?? [];
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle rows are mutable by contract
    const matches = (team: Readonly<typeof teamsForOrg[number]>): boolean =>
      team.ssoTeamId !== null ? groupSet.has(team.ssoTeamId) : groupSet.has(team.name);
    const staleTeamIds = teamsForOrg.filter((team): boolean => !matches(team)).map((team): string => team.id);
    if (staleTeamIds.length > 0) {
      await database.delete(teamMemberships).where(and(
        eq(teamMemberships.userId, userId),
        inArray(teamMemberships.teamId, staleTeamIds),
        eq(teamMemberships.ssoSource, "saml"),
      ));
    }
    // Only SAML-mapper-created organization memberships are managed here.
    const membership = memberships.find((candidate): boolean => candidate.orgId === org.id);
    if (membership === undefined || membership.ssoSource !== "saml") continue;
    const isOwner = org.ownersTeamSamlRoleId !== null && groupSet.has(org.ownersTeamSamlRoleId);
    const matchedTeam = teamsForOrg.some(matches);
    if (isOwner || matchedTeam) {
      const role: "owner" | "member" = isOwner ? "owner" : "member";
      if (membership.role !== role) {
        await database.update(organizationMemberships).set({ role })
          .where(eq(organizationMemberships.id, membership.id));
      }
      continue;
    }
    if (membership.role !== "member") {
      await database.update(organizationMemberships).set({ role: "member" })
        .where(eq(organizationMemberships.id, membership.id));
    }
  }
}

export async function syncSamlGroupMappings(userId: string, groups: readonly string[]): Promise<void> {
  await db.transaction(async (database): Promise<void> => {
    const mapping = await loadSamlGroupMappingData(database, userId);
    await applySamlGroupMapping(database, userId, groups, mapping);
    // Pruning uses the single pre-apply mapping snapshot; a redundant role
    // update is harmless and converges SAML-managed rows in this transaction.
    await pruneSamlGroupMappings(database, userId, groups, mapping);
  });
}

const DUMMY_PASSWORD_HASH = "$2b$10$./PtU.lbOie2J8A136xCHebbWWXw66h5mpFJQiXmWzmuMNqYJVzgq";

/** Compare local passwords safely, including nonexistent and unusable accounts. */
export async function passwordMatches(password: string, passwordHash = DUMMY_PASSWORD_HASH): Promise<boolean> {
  try {
    return await bcrypt.compare(password, passwordHash);
  } catch {
    return false;
  }
}

/** HTML-escape a value for safe interpolation into rendered SSO pages. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

/** Simple HTML page used by the SAML/OIDC browser flows. */
export function ssoHtmlPage(
  title: string,
  message: string,
  options: Readonly<{ redirectUrl?: string; token?: string; error?: boolean }> = {},
): string {
  // Only same-origin relative redirects are allowed; absolute or scheme-relative
  // URLs are dropped so an attacker cannot inject an external navigation.
  const candidate = options.redirectUrl;
  const safeRedirect = candidate !== undefined
    && /^\/(?![/\\])/.test(candidate)
    && !/[\u0000-\u001F\u007F]/.test(candidate)
    ? candidate
    : undefined;
  const body = options.token !== undefined
    ? `<p id="sso-token">${escapeHtml(options.token)}</p><p>Copy this token and use it as your user token. It is shown only once.</p>`
    : `<p id="sso-message">${escapeHtml(message)}</p>`;
  const redirect = safeRedirect !== undefined
    ? `<p><a href="${escapeHtml(safeRedirect)}">Continue to Terrence</a></p>`
    : "";
  // The client redirects via <meta http-equiv="refresh">; no inline script is
  // used, so the CSP can keep script-src 'none'.
  const refresh = safeRedirect !== undefined
    ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(safeRedirect)}">`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${refresh}
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${body}
    ${redirect}
  </main>
</body>
</html>`;
}

export function ssoHtmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'none'; style-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- primitive/header union has no mutable state
export function appendSetCookies(response: Readonly<Response>, value: string | number | readonly string[] | undefined): void {
  if (Array.isArray(value)) {
    for (const cookie of value as readonly string[]) response.headers.append("Set-Cookie", cookie);
  } else if (value !== undefined) {
    response.headers.append("Set-Cookie", String(value));
  }
}

/** Base URL for the instance, used to derive ACS / callback / metadata URLs. */
export function ssoBaseUrl(request: Readonly<{ url: string }>): string {
  return apiURL(request, "");
}

// Re-export for route modules that only need the URL helper.
export { apiURL };
