import { newResourceId } from "../../lib/resource-id";
import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import { db } from "../../db";
import { users, apiTokens, refreshSessions, user2FA, emailVerificationTokens, identityLinks, organizationMemberships, teamMemberships, scimUserIdentities } from "../../db/schema";
import type { SQL } from "drizzle-orm";
import { eq, and, or, count, isNull } from "drizzle-orm";
import { auditLog, caseInsensitiveLike, pageRequest, pagination, sensitiveIdentifierHash, withOrganizationMembershipLocks } from "../../lib/utils";
import { isUniqueConstraintError } from "../../lib/validation";
import { checkPasswordPolicy, loadPasswordPolicy } from "../../lib/password-policy";
import { hashPassword } from "../../lib/password-hashing";
import { generateAuthenticationToken, hashAuthenticationToken } from "../../lib/token-service";
import type { ParamCtx } from "./types";
import { type UserItem, adminUserResource } from "./helpers";
import { publish } from "../../lib/event-bus";
import { normalizeEmail, normalizeUsername } from "../../lib/identity";
import { IMPERSONATION_TOKEN_PREFIX, isImpersonationTokenId } from "../../lib/impersonation";
function parseAdminUserCreate(
  body: unknown,
  set: ParamCtx["set"],
): { username: string; email: string | null; password: string; isSiteAdmin: boolean } | { error: unknown } {
  const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = payload["data"] as Record<string, unknown> | undefined;
  const attrs = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
  const username = typeof attrs["username"] === "string" ? normalizeUsername(attrs["username"]) : null;
  const rawEmail = typeof attrs["email"] === "string" ? attrs["email"].trim() : null;
  const email = rawEmail === null || rawEmail === "" ? null : normalizeEmail(rawEmail);
  const password = typeof attrs["password"] === "string" ? attrs["password"] : "";
  const isSiteAdmin = attrs["is-site-admin"] === true;
  if (username === null) {
    (set as { status: number }).status = 422;
    return { error: { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Username is required" }] } };
  }
  if (rawEmail !== null && rawEmail !== "" && email === null) {
    (set as { status: number }).status = 422;
    return { error: { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid email" }] } };
  }
  return { username, email, password, isSiteAdmin };
}

async function checkAdminUserCreate(
  username: string,
  email: string | null,
  password: string,
  set: ParamCtx["set"],
): Promise<{ ok: true } | { error: unknown }> {
  const adminPolicy = checkPasswordPolicy(loadPasswordPolicy(), password, username);
  if (!adminPolicy.ok) {
    (set as { status: number }).status = 422;
    return { error: { errors: [{ status: "422", title: "Unprocessable Entity", detail: adminPolicy.errors.join(" ") }] } };
  }
  const existing = await db.query.users.findFirst({ where: or(eq(users.username, username), ...(email === null ? [] : [eq(users.email, email)])) });
  if (existing !== undefined) {
    (set as { status: number }).status = 409;
    return { error: { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] } };
  }
  return { ok: true };
}

async function insertAdminUser(
  username: string,
  email: string | null,
  password: string,
  isSiteAdmin: boolean,
  set: ParamCtx["set"],
): Promise<{ created: typeof users.$inferSelect } | { error: unknown }> {
  const passwordHash = await hashPassword(password);
  const id = newResourceId("user");
  try {
    await db.insert(users).values({ id, username, email, passwordHash, isSiteAdmin });
  } catch (e: unknown) {
    if (isUniqueConstraintError(e)) {
      (set as { status: number }).status = 409;
      return { error: { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] } };
    }
    throw e;
  }
  const created = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (created === undefined) { (set as { status: number }).status = 500; return { error: { errors: [{ status: "500", title: "Internal Server Error" }] } }; }
  return { created };
}

async function findAdminUserTarget(
  userId: string,
  set: ParamCtx["set"],
): Promise<{ target: typeof users.$inferSelect } | { error: unknown }> {
  const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (targetUser === undefined) { (set as { status: number }).status = 404; return { error: { errors: [{ status: "404", title: "Not Found" }] } }; }
  if ((targetUser as unknown as { deletedAt?: unknown }).deletedAt != null) { (set as { status: number }).status = 404; return { error: { errors: [{ status: "404", title: "Not Found" }] } }; }
  return { target: targetUser };
}

function adminUserAttributes(body: unknown): Record<string, unknown> {
  const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = payload["data"] as Record<string, unknown> | undefined;
  return typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
}

async function parseAdminUsernameUpdate(
  attributes: Record<string, unknown>,
  userId: string,
  set: ParamCtx["set"],
): Promise<{ username: string | null } | { error: unknown }> {
  if (typeof attributes["username"] !== "string") return { username: null };
  const username = normalizeUsername(attributes["username"]);
  if (username === null) {
    (set as { status: number }).status = 422;
    return { error: { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid username" }] } };
  }
  const claimant = await db.query.users.findFirst({ where: eq(users.username, username), columns: { id: true } });
  if (claimant !== undefined && claimant.id !== userId) {
    (set as { status: number }).status = 409;
    return { error: { errors: [{ status: "409", title: "Conflict", detail: "That username is already in use" }] } };
  }
  return { username };
}

async function parseAdminEmailUpdate(
  attributes: Record<string, unknown>,
  userId: string,
  currentEmail: string | null,
  set: ParamCtx["set"],
): Promise<{ email: string | null; changed: boolean } | { skipped: true } | { error: unknown }> {
  if (attributes["email"] !== null && typeof attributes["email"] !== "string") return { skipped: true };
  const raw = attributes["email"] === null ? "" : attributes["email"].trim();
  const email = raw === "" ? null : normalizeEmail(raw);
  if (email === null && raw !== "") {
    (set as { status: number }).status = 422;
    return { error: { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid email" }] } };
  }
  if (email !== null) {
    const claimant = await db.query.users.findFirst({ where: eq(users.email, email), columns: { id: true } });
    if (claimant !== undefined && claimant.id !== userId) {
      (set as { status: number }).status = 409;
      return { error: { errors: [{ status: "409", title: "Conflict", detail: "That email address is already in use" }] } };
    }
  }
  return { email, changed: email !== currentEmail };
}

async function persistAdminUserUpdates(
  userId: string,
  updates: Partial<typeof users.$inferInsert>,
  set: ParamCtx["set"],
): Promise<{ persisted: true } | { error: unknown }> {
  if (Object.keys(updates).length === 0) return { persisted: true };
  try {
    await db.update(users).set(updates).where(eq(users.id, userId));
  } catch (e: unknown) {
    if (isUniqueConstraintError(e)) {
      (set as { status: number }).status = 409;
      return { error: { errors: [{ status: "409", title: "Conflict", detail: "That identity is already in use" }] } };
    }
    throw e;
  }
  return { persisted: true };
}

function checkResetEligibility(
  target: typeof users.$inferSelect,
  userId: string,
  set: ParamCtx["set"],
): { ok: true } | { error: unknown } {
  if (target.id === userId || target.ssoProvider !== null || target.passwordHash.startsWith("$disabled$")) {
    (set as { status: number }).status = 422;
    return { error: { errors: [{ status: "422", title: "Unprocessable Entity", detail: target.id === userId
      ? "Change your own password in account settings."
      : "Reset this user's password through their identity provider." }] } };
  }
  return { ok: true };
}

function checkResetPasswordInput(
  body: unknown,
  username: string,
  set: ParamCtx["set"],
): { password: string } | { error: unknown } {
  const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
  const data = payload["data"] !== null && typeof payload["data"] === "object" ? payload["data"] as Record<string, unknown> : {};
  const attrs = data["attributes"] !== null && typeof data["attributes"] === "object" ? data["attributes"] as Record<string, unknown> : {};
  const password = typeof attrs["password"] === "string" ? attrs["password"] : "";
  const policy = checkPasswordPolicy(loadPasswordPolicy(), password, username);
  if (!policy.ok || password !== attrs["password-confirmation"]) {
    (set as { status: number }).status = 422;
    return { error: { errors: [{ status: "422", title: "Unprocessable Entity", detail: !policy.ok ? policy.errors.join(" ") : "Passwords do not match." }] } };
  }
  return { password };
}

async function applyPasswordReset(
  userId: string,
  targetPasswordHash: string,
  passwordHash: string,
): Promise<UserItem | undefined> {
  return db.transaction(async (tx: unknown): Promise<UserItem | undefined> => {
    const t = tx as typeof db;
    const [changed] = await t.update(users).set({ passwordHash, mustChangePassword: true })
      .where(and(eq(users.id, userId), eq(users.passwordHash, targetPasswordHash), isNull(users.deletedAt)))
      .returning();
    if (changed === undefined) return undefined;
    await t.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await t.update(refreshSessions).set({ revokedAt: Date.now() })
      .where(and(eq(refreshSessions.userId, userId), isNull(refreshSessions.revokedAt)));
    return changed;
  });
}

async function endImpersonationSession(
  token: ParamCtx["token"],
  set: ParamCtx["set"],
): Promise<{ ended: true } | { error: unknown }> {
  const tokenId = token?.id;
  const impersonationToken = tokenId !== undefined && isImpersonationTokenId(tokenId)
    ? await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, tokenId) })
    : undefined;
  if (impersonationToken === undefined) { (set as { status: number }).status = 404; return { error: { errors: [{ status: "404", title: "Not Found" }] } }; }
  const impersonatorName = /^Impersonation by (.+)$/.exec(impersonationToken.description ?? "")?.[1];
  const impersonator = impersonatorName === undefined
    ? undefined
    : await db.query.users.findFirst({ where: eq(users.username, impersonatorName), columns: { id: true } });
  await db.delete(apiTokens).where(eq(apiTokens.id, impersonationToken.id));
  await auditLog("unimpersonate", "users", impersonationToken.userId, impersonationToken.userId, null, {
    targetUserId: impersonationToken.userId,
    impersonatorUserId: impersonator?.id ?? null,
    effectiveUserId: impersonationToken.userId,
    impersonationTokenId: impersonationToken.id,
  }, { effectiveUserId: impersonationToken.userId });
  (set as { status: number }).status = 204;
  return { ended: true };
}

export const usersRoutes = new Elysia({ name: "admin-users" })
  .use(authPlugin)
  .get("/api/v2/admin/users", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const url = new URL(request.url);
    const filterAdmin = url.searchParams.get("filter[admin]");
    const filterSuspended = url.searchParams.get("filter[suspended]");
    const q = url.searchParams.get("q") ?? "";
    const { number, size } = pageRequest(request);
    const conditions: SQL[] = [isNull(users.deletedAt)];
    if (filterAdmin === "true") conditions.push(eq(users.isSiteAdmin, true));
    if (filterAdmin === "false") conditions.push(eq(users.isSiteAdmin, false));
    if (filterSuspended === "true") conditions.push(eq(users.isSuspended, true));
    if (filterSuspended === "false") conditions.push(eq(users.isSuspended, false));
    if (q !== "") {
      const pattern = `%${q}%`;
      conditions.push(or(caseInsensitiveLike(users.username, pattern), caseInsensitiveLike(users.email, pattern))!);
    }
    const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);
    const [allUsers, countRows] = await Promise.all([
      db.query.users.findMany({ where, limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(users).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: allUsers.map((u: UserItem) => adminUserResource(u)), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/admin/users", async ({ body, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const parsed = parseAdminUserCreate(body, set);
    if ("error" in parsed) return parsed.error;
    const checked = await checkAdminUserCreate(parsed.username, parsed.email, parsed.password, set);
    if ("error" in checked) return checked.error;
    const inserted = await insertAdminUser(parsed.username, parsed.email, parsed.password, parsed.isSiteAdmin, set);
    if ("error" in inserted) return inserted.error;
    (set as { status: number }).status = 201;
    return { data: adminUserResource(inserted.created) };
  })
  .get("/api/v2/admin/users/:user_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const userId = params["user_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if ((targetUser as unknown as { deletedAt?: unknown }).deletedAt != null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: adminUserResource(targetUser) };
  })
  .patch("/api/v2/admin/users/:user_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const userId = params["user_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const found = await findAdminUserTarget(userId, set);
    if ("error" in found) return found.error;
    const targetUser = found.target;
    const attributes = adminUserAttributes(body);
    const updates: Partial<typeof users.$inferInsert> = {};
    const nameParsed = await parseAdminUsernameUpdate(attributes, userId, set);
    if ("error" in nameParsed) return nameParsed.error;
    if (nameParsed.username !== null) updates.username = nameParsed.username;
    const emailParsed = await parseAdminEmailUpdate(attributes, userId, targetUser.email, set);
    if ("error" in emailParsed) return emailParsed.error;
    if (!("skipped" in emailParsed)) {
      updates.email = emailParsed.email;
      if (emailParsed.changed) updates.emailVerifiedAt = null;
    }
    const persisted = await persistAdminUserUpdates(userId, updates, set);
    if ("error" in persisted) return persisted.error;
    if (Object.keys(updates).length > 0) {
      await auditLog("update", "users", userId, user.id, null, { fields: Object.keys(updates) });
      publish("authz.changed", { "user-id": userId });
    }
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: adminUserResource(updated) };
  })
  .delete("/api/v2/admin/users/:user_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const userId = params["user_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if ((targetUser as unknown as { deletedAt?: unknown }).deletedAt != null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ownedMemberships = await db.query.organizationMemberships.findMany({
      where: and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.role, "owner"), eq(organizationMemberships.status, "active")),
      columns: { orgId: true },
    });
    const ownedOrgIds = ownedMemberships.map((membership): string => membership.orgId);
    const now = Date.now();
    const emailHash = (targetUser as unknown as { email?: string | null }).email ? sensitiveIdentifierHash(String((targetUser as unknown as { email?: string | null }).email).toLowerCase()) : null;
    let blockedLastOwner = false;
    let lockedOrgIds = ownedOrgIds;
    const maxOwnerLockRetries = 5;
    for (let attempt = 0; ; attempt += 1) {
      let retryOrgIds: string[] | null = null;
      await withOrganizationMembershipLocks(lockedOrgIds, async (): Promise<void> => {
        await db.transaction(async (tx: unknown): Promise<void> => {
        const t = tx as typeof db;
        const currentOwnedOrgIds = [...new Set((await t.query.organizationMemberships.findMany({
          where: and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.role, "owner"), eq(organizationMemberships.status, "active")),
          columns: { orgId: true },
        })).map((membership): string => membership.orgId))];
        if (currentOwnedOrgIds.some((orgId): boolean => !lockedOrgIds.includes(orgId))) {
          retryOrgIds = currentOwnedOrgIds;
          return;
        }
        for (const orgId of currentOwnedOrgIds) {
          const owners = await t.select({ total: count() }).from(organizationMemberships).where(and(
            eq(organizationMemberships.orgId, orgId),
            eq(organizationMemberships.role, "owner"),
            eq(organizationMemberships.status, "active"),
          ));
          if ((owners[0]?.total ?? 0) <= 1) {
            blockedLastOwner = true;
            return;
          }
        }
        await t.delete(teamMemberships).where(eq(teamMemberships.userId, userId));
        await t.delete(organizationMemberships).where(eq(organizationMemberships.userId, userId));
        await t.delete(scimUserIdentities).where(eq(scimUserIdentities.userId, userId));
        await t.delete(identityLinks).where(eq(identityLinks.userId, userId));
        await t.delete(user2FA).where(eq(user2FA.userId, userId));
        await t.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, userId));
        await t.delete(apiTokens).where(eq(apiTokens.userId, userId));
        await t.update(refreshSessions).set({ revokedAt: now }).where(and(eq(refreshSessions.userId, userId), isNull(refreshSessions.revokedAt)));
        await t.update(users).set({
          deletedAt: now,
          deletedEmailHash: emailHash,
          username: `deleted-${crypto.randomUUID()}`,
          email: null,
          passwordHash: `$disabled$${crypto.randomUUID()}`,
          isSiteAdmin: false,
          isSiteAuditor: false,
          isSuspended: true,
          isProvisional: false,
          mustChangePassword: false,
          ssoProvider: null,
          ssoSubject: null,
          ssoSiteAdmin: false,
          scimSiteAdmin: false,
        }).where(eq(users.id, userId));
        });
      });
      if (retryOrgIds === null) break;
      if (attempt >= maxOwnerLockRetries) {
        (set as { status: number }).status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "Organization ownership changed while deleting the account. Retry the request." }] };
      }
      lockedOrgIds = retryOrgIds;
    }
    if (blockedLastOwner) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Cannot delete the sole active owner of an organization" }] };
    }
    const { auditLog } = await import("../../lib/utils");
    await auditLog("delete", "users", userId, user?.id ?? null, null, { username: (targetUser as unknown as { username?: string }).username });
    publish("authz.changed", { "user-id": userId });
    (set as { status: number }).status = 204;
    return {};
  })
  // --- User Actions ---
  .post("/api/v2/admin/users/:user_id/actions/reset_password", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userId = params["user_id"] ?? "";
    const target = await db.query.users.findFirst({ where: and(eq(users.id, userId), isNull(users.deletedAt)) });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const eligible = checkResetEligibility(target, user.id, set);
    if ("error" in eligible) return eligible.error;
    const input = checkResetPasswordInput(body, target.username, set);
    if ("error" in input) return input.error;
    const passwordHash = await hashPassword(input.password);
    const updated = await applyPasswordReset(userId, target.passwordHash, passwordHash);
    if (updated === undefined) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "This account changed while resetting its password. Reload and try again." }] };
    }
    await auditLog("reset-password", "users", userId, user.id, null, { "must-change-password": true });
    publish("authz.changed", { "user-id": userId });
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/suspend", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userId = params["user_id"] ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined || target.deletedAt !== null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if ((target as Record<string, unknown>)["isSuspended"] === true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is already suspended" }] }; }
    await db.transaction(async (tx: unknown): Promise<void> => {
      const t = tx as typeof db;
      await t.update(users).set({ isSuspended: true }).where(eq(users.id, userId));
      await t.delete(apiTokens).where(eq(apiTokens.userId, userId));
      await t.update(refreshSessions).set({ revokedAt: Date.now() }).where(and(eq(refreshSessions.userId, userId), isNull(refreshSessions.revokedAt)));
    });
    try { const { auditLog: al } = await import("../../lib/utils"); await al("suspend", "users", userId, user?.id ?? null, null, { username: (target as unknown as { username?: string }).username }); } catch {}
    // A suspended user must lose live event access immediately, not after
    // the SSE connection's one-hour permission-snapshot lifetime.
    publish("authz.changed", { "user-id": userId });
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/unsuspend", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userId = params["user_id"] ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined || target.deletedAt !== null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if ((target as Record<string, unknown>)["isSuspended"] !== true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is not suspended" }] }; }
    await db.update(users).set({ isSuspended: false }).where(eq(users.id, userId));
    try { const { auditLog: al } = await import("../../lib/utils"); await al("unsuspend", "users", userId, user?.id ?? null, null, { username: (target as unknown as { username?: string }).username }); } catch {}
    publish("authz.changed", { "user-id": userId });
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/grant_admin", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userId = params["user_id"] ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined || target.deletedAt !== null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (target.isSiteAdmin === true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is already a site admin" }] }; }
    await db.update(users).set({ isSiteAdmin: true }).where(eq(users.id, userId));
    await auditLog("grant-admin", "users", userId, user.id, null, { username: target.username });
    publish("authz.changed", { "user-id": userId });
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/revoke_admin", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userId = params["user_id"] ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined || target.deletedAt !== null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (target.isSiteAdmin !== true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is not a site admin" }] }; }
    if (target.scimSiteAdmin === true) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Site-admin access is managed by the configured SCIM group" }] }; }
    await db.update(users).set({ isSiteAdmin: false }).where(eq(users.id, userId));
    await auditLog("revoke-admin", "users", userId, user.id, null, { username: target.username });
    // A demoted admin's SSE snapshot grants every org (allowedOrgIds = null);
    // close the stream so they re-resolve memberships immediately instead of
    // keeping all-org event delivery for the one-hour lifetime cap.
    publish("authz.changed", { "user-id": userId });
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/grant_site_auditor", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userId = params["user_id"] ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined || target.deletedAt !== null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if ((target as Record<string, unknown>)["isSiteAuditor"] === true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is already a site auditor" }] }; }
    await db.update(users).set({ isSiteAuditor: true }).where(eq(users.id, userId));
    await auditLog("grant-auditor", "users", userId, user.id, null, { username: target.username });
    publish("authz.changed", { "user-id": userId });
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/revoke_site_auditor", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userId = params["user_id"] ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined || target.deletedAt !== null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if ((target as Record<string, unknown>)["isSiteAuditor"] !== true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is not a site auditor" }] }; }
    await db.update(users).set({ isSiteAuditor: false }).where(eq(users.id, userId));
    await auditLog("revoke-auditor", "users", userId, user.id, null, { username: target.username });
    publish("authz.changed", { "user-id": userId });
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/disable_two_factor", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const target = await db.query.users.findFirst({ where: eq(users.id, params["user_id"] ?? "") });
    if (target === undefined || target.deletedAt !== null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mfa = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, target.id) });
    if (mfa === undefined || mfa.enabled !== true) {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "User does not have two-factor authentication enabled" }] };
    }
    await db.delete(user2FA).where(eq(user2FA.userId, target.id));
    await auditLog("disable-2fa", "users", target.id, user.id, null, { username: target.username });
    const updated = await db.query.users.findFirst({ where: eq(users.id, target.id) });
    return updated === undefined ? { data: adminUserResource(target) } : { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/impersonate", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) {
      await auditLog("impersonate", "users", params["user_id"] ?? null, user?.id ?? null, null, { reason: "requires-site-admin" }, { result: "denied", immutable: true });
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const userId = params["user_id"] ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined || target.deletedAt !== null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (target.id === user.id || target.isSiteAdmin === true) {
      await auditLog("impersonate", "users", target.id, user.id, null, { reason: "protected-administrator" }, { result: "denied", immutable: true });
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "This user cannot be impersonated" }] };
    }
    if ((target as Record<string, unknown>)["isSuspended"] === true) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: "User not found" }] };
    }
    const rawToken = generateAuthenticationToken("imp");
    const expiresAt = Date.now() + 15 * 60 * 1000;
    const impersonationTokenId = `${IMPERSONATION_TOKEN_PREFIX}${crypto.randomUUID()}`;
    await db.insert(apiTokens).values({
      id: impersonationTokenId,
      token: hashAuthenticationToken(rawToken),
      userId: target.id,
      description: `Impersonation by ${user.username}`,
      expiresAt,
    });
    await auditLog("impersonate", "users", target.id, user.id, null, {
      targetUserId: target.id,
      impersonatorUserId: user.id,
      effectiveUserId: target.id,
      impersonationTokenId,
    });
    return { data: { type: "authentication-tokens", attributes: { token: rawToken, "expires-at": new Date(expiresAt).toISOString(), "user-id": target.id } } };
  })
  .post("/api/v2/admin/users/actions/unimpersonate", async ({ user, token, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) {
      const ended = await endImpersonationSession(token, set);
      if ("error" in ended) return ended.error;
      return {};
    }
    await auditLog("unimpersonate", "users", user?.id ?? null, user?.id ?? null, null, { reason: "not-an-impersonation-session" }, { result: "denied", immutable: true });
    (set as { status: number }).status = 400;
    return { errors: [{ status: "400", title: "Bad Request", detail: "The current session is not an impersonation session" }] };
  });
