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
import { and, desc, eq, exists, gte, inArray, isNull, like, lt, notInArray, or, sql } from "drizzle-orm";
import { timingSafeEqual, createHmac } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { recordFailure } from "./process-metrics";
import { log } from "./log";
import { isDiskFullError, markStorageDegraded } from "./storage-health";
import { jsonExtract } from "./db-json";
import { validateVersion } from "../binaryManager";
import { decodeStatePayload, parseStatePayload } from "./validation";
import { privateHostReason } from "./url-safety";
import { archiveRunLogs, deleteRunLogArchive } from "./run-logs";
import { deletePlanJsonArtifact } from "./plan-json";
import { currentSiteAdmin, currentTokenScopes, requestCacheGet, requestCacheSet } from "./request-scope";
import {
  scopeGrants,
  scopeCoversOrg,
  evaluateTagExpression,
  type WorkspacePermissionGrant,
  type TokenScopes,
} from "./token-scopes";

export { validateVersion, decodeStatePayload, parseStatePayload };

export type DeepReadonly<T> =
  T extends (...args: infer _Args) => infer _Return
    ? T
    : T extends boolean | number | string | symbol | bigint | null | undefined
      ? T
      : T extends ReadonlySet<infer Item>
        ? ReadonlySet<DeepReadonly<Item>>
        : T extends readonly (infer Item)[]
          ? readonly DeepReadonly<Item>[]
          : T extends object
            ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
            : T;

const PUBLIC_URL = typeof process.env.PUBLIC_URL === "string" && process.env.PUBLIC_URL !== "" ? new URL(process.env.PUBLIC_URL) : null;

/** Minimal Elysia `set` shape shared by JSON:API error helpers. */
export type ErrorSet = { status?: number | string };

export type JsonApiErrorBody = { errors: { status: string; title: string; detail?: string }[] };

export function errorBody(status: number, title: string, detail?: string): JsonApiErrorBody {
  return { errors: [{ status: String(status), title, ...(detail === undefined ? {} : { detail }) }] };
}

/** JSON:API error response that also sets the HTTP status. */
export function apiError(set: ErrorSet, status: number, title: string, detail?: string): JsonApiErrorBody {
  set.status = status;
  return errorBody(status, title, detail);
}

export function notFound(set?: ErrorSet): JsonApiErrorBody {
  if (set !== undefined) set.status = 404;
  return errorBody(404, "Not Found");
}

