import { Elysia } from "elysia";
import { db } from "../db";
import {
  users,
  apiTokens,
  refreshSessions,
  user2FA,
  emailVerificationTokens,
  identityLinks,
  scimUserIdentities,
  agentPools,
  agentPoolTokens,
  organizationMemberships,
  teams,
  teamMemberships,
} from "../db/schema";
import { parseTokenScopes, type TokenScopes } from "../lib/token-scopes";
import { currentTokenScopes } from "../lib/request-scope";
import { eq, and, asc, desc, count, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { userResource, orgMembershipResource, tokenResource } from "../lib/response";
import { isUniqueConstraintError, tokenExpiry } from "../lib/validation";
import { generateAuthenticationToken, hashAuthenticationToken } from "../lib/token-service";
import { TOKEN_DESCRIPTION_MAX_LENGTH } from "../lib/constants";
import { resolveTokenExpiryUnderPolicy } from "../lib/token-ttl-policy";
import { caseInsensitiveLike, checkOrganizationPermission, checkOrgPermission, pageRequest, pagination, auditLog, sensitiveIdentifierHash, withOrganizationMembershipLocks } from "../lib/utils";
import { normalizeEmail, normalizeUsername } from "../lib/identity";
import { randomBytes } from "node:crypto";
import { publish } from "../lib/event-bus";
import { authPlugin } from "../auth";
import { cachedOrgByName } from "../lib/cached-lookups";
import { withDbLock } from "../lib/db-lock";

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

function organizationTokenWhere(orgId: string, tokenType: string) {
  return and(
    eq(apiTokens.orgId, orgId),
    eq(apiTokens.tokenType, tokenType),
    isNull(apiTokens.userId),
    isNull(apiTokens.teamId),
  );
}

// TFE org-token slots addressable via the singular endpoints' ?token= query
// (todo 52/53): arbitrary query strings must not mint new token namespaces.
// "organization" is accepted as a TFE-style alias of the "" slot.
const ORG_TOKEN_TYPES = ["", "organization", "audit-trails"] as const;

function validateOrgTokenType(value: string): (typeof ORG_TOKEN_TYPES)[number] | null {
  return (ORG_TOKEN_TYPES as readonly string[]).includes(value) ? value as (typeof ORG_TOKEN_TYPES)[number] : null;
}

const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export const userRoutes = new Elysia({ name: "users" })
  .use(authPlugin)
  .get("/api/v2/users", async ({ query, user, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) { (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    const filterParam = query["filter[username]"] ?? query["q"];
    const usernameFilter = typeof filterParam === "string" ? filterParam.trim() : "";
    let allUsers: Readonly<typeof users.$inferSelect>[];
    if (user.isSiteAdmin === true) {
      if (usernameFilter !== "") {
        allUsers = await db.query.users.findMany({
          where: caseInsensitiveLike(users.username, `%${usernameFilter}%`),
        });
      } else {
        allUsers = await db.query.users.findMany();
      }
    } else {
      const userMemberships = await db.query.organizationMemberships.findMany({
        where: and(eq(organizationMemberships.userId, user.id), eq(organizationMemberships.status, "active")),
      });
      const userOrgIds = userMemberships.map((m: Readonly<{ readonly orgId: string }>): string => m.orgId);
      if (userOrgIds.length === 0) {
        return { data: [userResource(user)] };
      }
      const sharedMemberships = await db.query.organizationMemberships.findMany({
        where: and(inArray(organizationMemberships.orgId, userOrgIds), eq(organizationMemberships.status, "active")),
      });
      const sharedUserIds = [...new Set(sharedMemberships.map((m: Readonly<{ readonly userId: string }>): string => m.userId))];
      if (usernameFilter !== "") {
        allUsers = await db.query.users.findMany({
          where: and(inArray(users.id, sharedUserIds), caseInsensitiveLike(users.username, `%${usernameFilter}%`)),
        });
      } else {
        allUsers = await db.query.users.findMany({
          where: inArray(users.id, sharedUserIds),
        });
      }
    }
    const visible = allUsers.filter((u): boolean => (u as unknown as { deletedAt?: unknown }).deletedAt == null);
    return { data: visible.map((u: Readonly<typeof users.$inferSelect>): Record<string, unknown> => userResource(u)) };
  })
  .get("/api/v2/users/:user_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const userId = params["user_id"] ?? "";
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined || targetUser.deletedAt !== null || user === null || user === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (user.isSiteAdmin !== true) {
      const userMemberships = await db.query.organizationMemberships.findMany({
        where: and(eq(organizationMemberships.userId, user.id), eq(organizationMemberships.status, "active")),
      });
      const userOrgIds = userMemberships.map((m: Readonly<{ readonly orgId: string }>): string => m.orgId);
      const targetMemberships = await db.query.organizationMemberships.findMany({
        where: and(eq(organizationMemberships.userId, targetUser.id), eq(organizationMemberships.status, "active")),
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
    const userId = params["user_id"] ?? "";
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined || user?.id !== userId) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    if (data !== undefined && typeof data["type"] === "string" && data["type"] !== "users") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data.type must be \"users\"" }] };
    }
    const attrs = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    if ((targetUser as unknown as { deletedAt?: unknown }).deletedAt != null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (targetUser.isSuspended === true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden", detail: "Suspended accounts cannot be modified" }] }; }
    const updates: Partial<typeof users.$inferInsert> = {};
    if (typeof attrs["username"] === "string" && attrs["username"].trim() !== "") {
      const nu = normalizeUsername(attrs["username"]);
      if (nu === null) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid username" }] }; }
      updates.username = nu;
    }
    if (typeof attrs["email"] === "string") {
      const ne = attrs["email"].trim() === "" ? null : normalizeEmail(attrs["email"]);
      if (attrs["email"].trim() !== "" && ne === null) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid email" }] }; }
      // Reject emails already claimed by ANOTHER account up front; the users
      // table enforces this with a UNIQUE constraint whose raw violation would
      // otherwise surface as an opaque 500.
      if (ne !== null) {
        const claimant = await db.query.users.findFirst({ where: eq(users.email, ne), columns: { id: true } });
        if (claimant !== undefined && claimant.id !== userId) {
          (set as { status: number }).status = 409;
          return { errors: [{ status: "409", title: "Conflict", detail: "That email address is already in use" }] };
        }
      }
      updates.email = ne ?? attrs["email"].trim();
      if (ne === null && attrs["email"].trim() === "") updates.email = null;
      if (updates.email !== targetUser.email) updates.emailVerifiedAt = null;
    }
    if (typeof attrs["username"] === "string" && attrs["username"].trim() !== "") {
      const nu2 = normalizeUsername(attrs["username"]);
      if (nu2 !== null && nu2 !== targetUser.username) {
        const nameClaimant = await db.query.users.findFirst({ where: eq(users.username, nu2), columns: { id: true } });
        if (nameClaimant !== undefined && nameClaimant.id !== userId) {
          (set as { status: number }).status = 409;
          return { errors: [{ status: "409", title: "Conflict", detail: "That username is already in use" }] };
        }
      }
    }
    if (Object.keys(updates).length > 0) {
      try {
        await db.update(users).set(updates).where(eq(users.id, userId));
      } catch (e: unknown) {
        if (isUniqueConstraintError(e)) {
          (set as { status: number }).status = 409;
          return { errors: [{ status: "409", title: "Conflict", detail: "That identity is already in use" }] };
        }
        throw e;
      }
    }
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: userResource(updated) };
  })
  .delete("/api/v2/users/:user_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const userId = params["user_id"] ?? "";
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined || user?.id !== userId) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if ((targetUser as unknown as { deletedAt?: unknown }).deletedAt != null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ownedMemberships = await db.query.organizationMemberships.findMany({
      where: and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.role, "owner"), eq(organizationMemberships.status, "active")),
      columns: { orgId: true },
    });
    const ownedOrgIds = ownedMemberships.map((membership): string => membership.orgId);
    const now = Date.now();
    const emailHash = targetUser.email !== null && targetUser.email !== undefined ? sensitiveIdentifierHash(targetUser.email.toLowerCase()) : null;
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
          passwordHash: `$disabled$${randomBytes(32).toString("base64url")}`,
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
    // Revoke live sessions / SSE
    publish("authz.changed", { "user-id": userId });
    await auditLog("delete", "users", userId, user.id, null, { username: targetUser.username });
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Org Memberships ---
  .get("/api/v2/organization-memberships", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const memberships = await db.query.organizationMemberships.findMany({ where: eq(organizationMemberships.userId, user.id), orderBy: [asc(organizationMemberships.id)] });
    const teamRows = await db.query.teamMemberships.findMany({ where: eq(teamMemberships.userId, user.id) });
    const teamIdsByOrg = new Map<string, string[]>();
    if (teamRows.length > 0) {
      const teamsById = new Map((await db.query.teams.findMany({ where: inArray(teams.id, teamRows.map((row): string => row.teamId)), columns: { id: true, orgId: true } })).map((team): [string, string] => [team.id, team.orgId]));
      for (const row of teamRows) {
        const orgId = teamsById.get(row.teamId);
        if (orgId === undefined) continue;
        const ids = teamIdsByOrg.get(orgId) ?? [];
        ids.push(row.teamId);
        teamIdsByOrg.set(orgId, ids);
      }
    }
    return { data: await Promise.all(memberships.map(async (membership): Promise<Record<string, unknown>> => orgMembershipResource(membership, user, teamIdsByOrg.get(membership.orgId) ?? []))) };
  })
  .post("/api/v2/organizations/:org_name/organization-memberships", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    if (data !== undefined && typeof data["type"] === "string" && data["type"] !== "organization-memberships") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data.type must be \"organization-memberships\"" }] };
    }
    const attrs = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const rawEmail = typeof attrs["email"] === "string" ? attrs["email"] : undefined;
    const email = rawEmail === undefined ? undefined : normalizeEmail(rawEmail);
    if (rawEmail !== undefined && email === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid email address" }] };
    }
    const username = typeof attrs["username"] === "string" ? attrs["username"] : undefined;
    let targetUser: Readonly<typeof users.$inferSelect> | undefined;
    if (email !== undefined && email !== null) targetUser = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${email}` });
    if (targetUser === undefined && username !== undefined) targetUser = await db.query.users.findFirst({ where: eq(users.username, username) });
    const memId = `orgmem-${crypto.randomUUID()}`;
    const allowedStatuses = new Set(["active", "invited"]);
    const rawRequestedStatus = typeof attrs["status"] === "string" ? attrs["status"] : undefined;
    if (rawRequestedStatus !== undefined && !allowedStatuses.has(rawRequestedStatus)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "status must be one of: active, invited" }] };
    }
    // Pre-validate relationships.teams before inserting the membership so a 422
    // does not leave an orphan organizationMembership row behind.
    const rels = typeof data?.["relationships"] === "object" && data["relationships"] !== null ? (data["relationships"] as Record<string, unknown>) : {};
    if (Object.hasOwn(rels, "teams") && (rels["teams"] === null || typeof rels["teams"] !== "object" || Array.isArray(rels["teams"]))) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "relationships.teams must be an object" }] };
    }
    const teamsRel = typeof rels["teams"] === "object" && rels["teams"] !== null ? (rels["teams"] as Record<string, unknown>) : {};
    const teamRelData = teamsRel["data"];
    const candidateIds: string[] = [];
    let validatedTeams: { id: string; orgId: string }[] | null = null;
    if (teamRelData !== undefined && !Array.isArray(teamRelData)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "relationships.teams.data must be an array" }] };
    }
    if (Array.isArray(teamRelData)) {
      for (const t of teamRelData) {
        if (t === null || typeof t !== "object" || Array.isArray(t) || typeof (t as Record<string, unknown>)["id"] !== "string" || (t as Record<string, unknown>)["id"] === "") {
          (set as { status: number }).status = 422;
          return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "relationships.teams.data[] must contain team resource identifiers" }] };
        }
        if (t !== null && typeof t === "object" && typeof (t as Record<string, unknown>)["type"] === "string" && (t as Record<string, unknown>)["type"] !== "teams") {
          (set as { status: number }).status = 422;
          return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "relationships.teams.data[].type must be \"teams\"" }] };
        }
        if (t !== null && typeof t === "object" && typeof (t as Record<string, unknown>)["id"] === "string") {
          candidateIds.push((t as Record<string, unknown>)["id"] as string);
        }
      }
      if (candidateIds.length > 0) {
        const uniqueIds = [...new Set(candidateIds)];
        if (uniqueIds.length !== candidateIds.length) {
          (set as { status: number }).status = 422;
          return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Duplicate team IDs in relationships.teams" }] };
        }
        const allTeams = await db.query.teams.findMany({ where: inArray(teams.id, uniqueIds), columns: { id: true, orgId: true } });
        const byIdMap = new Map(allTeams.map((tm: { id: string; orgId: string }): [string, string] => [tm.id, tm.orgId]));
        for (const cid of uniqueIds) {
          const owner = byIdMap.get(cid);
          if (owner === undefined) {
            (set as { status: number }).status = 422;
            return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `Team \"${cid}\" does not exist` }] };
          }
          if (owner !== org.id) {
            (set as { status: number }).status = 422;
            return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `Team \"${cid}\" does not belong to organization \"${org.name}\"` }] };
          }
        }
        validatedTeams = allTeams;
      }
    }

    if (targetUser === undefined && (email === undefined || email === null)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "An email address is required to add an organization member" }] };
    }
    if (targetUser !== undefined && (targetUser.email === null || targetUser.email === "")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "An email address is required for the organization member" }] };
    }
    if (targetUser !== undefined && email !== undefined && email !== null && normalizeEmail(targetUser.email) !== email) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "The email address does not match the selected user" }] };
    }
    // Provisioning, membership creation, and team assignment are one unit:
    // an unexpected constraint/FK failure must not leave a provisional user
    // or a half-created organization membership behind.
    const duplicateMembership = new Error("organization membership already exists");
    let result: { targetUser: Readonly<typeof users.$inferSelect>; mem: Readonly<typeof organizationMemberships.$inferSelect>; teamIds: string[] };
    try {
      result = await db.transaction(async (tx: unknown): Promise<{ targetUser: Readonly<typeof users.$inferSelect>; mem: Readonly<typeof organizationMemberships.$inferSelect>; teamIds: string[] }> => {
        const t = tx as typeof db;
        let txTargetUser = targetUser === undefined
          ? undefined
          : await t.query.users.findFirst({ where: eq(users.id, targetUser.id) });
        if (txTargetUser === undefined && email !== undefined && email !== null) {
          const uid = `usr-${crypto.randomUUID()}`;
          const emailPrefix = email.split("@")[0] ?? "user";
          const uname = `${emailPrefix}_${crypto.randomUUID().substring(0, 4)}`;
          await t.insert(users).values({ id: uid, username: uname, email, passwordHash: `$disabled$${randomBytes(32).toString("base64url")}`, isProvisional: true });
          txTargetUser = await t.query.users.findFirst({ where: eq(users.id, uid) });
        }
        if (txTargetUser === undefined) throw new Error("membership target user disappeared");
        const existingMem = await t.query.organizationMemberships.findFirst({
          where: and(eq(organizationMemberships.orgId, org.id), eq(organizationMemberships.userId, txTargetUser.id)),
        });
        if (existingMem !== undefined) throw duplicateMembership;
        // TFE compat: an auto-provisioned identity starts invited; an existing
        // identity defaults to active unless the caller explicitly requests invited.
        const isNewProvisional = txTargetUser.isProvisional === true && txTargetUser.email !== null && email !== undefined && email !== null && txTargetUser.email.toLowerCase() === email;
        const effectiveStatus = isNewProvisional ? "invited" : (rawRequestedStatus ?? "active");
        await t.insert(organizationMemberships).values({
          id: memId, orgId: org.id, userId: txTargetUser.id, role: "member", status: effectiveStatus,
        });
        const teamIds = validatedTeams?.map((team): string => team.id) ?? [];
        if (validatedTeams !== null && validatedTeams.length > 0) {
          // Team rows are safe to materialize while the org membership is invited:
          // authorization requires an active org membership, and preserving them
          // makes activation deterministic instead of dropping the assignment.
          await t.insert(teamMemberships).values(validatedTeams.map((team): typeof teamMemberships.$inferInsert => ({
            id: `tmem-${crypto.randomUUID()}`,
            teamId: team.id,
            userId: txTargetUser.id,
            createdAt: Date.now(),
          }))).onConflictDoNothing();
        }
        const createdMembership = await t.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, memId) });
        if (createdMembership === undefined) throw new Error("organization membership was not created");
        return { targetUser: txTargetUser, mem: createdMembership, teamIds };
      });
    } catch (error: unknown) {
      if (error === duplicateMembership || isUniqueConstraintError(error)) {
        (set as { status: number }).status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "User is already a member of this organization" }] };
      }
      throw error;
    }
    targetUser = result.targetUser;
    const mem = result.mem;
    const effectiveStatus = mem.status;
    await auditLog("create", "organization-memberships", memId, user?.id ?? null, org.id, { userId: targetUser.id, email: email ?? targetUser.email, role: "member", status: effectiveStatus });
    (set as { status: number }).status = 201;
    return { data: await orgMembershipResource(mem, targetUser, result.teamIds) };
  })
  .get("/api/v2/organizations/:org_name/organization-memberships", async ({ params, query, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId, tokenTeamId ?? null, "members:read"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const url = new URL(request.url);
    const q = (query["q"] ?? url.searchParams.get("q") ?? "").trim().toLowerCase();
    const filterStatus = (query["filter[status]"] ?? url.searchParams.get("filter[status]") ?? "").trim();
    const filterEmail = (query["filter[email]"] ?? url.searchParams.get("filter[email]") ?? "").trim().toLowerCase();
    if (filterStatus !== "" && !["active", "invited"].includes(filterStatus)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "filter[status] must be active or invited" }] };
    }
    const { number, size } = pageRequest(request);
    // Apply filters. q and filter[email] both match user username/email; they compose with AND.
    let filteredMems: Readonly<typeof organizationMemberships.$inferSelect>[] = await db.query.organizationMemberships.findMany({ where: eq(organizationMemberships.orgId, org.id), orderBy: [asc(organizationMemberships.id)] });
    if (filteredMems.length > 0) {
      const liveUserIds = new Set((await db.query.users.findMany({
        where: and(inArray(users.id, [...new Set(filteredMems.map((m): string => m.userId))]), isNull(users.deletedAt)),
        columns: { id: true },
      })).map((u): string => u.id));
      filteredMems = filteredMems.filter((m): boolean => liveUserIds.has(m.userId));
    }
    if (filterStatus !== "") filteredMems = filteredMems.filter((m): boolean => m.status === filterStatus);
    if (filterEmail !== "" || q !== "") {
      const memUserIds = [...new Set(filteredMems.map((m): string => m.userId))];
      const memUsers = memUserIds.length > 0 ? await db.query.users.findMany({ where: inArray(users.id, memUserIds) }) : [];
      const memUserMap = new Map(memUsers.map((u): [string, typeof u] => [u.id, u]));
      const emailNeedles = filterEmail !== "" ? filterEmail.split(",").map((s): string => s.trim().toLowerCase()).filter(Boolean) : [];
      const matchUser = (uid: string): boolean => {
        const u = memUserMap.get(uid);
        if (u === undefined) return false;
        const hay = `${u.username} ${u.email ?? ""}`.toLowerCase();
        const emailHay = (u.email ?? "").toLowerCase();
        if (q !== "" && !hay.includes(q)) return false;
        if (emailNeedles.length > 0 && !emailNeedles.some((needle): boolean => emailHay === needle || emailHay.includes(needle))) return false;
        return true;
      };
      filteredMems = filteredMems.filter((m): boolean => matchUser(m.userId));
    }
    const byStatus = await db.select({ status: organizationMemberships.status, total: count() }).from(organizationMemberships).where(eq(organizationMemberships.orgId, org.id)).groupBy(organizationMemberships.status);
    const countByStatus = new Map(byStatus.map((row): [string, number] => [row.status, row.total]));
    const statusCounts = {
      total: [...countByStatus.values()].reduce((sum, value): number => sum + value, 0),
      active: countByStatus.get("active") ?? 0,
      invited: countByStatus.get("invited") ?? 0,
    };
    const totalFiltered = filteredMems.length;
    const page = filteredMems.slice((number - 1) * size, number * size);
    const userIds = page.map((m: Readonly<{ readonly userId: string }>): string => m.userId);
    const userList = userIds.length > 0 ? await db.query.users.findMany({ where: inArray(users.id, userIds) }) : [];
    const userMap = new Map(userList.map((u: Readonly<typeof users.$inferSelect>): [string, typeof u] => [u.id, u]));
    const includeQuery = query["include"];
    const includeUsers = typeof includeQuery === "string" && includeQuery.split(",").includes("user");
    const data = await Promise.all(page.map(async (m: Readonly<typeof organizationMemberships.$inferSelect>): Promise<Record<string, unknown>> => orgMembershipResource(m, userMap.get(m.userId) ?? null)));
    const result: { data: Record<string, unknown>[]; included?: Record<string, unknown>[]; meta?: Record<string, unknown>; links?: Record<string, string | null> } = {
      data,
      ...pagination(request, number, size, totalFiltered),
    };
    // Preserve pagination meta alongside status-counts (object spread of `meta`
    // would otherwise clobber one side). Merge both.
    result.meta = { ...(result.meta ?? {}), "status-counts": statusCounts };
    if (includeUsers && userList.length > 0) {
      result.included = userList.map((u: Readonly<typeof users.$inferSelect>): Record<string, unknown> => userResource(u));
    }
    return result;
  })
  .get("/api/v2/organizations/:org_name/users", async ({ params, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId, tokenTeamId ?? null, "members:read"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const [rows, countRows] = await Promise.all([
      db.select({ user: users })
        .from(organizationMemberships)
        .innerJoin(users, eq(users.id, organizationMemberships.userId))
        .where(and(eq(organizationMemberships.orgId, org.id), isNull(users.deletedAt)))
        .orderBy(asc(organizationMemberships.id))
        .limit(size)
        .offset((number - 1) * size),
      db.select({ total: count() })
        .from(organizationMemberships)
        .innerJoin(users, eq(users.id, organizationMemberships.userId))
        .where(and(eq(organizationMemberships.orgId, org.id), isNull(users.deletedAt))),
    ]);
    const data = rows.map((row: Readonly<{ user: typeof users.$inferSelect }>): Record<string, unknown> => userResource(row.user));
    const totalCount = countRows[0]?.total ?? 0;
    return { data, ...pagination(request, number, size, totalCount) };
  })
  .get("/api/v2/organization-memberships/:id", async ({ params, query, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const memId = params["id"] ?? "";
    const mem = await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, memId) });
    if (mem === undefined || !(await checkOrgPermission(user?.id, mem.orgId, "member", tokenOrgId, tokenTeamId ?? null, "members:read"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const targetUser = await db.query.users.findFirst({ where: and(eq(users.id, mem.userId), isNull(users.deletedAt)) });
    if (targetUser === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const includeQuery = query["include"];
    const includeUsers = typeof includeQuery === "string" && includeQuery.split(",").includes("user");
    const result: { data: Record<string, unknown>; included?: Record<string, unknown>[] } = { data: await orgMembershipResource(mem, targetUser) };
    if (includeUsers && targetUser !== undefined) {
      result.included = [userResource(targetUser)];
    }
    return result;
  })
  .delete("/api/v2/organization-memberships/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const memId = params["id"] ?? "";
    const mem = await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, memId) });
    if (mem === undefined || !(await checkOrganizationPermission(mem.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    // Serialize the owner check with the delete. A count followed by an
    // unlocked delete lets two concurrent requests remove the final owners.
    let blockedLastOwner = false;
    let removedMem: typeof mem | undefined = undefined;
    await withDbLock(`organization-membership:${mem.orgId}`, async (): Promise<void> => {
      const current = await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, memId) });
      if (current === undefined) return;
      if (current.role === "owner" && current.status === "active") {
        const owners = await db.query.organizationMemberships.findMany({
          where: and(eq(organizationMemberships.orgId, current.orgId), eq(organizationMemberships.role, "owner"), eq(organizationMemberships.status, "active")),
          columns: { id: true },
        });
        if (owners.length <= 1) {
          blockedLastOwner = true;
          return;
        }
      }
      await db.transaction(async (tx: unknown): Promise<void> => {
        const t = tx as typeof db;
        const orgTeamIds = (await t.query.teams.findMany({ where: eq(teams.orgId, current.orgId), columns: { id: true } })).map((row: { id: string }): string => row.id);
        if (orgTeamIds.length > 0) {
          await t.delete(teamMemberships).where(and(eq(teamMemberships.userId, current.userId), inArray(teamMemberships.teamId, orgTeamIds)));
        }
        await t.delete(organizationMemberships).where(eq(organizationMemberships.id, memId));
      });
      removedMem = current;
    });
    if (blockedLastOwner) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Cannot remove the last active owner of the organization" }] };
    }
    if (removedMem === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await auditLog("remove", "organization-memberships", memId, user?.id ?? null, mem.orgId, { userId: mem.userId, role: mem.role });
    // Immediate SSE revocation: close the user's event streams so their
    // permission snapshot cannot linger for the one-hour reconnect cap.
    publish("authz.changed", { "user-id": mem.userId, "org-id": mem.orgId });
    (set as { status: number }).status = 204;
    return {};
  })
  .patch("/api/v2/organization-memberships/:id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }): Promise<unknown> => {
    const memId = params.id ?? "";
    const mem = await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, memId) });
    if (mem === undefined || !(await checkOrganizationPermission(mem.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    if (data !== undefined && typeof data["type"] === "string" && data["type"] !== "organization-memberships") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data.type must be \"organization-memberships\"" }] };
    }
    const attrs = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const updates: Partial<typeof organizationMemberships.$inferInsert> = {};

    // Status: invited <-> active is the activation path for provisioned members.
    if (attrs["status"] !== undefined) {
      if (typeof attrs["status"] !== "string" || !["active", "invited"].includes(attrs["status"])) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "status must be one of: active, invited" }] };
      }
      updates.status = attrs["status"];
    }

    // Role: owner promotion/demotion. The final owner guard is repeated inside
    // the write lock below so status changes cannot bypass it.
    if (attrs["role"] !== undefined) {
      if (typeof attrs["role"] !== "string" || !["owner", "member"].includes(attrs["role"])) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "role must be one of: owner, member" }] };
      }
      if (mem.role !== attrs["role"]) updates.role = attrs["role"];
    }

    if (Object.keys(updates).length === 0) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "No changes requested" }] };
    }

    let blockedLastOwner = false;
    let changed = false;
    let lockedMem: typeof mem | undefined = undefined;
    await withDbLock(`organization-membership:${mem.orgId}`, async (): Promise<void> => {
      const current = await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, memId) });
      if (current === undefined) return;
      lockedMem = current;
      const lockedUpdates: Partial<typeof organizationMemberships.$inferInsert> = {};
      if (updates.status !== undefined && updates.status !== current.status) lockedUpdates.status = updates.status;
      if (updates.role !== undefined && updates.role !== current.role) lockedUpdates.role = updates.role;
      if ((lockedUpdates.role === "member" || lockedUpdates.status === "invited") && current.role === "owner" && current.status === "active") {
        const owners = await db.query.organizationMemberships.findMany({
          where: and(eq(organizationMemberships.orgId, current.orgId), eq(organizationMemberships.role, "owner"), eq(organizationMemberships.status, "active")),
          columns: { id: true },
        });
        if (owners.length <= 1) {
          blockedLastOwner = true;
          return;
        }
      }
      if (Object.keys(lockedUpdates).length > 0) {
        await db.update(organizationMemberships).set(lockedUpdates).where(eq(organizationMemberships.id, memId));
        changed = true;
      }
    });
    if (blockedLastOwner) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Cannot remove the last active owner of the organization" }] };
    }
    if (lockedMem === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!changed) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "No changes requested" }] };
    }
    await auditLog("update", "organization-memberships", memId, user?.id ?? null, mem.orgId, { userId: mem.userId, ...updates });
    // Status/role changes alter permissions immediately; revoke stale streams.
    publish("authz.changed", { "user-id": mem.userId, "org-id": mem.orgId });
    const updated = await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, memId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, updated.userId) });
    return { data: await orgMembershipResource(updated, targetUser) };
  })
  // --- Auth Tokens ---
  .get("/api/v2/users/:user_id/authentication-tokens", async ({ params, user, request, set }: ParamCtx): Promise<unknown> => {
    const userId = params["user_id"] ?? "";
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
    const userId = params["user_id"] ?? "";
    const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (target === undefined || user?.id !== userId) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if ((target as unknown as { deletedAt?: unknown }).deletedAt != null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (target.isProvisional === true) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: "Provisional accounts cannot create tokens" }] };
    }
    if (target.isSuspended === true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden", detail: "Suspended accounts cannot create tokens" }] }; }
    // A fine-grained token must not be able to mint a new token (which could
    // be unscoped = full access), or its restrictions are trivially bypassed.
    if (currentTokenScopes() !== null) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: "Fine-grained tokens cannot create additional tokens" }] };
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attributes = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const description = typeof attributes["description"] === "string" ? attributes["description"].trim() : "API token";
    const requestedExpiry = tokenExpiry(typeof attributes["expired-at"] === "string" ? attributes["expired-at"] : undefined);
    if (description === "" || description.length > TOKEN_DESCRIPTION_MAX_LENGTH || Number.isNaN(requestedExpiry)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `description is required and must be at most ${TOKEN_DESCRIPTION_MAX_LENGTH} characters` }] };
    }
    // Organization TTL policy governs user tokens (todo 72-74): the effective
    // expiry is capped by the policy; max-ttl-ms = 0 forbids minting.
    const policyResolution = await resolveTokenExpiryUnderPolicy(null, "user", requestedExpiry);
    if (policyResolution.kind === "invalid") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: policyResolution.detail }] };
    }
    if (policyResolution.kind === "forbidden") {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: policyResolution.detail }] };
    }
    const expiresAt = policyResolution.expiresAt;
    // Fine-grained scopes (optional): when present, the token is restricted
    // to the listed orgs/projects/workspaces/tags and permission grants.
    let scopes: TokenScopes | null = null;
    if (attributes["scopes"] !== undefined) {
      try {
        scopes = parseTokenScopes(attributes["scopes"]);
      } catch (error: unknown) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: error instanceof Error ? error.message : "Invalid scopes" }] };
      }
    }
    const rawToken = generateAuthenticationToken("user");
    const createdToken = {
      id: crypto.randomUUID(),
      token: hashAuthenticationToken(rawToken),
      userId,
      orgId: null,
      description,
      scopes: scopes === null ? null : JSON.stringify(scopes),
      tokenType: "",
      legacy: false,
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt,
      teamId: null,
    };
    await db.insert(apiTokens).values(createdToken);
    await auditLog("create", "authentication-token", createdToken.id, user?.id ?? null, null, {
      description,
      source: "user",
    });
    (set as { status: number }).status = 201;
    return { data: tokenResource({ ...createdToken, _rawToken: rawToken }, true) };
  })
  .get("/api/v2/authentication-tokens/:token_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const tokenId = params["token_id"] ?? "";
    const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, tokenId) });
    if (token !== undefined && user?.id === token.userId) {
      return { data: tokenResource(token) };
    }
    // Team tokens: generic lookup requires manage-teams on the token's org
    // (todo 45).
    if (token !== undefined && token.teamId !== null) {
      const team = await db.query.teams.findFirst({ where: eq(teams.id, token.teamId) });
      if (team !== undefined && (await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) {
        return { data: tokenResource(token) };
      }
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
    const tokenId = params["token_id"] ?? "";
    const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, tokenId) });
    if (token !== undefined && user?.id === token.userId) {
      await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
      await auditLog("revoke", "authentication-token", tokenId, user?.id ?? null, null, { userId: token.userId });
      (set as { status: number }).status = 204;
      return {};
    }
    // Team tokens: generic delete requires manage-teams on the token's org;
    // the legacy credential can only be removed via the singular endpoint
    // (todo 46).
    if (token !== undefined && token.teamId !== null && token.legacy === false) {
      const team = await db.query.teams.findFirst({ where: eq(teams.id, token.teamId) });
      if (team !== undefined && (await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) {
        await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
        (set as { status: number }).status = 204;
        return {};
      }
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
    if (agentToken !== undefined && pool !== undefined) await auditLog("delete", "agent-pool-token", tokenId, user?.id ?? null, pool.orgId, { agentPoolId: pool.id });
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
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attributes = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const rels = typeof data?.["relationships"] === "object" && data["relationships"] !== null ? (data["relationships"] as Record<string, unknown>) : {};
    const orgRel = typeof rels["organization"] === "object" && rels["organization"] !== null ? (rels["organization"] as Record<string, unknown>) : {};
    const orgData = typeof orgRel["data"] === "object" && orgRel["data"] !== null ? (orgRel["data"] as Record<string, unknown>) : {};
    const description = typeof attributes["description"] === "string" ? attributes["description"] : "API token";
    const orgId = typeof orgData["id"] === "string" ? orgData["id"] : undefined;
    const requestedExpiry = tokenExpiry(typeof attributes["expired-at"] === "string" ? attributes["expired-at"] : undefined);
    if (Number.isNaN(requestedExpiry)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "expired-at must be a valid ISO-8601 timestamp" }] };
    }
    // Organization TTL policy governs org-scoped tokens minted here (todo
    // 72-74); user-scoped ones have no governing org policy.
    const policyResolution = orgId !== undefined
      ? await resolveTokenExpiryUnderPolicy(orgId, "", requestedExpiry)
      : { kind: "ok" as const, expiresAt: requestedExpiry };
    if (policyResolution.kind === "invalid") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: policyResolution.detail }] };
    }
    if (policyResolution.kind === "forbidden") {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: policyResolution.detail }] };
    }
    const expiresAt = policyResolution.expiresAt;
    // Fine-grained scopes (optional): when present, the token is restricted
    // to the listed orgs/projects/workspaces/tags and permission grants.
    let scopes: TokenScopes | null = null;
    if (attributes["scopes"] !== undefined) {
      try {
        scopes = parseTokenScopes(attributes["scopes"]);
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
    const rawToken = generateAuthenticationToken(orgId !== undefined ? "org" : "user");
    const createdToken = {
      id: crypto.randomUUID(),
      token: hashAuthenticationToken(rawToken),
      userId: orgId !== undefined ? null : user.id,
      orgId: orgId ?? null,
      description,
      scopes: scopes === null ? null : JSON.stringify(scopes),
      tokenType: "",
      legacy: false,
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt,
      teamId: null,
    };
    if (orgId !== undefined) {
      await withDbLock(`organization-token:${orgId}:`, async (): Promise<void> => {
        await db.transaction(async (tx: unknown): Promise<void> => {
          const t = tx as typeof db;
          await t.delete(apiTokens).where(organizationTokenWhere(orgId, ""));
          await t.insert(apiTokens).values(createdToken);
        });
      });
    } else {
      await db.insert(apiTokens).values(createdToken);
    }
    await auditLog("create", "authentication-token", createdToken.id, user.id, orgId ?? null, {
      description,
      scopes: createdToken.scopes,
      ...(orgId !== undefined ? { orgId } : {}),
      source: "user",
    });
    (set as { status: number }).status = 201;
    return { data: tokenResource({ ...createdToken, _rawToken: rawToken }, true) };
  })
  .get("/api/v2/organizations/:org_name/authentication-token", async ({ params, request, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || (orgId !== org.id && !(await checkOrgPermission(user?.id, org.id, "owner")))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    // the cloud platform passes ?token=audit-trails to address the audit-trails token slot
    // distinctly from the organization token (which sends no query param).
    const rawTokenType = new URL(request.url).searchParams.get("token") ?? "";
    const validated = validateOrgTokenType(rawTokenType);
    if (validated === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "token query parameter must be one of: (empty), organization, audit-trails" }] };
    }
    const tokenType = validated === "organization" ? "" : validated;
    const token = await db.query.apiTokens.findFirst({
      where: organizationTokenWhere(org.id, tokenType),
    });
    if (token === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: tokenResource(token) };
  })
  .post("/api/v2/organizations/:org_name/authentication-token", async ({ params, request, body, user, orgId, set }: ParamCtx): Promise<unknown> => {
    if (currentTokenScopes() !== null) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: "Fine-grained tokens cannot mint unscoped organization tokens" }] };
    }
    const orgName = params["org_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || (orgId !== org.id && !(await checkOrgPermission(user?.id, org.id, "owner")))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    // Unknown token values must not mint arbitrary token namespaces (todo 52/53).
    const rawTokenType = new URL(request.url).searchParams.get("token") ?? "";
    const validated = validateOrgTokenType(rawTokenType);
    if (validated === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "token query parameter must be one of: (empty), organization, audit-trails" }] };
    }
    const tokenType = validated === "organization" ? "" : validated;
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attributes = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const requestedExpiry = tokenExpiry(typeof attributes["expired-at"] === "string" ? attributes["expired-at"] : undefined);
    if (Number.isNaN(requestedExpiry)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    // TFE parity: org tokens default to a two-year expiry; the org TTL policy
    // caps (or forbids) the result (todo 49-51, 72-74).
    const requestedOrDefault = requestedExpiry ?? Date.now() + TWO_YEARS_MS;
    // The "organization" query alias resolves to the "" storage slot.
    const normalizedTokenType = validated === "organization" ? "" : validated;
    const policyResolution = await resolveTokenExpiryUnderPolicy(org.id, normalizedTokenType, requestedOrDefault);
    if (policyResolution.kind === "invalid") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: policyResolution.detail }] };
    }
    if (policyResolution.kind === "forbidden") {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: policyResolution.detail }] };
    }
    const expiresAt = policyResolution.expiresAt;
    const rawToken = generateAuthenticationToken("org");
    const createdToken = {
      id: crypto.randomUUID(),
      token: hashAuthenticationToken(rawToken),
      userId: null,
      orgId: org.id,
      description: null,
      scopes: null,
      tokenType,
      legacy: false,
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt,
      teamId: null,
    };
    const priorOrgToken = await withDbLock(`organization-token:${org.id}:${tokenType}`, async (): Promise<Readonly<typeof apiTokens.$inferSelect> | undefined> => {
      const prior = await db.query.apiTokens.findFirst({ where: organizationTokenWhere(org.id, tokenType) });
      await db.transaction(async (tx: unknown): Promise<void> => {
        const t = tx as typeof db;
        await t.delete(apiTokens).where(organizationTokenWhere(org.id, tokenType));
        await t.insert(apiTokens).values(createdToken);
      });
      return prior;
    });
    await auditLog(priorOrgToken === undefined ? "create" : "replace", "organization-authentication-token", createdToken.id, user?.id ?? null, org.id, {
      orgId: org.id,
      tokenType: tokenType === "" ? null : tokenType,
      source: "user",
      ...(priorOrgToken === undefined ? {} : { replacedTokenId: priorOrgToken.id }),
    });
    (set as { status: number }).status = 201;
    return { data: tokenResource({ ...createdToken, _rawToken: rawToken }, true) };
  })
  .delete("/api/v2/organizations/:org_name/authentication-token", async ({ params, request, user, orgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string; detail?: string }[] }> => {
    const orgName = params["org_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || (orgId !== org.id && !(await checkOrgPermission(user?.id, org.id, "owner")))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const requestedTokenType = new URL(request.url).searchParams.get("token") ?? "";
    const validatedTokenType = validateOrgTokenType(requestedTokenType);
    if (validatedTokenType === null) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "token must be one of: (empty), organization, audit-trails" }] };
    }
    const tokenType = validatedTokenType === "organization" ? "" : validatedTokenType;
    const existing = await withDbLock(`organization-token:${org.id}:${tokenType}`, async (): Promise<Readonly<typeof apiTokens.$inferSelect> | undefined> => {
      const prior = await db.query.apiTokens.findFirst({ where: organizationTokenWhere(org.id, tokenType) });
      await db.delete(apiTokens).where(organizationTokenWhere(org.id, tokenType));
      return prior;
    });
    if (existing !== undefined) await auditLog("delete", "organization-authentication-token", existing.id, user?.id ?? null, org.id, { tokenType: tokenType === "" ? null : tokenType });
    (set as { status: number }).status = 204;
    return {};
  });
