import { Elysia } from "elysia";
import { db } from "../db";
import { users, apiTokens, refreshSessions, organizationMemberships, organizations, samlSettings, teams, user2FA } from "../db/schema";
import { and, count, eq, gt, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { userResource } from "../lib/response";
import { isUniqueConstraintError } from "../lib/validation";
import { envEnabled } from "../lib/env";
import { auditLog } from "../lib/utils";
import { log } from "../lib/log";
import { authPlugin } from "../auth";
import { lockFirstUserElection } from "../db/first-user";
import { generateTotpSecret, matchingTotpCounter, otpauthUrl } from "../lib/totp";
import { encryptSecret, decryptSecret, isEncryptedSecret } from "../lib/secrets";
import { generateAuthenticationToken, hashAuthenticationToken, tokenHashCandidates } from "../lib/token-service";

import { issueMfaChallenge, consumeMfaChallenge } from "../lib/mfa-challenge";
import { withDbLock } from "../lib/db-lock";
import { authenticateLdapWithCircuitBreaker } from "../lib/ldap";
import { ldapSettings, passwordMatches, provisionSsoUser, ssoSettingsSnapshot, SsoConflictError } from "../lib/sso";
import { resolveClientIp } from "../lib/client-ip";
import { checkPasswordPolicy, loadPasswordPolicy } from "../lib/password-policy";
import { clearLoginFailures, isLoginLocked, recordFailedLogin } from "../lib/login-lockout";
import { secureRequest } from "../lib/secure-request";
import { normalizeEmail, normalizeUsername } from "../lib/identity";

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_COOKIE = "terrence_refresh";
// Two-tab concurrency grace (todo 125-127): a presented refresh token that
// was rotated within this window is treated as a legitimate concurrent tab,
// not replay. Replay detection (family revocation) applies outside it.
const REFRESH_GRACE_MS = 30_000;
const THEME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Cross-replica refresh rotation lock (todo 347): DB-backed mutex via
// the locks table so that multi-replica Postgres deployments serialize
// refresh rotation atomically. On SQLite the DB lock serializes through
// the single writer just as correctly; the in-process queue remains as a
// fast-path so we do not hit the DB on every serialization hop.
let refreshRotationQueue = Promise.resolve();

async function withRefreshRotationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = refreshRotationQueue;
  let release!: () => void;
  refreshRotationQueue = new Promise<void>((resolve): void => {
    release = resolve;
  });
  await previous;
  try {
    // Serialize across replicas through the DB lock; the outer in-process
    // queue prevents thundering within this replica while we wait.
    return await withDbLock("refresh-rotation", operation);
  } finally {
    release();
  }
}

type Attrs = Record<string, unknown>;
type DataPayload = { readonly data?: { readonly attributes?: Attrs; readonly type?: string; readonly id?: string } };

function extractAttrs(body: unknown): Attrs | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const payload = body as DataPayload;
  return payload.data?.attributes;
}

type HeaderValue = string | number | readonly string[];
type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, HeaderValue>> }>;

type RequestInfo = Readonly<{
  url: string;
  headers: Readonly<{ get: (name: string) => string | null }>;
}>;

type ReqCtx = Readonly<{
  body?: unknown;
  request?: RequestInfo;
  server?: unknown;
  set: SetObj;
}>;

type AuthReqCtx = Readonly<{
  user?: Readonly<typeof users.$inferSelect> | null;
  token?: Readonly<{ id: string }> | null;
  orgId?: string | null;
  teamId?: string | null;
  tokenError?: string | null;
  params?: Readonly<Record<string, string | undefined>>;
  request?: RequestInfo;
  server?: unknown;
  body?: unknown;
  set: SetObj;
}>;

export function opaqueToken(prefix: string): string {
  return `${prefix}-${randomBytes(32).toString("base64url")}`;
}

export function tokenHash(token: string): string {
  return hashAuthenticationToken(token);
}

async function refreshSessionForToken(rawToken: string): Promise<typeof refreshSessions.$inferSelect | undefined> {
  const [currentHash, legacyHash] = tokenHashCandidates(rawToken);
  const rows = await db.query.refreshSessions.findMany({
    where: inArray(refreshSessions.tokenHash, [currentHash, legacyHash]),
    limit: 2,
  });
  const row = rows.find((candidate) => candidate.tokenHash === currentHash) ?? rows[0];
  if (row?.tokenHash === legacyHash) {
    await db.update(refreshSessions).set({ tokenHash: currentHash }).where(eq(refreshSessions.id, row.id));
    return { ...row, tokenHash: currentHash };
  }
  return row;
}

export function isUserLoginBlocked(user: Readonly<typeof users.$inferSelect>): boolean {
  return user.isSuspended === true
    || (user as unknown as { deletedAt?: number | null }).deletedAt != null;
}

function refreshCookieCandidates(request: RequestInfo | undefined): string[] {
  const candidates: string[] = [];
  for (const part of request?.headers.get("cookie")?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === REFRESH_COOKIE) {
      const value = part.slice(separator + 1).trim();
      if (value !== "") candidates.push(value);
    }
  }
  return candidates;
}

function setRefreshCookie(
  set: SetObj,
  request: RequestInfo | undefined,
  token: string,
  expiresAt: number,
  server?: unknown,
): void {
  const maxAge = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  const secure = secureRequest(request, server) ? "; Secure" : "";
  const value = `${REFRESH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(maxAge)}${secure}`;
  // Elysia (via Bun) joins array Set-Cookie values with ", " into a single
  // header. That is invalid for Set-Cookie when any value contains a comma
  // (Expires=Thu, 01 Jan...), and Firefox rejects the resulting header
  // entirely so the live cookie is never stored. Avoid the extra header
  // here and rely on Max-Age alone for the live cookie; the legacy
  // Path=/api/v2/users ghost is naturally overwritten by the Path=/ cookie
  // on subsequent refreshes, or cleared on logout.
  (set.headers as Record<string, string | number>)["Set-Cookie"] = value;
}

