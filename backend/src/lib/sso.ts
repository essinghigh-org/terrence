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
    getSettings("oidc"),
    getSettings("saml"),
    getSettings("ldap"),
  ]);
  return {
    localAuthEnabled: bool(general["local-auth-enabled"], true),
    samlEnabled: bool(saml.enabled),
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

  constructor(provider: SsoProvider, username: string) {
    super(
      `Sign-in blocked: username "${username}" is already in use by a local account. `
      + "Rename the local account or change the identity provider username, then retry.",
    );
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
    throw new SsoConflictError(identity.provider, identity.username);
  }
  const email = validEmail(identity.email);

  const byIdentity = await db.query.users.findFirst({
    where: and(eq(users.ssoProvider, identity.provider), eq(users.ssoSubject, subject)),
  });
  if (byIdentity !== undefined) {
    const updates: Partial<typeof users.$inferInsert> = {};
    if (byIdentity.email === null && email !== null) updates.email = email;
    if (Object.keys(updates).length > 0) {
      await db.update(users).set(updates).where(eq(users.id, byIdentity.id));
    }
    const refreshed = await db.query.users.findFirst({ where: eq(users.id, byIdentity.id) });
    if (refreshed === undefined) throw new Error("SSO user is unavailable");
    return { user: refreshed, created: false };
  }

  if (email !== null) {
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

  const userId = `usr-${crypto.randomUUID()}`;
  // bcrypt of random bytes: valid hash format, impossible to guess.
  const unusableHash = await bcrypt.hash(randomBytes(32).toString("base64"), 10);
  await db.insert(users).values({
    id: userId,
    username,
    email,
    passwordHash: unusableHash,
    ssoProvider: identity.provider,
    ssoSubject: subject,
    isSiteAdmin: false,
  });
  await auditLog("create", "users", userId, null, null, {
    source: `sso:${identity.provider}`,
    username,
  });
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (user === undefined) throw new Error("Failed to provision SSO user");
  return { user, created: true };
}

/**
 * SAML group mapping: groups matching an organization's owners-team-saml-role-id
 * grant the owner role; groups matching existing team names grant team
 * membership; all SAML users of SAML-enabled organizations get basic membership.
 */
export async function applySamlGroupMapping(userId: string, groups: readonly string[]): Promise<void> {
  const groupSet = new Set(groups.map((group): string => group.trim()).filter((group): boolean => group !== ""));
  if (groupSet.size === 0) return;

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
      });
    } else if (isOwner && existing.role !== "owner") {
      await db.update(organizationMemberships).set({ role: "owner" })
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
      }));
    if (inserts.length > 0) await db.insert(teamMemberships).values(inserts).onConflictDoNothing();
  }
}

/**
 * Remove a user from SAML-managed org/team memberships whose groups no longer
 * include them. Called when the same identity logs in with fewer groups.
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
  for (const membership of memberships) {
    const org = samlOrgs.find((candidate): boolean => candidate.id === membership.orgId);
    if (org === undefined) continue;
    const isOwner = org.ownersTeamSamlRoleId !== null && groupSet.has(org.ownersTeamSamlRoleId);
    const teamsForOrg = teamByOrg.get(org.id) ?? [];
    const matchedTeam = teamsForOrg.some((team): boolean => (team.ssoTeamId !== null ? groupSet.has(team.ssoTeamId) : groupSet.has(team.name)));
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
    ));
  }
}

/** Simple HTML page used by the SAML/OIDC browser flows. */
export function ssoHtmlPage(
  title: string,
  message: string,
  options: Readonly<{ redirectUrl?: string; token?: string; error?: boolean }> = {},
): string {
  const body = options.token !== undefined
    ? `<p id="sso-token">${options.token}</p><p>Copy this token and use it as your user token. It is shown only once.</p>`
    : `<p id="sso-message">${message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>`;
  const redirect = options.redirectUrl !== undefined
    ? `<p><a href="${options.redirectUrl}">Continue to Terrence</a></p>`
    : "";
  const refresh = options.redirectUrl !== undefined
    ? `<script>setTimeout(() => { window.location.href = ${JSON.stringify(options.redirectUrl)}; }, 1500);</script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title.replaceAll("<", "&lt;")}</title>
</head>
<body>
  <main>
    <h1>${title.replaceAll("<", "&lt;")}</h1>
    ${body}
    ${redirect}
    ${refresh}
  </main>
</body>
</html>`;
}

export function ssoHtmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Base URL for the instance, used to derive ACS / callback / metadata URLs. */
export function ssoBaseUrl(request: Readonly<{ url: string }>): string {
  return apiURL(request, "");
}

// Re-export for route modules that only need the URL helper.
export { apiURL };
