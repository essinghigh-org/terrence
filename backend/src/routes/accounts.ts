import { Elysia } from "elysia";
import { db } from "../db";
import { users, apiTokens, refreshSessions, organizationMemberships, organizations, samlSettings, teams, user2FA } from "../db/schema";
import { and, count, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { userResource } from "../lib/response";
import { isUniqueConstraintError } from "../lib/validation";
import { auditLog } from "../lib/utils";
import { authPlugin } from "../auth";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../lib/totp";

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_COOKIE = "terrence_refresh";
const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
// ponytail: one Bun process is the deployment model; use database row locks if horizontal scaling is added.
let refreshRotationQueue = Promise.resolve();

// In-memory MFA login challenges: token -> { userId, expiresAt }.
// Single-process deployment; challenges expire after 5 minutes.
const mfaChallenges = new Map<string, { userId: string; expiresAt: number }>();

async function withRefreshRotationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = refreshRotationQueue;
  let release!: () => void;
  refreshRotationQueue = new Promise<void>((resolve): void => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
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

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type RequestInfo = Readonly<{
  url: string;
  headers: Readonly<{ get: (name: string) => string | null }>;
}>;

type ReqCtx = Readonly<{
  body?: unknown;
  request?: RequestInfo;
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
  body?: unknown;
  set: SetObj;
}>;

function opaqueToken(prefix: string): string {
  return `${prefix}-${randomBytes(32).toString("base64url")}`;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function refreshCookie(request: RequestInfo | undefined): string | undefined {
  for (const part of request?.headers.get("cookie")?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === REFRESH_COOKIE) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function secureRequest(request: RequestInfo | undefined): boolean {
  const forwarded = request?.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded === "https" || (request !== undefined && new URL(request.url).protocol === "https:");
}

function setRefreshCookie(
  set: SetObj,
  request: RequestInfo | undefined,
  token: string,
  expiresAt: number,
): void {
  const maxAge = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  const secure = secureRequest(request) ? "; Secure" : "";
  (set.headers as Record<string, string | number>)["Set-Cookie"] =
    `${REFRESH_COOKIE}=${token}; Path=/api/v2/users; HttpOnly; SameSite=Lax; Max-Age=${String(maxAge)}${secure}`;
}

function clearRefreshCookie(set: SetObj, request: RequestInfo | undefined): void {
  const secure = secureRequest(request) ? "; Secure" : "";
  (set.headers as Record<string, string | number>)["Set-Cookie"] =
    `${REFRESH_COOKIE}=; Path=/api/v2/users; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function accessTokenDocument(
  id: string,
  token: string,
  user: Readonly<typeof users.$inferSelect>,
  expiresAt?: number,
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
          : { "expired-at": new Date(expiresAt).toISOString(), refreshable: true }),
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

/**
 * Issue an access token (+ refresh session for browser logins) after
 * successful authentication. Shared by /users/login and /users/login/mfa.
 */
async function issueLoginSession(
  user: Readonly<typeof users.$inferSelect>,
  browserSession: boolean,
  set: SetObj,
  request: RequestInfo | undefined,
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
      expiresAt: refreshExpiresAt,
      createdAt,
    });
  });
  setRefreshCookie(set, request, refreshToken, refreshExpiresAt);
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
    lastRotatedAt: number | null;
  }>();
  for (const session of sessions) {
    const existing = families.get(session.familyId);
    families.set(session.familyId, {
      active: (existing?.active ?? false) || session.rotatedAt === null,
      createdAt: Math.min(existing?.createdAt ?? session.createdAt, session.createdAt),
      current: (existing?.current ?? false) || session.accessTokenId === currentAccessTokenId,
      expiresAt: Math.max(existing?.expiresAt ?? session.expiresAt, session.expiresAt),
      lastRotatedAt: session.rotatedAt === null
        ? existing?.lastRotatedAt ?? null
        : Math.max(existing?.lastRotatedAt ?? session.rotatedAt, session.rotatedAt),
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
        current: family.current,
      },
    }));
}

function refreshUnauthorized(
  set: SetObj,
  request: RequestInfo | undefined,
  detail: string,
): Record<string, unknown> {
  (set as { status: number }).status = 401;
  clearRefreshCookie(set, request);
  return { errors: [{ status: "401", title: "Unauthorized", detail }] };
}

export const accountRoutes = new Elysia({ name: "accounts" })
  // Public routes (no auth required)
  .post("/admin/initial-admin-user", async ({ body, request, set }: ReqCtx): Promise<unknown> => {
    const configuredToken = process.env.IACT_TOKEN;
    const suppliedToken = request === undefined ? null : new URL(request.url).searchParams.get("token");
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
    const username = typeof payload.username === "string" ? payload.username.trim() : "";
    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    const password = typeof payload.password === "string" ? payload.password : "";
    if (username === "" || email === "" || password.length < 10) {
      (set as { status: number }).status = 422;
      return { status: "error", error: "Username, email, and a password of at least 10 characters are required" };
    }

    const userId = `user-${crypto.randomUUID()}`;
    const organizationId = `org-${crypto.randomUUID()}`;
    const configuredOrganizationName = (process.env.ADMIN_ORGANIZATION ?? "default").trim();
    const organizationName = configuredOrganizationName === "" ? "default" : configuredOrganizationName;
    const token = `user-${crypto.randomUUID()}`;
    const passwordHash = await bcrypt.hash(password, 10);
    const createdOrganizationId = await db.transaction(async (tx: unknown): Promise<string | null> => {
      const t = tx as typeof db;
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
        token: createHash("sha256").update(token).digest("hex"),
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
    delete process.env.IACT_TOKEN;
    await auditLog("create", "users", userId, userId, createdOrganizationId, { username, source: "IACT_TOKEN" });
    return { status: "created", token };
  })
  .post("/api/v2/users/login", async ({ body, request, set }: ReqCtx): Promise<unknown> => {
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
    const username = typeof attrs.username === "string" ? attrs.username : "";
    const password = typeof attrs.password === "string" ? attrs.password : "";
    const browserSession = attrs["browser-session"] === true;

    if (username === "" || password === "") {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Missing credentials" }] };
    }

    const user = await db.query.users.findFirst({
      where: or(eq(users.username, username), eq(users.email, username)),
    });

    if (user === undefined || !(await bcrypt.compare(password, user.passwordHash))) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid username or password" }] };
    }

    // If MFA is enabled for this account, issue a short-lived challenge token
    // instead of an access token. The client completes login via
    // POST /users/login/mfa with a valid TOTP code.
    const mfa = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, user.id) });
    if (mfa !== undefined && mfa.enabled === true) {
      const challengeToken = opaqueToken("mfa");
      mfaChallenges.set(challengeToken, { userId: user.id, expiresAt: Date.now() + MFA_CHALLENGE_TTL_MS });
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

    return issueLoginSession(user, browserSession, set, request);
  })
  .post("/api/v2/users/login/mfa", async ({ body, request, set }: ReqCtx): Promise<unknown> => {
    let payload: DataPayload | undefined;
    if (typeof body === "string") {
      try {
        payload = JSON.parse(body) as DataPayload;
      } catch {
        payload = undefined;
      }
    } else if (body !== null && typeof body === "object") {
      payload = body as DataPayload;
    }
    const attrs = payload?.data?.attributes ?? {};
    const challengeToken = typeof attrs["challenge-token"] === "string" ? attrs["challenge-token"] : "";
    const code = typeof attrs.code === "string" ? attrs.code : "";
    const browserSession = attrs["browser-session"] === true;

    if (challengeToken === "" || code === "") {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Missing MFA challenge token or code" }] };
    }

    const challenge = mfaChallenges.get(challengeToken);
    if (challenge === undefined || challenge.expiresAt < Date.now()) {
      mfaChallenges.delete(challengeToken);
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "MFA challenge has expired or is invalid" }] };
    }

    const mfa = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, challenge.userId) });
    if (mfa === undefined || mfa.enabled !== true || !verifyTotp(mfa.secret, code)) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid authentication code" }] };
    }

    const user = await db.query.users.findFirst({ where: eq(users.id, challenge.userId) });
    if (user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Account not found" }] };
    }

    mfaChallenges.delete(challengeToken);
    return issueLoginSession(user, browserSession, set, request);
  })
  .post("/api/v2/users/refresh", async ({ request, set }: ReqCtx): Promise<unknown> => {
    const presentedToken = refreshCookie(request);
    if (presentedToken === undefined || presentedToken === "") {
      return refreshUnauthorized(set, request, "Refresh session is missing");
    }
    return withRefreshRotationLock(async (): Promise<unknown> => {
      const current = await db.query.refreshSessions.findFirst({
        where: eq(refreshSessions.tokenHash, tokenHash(presentedToken)),
      });
      if (current === undefined) {
        return refreshUnauthorized(set, request, "Refresh session is invalid");
      }

      const now = Date.now();
      if (current.rotatedAt !== null || current.revokedAt !== null || current.expiresAt <= now) {
        await revokeRefreshFamily(current.familyId, current.userId, now);
        return refreshUnauthorized(
          set,
          request,
          current.rotatedAt !== null ? "Refresh token reuse detected" : "Refresh session expired",
        );
      }
      const user = await db.query.users.findFirst({ where: eq(users.id, current.userId) });
      if (user === undefined) {
        await revokeRefreshFamily(current.familyId, current.userId, now);
        return refreshUnauthorized(set, request, "Refresh session is invalid");
      }

      const accessToken = opaqueToken("user");
      const accessTokenId = crypto.randomUUID();
      const refreshToken = opaqueToken("refresh");
      const accessExpiresAt = now + ACCESS_TOKEN_TTL_MS;
      const rotated = await db.transaction(async (tx: unknown): Promise<boolean> => {
        const t = tx as typeof db;
        const claimed = await t.update(refreshSessions)
          .set({ rotatedAt: now })
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
        });
        return true;
      });
      if (!rotated) {
        await revokeRefreshFamily(current.familyId, current.userId, now);
        return refreshUnauthorized(set, request, "Refresh token reuse detected");
      }

      setRefreshCookie(set, request, refreshToken, current.expiresAt);
      return accessTokenDocument(accessTokenId, accessToken, user, accessExpiresAt);
    });
  })
  .post("/api/v2/users/logout", async ({ request, set }: ReqCtx): Promise<unknown> => {
    const presentedToken = refreshCookie(request);
    if (presentedToken !== undefined && presentedToken !== "") {
      await withRefreshRotationLock(async (): Promise<void> => {
        const current = await db.query.refreshSessions.findFirst({
          where: eq(refreshSessions.tokenHash, tokenHash(presentedToken)),
        });
        if (current !== undefined) await revokeRefreshFamily(current.familyId, current.userId);
      });
    }
    clearRefreshCookie(set, request);
    (set as { status: number }).status = 204;
    return undefined;
  })
  .post("/api/v2/users", async ({ body, set }: ReqCtx): Promise<unknown> => {
    if (process.env.TERRENCE_ENABLE_LOCAL_SIGNUP !== "true") {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: "Local signup is disabled on this instance. Set TERRENCE_ENABLE_LOCAL_SIGNUP=true or use ADMIN_PASSWORD bootstrap." }] };
    }
    const attrs = extractAttrs(body) ?? {};
    const username = typeof attrs.username === "string" ? attrs.username : "";
    const password = typeof attrs.password === "string" ? attrs.password : "";
    const email = attrs.email;

    if (username === "" || password === "") {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Missing username or password" }] };
    }

    if (password.length < 10) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Password must be at least 10 characters" }] };
    }
    const RFC_5322_EMAIL_REGEX = /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])$/i;

    const emailStr = typeof email === "string" && email.trim() !== "" ? email.trim() : `${username}@example.com`;
    if (!RFC_5322_EMAIL_REGEX.test(emailStr)) {
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

    const passwordHash = await bcrypt.hash(password, 10);
    const id = crypto.randomUUID();
    const normalizedEmail = typeof email === "string" && email.trim() !== "" ? email.trim() : null;

    try {
      const isSiteAdmin = await db.transaction(async (tx: unknown): Promise<boolean> => {
        const t = tx as typeof db;
        const userCount = (await t.select({ val: count() }).from(users))[0]?.val ?? 0;
        const admin = userCount === 0;
        await t.insert(users).values({ id, username, email: normalizedEmail, passwordHash, isSiteAdmin: admin });
        return admin;
      });
      await auditLog("create", "users", id, null, null, { username });
      (set as { status: number }).status = 201;
      return {
        data: {
          id,
          type: "users",
          attributes: { username, email: normalizedEmail, "is-site-admin": isSiteAdmin },
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
  .delete("/api/v2/account/sessions/:family_id", async ({ params, request, user, token, set }: AuthReqCtx): Promise<unknown> => {
    const familyId = params?.family_id ?? "";
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
    if (current) clearRefreshCookie(set, request);
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

    const changes: { username?: string; email?: string | null } = {};
    if (Object.hasOwn(attrs, "username")) {
      if (typeof attrs.username !== "string" || attrs.username.trim() === "") {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Username cannot be empty" }] };
      }
      changes.username = attrs.username.trim();
    }
    if (Object.hasOwn(attrs, "email")) {
      const emailVal = attrs.email;
      if (emailVal !== null && (typeof emailVal !== "string" || emailVal.trim() === "")) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Email must be a string or null" }] };
      }
      changes.email = emailVal === null ? null : emailVal.trim();
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
    const currentPassword = typeof attrs.current_password === "string" ? attrs.current_password : (typeof attrs["current-password"] === "string" ? attrs["current-password"] : "");
    const password = typeof attrs.password === "string" ? attrs.password : "";
    const confirmation = typeof attrs.password_confirmation === "string" ? attrs.password_confirmation : (typeof attrs["password-confirmation"] === "string" ? attrs["password-confirmation"] : "");
    if (currentPassword === "" || password === "" || password !== confirmation || password.length < 10) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid password change request" }] };
    }
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Current password is incorrect" }] };
    }

    const passwordHash = await bcrypt.hash(password, 10);
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
  .post("/api/v2/account/mfa/enroll", async ({ user, set }: AuthReqCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const existing = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, user.id) });
    if (existing !== undefined && existing.enabled === true) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "MFA is already enabled" }] };
    }

    const secret = generateTotpSecret();
    const account = user.email ?? user.username;
    const otpauth = otpauthUrl(secret, account);
    // Store as pending (enabled=false); verify flips it on after a valid code.
    await db.insert(user2FA).values({ userId: user.id, secret, enabled: false }).onConflictDoUpdate({
      target: user2FA.userId,
      set: { secret, enabled: false },
    });
    return {
      data: {
        type: "mfa",
        attributes: { secret, "otpauth-url": otpauth },
      },
    };
  })
  .post("/api/v2/account/mfa/verify", async ({ user, body, set }: AuthReqCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attrs = extractAttrs(body) ?? {};
    const code = typeof attrs.code === "string" ? attrs.code : "";
    if (code === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Code is required" }] };
    }
    const mfa = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, user.id) });
    if (mfa === undefined || !verifyTotp(mfa.secret, code)) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid authentication code" }] };
    }
    await db.update(user2FA).set({ enabled: true }).where(eq(user2FA.userId, user.id));
    return { data: { type: "mfa", attributes: { enabled: true } } };
  })
  .delete("/api/v2/account/mfa", async ({ user, body, set }: AuthReqCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attrs = extractAttrs(body) ?? {};
    const code = typeof attrs.code === "string" ? attrs.code : "";
    if (code === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Code is required" }] };
    }
    const mfa = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, user.id) });
    if (mfa === undefined || mfa.enabled !== true) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: "MFA is not enabled" }] };
    }
    if (!verifyTotp(mfa.secret, code)) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid authentication code" }] };
    }
    await db.delete(user2FA).where(eq(user2FA.userId, user.id));
    return { data: { type: "mfa", attributes: { enabled: false } } };
  });
