import { db } from "../db";
import { isPostgres } from "../db/driver";
import {
  users, workspaces,
  runs, stateVersions, workspaceVariables, workspaceTags,
  configurationVersions, variableSets,
  auditLogs, dataRetentionPolicies, organizationDataRetentionPolicies, remoteStateConsumers,
  agentPools, workspaceRunTasks, logs, organizationMemberships, projectTags, reservedTagKeys,
  organizations, registryPartnerships, teams, teamMemberships, teamWorkspaces,
  organizationMembershipRoles, organizationRoles, apiTokens, stackStateLocks, workloadIdentityTokens,
} from "../db/schema";
import { and, desc, eq, exists, gte, ilike, inArray, isNull, like, lt, notInArray, or, sql } from "drizzle-orm";
import { timingSafeEqual, createHash, createHmac, randomBytes } from "node:crypto";
import { access, appendFile, rm } from "node:fs/promises";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { recordFailure } from "./process-metrics";
import { log } from "./log";
import { isDiskFullError, markStorageDegraded } from "./storage-health";
import { jsonExtract } from "./db-json";
import { validateVersion } from "../binaryManager";
import { decodeStatePayload, parseStatePayload } from "./validation";
import { outboundAllowlistAllows, privateHostReason } from "./url-safety";
import { archiveRunLogs, deleteRunLogArchive } from "./run-logs";
import { deletePlanJsonArtifact } from "./plan-json";
import { currentSiteAdmin, currentTokenScopes, requestCacheGet, requestCacheSet } from "./request-scope";
import { withDbLock } from "./db-lock";
import {
  scopeGrants,
  scopeCoversOrg,
  evaluateTagExpression,
  type WorkspacePermissionGrant,
  type TokenScopes,
} from "./token-scopes";

export { validateVersion, decodeStatePayload, parseStatePayload };

export function caseInsensitiveLike(
  column: Parameters<typeof like>[0],
  pattern: string,
): ReturnType<typeof like> {
  return isPostgres ? ilike(column, pattern) : like(column, pattern);
}

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

const PUBLIC_URL = typeof process.env["PUBLIC_URL"] === "string" && process.env["PUBLIC_URL"] !== "" ? new URL(process.env["PUBLIC_URL"]) : null;

/** Minimal Elysia `set` shape shared by JSON:API error helpers. */
export type ErrorSet = { status?: number | string };

export type JsonApiErrorBody = { errors: { status: string; title: string; detail?: string }[] };

/**
 * Serialize lifecycle changes for every organization a user owns. Sorting the
 * names gives concurrent multi-organization deletions a stable lock order;
 * the callback's transaction then performs the owner check and deletion while
 * all affected organization locks are held.
 */
export async function withOrganizationMembershipLocks<T>(
  organizationIds: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const ids = [...new Set(organizationIds)].sort();
  const acquire = async (index: number): Promise<T> => {
    const organizationId = ids[index];
    if (organizationId === undefined) return operation();
    return withDbLock(`organization-membership:${organizationId}`, async () => acquire(index + 1));
  };
  return acquire(0);
}

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
  const v = process.env["AUDIT_STRICT"];
  return v === "1" || v === "true";
}

function scopeAllowsOrgPermission(
  scopes: TokenScopes,
  orgId: string,
  requiredRole: "owner" | "member",
  requiredGrant: WorkspacePermissionGrant | null,
): boolean {
  if (!scopeCoversOrg(scopes, orgId)) return false;
  if (requiredGrant !== null) return scopeGrants(scopes, requiredGrant);
  if (requiredRole === "owner") return scopeGrants(scopes, "settings:write");
  return true;
}

