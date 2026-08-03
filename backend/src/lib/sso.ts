// Shared plumbing for SAML, OIDC, and LDAP authentication: settings reads,
// external-identity provisioning with a well-defined conflict policy, group
// mapping, and SSO session issuance.
import * as bcrypt from "bcryptjs";
import { and, eq, inArray } from "drizzle-orm";
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
import { getSettings } from "../routes/admin";
import { apiURL, auditLog } from "./utils";

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

export async function ssoSettingsSnapshot(): Promise<SsoSettingsSnapshot> {
  const [general, saml, oidc, ldap] = await Promise.all([
    getSettings("general"),
    db.query.samlSettings.findFirst({ where: eq(samlSettings.id, "saml") }),
    getSettings("oidc"),
    getSettings("ldap"),
  ]);
  return {
    localAuthEnabled: bool(general["local-auth-enabled"], true),
    samlEnabled: saml?.enabled === true,
    oidcEnabled: bool(oidc.enabled),
    ldapEnabled: bool(ldap.enabled),
  };
}

/** LDAP server configuration as persisted under the admin "ldap" settings group. */
export type LdapSettings = Readonly<{
  enabled: boolean;
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
  const port = typeof raw.port === "number" && Number.isInteger(raw.port) ? raw.port : 389;
  const encryption = ["plain", "starttls", "ldaps"].includes(String(raw.encryption))
    ? String(raw.encryption) as LdapSettings["encryption"]
    : "plain";
  return {
    enabled: bool(raw.enabled),
    host: str(raw.host),
    port,
    encryption,
    bindDn: str(raw["bind-dn"]),
    bindPassword: str(raw["bind-password"]),
    baseDn: str(raw["base-dn"]),
    userFilter: typeof raw["user-filter"] === "string" && raw["user-filter"] !== ""
      ? raw["user-filter"]
      : "(uid={{username}})",
    attrUsername: typeof raw["attr-username"] === "string" && raw["attr-username"] !== "" ? raw["attr-username"] : "uid",
    attrEmail: typeof raw["attr-email"] === "string" && raw["attr-email"] !== "" ? raw["attr-email"] : "mail",
    attrDisplayName: typeof raw["attr-display-name"] === "string" && raw["attr-display-name"] !== "" ? raw["attr-display-name"] : "cn",
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
  const trimmed = value.trim();
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
 *     account (including local accounts; both sign-in methods then work).
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
    const updates: Partial<typeof users.$inferInsert> = {};
    if (byIdentity.email === null && email !== null && identity.emailVerified === true) updates.email = email;
    if (Object.keys(updates).length > 0) {
      await db.update(users).set(updates).where(eq(users.id, byIdentity.id));
    }
    const refreshed = await db.query.users.findFirst({ where: eq(users.id, byIdentity.id) });
    if (refreshed === undefined) throw new Error("SSO user is unavailable");
    return { user: refreshed, created: false };
  }

  // Only link by email when the provider asserts the address is verified.
  // Attaching an external identity to an unverified-email account would let
  // an attacker take over a local account (including site admins) by signing
  // in with an address they can control. SAML and LDAP callers pass
  // emailVerified = true; OIDC derives it from the email_verified claim.
  if (email !== null && identity.emailVerified === true) {
    const byEmail = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (byEmail !== undefined) {
      const claimed = byEmail.ssoProvider !== null && byEmail.ssoSubject !== null;
      if (claimed) throw new SsoConflictError(identity.provider, username);
      await db.update(users).set({ ssoProvider: identity.provider, ssoSubject: subject })
        .where(eq(users.id, byEmail.id));
      const refreshed = await db.query.users.findFirst({ where: eq(users.id, byEmail.id) });
      if (refreshed === undefined) throw new Error("SSO user is unavailable");
      return { user: refreshed, created: false };
    }
  }

  const byUsername = await db.query.users.findFirst({ where: eq(users.username, username) });
  if (byUsername !== undefined) {
    // A user with the same external subject but a different identity record
    // cannot happen (unique index), so any hit here is a genuine conflict.
    throw new SsoConflictError(identity.provider, username);
  }

  let insertEmail = email;
  if (email !== null && identity.emailVerified !== true) {
    const emailOwner = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (emailOwner !== undefined) insertEmail = null;
  }

  const userId = `usr-${crypto.randomUUID()}`;
  // bcrypt of random bytes: valid hash format, impossible to guess.
  const unusableHash = await bcrypt.hash(randomBytes(32).toString("base64"), 10);
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
  if (raced === undefined) throw new Error("Failed to provision SSO user");
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
export async function applySamlGroupMapping(userId: string, groups: readonly string[]): Promise<void> {
  const groupSet = new Set(groups.map((group): string => group.trim()).filter((group): boolean => group !== ""));
  const samlOrgs = await db.query.organizations.findMany({
    where: eq(organizations.samlEnabled, true),
  });
  for (const org of samlOrgs) {
    const existing = await db.query.organizationMemberships.findFirst({
      where: and(eq(organizationMemberships.orgId, org.id), eq(organizationMemberships.userId, userId)),
    });
    const isOwner = org.ownersTeamSamlRoleId !== null && groupSet.has(org.ownersTeamSamlRoleId);
    if (existing === undefined) {
      await db.insert(organizationMemberships).values({
        id: `orgmem-${crypto.randomUUID()}`,
        orgId: org.id,
        userId,
        role: isOwner ? "owner" : "member",
        status: "active",
        // Mark the membership as SAML-managed so group pruning can later
        // remove or downgrade it without touching admin-granted rows.
        ssoSource: "saml",
      });
    } else if (isOwner && existing.role !== "owner") {
      await db.update(organizationMemberships).set({ role: "owner", ssoSource: "saml" })
        .where(and(eq(organizationMemberships.orgId, org.id), eq(organizationMemberships.userId, userId)));
    }

    const orgTeams = await db.query.teams.findMany({ where: eq(teams.orgId, org.id) });
    const matchedTeams = orgTeams.filter((team): boolean => team.ssoTeamId !== null
      ? groupSet.has(team.ssoTeamId)
      : groupSet.has(team.name));
    if (matchedTeams.length === 0) continue;
    const existingMemberships = await db.query.teamMemberships.findMany({
      where: and(eq(teamMemberships.userId, userId), inArray(teamMemberships.teamId, matchedTeams.map((team): string => team.id))),
      columns: { teamId: true },
    });
    const existingIds = new Set(existingMemberships.map((membership): string => membership.teamId));
    const inserts = matchedTeams
      .filter((team): boolean => !existingIds.has(team.id))
      .map((team): typeof teamMemberships.$inferInsert => ({
        id: `tmem-${crypto.randomUUID()}`,
        teamId: team.id,
        userId,
        createdAt: Date.now(),
        ssoSource: "saml",
      }));
    if (inserts.length > 0) await db.insert(teamMemberships).values(inserts).onConflictDoNothing();
  }
}

/**
 * Update SAML-managed org/team memberships to match the group set. Only rows
 * the SAML mapper created (ssoSource = 'saml') are ever removed or
 * downgraded; admin-granted memberships are left untouched. Called when the
 * same identity logs in with fewer groups.
 */
export async function pruneSamlGroupMappings(userId: string, groups: readonly string[]): Promise<void> {
  const groupSet = new Set(groups.map((group): string => group.trim()).filter((group): boolean => group !== ""));
  const samlOrgs = await db.query.organizations.findMany({
    where: eq(organizations.samlEnabled, true),
  });
  const orgIds = samlOrgs.map((org): string => org.id);
  if (orgIds.length === 0) return;

  const [memberships, orgTeams] = await Promise.all([
    db.query.organizationMemberships.findMany({ where: and(inArray(organizationMemberships.orgId, orgIds), eq(organizationMemberships.userId, userId)) }),
    db.query.teams.findMany({ where: inArray(teams.orgId, orgIds) }),
  ]);
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
      await db.delete(teamMemberships).where(and(
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
        await db.update(organizationMemberships).set({ role })
          .where(eq(organizationMemberships.id, membership.id));
      }
      continue;
    }
    await db.delete(organizationMemberships).where(and(
      eq(organizationMemberships.orgId, org.id),
      eq(organizationMemberships.userId, userId),
      eq(organizationMemberships.ssoSource, "saml"),
    ));
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
  const safeRedirect = options.redirectUrl !== undefined
    && options.redirectUrl.startsWith("/")
    && !options.redirectUrl.startsWith("//")
    ? options.redirectUrl
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
      "Content-Security-Policy": "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
