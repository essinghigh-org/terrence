import { Elysia } from "elysia";
import { db } from "../db";
import { teams, teamMemberships, teamWorkspaces, organizationMemberships, apiTokens, workspaces, users, scimGroups, scimSettings, teamScimGroupMappings, notificationConfigurations } from "../db/schema";
import { eq, and, count, inArray, asc, desc, or } from "drizzle-orm";
import { generateAuthenticationToken, hashAuthenticationToken } from "../lib/token-service";
import { TOKEN_DESCRIPTION_MAX_LENGTH } from "../lib/constants";
import { resolveTokenExpiryUnderPolicy } from "../lib/token-ttl-policy";

const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

import { auditLog, checkOrganizationPermission, checkOrgPermission, checkWorkspacePermission, pageRequest, pagination } from "../lib/utils";
import { authPlugin } from "../auth";
import { orgMembershipResource } from "../lib/response";
import { cachedOrgByName } from "../lib/cached-lookups";
import { currentTokenScopes } from "../lib/request-scope";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  request: Readonly<{ url: string }>;
  set: SetObj;
}>;

type TeamItem = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly visibility: string;
  readonly ssoTeamId: string | null;
  readonly organizationAccess: Readonly<Record<string, boolean>>;
  readonly allowMemberTokenManagement?: boolean | null;
  readonly policyOverrideDelegationExpiresAt?: number | null;
}>;

type TwItem = Readonly<{
  readonly id: string;
  readonly access: string;
  readonly permissions: unknown;
  readonly teamId: string;
  readonly workspaceId: string;
}>;

const organizationAccessKeys = [
  "manage-policies", "manage-policy-overrides", "delegate-policy-overrides", "manage-run-tasks",
  "manage-workspaces", "manage-vcs-settings", "manage-agent-pools", "manage-providers",
  "manage-modules", "manage-projects", "read-projects", "read-workspaces",
  "manage-membership", "manage-teams", "manage-organization-access",
  "access-secret-teams", "allow-member-token-management",
] as const;
// The the reference format team organization-access object also carries these string/non-list
// keys; they are stored on dedicated columns, not in the boolean JSON blob.
const organizationAccessStringKeys = new Set(["visibility", "sso-team-id"]);
const organizationAccessColumnKeys = new Set(["allow-member-token-management"]);

type TeamWorkspaceAccess = "read" | "plan" | "write" | "admin" | "custom";

const teamWorkspaceAccessLevels = new Set(["read", "plan", "write", "admin", "custom"]);
const teamWorkspacePermissionKeys = new Set([
  "runs", "variables", "state-versions", "sentinel-mocks", "workspace-locking", "run-tasks", "policy-overrides",
]);
const teamWorkspaceBooleanPermissionKeys = new Set(["workspace-locking", "run-tasks", "policy-overrides"]);
const teamWorkspaceStringPermissionValues: Readonly<Record<string, readonly string[]>> = {
  runs: ["read", "plan", "apply"],
  variables: ["none", "read", "write"],
  "state-versions": ["none", "read-outputs", "read", "write"],
  "sentinel-mocks": ["none", "read"],
};

type ParsedTeamWorkspaceGrant = Readonly<{
  access: TeamWorkspaceAccess;
  permissions: Record<string, unknown> | null;
  grantsPolicyOverrides: boolean;
}>;

function parseTeamWorkspaceGrant(accessInput: unknown, permissionsInput: unknown): Readonly<{ value: ParsedTeamWorkspaceGrant }> | Readonly<{ error: string }> {
  if (typeof accessInput !== "string" || !teamWorkspaceAccessLevels.has(accessInput)) return { error: "Invalid access level" };
  if (permissionsInput === undefined || permissionsInput === null) {
    return { value: { access: accessInput as TeamWorkspaceAccess, permissions: null, grantsPolicyOverrides: false } };
  }
  if (typeof permissionsInput !== "object" || Array.isArray(permissionsInput)) return { error: "permissions must be an object or null" };

  const permissions = permissionsInput as Record<string, unknown>;
  for (const [key, value] of Object.entries(permissions)) {
    if (!teamWorkspacePermissionKeys.has(key)) return { error: `permissions.${key} is not supported` };
    if (teamWorkspaceBooleanPermissionKeys.has(key)) {
      if (typeof value !== "boolean") return { error: `permissions.${key} must be a boolean` };
      continue;
    }
    const allowedValues = teamWorkspaceStringPermissionValues[key];
    if (allowedValues === undefined || typeof value !== "string" || !allowedValues.includes(value)) {
      return { error: `permissions.${key} has an invalid value` };
    }
  }

  return {
    value: {
      access: accessInput as TeamWorkspaceAccess,
      permissions,
      grantsPolicyOverrides: accessInput === "custom" && permissions["policy-overrides"] === true,
    },
  };
}

function parseOrganizationAccess(input: unknown): Readonly<{ value: Record<string, boolean> }> | Readonly<{ error: string }> {
  if (input === undefined) return { value: {} };
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { error: "organization-access must be an object" };
  const entries = Object.entries(input as Record<string, unknown>);
  const booleans: Record<string, boolean> = {};
  for (const [key, value] of entries) {
    if (!organizationAccessKeys.includes(key as typeof organizationAccessKeys[number]) && !organizationAccessStringKeys.has(key) && !organizationAccessColumnKeys.has(key)) {
      return { error: "organization-access contains an unknown permission" };
    }
    if (organizationAccessStringKeys.has(key)) {
      if (value !== null && typeof value !== "string") return { error: `organization-access.${key} must be a string or null` };
    } else if (organizationAccessColumnKeys.has(key)) {
      if (typeof value !== "boolean") return { error: `organization-access.${key} must be a boolean` };
    } else {
      if (typeof value !== "boolean") return { error: "organization-access contains a non-boolean permission" };
      booleans[key] = value;
    }
  }
  return { value: booleans };
}

