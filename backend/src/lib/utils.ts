import { db } from "../db";
import {
  users, workspaces,
  runs, stateVersions, workspaceVariables, workspaceTags,
  configurationVersions, variableSets,
  auditLogs, dataRetentionPolicies, organizationDataRetentionPolicies, remoteStateConsumers,
  agentPools, workspaceRunTasks, logs, organizationMemberships, projectTags, reservedTagKeys,
  organizations, registryPartnerships, teams, teamMemberships, teamWorkspaces,
  organizationMembershipRoles, organizationRoles,
} from "../db/schema";
import { and, desc, eq, gte, inArray, like, lt, notInArray, or, sql } from "drizzle-orm";
import { timingSafeEqual, createHmac } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { validateVersion } from "../binaryManager";
import { decodeStatePayload, parseStatePayload } from "./validation";
import { archiveRunLogs, deleteRunLogArchive } from "./run-logs";
import { deletePlanJsonArtifact } from "./plan-json";
import { currentTokenScopes, withoutTokenScopes } from "./request-scope";
import {
  scopeGrants,
  scopeCoversOrg,
  evaluateTagExpression,
  type WorkspacePermissionGrant,
  type TokenScopes,
  type TokenScopeTags,
} from "./token-scopes";

export { validateVersion, decodeStatePayload, parseStatePayload };

type DeepReadonly<T> = T extends null | undefined | boolean | number | string
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : { readonly [Key in keyof T]: DeepReadonly<T[Key]> };

const PUBLIC_URL = typeof process.env.PUBLIC_URL === "string" && process.env.PUBLIC_URL !== "" ? new URL(process.env.PUBLIC_URL) : null;

export async function auditLog(
  action: string,
  resourceType: string,
  resourceId: string | null,
  userId: string | null,
  orgId: string | null,
  details?: Readonly<Record<string, unknown>>,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId,
      userId,
      action,
      resourceType,
      resourceId,
      details: details !== undefined ? { ...details } : null,
      createdAt: Date.now(),
    });
  } catch {}
}

export async function checkOrgPermission(
  userId: string | undefined,
  orgId: string,
  requiredRole: "owner" | "member" = "member",
  tokenOrgId: string | null = null,
  tokenTeamId: string | null = null,
  requiredGrant: WorkspacePermissionGrant | null = null,
): Promise<boolean> {
  const scopes = currentTokenScopes();
  if (scopes !== null) {
    // Fine-grained token: the org MUST be inside the scope, org-level
    // owner actions additionally require the settings:write grant, and a
    // caller-specified grant (e.g. settings:read for org-settings reads)
    // must be present too.  The user's own membership is still verified
    // below, so a fine-grained token can never exceed the user's
    // underlying access.
    if (!scopeCoversOrg(scopes, orgId)) return false;
    if (requiredRole === "owner" && requiredGrant === null && !scopeGrants(scopes, "settings:write")) return false;
    if (requiredGrant !== null && !scopeGrants(scopes, requiredGrant)) return false;
  }
  if (tokenTeamId !== null) {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, tokenTeamId) });
    return team?.orgId === orgId && requiredRole === "member";
  }
  if (tokenOrgId !== null) return tokenOrgId === orgId;
  if (userId === undefined) return false;
  const [user, membership] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { isSiteAdmin: true } }),
    db.query.organizationMemberships.findFirst({
      where: and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.orgId, orgId)),
    }),
  ]);
  if (user?.isSiteAdmin === true) return true;
  if (membership?.status !== "active") return false;
  if (requiredRole === "owner" && membership.role !== "owner") return false;
  return true;
}

export type OrganizationPermission =
  | "manage-policies"
  | "read-policies"
  | "manage-policy-overrides"
  | "delegate-policy-overrides"
  | "manage-run-tasks"
  | "manage-workspaces"
  | "manage-vcs-settings"
  | "read-vcs-settings"
  | "manage-agent-pools"
  | "read-agent-pools"
  | "manage-providers"
  | "manage-modules"
  | "manage-projects"
  | "read-projects"
  | "read-workspaces"
  | "manage-membership"
  | "manage-teams"
  | "manage-organization-access"
  | "manage-varsets"
  | "read-varsets";

function teamOrganizationAllows(
  access: Readonly<Record<string, boolean>>,
  required: OrganizationPermission,
): boolean {
  if (access[required] === true) return true;
  if (required === "read-workspaces") {
    return access["manage-workspaces"] === true
      || access["read-projects"] === true
      || access["manage-projects"] === true
      || access["manage-agent-pools"] === true
      || access["manage-policy-overrides"] === true;
  }
  if (required === "manage-workspaces") return access["manage-projects"] === true;
  if (required === "read-projects") {
    return access["manage-projects"] === true || access["manage-agent-pools"] === true;
  }
  if (required === "manage-membership") {
    return access["manage-teams"] === true || access["manage-organization-access"] === true;
  }
  if (required === "manage-teams") return access["manage-organization-access"] === true;
  // Team-level `organization-access` records predate the fine-grained read
  // split; their existing manage keys satisfy the matching read requirement.
  if (required === "read-policies") return access["manage-policies"] === true;
  if (required === "read-vcs-settings") return access["manage-vcs-settings"] === true;
  if (required === "read-agent-pools") return access["manage-agent-pools"] === true;
  if (required === "read-varsets") {
    return access["manage-workspaces"] === true
      || access["read-workspaces"] === true
      || access["manage-projects"] === true
      || access["manage-varsets"] === true;
  }
  // manage-projects cascades to workspace management, which covers varsets.
  if (required === "manage-varsets") {
    return access["manage-workspaces"] === true || access["manage-projects"] === true;
  }
  return false;
}

/** Map an OrganizationPermission to the fine-grained grant it requires. */
function organizationPermissionGrant(required: OrganizationPermission): WorkspacePermissionGrant | null {
  switch (required) {
    case "manage-policies":
      return "policies:write";
    case "read-policies":
      return "policies:read";
    case "manage-policy-overrides":
    case "delegate-policy-overrides":
      return "runs:policy-override";
    case "manage-run-tasks":
      return "run-tasks:write";
    case "manage-vcs-settings":
      return "vcs:write";
    case "read-vcs-settings":
      return "vcs:read";
    case "manage-agent-pools":
      return "agent-pools:write";
    case "read-agent-pools":
      return "agent-pools:read";
    case "manage-providers":
    case "manage-modules":
      return "registry:write";
    case "manage-projects":
      return "projects:write";
    case "read-projects":
      return "projects:read";
    case "read-workspaces":
      return "workspaces:read";
    case "manage-workspaces":
      return "workspaces:write";
    case "manage-membership":
      return "members:write";
    case "manage-teams":
    case "manage-organization-access":
      return "teams:write";
    case "manage-varsets":
      return "varsets:write";
    case "read-varsets":
      return "varsets:read";
    default:
      return null;
  }
}