export function forbidden(set?: ErrorSet): JsonApiErrorBody {
  if (set !== undefined) set.status = 403;
  return errorBody(403, "Forbidden");
}

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
    } catch (error: unknown) {
      if (isDiskFullError(error)) markStorageDegraded("audit log writes are failing (disk full)");
      recordFailure("auditWrites");
      log.error("Audit log write failed", {
        action,
        resourceType,
        resourceId,
        orgId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
}

/**
 * Strict audit mode (kanban 12.16): when AUDIT_STRICT=1, operations that
 * touch especially sensitive material (token minting, SSH key material,
 * sensitive variable reads) are recorded in the audit log in addition to
 * the unconditional entries (e.g. raw state downloads). Defaults off so
 * self-hosters on constrained storage are not surprised by extra rows.
 */
export function strictAuditEnabled(): boolean {
  const v = process.env.AUDIT_STRICT;
  return v === "1" || v === "true";
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
  const facts = await loadMembershipFacts(userId, orgId);
  if (facts.isOwner) return true;
  if (!facts.isMember) return false;
  if (requiredRole === "owner" && facts.membership?.role !== "owner") return false;
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
    // Reuse the read-workspaces cascade (manage-workspaces, read-projects,
    // manage-projects, manage-agent-pools, manage-policy-overrides) instead
    // of duplicating a partial copy of it.
    return teamOrganizationAllows(access, "read-workspaces") || access["manage-varsets"] === true;
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

/**
 * The org-level access facts one principal has inside one org: ownership,
 * membership, direct-role grants and team roster. Loaded once per batched
 * permission evaluation so handlers that render many org permissions (org
 * detail evaluates ~9) read the base once and derive the rest in memory.
 */
type OrgAccessDetails = {
  readonly isOwner: boolean;
  readonly isMember: boolean;
  readonly directRoles: readonly (typeof organizationRoles.$inferSelect)[];
  readonly teamIds: readonly string[];
  readonly userTeams: readonly (typeof teams.$inferSelect)[];
}

/**
 * Read a user's org-membership facts in ONE pass (mirrors the owner/member
 * semantics of checkOrgPermission, which fetches the same two rows). Reads
 * are scope-independent, so this runs with token scopes suspended.
 *
 * Memoized per request: the same facts are needed by checkOrgPermission,
 * checkOrganizationPermission, and workspacePermissionSets, which previously
 * re-queried users + organization_memberships up to 3x per request.
 */
async function loadMembershipFacts(
  userId: string,
  orgId: string,
): Promise<{ readonly isOwner: boolean; readonly isMember: boolean; readonly membership: (typeof organizationMemberships.$inferSelect) | undefined }> {
  const key = `membership:${userId}:${orgId}`;
  const cached = requestCacheGet<Promise<Awaited<ReturnType<typeof loadMembershipFactsUncached>>>>(key);
  if (cached !== undefined) return cached;
  // Cache the IN-FLIGHT promise so concurrent callers (e.g. permission levels
  // evaluated inside a Promise.all) share one computation instead of racing.
  const value = loadMembershipFactsUncached(userId, orgId);
  requestCacheSet(key, value);
  return value;
}

async function loadMembershipFactsUncached(
  userId: string,
  orgId: string,
): Promise<{ readonly isOwner: boolean; readonly isMember: boolean; readonly membership: (typeof organizationMemberships.$inferSelect) | undefined }> {
  // The auth derive already loaded the full user row (joined token lookup), so
  // its site-admin flag is in the request cache — skip the duplicate users read.
  const knownSiteAdmin = currentSiteAdmin(userId);
  const [user, membership] = await Promise.all([
    knownSiteAdmin !== undefined
      ? Promise.resolve({ isSiteAdmin: knownSiteAdmin })
      : db.query.users.findFirst({ where: eq(users.id, userId), columns: { isSiteAdmin: true } }),
    db.query.organizationMemberships.findFirst({
      where: and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.orgId, orgId)),
    }),
  ]);
  if (user?.isSiteAdmin === true) return { isOwner: true, isMember: true, membership: undefined };
  if (membership?.status !== "active") return { isOwner: false, isMember: false, membership };
  return { isOwner: membership.role === "owner", isMember: true, membership };
}

/**
 * Load a user's teams + team workspaces within an org in 3 reads (shared by
 * the org-access and workspace-access loaders). Memoized per request for the
 * same reason as loadMembershipFacts.
 */
/**
 * Load the user's team roster (membership -> team rows) WITHOUT workspace-level
 * access. Org/project-only request paths call this so they never pay for the
 * (potentially large) team_workspaces read that `loadWorkspaceAccessBase`
 * needs and `loadOrgAccessDetails` discards.
 */
async function loadUserTeamRoster(
  orgId: string,
  userId: string,
): Promise<{
  readonly teamIds: readonly string[];
  readonly userTeams: readonly (typeof teams.$inferSelect)[];
}> {
  const key = `teamRoster:${userId}:${orgId}`;
  const cached = requestCacheGet<Promise<Awaited<ReturnType<typeof loadUserTeamRosterUncached>>>>(key);
  if (cached !== undefined) return cached;
  const value = loadUserTeamRosterUncached(orgId, userId);
  requestCacheSet(key, value);
  return value;
}

async function loadUserTeamRosterUncached(
  orgId: string,
  userId: string,
): Promise<{
  readonly teamIds: readonly string[];
  readonly userTeams: readonly (typeof teams.$inferSelect)[];
}> {
  const memberships = await db.query.teamMemberships.findMany({
    where: eq(teamMemberships.userId, userId),
  });
  const teamIds = memberships.map((membership): string => membership.teamId);
  if (teamIds.length === 0) return { teamIds, userTeams: [] };
  const userTeams = await db.query.teams.findMany({ where: and(eq(teams.orgId, orgId), inArray(teams.id, teamIds)) });
  return { teamIds, userTeams };
}

async function loadUserTeamAccess(
  orgId: string,
  userId: string,
): Promise<{
  readonly teamIds: readonly string[];
  readonly teamWorkspaces: readonly (typeof teamWorkspaces.$inferSelect)[];
  readonly userTeams: readonly (typeof teams.$inferSelect)[];
}> {
  const key = `teamAccess:${userId}:${orgId}`;
  const cached = requestCacheGet<Promise<Awaited<ReturnType<typeof loadUserTeamAccessUncached>>>>(key);
  if (cached !== undefined) return cached;
  const value = loadUserTeamAccessUncached(orgId, userId);
  requestCacheSet(key, value);
  return value;
}

async function loadUserTeamAccessUncached(
  orgId: string,
  userId: string,
): Promise<{
  readonly teamIds: readonly string[];
  readonly teamWorkspaces: readonly (typeof teamWorkspaces.$inferSelect)[];
  readonly userTeams: readonly (typeof teams.$inferSelect)[];
}> {
  const { teamIds, userTeams } = await loadUserTeamRoster(orgId, userId);
  if (teamIds.length === 0) return { teamIds, teamWorkspaces: [], userTeams };
  const accesses = await db.query.teamWorkspaces.findMany({ where: inArray(teamWorkspaces.teamId, teamIds) });
  return { teamIds, teamWorkspaces: accesses, userTeams };
}

async function loadOrgAccessDetails(orgId: string, userId: string): Promise<OrgAccessDetails> {
  const key = `orgAccess:${userId}:${orgId}`;
  const cached = requestCacheGet<Promise<OrgAccessDetails>>(key);
  if (cached !== undefined) return cached;
  const value = loadOrgAccessDetailsUncached(orgId, userId);
  requestCacheSet(key, value);
  return value;
}

async function loadOrgAccessDetailsUncached(orgId: string, userId: string): Promise<OrgAccessDetails> {
  const facts = await loadMembershipFacts(userId, orgId);
  let directRoles: OrgAccessDetails["directRoles"] = [];
  let teamIds: OrgAccessDetails["teamIds"] = [];
  let userTeams: OrgAccessDetails["userTeams"] = [];
  if (!facts.isOwner && facts.isMember) {
    const teamAccess = loadUserTeamRoster(orgId, userId);
    // Direct-role grants and the team roster are independent of each other.
    const roleResult = (async (): Promise<OrgAccessDetails["directRoles"]> => {
      if (facts.membership === undefined) return [];
      const assigned = await db.query.organizationMembershipRoles.findMany({
        where: eq(organizationMembershipRoles.membershipId, facts.membership.id),
      });
      if (assigned.length === 0) return [];
      return db.query.organizationRoles.findMany({
        where: inArray(organizationRoles.id, assigned.map((item): string => item.roleId)),
      });
    })();
    const [roles, teamData] = await Promise.all([roleResult, teamAccess]);
    directRoles = roles;
    teamIds = teamData.teamIds;
    userTeams = teamData.userTeams;
  }
  return { isOwner: facts.isOwner, isMember: facts.isMember, directRoles, teamIds, userTeams };
}

/** Evaluate one org permission against access details (pure). */
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- access-facts types carry mutable element types but are treated as read-only here.
function deriveOrgAccessAllows(details: OrgAccessDetails, required: OrganizationPermission): boolean {
  if (details.isOwner) return true;
  if (!details.isMember) return false;
  if (details.directRoles.some((role): boolean => teamOrganizationAllows(role.permissions ?? {}, required))) return true;
  if (details.teamIds.length === 0) return false;
  return details.userTeams.some((team): boolean => teamOrganizationAllows(team.organizationAccess, required));
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
  const details = await loadOrgAccessDetails(orgId, userId);
  return deriveOrgAccessAllows(details, required);
}

/**
 * Evaluate MANY org permissions for the same principal in one access-details
 * load. Handlers that render a permission matrix (org detail computes ~9
 * flags) otherwise re-read the same membership/team rows once per flag.
 * Semantics match calling `checkOrganizationPermission` per entry.
 */
export async function checkOrganizationPermissionsMany(
  orgId: string,
  userId: string | undefined,
  tokenOrgId: string | null | undefined,
  tokenTeamId: string | null | undefined,
  requireds: readonly OrganizationPermission[],
): Promise<boolean[]> {
  const scopes = currentTokenScopes();
  // Fine-grained scope gate applies on every branch (same as the single
  // helper). Hoisted so an out-of-scope org short-circuits before any DB read.
  if (scopes !== null && !scopeCoversOrg(scopes, orgId)) return requireds.map((): boolean => false);
  const scopeDenies = (required: OrganizationPermission): boolean => {
    if (scopes === null) return false;
    const grant = organizationPermissionGrant(required);
    return grant !== null && !scopeGrants(scopes, grant);
  };
  if (tokenOrgId !== null && tokenOrgId !== undefined) {
    const base = tokenOrgId === orgId;
    return requireds.map((required): boolean => base && !scopeDenies(required));
  }
  if (tokenTeamId !== null && tokenTeamId !== undefined) {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, tokenTeamId) });
    if (team === undefined || team.orgId !== orgId) return requireds.map((): boolean => false);
    return requireds.map((required): boolean =>
      !scopeDenies(required) && teamOrganizationAllows(team.organizationAccess, required));
  }
  if (userId === undefined) return requireds.map((): boolean => false);
  const details = await loadOrgAccessDetails(orgId, userId);
  return requireds.map((required): boolean => !scopeDenies(required) && deriveOrgAccessAllows(details, required));
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
export async function scopeWorkspaceIdsForOrg(scope: TokenScopes, orgId: string): Promise<readonly string[] | null> {
  if (!scopeCoversOrg(scope, orgId)) return [];

  const projectRestriction = scope.projects !== null;
  const workspaceRestriction = scope.workspaces !== null;
  const tagRestriction = scope.tags !== null && scope.tags.rules.length > 0;
  if (!projectRestriction && !workspaceRestriction && !tagRestriction) return null;

  // Gather matching workspace IDs.
  const matching = new Set<string>();

  if (projectRestriction && scope.projects.length > 0) {
    const rows = await db.query.workspaces.findMany({
      where: and(
        eq(workspaces.orgId, orgId),
        inArray(workspaces.projectId, scope.projects as string[]),
      ),
      columns: { id: true },
    });
    for (const row of rows) matching.add(row.id);
  }

  if (workspaceRestriction && scope.workspaces.length > 0) {
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
      // Evaluate every org workspace, including tagless ones (empty tag set).
      for (const workspaceId of orgWorkspaceIds) {
        if (evaluateTagExpression(scope.tags, tagsByWorkspace.get(workspaceId) ?? new Set<string>())) {
          matching.add(workspaceId);
        }
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

/**
 * Everything a permission derivation needs to know about a principal's
 * workspace access. Loading this base once per batched evaluation turns the
 * 10-permission-level workspace handlers into one set of DB reads plus
 * in-memory derivations.
 */
type WorkspaceAccessBase = {
  readonly orgId: string;
  readonly userId: string | undefined;
  readonly tokenOrgId: string | null;
  readonly tokenTeamId: string | null;
  readonly tokenTeam: (typeof teams.$inferSelect) | null;
  readonly tokenTeamWorkspaces: readonly (typeof teamWorkspaces.$inferSelect)[];
  readonly isOwner: boolean;
  readonly isMember: boolean;
  readonly userTeamData: {
    readonly teamIds: readonly string[];
    readonly teamWorkspaces: readonly (typeof teamWorkspaces.$inferSelect)[];
    readonly userTeams: readonly (typeof teams.$inferSelect)[];
  } | null;
}

async function loadWorkspaceAccessBase(
  orgId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
): Promise<WorkspaceAccessBase> {
  const key = `workspaceAccess:${orgId}:${userId ?? "-"}:${tokenOrgId ?? "-"}:${tokenTeamId ?? "-"}`;
  const cached = requestCacheGet<Promise<WorkspaceAccessBase>>(key);
  if (cached !== undefined) return cached;
  const value = loadWorkspaceAccessBaseUncached(orgId, userId, tokenOrgId, tokenTeamId);
  requestCacheSet(key, value);
  return value;
}

async function loadWorkspaceAccessBaseUncached(
  orgId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
): Promise<WorkspaceAccessBase> {
  if (tokenTeamId !== null) {
    const [team, accesses] = await Promise.all([
      db.query.teams.findFirst({ where: eq(teams.id, tokenTeamId) }),
      db.query.teamWorkspaces.findMany({ where: eq(teamWorkspaces.teamId, tokenTeamId) }),
    ]);
    return {
      orgId,
      userId,
      tokenOrgId,
      tokenTeamId,
      tokenTeam: team ?? null,
      tokenTeamWorkspaces: accesses,
      isOwner: false,
      isMember: false,
      userTeamData: null,
    };
  }
  if (tokenOrgId !== null) {
    return {
      orgId,
      userId,
      tokenOrgId,
      tokenTeamId: null,
      tokenTeam: null,
      tokenTeamWorkspaces: [],
      isOwner: false,
      isMember: false,
      userTeamData: null,
    };
  }
  if (userId === undefined) {
    return {
      orgId,
      userId,
      tokenOrgId: null,
      tokenTeamId: null,
      tokenTeam: null,
      tokenTeamWorkspaces: [],
      isOwner: false,
      isMember: false,
      userTeamData: null,
    };
  }
  // The base describes the user's UNDERLYING access, so membership facts are
  // loaded with token scopes suspended (a fine-grained token must never
  // shrink the base it intersects with — the scope narrows it later).
  const facts = await loadMembershipFacts(userId, orgId);
  let userTeamData: WorkspaceAccessBase["userTeamData"] = null;
  if (!facts.isOwner && facts.isMember) {
    const { teamIds, teamWorkspaces, userTeams } = await loadUserTeamAccess(orgId, userId);
    userTeamData = { teamIds, teamWorkspaces, userTeams };
  }
  return {
    orgId,
    userId,
    tokenOrgId: null,
    tokenTeamId: null,
    tokenTeam: null,
    tokenTeamWorkspaces: [],
    isOwner: facts.isOwner,
    isMember: facts.isMember,
    userTeamData,
  };
}

/**
 * Derive one permission level's workspace-ID set from a loaded access base.
 * Pure in-memory; mirrors the exact early-return semantics of the original
 * single-level implementation so behavior is unchanged.
 */
function deriveWorkspaceIdsForRequired(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- access-base type carries mutable element types but is treated as read-only here.
  base: WorkspaceAccessBase,
  required: WorkspacePermission,
): readonly string[] | null {
  if (base.tokenTeamId !== null) {
    const team = base.tokenTeam;
    if (team === null || team.orgId !== base.orgId) return [];
    if (teamOrganizationAllows(team.organizationAccess, "manage-workspaces")) return null;
    if (required === "read" && team.organizationAccess["manage-policies"] === true) return null;
    if (required === "policy-override" && team.organizationAccess["manage-policy-overrides"] === true) return null;
    if (["read", "run-read", "variables-read", "state-outputs", "state-read"].includes(required)
      && teamOrganizationAllows(team.organizationAccess, "read-workspaces")) return null;
    const delegateTeamIds = required === "policy-override"
      ? new Set(teamOverrideDelegationActive(team) ? [team.id] : [])
      : null;
    return [...new Set(base.tokenTeamWorkspaces
      .filter((entry): boolean =>
        teamWorkspaceAllows(entry.access, entry.permissions, required)
        && (delegateTeamIds === null || delegateTeamIds.has(entry.teamId)))
      .map((entry): string => entry.workspaceId))];
  }
  if (base.tokenOrgId !== null) {
    if (base.tokenOrgId !== base.orgId || ["plan", "apply", "policy-override"].includes(required)) return [];
    return null;
  }
  if (base.userId === undefined) return [];
  if (base.isOwner) return null;
  if (!base.isMember) return [];
  const teamData = base.userTeamData;
  if (teamData === null || teamData.teamIds.length === 0) return [];
  if (teamData.userTeams.some((team): boolean => teamOrganizationAllows(team.organizationAccess, "manage-workspaces"))) return null;
  if (required === "read" && teamData.userTeams.some((team): boolean => team.organizationAccess["manage-policies"] === true)) return null;
  if (required === "policy-override" && teamData.userTeams.some((team): boolean => team.organizationAccess["manage-policy-overrides"] === true)) return null;
  if (["read", "run-read", "variables-read", "state-outputs", "state-read"].includes(required)
    && teamData.userTeams.some((team): boolean => teamOrganizationAllows(team.organizationAccess, "read-workspaces"))) return null;
  const delegateTeamIds = required === "policy-override"
    ? new Set(teamData.userTeams
      .filter((t: DeepReadonly<typeof teams.$inferSelect>): boolean => teamOverrideDelegationActive(t))
      .map((t: DeepReadonly<typeof teams.$inferSelect>): string => t.id))
    : null;
  return [...new Set(teamData.teamWorkspaces
    .filter((entry): boolean =>
      teamWorkspaceAllows(entry.access, entry.permissions, required)
      && (delegateTeamIds === null || delegateTeamIds.has(entry.teamId)))
    .map((entry): string => entry.workspaceId))];
}

/**
 * Whether a team's policy-override delegation grant is currently effective
 * (kanban 18.7). The grant must be requested AND, when the team carries an
 * explicit delegation expiry, must not have lapsed. Expiry is stored as
 * epoch-millis; null/undefined/0 means no expiry (permanent grant), matching
 * the pre-existing semantics before time-bounded delegations existed.
 */
function teamOverrideDelegationActive(
  team: Readonly<{ organizationAccess?: Record<string, boolean> | null; policyOverrideDelegationExpiresAt?: number | null }>,
): boolean {
  if (team.organizationAccess?.["delegate-policy-overrides"] !== true) return false;
  const expiresAt = team.policyOverrideDelegationExpiresAt;
  if (expiresAt === undefined || expiresAt === null || expiresAt === 0) return true;
  return Date.now() < expiresAt;
}

async function workspaceIdsForPermissionUnscoped(
  orgId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
  required: WorkspacePermission,
): Promise<readonly string[] | null> {
  const base = await loadWorkspaceAccessBase(orgId, userId, tokenOrgId, tokenTeamId);
  return deriveWorkspaceIdsForRequired(base, required);
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
    const base = await workspaceIdsForPermissionUnscoped(orgId, userId, tokenOrgId, tokenTeamId, required);
    if (base === null) return scopeIds; // user has org-wide access; scope narrows
    if (scopeIds === null) return base; // scope covers all; user's own access applies
    const scopeSet = new Set(scopeIds);
    return base.filter((id): boolean => scopeSet.has(id));
  }
  return workspaceIdsForPermissionUnscoped(orgId, userId, tokenOrgId, tokenTeamId, required);
}

/** The ten permission levels the workspace resource builders need. */
export type WorkspacePermissionSets = {
  read: ReadonlySet<string> | null;
  plan: ReadonlySet<string> | null;
  apply: ReadonlySet<string> | null;
  lock: ReadonlySet<string> | null;
  admin: ReadonlySet<string> | null;
  variablesWrite: ReadonlySet<string> | null;
  variablesRead: ReadonlySet<string> | null;
  stateRead: ReadonlySet<string> | null;
  stateWrite: ReadonlySet<string> | null;
  runTasks: ReadonlySet<string> | null;
}

const PERMISSION_SET_LEVELS: readonly { readonly key: keyof WorkspacePermissionSets; readonly permission: WorkspacePermission }[] = [
  { key: "read", permission: "read" },
  { key: "plan", permission: "plan" },
  { key: "apply", permission: "apply" },
  { key: "lock", permission: "lock" },
  { key: "admin", permission: "admin" },
  { key: "variablesWrite", permission: "variables-write" },
  { key: "variablesRead", permission: "variables-read" },
  { key: "stateRead", permission: "state-read" },
  { key: "stateWrite", permission: "state-write" },
  { key: "runTasks", permission: "run-tasks" },
];

/**
 * Compute every permission level for an org in ONE access-base load (plus one
 * scope resolution for fine-grained tokens). Use this in handlers that need
 * several levels (workspace lists); single-level callers should keep using
 * `workspaceIdsForPermission`. Returns ReadonlySets for O(1) membership tests.
 */
export async function workspacePermissionSets(
  orgId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
): Promise<WorkspacePermissionSets> {
  const scopes = currentTokenScopes();
  const base = await loadWorkspaceAccessBase(orgId, userId, tokenOrgId, tokenTeamId);
  const scopeIds = scopes !== null ? await scopeWorkspaceIdsForOrg(scopes, orgId) : null;
  const scopeSet = scopeIds === null ? null : new Set(scopeIds);
  const sets = {} as Partial<WorkspacePermissionSets>;
  for (const { key, permission } of PERMISSION_SET_LEVELS) {
    if (scopes !== null) {
      const grants = workspacePermissionGrant(permission);
      if (grants.length === 0 || !grants.some((grant): boolean => scopeGrants(scopes, grant))) {
        sets[key] = new Set<string>();
        continue;
      }
    }
    const derived = deriveWorkspaceIdsForRequired(base, permission);
    if (derived === null) {
      sets[key] = scopes !== null && scopeIds !== null ? new Set(scopeIds) : null;
      continue;
    }
    sets[key] = scopes !== null && scopeIds !== null && scopeSet !== null
      ? new Set(derived.filter((id): boolean => scopeSet.has(id)))
      : new Set(derived);
  }
  // Checked build: every declared level must be assigned (a silent undefined
  // would make workspaceAllows return false for that level).
  for (const { key } of PERMISSION_SET_LEVELS) {
    if (sets[key] === undefined) {
      throw new Error(`workspacePermissionSets failed to compute level "${key}"`);
    }
  }
  return sets as WorkspacePermissionSets;
}

/** Convenience: null (unrestricted) or the set contains the workspace. */
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- ReadonlySet is immutable; the rule mis-flags it in a null-union.
export function workspaceAllows(set: ReadonlySet<string> | null, workspaceId: string): boolean {
  return set === null || set.has(workspaceId);
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

/** Run-principal scopes (the reference format run-token model). A run token can read registry
 * modules produced by ITS OWN organization, and nothing else. */
export type RunPrincipal = Readonly<{
  runId: string;
  workspaceId: string;
  organizationId: string;
}>;

export function checkRunRegistryRead(run: RunPrincipal | null | undefined, producerOrgId: string): boolean {
  return run !== null && run !== undefined && run.organizationId === producerOrgId;
}

export function checkRunStateAccess(run: RunPrincipal | null | undefined, workspaceId: string): boolean {
  return run !== null && run !== undefined && run.workspaceId === workspaceId;
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
  if (!Array.isArray(data)) return undefined;
  const items = data;
  if (items.some((item: unknown): boolean => !isJsonApiData(item, "workspaces"))) return undefined;
  // JSON:API: an explicit empty array is a no-op add/remove, not an error
  // (the reference format accepts data: [] on relationship add/remove). Missing data or
  // malformed items still reject.
  return [...new Set(items.map((item: unknown): string => (item as { readonly id: string }).id))];
}

export function stackRelationshipIds(body: unknown): string[] | undefined {
  const payload = body as Record<string, unknown> | null;
  const data = payload?.data;
  if (!Array.isArray(data)) return undefined;
  const items = data;
  if (items.some((item: unknown): boolean => !isJsonApiData(item, "stacks"))) return undefined;
  // JSON:API: an explicit empty array is a no-op add/remove, not an error
  // (the reference format accepts data: [] on relationship add/remove). Missing data or
  // malformed items still reject.
  return [...new Set(items.map((item: unknown): string => (item as { readonly id: string }).id))];
}

export function projectRelationshipIds(body: unknown): string[] | undefined {
  const payload = body as Record<string, unknown> | null;
  const data = payload?.data;
  if (!Array.isArray(data)) return undefined;
  const items = data;
  if (items.some((item: unknown): boolean => !isJsonApiData(item, "projects"))) return undefined;
  // JSON:API: an explicit empty array is a no-op add/remove, not an error
  // (the reference format accepts data: [] on relationship add/remove). Missing data or
  // malformed items still reject.
  return [...new Set(items.map((item: unknown): string => (item as { readonly id: string }).id))];
}

type VarRelationshipResult = { many: boolean; resources: unknown[] };

export function variableRelationshipResources(body: unknown): VarRelationshipResult | undefined {
  const payload = body as Record<string, unknown> | null;
  const data = payload?.data;
  if (data === undefined || data === null) return undefined;
  const many = Array.isArray(data);
  const resources = many ? (data as unknown[]) : [data];
  if (
    resources.length > 0 &&
    (resources.some((item: unknown): boolean => !isJsonApiData(item, "vars"))
      || new Set(resources.map((item: unknown): string => (item as { readonly id: string }).id)).size !== resources.length)
  ) return undefined;
  // An explicit empty array (data: []) is a valid no-op bulk request under
  // JSON:API; the reference format accepts it. Only missing data or malformed/duplicate
  // items reject.
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

/**
 * Determine whether `consumerWorkspaceId` may read state produced by
 * `producerWorkspaceId`, following the reference format's remote-state consumer model.
 *
 * Grants are OR-combined:
 *   1. explicit consumer link (remote_state_consumers)
 *   2. project-remote-state: both workspaces share the same project
 *   3. global-remote-state: the producer workspace grants org-wide access
 *
 * Cross-organization reads are never allowed (consumers must be in the same
 * org as the producer). When no grant applies, the read falls through to the
 * caller's normal 404 "not found" behavior, keeping parity with the rest of
 * the state module's access-denied convention.
 */
export async function canConsumeRemoteState(
  producerWorkspaceId: string,
  consumerWorkspaceId: string,
): Promise<boolean> {
  const producer = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, producerWorkspaceId),
    columns: { id: true, orgId: true, projectId: true, globalRemoteState: true, projectRemoteState: true },
  });
  if (producer === undefined) return false;
  // Same workspace: a workspace can always read its own state.
  if (producerWorkspaceId === consumerWorkspaceId) return true;
  const consumer = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, consumerWorkspaceId),
    columns: { id: true, orgId: true, projectId: true },
  });
  if (consumer === undefined) return false;
  // Consumers must live in the same organization as the producer.
  if (producer.orgId !== consumer.orgId) return false;
  // 3. Global remote state grants org-wide access.
  if (producer.globalRemoteState === true) return true;
  // 2. Project remote state grants access to workspaces sharing the project.
  if (producer.projectRemoteState === true && producer.projectId !== null && producer.projectId === consumer.projectId) return true;
  // 1. Explicit consumer link.
  const link = await db.query.remoteStateConsumers.findFirst({
    where: and(
      eq(remoteStateConsumers.workspaceId, producerWorkspaceId),
      eq(remoteStateConsumers.consumerWorkspaceId, consumerWorkspaceId),
    ),
  });
  return link !== undefined;
}

