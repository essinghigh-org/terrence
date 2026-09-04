import { Elysia } from "elysia";
import { tokenHashCandidates } from "../lib/token-service";
import { db } from "../db";
import { apiTokens, identityLinks, organizationInvitations, refreshSessions, scimGroups, scimGroupMemberships, scimTokens, scimUserIdentities, scimSettings,
  teamMemberships, teamScimGroupMappings, teams, users } from "../db/schema";
import { and, asc, count, eq, inArray, isNull, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { isUniqueConstraintError } from "../lib/validation";
import { hashPassword } from "../lib/password-hashing";
import { reconcileScimSiteAdmins, reconcileTeam } from "./scim-admin";

type SetObj = Readonly<{ status?: number | string; headers: Record<string, string | number> }>;

type RequestCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string>>;
  body?: unknown;
  request: Readonly<{ headers: { get(name: string): string | null }; url: string }>;
  set: SetObj;
}>;

async function validateScimToken(request: { headers: { get(name: string): string | null } }, set: SetObj): Promise<boolean> {
  const auth = request.headers.get("authorization");
  const match = auth === null ? null : /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (match === null) { (set as { status: number }).status = 401; return false; }
  const rawToken = match[1] ?? "";
  const [hash, legacyHash] = tokenHashCandidates(rawToken);
  const now = Date.now();
  const tokenRows = await db.query.scimTokens.findMany({ where: inArray(scimTokens.tokenHash, [hash, legacyHash]), limit: 2 });
  const token = tokenRows.find((candidate) => candidate.tokenHash === hash) ?? tokenRows[0];
  if (!token || token.expiresAt < now) { (set as { status: number }).status = 401; return false; }
  if (token.tokenHash === legacyHash) {
    await db.update(scimTokens).set({ tokenHash: hash }).where(eq(scimTokens.id, token.id));
  }
  const settings = await db.query.scimSettings.findFirst({ where: eq(scimSettings.id, "scim") });
  if (!settings?.enabled || settings.paused === true) { (set as { status: number }).status = 401; return false; }
  await db.update(scimTokens).set({ lastUsedAt: now }).where(eq(scimTokens.id, token.id));
  return true;
}

function scimError(set: SetObj, status: number, detail: string): Record<string, unknown> {
  (set as { status: number }).status = status;
  set.headers["Content-Type"] = "application/scim+json";
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    detail,
  };
}

type ScimPayload = Record<string, unknown>;

const SCIM_DEFAULT_COUNT = 100;
const SCIM_MAX_COUNT = 200;

type ScimFilter = Readonly<{ attribute: string; value: string | boolean }>;
type ScimListQuery = Readonly<{ filter?: ScimFilter; startIndex: number; count: number }>;

function parseScimFilter(raw: string | null): ScimFilter | { error: string } | undefined {
  if (raw === null) return undefined;
  if (raw.trim() === "") return { error: "filter must not be empty" };
  const match = /^\s*([A-Za-z][A-Za-z0-9_.-]*)\s+eq\s+(?:"((?:\\.|[^"\\])*)"|(true|false))\s*$/i.exec(raw);
  if (match === null) return { error: "filter must use an equality expression with a quoted string or boolean" };
  const attribute = match[1] ?? "";
  const stringValue = match[2];
  if (stringValue !== undefined) {
    try {
      const decoded: unknown = JSON.parse(`"${stringValue}"`);
      return typeof decoded === "string" ? { attribute, value: decoded } : { error: "filter string value is invalid" };
    } catch {
      return { error: "filter string value is invalid" };
    }
  }
  return { attribute, value: (match[3] ?? "").toLowerCase() === "true" };
}

function parseScimInteger(raw: string | null, name: string, defaultValue: number, minimum: number): number | { error: string } {
  if (raw === null) return defaultValue;
  if (!/^\d+$/.test(raw)) return { error: `${name} must be an integer` };
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum ? value : { error: `${name} is out of range` };
}

function parseScimListQuery(request: RequestCtx["request"]): ScimListQuery | { error: string } {
  const params = new URL(request.url).searchParams;
  const startIndex = parseScimInteger(params.get("startIndex"), "startIndex", 1, 1);
  if (typeof startIndex !== "number") return startIndex;
  const requestedCount = parseScimInteger(params.get("count"), "count", SCIM_DEFAULT_COUNT, 0);
  if (typeof requestedCount !== "number") return requestedCount;
  const parsedFilter = parseScimFilter(params.get("filter"));
  if (parsedFilter !== undefined && "error" in parsedFilter) return parsedFilter;
  return {
    startIndex,
    count: Math.min(requestedCount, SCIM_MAX_COUNT),
    ...(parsedFilter === undefined ? {} : { filter: parsedFilter }),
  };
}