export async function checkOrganizationPermission(
  orgId: string,
  userId: string | undefined,
  tokenOrgId: string | null | undefined,
  tokenTeamId: string | null | undefined,
  required: OrganizationPermission,
): Promise<boolean> {
  const scopes = currentTokenScopes();
  if (scopes !== null) {
    // Fine-grained token: org must be inside the scope AND the required
    // org-level action must map to a granted permission.
    if (!scopeCoversOrg(scopes, orgId)) return false;
    const grant = organizationPermissionGrant(required);
    if (grant !== null && !scopeGrants(scopes, grant)) return false;
    // Fall through: user's own membership/team access must also pass.
  }
  if (tokenOrgId !== null && tokenOrgId !== undefined) return tokenOrgId === orgId;
  if (tokenTeamId !== null && tokenTeamId !== undefined) {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, tokenTeamId) });
    return team?.orgId === orgId && teamOrganizationAllows(team.organizationAccess, required);
  }
  if (userId === undefined) return false;
  // The inner probes below are membership checks ("is this user an owner /
  // member?"), not additional permission gates.  The scope filter was already
  // applied above, so resolve underlying access without re-applying it —
  // otherwise an org owner with a workspaces:write token (no settings:write)
  // would fail the owner probe and then fall through to team checks that may
  // also fail, denying a grant the outer check already accepted.
  return await withoutTokenScopes(async () => {
    if (await checkOrgPermission(userId, orgId, "owner")) return true;
    if (!(await checkOrgPermission(userId, orgId, "member"))) return false;
    const directMembership = await db.query.organizationMemberships.findFirst({
      where: and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.orgId, orgId)),
    });
    if (directMembership !== undefined) {
      const assigned = await db.query.organizationMembershipRoles.findMany({
        where: eq(organizationMembershipRoles.membershipId, directMembership.id),
      });
      if (assigned.length > 0) {
        const roles = await db.query.organizationRoles.findMany({
          where: inArray(organizationRoles.id, assigned.map((item) => item.roleId)),
        });
        if (roles.some((role) => teamOrganizationAllows(role.permissions ?? {}, required))) return true;
      }
    }
    const memberships = await db.query.teamMemberships.findMany({
      where: eq(teamMemberships.userId, userId),
    });
    const teamIds = memberships.map((membership): string => membership.teamId);
    if (teamIds.length === 0) return false;
    const userTeams = await db.query.teams.findMany({
      where: and(eq(teams.orgId, orgId), inArray(teams.id, teamIds)),
    });
    return userTeams.some((team): boolean => teamOrganizationAllows(team.organizationAccess, required));
  });
}

export async function checkOrganizationVcsReadPermission(
  orgId: string,
  userId: string | undefined,
  tokenOrgId: string | null | undefined,
  tokenTeamId: string | null | undefined,
): Promise<boolean> {
  return await checkOrganizationPermission(
    orgId,
    userId,
    tokenOrgId,
    tokenTeamId,
    "read-vcs-settings",
  ) || await checkOrganizationPermission(
    orgId,
    userId,
    tokenOrgId,
    tokenTeamId,
    "manage-vcs-settings",
  ) || await checkOrganizationPermission(
    orgId,
    userId,
    tokenOrgId,
    tokenTeamId,
    "manage-workspaces",
  );
}

export type WorkspacePermission =
  | "read"
  | "run-read"
  | "plan"
  | "apply"
  | "discard"
  | "cancel"
  | "lock"
  | "admin"
  | "run-tasks"
  | "run-tasks-read"
  | "policy-override"
  | "variables-read"
  | "variables-write"
  | "state-outputs"
  | "state-read"
  | "state-write";

function teamWorkspaceAllows(
  accessLevel: string,
  rawPermissions: Readonly<Record<string, unknown>> | null,
  required: WorkspacePermission,
): boolean {
  const permissions = rawPermissions ?? {};
  if (required === "policy-override") return accessLevel === "custom" && permissions["policy-overrides"] === true;
  if (accessLevel === "admin") return true;
  if (accessLevel === "write") return ["read", "run-read", "plan", "apply", "discard", "cancel", "lock", "variables-read", "variables-write", "state-outputs", "state-read", "state-write"].includes(required);
  if (accessLevel === "plan") return ["read", "run-read", "plan", "variables-read", "state-outputs", "state-read"].includes(required);
  if (accessLevel === "read") return ["read", "run-read", "variables-read", "state-outputs", "state-read"].includes(required);
  if (accessLevel !== "custom") return false;

  const runs = typeof permissions.runs === "string" ? permissions.runs : "read";
  if (required === "read" || required === "run-read") return ["read", "plan", "apply"].includes(runs);
  if (required === "plan") return runs === "plan" || runs === "apply";
  if (required === "apply" || required === "discard" || required === "cancel") return runs === "apply";
  if (required === "run-tasks" || required === "run-tasks-read") return permissions["run-tasks"] === true;
  if (required === "lock") return permissions["workspace-locking"] === true;
  const variableAccess = typeof permissions.variables === "string" ? permissions.variables : "none";
  if (required === "variables-read") return variableAccess === "read" || variableAccess === "write";
  if (required === "variables-write") return variableAccess === "write";
  const stateAccess = typeof permissions["state-versions"] === "string" ? permissions["state-versions"] : "none";
  if (required === "state-outputs") return ["read-outputs", "read", "write"].includes(stateAccess);
  if (required === "state-read") return stateAccess === "read" || stateAccess === "write";
  if (required === "state-write") return stateAccess === "write";
  return false;
}

/**
 * Resolve the set of workspace IDs a fine-grained token scope allows within an
 * org. Returns null when the scope covers ALL workspaces in the org (no
 * workspace/project/tag restriction). Returns [] when the scope cannot reach
 * any workspace in the org.
 */