async function checkTeamTokenOrgPermission(
  tokenTeamId: string,
  orgId: string,
  requiredRole: "owner" | "member",
): Promise<boolean> {
  const team = await db.query.teams.findFirst({ where: eq(teams.id, tokenTeamId) });
  return team?.orgId === orgId && requiredRole === "member";
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
  if (scopes !== null && !scopeAllowsOrgPermission(scopes, orgId, requiredRole, requiredGrant)) return false;
  if (tokenTeamId !== null) return checkTeamTokenOrgPermission(tokenTeamId, orgId, requiredRole);
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
  | "read-run-tasks"
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

const TEAM_ORG_FALLBACK_MAP: Readonly<Record<string, readonly string[]>> = {
  "read-workspaces": ["manage-workspaces", "read-projects", "manage-projects", "manage-agent-pools", "manage-policy-overrides"],
  "manage-workspaces": ["manage-projects"],
  "read-projects": ["manage-projects", "manage-agent-pools"],
  "manage-membership": ["manage-teams", "manage-organization-access"],
  "manage-teams": ["manage-organization-access"],
  "read-policies": ["manage-policies"],
  "read-vcs-settings": ["manage-vcs-settings"],
  "read-agent-pools": ["manage-agent-pools"],
  "read-run-tasks": ["manage-run-tasks"],
  "manage-varsets": ["manage-workspaces", "manage-projects"],
};

function hasAnyFallback(access: Readonly<Record<string, boolean>>, keys: readonly string[]): boolean {
  return keys.some((key): boolean => access[key] === true);
}

function teamOrganizationAllows(
  access: Readonly<Record<string, boolean>>,
  required: OrganizationPermission,
): boolean {
  if (access[required] === true) return true;
  if (required === "read-varsets") {
    if (access["manage-varsets"] === true) return true;
    return teamOrganizationAllows(access, "read-workspaces");
  }
  const fallbacks = TEAM_ORG_FALLBACK_MAP[required];
  if (fallbacks === undefined) return false;
  return hasAnyFallback(access, fallbacks);
}

const ORGANIZATION_PERMISSION_GRANT_MAP: Readonly<Record<OrganizationPermission, WorkspacePermissionGrant | null>> = {
  "manage-policies": "policies:write",
  "read-policies": "policies:read",
  "manage-policy-overrides": "runs:policy-override",
  "delegate-policy-overrides": "runs:policy-override",
  "manage-run-tasks": "run-tasks:write",
  "read-run-tasks": "run-tasks:read",
  "manage-vcs-settings": "vcs:write",
  "read-vcs-settings": "vcs:read",
  "manage-agent-pools": "agent-pools:write",
  "read-agent-pools": "agent-pools:read",
  "manage-providers": "registry:write",
  "manage-modules": "registry:write",
  "manage-projects": "projects:write",
  "read-projects": "projects:read",
  "read-workspaces": "workspaces:read",
  "manage-workspaces": "workspaces:write",
  "manage-membership": "members:write",
  "manage-teams": "teams:write",
  "manage-organization-access": "teams:write",
  "manage-varsets": "varsets:write",
  "read-varsets": "varsets:read",
};

/** Map an OrganizationPermission to the fine-grained grant it requires. */
function organizationPermissionGrant(required: OrganizationPermission): WorkspacePermissionGrant | null {
  return ORGANIZATION_PERMISSION_GRANT_MAP[required] ?? null;
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

export type LockPrincipal = Readonly<{ type: string; id: string }>;

export function lockPrincipal(userId: string | null | undefined, orgId: string | null | undefined, teamId: string | null | undefined): LockPrincipal {
  if (teamId !== null && teamId !== undefined && teamId !== "") return { type: "team", id: teamId };
  if (userId !== null && userId !== undefined && userId !== "") return { type: "user", id: userId };
  if (orgId !== null && orgId !== undefined && orgId !== "") return { type: "organization", id: orgId };
  return { type: "service", id: "system" };
}

export function ownsWorkspaceLock(
  workspace: Readonly<{ locked?: boolean | null; lockOwnerType?: string | null; lockOwnerId?: string | null }>,
  principal: LockPrincipal,
): boolean {
  return workspace.locked === true
    && workspace.lockOwnerType === principal.type
    && workspace.lockOwnerId === principal.id;
}

export function strongDocumentEtag(document: unknown): string {
  return `"${createHash("sha256").update(JSON.stringify(document)).digest("hex")}"`;
}

export function ifMatchSatisfied(request: Readonly<{ headers: Readonly<{ get(name: string): string | null }> }>, document: unknown): boolean {
  const ifMatch = request.headers.get("if-match");
  if (ifMatch === null || ifMatch.trim() === "*") return true;
  const expected = strongDocumentEtag(document);
  return ifMatch.split(",").map((tag): string => tag.trim()).some((tag): boolean => tag === expected);
}

const NON_CUSTOM_ALLOWS: Readonly<Record<string, readonly WorkspacePermission[]>> = {
  admin: ["read", "run-read", "plan", "apply", "discard", "cancel", "lock", "variables-read", "variables-write", "state-outputs", "state-read", "state-write"],
  write: ["read", "run-read", "plan", "apply", "discard", "cancel", "lock", "variables-read", "variables-write", "state-outputs", "state-read", "state-write"],
  plan: ["read", "run-read", "plan", "variables-read", "state-outputs", "state-read"],
  read: ["read", "run-read", "variables-read", "state-outputs", "state-read"],
};

function allowsNonCustomLevel(accessLevel: string, required: WorkspacePermission): boolean {
  if (accessLevel === "admin") return true;
  const allowed = NON_CUSTOM_ALLOWS[accessLevel];
  if (allowed === undefined) return false;
  return (allowed as readonly string[]).includes(required);
}

function allowsCustomRuns(runs: string, required: WorkspacePermission): boolean | null {
  if (required === "read" || required === "run-read") return ["read", "plan", "apply"].includes(runs);
  if (required === "plan") return runs === "plan" || runs === "apply";
  if (required === "apply" || required === "discard" || required === "cancel") return runs === "apply";
  return null;
}

function allowsCustomTaskOrLock(permissions: Readonly<Record<string, unknown>>, required: WorkspacePermission): boolean | null {
  if (required === "run-tasks" || required === "run-tasks-read") return permissions["run-tasks"] === true;
  if (required === "lock") return permissions["workspace-locking"] === true;
  return null;
}

function allowsCustomVariables(permissions: Readonly<Record<string, unknown>>, required: WorkspacePermission): boolean | null {
  const variableAccess = typeof permissions["variables"] === "string" ? permissions["variables"] : "none";
  if (required === "variables-read") return variableAccess === "read" || variableAccess === "write";
  if (required === "variables-write") return variableAccess === "write";
  return null;
}

function allowsCustomState(permissions: Readonly<Record<string, unknown>>, required: WorkspacePermission): boolean | null {
  const stateAccess = typeof permissions["state-versions"] === "string" ? permissions["state-versions"] : "none";
  if (required === "state-outputs") return ["read-outputs", "read", "write"].includes(stateAccess);
  if (required === "state-read") return stateAccess === "read" || stateAccess === "write";
  if (required === "state-write") return stateAccess === "write";
  return null;
}

function allowsCustomLevel(permissions: Readonly<Record<string, unknown>>, required: WorkspacePermission): boolean {
  const runs = typeof permissions["runs"] === "string" ? permissions["runs"] : "read";
  const runResult = allowsCustomRuns(runs, required);
  if (runResult !== null) return runResult;
  const taskResult = allowsCustomTaskOrLock(permissions, required);
  if (taskResult !== null) return taskResult;
  const varResult = allowsCustomVariables(permissions, required);
  if (varResult !== null) return varResult;
  const stateResult = allowsCustomState(permissions, required);
  if (stateResult !== null) return stateResult;
  return false;
}

function teamWorkspaceAllows(
  accessLevel: string,
  rawPermissions: Readonly<Record<string, unknown>> | null,
  required: WorkspacePermission,
): boolean {
  const permissions = rawPermissions ?? {};
  if (required === "policy-override") return accessLevel === "custom" && permissions["policy-overrides"] === true;
  if (accessLevel !== "custom") return allowsNonCustomLevel(accessLevel, required);
  return allowsCustomLevel(permissions, required);
}

/**
 * Resolve the set of workspace IDs a fine-grained token scope allows within an
 * org. Returns null when the scope covers ALL workspaces in the org (no
 * workspace/project/tag restriction). Returns [] when the scope cannot reach
 * any workspace in the org.
 */
async function collectProjectScopedIds(scope: TokenScopes, orgId: string): Promise<readonly string[]> {
  if (scope.projects === null || scope.projects.length === 0) return [];
  const rows = await db.query.workspaces.findMany({
    where: and(eq(workspaces.orgId, orgId), inArray(workspaces.projectId, scope.projects as string[])),
    columns: { id: true },
  });
  return rows.map((row): string => row.id);
}

async function collectWorkspaceScopedIds(scope: TokenScopes, orgId: string): Promise<readonly string[]> {
  if (scope.workspaces === null || scope.workspaces.length === 0) return [];
  const rows = await db.query.workspaces.findMany({
    where: and(eq(workspaces.orgId, orgId), inArray(workspaces.id, scope.workspaces as string[])),
    columns: { id: true },
  });
  return rows.map((row): string => row.id);
}

async function collectTagScopedIds(scope: TokenScopes, orgId: string): Promise<readonly string[]> {
  if (scope.tags === null || scope.tags.rules.length === 0) return [];
  const orgWorkspaceIds = (await db.query.workspaces.findMany({
    where: eq(workspaces.orgId, orgId),
    columns: { id: true },
  })).map((row): string => row.id);
  if (orgWorkspaceIds.length === 0) return [];
  const tagRows: Array<{ workspaceId: string; key: string; value: string | null }> = [];
  for (let offset = 0; offset < orgWorkspaceIds.length; offset += DELETE_ID_CHUNK_SIZE) {
    const chunk = orgWorkspaceIds.slice(offset, offset + DELETE_ID_CHUNK_SIZE);
    const rows = await db.query.workspaceTags.findMany({
      where: inArray(workspaceTags.workspaceId, chunk),
      columns: { workspaceId: true, key: true, value: true },
    });
    tagRows.push(...rows);
  }
  const tagsByWorkspace = buildTagsByWorkspace(tagRows);
  const matching: string[] = [];
  for (const workspaceId of orgWorkspaceIds) {
    if (evaluateTagExpression(scope.tags, tagsByWorkspace.get(workspaceId) ?? new Set<string>())) {
      matching.push(workspaceId);
    }
  }
  return matching;
}

function buildTagsByWorkspace(tagRows: readonly DeepReadonly<{ workspaceId: string; key: string; value: string | null }>[]): Map<string, Set<string>> {
  const tagsByWorkspace = new Map<string, Set<string>>();
  for (const row of tagRows) {
    const tags = tagsByWorkspace.get(row.workspaceId) ?? new Set<string>();
    tags.add(`${row.key}=${row.value ?? ""}`);
    tagsByWorkspace.set(row.workspaceId, tags);
  }
  return tagsByWorkspace;
}

function hasNoWorkspaceRestriction(scope: TokenScopes): boolean {
  const hasProject = scope.projects !== null;
  const hasWorkspace = scope.workspaces !== null;
  const hasTag = scope.tags !== null && scope.tags.rules.length > 0;
  return !hasProject && !hasWorkspace && !hasTag;
}

export async function scopeWorkspaceIdsForOrg(scope: TokenScopes, orgId: string): Promise<readonly string[] | null> {
  if (!scopeCoversOrg(scope, orgId)) return [];
  if (hasNoWorkspaceRestriction(scope)) return null;
  const matching = new Set<string>();
  const scopedIds = await Promise.all([
    collectProjectScopedIds(scope, orgId),
    collectWorkspaceScopedIds(scope, orgId),
    collectTagScopedIds(scope, orgId),
  ]);
  for (const ids of scopedIds) for (const id of ids) matching.add(id);
  return [...matching];
}

const WORKSPACE_PERMISSION_GRANT_MAP: Readonly<Record<WorkspacePermission, readonly WorkspacePermissionGrant[]>> = {
  read: ["workspaces:read"],
  "run-read": ["runs:read"],
  admin: ["workspaces:write"],
  plan: ["runs:plan"],
  apply: ["runs:apply"],
  discard: ["runs:discard"],
  cancel: ["runs:cancel"],
  lock: ["workspaces:lock"],
  "run-tasks": ["run-tasks:write"],
  "run-tasks-read": ["run-tasks:read"],
  "policy-override": ["runs:policy-override"],
  "variables-read": ["variables:read"],
  "variables-write": ["variables:write"],
  "state-outputs": ["state:read"],
  "state-read": ["state:read"],
  "state-write": ["state:write"],
};

/** Map a WorkspacePermission to the fine-grained grant(s) it requires. */
function workspacePermissionGrant(required: WorkspacePermission): readonly WorkspacePermissionGrant[] {
  return WORKSPACE_PERMISSION_GRANT_MAP[required] ?? [];
}

/**
 * Everything a permission derivation needs to know about a principal's
 * workspace access. Loading this base once per batched evaluation turns the
 * 10-permission-level workspace handlers into one set of DB reads plus
 * in-memory derivations.
 */
type WorkspaceAccessBase = DeepReadonly<{
  orgId: string;
  userId: string | undefined;
  tokenOrgId: string | null;
  tokenTeamId: string | null;
  tokenTeam: (typeof teams.$inferSelect) | null;
  tokenTeamWorkspaces: (typeof teamWorkspaces.$inferSelect)[];
  isOwner: boolean;
  isMember: boolean;
  userTeamData: {
    teamIds: string[];
    teamWorkspaces: (typeof teamWorkspaces.$inferSelect)[];
    userTeams: (typeof teams.$inferSelect)[];
  } | null;
}>;

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
function derivesFromTeamToken(base: WorkspaceAccessBase, required: WorkspacePermission): readonly string[] | null | undefined {
  if (base.tokenTeamId === null) return undefined;
  const team = base.tokenTeam;
  if (team === null || team.orgId !== base.orgId) return [];
  if (teamOrganizationAllows(team.organizationAccess, "manage-workspaces")) return null;
  if (grantsTeamOrgWide(team, required)) return null;
  const delegateTeamIds = required === "policy-override"
    ? new Set(teamOverrideDelegationActive(team) ? [team.id] : [])
    : null;
  return [...new Set(base.tokenTeamWorkspaces
    .filter((entry): boolean =>
      teamWorkspaceAllows(entry.access, entry.permissions, required)
      && (delegateTeamIds === null || delegateTeamIds.has(entry.teamId)))
    .map((entry): string => entry.workspaceId))];
}

function grantsTeamOrgWide(team: DeepReadonly<typeof teams.$inferSelect>, required: WorkspacePermission): boolean {
  if (required === "read" && team.organizationAccess["manage-policies"] === true) return true;
  if (required === "policy-override" && team.organizationAccess["manage-policy-overrides"] === true) return true;
  if (["read", "run-read", "variables-read", "state-outputs", "state-read"].includes(required)
    && teamOrganizationAllows(team.organizationAccess, "read-workspaces")) return true;
  return false;
}

function derivesFromOrgToken(base: WorkspaceAccessBase, required: WorkspacePermission): readonly string[] | null | undefined {
  if (base.tokenOrgId === null) return undefined;
  if (base.tokenOrgId !== base.orgId || ["plan", "apply", "policy-override"].includes(required)) return [];
  return null;
}

function grantsUserOrgWide(userTeams: readonly DeepReadonly<typeof teams.$inferSelect>[], required: WorkspacePermission): boolean {
  if (userTeams.some((team): boolean => teamOrganizationAllows(team.organizationAccess, "manage-workspaces"))) return true;
  if (required === "read" && userTeams.some((team): boolean => team.organizationAccess["manage-policies"] === true)) return true;
  if (required === "policy-override" && userTeams.some((team): boolean => team.organizationAccess["manage-policy-overrides"] === true)) return true;
  if (["read", "run-read", "variables-read", "state-outputs", "state-read"].includes(required)
    && userTeams.some((team): boolean => teamOrganizationAllows(team.organizationAccess, "read-workspaces"))) return true;
  return false;
}

function deriveForUserTeams(base: WorkspaceAccessBase, required: WorkspacePermission): readonly string[] | null {
  const teamData = base.userTeamData;
  if (teamData === null || teamData.teamIds.length === 0) return [];
  if (grantsUserOrgWide(teamData.userTeams, required)) return null;
  const delegateTeamIds = buildDelegateTeamIds(teamData.userTeams, required);
  return [...new Set(teamData.teamWorkspaces
    .filter((entry): boolean =>
      teamWorkspaceAllows(entry.access, entry.permissions, required)
      && (delegateTeamIds === null || delegateTeamIds.has(entry.teamId)))
    .map((entry): string => entry.workspaceId))];
}

function buildDelegateTeamIds(userTeams: readonly DeepReadonly<typeof teams.$inferSelect>[], required: WorkspacePermission): ReadonlySet<string> | null {
  if (required !== "policy-override") return null;
  return new Set(userTeams
    .filter((t: DeepReadonly<typeof teams.$inferSelect>): boolean => teamOverrideDelegationActive(t))
    .map((t: DeepReadonly<typeof teams.$inferSelect>): string => t.id));
}

function deriveWorkspaceIdsForRequired(
  base: WorkspaceAccessBase,
  required: WorkspacePermission,
): readonly string[] | null {
  const teamResult = derivesFromTeamToken(base, required);
  if (teamResult !== undefined) return teamResult;
  const orgResult = derivesFromOrgToken(base, required);
  if (orgResult !== undefined) return orgResult;
  if (base.userId === undefined) return [];
  if (base.isOwner) return null;
  if (!base.isMember) return [];
  return deriveForUserTeams(base, required);
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
  return i["type"] === expectedType && typeof i["id"] === "string" && i["id"] !== "";
}

export function workspaceRelationshipIds(body: unknown): string[] | undefined {
  const payload = body as Record<string, unknown> | null;
  const data = payload?.["data"];
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
  const data = payload?.["data"];
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
  const data = payload?.["data"];
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
  const data = payload?.["data"];
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
  // Empty collections still expose page 1 through first/last links. Keep the
  // metadata consistent with those links instead of reporting zero pages.
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const pageLink = (page: number): string => {
    const url = new URL(request.url);
    url.searchParams.set("page[number]", String(page));
    url.searchParams.set("page[size]", String(pageSize));
    return url.toString();
  };

  return {
    links: {
      self: request.url,
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
  return new URL(path, requestBaseUrl(request)).toString();
}

/**
 * Signed URLs must use the same key on every replica. Configure
 * SIGNED_URL_SECRET consistently across a multi-replica deployment, or mount
 * a shared STORAGE_DIR so the generated fallback file is shared. A single
 * replica may continue using the local fallback.
 */
function loadSignedUrlSecret(): string {
  const storage = process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage");
  const path = join(storage, ".signed-url-secret");
  mkdirSync(storage, { recursive: true });
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // Create below; a missing/unreadable secret must not silently rotate on
    // every request, so a write/read failure is surfaced by the caller.
  }
  const generated = randomBytes(32).toString("base64url");
  try {
    writeFileSync(path, generated, { mode: 0o600, flag: "wx" });
    return generated;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const existing = readFileSync(path, "utf8").trim();
        if (existing.length >= 32) return existing;
      } catch {
        // Another process may have created the file but not made it readable yet.
      }
      throw new Error(`Signed-URL secret at ${path} is present but unusable; replace the file before starting Terrence.`);
    }
    throw error;
  }
}

const configuredSignedUrlSecret = process.env["SIGNED_URL_SECRET"]?.trim();
const SIGNED_URL_SECRET = configuredSignedUrlSecret === undefined || configuredSignedUrlSecret === ""
  ? loadSignedUrlSecret()
  : configuredSignedUrlSecret.length >= 32
    ? configuredSignedUrlSecret
    : (() => { throw new Error("SIGNED_URL_SECRET must be at least 32 characters"); })();

/** Stable, non-reversible identifier fingerprint keyed by an installation secret. */
export function sensitiveIdentifierHash(value: string): string {
  return createHmac("sha256", SIGNED_URL_SECRET).update(value).digest("hex");
}

/**
 * Outward-facing base URL for generated links (issue #576). PUBLIC_URL is
 * authoritative when set. Otherwise derive from reverse-proxy headers when
 * present (standard homelab proxies preserve Host or set
 * X-Forwarded-Host/Proto), falling back to the connection address. The
 * header path is best-effort: proxy deployments should set PUBLIC_URL.
 */
type HeaderCarrier = Readonly<{
  readonly url: string;
  readonly headers?: Readonly<{ get(name: string): string | null }>;
}>;

function proxyBaseUrl(request: HeaderCarrier): string | null {
  const headers = request.headers;
  if (headers === undefined) return null;
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (host === null || host === "") return null;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? "http";
  if (!/^[A-Za-z0-9._~-]+(?::\d+)?$/.test(host)) return null;
  if (proto !== "http" && proto !== "https") return null;
  return `${proto}://${host}`;
}

export function requestBaseUrl(request: HeaderCarrier): string {
  if (PUBLIC_URL !== null) return PUBLIC_URL.toString();
  // The connection-address fallback is a base URL, so return the origin
  // only: a request-specific pathname must never leak into generated links
  // (CodeRabbit P1-sweep review). Absolute-path callers are unaffected.
  try {
    return proxyBaseUrl(request) ?? new URL(request.url).origin;
  } catch {
    return request.url;
  }
}

export function signedApiURL(request: RequestWithUrl, path: string, method = "GET", ttlSeconds?: number): string {
  const configuredTtl = ttlSeconds ?? Number(process.env["SIGNED_URL_TTL_SECONDS"] ?? 300);
  const ttl = Number.isSafeInteger(configuredTtl) && configuredTtl > 0 ? configuredTtl : 300;
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const signature = createHmac("sha256", SIGNED_URL_SECRET)
    .update(`${method}\n${path}\n${String(expires)}`)
    .digest("hex");
  const url = new URL(path, requestBaseUrl(request));
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


export function validateExternalUrl(url: string, allowPrivate = false): string | null {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "Only http and https URLs are allowed";
    // 41-44: outbound allowlist/CIDR/DNS — when TERRENCE_OUTBOUND_ALLOW_HOSTS or CIDRS gate private access,
    // private-host denial is scoped to that policy; otherwise the global allowPrivate flag applies.
    if (!allowPrivate && outboundAllowlistAllows(parsed.hostname)) return null;
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
    const attrs = i["attributes"] as Record<string, unknown> | undefined;
    const key = attrs?.["key"] as string | undefined;
    const value = typeof attrs?.["value"] === "string" ? attrs["value"] : "";
    if (i["type"] !== "tag-bindings" || typeof key !== "string" || key.trim() === "" || typeof value !== "string") {
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

type RunWhereCondition = DeepReadonly<ReturnType<typeof eq> | ReturnType<typeof or>>;
type RunWhereConditions = readonly RunWhereCondition[];

function addStatusFilter(conditions: readonly RunWhereCondition[], csv: (name: string) => string[] | undefined): RunWhereConditions {
  const statuses = csv("filter[status]");
  return statuses !== undefined && statuses.length > 0 ? [...conditions, inArray(runs.status, statuses)] : conditions;
}

function addOperationFilter(conditions: readonly RunWhereCondition[], csv: (name: string) => string[] | undefined): RunWhereConditions {
  const operations = csv("filter[operation]");
  return operations !== undefined && operations.length > 0 ? [...conditions, inArray(runs.operation, operations)] : conditions;
}

function addSourceFilter(conditions: readonly RunWhereCondition[], csv: (name: string) => string[] | undefined): RunWhereConditions {
  const sources = csv("filter[source]");
  if (sources === undefined || sources.length === 0) return conditions;
  const wantsApi = sources.includes("tfe-api");
  const wantsVcs = sources.includes("tfe-vcs");
  if (!wantsApi && !wantsVcs) {
    return [...conditions, sql`false`];
  }
  if (wantsApi === wantsVcs) return conditions;
  const vcsSources = ["github", "gitlab", "bitbucket"];
  const vcsRuns = exists(db.select({ id: configurationVersions.id })
    .from(configurationVersions)
    .where(and(eq(configurationVersions.id, runs.configurationVersionId), inArray(configurationVersions.source, vcsSources))));
  return [...conditions, wantsVcs ? vcsRuns : or(isNull(runs.configurationVersionId), sql`NOT ${vcsRuns}`)];
}

function addStatusGroupFilter(conditions: readonly RunWhereCondition[], statusGroup: string | null): RunWhereConditions {
  if (statusGroup === null || statusGroup === "") return conditions;
  if (statusGroup === "final") return [...conditions, inArray(runs.status, FINAL_RUN_STATUSES)];
  if (statusGroup === "non_final") return [...conditions, notInArray(runs.status, FINAL_RUN_STATUSES)];
  if (statusGroup === "discardable") return [...conditions, inArray(runs.status, DISCARDABLE_RUN_STATUSES)];
  return [...conditions, sql`false`];
}

function addTimeframeFilter(conditions: readonly RunWhereCondition[], timeframe: string | null): RunWhereConditions {
  if (timeframe === null || timeframe === "") return conditions;
  if (timeframe === "year") {
    return [...conditions, gte(runs.createdAt, Date.now() - 365 * 24 * 60 * 60 * 1000)];
  }
  if (/^\d{4}$/.test(timeframe)) {
    const year = Number(timeframe);
    return [...conditions, gte(runs.createdAt, Date.UTC(year, 0, 1)), lt(runs.createdAt, Date.UTC(year + 1, 0, 1))];
  }
  return [...conditions, sql`false`];
}

function addBasicSearchFilter(conditions: readonly RunWhereCondition[], basic: string | undefined): RunWhereConditions {
  if (basic === undefined || basic === "") return conditions;
  return [...conditions, or(caseInsensitiveLike(runs.id, `%${basic}%`), caseInsensitiveLike(runs.message, `%${basic}%`))];
}

function addUserSearchFilter(conditions: readonly RunWhereCondition[], userSearch: string | undefined): RunWhereConditions {
  if (userSearch === undefined || userSearch === "") return conditions;
  const userMatches = db.select({ id: users.id }).from(users).where(caseInsensitiveLike(users.username, `%${userSearch}%`));
  return [...conditions, inArray(runs.createdBy, userMatches)];
}

function addAgentPoolFilter(conditions: readonly RunWhereCondition[], csv: (name: string) => string[] | undefined): RunWhereConditions {
  const agentPoolNames = csv("filter[agent_pool_names]");
  if (agentPoolNames === undefined || agentPoolNames.length === 0) return conditions;
  const matchingPools = db.select({ id: agentPools.id }).from(agentPools).where(inArray(agentPools.name, agentPoolNames));
  const matchingWorkspaces = db.select({ id: workspaces.id }).from(workspaces).where(inArray(workspaces.agentPoolId, matchingPools));
  return [...conditions, inArray(runs.workspaceId, matchingWorkspaces)];
}

function addCommitSearchFilter(conditions: readonly RunWhereCondition[], commitSearch: string | undefined): RunWhereConditions {
  if (commitSearch === undefined || commitSearch === "") return conditions;
  return [...conditions, inArray(runs.id, db.select({ id: runs.id }).from(runs)
    .innerJoin(configurationVersions, eq(runs.configurationVersionId, configurationVersions.id))
    .where(sql`COALESCE(${jsonExtract(configurationVersions.ingressAttributes, '$.commitSha')}, '') LIKE ${`%${commitSearch}%`}`))];
}

function addWorkspaceNameFilter(conditions: readonly RunWhereCondition[], name: string | null): RunWhereConditions {
  const trimmed = name?.trim();
  if (trimmed === undefined || trimmed === "") return conditions;
  const matchingWorkspaces = db.select({ id: workspaces.id }).from(workspaces)
    .where(caseInsensitiveLike(workspaces.name, `%${trimmed}%`));
  return [...conditions, inArray(runs.workspaceId, matchingWorkspaces)];
}

function addWorkspaceNamesFilter(conditions: readonly RunWhereCondition[], names: string[] | undefined): RunWhereConditions {
  if (names === undefined || names.length === 0) return conditions;
  const matchingWorkspaces = db.select({ id: workspaces.id }).from(workspaces)
    .where(or(...names.map((name: string) => caseInsensitiveLike(workspaces.name, `%${name}%`))));
  return [...conditions, inArray(runs.workspaceId, matchingWorkspaces)];
}

function runHistoryCsv(params: URLSearchParams, name: string): string[] | undefined {
  return params.get(name)?.split(",").map((value: string): string => value.trim()).filter((s: string): boolean => s !== "");
}

function runHistoryWhere(request: RequestWithUrl, initial: RunWhereConditions): ReturnType<typeof and> {
  const params = new URL(request.url).searchParams;
  const csv = (name: string): string[] | undefined => runHistoryCsv(params, name);
  let conditions: RunWhereConditions = initial;
  conditions = addStatusFilter(conditions, csv);
  conditions = addOperationFilter(conditions, csv);
  conditions = addSourceFilter(conditions, csv);
  conditions = addStatusGroupFilter(conditions, params.get("filter[status_group]"));
  conditions = addTimeframeFilter(conditions, params.get("filter[timeframe]"));
  conditions = addBasicSearchFilter(conditions, params.get("search[basic]")?.trim());
  conditions = addUserSearchFilter(conditions, params.get("search[user]")?.trim());
  conditions = addAgentPoolFilter(conditions, csv);
  conditions = addCommitSearchFilter(conditions, params.get("search[commit]")?.trim());
  return and(...conditions);
}

export function workspaceRunHistoryWhere(request: RequestWithUrl, workspaceId: string): ReturnType<typeof and> {
  return runHistoryWhere(request, [eq(runs.workspaceId, workspaceId)]);
}

/** Build the same filtered run-history predicate for an authorized organization scope. */
export function organizationRunHistoryWhere(request: RequestWithUrl, workspaceIds: readonly string[]): ReturnType<typeof and> {
  const params = new URL(request.url).searchParams;
  let conditions: RunWhereConditions = [inArray(runs.workspaceId, [...workspaceIds])];
  conditions = addWorkspaceNamesFilter(conditions, runHistoryCsv(params, "filter[workspace_names]"));
  conditions = addWorkspaceNameFilter(conditions, params.get("filter[workspace][name]"));
  conditions = addWorkspaceNameFilter(conditions, params.get("search[name]"));
  return runHistoryWhere(request, conditions);
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
export const WORKSPACE_BLOCKING_RUN_STATUSES = [
  "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed",
  "queuing", "plan_queued", "planning", "planned", "cost_estimating",
  "cost_estimated", "policy_checking", "policy_override", "policy_checked",
  "post_plan_running", "post_plan_completed", "policy_soft_failed",
  "confirmed", "apply_queued", "applying",
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

type WorkspaceDeletionArtifact = Readonly<{
  kind: "run" | "configuration";
  value: string;
}>;

const DELETE_ID_CHUNK_SIZE = 500;
const DELETION_ARTIFACT_BATCH_SIZE = 25;

async function deleteIdChunks(
  ids: readonly string[],
  operation: (chunk: string[]) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += DELETE_ID_CHUNK_SIZE) {
    await operation(ids.slice(offset, offset + DELETE_ID_CHUNK_SIZE));
  }
}

function workspaceDeletionManifestPath(): string {
  return join(tmpdir(), `terrence-workspace-deletion-${crypto.randomUUID()}.jsonl`);
}

async function appendWorkspaceDeletionArtifacts(
  manifestPath: string,
  runIds: readonly string[],
  configurationArchives: readonly { readonly archivePath: string | null }[],
): Promise<void> {
  const entries: string[] = [];
  for (const runId of runIds) {
    entries.push(JSON.stringify({ kind: "run", value: runId }));
  }
  for (const archive of configurationArchives) {
    if (archive.archivePath !== null) {
      entries.push(JSON.stringify({ kind: "configuration", value: archive.archivePath }));
    }
  }
  if (entries.length > 0) await appendFile(manifestPath, `${entries.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

async function deleteWorkspaceDataInTransaction(
  transaction: typeof db,
  workspaceIds: readonly string[],
  manifestPath: string,
): Promise<void> {
  const ids = [...new Set(workspaceIds)];
  await deleteIdChunks(ids, async (chunk): Promise<void> => {
    const runsToDelete = await transaction.query.runs.findMany({
      where: inArray(runs.workspaceId, chunk),
      columns: { id: true },
    });
    const configurationArchives = await transaction.query.configurationVersions.findMany({
      where: inArray(configurationVersions.workspaceId, chunk),
      columns: { archivePath: true },
    });
    const runIds = runsToDelete.map((run): string => run.id);
    await appendWorkspaceDeletionArtifacts(manifestPath, runIds, configurationArchives);

    // These tables intentionally do not have foreign keys to runs: tokens are
    // independently verifiable credentials and stack locks can outlive a run.
    // Remove them before the run rows so a failed transaction cannot leave
    // credentials or locks pointing at deleted execution records.
    await deleteIdChunks(runIds, async (runChunk): Promise<void> => {
      await transaction.delete(workloadIdentityTokens).where(inArray(workloadIdentityTokens.runId, runChunk));
      await transaction.delete(stackStateLocks).where(inArray(stackStateLocks.runId, runChunk));
      await transaction.delete(logs).where(inArray(logs.runId, runChunk));
    });
    await transaction.delete(runs).where(inArray(runs.workspaceId, chunk));
    await transaction.delete(configurationVersions).where(inArray(configurationVersions.workspaceId, chunk));
    await transaction.delete(workspaceVariables).where(inArray(workspaceVariables.workspaceId, chunk));
    await transaction.delete(workspaceTags).where(inArray(workspaceTags.workspaceId, chunk));
    await transaction.delete(stateVersions).where(inArray(stateVersions.workspaceId, chunk));
    await transaction.delete(dataRetentionPolicies).where(inArray(dataRetentionPolicies.workspaceId, chunk));
    await transaction.delete(remoteStateConsumers).where(or(
      inArray(remoteStateConsumers.workspaceId, chunk),
      inArray(remoteStateConsumers.consumerWorkspaceId, chunk),
    ));
    await transaction.delete(workspaceRunTasks).where(inArray(workspaceRunTasks.workspaceId, chunk));
  });
}

function isWorkspaceDeletionArtifact(value: unknown): value is WorkspaceDeletionArtifact {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; value?: unknown };
  return (candidate.kind === "run" || candidate.kind === "configuration") && typeof candidate.value === "string";
}

async function cleanupWorkspaceDeletionArtifacts(manifestPath: string): Promise<void> {
  try {
    await access(manifestPath);
  } catch {
    return;
  }

  const cleanupOperations: (() => Promise<void>)[] = [];
  const flush = async (): Promise<void> => {
    if (cleanupOperations.length === 0) return;
    const batch = cleanupOperations.splice(0, DELETION_ARTIFACT_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((cleanup): Promise<void> => cleanup()));
    for (const result of results) {
      if (result.status === "rejected") log.error("Workspace deletion artifact cleanup failed", { error: result.reason });
    }
  };

  try {
    const input = createReadStream(manifestPath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error: unknown) {
          log.error("Workspace deletion artifact manifest entry is invalid", { error });
          continue;
        }
        if (!isWorkspaceDeletionArtifact(parsed)) {
          log.error("Workspace deletion artifact manifest entry is unsupported");
          continue;
        }
        if (parsed.kind === "configuration") {
          cleanupOperations.push((): Promise<void> => rm(parsed.value, { force: true }));
        } else {
          cleanupOperations.push(async (): Promise<void> => { await deleteRunLogArchive(parsed.value); });
          cleanupOperations.push(async (): Promise<void> => { await deletePlanJsonArtifact(parsed.value); });
        }
        if (cleanupOperations.length >= DELETION_ARTIFACT_BATCH_SIZE) await flush();
      }
    } finally {
      lines.close();
      input.destroy();
    }
    await flush();
  } catch (error: unknown) {
    log.error("Workspace deletion artifact manifest cleanup failed", { error });
  } finally {
    await rm(manifestPath, { force: true }).catch((error: unknown): void => {
      log.error("Workspace deletion artifact manifest removal failed", { error });
    });
  }
}

async function withWorkspaceDeletionManifest<T>(
  operation: (manifestPath: string) => Promise<T>,
): Promise<T> {
  const manifestPath = workspaceDeletionManifestPath();
  try {
    const result = await operation(manifestPath);
    await cleanupWorkspaceDeletionArtifacts(manifestPath);
    return result;
  } catch (error: unknown) {
    await rm(manifestPath, { force: true }).catch((cleanupError: unknown): void => {
      log.error("Workspace deletion artifact manifest removal failed after rollback", { error: cleanupError });
    });
    throw error;
  }
}

/**
 * Delete all data associated with one or more workspaces in a transaction.
 * The workspace rows themselves are deleted by the public operation that
 * called this primitive. Files are removed only after the transaction commits.
 */
export async function deleteWorkspaceData(workspaceId: string): Promise<void> {
  await withWorkspaceDeletionManifest(async (manifestPath): Promise<void> => {
    await db.transaction(async (tx: unknown): Promise<void> => {
      await deleteWorkspaceDataInTransaction(tx as typeof db, [workspaceId], manifestPath);
    });
  });
}

/** Delete one workspace, including its parent row, atomically. */
export async function deleteWorkspace(workspaceId: string): Promise<void> {
  await withWorkspaceDeletionManifest(async (manifestPath): Promise<void> => {
    await db.transaction(async (tx: unknown): Promise<void> => {
      const transaction = tx as typeof db;
      await deleteWorkspaceDataInTransaction(transaction, [workspaceId], manifestPath);
      await transaction.delete(workspaces).where(eq(workspaces.id, workspaceId));
    });
  });
}

/**
 * Delete an organization and all of its workspaces in one transaction.
 * Returns member IDs captured before their membership rows are deleted so
 * callers can invalidate permission/event-stream caches after commit.
 */
export async function deleteOrganization(organizationId: string): Promise<readonly string[]> {
  return withWorkspaceDeletionManifest(async (manifestPath): Promise<readonly string[]> => {
    return db.transaction(async (tx: unknown): Promise<readonly string[]> => {
      const transaction = tx as typeof db;
      const organizationWorkspaces = await transaction.query.workspaces.findMany({
        where: eq(workspaces.orgId, organizationId),
        columns: { id: true },
      });
      const memberships = await transaction.query.organizationMemberships.findMany({
        where: eq(organizationMemberships.orgId, organizationId),
        columns: { userId: true },
      });
      await deleteWorkspaceDataInTransaction(
        transaction,
        organizationWorkspaces.map((workspace): string => workspace.id),
        manifestPath,
      );
      await transaction.delete(workspaces).where(eq(workspaces.orgId, organizationId));
      await transaction.delete(organizationMemberships).where(eq(organizationMemberships.orgId, organizationId));
      await transaction.delete(apiTokens).where(eq(apiTokens.orgId, organizationId));
      await transaction.delete(organizations).where(eq(organizations.id, organizationId));
      return [...new Set(memberships.map((membership): string => membership.userId))];
    });
  });
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
        const decoded = decodeStatePayload(latest.statePayload);
        const parsed = JSON.parse(decoded) as Record<string, unknown>;
        // Check if state contains any resources
        const resources = parsed["resources"];
        if (resources !== undefined && Array.isArray(resources) && resources.length > 0) {
          return false; // Has managed resources
        }
      } catch {
        // Fail-closed on corrupt state or decryption failures: refuse deletion when state cannot be verified
        return false;
      }
    }
  }
  await deleteWorkspace(workspaceId);
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
function getGraceCutoff(now: number, gracePeriodMs: number | undefined): number {
  const configuredGraceDays = Number(process.env["GC_GRACE_PERIOD_DAYS"] ?? 7);
  const defaultGracePeriodMs = Number.isFinite(configuredGraceDays) && configuredGraceDays >= 0
    ? configuredGraceDays * 86_400_000
    : 7 * 86_400_000;
  return now - (gracePeriodMs ?? defaultGracePeriodMs);
}

function getRetentionCutoff(policy: Readonly<{ deleteOlderThanNDays?: number | null }> | undefined, now: number): number | null {
  if (policy === undefined) return null;
  if (typeof policy.deleteOlderThanNDays !== "number" || policy.deleteOlderThanNDays <= 0) return null;
  return now - policy.deleteOlderThanNDays * 86_400_000;
}

async function loadRetentionPolicy(workspaceId: string): Promise<{ policy: typeof dataRetentionPolicies.$inferSelect | typeof organizationDataRetentionPolicies.$inferSelect | undefined; policySource: string | null }> {
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
  const policySource = workspacePolicy !== undefined ? "workspace" : organizationPolicy !== undefined ? "organization" : null;
  return { policy, policySource };
}

type GcCollections = DeepReadonly<{
  finalizedVersions: { id: string; createdAt: number; intermediate: boolean }[];
  softDeletedVersions: { id: string; softDeletedAt: number | null }[];
  retainedConfigurationVersions: { id: string; createdAt: number }[];
  softDeletedConfigurationVersions: { id: string; archivePath: string | null; softDeletedAt: number | null }[];
  workspaceRuns: { id: string; status: string; createdAt: number; configurationVersionId: string | null; softDeletedAt: number | null }[];
}>;

async function fetchGcCollections(workspaceId: string): Promise<GcCollections> {
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
      where: and(eq(configurationVersions.workspaceId, workspaceId), inArray(configurationVersions.status, ["uploaded", "archived"])),
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
  return { finalizedVersions, softDeletedVersions, retainedConfigurationVersions, softDeletedConfigurationVersions, workspaceRuns };
}

async function purgeStaleStateVersions(softDeletedVersions: GcCollections["softDeletedVersions"], graceCutoff: number): Promise<number> {
  const stale = softDeletedVersions.filter(({ softDeletedAt }): boolean => typeof softDeletedAt === "number" && softDeletedAt <= graceCutoff);
  if (stale.length > 0) await db.delete(stateVersions).where(inArray(stateVersions.id, stale.map((v): string => v.id)));
  return stale.length;
}

async function stampPendingSoftDeletedStateVersions(softDeletedVersions: GcCollections["softDeletedVersions"], now: number): Promise<void> {
  const ids = softDeletedVersions.filter(({ softDeletedAt }): boolean => softDeletedAt === null).map((v): string => v.id);
  if (ids.length > 0) await db.update(stateVersions).set({ softDeletedAt: now }).where(inArray(stateVersions.id, ids));
}

async function purgeStaleConfigurationVersions(softDeletedConfigurationVersions: GcCollections["softDeletedConfigurationVersions"], graceCutoff: number): Promise<{ count: number; archivesDeleted: number }> {
  const stale = softDeletedConfigurationVersions.filter(({ softDeletedAt }): boolean => typeof softDeletedAt === "number" && softDeletedAt <= graceCutoff);
  let archivesDeleted = 0;
  const ids: string[] = [];
  for (const cv of stale) {
    if (await removeConfigurationArchive(cv.archivePath)) archivesDeleted += 1;
    ids.push(cv.id);
  }
  if (ids.length > 0) await db.update(configurationVersions).set({ archivePath: null, status: "backing_data_permanently_deleted" }).where(inArray(configurationVersions.id, ids));
  return { count: stale.length, archivesDeleted };
}

async function stampPendingSoftDeletedConfigurationVersions(softDeletedConfigurationVersions: GcCollections["softDeletedConfigurationVersions"], now: number): Promise<void> {
  const ids = softDeletedConfigurationVersions.filter(({ softDeletedAt }): boolean => softDeletedAt === null).map((v): string => v.id);
  if (ids.length > 0) await db.update(configurationVersions).set({ softDeletedAt: now }).where(inArray(configurationVersions.id, ids));
}

async function purgeStaleRuns(workspaceRuns: GcCollections["workspaceRuns"], graceCutoff: number): Promise<{ count: number; archivesDeleted: number; retainedRuns: GcCollections["workspaceRuns"] }> {
  const staleRuns = workspaceRuns.filter(({ status, softDeletedAt }): boolean => FINAL_RUN_STATUSES.includes(status) && typeof softDeletedAt === "number" && softDeletedAt <= graceCutoff);
  let archivesDeleted = 0;
  const ids: string[] = [];
  for (const run of staleRuns) {
    const [deleted] = await Promise.all([deleteRunLogArchive(run.id), deletePlanJsonArtifact(run.id)]);
    if (deleted) archivesDeleted += 1;
    ids.push(run.id);
  }
  if (ids.length > 0) await db.delete(runs).where(inArray(runs.id, ids));
  const staleIds = new Set(ids);
  const retainedRuns = workspaceRuns.filter(({ id }): boolean => !staleIds.has(id));
  return { count: staleRuns.length, archivesDeleted, retainedRuns };
}

function collectStateVersionIdsToSoftDelete(finalizedVersions: GcCollections["finalizedVersions"], policy: Readonly<{ stateVersionsCount?: number | null }>, currentStateVersionId: string | undefined, retentionCutoff: number | null): Set<string> {
  return new Set([
    ...addCountBasedStateVersions(finalizedVersions, policy, currentStateVersionId),
    ...addCutoffBasedStateVersions(finalizedVersions, currentStateVersionId, retentionCutoff),
  ]);
}

function addCountBasedStateVersions(finalizedVersions: GcCollections["finalizedVersions"], policy: Readonly<{ stateVersionsCount?: number | null }>, currentStateVersionId: string | undefined): readonly string[] {
  if (typeof policy.stateVersionsCount !== "number" || policy.stateVersionsCount <= 0) return [];
  return finalizedVersions.slice(policy.stateVersionsCount)
    .filter((sv): boolean => sv.id !== currentStateVersionId)
    .map((sv): string => sv.id);
}

function addCutoffBasedStateVersions(finalizedVersions: GcCollections["finalizedVersions"], currentStateVersionId: string | undefined, retentionCutoff: number | null): readonly string[] {
  if (retentionCutoff === null) return [];
  return finalizedVersions
    .filter((sv): boolean => sv.id !== currentStateVersionId && sv.createdAt <= retentionCutoff)
    .map((sv): string => sv.id);
}

async function softDeleteStateVersions(ids: Readonly<ReadonlySet<string>>, now: number): Promise<void> {
  if (ids.size === 0) return;
  await db.update(stateVersions).set({ status: "backing_data_soft_deleted", softDeletedAt: now }).where(inArray(stateVersions.id, [...ids]));
}

function collectConfigurationVersionIds(retainedConfigurationVersions: GcCollections["retainedConfigurationVersions"], retainedRuns: GcCollections["workspaceRuns"], retentionCutoff: number | null): string[] {
  if (retentionCutoff === null) return [];
  const protectedIds = buildProtectedConfigurationIds(retainedConfigurationVersions, retainedRuns);
  return retainedConfigurationVersions.filter(({ id, createdAt }): boolean => !protectedIds.has(id) && createdAt <= retentionCutoff).map(({ id }): string => id);
}

function buildProtectedConfigurationIds(retainedConfigurationVersions: GcCollections["retainedConfigurationVersions"], retainedRuns: GcCollections["workspaceRuns"]): Set<string> {
  const currentId = retainedConfigurationVersions[0]?.id;
  const ids = new Set<string>(currentId === undefined ? [] : [currentId]);
  for (const run of retainedRuns) {
    if (run.configurationVersionId !== null && !FINAL_RUN_STATUSES.includes(run.status)) ids.add(run.configurationVersionId);
  }
  return ids;
}

async function softDeleteConfigurationVersions(ids: readonly string[], now: number): Promise<void> {
  if (ids.length === 0) return;
  await db.update(configurationVersions).set({ status: "backing_data_soft_deleted", softDeletedAt: now }).where(inArray(configurationVersions.id, ids));
}

function collectExpiredRunIds(retainedRuns: GcCollections["workspaceRuns"], retentionCutoff: number | null): readonly string[] {
  if (retentionCutoff === null) return [];
  return retainedRuns.filter(({ status, createdAt, softDeletedAt }): boolean => FINAL_RUN_STATUSES.includes(status) && softDeletedAt === null && createdAt <= retentionCutoff).map(({ id }): string => id);
}

async function archiveAndDeleteExpiredRuns(expiredRunIds: readonly string[], now: number): Promise<{ logsDeletedCount: number; logsArchived: number }> {
  if (expiredRunIds.length === 0) return { logsDeletedCount: 0, logsArchived: 0 };
  const expiredLogs = await db.query.logs.findMany({ where: inArray(logs.runId, expiredRunIds), columns: { id: true } });
  const logsArchived = (await Promise.all(expiredRunIds.map(archiveRunLogs))).filter(Boolean).length;
  await db.delete(logs).where(inArray(logs.runId, expiredRunIds));
  await db.update(runs).set({ softDeletedAt: now }).where(inArray(runs.id, expiredRunIds));
  return { logsDeletedCount: expiredLogs.length, logsArchived };
}

async function applyRetentionPolicy(collections: GcCollections, policy: Readonly<{ stateVersionsCount?: number | null; deleteOlderThanNDays?: number | null }>, now: number, retainedRuns: GcCollections["workspaceRuns"]): Promise<{ stateVersionIds: Set<string>; configurationVersionIds: readonly string[]; expiredRunIds: readonly string[]; logsDeleted: number; logsArchived: number }> {
  const retentionCutoff = getRetentionCutoff(policy, now);
  const currentStateVersionId = collections.finalizedVersions.find(({ intermediate }): boolean => !intermediate)?.id;
  const stateVersionIds = collectStateVersionIdsToSoftDelete(collections.finalizedVersions, policy, currentStateVersionId, retentionCutoff);
  await softDeleteStateVersions(stateVersionIds, now);
  const configurationVersionIds = collectConfigurationVersionIds(collections.retainedConfigurationVersions, retainedRuns, retentionCutoff);
  await softDeleteConfigurationVersions(configurationVersionIds, now);
  const expiredRunIds = collectExpiredRunIds(retainedRuns, retentionCutoff);
  const { logsDeletedCount, logsArchived } = await archiveAndDeleteExpiredRuns(expiredRunIds, now);
  return { stateVersionIds, configurationVersionIds, expiredRunIds, logsDeleted: logsDeletedCount, logsArchived };
}

export async function applyDataRetentionGarbageCollection(
  workspaceId: string,
  options: Readonly<{ now?: number; gracePeriodMs?: number }> = {},
): Promise<Record<string, unknown>> {
  const now = options.now ?? Date.now();
  const graceCutoff = getGraceCutoff(now, options.gracePeriodMs);
  const { policy, policySource } = await loadRetentionPolicy(workspaceId);
  const collections = await fetchGcCollections(workspaceId);
  const staleStateCount = await purgeStaleStateVersions(collections.softDeletedVersions, graceCutoff);
  await stampPendingSoftDeletedStateVersions(collections.softDeletedVersions, now);
  const { count: staleConfigCount, archivesDeleted } = await purgeStaleConfigurationVersions(collections.softDeletedConfigurationVersions, graceCutoff);
  await stampPendingSoftDeletedConfigurationVersions(collections.softDeletedConfigurationVersions, now);
  const { count: staleRunCount, archivesDeleted: runArchivesDeleted, retainedRuns } = await purgeStaleRuns(collections.workspaceRuns, graceCutoff);
  const summary = {
    softDeleted: 0,
    permanentlyDeleted: staleStateCount,
    configurationVersions: { softDeleted: 0, permanentlyDeleted: staleConfigCount, archivesDeleted },
    runs: { softDeleted: 0, permanentlyDeleted: staleRunCount, archivesDeleted: runArchivesDeleted },
    logsDeleted: 0,
    reason: policy === undefined ? "no-policy" : "retention-applied",
    policySource,
  };
  if (policy === undefined) {
    const hasCleanup = staleStateCount + staleConfigCount + staleRunCount > 0;
    return { ...summary, reason: hasCleanup ? "cleanup" : "no-policy" };
  }
  const { stateVersionIds, configurationVersionIds, expiredRunIds, logsDeleted, logsArchived } = await applyRetentionPolicy(collections, policy, now, retainedRuns);
  return {
    ...summary,
    softDeleted: stateVersionIds.size,
    configurationVersions: { ...summary.configurationVersions, softDeleted: configurationVersionIds.length },
    runs: { ...summary.runs, softDeleted: expiredRunIds.length },
    logsDeleted,
    logsArchived,
    count: collections.finalizedVersions.length,
    limit: policy.stateVersionsCount,
    "delete-older-than-n-days": policy.deleteOlderThanNDays,
  };
}