function scimCaseInsensitiveEquals(column: AnyColumn, value: string): SQL {
  return sql`lower(${column}) = lower(${value})`;
}

function scimUserWhere(filter: ScimFilter | undefined): SQL | { error: string } | undefined {
  if (filter === undefined) return undefined;
  switch (filter.attribute.toLowerCase()) {
    case "id":
      return typeof filter.value === "string" ? eq(scimUserIdentities.id, filter.value) : { error: "id filter value must be a string" };
    case "username":
      return typeof filter.value === "string" ? sql`lower(coalesce(${users.username}, ${scimUserIdentities.username})) = lower(${filter.value})` : { error: "userName filter value must be a string" };
    case "externalid":
      return typeof filter.value === "string" ? scimCaseInsensitiveEquals(scimUserIdentities.externalId, filter.value) : { error: "externalId filter value must be a string" };
    case "emails.value":
      return typeof filter.value === "string" ? sql`lower(nullif(${users.email}, '')) = lower(${filter.value})` : { error: "emails.value filter value must be a string" };
    case "active":
      if (typeof filter.value !== "boolean") return { error: "active filter value must be a boolean" };
      return filter.value
        ? or(isNull(users.id), isNull(users.isSuspended), eq(users.isSuspended, false))
        : eq(users.isSuspended, true);
    default:
      return { error: `Unsupported User filter attribute: ${filter.attribute}` };
  }
}

function scimGroupWhere(filter: ScimFilter | undefined): SQL | { error: string } | undefined {
  if (filter === undefined) return undefined;
  switch (filter.attribute.toLowerCase()) {
    case "id":
      return typeof filter.value === "string" ? eq(scimGroups.id, filter.value) : { error: "id filter value must be a string" };
    case "displayname":
      return typeof filter.value === "string" ? scimCaseInsensitiveEquals(scimGroups.name, filter.value) : { error: "displayName filter value must be a string" };
    case "externalid":
      return typeof filter.value === "string" ? scimCaseInsensitiveEquals(scimGroups.externalId, filter.value) : { error: "externalId filter value must be a string" };
    default:
      return { error: `Unsupported Group filter attribute: ${filter.attribute}` };
  }
}

function parseScimActive(payload: ScimPayload): boolean | undefined | null {
  const value = payload["active"];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function scimUserResource(identity: typeof scimUserIdentities.$inferSelect, user: typeof users.$inferSelect | undefined): Record<string, unknown> {
  const created = new Date(identity.createdAt ?? identity.updatedAt).toISOString();
  const lastModified = new Date(identity.updatedAt).toISOString();
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: identity.id,
    externalId: identity.externalId ?? null,
    userName: user?.username ?? identity.username,
    name: { formatted: user?.username ?? identity.username },
    emails: user?.email ? [{ value: user.email, primary: true }] : [],
    active: user?.isSuspended !== true,
    meta: { resourceType: "User", created, lastModified },
  };
}

type ScimGroupMembership = typeof scimGroupMemberships.$inferSelect;

function buildScimGroupResource(
  group: typeof scimGroups.$inferSelect,
  memberships: readonly ScimGroupMembership[],
  names: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const created = new Date(group.createdAt).toISOString();
  const lastModified = new Date(group.updatedAt).toISOString();
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    id: group.id,
    externalId: group.externalId ?? null,
    displayName: group.name,
    members: memberships.map((membership): Record<string, string> => ({ value: membership.scimUserId, display: names.get(membership.scimUserId) ?? membership.scimUserId })),
    meta: { resourceType: "Group", created, lastModified },
  };
}

async function scimGroupResource(group: typeof scimGroups.$inferSelect): Promise<Record<string, unknown>> {
  const memberships = await db.query.scimGroupMemberships.findMany({ where: eq(scimGroupMemberships.groupId, group.id) });
  const identityIds = memberships.map((membership): string => membership.scimUserId);
  const identities = identityIds.length === 0 ? [] : await db.query.scimUserIdentities.findMany({ where: inArray(scimUserIdentities.id, identityIds) });
  const userIds = identities.map((identity): string => identity.userId);
  const userRows = userIds.length === 0 ? [] : await db.query.users.findMany({ where: inArray(users.id, userIds), columns: { id: true, username: true } });
  const usernames = new Map(userRows.map((user): [string, string] => [user.id, user.username]));
  const names = new Map(identities.map((identity): [string, string] => [identity.id, usernames.get(identity.userId) ?? identity.username]));
  return buildScimGroupResource(group, memberships, names);
}