async function scopeWorkspaceIdsForOrg(scope: TokenScopes, orgId: string): Promise<readonly string[] | null> {
  if (!scopeCoversOrg(scope, orgId)) return [];

  const projectRestriction = scope.projects !== null && scope.projects.length > 0;
  const workspaceRestriction = scope.workspaces !== null && scope.workspaces.length > 0;
  const tagRestriction = scope.tags !== null && scope.tags.rules.length > 0;
  if (!projectRestriction && !workspaceRestriction && !tagRestriction) return null;

  // Gather matching workspace IDs.
  const matching = new Set<string>();

  if (projectRestriction) {
    const rows = await db.query.workspaces.findMany({
      where: and(
        eq(workspaces.orgId, orgId),
        inArray(workspaces.projectId, scope.projects as string[]),
      ),
      columns: { id: true },
    });
    for (const row of rows) matching.add(row.id);
  }

  if (workspaceRestriction) {
    const rows = await db.query.workspaces.findMany({
      where: and(eq(workspaces.orgId, orgId), inArray(workspaces.id, scope.workspaces as string[])),
      columns: { id: true },
    });
    for (const row of rows) matching.add(row.id);
  }

  if (tagRestriction) {
    // Evaluate the tag expression in memory per workspace: AND/OR nesting
    // across multiple tags is hard to express with a single join.
    const orgWorkspaceIds = (await db.query.workspaces.findMany({
      where: eq(workspaces.orgId, orgId),
      columns: { id: true },
    })).map((row): string => row.id);
    if (orgWorkspaceIds.length > 0) {
      const tagRows = await db.query.workspaceTags.findMany({
        where: inArray(workspaceTags.workspaceId, orgWorkspaceIds),
        columns: { workspaceId: true, key: true, value: true },
      });
      const tagsByWorkspace = new Map<string, Set<string>>();
      for (const row of tagRows) {
        const tags = tagsByWorkspace.get(row.workspaceId) ?? new Set<string>();
        tags.add(`${row.key}=${row.value ?? ""}`);
        tagsByWorkspace.set(row.workspaceId, tags);
      }
      for (const [workspaceId, tags] of tagsByWorkspace) {
        if (evaluateTagExpression(scope.tags as TokenScopeTags, tags)) matching.add(workspaceId);
      }
    }
  }

  return [...matching];
}

/** Map a WorkspacePermission to the fine-grained grant(s) it requires. */
function workspacePermissionGrant(required: WorkspacePermission): readonly WorkspacePermissionGrant[] {
  switch (required) {
    case "read": return ["workspaces:read"];
    case "run-read": return ["runs:read"];
    case "admin": return ["workspaces:write"];
    case "plan": return ["runs:plan"];
    case "apply": return ["runs:apply"];
    case "discard": return ["runs:discard"];
    case "cancel": return ["runs:cancel"];
    case "lock": return ["workspaces:lock"];
    case "run-tasks": return ["run-tasks:write"];
    case "run-tasks-read": return ["run-tasks:read"];
    case "policy-override": return ["runs:policy-override"];
    case "variables-read": return ["variables:read"];
    case "variables-write": return ["variables:write"];
    case "state-outputs": return ["state:read"];
    case "state-read": return ["state:read"];
    case "state-write": return ["state:write"];
    default: return [];
  }
}

export async function workspaceIdsForPermission(
  orgId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
  required: WorkspacePermission,
): Promise<readonly string[] | null> {
  const scopes = currentTokenScopes();
  if (scopes !== null) {
    // Fine-grained token: (1) the required action must be granted, (2) the
    // workspace must be inside the scope's org/project/workspace/tag set,
    // AND (3) the user's own membership/team access must pass.  Enforce
    // (1)+(2) here, then intersect with the base result below.
    const grants = workspacePermissionGrant(required);
    if (grants.length === 0 || !grants.some((grant): boolean => scopeGrants(scopes, grant))) return [];
    const scopeIds = await scopeWorkspaceIdsForOrg(scopes, orgId);
    // Compute the user's base access WITHOUT scope influence — the base is
    // "what this user can do on their own", which the scope then narrows.
    const base = await withoutTokenScopes(() =>
      workspaceIdsForPermissionUnscoped(orgId, userId, tokenOrgId, tokenTeamId, required));
    if (base === null) return scopeIds; // user has org-wide access; scope narrows
    if (scopeIds === null) return base; // scope covers all; user's own access applies
    const scopeSet = new Set(scopeIds);
    return base.filter((id): boolean => scopeSet.has(id));
  }
  return workspaceIdsForPermissionUnscoped(orgId, userId, tokenOrgId, tokenTeamId, required);
}

async function workspaceIdsForPermissionUnscoped(
  orgId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
  required: WorkspacePermission,
): Promise<readonly string[] | null> {
  if (tokenTeamId !== null) {
    const [team, accesses] = await Promise.all([
      db.query.teams.findFirst({ where: eq(teams.id, tokenTeamId) }),
      db.query.teamWorkspaces.findMany({ where: eq(teamWorkspaces.teamId, tokenTeamId) }),
    ]);
    if (team?.orgId !== orgId) return [];
    if (teamOrganizationAllows(team.organizationAccess, "manage-workspaces")) return null;
    if (required === "read" && team.organizationAccess["manage-policies"] === true) return null;
    if (required === "policy-override" && team.organizationAccess["manage-policy-overrides"] === true) return null;
    if (["read", "run-read", "variables-read", "state-outputs", "state-read"].includes(required) && teamOrganizationAllows(team.organizationAccess, "read-workspaces")) return null;
    return accesses
      .filter((entry): boolean =>
        teamWorkspaceAllows(entry.access, entry.permissions, required)
        && (required !== "policy-override" || team.organizationAccess["delegate-policy-overrides"] === true))
      .map((entry): string => entry.workspaceId);
  }
  if (tokenOrgId !== null) {
    if (tokenOrgId !== orgId || required === "plan" || required === "apply" || required === "policy-override") return [];
    return null;
  }
  if (userId === undefined) return [];
  if (await checkOrgPermission(userId, orgId, "owner")) return null;
  if (!(await checkOrgPermission(userId, orgId, "member"))) return [];

  const memberships = await db.query.teamMemberships.findMany({
    where: eq(teamMemberships.userId, userId),
  });
  const teamIds = memberships.map((membership): string => membership.teamId);
  if (teamIds.length === 0) return [];
  const [accesses, userTeams] = await Promise.all([
    db.query.teamWorkspaces.findMany({ where: inArray(teamWorkspaces.teamId, teamIds) }),
    db.query.teams.findMany({ where: and(eq(teams.orgId, orgId), inArray(teams.id, teamIds)) }),
  ]);
  if (userTeams.some((team): boolean => teamOrganizationAllows(team.organizationAccess, "manage-workspaces"))) return null;
  if (required === "read" && userTeams.some((team): boolean => team.organizationAccess["manage-policies"] === true)) return null;
  if (required === "policy-override" && userTeams.some((team): boolean => team.organizationAccess["manage-policy-overrides"] === true)) return null;
  if (["read", "run-read", "variables-read", "state-outputs", "state-read"].includes(required)
    && userTeams.some((team): boolean => teamOrganizationAllows(team.organizationAccess, "read-workspaces"))) return null;
  const delegateTeamIds = required === "policy-override"
    ? new Set(userTeams
      .filter((team): boolean => team.organizationAccess["delegate-policy-overrides"] === true)
      .map((team): string => team.id))
    : null;
  return [...new Set(accesses
    .filter((entry): boolean =>
      teamWorkspaceAllows(entry.access, entry.permissions, required)
      && (delegateTeamIds === null || delegateTeamIds.has(entry.teamId)))
    .map((entry): string => entry.workspaceId))];
}