function organizationAccessResource(team: TeamItem): Record<string, boolean | string | null> {
  const boolDefaults = Object.fromEntries(organizationAccessKeys.map((key): [string, boolean] => [key, false]));
  return {
    ...boolDefaults,
    ...team.organizationAccess,
    visibility: team.visibility,
    "sso-team-id": team.ssoTeamId,
    "allow-member-token-management": team.allowMemberTokenManagement === true,
  };
}

async function resolveUserIds(rawIds: string[]): Promise<string[]> {
  if (rawIds.length === 0) return [];
  const userList = await db.query.users.findMany({
    where: or(inArray(users.id, rawIds), inArray(users.username, rawIds)),
  });
  const byId = new Map(userList.map((u: Readonly<{ readonly id: string; readonly username: string }>): [string, string] => [u.id, u.id]));
  const byUsername = new Map(userList.map((u: Readonly<{ readonly username: string; readonly id: string }>): [string, string] => [u.username, u.id]));
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const rawId of rawIds) {
    const userId = byId.get(rawId) ?? byUsername.get(rawId);
    if (userId !== undefined && !seen.has(userId)) {
      seen.add(userId);
      resolved.push(userId);
    }
  }
  return resolved;
}

type TeamLinkage = {
  users?: { id: string; type: string }[];
  organizationMemberships?: { id: string; type: string }[];
};

type TeamScim = {
  enabled: boolean;
  mapping: Readonly<{ scimGroupId: string; syncPaused: boolean; updatedAt: number }> | undefined;
  groupName: string | null;
};

type TeamPermissions = Readonly<{ canUpdate: boolean; canDestroy: boolean }>;

async function teamResource(
  team: TeamItem,
  userCount: number,
  linkage?: TeamLinkage,
  scim?: TeamScim,
  permissions: TeamPermissions = { canUpdate: false, canDestroy: false },
): Promise<Record<string, unknown>> {
  return {
    id: team.id,
    type: "teams",
    attributes: {
      name: team.name,
      description: team.description,
      visibility: team.visibility,
      "sso-team-id": team.ssoTeamId,
      "organization-access": organizationAccessResource(team),
      "allow-member-token-management": team.allowMemberTokenManagement === true,
      "policy-override-delegation-expires-at": team.policyOverrideDelegationExpiresAt ?? null,
      "users-count": userCount,
      permissions: { "can-update": permissions.canUpdate, "can-destroy": permissions.canDestroy },
      ...(scim?.enabled === true ? {
        "scim-linked": scim.mapping !== undefined,
        "scim-group-name": scim.groupName ?? null,
        "scim-updated-at": scim.mapping === undefined ? null : new Date(scim.mapping.updatedAt).toISOString(),
        "scim-sync-paused": scim.mapping?.syncPaused ?? false,
      } : {}),
    },
    relationships: {
      ...(linkage?.users !== undefined ? { users: { data: linkage.users } } : {}),
      ...(linkage?.organizationMemberships !== undefined ? { "organization-memberships": { data: linkage.organizationMemberships } } : {}),
      "authentication-token": { meta: {} },
    },
    links: { self: `/api/v2/teams/${team.id}` },
  };
}

async function teamScim(teamId: string, enabled: boolean): Promise<TeamScim | undefined> {
  if (!enabled) return undefined;
  const mapping = await db.query.teamScimGroupMappings.findFirst({ where: eq(teamScimGroupMappings.teamId, teamId) });
  const group = mapping === undefined
    ? undefined
    : await db.query.scimGroups.findFirst({ where: eq(scimGroups.id, mapping.scimGroupId) });
  return { enabled: true, mapping: mapping === undefined ? undefined : { scimGroupId: mapping.scimGroupId, syncPaused: mapping.syncPaused ?? false, updatedAt: mapping.updatedAt }, groupName: group?.name ?? null };
}

async function scimLinked(teamId: string): Promise<boolean> {
  const settings = await db.query.scimSettings.findFirst({ where: eq(scimSettings.id, "scim") });
  if (settings?.enabled !== true) return false;
  return (await db.query.teamScimGroupMappings.findFirst({
    where: eq(teamScimGroupMappings.teamId, teamId),
    columns: { teamId: true },
  })) !== undefined;
}