async function scimGroupResources(groups: readonly (typeof scimGroups.$inferSelect)[]): Promise<Record<string, unknown>[]> {
  if (groups.length === 0) return [];
  const groupIds = groups.map((group): string => group.id);
  const memberships = await db.query.scimGroupMemberships.findMany({
    where: inArray(scimGroupMemberships.groupId, groupIds),
    orderBy: [asc(scimGroupMemberships.id)],
  });
  const identityIds = [...new Set(memberships.map((membership): string => membership.scimUserId))];
  const identities = identityIds.length === 0 ? [] : await db.query.scimUserIdentities.findMany({ where: inArray(scimUserIdentities.id, identityIds) });
  const userIds = [...new Set(identities.map((identity): string => identity.userId))];
  const userRows = userIds.length === 0 ? [] : await db.query.users.findMany({ where: inArray(users.id, userIds), columns: { id: true, username: true } });
  const usernames = new Map(userRows.map((user): [string, string] => [user.id, user.username]));
  const names = new Map(identities.map((identity): [string, string] => [identity.id, usernames.get(identity.userId) ?? identity.username]));
  const membershipsByGroup = new Map<string, ScimGroupMembership[]>();
  for (const membership of memberships) {
    const groupMemberships = membershipsByGroup.get(membership.groupId) ?? [];
    groupMemberships.push(membership);
    membershipsByGroup.set(membership.groupId, groupMemberships);
  }
  return groups.map((group): Record<string, unknown> => buildScimGroupResource(group, membershipsByGroup.get(group.id) ?? [], names));
}

function scimEmail(payload: ScimPayload): string | null {
  const emails: readonly unknown[] = Array.isArray(payload["emails"]) ? payload["emails"] as readonly unknown[] : [];
  const primary = emails.find((email): boolean => email !== null && typeof email === "object" && (email as Record<string, unknown>)["primary"] === true);
  const first = primary ?? emails[0];
  const value = first !== null && typeof first === "object" ? (first as Record<string, unknown>)["value"] : undefined;
  // Lowercase to the canonical form used by every other identity path (SSO,
  // invitations, membership add). Without this, a mixed-case SCIM email
  // bypasses the exact-match lookups and provisions duplicate users.
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim().toLowerCase();
}

function scimMemberIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map((item): string => {
    if (item === null || typeof item !== "object") return "";
    const id = (item as Record<string, unknown>)["value"];
    return typeof id === "string" ? id : "";
  });
  return ids.every((id): boolean => id !== "") ? [...new Set(ids)] : null;
}

async function replaceScimGroupMembers(groupId: string, ids: readonly string[], transaction?: unknown): Promise<boolean> {
  const replace = async (transactionContext: unknown): Promise<boolean> => {
    const tx = transactionContext as typeof db;
    const identities = ids.length === 0
      ? []
      : await tx.select({ id: scimUserIdentities.id }).from(scimUserIdentities).where(inArray(scimUserIdentities.id, [...ids]));
    if (identities.length !== ids.length) return false;
    await tx.delete(scimGroupMemberships).where(eq(scimGroupMemberships.groupId, groupId));
    if (ids.length > 0) {
      await tx.insert(scimGroupMemberships).values(ids.map((scimUserId): typeof scimGroupMemberships.$inferInsert => ({ id: `scimmember-${crypto.randomUUID()}`, groupId, scimUserId })));
    }
    return true;
  };
  return transaction === undefined ? db.transaction(replace) : replace(transaction);
}

async function reconcileMappedTeams(groupId: string, transaction?: unknown): Promise<void> {
  const reconcile = async (transactionContext: unknown): Promise<void> => {
    const tx = transactionContext as typeof db;
    const mappings = await tx.query.teamScimGroupMappings.findMany({ where: eq(teamScimGroupMappings.scimGroupId, groupId) });
    if (mappings.length === 0) return;
    const mappedTeams = await tx.query.teams.findMany({ where: inArray(teams.id, mappings.map((mapping): string => mapping.teamId)), columns: { id: true, orgId: true } });
    const teamsById = new Map(mappedTeams.map((team): [string, { id: string; orgId: string }] => [team.id, team]));
    for (const mapping of mappings) {
      if (mapping.syncPaused === true) continue;
      const team = teamsById.get(mapping.teamId);
      if (team !== undefined) await reconcileTeam(team, groupId, tx);
    }
  };
  if (transaction !== undefined) return reconcile(transaction);
  await db.transaction(reconcile);
}

async function removeMappedTeamRows(groupIds: readonly string[]): Promise<void> {
  if (groupIds.length === 0) return;
  const mappings = await db.query.teamScimGroupMappings.findMany({ where: inArray(teamScimGroupMappings.scimGroupId, [...groupIds]), columns: { teamId: true } });
  if (mappings.length === 0) return;
  await db.delete(teamMemberships).where(and(eq(teamMemberships.ssoSource, "scim"), inArray(teamMemberships.teamId, mappings.map((mapping): string => mapping.teamId))));
}

