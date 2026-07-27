import { Elysia } from "elysia";
import { db } from "../db";
import { users, apiTokens, organizationMemberships, organizations, teamMemberships } from "../db/schema";
import { eq, and, desc, count, inArray, like } from "drizzle-orm";
import { createHash } from "node:crypto";
import { userResource, orgMembershipResource, tokenResource } from "../lib/response";
import { tokenExpiry } from "../lib/validation";
import { checkOrgPermission, pageRequest, pagination } from "../lib/utils";
import { authPlugin } from "../auth";

export const userRoutes = new Elysia({ name: "users" })
  .use(authPlugin)
  .get("/api/v2/users", async ({ query, user, set }) => {
    if (!user) { set.status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    const usernameFilter = (query as any)?.["filter[username]"] || (query as any)?.q;
    let allUsers;
    if (user.isSiteAdmin) {
      if (usernameFilter) {
        allUsers = await db.query.users.findMany({
          where: (u, { like }) => like(u.username, `%${usernameFilter}%`),
        });
      } else {
        allUsers = await db.query.users.findMany();
      }
    } else {
      const userMemberships = await db.query.organizationMemberships.findMany({
        where: eq(organizationMemberships.userId, user.id),
      });
      const userOrgIds = userMemberships.map(m => m.orgId);
      if (userOrgIds.length === 0) {
        return { data: [userResource(user)] };
      }
      const sharedMemberships = await db.query.organizationMemberships.findMany({
        where: inArray(organizationMemberships.orgId, userOrgIds),
      });
      const sharedUserIds = [...new Set(sharedMemberships.map(m => m.userId))];
      if (usernameFilter) {
        allUsers = await db.query.users.findMany({
          where: (u, { and, like, inArray: inArr }) => and(
            inArr(u.id, sharedUserIds),
            like(u.username, `%${usernameFilter}%`),
          ),
        });
      } else {
        allUsers = await db.query.users.findMany({
          where: (u, { inArray: inArr }) => inArr(u.id, sharedUserIds),
        });
      }
    }
    return { data: allUsers.map(u => userResource(u)) };
  })
  .get("/api/v2/users/:user_id", async ({ params: { user_id }, user, set }) => {
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, user_id) });
    if (!targetUser || !user) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!user.isSiteAdmin) {
      const userMemberships = await db.query.organizationMemberships.findMany({
        where: eq(organizationMemberships.userId, user.id),
      });
      const userOrgIds = userMemberships.map(m => m.orgId);
      const targetMemberships = await db.query.organizationMemberships.findMany({
        where: and(eq(organizationMemberships.userId, targetUser.id)),
      });
      const targetOrgIds = targetMemberships.map(m => m.orgId);
      const hasSharedOrg = userOrgIds.some(oid => targetOrgIds.includes(oid)) || user.id === targetUser.id;
      if (!hasSharedOrg) {
        set.status = 404;
        return { errors: [{ status: "404", title: "Not Found" }] };
      }
    }
    return { data: userResource(targetUser) };
  })
  .patch("/api/v2/users/:user_id", async ({ params: { user_id }, body, user, set }) => {
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, user_id) });
    if (!targetUser || !user || (user.id !== user_id)) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attrs = (body as any)?.data?.attributes || {};
    const updates: Partial<typeof users.$inferInsert> = {};
    if (typeof attrs.username === "string" && attrs.username.trim()) updates.username = attrs.username.trim();
    if (typeof attrs.email === "string") updates.email = attrs.email.trim();
    if (Object.keys(updates).length > 0) {
      await db.update(users).set(updates).where(eq(users.id, user_id));
    }
    const updated = (await db.query.users.findFirst({ where: eq(users.id, user_id) }))!;
    return { data: userResource(updated) };
  })
  .delete("/api/v2/users/:user_id", async ({ params: { user_id }, user, set }) => {
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, user_id) });
    if (!targetUser || !user || user.id !== user_id) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(users).where(eq(users.id, user_id));
    set.status = 204;
    return;
  })
  // --- Org Memberships ---
  .post("/api/v2/organizations/:org_name/organization-memberships", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "owner", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attrs = (body as any)?.data?.attributes || {};
    const email = attrs.email;
    const username = attrs.username;
    let targetUser = null;
    if (email) targetUser = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (!targetUser && username) targetUser = await db.query.users.findFirst({ where: eq(users.username, username) });
    if (!targetUser && email) {
      const uid = `usr-${crypto.randomUUID()}`;
      const uname = email.split("@")[0] + "_" + crypto.randomUUID().substring(0, 4);
      await db.insert(users).values({ id: uid, username: uname, email, passwordHash: "invited" });
      targetUser = (await db.query.users.findFirst({ where: eq(users.id, uid) }))!;
    }
    if (!targetUser) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "User email or username required" }] };
    }
    const existingMem = await db.query.organizationMemberships.findFirst({
      where: and(eq(organizationMemberships.orgId, org.id), eq(organizationMemberships.userId, targetUser.id)),
    });
    if (existingMem) {
      set.status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "User is already a member of this organization" }] };
    }
    const memId = `orgmem-${crypto.randomUUID()}`;
    const status = attrs.status || "active";
    await db.insert(organizationMemberships).values({
      id: memId, orgId: org.id, userId: targetUser.id, role: "member", status,
    });
    const teamRelData = (body as any)?.data?.relationships?.teams?.data;
    const teamIds: string[] = [];
    if (Array.isArray(teamRelData)) {
      for (const t of teamRelData) {
        if (t?.id) {
          teamIds.push(t.id);
          await db.insert(teamMemberships).values({
            id: `tmem-${crypto.randomUUID()}`, teamId: t.id, userId: targetUser.id, createdAt: Date.now(),
          }).catch(() => {});
        }
      }
    }
    const mem = (await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, memId) }))!;
    set.status = 201;
    return { data: orgMembershipResource(mem, targetUser, teamIds) };
  })
  .get("/api/v2/organizations/:org_name/organization-memberships", async ({ params: { org_name }, query, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const mems = await db.query.organizationMemberships.findMany({ where: eq(organizationMemberships.orgId, org.id) });
    const userIds = mems.map(m => m.userId);
    const userList = userIds.length > 0 ? await db.query.users.findMany({ where: inArray(users.id, userIds) }) : [];
    const userMap = new Map(userList.map(u => [u.id, u]));
    const includeUsers = (query as any)?.include?.split(",").includes("user");
    const data = mems.map(m => orgMembershipResource(m, userMap.get(m.userId) || null));
    const result: any = { data };
    if (includeUsers && userList.length > 0) {
      result.included = userList.map(u => userResource(u));
    }
    return result;
  })
  .get("/api/v2/organization-memberships/:id", async ({ params: { id }, query, user, orgId: tokenOrgId, set }) => {
    const mem = await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, id) });
    if (!mem || !(await checkOrgPermission(user?.id, mem.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, mem.userId) });
    const includeUsers = (query as any)?.include?.split(",").includes("user");
    const result: any = { data: orgMembershipResource(mem, targetUser) };
    if (includeUsers && targetUser) {
      result.included = [userResource(targetUser)];
    }
    return result;
  })
  .delete("/api/v2/organization-memberships/:id", async ({ params: { id }, user, orgId: tokenOrgId, set }) => {
    const mem = await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, id) });
    if (!mem || !(await checkOrgPermission(user?.id, mem.orgId, "owner", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, id));
    set.status = 204;
    return;
  })
  // --- Auth Tokens ---
  .get("/api/v2/users/:user_id/authentication-tokens", async ({ params: { user_id }, user, request, set }) => {
    const target = await db.query.users.findFirst({ where: eq(users.id, user_id) });
    if (!target || !user || user.id !== user_id) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const where = eq(apiTokens.userId, user_id);
    const [tokens, [{ total }]] = await Promise.all([
      db.query.apiTokens.findMany({ where, orderBy: [desc(apiTokens.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(apiTokens).where(where),
    ]);
    return { data: tokens.map(token => tokenResource(token)), ...pagination(request, number, size, total) };
  })
  .get("/api/v2/authentication-tokens/:token_id", async ({ params: { token_id }, user, set }) => {
    const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, token_id) });
    if (!token || !user || token.userId !== user.id) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: tokenResource(token) };
  })
  .delete("/api/v2/authentication-tokens/:token_id", async ({ params: { token_id }, user, set }) => {
    const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, token_id) });
    if (!token || !user || token.userId !== user.id) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(apiTokens).where(eq(apiTokens.id, token_id));
    set.status = 204;
  })
  .post("/api/v2/tokens", async ({ body, user, set }) => {
    if (!user) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const payload = body as any;
    const attributes = payload?.data?.attributes || {};
    const description = attributes.description ?? "API token";
    const orgId = payload?.data?.relationships?.organization?.data?.id;
    const expiresAt = tokenExpiry(attributes["expired-at"]);
    if (typeof description !== "string" || (orgId !== undefined && typeof orgId !== "string") || Number.isNaN(expiresAt)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    if (orgId) {
      if (!(await checkOrgPermission(user.id, orgId, "owner"))) {
        set.status = 403;
        return { errors: [{ status: "403", title: "Forbidden" }] };
      }
    }
    const rawToken = `${orgId ? "org" : "user"}-${crypto.randomUUID()}`;
    const createdToken: any = {
      id: crypto.randomUUID(),
      token: createHash("sha256").update(rawToken).digest("hex"),
      userId: orgId ? null : user.id,
      orgId: orgId || null,
      description,
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt,
    };
    if (orgId) {
      await db.transaction(async tx => {
        await tx.delete(apiTokens).where(eq(apiTokens.orgId, orgId));
        await tx.insert(apiTokens).values(createdToken);
      });
    } else {
      await db.insert(apiTokens).values(createdToken);
    }
    set.status = 201;
    return { data: tokenResource({ ...createdToken, _rawToken: rawToken }, true) };
  })
  .get("/api/v2/organizations/:org_name/authentication-token", async ({ params: { org_name }, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || (orgId !== org.id && !(await checkOrgPermission(user?.id, org.id, "owner")))) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.orgId, org.id) });
    if (!token) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: tokenResource(token) };
  })
  .post("/api/v2/organizations/:org_name/authentication-token", async ({ params: { org_name }, body, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || (orgId !== org.id && !(await checkOrgPermission(user?.id, org.id, "owner")))) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes || {};
    const expiresAt = tokenExpiry(attributes["expired-at"]);
    if (Number.isNaN(expiresAt)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const rawToken = `org-${crypto.randomUUID()}`;
    const createdToken: any = {
      id: crypto.randomUUID(),
      token: createHash("sha256").update(rawToken).digest("hex"),
      userId: null,
      orgId: org.id,
      description: null,
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt,
      _rawToken: rawToken,
    };
    await db.transaction(async tx => {
      await tx.delete(apiTokens).where(eq(apiTokens.orgId, org.id));
      await tx.insert(apiTokens).values(createdToken);
    });
    set.status = 201;
    return { data: tokenResource(createdToken, true) };
  })
  .delete("/api/v2/organizations/:org_name/authentication-token", async ({ params: { org_name }, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || (orgId !== org.id && !(await checkOrgPermission(user?.id, org.id, "owner")))) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(apiTokens).where(eq(apiTokens.orgId, org.id));
    set.status = 204;
  });
