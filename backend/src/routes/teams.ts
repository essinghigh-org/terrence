import { Elysia } from "elysia";
import { db } from "../db";
import { teams, teamMemberships, teamWorkspaces, organizationMemberships, apiTokens, workspaces, users, organizations, notificationConfigurations, scimGroups, scimSettings, teamScimGroupMappings } from "../db/schema";
import { eq, and, count, inArray, asc, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { checkOrganizationPermission, checkOrgPermission, checkWorkspacePermission, pageRequest, pagination } from "../lib/utils";
import { authPlugin } from "../auth";
import { orgMembershipResource } from "../lib/response";

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
] as const;

function parseOrganizationAccess(input: unknown): Readonly<{ value: Record<string, boolean> }> | Readonly<{ error: string }> {
  if (input === undefined) return { value: {} };
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { error: "organization-access must be an object" };
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.some(([key, value]): boolean => !organizationAccessKeys.includes(key as typeof organizationAccessKeys[number]) || typeof value !== "boolean")) {
    return { error: "organization-access contains an unknown or non-boolean permission" };
  }
  return { value: Object.fromEntries(entries) as Record<string, boolean> };
}

function organizationAccessResource(access: Readonly<Record<string, boolean>>): Record<string, boolean> {
  return {
    ...Object.fromEntries(organizationAccessKeys.map((key): [string, boolean] => [key, false])),
    ...access,
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

async function teamResource(team: TeamItem, userCount: number, linkage?: TeamLinkage, scim?: TeamScim): Promise<Record<string, unknown>> {
  return {
    id: team.id,
    type: "teams",
    attributes: {
      name: team.name,
      description: team.description,
      visibility: team.visibility,
      "sso-team-id": team.ssoTeamId,
      "organization-access": organizationAccessResource(team.organizationAccess),
      "allow-member-token-management": team.allowMemberTokenManagement === true,
      "users-count": userCount,
      permissions: { "can-update": true, "can-destroy": true },
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
  return (await db.query.teamScimGroupMappings.findFirst({
    where: eq(teamScimGroupMappings.teamId, teamId),
    columns: { teamId: true },
  })) !== undefined;
}

export const teamRoutes = new Elysia({ name: "teams" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/teams", async ({ params, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId, tokenTeamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const [teamList, countRows] = await Promise.all([
      db.query.teams.findMany({ where: eq(teams.orgId, org.id), orderBy: [asc(teams.id)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(teams).where(eq(teams.orgId, org.id)),
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
    const data = teamList.map((t: TeamItem): Promise<Record<string, unknown>> => {
      const userRefs = membersByTeam.get(t.id) ?? [];
      const mapping = mappingByTeam.get(t.id);
      const scim = scimEnabled
        ? { enabled: true, mapping, groupName: mapping === undefined ? null : groupById.get(mapping.scimGroupId) ?? null }
        : undefined;
      return teamResource(t, userRefs.length, { users: userRefs }, scim);
    });
    const totalCount = countRows[0]?.total ?? 0;
    return { data: await Promise.all(data), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/organizations/:org_name/teams", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const name = typeof attributes.name === "string" ? attributes.name : "";
    if (name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    const id = `team-${crypto.randomUUID()}`;
    const description = typeof attributes.description === "string" ? attributes.description : null;
    const visibility = typeof attributes.visibility === "string" ? attributes.visibility : "organization";
    const ssoTeamId = typeof attributes["sso-team-id"] === "string" ? attributes["sso-team-id"] : null;
    const organizationAccess = parseOrganizationAccess(attributes["organization-access"]);
    if ("error" in organizationAccess) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: organizationAccess.error }] }; }
    if (
      attributes["organization-access"] !== undefined
      && !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-organization-access"))
    ) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const newTeam = { id, orgId: org.id, name, description, visibility, ssoTeamId, organizationAccess: organizationAccess.value, createdAt: Date.now() };
    await db.insert(teams).values(newTeam);
    (set as { status: number }).status = 201;
    return { data: await teamResource(newTeam, 0, { users: [] }) };
  })
  .get("/api/v2/teams/:team_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, query, set }: ParamCtx): Promise<unknown> => {
    const teamId = params.team_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId, tokenTeamId ?? null))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userCount = (await db.select({ val: count() }).from(teamMemberships).where(eq(teamMemberships.teamId, team.id)))[0]?.val ?? 0;
    const includeQuery = query !== undefined ? query.include : undefined;
    const includes = typeof includeQuery === "string" ? includeQuery.split(",") : [];
    const includeUsers = includes.includes("users");
    const includeOrgMemberships = includes.includes("organization-memberships");
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
      return { data: await teamResource(team, userCount, linkage, scim), ...(included.length > 0 ? { included } : {}) };
    }
    if (includeUsers) {
      const linkage: TeamLinkage = { users: members.map((m): { id: string; type: string } => ({ id: m.userId, type: "users" })) };
      return { data: await teamResource(team, userCount, linkage, scim), ...(included.length > 0 ? { included } : {}) };
    }
    return { data: await teamResource(team, userCount, undefined, scim), ...(included.length > 0 ? { included } : {}) };
  })
  .patch("/api/v2/teams/:team_id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const teamId = params.team_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof teams.$inferInsert> = {};
    const linked = await scimLinked(teamId);
    if (linked && attributes.name !== undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "SCIM-linked teams cannot be renamed" }] };
    }
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = typeof attributes.description === "string" ? attributes.description : null;
    if (typeof attributes.visibility === "string") updates.visibility = attributes.visibility;
    if (!linked && attributes["sso-team-id"] !== undefined) updates.ssoTeamId = typeof attributes["sso-team-id"] === "string" ? attributes["sso-team-id"] : null;
    if (attributes["organization-access"] !== undefined) {
      if (!(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-organization-access"))) {
        (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
      }
      const organizationAccess = parseOrganizationAccess(attributes["organization-access"]);
      if ("error" in organizationAccess) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: organizationAccess.error }] }; }
      updates.organizationAccess = { ...team.organizationAccess, ...organizationAccess.value };
    }
    if (Object.keys(updates).length > 0) await db.update(teams).set(updates).where(eq(teams.id, teamId));
    const updated = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const userCount = (await db.select({ val: count() }).from(teamMemberships).where(eq(teamMemberships.teamId, teamId)))[0]?.val ?? 0;
    const [memberRefs, scim] = await Promise.all([
      db.query.teamMemberships.findMany({ where: eq(teamMemberships.teamId, teamId), columns: { userId: true } }),
      teamScim(teamId, (await db.query.scimSettings.findFirst({ where: eq(scimSettings.id, "scim") }))?.enabled === true),
    ]);
    return { data: await teamResource(updated, userCount, { users: memberRefs.map((m): { id: string; type: string } => ({ id: m.userId, type: "users" })) }, scim) };
  })
  .delete("/api/v2/teams/:team_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const teamId = params.team_id ?? "";
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
    const teamId = params.team_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (await scimLinked(teamId)) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const userItems = payload.data;
    if (Array.isArray(userItems)) {
      const batch: (typeof teamMemberships.$inferInsert)[] = [];
      // TFE's Atlas convention lets `data[].id` be either a user UUID or a
      // username; the go-tfe v2 client sends usernames.
      const rawIds = userItems
        .map((item): string => (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") ? (item as Record<string, unknown>).id as string : "")
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
    const teamId = params.team_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (await scimLinked(teamId)) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const userItems = payload.data;
    if (Array.isArray(userItems)) {
      const rawIds = userItems.map((i: unknown): string => (i !== null && typeof i === "object" && typeof (i as Record<string, unknown>).id === "string") ? (i as Record<string, unknown>).id as string : "").filter((s: string): boolean => s !== "");
      const userIds = await resolveUserIds(rawIds);
      if (userIds.length > 0) await db.delete(teamMemberships).where(and(eq(teamMemberships.teamId, teamId), inArray(teamMemberships.userId, userIds)));
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/teams/:team_id/relationships/organization-memberships", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const teamId = params.team_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (await scimLinked(teamId)) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    if (Array.isArray(items)) {
      const memIds = items
        .map((item): string => (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") ? (item as Record<string, unknown>).id as string : "")
        .filter((s: string): boolean => s !== "");
      const memberships = memIds.length === 0
        ? new Map<string, typeof organizationMemberships.$inferSelect>()
        : new Map(
            (await db.query.organizationMemberships.findMany({
              where: inArray(organizationMemberships.id, memIds),
            })).map((m): [string, typeof organizationMemberships.$inferSelect] => [m.id, m]),
          );
      for (const memId of memIds) {
        const mem = memberships.get(memId);
        if (mem?.orgId === team.orgId) await db.insert(teamMemberships).values({ id: `tm-${crypto.randomUUID()}`, teamId, userId: mem.userId, createdAt: Date.now() }).onConflictDoNothing();
      }
    }
    (set as { status: number }).status = 204;
    return {};
  })
  .delete("/api/v2/teams/:team_id/relationships/organization-memberships", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const teamId = params.team_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-membership"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (await scimLinked(teamId)) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const items = payload.data;
    if (Array.isArray(items)) {
      const memIds = items
        .map((item): string => (item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") ? (item as Record<string, unknown>).id as string : "")
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
  .post("/api/v2/teams/:team_id/authentication-token", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const teamId = params.team_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const rawToken = `team-tok-${crypto.randomUUID()}`;
    const id = `tok-${crypto.randomUUID()}`;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await db.delete(apiTokens).where(eq(apiTokens.teamId, teamId));
    await db.insert(apiTokens).values({ id, token: tokenHash, teamId, orgId: team.orgId, description: `Team token for ${team.name}`, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "authentication-tokens", attributes: { token: rawToken, "created-at": new Date().toISOString() } } };
  })
  .get("/api/v2/teams/:team_id/authentication-token", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const teamId = params.team_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tok = await db.query.apiTokens.findFirst({ where: eq(apiTokens.teamId, teamId) });
    if (tok === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: tok.id, type: "authentication-tokens", attributes: { "created-at": new Date(tok.createdAt).toISOString() } } };
  })
  .delete("/api/v2/teams/:team_id/authentication-token", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const teamId = params.team_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(apiTokens).where(eq(apiTokens.teamId, teamId));
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/teams/:team_id/authentication-tokens", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const teamId = params.team_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const secret = `team-${crypto.randomUUID().replace(/-/g, "")}`;
    const tokenId = `tok-${crypto.randomUUID()}`;
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const description = typeof attrs.description === "string" ? attrs.description : `Team token for ${team.name}`;
    const expiredAtVal = attrs["expired-at"] ?? attrs["expires-at"] ?? attrs.expiredAt ?? attrs.expiresAt;
    const expiredAtStr = typeof expiredAtVal === "string" ? expiredAtVal : "";
    const expiresAt = expiredAtStr !== "" ? new Date(expiredAtStr).getTime() : null;
    const tokenHash = createHash("sha256").update(secret).digest("hex");
    await db.insert(apiTokens).values({ id: tokenId, token: tokenHash, orgId: team.orgId, teamId: team.id, description, createdAt: Date.now(), expiresAt });
    (set as { status: number }).status = 201;
    return { data: { id: tokenId, type: "authentication-tokens", attributes: { token: secret, description, "created-at": new Date().toISOString(), "expired-at": expiresAt !== null ? new Date(expiresAt).toISOString() : null } } };
  })
  .get("/api/v2/teams/:team_id/authentication-tokens", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const teamId = params.team_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tokenList = await db.query.apiTokens.findMany({ where: eq(apiTokens.teamId, teamId) });
    return { data: tokenList.map((t): Record<string, unknown> => ({ id: t.id, type: "authentication-tokens", attributes: { description: t.description, "created-at": new Date(t.createdAt).toISOString(), "last-used-at": t.lastUsedAt !== null ? new Date(t.lastUsedAt).toISOString() : null } })) };
  })
  .delete("/api/v2/teams/:team_id/authentication-tokens/:token_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const teamId = params.team_id ?? "";
    const tokenId = params.token_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(apiTokens).where(and(eq(apiTokens.id, tokenId), eq(apiTokens.teamId, teamId)));
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
    const data = payload.data as Record<string, unknown> | undefined;
    const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
    const teamRel = typeof rels.team === "object" && rels.team !== null ? (rels.team as Record<string, unknown>) : {};
    const teamData = typeof teamRel.data === "object" && teamRel.data !== null ? (teamRel.data as Record<string, unknown>) : {};
    const wsRel = typeof rels.workspace === "object" && rels.workspace !== null ? (rels.workspace as Record<string, unknown>) : {};
    const wsData = typeof wsRel.data === "object" && wsRel.data !== null ? (wsRel.data as Record<string, unknown>) : {};
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const teamId = typeof teamData.id === "string" ? teamData.id : "";
    const workspaceId = typeof wsData.id === "string" ? wsData.id : "";
    const access = typeof attrs.access === "string" ? attrs.access : "write";
    const permissions = (attrs.permissions as Record<string, unknown> | null) ?? null;
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
    const id = `tw-${crypto.randomUUID()}`;
    await db.insert(teamWorkspaces).values({ id, teamId, workspaceId, access, permissions });
    (set as { status: number }).status = 201;
    return { data: { id, type: "team-workspaces", attributes: { access, permissions: permissions ?? { runs: "write", variables: "write" } }, relationships: { team: { data: { id: teamId, type: "teams" } }, workspace: { data: { id: workspaceId, type: "workspaces" } } } } };
  })
  .get("/api/v2/team-workspaces/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const id = params.id ?? "";
    const tw = await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, id) });
    if (tw === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, tw.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, tokenOrgId, tokenTeamId ?? null, "admin"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: tw.id, type: "team-workspaces", attributes: { access: tw.access, permissions: tw.permissions ?? { runs: "write", variables: "write", "state-versions": "write" } }, relationships: { team: { data: { id: tw.teamId, type: "teams" } }, workspace: { data: { id: tw.workspaceId, type: "workspaces" } } } } };
  })
  .patch("/api/v2/team-workspaces/:id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const id = params.id ?? "";
    const tw = await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, id) });
    if (tw === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, tw.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, tokenOrgId, tokenTeamId ?? null, "admin"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Record<string, unknown> = {};
    if (typeof attributes.access === "string") updates.access = attributes.access;
    if (attributes.permissions !== undefined) updates.permissions = attributes.permissions;
    if (Object.keys(updates).length > 0) await db.update(teamWorkspaces).set(updates).where(eq(teamWorkspaces.id, id));
    const updated = await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, id) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "team-workspaces", attributes: { access: updated.access, permissions: updated.permissions }, relationships: { team: { data: { id: updated.teamId, type: "teams" } }, workspace: { data: { id: updated.workspaceId, type: "workspaces" } } } } };
  })
  .delete("/api/v2/team-workspaces/:id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const id = params.id ?? "";
    const tw = await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, id) });
    if (tw === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, tw.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, tokenOrgId, tokenTeamId ?? null, "admin"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(teamWorkspaces).where(eq(teamWorkspaces.id, id));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Team Notification Configurations ---
  .post("/api/v2/teams/:team_id/notification-configurations", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const teamId = params.team_id ?? "";
    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (team === undefined || !(await checkOrganizationPermission(team.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-teams"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const url = typeof attributes.url === "string" ? attributes.url : "";
    const destinationType = typeof attributes["destination-type"] === "string" ? attributes["destination-type"] : "";
    if (url === "" || destinationType === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "URL and destination-type are required" }] }; }
    const id = `nc-${crypto.randomUUID()}`;
    const name = typeof attributes.name === "string" ? attributes.name : `Team notification for ${team.name}`;
    const triggers = Array.isArray(attributes.triggers) ? (attributes.triggers as string[]) : ["team:change_request"];
    const enabled = typeof attributes.enabled === "boolean" ? attributes.enabled : true;
    const token = typeof attributes.token === "string" ? attributes.token : null;
    await db.insert(notificationConfigurations).values({ id, workspaceId: null, teamId, name, destinationType, url, triggers, enabled, token, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "notification-configurations", attributes: { name, "destination-type": destinationType, url, triggers, enabled } } };
  });