export const teamRoutes = new Elysia({ name: "teams" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/team-tokens", async ({ params, request, query, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const org = await cachedOrgByName(params["org_name"] ?? "");
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const search = typeof query?.["q"] === "string" ? query["q"].toLowerCase() : new URL(request.url).searchParams.get("q")?.toLowerCase() ?? "";
    const matchingTeams = await db.query.teams.findMany({
      where: eq(teams.orgId, org.id),
      columns: { id: true, name: true },
    });
    const teamIds = matchingTeams
      .filter((team): boolean => search === "" || team.name.toLowerCase().includes(search))
      .map((team): string => team.id);
    const { number, size } = pageRequest(request);
    if (teamIds.length === 0) return { data: [], ...pagination(request, number, size, 0) };
    const tokenWhere = inArray(apiTokens.teamId, teamIds);
    const [page, countRows] = await Promise.all([
      db.query.apiTokens.findMany({ where: tokenWhere, orderBy: [asc(apiTokens.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(apiTokens).where(tokenWhere),
    ]);
    const total = countRows[0]?.total ?? 0;
    return {
      data: page.map((token): Record<string, unknown> => ({
        id: token.id,
        type: "authentication-tokens",
        attributes: {
          description: token.description,
          "created-at": new Date(token.createdAt).toISOString(),
          "last-used-at": token.lastUsedAt === null ? null : new Date(token.lastUsedAt).toISOString(),
          "expired-at": token.expiresAt === null ? null : new Date(token.expiresAt).toISOString(),
        },
        relationships: {
          team: { data: token.teamId === null ? null : { id: token.teamId, type: "teams" } },
          "created-by": { data: token.userId === null ? null : { id: token.userId, type: "users" } },
        },
      })),
      ...pagination(request, number, size, total),
    };
  })
  .get("/api/v2/organizations/:org_name/teams", async ({ params, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId, tokenTeamId ?? null, "teams:read"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    // Roster (member identifiers) is membership data: only include it when the
    // token also grants members:read.
    const [canReadMembers, canManageTeams] = await Promise.all([
      checkOrgPermission(user?.id, org.id, "member", tokenOrgId, tokenTeamId ?? null, "members:read"),
      checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"),
    ]);
    const { number, size } = pageRequest(request);
    const callerUserId = user?.id ?? null;
    const callerIsOwner = callerUserId !== null && (await db.query.organizationMemberships.findFirst({ where: and(eq(organizationMemberships.orgId, org.id), eq(organizationMemberships.userId, callerUserId), eq(organizationMemberships.role, "owner"), eq(organizationMemberships.status, "active")) })) !== undefined;
    const callerIsSiteAdmin = user?.isSiteAdmin === true;
    // A team token identifies one team; it is not an organization-wide secret
    // roster token. Keep its visibility limited to public teams plus itself.
    let callerTeamIds: Set<string> | null = tokenTeamId === null ? null : new Set([tokenTeamId]);
    let callerCanSeeSecret = callerIsOwner || callerIsSiteAdmin || (tokenOrgId !== null && tokenOrgId === org.id);
    if (callerUserId !== null) {
      const rows = await db.query.teamMemberships.findMany({ where: eq(teamMemberships.userId, callerUserId), columns: { teamId: true } });
      const memberTeamIds = rows.map((r: { teamId: string }): string => r.teamId);
      const callerTeams = memberTeamIds.length === 0
        ? []
        : await db.query.teams.findMany({ where: and(eq(teams.orgId, org.id), inArray(teams.id, memberTeamIds)), columns: { id: true, organizationAccess: true } });
      callerTeamIds = new Set(callerTeams.map((tm): string => tm.id));
      if (!callerCanSeeSecret) {
        callerCanSeeSecret = callerTeams.some((tm): boolean => (tm.organizationAccess as Record<string, unknown> | undefined)?.["access-secret-teams"] === true);
      }
    }
    const visibleTeamWhere = callerCanSeeSecret
      ? eq(teams.orgId, org.id)
      : callerTeamIds !== null && callerTeamIds.size > 0
        ? and(eq(teams.orgId, org.id), or(eq(teams.visibility, "organization"), inArray(teams.id, [...callerTeamIds])))!
        : and(eq(teams.orgId, org.id), eq(teams.visibility, "organization"))!;
    const [teamList, countRows] = await Promise.all([
      db.query.teams.findMany({ where: visibleTeamWhere, orderBy: [asc(teams.id)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(teams).where(visibleTeamWhere),
    ]);
    const teamIds = teamList.map((t: TeamItem): string => t.id);
    const scimEnabled = (await db.query.scimSettings.findFirst({ where: eq(scimSettings.id, "scim") }))?.enabled === true;
    const [membershipRows, mappingRows] = teamIds.length === 0
      ? [[], []]
      : await Promise.all([
        db.query.teamMemberships.findMany({ where: inArray(teamMemberships.teamId, teamIds), columns: { teamId: true, userId: true } }),
        scimEnabled ? db.query.teamScimGroupMappings.findMany({ where: inArray(teamScimGroupMappings.teamId, teamIds) }) : [],
      ]);
    const groupIds = [...new Set(mappingRows.map((m: Readonly<{ readonly scimGroupId: string }>): string => m.scimGroupId))];
    const groupRows = groupIds.length === 0 ? [] : await db.query.scimGroups.findMany({ where: inArray(scimGroups.id, groupIds) });
    const groupById = new Map(groupRows.map((g: Readonly<{ readonly id: string; readonly name: string | null }>): [string, string | null] => [g.id, g.name]));
    const membersByTeam = new Map<string, { id: string; type: string }[]>();
    for (const m of membershipRows) {
      const refs = membersByTeam.get(m.teamId) ?? [];
      refs.push({ id: m.userId, type: "users" });
      membersByTeam.set(m.teamId, refs);
    }
    const mappingByTeam = new Map(mappingRows.map((m: Readonly<{ readonly teamId: string; readonly scimGroupId: string; readonly syncPaused: boolean | null; readonly updatedAt: number }>): [string, Readonly<{ scimGroupId: string; syncPaused: boolean; updatedAt: number }>] => [m.teamId, { scimGroupId: m.scimGroupId, syncPaused: m.syncPaused ?? false, updatedAt: m.updatedAt }]));
    const data = teamList.map(async (t: TeamItem): Promise<Record<string, unknown>> => {
      const userRefs = canReadMembers ? (membersByTeam.get(t.id) ?? []) : [];
      const mapping = mappingByTeam.get(t.id);
      const scim = scimEnabled
        ? { enabled: true, mapping, groupName: mapping === undefined ? null : groupById.get(mapping.scimGroupId) ?? null }
        : undefined;
      return teamResource(t, userRefs.length, { users: userRefs }, scim, { canUpdate: canManageTeams, canDestroy: canManageTeams });
    });
    const totalCount = countRows[0]?.total ?? 0;
    return { data: await Promise.all(data), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/organizations/:org_name/teams", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attributes = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const name = typeof attributes["name"] === "string" ? attributes["name"] : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    const id = `team-${crypto.randomUUID()}`;
    const rawOrgAccess = attributes["organization-access"] !== undefined && typeof attributes["organization-access"] === "object" && attributes["organization-access"] !== null
      ? attributes["organization-access"] as Record<string, unknown>
      : {};
    const description = typeof attributes["description"] === "string" ? attributes["description"] : null;
    const visibility = typeof attributes["visibility"] === "string" ? attributes["visibility"] : (typeof rawOrgAccess["visibility"] === "string" ? rawOrgAccess["visibility"] : "organization");
    const ssoTeamId = typeof attributes["sso-team-id"] === "string" ? attributes["sso-team-id"] : (typeof rawOrgAccess["sso-team-id"] === "string" ? rawOrgAccess["sso-team-id"] : null);
    const allowMemberTokenManagement = typeof rawOrgAccess["allow-member-token-management"] === "boolean" ? rawOrgAccess["allow-member-token-management"] : false;
    const organizationAccess = parseOrganizationAccess(rawOrgAccess);
    if ("error" in organizationAccess) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: organizationAccess.error }] }; }
    if (
      attributes["organization-access"] !== undefined
      && !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-organization-access"))
    ) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const newTeam = { id, orgId: org.id, name, description, visibility, ssoTeamId, allowMemberTokenManagement, organizationAccess: organizationAccess.value, createdAt: Date.now() };
    await db.transaction(async (tx: unknown): Promise<void> => {
      const t = tx as typeof db;
      await t.insert(teams).values(newTeam);
      await t.insert(notificationConfigurations).values({
        id: `nc-${crypto.randomUUID()}`,
        teamId: id,
        workspaceId: null,
        projectId: null,
        name: "Default email notification",
        destinationType: "email",
        url: "",
        emailAddresses: [],
        emailAllMembers: true,
        emailUserIds: [],
        triggers: [],
        enabled: false,
        token: null,
        createdAt: Date.now(),
      });
    });
    (set as { status: number }).status = 201;
    return { data: await teamResource(newTeam, 0, { users: [] }, undefined, { canUpdate: true, canDestroy: true }) };
  })
  .get("/api/v2/teams/:team_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, query, set }: ParamCtx): Promise<unknown> => {
    const teamId = params["team_id"] ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId, tokenTeamId ?? null, "teams:read"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userCount = (await db.select({ val: count() }).from(teamMemberships).where(eq(teamMemberships.teamId, team.id)))[0]?.val ?? 0;
    const includeQuery = query !== undefined ? query["include"] : undefined;
    const includes = typeof includeQuery === "string" ? includeQuery.split(",") : [];
    // Membership data (usernames/emails, membership refs, and the exact team
    // size) requires members:read.
    const [canReadMembers, canManageTeams] = await Promise.all([
      checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId, tokenTeamId ?? null, "members:read"),
      checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"),
    ]);
    const permissions: TeamPermissions = { canUpdate: canManageTeams, canDestroy: canManageTeams };
    const rosterCount = canReadMembers ? userCount : 0;
    const includeUsers = canReadMembers && includes.includes("users");
    const includeOrgMemberships = canReadMembers && includes.includes("organization-memberships");
    let included: Record<string, unknown>[] = [];
    const members = await db.query.teamMemberships.findMany({ where: eq(teamMemberships.teamId, team.id) });
    const userIds = members.map((m: Readonly<{ readonly userId: string }>): string => m.userId);
    const scim = await teamScim(team.id, (await db.query.scimSettings.findFirst({ where: eq(scimSettings.id, "scim") }))?.enabled === true);
    if (includeUsers && userIds.length > 0) {
      const uList = await db.query.users.findMany({ where: inArray(users.id, userIds) });
      included = uList.map((u: Readonly<{ readonly id: string; readonly username: string; readonly email: string | null }>): Record<string, unknown> => ({ id: u.id, type: "users", attributes: { username: u.username, email: u.email } }));
    }
    if (includeOrgMemberships && userIds.length > 0) {
      const memList = (await db.query.organizationMemberships.findMany({ where: inArray(organizationMemberships.userId, userIds) }))
        .filter((m): boolean => m.orgId === team.orgId);
      const uMap = new Map((await db.query.users.findMany({ where: inArray(users.id, userIds) })).map((u): [string, typeof u] => [u.id, u]));
      included = included.concat(await Promise.all(memList.map(async (m): Promise<Record<string, unknown>> => orgMembershipResource(m, uMap.get(m.userId) ?? null))));
      const linkage: TeamLinkage = {
        users: members.map((m): { id: string; type: string } => ({ id: m.userId, type: "users" })),
        organizationMemberships: memList.map((m): { id: string; type: string } => ({ id: m.id, type: "organization-memberships" })),
      };
      return { data: await teamResource(team, rosterCount, linkage, scim, permissions), ...(included.length > 0 ? { included } : {}) };
    }
    if (includeUsers) {
      const linkage: TeamLinkage = { users: members.map((m): { id: string; type: string } => ({ id: m.userId, type: "users" })) };
      return { data: await teamResource(team, rosterCount, linkage, scim, permissions), ...(included.length > 0 ? { included } : {}) };
    }
    return { data: await teamResource(team, rosterCount, undefined, scim, permissions), ...(included.length > 0 ? { included } : {}) };
  })
  .patch("/api/v2/teams/:team_id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const teamId = params["team_id"] ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attributes = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const updates: Partial<typeof teams.$inferInsert> = {};
    const linked = await scimLinked(teamId);
    if (linked && typeof attributes["name"] === "string" && attributes["name"] !== team.name) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "SCIM-linked teams cannot be renamed" }] };
    }
    if (typeof attributes["name"] === "string") updates.name = attributes["name"];
    if (attributes["description"] !== undefined) updates.description = typeof attributes["description"] === "string" ? attributes["description"] : null;
    if (typeof attributes["visibility"] === "string") updates.visibility = attributes["visibility"];
    if (!linked && attributes["sso-team-id"] !== undefined) updates.ssoTeamId = typeof attributes["sso-team-id"] === "string" ? attributes["sso-team-id"] : null;
    if (attributes["organization-access"] !== undefined) {
      if (!(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-organization-access"))) {
        (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
      }
      const rawOrgAccess = attributes["organization-access"] as Record<string, unknown> | null;
      const organizationAccess = parseOrganizationAccess(rawOrgAccess);
      if ("error" in organizationAccess) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: organizationAccess.error }] }; }
      updates.organizationAccess = { ...team.organizationAccess, ...organizationAccess.value };
      // The provider carries visibility / sso-team-id / allow-member-token-management
      // inside organization-access, but the top-level attribute takes precedence
      // when present (matching the create handler), and sso-team-id is gated by
      // the linked-team guard. Column-backed keys are persisted to their columns.
      if (attributes["visibility"] === undefined && typeof rawOrgAccess?.["visibility"] === "string") updates.visibility = rawOrgAccess["visibility"];
      if (!linked && attributes["sso-team-id"] === undefined && rawOrgAccess?.["sso-team-id"] !== undefined) updates.ssoTeamId = typeof rawOrgAccess["sso-team-id"] === "string" ? rawOrgAccess["sso-team-id"] : null;
      if (rawOrgAccess?.["allow-member-token-management"] !== undefined) updates.allowMemberTokenManagement = typeof rawOrgAccess["allow-member-token-management"] === "boolean" ? rawOrgAccess["allow-member-token-management"] : false;
    }
    // Time-bounded policy-override delegation (kanban 18.7): epoch-millis
    // expiry (or null/0 to clear and return to a permanent grant). Requires
    // manage-organization-access, same as the delegation grant itself.
    if (attributes["policy-override-delegation-expires-at"] !== undefined) {
      if (!(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-organization-access"))) {
        (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
      }
      const rawExpiry = attributes["policy-override-delegation-expires-at"];
      if (rawExpiry === null) {
        updates.policyOverrideDelegationExpiresAt = null;
      } else if (typeof rawExpiry === "number" && Number.isFinite(rawExpiry)) {
        if (rawExpiry <= 0) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "policy-override-delegation-expires-at must be a future epoch-millis timestamp, or null" }] }; }
        updates.policyOverrideDelegationExpiresAt = Math.floor(rawExpiry);
      } else {
        (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "policy-override-delegation-expires-at must be a number or null" }] };
      }
    }
    if (Object.keys(updates).length > 0) await db.update(teams).set(updates).where(eq(teams.id, teamId));
    const updated = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userCount = (await db.select({ val: count() }).from(teamMemberships).where(eq(teamMemberships.teamId, teamId)))[0]?.val ?? 0;
    const [memberRefs, scim] = await Promise.all([
      db.query.teamMemberships.findMany({ where: eq(teamMemberships.teamId, teamId), columns: { userId: true } }),
      teamScim(teamId, (await db.query.scimSettings.findFirst({ where: eq(scimSettings.id, "scim") }))?.enabled === true),
    ]);
    return { data: await teamResource(updated, userCount, { users: memberRefs.map((m): { id: string; type: string } => ({ id: m.userId, type: "users" })) }, scim, { canUpdate: true, canDestroy: true }) };
  })
  .delete("/api/v2/teams/:team_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const teamId = params["team_id"] ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (await scimLinked(teamId)) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(apiTokens).where(eq(apiTokens.teamId, teamId));
    await db.delete(teamMemberships).where(eq(teamMemberships.teamId, teamId));
    await db.delete(teamWorkspaces).where(eq(teamWorkspaces.teamId, teamId));
    await db.delete(teams).where(eq(teams.id, teamId));
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/teams/:team_id/relationships/users", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const teamId = params["team_id"] ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (user?.isSiteAdmin !== true && (await scimLinked(teamId))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const userItems = payload["data"];
    if (Array.isArray(userItems)) {
      const batch: (typeof teamMemberships.$inferInsert)[] = [];
      // the reference format's Atlas convention lets `data[].id` be either a user UUID or a
      // username; the go-tfe v2 client sends usernames.
      const rawIds = userItems
        .map((item): string => (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>)["id"] === "string") ? (item as Record<string, unknown>)["id"] as string : "")
        .filter((s: string): boolean => s !== "");
      const userIds = await resolveUserIds(rawIds);
      const memberships = userIds.length === 0
        ? new Map<string, typeof organizationMemberships.$inferSelect>()
        : new Map(
            (await db.query.organizationMemberships.findMany({
              where: and(eq(organizationMemberships.orgId, team.orgId), inArray(organizationMemberships.userId, userIds)),
            })).map((m): [string, typeof organizationMemberships.$inferSelect] => [m.userId, m]),
          );
      for (const userId of userIds) {
        const membership = memberships.get(userId);
        if (membership?.status === "active") {
          batch.push({ id: `tm-${crypto.randomUUID()}`, teamId, userId, createdAt: Date.now() });
        }
      }
      if (batch.length > 0) await db.insert(teamMemberships).values(batch).onConflictDoNothing();
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/teams/:team_id/relationships/users", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const teamId = params["team_id"] ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (user?.isSiteAdmin !== true && (await scimLinked(teamId))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const userItems = payload["data"];
    if (Array.isArray(userItems)) {
      const rawIds = userItems.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>)["id"] === "string") ? (i as Record<string, unknown>)["id"] as string : "").filter((s: string): boolean => s !== "");
      const userIds = await resolveUserIds(rawIds);
      if (userIds.length > 0) await db.delete(teamMemberships).where(and(eq(teamMemberships.teamId, teamId), inArray(teamMemberships.userId, userIds)));
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/teams/:team_id/relationships/organization-memberships", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const teamId = params["team_id"] ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (user?.isSiteAdmin !== true && (await scimLinked(teamId))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload["data"];
    if (Array.isArray(items)) {
      const memIds = items
        .map((item): string => (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>)["id"] === "string") ? (item as Record<string, unknown>)["id"] as string : "")
        .filter((s: string): boolean => s !== "");
      const memberships = memIds.length === 0
        ? new Map<string, typeof organizationMemberships.$inferSelect>()
        : new Map(
            (await db.query.organizationMemberships.findMany({
              where: inArray(organizationMemberships.id, memIds),
            })).map((m): [string, typeof organizationMemberships.$inferSelect] => [m.id, m]),
          );
      const batch: (typeof teamMemberships.$inferInsert)[] = [];
      for (const memId of memIds) {
        const mem = memberships.get(memId);
        if (mem?.orgId === team.orgId) {
          batch.push({ id: `tm-${crypto.randomUUID()}`, teamId, userId: mem.userId, createdAt: Date.now() });
        }
      }
      if (batch.length > 0) await db.insert(teamMemberships).values(batch).onConflictDoNothing();
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/teams/:team_id/relationships/organization-memberships", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const teamId = params["team_id"] ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (user?.isSiteAdmin !== true && (await scimLinked(teamId))) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload["data"];
    if (Array.isArray(items)) {
      const memIds = items
        .map((item): string => (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>)["id"] === "string") ? (item as Record<string, unknown>)["id"] as string : "")
        .filter((s: string): boolean => s !== "");
      if (memIds.length > 0) {
        const memberships = await db.query.organizationMemberships.findMany({ where: inArray(organizationMemberships.id, memIds) });
        const userIds = memberships.filter((m): boolean => m.orgId === team.orgId).map((m): string => m.userId);
        if (userIds.length > 0) await db.delete(teamMemberships).where(and(eq(teamMemberships.teamId, teamId), inArray(teamMemberships.userId, userIds)));
      }
    }
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Team Auth Tokens ---
  // TFE parity: the singular legacy endpoints manage ONLY the team's single
  // legacy credential; the plural authentication-tokens endpoints manage
  // modern tokens. Neither may clobber the other (regression-tested).
  .post("/api/v2/teams/:team_id/authentication-token", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    if (currentTokenScopes() !== null) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: "Fine-grained tokens cannot mint unscoped team tokens" }] };
    }
    const teamId = params["team_id"] ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const rawToken = generateAuthenticationToken("team-tok");
    const id = `tok-${crypto.randomUUID()}`;
    const tokenHash = hashAuthenticationToken(rawToken);
    // The org TTL policy governs the legacy team token too (todo 72-74):
    // a zero-TTL policy forbids rotation, otherwise no expiry is imposed
    // (legacy tokens predate the two-year default).
    const legacyPolicy = await resolveTokenExpiryUnderPolicy(team.orgId, "team-legacy", null);
    if (legacyPolicy.kind === "forbidden") {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: legacyPolicy.detail }] };
    }
    await db.transaction(async (tx: unknown): Promise<void> => {
      const t = tx as typeof db;
      // Replace only the legacy token; modern plural tokens must survive.
      await t.delete(apiTokens).where(and(eq(apiTokens.teamId, teamId), eq(apiTokens.legacy, true)));
      await t.insert(apiTokens).values({ id, token: tokenHash, teamId, orgId: team.orgId, description: `Team token for ${team.name}`, scopes: null, legacy: true, createdAt: Date.now() });
    });
    await auditLog("create", "team-authentication-token", id, user?.id ?? null, team.orgId, { teamId, legacy: true });
    (set as { status: number }).status = 201;
    return { data: { id, type: "authentication-tokens", attributes: { token: rawToken, "created-at": new Date().toISOString() } } };
  })
  .get("/api/v2/teams/:team_id/authentication-token", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const teamId = params["team_id"] ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tok = await db.query.apiTokens.findFirst({ where: and(eq(apiTokens.teamId, teamId), eq(apiTokens.legacy, true)) });
    if (tok === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: tok.id, type: "authentication-tokens", attributes: { "created-at": new Date(tok.createdAt).toISOString() } } };
  })
  .delete("/api/v2/teams/:team_id/authentication-token", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const teamId = params["team_id"] ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const deleted = await db.delete(apiTokens).where(and(eq(apiTokens.teamId, teamId), eq(apiTokens.legacy, true))).returning({ id: apiTokens.id });
    const deletedId = deleted[0]?.id;
    if (deletedId !== undefined) await auditLog("delete", "team-authentication-token", deletedId, user?.id ?? null, team.orgId, { teamId, legacy: true });
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/teams/:team_id/authentication-tokens", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    if (currentTokenScopes() !== null) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: "Fine-grained tokens cannot mint unscoped team tokens" }] };
    }
    const teamId = params["team_id"] ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const secret = generateAuthenticationToken("team");
    const tokenId = `tok-${crypto.randomUUID()}`;
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attrs = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    // TFE parity: modern team tokens require an explicit description and
    // default to a two-year expiration when none is supplied. The org TTL
    // policy caps or forbids the result (todo 72-74).
    const description = typeof attrs["description"] === "string" ? attrs["description"].trim() : "";
    if (description === "" || description.length > TOKEN_DESCRIPTION_MAX_LENGTH) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: `Description is required for team tokens and must be at most ${TOKEN_DESCRIPTION_MAX_LENGTH} characters` }] };
    }
    const expiredAtVal = attrs["expired-at"] ?? attrs["expires-at"] ?? attrs["expiredAt"] ?? attrs["expiresAt"];
    const expiredAtStr = typeof expiredAtVal === "string" ? expiredAtVal : "";
    let requestedExpiry: number;
    if (expiredAtStr === "") {
      requestedExpiry = Date.now() + TWO_YEARS_MS;
    } else {
      const parsed = new Date(expiredAtStr);
      const parsedMs = parsed.getTime();
      if (Number.isNaN(parsedMs)) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "expired-at must be a valid ISO-8601 date" }] };
      }
      if (parsedMs <= Date.now()) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "expired-at must be in the future" }] };
      }
      requestedExpiry = parsedMs;
    }
    const policyResolution = await resolveTokenExpiryUnderPolicy(team.orgId, "team", requestedExpiry);
    if (policyResolution.kind === "invalid") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: policyResolution.detail }] };
    }
    if (policyResolution.kind === "forbidden") {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: policyResolution.detail }] };
    }
    const expiresAt = policyResolution.expiresAt;
    // TFE parity: descriptions must be unique among a team's modern tokens.
    const duplicate = await db.query.apiTokens.findFirst({ where: and(eq(apiTokens.teamId, teamId), eq(apiTokens.legacy, false), eq(apiTokens.description, description)), columns: { id: true } });
    if (duplicate !== undefined) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "A team token with this description already exists" }] };
    }
    const tokenHash = hashAuthenticationToken(secret);
    await db.insert(apiTokens).values({ id: tokenId, token: tokenHash, orgId: team.orgId, teamId: team.id, description, createdAt: Date.now(), expiresAt, legacy: false });
    await auditLog("create", "team-authentication-token", tokenId, user?.id ?? null, team.orgId, { teamId, description });
    (set as { status: number }).status = 201;
    return { data: { id: tokenId, type: "authentication-tokens", attributes: { token: secret, description, "created-at": new Date().toISOString(), "expired-at": expiresAt !== null ? new Date(expiresAt).toISOString() : null } } };
  })
  .get("/api/v2/teams/:team_id/authentication-tokens", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const teamId = params["team_id"] ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    // Modern tokens only: the legacy credential is exposed via the singular
    // endpoint. Deterministic newest-first order (TFE parity).
    const tokenList = await db.query.apiTokens.findMany({
      where: and(eq(apiTokens.teamId, teamId), eq(apiTokens.legacy, false)),
      orderBy: [desc(apiTokens.createdAt), desc(apiTokens.id)],
    });
    return { data: tokenList.map((t): Record<string, unknown> => ({ id: t.id, type: "authentication-tokens", attributes: { description: t.description, "created-at": new Date(t.createdAt).toISOString(), "last-used-at": t.lastUsedAt !== null ? new Date(t.lastUsedAt).toISOString() : null, "expired-at": t.expiresAt !== null ? new Date(t.expiresAt).toISOString() : null } })) };
  })
  .delete("/api/v2/teams/:team_id/authentication-tokens/:token_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const teamId = params["team_id"] ?? "";
    const tokenId = params["token_id"] ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    // Removing a modern token must never disturb the legacy credential.
    const deleted = await db.delete(apiTokens).where(and(eq(apiTokens.id, tokenId), eq(apiTokens.teamId, teamId), eq(apiTokens.legacy, false))).returning({ id: apiTokens.id });
    if (deleted.length > 0) await auditLog("delete", "team-authentication-token", tokenId, user?.id ?? null, team.orgId, { teamId });
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Team Workspaces ---
  .get("/api/v2/team-workspaces", async ({ query, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const filterWorkspace = query !== undefined ? query["filter[workspace][id]"] : undefined;
    const workspaceId = typeof filterWorkspace === "string" ? filterWorkspace : "";
    if (workspaceId === "") return { data: [] };
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, tokenOrgId, tokenTeamId ?? null, "admin"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const twList = await db.query.teamWorkspaces.findMany({ where: eq(teamWorkspaces.workspaceId, workspaceId) });
    return { data: twList.map((tw: TwItem): Record<string, unknown> => ({ id: tw.id, type: "team-workspaces", attributes: { access: tw.access, permissions: tw.permissions ?? { runs: "write", variables: "write", "state-versions": "write" } }, relationships: { team: { data: { id: tw.teamId, type: "teams" } }, workspace: { data: { id: tw.workspaceId, type: "workspaces" } } } })) };
  })
  .post("/api/v2/team-workspaces", async ({ body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const rels = typeof data?.["relationships"] === "object" && data["relationships"] !== null ? (data["relationships"] as Record<string, unknown>) : {};
    const teamRel = typeof rels["team"] === "object" && rels["team"] !== null ? (rels["team"] as Record<string, unknown>) : {};
    const teamData = typeof teamRel["data"] === "object" && teamRel["data"] !== null ? (teamRel["data"] as Record<string, unknown>) : {};
    const wsRel = typeof rels["workspace"] === "object" && rels["workspace"] !== null ? (rels["workspace"] as Record<string, unknown>) : {};
    const wsData = typeof wsRel["data"] === "object" && wsRel["data"] !== null ? (wsRel["data"] as Record<string, unknown>) : {};
    const attrs = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const teamId = typeof teamData["id"] === "string" ? teamData["id"] : "";
    const workspaceId = typeof wsData["id"] === "string" ? wsData["id"] : "";
    const accessInput = attrs["access"] === undefined ? "write" : attrs["access"];
    const grant = parseTeamWorkspaceGrant(accessInput, attrs["permissions"]);
    if ("error" in grant) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: grant.error }] }; }
    const { access, permissions } = grant.value;
    if (teamId === "" || workspaceId === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const [ws, targetTeam] = await Promise.all([
      db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) }),
      db.query.teams.findFirst({ where: eq(teams.id, teamId) }),
    ]);
    if (
      ws === undefined
      || targetTeam?.orgId !== ws.orgId
      || !(await checkWorkspacePermission(ws, user?.id, tokenOrgId, tokenTeamId ?? null, "admin"))
    ) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (
      grant.value.grantsPolicyOverrides
      && !(await checkOrganizationPermission(ws.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policy-overrides"))
    ) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: "manage-policy-overrides is required to grant policy overrides" }] };
    }
    const id = `tw-${crypto.randomUUID()}`;
    await db.insert(teamWorkspaces).values({ id, teamId, workspaceId, access, permissions });
    (set as { status: number }).status = 201;
    return { data: { id, type: "team-workspaces", attributes: { access, permissions: permissions ?? { runs: "write", variables: "write" } }, relationships: { team: { data: { id: teamId, type: "teams" } }, workspace: { data: { id: workspaceId, type: "workspaces" } } } } };
  })
  .get("/api/v2/team-workspaces/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const id = params["id"] ?? "";
    const tw = await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, id) });
    if (tw === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, tw.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, tokenOrgId, tokenTeamId ?? null, "admin"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: tw.id, type: "team-workspaces", attributes: { access: tw.access, permissions: tw.permissions ?? { runs: "write", variables: "write", "state-versions": "write" } }, relationships: { team: { data: { id: tw.teamId, type: "teams" } }, workspace: { data: { id: tw.workspaceId, type: "workspaces" } } } } };
  })
  .patch("/api/v2/team-workspaces/:id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const id = params["id"] ?? "";
    const tw = await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, id) });
    if (tw === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, tw.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, tokenOrgId, tokenTeamId ?? null, "admin"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload["data"] as Record<string, unknown> | undefined;
    const attributes = typeof data?.["attributes"] === "object" && data["attributes"] !== null ? (data["attributes"] as Record<string, unknown>) : {};
    const accessInput = attributes["access"] === undefined ? tw.access : attributes["access"];
    const permissionsInput = attributes["permissions"] === undefined
      ? (accessInput === "custom" ? tw.permissions : null)
      : attributes["permissions"];
    const grant = parseTeamWorkspaceGrant(accessInput, permissionsInput);
    if ("error" in grant) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: grant.error }] }; }
    if (
      (attributes["access"] !== undefined || attributes["permissions"] !== undefined)
      && grant.value.grantsPolicyOverrides
      && !(await checkOrganizationPermission(ws.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-policy-overrides"))
    ) {
      (set as { status: number }).status = 403;
      return { errors: [{ status: "403", title: "Forbidden", detail: "manage-policy-overrides is required to grant policy overrides" }] };
    }
    const updates: Record<string, unknown> = {};
    if (attributes["access"] !== undefined) updates["access"] = grant.value.access;
    if (attributes["permissions"] !== undefined) updates["permissions"] = grant.value.permissions;
    if (Object.keys(updates).length > 0) await db.update(teamWorkspaces).set(updates).where(eq(teamWorkspaces.id, id));
    const updated = await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, id) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "team-workspaces", attributes: { access: updated.access, permissions: updated.permissions }, relationships: { team: { data: { id: updated.teamId, type: "teams" } }, workspace: { data: { id: updated.workspaceId, type: "workspaces" } } } } };
  })
  .delete("/api/v2/team-workspaces/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const id = params["id"] ?? "";
    const tw = await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, id) });
    if (tw === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, tw.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, tokenOrgId, tokenTeamId ?? null, "admin"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(teamWorkspaces).where(eq(teamWorkspaces.id, id));
    (set as { status: number }).status = 204;
    return {};
  })
;