/**
 * For a cross-workspace state read: if the caller cannot access the producer
 * workspace directly, allow the request through only when a remote-state
 * consumer grant exists. Returns the producer workspace (if readable) or
 * undefined (caller should 404).
 */
export async function findRemoteStateReadableWorkspace(
  producerWorkspaceId: string,
  consumerWorkspaceId: string,
): Promise<typeof workspaces.$inferSelect | undefined> {
  const producer = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, producerWorkspaceId),
  });
  if (producer === undefined) return undefined;
  if (await canConsumeRemoteState(producerWorkspaceId, consumerWorkspaceId)) return producer;
  return undefined;
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

export type RequestWithUrl = Readonly<{ readonly url: string }>;

export function pageRequest(request: RequestWithUrl): { number: number; size: number } {
  const params = new URL(request.url).searchParams;
  const number = Number.parseInt(params.get("page[number]") ?? "1", 10);
  const size = Number.parseInt(params.get("page[size]") ?? "20", 10);
  return {
    number: Number.isSafeInteger(number) && number > 0 ? number : 1,
    size: Number.isSafeInteger(size) && size > 0 ? Math.min(size, 100) : 20,
  };
}

/** Cursor pagination (303-305): keyset helper for enormous tables. */
/** @lintignore Intentional surface: large-table consumers opt into cursor pagination. */
export function cursorPagination(request: RequestWithUrl, cursor: string | null, pageSize: number, hasMore: boolean): { links: Record<string, string | null>; meta: Record<string, unknown> } {
  const nextCursor = hasMore ? cursor : null;
  const base = new URL(request.url);
  const linkFor = (c: string | null): string | null => {
    if (c === null) return null;
    const u = new URL(base.toString());
    u.searchParams.set("page[cursor]", c);
    u.searchParams.set("page[size]", String(pageSize));
    return u.toString();
  };
  return {
    links: { self: request.url, first: linkFor(null), prev: null, next: linkFor(nextCursor), last: null },
    meta: { pagination: { "page-size": pageSize, "next-cursor": nextCursor, "cursor": cursor } },
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

// Private/loopback/link-local/CGNAT/cloud-metadata range checks live in
// lib/url-safety.ts (privateHostReason); validateExternalUrl delegates there.


/** Outbound allowlist: when TERRENCE_OUTBOUND_ALLOW_HOSTS/CIDRS restrict egress, check them. */
function isOutboundAllowed(hostname: string, _href: string): boolean {
  const allowHosts = (process.env.TERRENCE_OUTBOUND_ALLOW_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowHosts.length > 0 && allowHosts.some((h) => hostname.toLowerCase() === h || hostname.toLowerCase().endsWith(`.${h}`))) return true;
  // CIDR allowlist (parsed via isPrivate-style check but inverted: if host is IPv4 within CIDR, allow)
  const allowCidrs = (process.env.TERRENCE_OUTBOUND_ALLOW_CIDRS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowCidrs.length > 0) {
    try {
      const { isIPv4InCidr } = require("./url-safety") as { isIPv4InCidr?: (host: string, cidr: string) => boolean };
      if (typeof isIPv4InCidr === "function" && allowCidrs.some((cidr) => isIPv4InCidr(hostname, cidr))) return true;
    } catch { /* best-effort */ }
  }
  return false;
}

export function validateExternalUrl(url: string, allowPrivate = false): string | null {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "Only http and https URLs are allowed";
    // 41-44: outbound allowlist/CIDR/DNS — when TERRENCE_OUTBOUND_ALLOW_HOSTS or CIDRS gate private access,
    // private-host denial is scoped to that policy; otherwise the global allowPrivate flag applies.
    if (!allowPrivate && isOutboundAllowed(parsed.hostname, parsed.href)) return null;
    if (!allowPrivate) {
      const reason = privateHostReason(parsed.hostname);
      if (reason !== null) return reason;
    }
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
    conditions.push(inArray(runs.operation, operations));
  }
  // No operation filter means "all runs", including speculative/plan-only runs.
  // TFE shows speculative plans in the workspace run list, so we surface them by
  // default. Callers that want to exclude them pass an explicit operation filter.

  const sources = csv("filter[source]");
  if (sources !== undefined && sources.length > 0) {
    const wantsApi = sources.includes("tfe-api");
    const wantsVcs = sources.includes("tfe-vcs");
    if (!wantsApi && !wantsVcs) conditions.push(sql`false`);
    else if (wantsApi !== wantsVcs) {
      const vcsSources = ["github", "gitlab", "bitbucket"];
      const vcsRuns = exists(db.select({ id: configurationVersions.id })
        .from(configurationVersions)
        .where(and(eq(configurationVersions.id, runs.configurationVersionId), inArray(configurationVersions.source, vcsSources))));
      conditions.push(wantsVcs ? vcsRuns : or(isNull(runs.configurationVersionId), sql`NOT ${vcsRuns}`));
    }
  }

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
          .where(sql`COALESCE(${jsonExtract(configurationVersions.ingressAttributes, '$.commitSha')}, '') LIKE ${`%${commitSearch}%`}`)
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
const DISCARDABLE_RUN_STATUSES = [
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