export async function checkWorkspacePermission(
  workspace: DeepReadonly<typeof workspaces.$inferSelect>,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
  required: WorkspacePermission,
): Promise<boolean> {
  const ids = await workspaceIdsForPermission(workspace.orgId, userId, tokenOrgId, tokenTeamId, required);
  return ids === null || ids.includes(workspace.id);
}

export async function checkRegistryReadPermission(
  userId: string | undefined,
  producerOrgId: string,
  kind: "modules" | "providers",
  tokenOrgId: string | null = null,
): Promise<boolean> {
  const scopes = currentTokenScopes();
  if (scopes !== null) {
    // Fine-grained token: registry reads need the registry:read grant AND an
    // org inside the scope (partnership reads from orgs outside the scope
    // are not reachable with a scoped token).
    if (!scopeCoversOrg(scopes, producerOrgId)) return false;
    if (!scopeGrants(scopes, "registry:read")) return false;
  }
  if (await checkOrgPermission(userId, producerOrgId, "member", tokenOrgId)) return true;
  const producer = await db.query.organizations.findFirst({ where: eq(organizations.id, producerOrgId) });
  if (producer?.[kind === "modules" ? "globalModuleSharing" : "globalProviderSharing"] === true) return true;

  const consumerOrgIds = tokenOrgId === null
    ? (userId === undefined
      ? []
      : (await db.query.organizationMemberships.findMany({
          where: eq(organizationMemberships.userId, userId),
        })).map((membership): string => membership.orgId))
    : [tokenOrgId];
  if (consumerOrgIds.length === 0) return false;

  const partnership = await db.query.registryPartnerships.findFirst({
    where: and(
      eq(registryPartnerships.producerOrgId, producerOrgId),
      inArray(registryPartnerships.consumerOrgId, consumerOrgIds),
      eq(kind === "modules" ? registryPartnerships.modules : registryPartnerships.providers, true),
    ),
  });
  return partnership !== undefined;
}

export async function findWorkspaceVar(workspaceId: string, varId: string): Promise<typeof workspaceVariables.$inferSelect | undefined> {
  return db.query.workspaceVariables.findFirst({
    where: and(eq(workspaceVariables.id, varId), eq(workspaceVariables.workspaceId, workspaceId)),
  });
}

export async function findAuthorizedVariableSet(
  variableSetId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null = null,
  required: "read-varsets" | "manage-varsets" = "read-varsets",
): Promise<typeof variableSets.$inferSelect | undefined> {
  const variableSet = await db.query.variableSets.findFirst({ where: eq(variableSets.id, variableSetId) });
  if (variableSet === undefined) return undefined;
  const hasPerm = await checkOrganizationPermission(variableSet.orgId, userId, tokenOrgId, tokenTeamId, required);
  return hasPerm ? variableSet : undefined;
}

function isJsonApiData(item: unknown, expectedType: string): item is { readonly id: string; readonly type: string } {
  if (item === null || typeof item !== "object") return false;
  const i = item as Record<string, unknown>;
  return i.type === expectedType && typeof i.id === "string" && i.id !== "";
}

export function workspaceRelationshipIds(body: unknown): string[] | undefined {
  const payload = body as Record<string, unknown> | null;
  const data = payload?.data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const items = data as unknown[];
  if (items.some((item: unknown): boolean => !isJsonApiData(item, "workspaces"))) return undefined;
  return [...new Set(items.map((item: unknown): string => (item as { readonly id: string }).id))];
}

export function projectRelationshipIds(body: unknown): string[] | undefined {
  const payload = body as Record<string, unknown> | null;
  const data = payload?.data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const items = data as unknown[];
  if (items.some((item: unknown): boolean => !isJsonApiData(item, "projects"))) return undefined;
  return [...new Set(items.map((item: unknown): string => (item as { readonly id: string }).id))];
}

type VarRelationshipResult = { many: boolean; resources: unknown[] };

export function variableRelationshipResources(body: unknown): VarRelationshipResult | undefined {
  const payload = body as Record<string, unknown> | null;
  const data = payload?.data;
  const many = Array.isArray(data);
  const resources = many ? (data as unknown[]) : [data];
  if (
    resources.length === 0
    || resources.some((item: unknown): boolean => !isJsonApiData(item, "vars"))
    || new Set(resources.map((item: unknown): string => (item as { readonly id: string }).id)).size !== resources.length
  ) return undefined;
  return { many, resources };
}

export async function findWorkspaceByName(orgId: string, name: string): Promise<typeof workspaces.$inferSelect | undefined> {
  return db.query.workspaces.findFirst({
    where: and(eq(workspaces.orgId, orgId), eq(workspaces.name, name)),
  });
}

export async function findAuthorizedWorkspace(
  workspaceId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null = null,
  required: WorkspacePermission = "read",
): Promise<typeof workspaces.$inferSelect | undefined> {
  const workspace = (await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) })) as typeof workspaces.$inferSelect | undefined;
  if (workspace === undefined) return undefined;
  const hasPerm = await checkWorkspacePermission(workspace, userId, tokenOrgId, tokenTeamId, required);
  return hasPerm ? workspace : undefined;
}