export const scimRoutes = new Elysia({ name: "scim" })
  // Service Discovery
  .get("/scim/v2/ServiceProviderConfig", ({ set }: RequestCtx): Record<string, unknown> => {
    set.headers["Content-Type"] = "application/scim+json";
    return {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: "https://developer.hashicorp.com/terraform/enterprise/api-docs/scim",
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        { name: "OAuth Bearer Token", description: "Authentication via SCIM Bearer Token", type: "oauthbearertoken" }
      ]
    };
  })
  .get("/scim/v2/Schemas", ({ set }: RequestCtx): Record<string, unknown> => {
    set.headers["Content-Type"] = "application/scim+json";
    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 2,
      Resources: [
        { id: "urn:ietf:params:scim:schemas:core:2.0:User", name: "User", description: "User Account" },
        { id: "urn:ietf:params:scim:schemas:core:2.0:Group", name: "Group", description: "Group" }
      ]
    };
  })
  .get("/scim/v2/ResourceTypes", ({ set }: RequestCtx): Record<string, unknown> => {
    set.headers["Content-Type"] = "application/scim+json";
    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 2,
      Resources: [
        { id: "User", name: "User", endpoint: "/Users", schema: "urn:ietf:params:scim:schemas:core:2.0:User" },
        { id: "Group", name: "Group", endpoint: "/Groups", schema: "urn:ietf:params:scim:schemas:core:2.0:Group" }
      ]
    };
  })

  // Users
  .get("/scim/v2/Users", async ({ request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const parsed = parseScimListQuery(request);
    if ("error" in parsed) return scimError(set, 400, parsed.error);
    const filterWhere = scimUserWhere(parsed.filter);
    if (filterWhere !== undefined && "error" in filterWhere) return scimError(set, 400, filterWhere.error);
    const where = filterWhere;
    const userRowsQuery = db.select({ identity: scimUserIdentities, user: users })
      .from(scimUserIdentities)
      .leftJoin(users, eq(users.id, scimUserIdentities.userId));
    const userCountQuery = db.select({ total: count() })
      .from(scimUserIdentities)
      .leftJoin(users, eq(users.id, scimUserIdentities.userId));
    const [rows, countRows] = await Promise.all([
      (where === undefined ? userRowsQuery : userRowsQuery.where(where))
        .orderBy(asc(scimUserIdentities.id))
        .limit(parsed.count)
        .offset(parsed.startIndex - 1),
      (where === undefined ? userCountQuery : userCountQuery.where(where)),
    ]);
    const resources = rows.map((row): Record<string, unknown> => scimUserResource(row.identity, row.user ?? undefined));
    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: countRows[0]?.total ?? 0,
      startIndex: parsed.startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  })
  .post("/scim/v2/Users", async ({ request, body, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const userName = typeof payload["userName"] === "string" ? payload["userName"].trim() : "";
    if (userName === "") return scimError(set, 400, "userName is required");

    const active = parseScimActive(payload);
    if (active === null) return scimError(set, 400, "active must be a boolean");
    const email = scimEmail(payload);
    if (email === null) return scimError(set, 400, "emails is required");

    const userId = `user-${crypto.randomUUID()}`;
    const passwordHash = await hashPassword(crypto.randomUUID());
    const scimIdentityId = `scimuser-${crypto.randomUUID()}`;
    let rejectedExistingAccount = false;
    try {
      await db.transaction(async (tx): Promise<void> => {
        const existing = await tx.query.users.findFirst({ where: sql`lower(${users.email}) = lower(${email})` });
        if (existing?.isSiteAdmin === true) {
          rejectedExistingAccount = true;
          return;
        }
        const linkedUserId = existing?.id ?? userId;
        if (existing === undefined) {
          await tx.insert(users).values({
            id: userId,
            username: userName,
            email,
            passwordHash,
            isSiteAdmin: false,
            isSuspended: active === false,
            mustChangePassword: false,
          });
        } else {
          if (active !== undefined) {
            await tx.update(users).set({ isSuspended: !active }).where(eq(users.id, existing.id));
            if (active === false) {
              await tx.delete(apiTokens).where(eq(apiTokens.userId, existing.id));
              await tx.update(refreshSessions).set({ revokedAt: Date.now() }).where(and(eq(refreshSessions.userId, existing.id), isNull(refreshSessions.revokedAt)));
            }
          }
        }
        await tx.insert(scimUserIdentities).values({
          id: scimIdentityId,
          userId: linkedUserId,
          username: userName,
          externalId: typeof payload["externalId"] === "string" ? payload["externalId"] : null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        await tx.insert(identityLinks).values({ id: `idlink-${crypto.randomUUID()}`, userId: linkedUserId, provider: "scim", externalId: scimIdentityId, emailAtLinkTime: email, createdAt: Date.now() }).onConflictDoNothing();
        // Converge pending invitation for same canonical email (todo #11: merge not duplicate)
        if (email !== null) {
          const pending = await tx.query.organizationInvitations.findFirst({ where: and(eq(organizationInvitations.emailNormalized, email.toLowerCase()), eq(organizationInvitations.status, "pending")) });
          if (pending !== undefined) {
            const { organizationMemberships } = await import("../db/schema");
            await tx.insert(organizationMemberships).values({ id: `orgmem-${crypto.randomUUID()}`, orgId: pending.orgId, userId: linkedUserId, role: pending.role, status: "active" }).onConflictDoNothing();
            await tx.update(organizationInvitations).set({ status: "accepted", acceptedBy: linkedUserId, updatedAt: Date.now() }).where(eq(organizationInvitations.id, pending.id));
          }
        }
      });
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) throw error;
      return scimError(set, 409, "userName or email is already in use");
    }
    if (rejectedExistingAccount) return scimError(set, 409, "Existing site administrator accounts cannot be linked through SCIM");
    const identity = await db.query.scimUserIdentities.findFirst({ where: eq(scimUserIdentities.id, scimIdentityId) });
    const created = identity === undefined ? undefined : await db.query.users.findFirst({ where: eq(users.id, identity.userId) });
    (set as { status: number }).status = 201;
    return identity === undefined ? scimError(set, 500, "User identity was not created") : scimUserResource(identity, created);
  })
  .get("/scim/v2/Users/:id", async ({ params, request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const identity = await db.query.scimUserIdentities.findFirst({ where: eq(scimUserIdentities.id, params["id"] ?? "") });
    if (!identity) return scimError(set, 404, "User not found");
    const u = await db.query.users.findFirst({ where: eq(users.id, identity.userId) });

    return scimUserResource(identity, u);
  })
  .delete("/scim/v2/Users/:id", async ({ params, request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const identity = await db.query.scimUserIdentities.findFirst({ where: eq(scimUserIdentities.id, params["id"] ?? "") });
    if (!identity) return scimError(set, 404, "User not found");

    await db.transaction(async (tx): Promise<void> => {
      const groupLinks = await tx.query.scimGroupMemberships.findMany({ where: eq(scimGroupMemberships.scimUserId, identity.id), columns: { groupId: true } });
      const mappedTeams = groupLinks.length === 0 ? [] : await tx.query.teamScimGroupMappings.findMany({
        where: inArray(teamScimGroupMappings.scimGroupId, groupLinks.map((link): string => link.groupId)),
        columns: { teamId: true },
      });
      if (mappedTeams.length > 0) {
        await tx.delete(teamMemberships).where(and(eq(teamMemberships.userId, identity.userId), eq(teamMemberships.ssoSource, "scim"), inArray(teamMemberships.teamId, mappedTeams.map((mapping): string => mapping.teamId))));
      }
      await tx.delete(scimGroupMemberships).where(eq(scimGroupMemberships.scimUserId, identity.id));
      await tx.delete(scimUserIdentities).where(eq(scimUserIdentities.id, identity.id));
      await tx.update(users).set({ isSuspended: true }).where(eq(users.id, identity.userId));
      await tx.delete(apiTokens).where(eq(apiTokens.userId, identity.userId));
      await tx.update(refreshSessions).set({ revokedAt: Date.now() }).where(and(eq(refreshSessions.userId, identity.userId), isNull(refreshSessions.revokedAt)));
      await reconcileScimSiteAdmins(tx);
    });

    (set as { status: number }).status = 204;
    return {};
  })
  .put("/scim/v2/Users/:id", async ({ params, body, request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const identity = await db.query.scimUserIdentities.findFirst({ where: eq(scimUserIdentities.id, params["id"] ?? "") });
    if (identity === undefined) return scimError(set, 404, "User not found");
    const payload = body !== null && typeof body === "object" ? body as ScimPayload : {};
    const userName = typeof payload["userName"] === "string" && payload["userName"].trim() !== "" ? payload["userName"].trim() : identity.username;
    const active = parseScimActive(payload);
    if (active === null) return scimError(set, 400, "active must be a boolean");
    const email = scimEmail(payload);
    if (email === null) return scimError(set, 400, "emails is required");
    const currentUser = await db.query.users.findFirst({ where: eq(users.id, identity.userId) });
    if (currentUser === undefined) return scimError(set, 404, "User not found");
    const updatedAt = Date.now();
    try {
      await db.transaction(async (tx): Promise<void> => {
        await tx.update(users).set({
          username: userName,
          email,
          ...(email !== currentUser.email ? { emailVerifiedAt: null } : {}),
          ...(active !== undefined ? { isSuspended: !active } : {}),
        }).where(eq(users.id, identity.userId));
        if (active === false) {
          await tx.delete(apiTokens).where(eq(apiTokens.userId, identity.userId));
          await tx.update(refreshSessions).set({ revokedAt: Date.now() }).where(and(eq(refreshSessions.userId, identity.userId), isNull(refreshSessions.revokedAt)));
        }
        await tx.update(scimUserIdentities).set({ username: userName, externalId: typeof payload["externalId"] === "string" ? payload["externalId"] : null, updatedAt }).where(eq(scimUserIdentities.id, identity.id));
        await tx.update(identityLinks).set({ emailAtLinkTime: email }).where(and(
          eq(identityLinks.userId, identity.userId),
          eq(identityLinks.provider, "scim"),
          eq(identityLinks.externalId, identity.id),
        ));
        await reconcileScimSiteAdmins(tx);
      });
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) throw error;
      return scimError(set, 409, "userName or email is already in use");
    }
    const updatedIdentity = await db.query.scimUserIdentities.findFirst({ where: eq(scimUserIdentities.id, identity.id) });
    const updatedUser = await db.query.users.findFirst({ where: eq(users.id, identity.userId) });
    return updatedIdentity === undefined ? scimError(set, 500, "User identity was not updated") : scimUserResource(updatedIdentity, updatedUser);
  })
  .patch("/scim/v2/Users/:id", async ({ params, body, request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const identity = await db.query.scimUserIdentities.findFirst({ where: eq(scimUserIdentities.id, params["id"] ?? "") });
    if (identity === undefined) return scimError(set, 404, "User not found");
    const payload = body !== null && typeof body === "object" ? body as ScimPayload : {};
    const operations = Array.isArray(payload["Operations"]) ? payload["Operations"] : [];
    if (operations.length > 100) return scimError(set, 400, "Too many operations");
    const updates: ScimPayload = {};
    for (const rawOperation of operations) {
      if (rawOperation === null || typeof rawOperation !== "object") return scimError(set, 400, "Invalid PATCH operation");
      const operation = rawOperation as ScimPayload;
      const op = typeof operation["op"] === "string" ? operation["op"].toLowerCase() : "";
      const rawPath = typeof operation["path"] === "string" ? operation["path"] : "";
      const path = rawPath.toLowerCase();
      if (!["add", "replace", "remove"].includes(op)) return scimError(set, 400, "Unsupported PATCH operation");
      if (op === "remove") {
        if (path !== "externalid") return scimError(set, 400, "Only externalId can be removed");
        updates["externalId"] = null;
        continue;
      }
      if (path === "") {
        if (operation["value"] === null || typeof operation["value"] !== "object") return scimError(set, 400, "PATCH value must be an object");
        Object.assign(updates, operation["value"] as ScimPayload);
      } else if (["active", "username", "externalid", "emails"].includes(path)) {
        updates[path === "username" ? "userName" : path === "externalid" ? "externalId" : path] = operation["value"];
      } else return scimError(set, 400, "Unsupported PATCH path");
    }
    const currentUser = await db.query.users.findFirst({ where: eq(users.id, identity.userId) });
    if (currentUser === undefined) return scimError(set, 404, "User not found");
    const userName = typeof updates["userName"] === "string" && updates["userName"].trim() !== "" ? updates["userName"].trim() : currentUser.username;
    const email = updates["emails"] === undefined ? currentUser.email : scimEmail({ emails: updates["emails"] });
    if (updates["emails"] !== undefined && email === null) return scimError(set, 400, "emails cannot be cleared");
    const active = parseScimActive(updates);
    if (active === null) return scimError(set, 400, "active must be a boolean");
    const updatedAt = Date.now();
    try {
      await db.transaction(async (tx): Promise<void> => {
        await tx.update(users).set({
          username: userName,
          email,
          ...(email !== currentUser.email ? { emailVerifiedAt: null } : {}),
          ...(active !== undefined ? { isSuspended: !active } : {}),
        }).where(eq(users.id, currentUser.id));
        if (active === false) {
          await tx.delete(apiTokens).where(eq(apiTokens.userId, currentUser.id));
          await tx.update(refreshSessions).set({ revokedAt: Date.now() }).where(and(eq(refreshSessions.userId, currentUser.id), isNull(refreshSessions.revokedAt)));
        }
        await tx.update(scimUserIdentities).set({ username: userName, ...(updates["externalId"] !== undefined ? { externalId: typeof updates["externalId"] === "string" ? updates["externalId"] : null } : {}), updatedAt }).where(eq(scimUserIdentities.id, identity.id));
        await tx.update(identityLinks).set({ emailAtLinkTime: email }).where(and(
          eq(identityLinks.userId, currentUser.id),
          eq(identityLinks.provider, "scim"),
          eq(identityLinks.externalId, identity.id),
        ));
        await reconcileScimSiteAdmins(tx);
      });
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) throw error;
      return scimError(set, 409, "userName or email is already in use");
    }
    const updatedIdentity = await db.query.scimUserIdentities.findFirst({ where: eq(scimUserIdentities.id, identity.id) });
    const updatedUser = await db.query.users.findFirst({ where: eq(users.id, currentUser.id) });
    return updatedIdentity === undefined ? scimError(set, 500, "User identity was not updated") : scimUserResource(updatedIdentity, updatedUser);
  })

  // Groups
  .get("/scim/v2/Groups", async ({ request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const parsed = parseScimListQuery(request);
    if ("error" in parsed) return scimError(set, 400, parsed.error);
    const filterWhere = scimGroupWhere(parsed.filter);
    if (filterWhere !== undefined && "error" in filterWhere) return scimError(set, 400, filterWhere.error);
    const where = filterWhere;
    const groupRowsQuery = db.select().from(scimGroups);
    const groupCountQuery = db.select({ total: count() }).from(scimGroups);
    const [groupsList, countRows] = await Promise.all([
      (where === undefined ? groupRowsQuery : groupRowsQuery.where(where))
        .orderBy(asc(scimGroups.id))
        .limit(parsed.count)
        .offset(parsed.startIndex - 1),
      (where === undefined ? groupCountQuery : groupCountQuery.where(where)),
    ]);
    const resources = await scimGroupResources(groupsList);
    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: countRows[0]?.total ?? 0,
      startIndex: parsed.startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  })
  .post("/scim/v2/Groups", async ({ request, body, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const displayName = typeof payload["displayName"] === "string" ? payload["displayName"].trim() : "";
    if (displayName === "") return scimError(set, 400, "displayName is required");

    const id = `scimgroup-${crypto.randomUUID()}`;
    const memberIds = payload["members"] === undefined ? [] : scimMemberIds(payload["members"]);
    if (memberIds === null) return scimError(set, 400, "members must be an array of SCIM user identifiers");
    const createdAt = Date.now();
    await db.insert(scimGroups).values({ id, name: displayName, externalId: typeof payload["externalId"] === "string" ? payload["externalId"] : null, createdAt, updatedAt: createdAt });
    if (!(await replaceScimGroupMembers(id, memberIds))) {
      await db.delete(scimGroups).where(eq(scimGroups.id, id));
      return scimError(set, 404, "Referenced SCIM user not found");
    }
    await db.transaction(reconcileScimSiteAdmins);

    (set as { status: number }).status = 201;
    const group = await db.query.scimGroups.findFirst({ where: eq(scimGroups.id, id) });
    return group === undefined ? scimError(set, 500, "Group was not created") : scimGroupResource(group);
  })
  .get("/scim/v2/Groups/:id", async ({ params, request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const g = await db.query.scimGroups.findFirst({ where: eq(scimGroups.id, params["id"] ?? "") });
    if (!g) return scimError(set, 404, "Group not found");

    return scimGroupResource(g);
  })
  .delete("/scim/v2/Groups/:id", async ({ params, request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const g = await db.query.scimGroups.findFirst({ where: eq(scimGroups.id, params["id"] ?? "") });
    if (!g) { (set as { status: number }).status = 204; return {}; }
    const settings = await db.query.scimSettings.findFirst({ where: eq(scimSettings.id, "scim") });
    if (settings?.siteAdminGroupScimId === g.id) await db.update(scimSettings).set({ siteAdminGroupScimId: null, updatedAt: Date.now() }).where(eq(scimSettings.id, "scim"));
    await removeMappedTeamRows([g.id]);
    await db.delete(scimGroups).where(eq(scimGroups.id, g.id));
    await db.transaction(reconcileScimSiteAdmins);
    (set as { status: number }).status = 204;
    return {};
  })
  .put("/scim/v2/Groups/:id", async ({ params, body, request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const group = await db.query.scimGroups.findFirst({ where: eq(scimGroups.id, params["id"] ?? "") });
    if (group === undefined) return scimError(set, 404, "Group not found");
    const payload = body !== null && typeof body === "object" ? body as ScimPayload : {};
    const name = typeof payload["displayName"] === "string" && payload["displayName"].trim() !== "" ? payload["displayName"].trim() : group.name;
    const memberIds = payload["members"] === undefined ? undefined : scimMemberIds(payload["members"]);
    if (memberIds === null) return scimError(set, 400, "members must be an array of SCIM user identifiers");
    let missingMember = false;
    await db.transaction(async (tx): Promise<void> => {
      if (memberIds !== undefined && !(await replaceScimGroupMembers(group.id, memberIds, tx))) {
        missingMember = true;
        return;
      }
      if (memberIds !== undefined) await reconcileMappedTeams(group.id, tx);
      await reconcileScimSiteAdmins(tx);
      await tx.update(scimGroups).set({ name, ...(payload["externalId"] !== undefined ? { externalId: typeof payload["externalId"] === "string" ? payload["externalId"] : null } : {}), updatedAt: Date.now() }).where(eq(scimGroups.id, group.id));
    });
    if (missingMember) return scimError(set, 404, "Referenced SCIM user not found");
    const updated = await db.query.scimGroups.findFirst({ where: eq(scimGroups.id, group.id) });
    return updated === undefined ? scimError(set, 500, "Group was not updated") : scimGroupResource(updated);
  })
  .patch("/scim/v2/Groups/:id", async ({ params, body, request, set }: RequestCtx): Promise<unknown> => {
    if (!(await validateScimToken(request, set))) return scimError(set, 401, "Unauthorized");
    set.headers["Content-Type"] = "application/scim+json";
    const group = await db.query.scimGroups.findFirst({ where: eq(scimGroups.id, params["id"] ?? "") });
    if (group === undefined) return scimError(set, 404, "Group not found");
    const payload = body !== null && typeof body === "object" ? body as ScimPayload : {};
    const operations = Array.isArray(payload["Operations"]) ? payload["Operations"] : [];
    if (operations.length > 100) return scimError(set, 400, "Too many operations");
    let name = group.name;
    let externalId: string | null | undefined = undefined;
    let memberIds = (await db.query.scimGroupMemberships.findMany({ where: eq(scimGroupMemberships.groupId, group.id) })).map((membership): string => membership.scimUserId);
    let membersChanged = false;
    for (const rawOperation of operations) {
      if (rawOperation === null || typeof rawOperation !== "object") return scimError(set, 400, "Invalid PATCH operation");
      const operation = rawOperation as ScimPayload;
      const op = typeof operation["op"] === "string" ? operation["op"].toLowerCase() : "";
      const rawPath = typeof operation["path"] === "string" ? operation["path"] : "";
      const path = rawPath.toLowerCase();
      if (!["add", "replace", "remove"].includes(op)) return scimError(set, 400, "Unsupported PATCH operation");
      if (path === "" && operation["value"] !== null && typeof operation["value"] === "object") {
        const value = operation["value"] as ScimPayload;
        if (typeof value["displayName"] === "string" && value["displayName"].trim() !== "") name = value["displayName"].trim();
        if (value["externalId"] !== undefined) externalId = typeof value["externalId"] === "string" ? value["externalId"] : null;
        if (value["members"] !== undefined) {
          const ids = scimMemberIds(value["members"]);
          if (ids === null) return scimError(set, 400, "members must be an array of SCIM user identifiers");
          memberIds = ids;
          membersChanged = true;
        }
        continue;
      }
      if (path === "displayname") {
        if (op === "remove" || typeof operation["value"] !== "string" || operation["value"].trim() === "") return scimError(set, 400, "displayName is required");
        name = operation["value"].trim();
      } else if (path === "externalid") {
        externalId = op === "remove" ? null : typeof operation["value"] === "string" ? operation["value"] : null;
      } else if (path === "members") {
        const ids = scimMemberIds(operation["value"]);
        if (ids === null) return scimError(set, 400, "members must be an array of SCIM user identifiers");
        memberIds = op === "add" ? [...new Set([...memberIds, ...ids])] : op === "remove" ? memberIds.filter((id) => !new Set(ids).has(id)) : ids;
        membersChanged = true;
      } else if (op === "remove" && path.startsWith("members[")) {
        const match = /value\s+eq\s+['\"]([^'\"]+)['\"]/i.exec(rawPath);
        if (match !== null) {
          memberIds = memberIds.filter((id): boolean => id !== match[1]);
          membersChanged = true;
        }
        else return scimError(set, 400, "Invalid member filter");
      } else return scimError(set, 400, "Unsupported PATCH path");
    }
    let missingMember = false;
    await db.transaction(async (tx): Promise<void> => {
      if (membersChanged && !(await replaceScimGroupMembers(group.id, memberIds, tx))) {
        missingMember = true;
        return;
      }
      if (membersChanged) await reconcileMappedTeams(group.id, tx);
      await reconcileScimSiteAdmins(tx);
      await tx.update(scimGroups).set({ name, ...(externalId === undefined ? {} : { externalId }), updatedAt: Date.now() }).where(eq(scimGroups.id, group.id));
    });
    if (missingMember) return scimError(set, 404, "Referenced SCIM user not found");
    const updated = await db.query.scimGroups.findFirst({ where: eq(scimGroups.id, group.id) });
    return updated === undefined ? scimError(set, 500, "Group was not updated") : scimGroupResource(updated);
  });
