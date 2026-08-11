import { Elysia } from "elysia";
import { db } from "../db";
import {
  users,
  apiTokens,
  agentPools,
  agentPoolTokens,
  organizationMemberships,
  organizations,
  teams,
  teamMemberships,
} from "../db/schema";
import { parseTokenScopes, type TokenScopes } from "../lib/token-scopes";
import { currentTokenScopes } from "../lib/request-scope";
import { eq, and, asc, desc, count, inArray, isNull, like, ne, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { userResource, orgMembershipResource, tokenResource } from "../lib/response";
import { tokenExpiry } from "../lib/validation";
import { checkOrganizationPermission, checkOrgPermission, pageRequest, pagination, auditLog, strictAuditEnabled } from "../lib/utils";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  request: Readonly<{ url: string }>;
  set: SetObj;
}>;

export const userRoutes = new Elysia({ name: "users" })
  .use(authPlugin)
  .get("/api/v2/users", async ({ query, user, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) { (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    const filterParam = query["filter[username]"] ?? query.q;
    const usernameFilter = typeof filterParam === "string" ? filterParam.trim() : "";
    let allUsers: Readonly<typeof users.$inferSelect>[];
    if (user.isSiteAdmin === true) {
      if (usernameFilter !== "") {
        allUsers = await db.query.users.findMany({
          where: like(users.username, `%${usernameFilter}%`),
        });
      } else {
        allUsers = await db.query.users.findMany();
      }
    } else {
      const userMemberships = await db.query.organizationMemberships.findMany({
        where: eq(organizationMemberships.userId, user.id),
      });
      const userOrgIds = userMemberships.map((m: Readonly<{ readonly orgId: string }>): string => m.orgId);
      if (userOrgIds.length === 0) {
        return { data: [userResource(user)] };
      }
      const sharedMemberships = await db.query.organizationMemberships.findMany({
        where: inArray(organizationMemberships.orgId, userOrgIds),
      });
      const sharedUserIds = [...new Set(sharedMemberships.map((m: Readonly<{ readonly userId: string }>): string => m.userId))];
      if (usernameFilter !== "") {
        allUsers = await db.query.users.findMany({
          where: and(inArray(users.id, sharedUserIds), like(users.username, `%${usernameFilter}%`)),
        });
      } else {
        allUsers = await db.query.users.findMany({
          where: inArray(users.id, sharedUserIds),
        });
      }
    }
    return { data: allUsers.map((u: Readonly<typeof users.$inferSelect>): Record<string, unknown> => userResource(u)) };
  })
  .get("/api/v2/users/:user_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const userId = params.user_id ?? "";
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined || user === null || user === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (user.isSiteAdmin !== true) {
      const userMemberships = await db.query.organizationMemberships.findMany({
        where: eq(organizationMemberships.userId, user.id),
      });
      const userOrgIds = userMemberships.map((m: Readonly<{ readonly orgId: string }>): string => m.orgId);
      const targetMemberships = await db.query.organizationMemberships.findMany({
        where: and(eq(organizationMemberships.userId, targetUser.id)),
      });
      const targetOrgIds = targetMemberships.map((m: Readonly<{ readonly orgId: string }>): string => m.orgId);
      const hasSharedOrg = userOrgIds.some((oid: string): boolean => targetOrgIds.includes(oid)) || user.id === targetUser.id;
      if (!hasSharedOrg) {
        (set as { status: number }).status = 404;
        return { errors: [{ status: "404", title: "Not Found" }] };
      }
    }
    return { data: userResource(targetUser) };
  })
  .patch("/api/v2/users/:user_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const userId = params.user_id ?? "";
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined || user?.id !== userId) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof users.$inferInsert> = {};
    if (typeof attrs.username === "string" && attrs.username.trim() !== "") updates.username = attrs.username.trim();
    if (typeof attrs.email === "string") updates.email = attrs.email.trim();
    if (Object.keys(updates).length > 0) {
      await db.update(users).set(updates).where(eq(users.id, userId));
    }
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: userResource(updated) };
  })
  .delete("/api/v2/users/:user_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const userId = params.user_id ?? "";
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined || user?.id !== userId) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(users).where(eq(users.id, userId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Org Memberships ---
  .post("/api/v2/organizations/:org_name/organization-memberships", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const email = typeof attrs.email === "string" ? attrs.email : undefined;
    const username = typeof attrs.username === "string" ? attrs.username : undefined;
    let targetUser: Readonly<typeof users.$inferSelect> | undefined;
    if (email !== undefined) targetUser = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (targetUser === undefined && username !== undefined) targetUser = await db.query.users.findFirst({ where: eq(users.username, username) });
    if (targetUser === undefined && email !== undefined) {
      const uid = `usr-${crypto.randomUUID()}`;
      const emailPrefix = email.split("@")[0] ?? "user";
      const uname = `${emailPrefix}_${crypto.randomUUID().substring(0, 4)}`;
      await db.insert(users).values({ id: uid, username: uname, email, passwordHash: "invited" });
      targetUser = await db.query.users.findFirst({ where: eq(users.id, uid) });
    }
    if (targetUser === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "User email or username required" }] };
    }
    const existingMem = await db.query.organizationMemberships.findFirst({
      where: and(eq(organizationMemberships.orgId, org.id), eq(organizationMemberships.userId, targetUser.id)),
    });
    if (existingMem !== undefined) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "User is already a member of this organization" }] };
    }
    const memId = `orgmem-${crypto.randomUUID()}`;
    const status = typeof attrs.status === "string" ? attrs.status : "active";
    await db.insert(organizationMemberships).values({
      id: memId, orgId: org.id, userId: targetUser.id, role: "member", status,
    });
    const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
    const teamsRel = typeof rels.teams === "object" && rels.teams !== null ? (rels.teams as Record<string, unknown>) : {};
    const teamRelData = teamsRel.data;
    const teamIds: string[] = [];
    if (Array.isArray(teamRelData)) {
      const candidateIds: string[] = [];
      for (const t of teamRelData) {
        if (t !== null && typeof t === "object" && typeof (t as Record<string, unknown>).id === "string") {
          candidateIds.push((t as Record<string, unknown>).id as string);
        }
      }
      if (candidateIds.length > 0) {
        const teamsInOrg = await db.query.teams.findMany({
          where: and(inArray(teams.id, candidateIds), eq(teams.orgId, org.id)),
          columns: { id: true },
        });
        const membershipBatch = teamsInOrg.map((team): typeof teamMemberships.$inferInsert => ({
          id: `tmem-${crypto.randomUUID()}`,
          teamId: team.id,
          userId: targetUser.id,
          createdAt: Date.now(),
        }));
        if (membershipBatch.length > 0) {
          await db.insert(teamMemberships).values(membershipBatch).onConflictDoNothing();
        }
        teamIds.push(...teamsInOrg.map((t): string => t.id));
      }
    }
    const mem = await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, memId) });
    if (mem === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    (set as { status: number }).status = 201;
    return { data: await orgMembershipResource(mem, targetUser, teamIds) };
  })
  .get("/api/v2/organizations/:org_name/organization-memberships", async ({ params, query, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId, tokenTeamId ?? null, "members:read"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const [mems, countRows] = await Promise.all([
      db.query.organizationMemberships.findMany({ where: eq(organizationMemberships.orgId, org.id), orderBy: [asc(organizationMemberships.id)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(organizationMemberships).where(eq(organizationMemberships.orgId, org.id)),
    ]);
    const userIds = mems.map((m: Readonly<{ readonly userId: string }>): string => m.userId);
    const userList = userIds.length > 0 ? await db.query.users.findMany({ where: inArray(users.id, userIds) }) : [];
    const userMap = new Map(userList.map((u: Readonly<typeof users.$inferSelect>): [string, typeof u] => [u.id, u]));
    const includeQuery = query.include;
    const includeUsers = typeof includeQuery === "string" && includeQuery.split(",").includes("user");
    const data = await Promise.all(mems.map(async (m: Readonly<typeof organizationMemberships.$inferSelect>): Promise<Record<string, unknown>> => orgMembershipResource(m, userMap.get(m.userId) ?? null)));
    const totalCount = countRows[0]?.total ?? 0;
    const result: { data: Record<string, unknown>[]; included?: Record<string, unknown>[] } = { data, ...pagination(request, number, size, totalCount) };
    if (includeUsers && userList.length > 0) {
      result.included = userList.map((u: Readonly<typeof users.$inferSelect>): Record<string, unknown> => userResource(u));
    }
    return result;
  })
  .get("/api/v2/organizations/:org_name/users", async ({ params, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId, tokenTeamId ?? null, "members:read"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const [rows, countRows] = await Promise.all([
      db.select({ user: users })
        .from(organizationMemberships)
        .innerJoin(users, eq(users.id, organizationMemberships.userId))
        .where(eq(organizationMemberships.orgId, org.id))
        .orderBy(asc(organizationMemberships.id))
        .limit(size)
        .offset((number - 1) * size),
      db.select({ total: count() })
        .from(organizationMemberships)
        .innerJoin(users, eq(users.id, organizationMemberships.userId))
        .where(eq(organizationMemberships.orgId, org.id)),
    ]);
    const data = rows.map((row: Readonly<{ user: typeof users.$inferSelect }>): Record<string, unknown> => userResource(row.user));
    const totalCount = countRows[0]?.total ?? 0;
    return { data, ...pagination(request, number, size, totalCount) };
  })
  .get("/api/v2/organization-memberships/:id", async ({ params, query, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const memId = params.id ?? "";
    const mem = await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, memId) });
    if (mem === undefined || !(await checkOrgPermission(user?.id, mem.orgId, "member", tokenOrgId, tokenTeamId ?? null, "members:read"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, mem.userId) });
    const includeQuery = query.include;
    const includeUsers = typeof includeQuery === "string" && includeQuery.split(",").includes("user");
    const result: { data: Record<string, unknown>; included?: Record<string, unknown>[] } = { data: await orgMembershipResource(mem, targetUser) };
    if (includeUsers && targetUser !== undefined) {
      result.included = [userResource(targetUser)];
    }
    return result;
  })
  .delete("/api/v2/organization-memberships/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const memId = params.id ?? "";
    const mem = await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, memId) });
    if (mem === undefined || !(await checkOrganizationPermission(mem.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, memId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Auth Tokens ---
  .get("/api/v2/users/:user_id/authentication-tokens", async ({ params, user, request, set }: ParamCtx): Promise<unknown> => {
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined || user?.id !== userId) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const where = and(
      eq(apiTokens.userId, userId),
      or(
        isNull(apiTokens.description),
        ne(apiTokens.description, "Browser session access token"),
      ),
    );
    const [tokens, countRows] = await Promise.all([
      db.query.apiTokens.findMany({ where, orderBy: [desc(apiTokens.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(apiTokens).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: tokens.map((token: Readonly<typeof apiTokens.$inferSelect>): Record<string, unknown> => tokenResource(token)), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/users/:user_id/authentication-tokens", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const userId = params.user_id ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined || user?.id !== userId) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    // A fine-grained token must not be able to mint a new token (which could
    // be unscoped = full access), or its restrictions are trivially bypassed.
    if (currentTokenScopes() !== null) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: "Fine-grained tokens cannot create additional tokens" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const description = typeof attributes.description === "string" ? attributes.description : "API token";
    const expiresAt = tokenExpiry(typeof attributes["expired-at"] === "string" ? attributes["expired-at"] : undefined);
    if (description === "" || Number.isNaN(expiresAt)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    // Fine-grained scopes (optional): when present, the token is restricted
    // to the listed orgs/projects/workspaces/tags and permission grants.
    let scopes: TokenScopes | null = null;
    if (attributes.scopes !== undefined) {
      try {
        scopes = parseTokenScopes(attributes.scopes);
      } catch (error: unknown) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: error instanceof Error ? error.message : "Invalid scopes" }] };
      }
    }
    const rawToken = `user-${crypto.randomUUID()}`;
    const createdToken = {
      id: crypto.randomUUID(),
      token: createHash("sha256").update(rawToken).digest("hex"),
      userId,
      orgId: null,
      description,
      scopes: scopes === null ? null : JSON.stringify(scopes),
      tokenType: "",
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt,
      teamId: null,
    };
    await db.insert(apiTokens).values(createdToken);
    if (strictAuditEnabled()) {
      await auditLog("create", "authentication-token", createdToken.id, user?.id ?? null, null, {
        description,
        source: "user",
      });
    }
    (set as { status: number }).status = 201;
    return { data: tokenResource({ ...createdToken, _rawToken: rawToken }, true) };
  })
  .get("/api/v2/authentication-tokens/:token_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const tokenId = params.token_id ?? "";
    const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, tokenId) });
    if (token !== undefined && user?.id === token.userId) {
      return { data: tokenResource(token) };
    }
    const agentToken = await db.query.agentPoolTokens.findFirst({ where: eq(agentPoolTokens.id, tokenId) });
    const pool = agentToken === undefined
      ? undefined
      : await db.query.agentPools.findFirst({ where: eq(agentPools.id, agentToken.agentPoolId) });
    if (
      agentToken === undefined
      || pool === undefined
      || !(await checkOrganizationPermission(pool.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-agent-pools"))
    ) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: agentToken.id,
        type: "authentication-tokens",
        attributes: {
          description: agentToken.description,
          "created-at": new Date(agentToken.createdAt).toISOString(),
          "last-used-at": agentToken.lastUsedAt === null ? null : new Date(agentToken.lastUsedAt).toISOString(),
        },
        relationships: {
          "agent-pool": { data: { id: pool.id, type: "agent-pools" } },
        },
      },
    };
  })
  .delete("/api/v2/authentication-tokens/:token_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const tokenId = params.token_id ?? "";
    const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, tokenId) });
    if (token !== undefined && user?.id === token.userId) {
      await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
      (set as { status: number }).status = 204;
      return {};
    }
    const agentToken = await db.query.agentPoolTokens.findFirst({ where: eq(agentPoolTokens.id, tokenId) });
    const pool = agentToken === undefined
      ? undefined
      : await db.query.agentPools.findFirst({ where: eq(agentPools.id, agentToken.agentPoolId) });
    if (
      agentToken === undefined
      || pool === undefined
      || !(await checkOrganizationPermission(pool.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-agent-pools"))
    ) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(agentPoolTokens).where(eq(agentPoolTokens.id, tokenId));
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/tokens", async ({ body, user, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    // Same privilege-escalation guard as the per-user endpoint: a fine-grained
    // token must not be able to mint an unscoped (full-access) token.
    if (currentTokenScopes() !== null) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: "Fine-grained tokens cannot create additional tokens" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
    const orgRel = typeof rels.organization === "object" && rels.organization !== null ? (rels.organization as Record<string, unknown>) : {};
    const orgData = typeof orgRel.data === "object" && orgRel.data !== null ? (orgRel.data as Record<string, unknown>) : {};
    const description = typeof attributes.description === "string" ? attributes.description : "API token";
    const orgId = typeof orgData.id === "string" ? orgData.id : undefined;
    const expiresAt = tokenExpiry(typeof attributes["expired-at"] === "string" ? attributes["expired-at"] : undefined);
    // Fine-grained scopes (optional): when present, the token is restricted
    // to the listed orgs/projects/workspaces/tags and permission grants.
    let scopes: TokenScopes | null = null;
    if (attributes.scopes !== undefined) {
      try {
        scopes = parseTokenScopes(attributes.scopes);
      } catch (error: unknown) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: error instanceof Error ? error.message : "Invalid scopes" }] };
      }
    }
    if (description === "" || Number.isNaN(expiresAt)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    if (orgId !== undefined) {
      if (!(await checkOrgPermission(user.id, orgId, "owner"))) {
        (set as { status: number }).status = 403;
        return { errors: [{ status: "403", title: "Forbidden" }] };
      }
    }
    const rawToken = `${orgId !== undefined ? "org" : "user"}-${crypto.randomUUID()}`;
    const createdToken = {
      id: crypto.randomUUID(),
      token: createHash("sha256").update(rawToken).digest("hex"),
      userId: orgId !== undefined ? null : user.id,
      orgId: orgId ?? null,
      description,
      scopes: scopes === null ? null : JSON.stringify(scopes),
      tokenType: "",
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt,
      teamId: null,
    };
    if (orgId !== undefined) {
      await db.transaction(async (tx: unknown): Promise<void> => {
        const t = tx as typeof db;
        await t.delete(apiTokens).where(and(eq(apiTokens.orgId, orgId), eq(apiTokens.tokenType, "")));
        await t.insert(apiTokens).values(createdToken);
      });
    } else {
      await db.insert(apiTokens).values(createdToken);
    }
    (set as { status: number }).status = 201;
    return { data: tokenResource({ ...createdToken, _rawToken: rawToken }, true) };
  })
  .get("/api/v2/organizations/:org_name/authentication-token", async ({ params, request, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || (orgId !== org.id && !(await checkOrgPermission(user?.id, org.id, "owner")))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    // HCP passes ?token=audit-trails to address the audit-trails token slot
    // distinctly from the organization token (which sends no query param).
    const tokenType = new URL(request.url).searchParams.get("token") ?? "";
    const token = await db.query.apiTokens.findFirst({
      where: and(eq(apiTokens.orgId, org.id), eq(apiTokens.tokenType, tokenType)),
    });
    if (token === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: tokenResource(token) };
  })
  .post("/api/v2/organizations/:org_name/authentication-token", async ({ params, request, body, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || (orgId !== org.id && !(await checkOrgPermission(user?.id, org.id, "owner")))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const tokenType = new URL(request.url).searchParams.get("token") ?? "";
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const expiresAt = tokenExpiry(typeof attributes["expired-at"] === "string" ? attributes["expired-at"] : undefined);
    if (Number.isNaN(expiresAt)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const rawToken = `org-${crypto.randomUUID()}`;
    const createdToken = {
      id: crypto.randomUUID(),
      token: createHash("sha256").update(rawToken).digest("hex"),
      userId: null,
      orgId: org.id,
      description: null,
      scopes: null,
      tokenType,
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt,
      teamId: null,
    };
    await db.transaction(async (tx: unknown): Promise<void> => {
      const t = tx as typeof db;
      await t.delete(apiTokens).where(and(eq(apiTokens.orgId, org.id), eq(apiTokens.tokenType, tokenType)));
      await t.insert(apiTokens).values(createdToken);
    });
    (set as { status: number }).status = 201;
    return { data: tokenResource({ ...createdToken, _rawToken: rawToken }, true) };
  })
  .delete("/api/v2/organizations/:org_name/authentication-token", async ({ params, request, user, orgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || (orgId !== org.id && !(await checkOrgPermission(user?.id, org.id, "owner")))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const tokenType = new URL(request.url).searchParams.get("token") ?? "";
    await db.delete(apiTokens).where(and(eq(apiTokens.orgId, org.id), eq(apiTokens.tokenType, tokenType)));
    (set as { status: number }).status = 204;
    return {};
  });