export async function findAuthorizedRun(
  runId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null = null,
  required: WorkspacePermission = "run-read",
): Promise<{ run: typeof runs.$inferSelect; workspace: typeof workspaces.$inferSelect } | undefined> {
  const run = (await db.query.runs.findFirst({ where: eq(runs.id, runId) })) as typeof runs.$inferSelect | undefined;
  if (run === undefined) return undefined;
  const workspace = await findAuthorizedWorkspace(run.workspaceId, userId, tokenOrgId, tokenTeamId, required);
  return workspace !== undefined ? { run, workspace } : undefined;
}

export async function findLogCapability(runId: string, token: string): Promise<typeof runs.$inferSelect | undefined> {
  const run = (await db.query.runs.findFirst({ where: eq(runs.id, runId) })) as typeof runs.$inferSelect | undefined;
  if (run === undefined || typeof run.logToken !== "string") return undefined;
  const expected = Buffer.from(run.logToken);
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? run : undefined;
}

type RequestWithUrl = Readonly<{ readonly url: string }>;

export function pageRequest(request: RequestWithUrl): { number: number; size: number } {
  const params = new URL(request.url).searchParams;
  const number = Number.parseInt(params.get("page[number]") ?? "1", 10);
  const size = Number.parseInt(params.get("page[size]") ?? "20", 10);
  return {
    number: Number.isSafeInteger(number) && number > 0 ? number : 1,
    size: Number.isSafeInteger(size) && size > 0 ? Math.min(size, 100) : 20,
  };
}

export function pagination(request: RequestWithUrl, currentPage: number, pageSize: number, totalCount: number): { links: Record<string, string | null>; meta: Record<string, unknown> } {
  const totalPages = Math.ceil(totalCount / pageSize);
  const pageLink = (page: number): string => {
    const url = new URL(request.url);
    url.searchParams.set("page[number]", String(page));
    url.searchParams.set("page[size]", String(pageSize));
    return url.toString();
  };

  return {
    links: {
      self: pageLink(currentPage),
      first: pageLink(1),
      prev: currentPage > 1 ? pageLink(currentPage - 1) : null,
      next: currentPage < totalPages ? pageLink(currentPage + 1) : null,
      last: pageLink(Math.max(1, totalPages)),
    },
    meta: {
      pagination: {
        "current-page": currentPage,
        "page-size": pageSize,
        "prev-page": currentPage > 1 ? currentPage - 1 : null,
        "next-page": currentPage < totalPages ? currentPage + 1 : null,
        "total-pages": totalPages,
        "total-count": totalCount,
      },
    },
  };
}

export function apiURL(request: RequestWithUrl, path: string): string {
  return new URL(path, PUBLIC_URL ?? request.url).toString();
}

const SIGNED_URL_SECRET = process.env.SIGNED_URL_SECRET ?? crypto.randomUUID();

export function signedApiURL(request: RequestWithUrl, path: string, method = "GET", ttlSeconds?: number): string {
  const configuredTtl = ttlSeconds ?? Number(process.env.SIGNED_URL_TTL_SECONDS ?? 300);
  const ttl = Number.isSafeInteger(configuredTtl) && configuredTtl > 0 ? configuredTtl : 300;
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const signature = createHmac("sha256", SIGNED_URL_SECRET)
    .update(`${method}\n${path}\n${String(expires)}`)
    .digest("hex");
  const url = new URL(path, PUBLIC_URL ?? request.url);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", signature);
  return url.toString();
}

export function validSignedApiURL(request: RequestWithUrl, path: string, method = "GET"): boolean {
  const url = new URL(request.url);
  const expires = url.searchParams.get("expires");
  const signature = url.searchParams.get("signature");
  if (expires === null || signature === null || !/^\d+$/.test(expires) || Number(expires) < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(createHmac("sha256", SIGNED_URL_SECRET)
    .update(`${method}\n${path}\n${expires}`)
    .digest("hex"));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const PRIVATE_IP_PATTERN = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|::1$|localhost$)/i;

export function validateExternalUrl(url: string, allowPrivate = false): string | null {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "Only http and https URLs are allowed";
    if (!allowPrivate && PRIVATE_IP_PATTERN.test(parsed.hostname)) return "URL points to a private or loopback address";
    return null; // valid
  } catch {
    return "Invalid URL";
  }
}

export function logChunk(output: string, request: RequestWithUrl): Uint8Array {
  const params = new URL(request.url).searchParams;
  const parsedOffset = Number.parseInt(params.get("offset") ?? "0", 10);
  const parsedLimit = Number.parseInt(params.get("limit") ?? "", 10);
  const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
  const bytes = Buffer.from(output);
  const limit = Number.isInteger(parsedLimit) && parsedLimit >= 0 ? parsedLimit : bytes.length;
  return bytes.subarray(offset, offset + limit);
}

/** Map VCS service provider identifier to human-readable display name */
export function serviceProviderDisplayName(provider: string): string {
  const map: Record<string, string> = {
    github: "GitHub",
    github_enterprise: "GitHub Enterprise",
    gitlab: "GitLab",
    gitlab_ce: "GitLab Community Edition",
    gitlab_ee: "GitLab Enterprise Edition",
    bitbucket: "Bitbucket Cloud",
    bitbucket_data_center: "Bitbucket Data Center",
    azure_devops_server: "Azure DevOps Server",
    ado_server: "Azure DevOps Server",
  };
  return map[provider] ?? provider;
}

export function parseTagBindings(data: unknown): { key: string; value: string }[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const bindings = new Map<string, { key: string; value: string }>();
  for (const item of data) {
    const i = item as Record<string, unknown> | null;
    if (i === null) return undefined;
    const attrs = i.attributes as Record<string, unknown> | undefined;
    const key = attrs?.key as string | undefined;
    const value = typeof attrs?.value === "string" ? attrs.value : "";
    if (i.type !== "tag-bindings" || typeof key !== "string" || key.trim() === "" || typeof value !== "string") {
      return undefined;
    }
    bindings.set(key.trim(), { key: key.trim(), value });
  }
  return [...bindings.values()];
}