function clearRefreshCookie(set: SetObj, request: RequestInfo | undefined, server?: unknown): void {
  const secure = secureRequest(request, server) ? "; Secure" : "";
  // Same Bun/Elysia issue as setRefreshCookie: array Set-Cookie with Expires
  // (which contains a comma) is joined into one header and Firefox rejects
  // it. Only Max-Age=0 is needed; omit Expires and only clear Path=/.
  // The legacy Path=/api/v2/users ghost (if present) is handled by the
  // refresh candidate loop and expires naturally within 30 days.
  (set.headers as Record<string, string | number>)["Set-Cookie"] =
    `${REFRESH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

/**
 * Revoke the refresh-session family attached to the browser cookie and clear
 * it. Used by SAML SLO to terminate the local session when the IdP logs the
 * user out.
 */
export async function revokeBrowserSession(
  set: SetObj,
  request: RequestInfo | undefined,
  server?: unknown,
): Promise<boolean> {
  const candidates = refreshCookieCandidates(request);
  if (candidates.length === 0) return false;
  return withRefreshRotationLock(async (): Promise<boolean> => {
    let revoked = false;
    for (const token of candidates) {
      const current = await refreshSessionForToken(token);
      if (current === undefined) continue;
      if (await revokeRefreshFamily(current.familyId, current.userId)) revoked = true;
    }
    if (revoked) clearRefreshCookie(set, request, server);
    return revoked;
  });
}

export async function browserSessionDetails(
  request: RequestInfo | undefined,
): Promise<{ user: Readonly<typeof users.$inferSelect>; session: Readonly<typeof refreshSessions.$inferSelect> } | null> {
  for (const token of refreshCookieCandidates(request)) {
    const current = await refreshSessionForToken(token);
    if (current === undefined || current.rotatedAt !== null || current.revokedAt !== null || current.expiresAt <= Date.now()) continue;
    const user = await db.query.users.findFirst({ where: eq(users.id, current.userId) });
    if (user === undefined || isUserLoginBlocked(user)) continue;
    return { user, session: current };
  }
  return null;
}

export async function browserSessionUser(
  request: RequestInfo | undefined,
): Promise<Readonly<typeof users.$inferSelect> | null> {
  const details = await browserSessionDetails(request);
  return details?.user ?? null;
}

/**
 * Build the JSON:API token document returned after successful
 * authentication. Browser-session tokens are refreshable; SSO API tokens
 * (which carry no refresh session) pass `refreshable = false`.
 */
export function accessTokenDocument(
  id: string,
  token: string,
  user: Readonly<typeof users.$inferSelect>,
  expiresAt?: number,
  refreshable = true,
): Record<string, unknown> {
  return {
    data: {
      id,
      type: "tokens",
      attributes: {
        token,
        "must-change-password": user.mustChangePassword,
        ...(expiresAt === undefined
          ? {}
          : { "expired-at": new Date(expiresAt).toISOString(), refreshable }),
      },
    },
  };
}

async function revokeRefreshFamily(
  familyId: string,
  userId: string,
  revokedAt = Date.now(),
): Promise<boolean> {
  return db.transaction(async (tx: unknown): Promise<boolean> => {
    const t = tx as typeof db;
    const family = await t.query.refreshSessions.findMany({
      where: and(
        eq(refreshSessions.familyId, familyId),
        eq(refreshSessions.userId, userId),
      ),
      columns: { accessTokenId: true },
    });
    if (family.length === 0) return false;
    await t.update(refreshSessions)
      .set({ revokedAt })
      .where(and(
        eq(refreshSessions.familyId, familyId),
        eq(refreshSessions.userId, userId),
      ));
    const accessTokenIds = [...new Set(family.map((session): string => session.accessTokenId))];
    if (accessTokenIds.length > 0) {
      await t.delete(apiTokens).where(and(
        inArray(apiTokens.id, accessTokenIds),
        eq(apiTokens.userId, userId),
      ));
    }
    return true;
  });
}

/** Revoke every browser session and its access token when an account is blocked. */
async function revokeAllRefreshSessions(userId: string, revokedAt = Date.now()): Promise<void> {
  await db.transaction(async (tx: unknown): Promise<void> => {
    const t = tx as typeof db;
    const sessions = await t.query.refreshSessions.findMany({
      where: eq(refreshSessions.userId, userId),
      columns: { accessTokenId: true },
    });
    await t.update(refreshSessions)
      .set({ revokedAt })
      .where(and(eq(refreshSessions.userId, userId), isNull(refreshSessions.revokedAt)));
    const accessTokenIds = [...new Set(sessions.map((session): string => session.accessTokenId))];
    if (accessTokenIds.length > 0) {
      await t.delete(apiTokens).where(and(inArray(apiTokens.id, accessTokenIds), eq(apiTokens.userId, userId)));
    }
  });
}

/**
 * Issue an access token (+ refresh session for browser logins) after
 * successful authentication. Shared by /users/login, /users/login/mfa, and
 * the SAML / OIDC / LDAP SSO flows.
 */
export async function issueLoginSession(
  user: Readonly<typeof users.$inferSelect>,
  browserSession: boolean,
  set: SetObj,
  request: RequestInfo | undefined,
  server: unknown,
  mfaVerified = false,
): Promise<unknown> {
  const tokenStr = opaqueToken("user");
  const tokenId = crypto.randomUUID();
  const createdAt = Date.now();
  if (!browserSession) {
    await db.insert(apiTokens).values({
      id: tokenId,
      token: tokenHash(tokenStr),
      userId: user.id,
      description: "User login token",
      createdAt,
    });
    return accessTokenDocument(tokenId, tokenStr, user);
  }

  const accessExpiresAt = createdAt + ACCESS_TOKEN_TTL_MS;
  const refreshExpiresAt = createdAt + REFRESH_TOKEN_TTL_MS;
  const refreshToken = opaqueToken("refresh");
  const ipAddress = await resolveClientIp(request, server);
  const userAgent = request?.headers.get("user-agent") ?? null;
  await db.transaction(async (tx: unknown): Promise<void> => {
    const t = tx as typeof db;
    await t.insert(apiTokens).values({
      id: tokenId,
      token: tokenHash(tokenStr),
      userId: user.id,
      description: "Browser session access token",
      expiresAt: accessExpiresAt,
      createdAt,
    });
    await t.insert(refreshSessions).values({
      id: crypto.randomUUID(),
      familyId: crypto.randomUUID(),
      tokenHash: tokenHash(refreshToken),
      userId: user.id,
      accessTokenId: tokenId,
      ipAddress,
      userAgent,
      expiresAt: refreshExpiresAt,
      createdAt,
      mfaVerified,
    });
  });
  setRefreshCookie(set, request, refreshToken, refreshExpiresAt, server);
  return accessTokenDocument(tokenId, tokenStr, user, accessExpiresAt);
}

function browserSessionResources(
  sessions: readonly Readonly<typeof refreshSessions.$inferSelect>[],
  currentAccessTokenId: string | null,
): Record<string, unknown>[] {
  const families = new Map<string, {
    active: boolean;
    createdAt: number;
    current: boolean;
    expiresAt: number;
    ipAddress: string | null;
    lastRotatedAt: number | null;
    userAgent: string | null;
  }>();
  for (const session of sessions) {
    const existing = families.get(session.familyId);
    families.set(session.familyId, {
      active: (existing?.active ?? false) || session.rotatedAt === null,
      createdAt: Math.min(existing?.createdAt ?? session.createdAt, session.createdAt),
      current: (existing?.current ?? false) || session.accessTokenId === currentAccessTokenId,
      expiresAt: Math.max(existing?.expiresAt ?? session.expiresAt, session.expiresAt),
      ipAddress: existing?.ipAddress ?? session.ipAddress ?? null,
      lastRotatedAt: session.rotatedAt === null
        ? existing?.lastRotatedAt ?? null
        : Math.max(existing?.lastRotatedAt ?? session.rotatedAt, session.rotatedAt),
      userAgent: existing?.userAgent ?? session.userAgent ?? null,
    });
  }

  return [...families.entries()]
    .filter(([, family]): boolean => family.active)
    .sort(([, left], [, right]): number => {
      if (left.current !== right.current) return right.current ? 1 : -1;
      return (right.lastRotatedAt ?? right.createdAt) - (left.lastRotatedAt ?? left.createdAt);
    })
    .map(([familyId, family]): Record<string, unknown> => ({
      id: familyId,
      type: "browser-sessions",
      attributes: {
        "created-at": new Date(family.createdAt).toISOString(),
        "last-rotated-at": family.lastRotatedAt === null
          ? null
          : new Date(family.lastRotatedAt).toISOString(),
        "expires-at": new Date(family.expiresAt).toISOString(),
        "ip-address": family.ipAddress,
        "user-agent": family.userAgent,
        current: family.current,
      },
    }));
}

function refreshUnauthorized(
  set: SetObj,
  request: RequestInfo | undefined,
  detail: string,
  server?: unknown,
): Record<string, unknown> {
  (set as { status: number }).status = 401;
  clearRefreshCookie(set, request, server);
  return { errors: [{ status: "401", title: "Unauthorized", detail }] };
}

async function resolveMfaSeed(mfa: Readonly<{ secret: string; secretEncrypted: string | null }>): Promise<string | null> {
  const raw = mfa.secretEncrypted ?? (mfa.secret !== "" ? mfa.secret : null);
  if (raw === null) return null;
  if (!isEncryptedSecret(raw)) return raw;
  try { return await decryptSecret(raw); } catch { return null; }
}

type MfaUpdate = Readonly<{
  secret?: string;
  secretEncrypted?: string;
  enabled?: boolean;
}>;

/** Atomically accept a strictly newer TOTP counter for this MFA record. */
async function acceptTotpCode(
  userId: string,
  mfa: Readonly<typeof user2FA.$inferSelect>,
  code: string,
  updates: MfaUpdate = {},
): Promise<boolean> {
  const seedPlain = await resolveMfaSeed(mfa);
  if (seedPlain === null) return false;
  const counter = matchingTotpCounter(seedPlain, code);
  if (counter === null) return false;
  const sameSecret = and(
    eq(user2FA.secret, mfa.secret),
    mfa.secretEncrypted === null
      ? isNull(user2FA.secretEncrypted)
      : eq(user2FA.secretEncrypted, mfa.secretEncrypted),
  );
  const accepted = await db.update(user2FA)
    .set({ ...updates, lastAcceptedCounter: counter })
    .where(and(
      eq(user2FA.userId, userId),
      sameSecret,
      or(isNull(user2FA.lastAcceptedCounter), lt(user2FA.lastAcceptedCounter, counter)),
    ))
    .returning({ userId: user2FA.userId });
  return accepted.length === 1;
}

function currentPasswordFromAttrs(attrs: Attrs): string {
  return typeof attrs["current_password"] === "string"
    ? attrs["current_password"]
    : typeof attrs["current-password"] === "string"
      ? attrs["current-password"]
      : "";
}

async function requireCurrentPassword(
  user: Readonly<typeof users.$inferSelect>,
  body: unknown,
  set: SetObj,
): Promise<Record<string, unknown> | null> {
  const currentPassword = currentPasswordFromAttrs(extractAttrs(body) ?? {});
  if (currentPassword === "") {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Current password is required" }] };
  }
  if (!(await passwordMatches(currentPassword, user.passwordHash))) {
    (set as { status: number }).status = 401;
    return { errors: [{ status: "401", title: "Unauthorized", detail: "Current password is incorrect" }] };
  }
  return null;
}

export const accountRoutes = new Elysia({ name: "accounts" })
  // Public routes (no auth required)
  .post("/admin/initial-admin-user", async ({ body, request, set }: ReqCtx): Promise<unknown> => {
    const configuredToken = process.env["IACT_TOKEN"];
    // the reference format's installer passes the token as a query parameter.
    // Query-token compatibility is OPT-IN (todo 142: the default is the
    // safer header-only flow) — set IACT_QUERY_TOKEN_ENABLED=1 to restore the
    // reference installer behavior. The header alternative keeps the secret
    // out of proxy logs, browser history, and traces entirely.
    const queryEnabled = envEnabled(process.env["IACT_QUERY_TOKEN_ENABLED"]);
    const queryToken = request === undefined || !queryEnabled ? null : new URL(request.url).searchParams.get("token");
    const headerToken = request === undefined ? null
      : request.headers.get("x-iact-token")
        ?? (() => {
          const authorization = request.headers.get("authorization") ?? "";
          return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
        })();
    const suppliedToken = queryToken ?? headerToken;
    const configured = Buffer.from(configuredToken ?? "");
    const supplied = Buffer.from(suppliedToken ?? "");
    if (
      configuredToken === undefined
      || configuredToken === ""
      || suppliedToken === null
      || configured.length !== supplied.length
      || !timingSafeEqual(configured, supplied)
      || (await db.select({ value: count() }).from(users))[0]?.value !== 0
    ) {
      (set as { status: number }).status = 404;
      return { status: "error", error: "Not found" };
    }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const username = typeof payload["username"] === "string" ? normalizeUsername(payload["username"]) ?? "" : "";
    const email = typeof payload["email"] === "string" ? normalizeEmail(payload["email"]) ?? "" : "";
    const password = typeof payload["password"] === "string" ? payload["password"] : "";
    if (username === "" || email === "" || password === "") {
      (set as { status: number }).status = 422;
      return { status: "error", error: "Username, email, and password are required" };
    }
    const setupPolicy = checkPasswordPolicy(loadPasswordPolicy(), password, username);
    if (!setupPolicy.ok) {
      (set as { status: number }).status = 422;
      return { status: "error", error: setupPolicy.errors.join(" ") };
    }

    const userId = `user-${crypto.randomUUID()}`;
    const organizationId = `org-${crypto.randomUUID()}`;
    const configuredOrganizationName = (process.env["ADMIN_ORGANIZATION"] ?? "default").trim();
    const organizationName = configuredOrganizationName === "" ? "default" : configuredOrganizationName;
    const token = generateAuthenticationToken("user");
    const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
    const createdOrganizationId = await db.transaction(async (tx: unknown): Promise<string | null> => {
      const t = tx as typeof db;
      // Serialize the first-user election across concurrent requests (PG
      // advisory lock; no-op on SQLite): see db/first-user.ts.
      await lockFirstUserElection(t);
      if (((await t.select({ value: count() }).from(users))[0]?.value ?? 0) !== 0) return null;
      await t.insert(users).values({
        id: userId,
        username,
        email,
        passwordHash,
        isSiteAdmin: true,
      });
      const existingOrganization = await t.query.organizations.findFirst({
        where: eq(organizations.name, organizationName),
      });
      const targetOrganizationId = existingOrganization?.id ?? organizationId;
      if (existingOrganization === undefined) {
        const saml = await t.query.samlSettings.findFirst({ where: eq(samlSettings.id, "saml") });
        await t.insert(organizations).values({
          id: targetOrganizationId,
          name: organizationName,
          samlEnabled: saml?.enabled ?? false,
        });
      }
      await t.insert(organizationMemberships).values({
        id: `oum-${crypto.randomUUID()}`,
        userId,
        orgId: targetOrganizationId,
        role: "owner",
      });
      await t.insert(apiTokens).values({
        id: crypto.randomUUID(),
        token: hashAuthenticationToken(token),
        userId,
        description: "Initial administrator token",
        createdAt: Date.now(),
      });
      return targetOrganizationId;
    });
    if (createdOrganizationId === null) {
      (set as { status: number }).status = 404;
      return { status: "error", error: "Not found" };
    }
    delete process.env["IACT_TOKEN"];
    await auditLog("create", "users", userId, userId, createdOrganizationId, { username, source: "IACT_TOKEN" });
    return { status: "created", token };
  })
  .post("/api/v2/users/login", async ({ body, request, set, server }: ReqCtx): Promise<unknown> => {
    let payload: DataPayload | undefined;
    if (typeof body === "string") {
      try {
        payload = JSON.parse(body) as DataPayload;
      } catch {
        (set as { status: number }).status = 400;
        return { errors: [{ status: "400", title: "Bad Request", detail: "Invalid JSON string" }] };
      }
    } else if (body !== null && typeof body === "object") {
      payload = body;
    }

    const attrs = payload?.data?.attributes ?? {};
    const username = typeof attrs["username"] === "string" ? attrs["username"] : "";
    const password = typeof attrs["password"] === "string" ? attrs["password"] : "";
    const browserSession = attrs["browser-session"] === true;

    if (username === "" || password === "") {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Missing credentials" }] };
    }

    const [sso, ldap] = await Promise.all([ssoSettingsSnapshot(), ldapSettings()]);
    const localAuthEnabled = sso.localAuthEnabled;

    // LDAP is tried first when the directory is reachable; local password
    // auth remains the fallback unless an administrator has disabled local
    // authentication. An *unavailable* directory is different from a rejected
    // bind: when LDAP is the only configured path, a down directory is a
    // service problem (503), not bad credentials.
    let user: typeof users.$inferSelect | null = null;
    let ldapUnavailable = false;
    if (ldap.enabled) {
      let ldapUser: Awaited<ReturnType<typeof authenticateLdapWithCircuitBreaker>>["user"] = null;
      try {
        const ldapResult = await authenticateLdapWithCircuitBreaker(ldap, username, password);
        ldapUser = ldapResult.user;
        ldapUnavailable = ldapResult.unavailable;
      } catch (error: unknown) {
        ldapUnavailable = true;
        log.warn("LDAP authentication probe failed; continuing with local authentication", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (ldapUser !== null) {
        try {
          const provisioned = await provisionSsoUser({
            provider: "ldap",
            subject: ldapUser.dn,
            username: ldapUser.username,
            email: ldapUser.email,
            // Directory attributes are operator-controlled; the bind against
            // the user DN already authenticated the caller.
            emailVerified: true,
            allowEmailLinking: ldap.allowEmailLinking,
          });
          user = provisioned.user;
        } catch (error: unknown) {
          if (error instanceof SsoConflictError) {
            // Do not reveal whether a local account owns the username; log
            // the specifics server-side only.
            log.warn("LDAP provisioning conflict", { username });
            (set as { status: number }).status = 401;
            return { errors: [{ status: "401", title: "Unauthorized", detail: "This account cannot be provisioned from the directory" }] };
          }
          throw error;
        }
      }
    }

    if (user === null) {
      if (ldapUnavailable && !localAuthEnabled) {
        (set as { status: number }).status = 503;
        return { errors: [{ status: "503", title: "Service Unavailable", detail: "The LDAP directory is temporarily unavailable." }] };
      }
      if (!localAuthEnabled) {
        (set as { status: number }).status = 401;
        return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid username or password" }] };
      }
      const loginEmail = normalizeEmail(username);
      const found = await db.query.users.findFirst({
        where: loginEmail === null
          ? eq(users.username, username)
          : or(eq(users.username, username), eq(users.email, loginEmail)),
      });
      if (found !== undefined && isLoginLocked(found)) {
        (set as { status: number }).status = 401;
        return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid username or password" }] };
      }
      const passwordValid = await passwordMatches(password, found?.passwordHash);
      if (found === undefined || !passwordValid) {
        if (found !== undefined && !isUserLoginBlocked(found)) await recordFailedLogin(found.id);
        (set as { status: number }).status = 401;
        return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid username or password" }] };
      }
      user = found;
    }

    if (isLoginLocked(user)) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid username or password" }] };
    }
    if (isUserLoginBlocked(user)) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid username or password" }] };
    }
    if (user.isProvisional === true) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "This invitation has not been accepted yet" }] };
    }
    if (!(await clearLoginFailures(user.id))) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid username or password" }] };
    }
    // If MFA is enabled for this account, issue a short-lived challenge token
    // instead of an access token. The client completes login via
    // POST /users/login/mfa with a valid TOTP code.
    const mfa = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, user.id) });
    if (mfa !== undefined && mfa.enabled === true) {
      const challengeToken = await issueMfaChallenge(user.id);
      return {
        data: {
          type: "users",
          attributes: {
            "mfa-required": true,
            "mfa-challenge-token": challengeToken,
          },
        },
      };
    }

    return issueLoginSession(user, browserSession, set, request, server);
  })
  .post("/api/v2/users/login/mfa", async ({ body, request, set, server }: ReqCtx): Promise<unknown> => {
    let payload: DataPayload | undefined;
    if (typeof body === "string") {
      try {
        payload = JSON.parse(body) as DataPayload;
      } catch {
        payload = undefined;
      }
    } else if (body !== null && typeof body === "object") {
      payload = body;
    }
    const attrs = payload?.data?.attributes ?? {};
    const challengeToken = typeof attrs["challenge-token"] === "string" ? attrs["challenge-token"] : "";
    const code = typeof attrs["code"] === "string" ? attrs["code"] : "";
    const browserSession = attrs["browser-session"] === true;

    if (challengeToken === "" || code === "") {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Missing MFA challenge token or code" }] };
    }

    const challenge = await consumeMfaChallenge(challengeToken);
    if (challenge === null) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "MFA challenge has expired or is invalid" }] };
    }

    const mfa = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, challenge.userId) });
    if (mfa === undefined || mfa.enabled !== true) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid authentication code" }] };
    }
    if (!(await acceptTotpCode(challenge.userId, mfa, code))) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid authentication code" }] };
    }

    const user = await db.query.users.findFirst({ where: eq(users.id, challenge.userId) });
    if (user === undefined || isUserLoginBlocked(user)) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Account not found" }] };
    }

    return issueLoginSession(user, browserSession, set, request, server, true);
  })
  .post("/api/v2/users/refresh", async ({ request, server, set }: ReqCtx): Promise<unknown> => {
    const candidates = refreshCookieCandidates(request);
    if (candidates.length === 0) {
      return refreshUnauthorized(set, request, "Refresh session is missing", server);
    }
    return withRefreshRotationLock(async (): Promise<unknown> => {
      const seen = new Map<string, typeof refreshSessions.$inferSelect>();
      const now = Date.now();
      let liveFamilyId: string | null = null;
      for (const presentedToken of candidates) {
        const key = tokenHash(presentedToken);
        let current = seen.get(key) ?? null;
        if (current === null) {
          const row = await refreshSessionForToken(presentedToken);
          if (row === undefined) continue;
          seen.set(key, row);
          current = row;
        }
        if (current.revokedAt !== null || current.expiresAt <= now) {
          continue;
        }
        const currentUser = await db.query.users.findFirst({ where: eq(users.id, current.userId) });
        if (currentUser === undefined || isUserLoginBlocked(currentUser)) {
          await revokeAllRefreshSessions(current.userId, now);
          return refreshUnauthorized(set, request, "Refresh session is invalid", server);
        }
        // Two-tab concurrency grace (todo 125-127): this request serialized
        // behind the winning tab (in-process rotation lock) and is presenting
        // a token the winner just rotated. Within the grace window that is
        // the legitimate second tab, not replay: re-issue an access token
        // against the successor session WITHOUT rotating again. Outside the
        // window the normal reuse handling below applies.
        if (
          current.rotatedAt !== null
          && current.rotatedAtMs !== null
          && current.successorHash !== null
          && now - current.rotatedAtMs <= REFRESH_GRACE_MS
        ) {
          const successor = await db.query.refreshSessions.findFirst({
            where: eq(refreshSessions.tokenHash, current.successorHash),
          });
          const successorUser = successor !== undefined && successor.revokedAt === null && successor.expiresAt > now
            ? await db.query.users.findFirst({ where: eq(users.id, successor.userId) })
            : undefined;
          if (successor !== undefined && successorUser !== undefined && !isUserLoginBlocked(successorUser)) {
            const graceAccess = opaqueToken("user");
            const graceAccessId = crypto.randomUUID();
            const graceExpiresAt = now + ACCESS_TOKEN_TTL_MS;
            await db.insert(apiTokens).values({
              id: graceAccessId,
              token: tokenHash(graceAccess),
              userId: successorUser.id,
              description: "Browser session access token",
              expiresAt: graceExpiresAt,
              createdAt: now,
            });
            // The browser already holds the successor refresh cookie from the
            // winning response; only the access-token document is re-issued.
            return accessTokenDocument(graceAccessId, graceAccess, successorUser, graceExpiresAt);
          }
        }
        // Rotated tokens are normally reuse, but the pre-2026-08-19
        // Path=/api/v2/users ghost cookie is a rotated token that shares
        // the same family as the live token the browser also sends.
        // Only relax reuse when the rotated token is from the same family
        // as the live candidate we will successfully rotate.
        // TODO(remove after 2027-02-19): legacy ghost-cookie relaxation.
        if (current.rotatedAt !== null) {
          if (liveFamilyId === null) {
            // We don't know the live family yet — stash and re-evaluate
            // after we find a live candidate. For now just remember it.
            continue;
          }
          if (current.familyId !== liveFamilyId) {
            await revokeRefreshFamily(current.familyId, current.userId, now);
            return refreshUnauthorized(set, request, "Refresh token reuse detected", server);
          }
          continue;
        }
        // This is a live candidate — record its family so earlier rotated
        // ghosts from the same family can be forgiven (already skipped).
        liveFamilyId ??= current.familyId;
        const user = currentUser;

        const accessToken = opaqueToken("user");
        const accessTokenId = crypto.randomUUID();
        const refreshToken = opaqueToken("refresh");
        const accessExpiresAt = now + ACCESS_TOKEN_TTL_MS;
        // Two-tab concurrency grace (todo 125-127): the rotation records the
        // successor hash so an immediately-duplicated refresh presenting the
        // same old token resolves to the successor instead of revoking the
        // family. Only rotations within REFRESH_GRACE_MS are forgiven.
        const rotated = await db.transaction(async (tx: unknown): Promise<boolean> => {
          const t = tx as typeof db;
          const claimed = await t.update(refreshSessions)
            .set({ rotatedAt: now, rotatedAtMs: now, successorHash: tokenHash(refreshToken) })
            .where(and(
              eq(refreshSessions.id, current.id),
              isNull(refreshSessions.rotatedAt),
              isNull(refreshSessions.revokedAt),
              gt(refreshSessions.expiresAt, now),
            ))
            .returning({ id: refreshSessions.id });
          if (claimed.length === 0) return false;
          await t.delete(apiTokens).where(eq(apiTokens.id, current.accessTokenId));
          await t.insert(apiTokens).values({
            id: accessTokenId,
            token: tokenHash(accessToken),
            userId: user.id,
            description: "Browser session access token",
            expiresAt: accessExpiresAt,
            createdAt: now,
          });
          await t.insert(refreshSessions).values({
            id: crypto.randomUUID(),
            familyId: current.familyId,
            tokenHash: tokenHash(refreshToken),
            userId: user.id,
            accessTokenId,
            expiresAt: current.expiresAt,
            createdAt: now,
            mfaVerified: current.mfaVerified ?? false,
          });
          return true;
        });
        if (!rotated) {
          // Re-read the row: the concurrent winner may have populated
          // successorHash/rotatedAtMs that our stale snapshot lacks.
          const fresh = await db.query.refreshSessions.findFirst({
            where: eq(refreshSessions.id, current.id),
          });
          const effective = fresh ?? current;
          // The claim failed: the token was already rotated (two-tab race or
          // replay) or revoked/expired. The in-process rotation lock means a
          // concurrent same-process tab serialized behind us and re-read the
          // row; a genuine cross-process replay arrives later than the grace
          // window. Inside the window, treat the duplicate as the legitimate
          // second tab: hand back the successor session's access token
          // WITHOUT rotating again (todo 125-126). Outside the window this
          // stays a family-revocation reuse event (todo 127).
          if (
            effective.rotatedAtMs !== null
            && effective.successorHash !== null
            && now - effective.rotatedAtMs <= REFRESH_GRACE_MS
          ) {
            const successor = await db.query.refreshSessions.findFirst({
              where: eq(refreshSessions.tokenHash, effective.successorHash),
            });
            const successorUser = successor !== undefined && successor.revokedAt === null && successor.expiresAt > now
              ? await db.query.users.findFirst({ where: eq(users.id, successor.userId) })
              : undefined;
            if (successor !== undefined && successorUser !== undefined && !isUserLoginBlocked(successorUser)) {
              const graceAccess = opaqueToken("user");
              const graceAccessId = crypto.randomUUID();
              const graceExpiresAt = now + ACCESS_TOKEN_TTL_MS;
              await db.insert(apiTokens).values({
                id: graceAccessId,
                token: tokenHash(graceAccess),
                userId: successorUser.id,
                description: "Browser session access token",
                expiresAt: graceExpiresAt,
                createdAt: now,
              });
              // Keep the successor's refresh cookie value as-is: the browser
              // already holds it from the first response. Only the access
              // token document is re-issued here.
              return accessTokenDocument(graceAccessId, graceAccess, successorUser, graceExpiresAt);
            }
          }
          await revokeRefreshFamily(current.familyId, current.userId, now);
          return refreshUnauthorized(set, request, "Refresh token reuse detected", server);
        }

        setRefreshCookie(set, request, refreshToken, current.expiresAt, server);
        return accessTokenDocument(accessTokenId, accessToken, user, accessExpiresAt);
      }

      // No candidate matched a live session. If any candidate was a
      // rotated token, treat it as reuse (revoke the family). Otherwise
      // the session is simply invalid/expired.
      const reuse = [...seen.values()].find((row): boolean => row.rotatedAt !== null) ?? null;
      if (reuse !== null) {
        await revokeRefreshFamily(reuse.familyId, reuse.userId, now);
        return refreshUnauthorized(set, request, "Refresh token reuse detected", server);
      }
      if ([...seen.values()].some((row): boolean => row.revokedAt !== null || row.expiresAt <= now)) {
        return refreshUnauthorized(set, request, "Refresh session expired", server);
      }
      // Tokens not found in DB (seen miss) — fill the map for them too
      // so the error classification above could consider them; otherwise
      // treat as invalid.
      for (const token of candidates) {
        const key = tokenHash(token);
        if (seen.has(key)) continue;
        const row = await refreshSessionForToken(token);
        if (row === undefined) continue;
        seen.set(key, row);
        if (row.rotatedAt !== null) {
          await revokeRefreshFamily(row.familyId, row.userId, now);
          return refreshUnauthorized(set, request, "Refresh token reuse detected", server);
        }
        if (row.revokedAt !== null || row.expiresAt <= now) {
          return refreshUnauthorized(set, request, "Refresh session expired", server);
        }
      }
      return refreshUnauthorized(set, request, "Refresh session is invalid", server);
    });
  })
  .post("/api/v2/users/logout", async ({ request, server, set }: ReqCtx): Promise<unknown> => {
    const candidates = refreshCookieCandidates(request);
    if (candidates.length > 0) {
      await withRefreshRotationLock(async (): Promise<void> => {
        for (const token of candidates) {
          const current = await refreshSessionForToken(token);
          if (current !== undefined) await revokeRefreshFamily(current.familyId, current.userId);
        }
      });
    }
    clearRefreshCookie(set, request, server);
    (set as { status: number }).status = 204;
    return undefined;
  })
  .post("/api/v2/users", async ({ body, set }: ReqCtx): Promise<unknown> => {
    if (!envEnabled(process.env["TERRENCE_ENABLE_LOCAL_SIGNUP"])) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: "Local signup is disabled on this instance. Set TERRENCE_ENABLE_LOCAL_SIGNUP=true or use ADMIN_PASSWORD bootstrap." }] };
    }
    const attrs = extractAttrs(body) ?? {};
    const username = typeof attrs["username"] === "string" ? normalizeUsername(attrs["username"]) ?? "" : "";
    const password = typeof attrs["password"] === "string" ? attrs["password"] : "";
    const email = attrs["email"];

    if (username === "" || password === "") {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Missing username or password" }] };
    }

    const policyCheck = checkPasswordPolicy(loadPasswordPolicy(), password, username);
    if (!policyCheck.ok) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: policyCheck.errors.join(" ") }] };
    }
    // Bounded email matcher. The full RFC-5322 grammar embeds nested
    // quantifiers that admit catastrophic backtracking (ReDoS); this
    // pragmatic pattern scans in linear time and is sufficient for signup.
    const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

    const emailStr = typeof email === "string" && email.trim() !== "" ? normalizeEmail(email) ?? "" : `${username}@example.com`;
    if (!EMAIL_REGEX.test(emailStr)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "A valid email address is required" }] };
    }

    const existing = await db.query.users.findFirst({
      where: eq(users.username, username),
    });
    if (existing !== undefined) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] };
    }

    const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
    const id = crypto.randomUUID();
    const normalizedEmail = emailStr;

    // Local signup NEVER elects a site admin. The first user on a fresh
    // instance must come from the ADMIN_PASSWORD (or installer IACT)
    // bootstrap, whose count-then-insert runs under a serialized first-user
    // lock. Letting signup elect admins from a plain count raced two
    // concurrent signups into two site admins on PostgreSQL.
    try {
      await db.insert(users).values({ id, username, email: normalizedEmail, passwordHash, isSiteAdmin: false });
      await auditLog("create", "users", id, null, null, { username });
      (set as { status: number }).status = 201;
      return {
        data: {
          id,
          type: "users",
          attributes: { username, email: normalizedEmail, "is-site-admin": false },
        },
      };
    } catch (e: unknown) {
      if (isUniqueConstraintError(e)) {
        (set as { status: number }).status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] };
      }
      throw e;
    }
  })
  .use(authPlugin)
  .get("/api/v2/account/details", async ({ user, orgId, teamId, tokenError, set }: AuthReqCtx): Promise<unknown> => {
    // Return 401 for invalid or expired tokens (distinct from "no auth" → 404)
    if (tokenError !== null && tokenError !== undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: tokenError === "expired" ? "Token expired" : "Invalid token" }] };
    }
    if (user !== null && user !== undefined) return { data: userResource(user) };

    if (teamId !== null && teamId !== undefined) {
      const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
      if (team !== undefined) {
        const synthetic = { id: `service-user-${team.id}`, username: `${team.name}-service-user` };
        return { data: userResource(synthetic, { id: team.id, type: "teams" }) };
      }
    }

    const org = orgId !== null && orgId !== undefined
      ? await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) })
      : null;
    if (org === null || org === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const synthetic = { id: `service-user-${org.id}`, username: `${org.name}-service-user` };
    return { data: userResource(synthetic, { id: org.name, type: "organizations" }) };
  })
  .get("/api/v2/account/sessions", async ({ user, token, set }: AuthReqCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    (set.headers as Record<string, string | number>)["Cache-Control"] = "no-store";
    const sessions = await db.query.refreshSessions.findMany({
      where: and(
        eq(refreshSessions.userId, user.id),
        isNull(refreshSessions.revokedAt),
        gt(refreshSessions.expiresAt, Date.now()),
      ),
    });
    return { data: browserSessionResources(sessions, token?.id ?? null) };
  })
  .delete("/api/v2/account/sessions", async ({ user, token, set }: AuthReqCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.update(refreshSessions)
      .set({ revokedAt: Date.now() })
      .where(and(eq(refreshSessions.userId, user.id), isNull(refreshSessions.revokedAt)));
    if (token !== null && token !== undefined) {
      await db.delete(apiTokens).where(and(eq(apiTokens.userId, user.id), ne(apiTokens.id, token.id)));
    }
    (set as { status: number }).status = 204;
    return undefined;
  })
  .delete("/api/v2/account/sessions/:family_id", async ({ params, request, server, user, token, set }: AuthReqCtx): Promise<unknown> => {
    const familyId = params?.["family_id"] ?? "";
    if (user === null || user === undefined || familyId === "") {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const current = await withRefreshRotationLock(async (): Promise<boolean | null> => {
      const activeFamily = await db.query.refreshSessions.findMany({
        where: and(
          eq(refreshSessions.familyId, familyId),
          eq(refreshSessions.userId, user.id),
          isNull(refreshSessions.revokedAt),
          gt(refreshSessions.expiresAt, Date.now()),
        ),
        columns: { accessTokenId: true, rotatedAt: true },
      });
      if (!activeFamily.some((session): boolean => session.rotatedAt === null)) return null;
      const isCurrent = token !== null
        && token !== undefined
        && activeFamily.some((session): boolean => session.accessTokenId === token.id);
      return await revokeRefreshFamily(familyId, user.id) ? isCurrent : null;
    });
    if (current === null) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (current) clearRefreshCookie(set, request, server);
    (set as { status: number }).status = 204;
    return undefined;
  })
  .patch("/api/v2/account/update", async ({ user, body, set }: AuthReqCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const attrs = extractAttrs(body);
    if (attrs === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }

    const changes: { username?: string; email?: string | null; emailVerifiedAt?: number | null; theme?: string } = {};
    if (Object.hasOwn(attrs, "username")) {
      if (typeof attrs["username"] !== "string" || attrs["username"].trim() === "") {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Username cannot be empty" }] };
      }
      const normalizedUsername = normalizeUsername(attrs["username"]);
      if (normalizedUsername === null) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Username contains invalid characters" }] };
      }
      changes.username = normalizedUsername;
    }
    if (Object.hasOwn(attrs, "email")) {
      const emailVal = attrs["email"];
      if (emailVal !== null && (typeof emailVal !== "string" || emailVal.trim() === "")) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Email must be a string or null" }] };
      }
      const normalizedEmail = emailVal === null ? null : normalizeEmail(emailVal.trim());
      if (emailVal !== null && normalizedEmail === null) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "A valid email address is required" }] };
      }
      changes.email = normalizedEmail;
      if (normalizedEmail !== user.email) changes.emailVerifiedAt = null;
    }
    if (Object.hasOwn(attrs, "theme")) {
      if (typeof attrs["theme"] !== "string" || attrs["theme"].length > 64 || !THEME_ID_PATTERN.test(attrs["theme"])) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Theme must be a valid theme id" }] };
      }
      changes.theme = attrs["theme"];
    }
    if (Object.keys(changes).length === 0) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "No account fields provided" }] };
    }

    try {
      await db.update(users).set(changes).where(eq(users.id, user.id));
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        (set as { status: number }).status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "Username is already in use" }] };
      }
      throw error;
    }

    return { data: userResource({ ...user, ...changes }) };
  })
  .patch("/api/v2/account/password", async ({ user, token, body, set }: AuthReqCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const attrs = extractAttrs(body) ?? {};
    const currentPassword = typeof attrs["current_password"] === "string" ? attrs["current_password"] : (typeof attrs["current-password"] === "string" ? attrs["current-password"] : "");
    const password = typeof attrs["password"] === "string" ? attrs["password"] : "";
    const confirmation = typeof attrs["password_confirmation"] === "string" ? attrs["password_confirmation"] : (typeof attrs["password-confirmation"] === "string" ? attrs["password-confirmation"] : "");
    if (currentPassword === "" || password === "" || password !== confirmation) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid password change request" }] };
    }
    const changePolicy = checkPasswordPolicy(loadPasswordPolicy(), password, user.username);
    if (!changePolicy.ok) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: changePolicy.errors.join(" ") }] };
    }
    // passwordMatches swallows malformed/unusable hashes (SSO-provisioned
    // accounts), so a bad hash cannot surface as a 500; it is just a failed
    // password check.
    if (!(await passwordMatches(currentPassword, user.passwordHash))) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Current password is incorrect" }] };
    }

    const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
    await db.transaction(async (tx: unknown): Promise<void> => {
      const t = tx as typeof db;
      await t.update(users)
        .set({ passwordHash, mustChangePassword: false })
        .where(eq(users.id, user.id));
      if (token !== null && token !== undefined) {
        await t.delete(apiTokens)
          .where(and(eq(apiTokens.userId, user.id), ne(apiTokens.id, token.id)));
      }
      await t.update(refreshSessions)
        .set({ revokedAt: Date.now() })
        .where(and(eq(refreshSessions.userId, user.id), isNull(refreshSessions.revokedAt)));
    });
    return { data: userResource({ ...user, mustChangePassword: false }) };
  })

  // ---- Multi-factor authentication (TOTP) ----
  .get("/api/v2/account/mfa", async ({ user, set }: AuthReqCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const mfa = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, user.id) });
    return {
      data: {
        type: "mfa",
        attributes: { enabled: mfa !== undefined && mfa.enabled === true },
      },
    };
  })
  .post("/api/v2/account/mfa/enroll", async ({ user, body, set }: AuthReqCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const passwordError = await requireCurrentPassword(user, body, set);
    if (passwordError !== null) return passwordError;
    const existing = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, user.id) });
    if (existing !== undefined && existing.enabled === true) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "MFA is already enabled" }] };
    }

    const secret = generateTotpSecret();
    const account = user.email ?? user.username;
    const otpauth = otpauthUrl(secret, account);
    // Store the seed ENCRYPTED at rest (todo 110): pending (enabled=false);
    // verify flips it on after a valid code. The plaintext column keeps "" so
    // the NOT NULL constraint holds; readers prefer secretEncrypted.
    const secretEncrypted = await encryptSecret(secret);
    await db.insert(user2FA).values({ userId: user.id, secret: "", secretEncrypted, enabled: false }).onConflictDoUpdate({
      target: user2FA.userId,
      set: { secret: "", secretEncrypted, enabled: false, lastAcceptedCounter: null },
    });
    await auditLog("enroll", "mfa", user.id, user.id, null, { userId: user.id });
    return {
      data: {
        type: "mfa",
        attributes: { secret, "otpauth-url": otpauth },
      },
    };
  })
  .post("/api/v2/account/mfa/verify", async ({ user, body, request, set }: AuthReqCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attrs = extractAttrs(body) ?? {};
    const code = typeof attrs["code"] === "string" ? attrs["code"] : "";
    if (code === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Code is required" }] };
    }
    const mfa = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, user.id) });
    if (mfa === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid authentication code" }] };
    }
    const seedUpdate = mfa.secretEncrypted === null && mfa.secret !== ""
      ? { secret: "", secretEncrypted: await encryptSecret(mfa.secret) }
      : {};
    if (!(await acceptTotpCode(user.id, mfa, code, { ...seedUpdate, enabled: true }))) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid authentication code" }] };
    }
    await auditLog("verify", "mfa", user.id, user.id, null, { userId: user.id });
    const token = refreshCookieCandidates(request)[0];
    if (token !== undefined && token !== "") {
      const session = await refreshSessionForToken(token);
      if (session !== undefined) {
        await db.update(refreshSessions)
          .set({ mfaVerified: true })
          .where(eq(refreshSessions.id, session.id));
      }
    }
    return { data: { type: "mfa", attributes: { enabled: true } } };
  })
  .delete("/api/v2/account/mfa", async ({ user, body, set }: AuthReqCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const mfa = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, user.id) });
    if (mfa === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: "MFA is not enabled" }] };
    }
    if (mfa.enabled !== true) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: "MFA is not enabled" }] };
    }
    const attrs = extractAttrs(body) ?? {};
    const code = typeof attrs["code"] === "string" ? attrs["code"] : "";
    if (code === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Code is required" }] };
    }
    const passwordError = await requireCurrentPassword(user, body, set);
    if (passwordError !== null) return passwordError;
    if (!(await acceptTotpCode(user.id, mfa, code))) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid authentication code" }] };
    }
    await db.delete(user2FA).where(eq(user2FA.userId, user.id));
    await auditLog("remove", "mfa", user.id, user.id, null, { userId: user.id });
    return { data: { type: "mfa", attributes: { enabled: false } } };
  });
