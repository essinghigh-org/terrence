import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import { db } from "../../db";
import { users, apiTokens, user2FA } from "../../db/schema";
import type { SQL } from "drizzle-orm";
import { eq, and, or, count, like } from "drizzle-orm";
import { pageRequest, pagination } from "../../lib/utils";
import { isUniqueConstraintError } from "../../lib/validation";
import { checkPasswordPolicy, loadPasswordPolicy } from "../../lib/password-policy";
import { hashAuthenticationToken } from "../../lib/token-service";
import type { ParamCtx } from "./types";
import { type UserItem, adminUserResource } from "./helpers";
import { publish } from "../../lib/event-bus";
export const usersRoutes = new Elysia({ name: "admin-users" })
  .use(authPlugin)
  .get("/api/v2/admin/users", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const url = new URL(request.url);
    const filterAdmin = url.searchParams.get("filter[admin]");
    const filterSuspended = url.searchParams.get("filter[suspended]");
    const q = url.searchParams.get("q") ?? "";
    const { number, size } = pageRequest(request);
    const conditions: SQL[] = [];
    if (filterAdmin === "true") conditions.push(eq(users.isSiteAdmin, true));
    if (filterAdmin === "false") conditions.push(eq(users.isSiteAdmin, false));
    if (filterSuspended === "true") conditions.push(eq(users.isSuspended, true));
    if (filterSuspended === "false") conditions.push(eq(users.isSuspended, false));
    if (q !== "") {
      const pattern = `%${q}%`;
      conditions.push(or(like(users.username, pattern), like(users.email ?? users.username, pattern)) as SQL); // eslint-disable-line @typescript-eslint/non-nullable-type-assertion-style
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
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const username = typeof attrs.username === "string" ? attrs.username.trim() : "";
    const email = typeof attrs.email === "string" ? attrs.email.trim() : null;
    const password = typeof attrs.password === "string" ? attrs.password : "";
    const isSiteAdmin = attrs["is-site-admin"] === true;
    if (username === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Username is required" }] };
    }
    const adminPolicy = checkPasswordPolicy(loadPasswordPolicy(), password, username);
    if (!adminPolicy.ok) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: adminPolicy.errors.join(" ") }] };
    }
    const existing = await db.query.users.findFirst({ where: eq(users.username, username) });
    if (existing !== undefined) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] };
    }
    const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
    const id = `user-${crypto.randomUUID()}`;
    try {
      await db.insert(users).values({ id, username, email, passwordHash, isSiteAdmin });
    } catch (e: unknown) {
      if (isUniqueConstraintError(e)) {
        (set as { status: number }).status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] };
      }
      throw e;
    }
    const created = await db.query.users.findFirst({ where: eq(users.id, id) });
    if (created === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    (set as { status: number }).status = 201;
    return { data: adminUserResource(created) };
  })
  .get("/api/v2/admin/users/:user_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const userId = params.user_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: adminUserResource(targetUser) };
  })
  .patch("/api/v2/admin/users/:user_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const userId = params.user_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof users.$inferInsert> = {};
    if (typeof attributes.username === "string") updates.username = attributes.username;
    if (typeof attributes.email === "string") updates.email = attributes.email;
    if (Object.keys(updates).length > 0) await db.update(users).set(updates).where(eq(users.id, userId));
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: adminUserResource(updated) };
  })
  .delete("/api/v2/admin/users/:user_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const userId = params.user_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if ((targetUser as unknown as { deletedAt?: unknown }).deletedAt != null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { createHash } = await import("node:crypto");
    const now = Date.now();
    const emailHash = (targetUser as unknown as { email?: string | null }).email ? createHash("sha256").update(String((targetUser as unknown as { email?: string | null }).email).toLowerCase()).digest("hex") : null;
    await db.update(users).set({ deletedAt: now, deletedEmailHash: emailHash, email: null, isSuspended: true } as unknown as Record<string, unknown>).where(eq(users.id, userId));
    const { auditLog } = await import("../../lib/utils");
    await auditLog("delete", "users", userId, user?.id ?? null, null, { username: (targetUser as unknown as { username?: string }).username });
    publish("authz.changed", { "user-id": userId });
    (set as { status: number }).status = 204;
    return {};
  })
  // --- User Actions ---
  .post("/api/v2/admin/users/:user_id/actions/suspend", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if ((target as Record<string, unknown>).isSuspended === true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is already suspended" }] }; }
    await db.update(users).set({ isSuspended: true }).where(eq(users.id, userId));
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
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if ((target as Record<string, unknown>).isSuspended !== true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is not suspended" }] }; }
    await db.update(users).set({ isSuspended: false }).where(eq(users.id, userId));
    try { const { auditLog: al } = await import("../../lib/utils"); await al("unsuspend", "users", userId, user?.id ?? null, null, { username: (target as unknown as { username?: string }).username }); } catch {}
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/grant_admin", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (target.isSiteAdmin === true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is already a site admin" }] }; }
    await db.update(users).set({ isSiteAdmin: true }).where(eq(users.id, userId));
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/revoke_admin", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (target.isSiteAdmin !== true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is not a site admin" }] }; }
    await db.update(users).set({ isSiteAdmin: false }).where(eq(users.id, userId));
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
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if ((target as Record<string, unknown>).isSiteAuditor === true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is already a site auditor" }] }; }
    await db.update(users).set({ isSiteAuditor: true }).where(eq(users.id, userId));
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/revoke_site_auditor", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if ((target as Record<string, unknown>).isSiteAuditor !== true) { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "User is not a site auditor" }] }; }
    await db.update(users).set({ isSiteAuditor: false }).where(eq(users.id, userId));
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    return { data: adminUserResource(updated) };
  })
  .post("/api/v2/admin/users/:user_id/actions/disable_two_factor", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const target = await db.query.users.findFirst({ where: eq(users.id, params.user_id ?? "") });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const mfa = await db.query.user2FA.findFirst({ where: eq(user2FA.userId, target.id) });
    if (mfa === undefined || mfa.enabled !== true) {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "User does not have two-factor authentication enabled" }] };
    }
    await db.delete(user2FA).where(eq(user2FA.userId, target.id));
    return { data: adminUserResource(target) };
  })
  .post("/api/v2/admin/users/:user_id/actions/impersonate", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (target.id === user.id || target.isSiteAdmin === true) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "This user cannot be impersonated" }] };
    }
    if ((target as Record<string, unknown>).isSuspended === true) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found", detail: "User not found" }] };
    }
    const rawToken = `imp-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    await db.insert(apiTokens).values({
      id: `impersonation-${crypto.randomUUID()}`,
      token: hashAuthenticationToken(rawToken),
      userId: target.id,
      description: `Impersonation by ${user.username}`,
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    return { data: { type: "authentication-tokens", attributes: { token: rawToken, "expires-at": new Date(Date.now() + 15 * 60 * 1000).toISOString(), "user-id": target.id } } };
  })
  .post("/api/v2/admin/users/actions/unimpersonate", async ({ user, token, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) {
      const impersonationToken = token?.id === undefined ? undefined : await db.query.apiTokens.findFirst({
        where: and(eq(apiTokens.id, token.id), like(apiTokens.id, "impersonation-%")),
      });
      if (impersonationToken === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
      await db.delete(apiTokens).where(eq(apiTokens.id, impersonationToken.id));
      (set as { status: number }).status = 204;
      return {};
    }
    (set as { status: number }).status = 400;
    return { errors: [{ status: "400", title: "Bad Request", detail: "The current session is not an impersonation session" }] };
  });