export async function findLockedInheritedTagKey(
  orgId: string,
  projectId: string | null,
  keys: readonly string[],
): Promise<string | undefined> {
  if (projectId === null || keys.length === 0) return undefined;
  const matches = await db
    .select({ key: reservedTagKeys.key })
    .from(reservedTagKeys)
    .innerJoin(projectTags, eq(projectTags.key, reservedTagKeys.key))
    .where(and(
      eq(reservedTagKeys.orgId, orgId),
      eq(reservedTagKeys.disableOverrides, true),
      eq(projectTags.projectId, projectId),
      inArray(reservedTagKeys.key, [...new Set(keys)]),
    ))
    .limit(1);
  return matches[0]?.key;
}

export function workspaceRunHistoryWhere(request: RequestWithUrl, workspaceId: string): ReturnType<typeof and> {
  const params = new URL(request.url).searchParams;
  const csv = (name: string): string[] | undefined => params.get(name)?.split(",").map((value: string): string => value.trim()).filter((s: string): boolean => s !== "");
  const conditions: (ReturnType<typeof eq>         | ReturnType<typeof or>)[] = [eq(runs.workspaceId, workspaceId)];
  const statuses = csv("filter[status]");
  if (statuses !== undefined && statuses.length > 0) conditions.push(inArray(runs.status, statuses));

  const operations = csv("filter[operation]");
  if (operations !== undefined && operations.length > 0) {
    const destroy = operations.includes("destroy");
    const planAndApply = operations.includes("plan_and_apply");
    if (destroy !== planAndApply) conditions.push(eq(runs.isDestroy, destroy));
    else if (!destroy) conditions.push(sql`false`);
  }

  const sources = csv("filter[source]");
  if (sources !== undefined && sources.length > 0 && !sources.includes("tfe-api")) conditions.push(sql`false`);

  const statusGroup = params.get("filter[status_group]");
  if (statusGroup === "final") conditions.push(inArray(runs.status, FINAL_RUN_STATUSES));
  else if (statusGroup === "non_final") conditions.push(notInArray(runs.status, FINAL_RUN_STATUSES));
  else if (statusGroup === "discardable") conditions.push(inArray(runs.status, DISCARDABLE_RUN_STATUSES));
  else if (statusGroup !== null && statusGroup !== "") conditions.push(sql`false`);

  const timeframe = params.get("filter[timeframe]");
  if (timeframe === "year") {
    conditions.push(gte(runs.createdAt, Date.now() - 365 * 24 * 60 * 60 * 1000));
  } else if (timeframe !== null && /^\d{4}$/.test(timeframe)) {
    const year = Number(timeframe);
    conditions.push(gte(runs.createdAt, Date.UTC(year, 0, 1)));
    conditions.push(lt(runs.createdAt, Date.UTC(year + 1, 0, 1)));
  } else if (timeframe !== null && timeframe !== "") {
    conditions.push(sql`false`);
  }

  const basic = params.get("search[basic]")?.trim();
  if (basic !== undefined && basic !== "") conditions.push(or(like(runs.id, `%${basic}%`), like(runs.message, `%${basic}%`)));

  const userSearch = params.get("search[user]")?.trim();
  if (userSearch !== undefined && userSearch !== "") {
    const userMatches = db.select({ id: users.id }).from(users)
      .where(like(users.username, `%${userSearch}%`));
    conditions.push(inArray(runs.createdBy, userMatches));
  }

  const agentPoolNames = csv("filter[agent_pool_names]");
  if (agentPoolNames !== undefined && agentPoolNames.length > 0) {
    const matchingPools = db.select({ id: agentPools.id }).from(agentPools)
      .where(inArray(agentPools.name, agentPoolNames));
    const matchingWorkspaces = db.select({ id: workspaces.id }).from(workspaces)
      .where(inArray(workspaces.agentPoolId, matchingPools));
    conditions.push(inArray(runs.workspaceId, matchingWorkspaces));
  }

  const commitSearch = params.get("search[commit]")?.trim();
  if (commitSearch !== undefined && commitSearch !== "") {
    conditions.push(
      inArray(runs.id,
        db.select({ id: runs.id }).from(runs)
          .innerJoin(configurationVersions, eq(runs.configurationVersionId, configurationVersions.id))
          .where(sql`COALESCE(json_extract(${configurationVersions.ingressAttributes}, '$.commitSha'), '') LIKE ${`%${commitSearch}%`}`)
      )
    );
  }

  return and(...conditions);
}

export const FINAL_RUN_STATUSES = [
  "applied",
  "planned_and_finished",
  "discarded",
  "errored",
  "canceled",
  "force_canceled",
  "unreachable",
];
export const CAPACITY_PENDING_STATUSES = ["pending", "queuing", "plan_queued", "confirmed", "apply_queued"];
export const CAPACITY_RUNNING_STATUSES = [
  "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed",
  "planning", "cost_estimating", "cost_estimated", "policy_checking",
  "policy_override", "policy_checked", "post_plan_running", "post_plan_completed",
  "applying",
];
export const DISCARDABLE_RUN_STATUSES = [
  "planned",
  "planned_and_saved",
  "cost_estimated",
  "policy_checked",
  "policy_override",
  "post_plan_running",
  "post_plan_completed",
];

/**
 * Delete all data associated with a workspace.
 * Uses cascade-friendly approach: deletes logs, state_versions, CVs, variables, tags, etc. directly.
 * The workspace itself is deleted by the calling route.
 */
export async function deleteWorkspaceData(workspaceId: string): Promise<void> {
  // Runs cascade to logs, policy_checks, run_comments
  const runsToDelete = await db.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId), columns: { id: true } });
  const configurationArchives = await db.query.configurationVersions.findMany({
    where: eq(configurationVersions.workspaceId, workspaceId),
    columns: { archivePath: true },
  });
  await Promise.all(configurationArchives.map(async ({ archivePath }): Promise<void> => {
    if (archivePath !== null) await rm(archivePath, { force: true });
  }));
  for (const r of runsToDelete) {
    await Promise.all([deleteRunLogArchive(r.id), deletePlanJsonArtifact(r.id)]);
  }
  const runIds = runsToDelete.map((r): string => r.id);
  if (runIds.length > 0) await db.delete(logs).where(inArray(logs.runId, runIds));
  await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
  await db.delete(configurationVersions).where(eq(configurationVersions.workspaceId, workspaceId));
  await db.delete(workspaceVariables).where(eq(workspaceVariables.workspaceId, workspaceId));
  await db.delete(workspaceTags).where(eq(workspaceTags.workspaceId, workspaceId));
  await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
  await db.delete(dataRetentionPolicies).where(eq(dataRetentionPolicies.workspaceId, workspaceId));
  await db.delete(remoteStateConsumers).where(or(eq(remoteStateConsumers.workspaceId, workspaceId), eq(remoteStateConsumers.consumerWorkspaceId, workspaceId)));
  await db.delete(workspaceRunTasks).where(eq(workspaceRunTasks.workspaceId, workspaceId));
}

/**
 * Safely delete a workspace — only succeeds if workspace has no managed resources.
 * Returns true if deleted, false if workspace has resources.
 */
export async function safeDeleteWorkspace(workspaceId: string): Promise<boolean> {
  // Check if workspace has state versions with actual resources
  const relevantStates = await db.query.stateVersions.findMany({
    where: and(eq(stateVersions.workspaceId, workspaceId), eq(stateVersions.status, "finalized")),
    columns: { statePayload: true },
    orderBy: [desc(stateVersions.serial)],
    limit: 1,
  });
  if (relevantStates.length > 0) {
    const latest = relevantStates[0];
    if (latest !== undefined && typeof latest.statePayload === "string" && latest.statePayload !== "") {
      try {
        const parsed = JSON.parse(decodeStatePayload(latest.statePayload)) as Record<string, unknown>;
        // Check if state contains any resources
        const resources = parsed.resources;
        if (resources !== undefined && Array.isArray(resources) && resources.length > 0) {
          return false; // Has managed resources
        }
      } catch {
        // If we can't parse, err on the side of allowing deletion
      }
    }
  }
  await deleteWorkspaceData(workspaceId);
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  return true;
}

export async function promoteIntermediateStateVersion(workspaceId: string): Promise<string | null> {
  const snapshot = await db.query.stateVersions.findFirst({
    where: and(
      eq(stateVersions.workspaceId, workspaceId),
      eq(stateVersions.status, "finalized"),
      eq(stateVersions.intermediate, true),
    ),
    orderBy: [desc(stateVersions.serial)],
    columns: { id: true },
  });
  if (snapshot === undefined) return null;
  await db.update(stateVersions).set({ intermediate: false }).where(eq(stateVersions.id, snapshot.id));
  return snapshot.id;
}

async function removeConfigurationArchive(archivePath: string | null): Promise<boolean> {
  if (archivePath === null) return false;
  try {
    await access(archivePath);
  } catch {
    return false;
  }
  await rm(archivePath, { force: true });
  return true;
}

/**
 * Apply data retention garbage collection for a workspace.
 * Two-phase lifecycle:
 *   1. Eligible backing data → backing_data_soft_deleted
 *   2. Backing data whose grace period elapsed → permanently deleted
 */
export async function applyDataRetentionGarbageCollection(
  workspaceId: string,
  options: Readonly<{ now?: number; gracePeriodMs?: number }> = {},
): Promise<Record<string, unknown>> {
  const now = options.now ?? Date.now();
  const configuredGraceDays = Number(process.env.GC_GRACE_PERIOD_DAYS ?? 7);
  const defaultGracePeriodMs = Number.isFinite(configuredGraceDays) && configuredGraceDays >= 0
    ? configuredGraceDays * 86_400_000
    : 7 * 86_400_000;
  const graceCutoff = now - (options.gracePeriodMs ?? defaultGracePeriodMs);

  const [workspacePolicy, workspace] = await Promise.all([
    db.query.dataRetentionPolicies.findFirst({ where: eq(dataRetentionPolicies.workspaceId, workspaceId) }),
    db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { orgId: true } }),
  ]);
  const organizationPolicy = workspacePolicy === undefined && workspace !== undefined
    ? await db.query.organizationDataRetentionPolicies.findFirst({
      where: eq(organizationDataRetentionPolicies.organizationId, workspace.orgId),
    })
    : undefined;
  const policy = workspacePolicy ?? organizationPolicy;
  const policySource = workspacePolicy !== undefined
    ? "workspace"
    : organizationPolicy !== undefined
      ? "organization"
      : null;

  const [finalizedVersions, softDeletedVersions, retainedConfigurationVersions, softDeletedConfigurationVersions, workspaceRuns] = await Promise.all([
    db.query.stateVersions.findMany({
      where: and(eq(stateVersions.workspaceId, workspaceId), eq(stateVersions.status, "finalized")),
      orderBy: [desc(stateVersions.serial)],
      columns: { id: true, createdAt: true, intermediate: true },
    }),
    db.query.stateVersions.findMany({
      where: and(eq(stateVersions.workspaceId, workspaceId), eq(stateVersions.status, "backing_data_soft_deleted")),
      columns: { id: true, softDeletedAt: true },
    }),
    db.query.configurationVersions.findMany({
      where: and(
        eq(configurationVersions.workspaceId, workspaceId),
        inArray(configurationVersions.status, ["uploaded", "archived"]),
      ),
      orderBy: [desc(configurationVersions.createdAt)],
      columns: { id: true, createdAt: true },
    }),
    db.query.configurationVersions.findMany({
      where: and(eq(configurationVersions.workspaceId, workspaceId), eq(configurationVersions.status, "backing_data_soft_deleted")),
      columns: { id: true, archivePath: true, softDeletedAt: true },
    }),
    db.query.runs.findMany({
      where: eq(runs.workspaceId, workspaceId),
      orderBy: [desc(runs.createdAt)],
      columns: { id: true, status: true, createdAt: true, configurationVersionId: true, softDeletedAt: true },
    }),
  ]);

  const staleStateVersions = softDeletedVersions.filter(({ softDeletedAt }): boolean =>
    typeof softDeletedAt === "number" && softDeletedAt <= graceCutoff
  );
  if (staleStateVersions.length > 0) {
    await db.delete(stateVersions).where(inArray(stateVersions.id, staleStateVersions.map((v): string => v.id)));
  }
  const softDeletedStateVersionIds = softDeletedVersions
    .filter(({ softDeletedAt }): boolean => softDeletedAt === null)
    .map((v): string => v.id);
  if (softDeletedStateVersionIds.length > 0) {
    await db.update(stateVersions).set({ softDeletedAt: now }).where(inArray(stateVersions.id, softDeletedStateVersionIds));
  }

  const staleConfigurationVersions = softDeletedConfigurationVersions.filter(({ softDeletedAt }): boolean =>
    typeof softDeletedAt === "number" && softDeletedAt <= graceCutoff
  );
  let archivesDeleted = 0;
  const staleConfigVersionIds: string[] = [];
  for (const configurationVersion of staleConfigurationVersions) {
    if (await removeConfigurationArchive(configurationVersion.archivePath)) archivesDeleted += 1;
    staleConfigVersionIds.push(configurationVersion.id);
  }
  if (staleConfigVersionIds.length > 0) {
    await db.update(configurationVersions).set({
      archivePath: null,
      status: "backing_data_permanently_deleted",
    }).where(inArray(configurationVersions.id, staleConfigVersionIds));
  }
  const softDeletedConfigVersionIds = softDeletedConfigurationVersions
    .filter(({ softDeletedAt }): boolean => softDeletedAt === null)
    .map((v): string => v.id);
  if (softDeletedConfigVersionIds.length > 0) {
    await db.update(configurationVersions).set({ softDeletedAt: now }).where(inArray(configurationVersions.id, softDeletedConfigVersionIds));
  }

  const staleRuns = workspaceRuns.filter(({ status, softDeletedAt }): boolean =>
    FINAL_RUN_STATUSES.includes(status)
    && typeof softDeletedAt === "number"
    && softDeletedAt <= graceCutoff
  );
  let runArchivesDeleted = 0;
  const staleRunIds: string[] = [];
  for (const run of staleRuns) {
    const [logsDeleted] = await Promise.all([
      deleteRunLogArchive(run.id),
      deletePlanJsonArtifact(run.id),
    ]);
    if (logsDeleted) runArchivesDeleted += 1;
    staleRunIds.push(run.id);
  }
  if (staleRunIds.length > 0) await db.delete(runs).where(inArray(runs.id, staleRunIds));
  const retainedRuns = workspaceRuns.filter(({ id }): boolean =>
    !staleRuns.some((staleRun): boolean => staleRun.id === id)
  );

  const summary = {
    softDeleted: 0,
    permanentlyDeleted: staleStateVersions.length,
    configurationVersions: {
      softDeleted: 0,
      permanentlyDeleted: staleConfigurationVersions.length,
      archivesDeleted,
    },
    runs: {
      softDeleted: 0,
      permanentlyDeleted: staleRuns.length,
      archivesDeleted: runArchivesDeleted,
    },
    logsDeleted: 0,
    reason: policy === undefined ? "no-policy" : "retention-applied",
    policySource,
  };
  if (policy === undefined) {
    return {
      ...summary,
      reason: staleStateVersions.length + staleConfigurationVersions.length + staleRuns.length > 0 ? "cleanup" : "no-policy",
    };
  }

  const currentStateVersionId = finalizedVersions.find(({ intermediate }): boolean => !intermediate)?.id;
  const stateVersionIds = new Set<string>();
  if (typeof policy.stateVersionsCount === "number" && policy.stateVersionsCount > 0) {
    for (const stateVersion of finalizedVersions.slice(policy.stateVersionsCount)) {
      if (stateVersion.id !== currentStateVersionId) stateVersionIds.add(stateVersion.id);
    }
  }

  const retentionCutoff = typeof policy.deleteOlderThanNDays === "number" && policy.deleteOlderThanNDays > 0
    ? now - policy.deleteOlderThanNDays * 86_400_000
    : null;
  if (retentionCutoff !== null) {
    for (const stateVersion of finalizedVersions) {
      if (stateVersion.id !== currentStateVersionId && stateVersion.createdAt <= retentionCutoff) {
        stateVersionIds.add(stateVersion.id);
      }
    }
  }
  if (stateVersionIds.size > 0) {
    await db.update(stateVersions).set({
      status: "backing_data_soft_deleted",
      softDeletedAt: now,
    }).where(inArray(stateVersions.id, [...stateVersionIds]));
  }

  const currentConfigurationVersionId = retainedConfigurationVersions[0]?.id;
  const protectedConfigurationVersionIds = new Set<string>([
    ...(currentConfigurationVersionId === undefined ? [] : [currentConfigurationVersionId]),
    ...retainedRuns.flatMap(({ status, configurationVersionId }): string[] =>
      configurationVersionId !== null && !FINAL_RUN_STATUSES.includes(status)
        ? [configurationVersionId]
        : []
    ),
  ]);
  const configurationVersionIds = retentionCutoff === null
    ? []
    : retainedConfigurationVersions
      .filter(({ id, createdAt }): boolean => !protectedConfigurationVersionIds.has(id) && createdAt <= retentionCutoff)
      .map(({ id }): string => id);
  if (configurationVersionIds.length > 0) {
    await db.update(configurationVersions).set({
      status: "backing_data_soft_deleted",
      softDeletedAt: now,
    }).where(inArray(configurationVersions.id, configurationVersionIds));
  }

  const expiredRunIds = retentionCutoff === null
    ? []
    : retainedRuns
      .filter(({ status, createdAt, softDeletedAt }): boolean =>
        FINAL_RUN_STATUSES.includes(status) && softDeletedAt === null && createdAt <= retentionCutoff
      )
      .map(({ id }): string => id);
  const expiredLogs = expiredRunIds.length === 0
    ? []
    : await db.query.logs.findMany({ where: inArray(logs.runId, expiredRunIds), columns: { id: true } });
  const logsArchived = (await Promise.all(expiredRunIds.map(archiveRunLogs))).filter(Boolean).length;
  if (expiredRunIds.length > 0) await db.delete(logs).where(inArray(logs.runId, expiredRunIds));
  if (expiredRunIds.length > 0) {
    await db.update(runs).set({ softDeletedAt: now }).where(inArray(runs.id, expiredRunIds));
  }

  return {
    ...summary,
    softDeleted: stateVersionIds.size,
    configurationVersions: {
      ...summary.configurationVersions,
      softDeleted: configurationVersionIds.length,
    },
    runs: {
      ...summary.runs,
      softDeleted: expiredRunIds.length,
    },
    logsDeleted: expiredLogs.length,
    logsArchived,
    count: finalizedVersions.length,
    limit: policy.stateVersionsCount,
    "delete-older-than-n-days": policy.deleteOlderThanNDays,
  };
}
