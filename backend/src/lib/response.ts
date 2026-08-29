import { createHash } from "node:crypto";
import { db } from "../db";
import { AvatarService } from "./avatars";
import type {
  workspaces, stateVersions, apiTokens, variableSets, workspaceVariables,
  projects, runs
} from "../db/schema";
import { organizations, workspaceTags, variableSetWorkspaces,
  variableSetProjects, variableSetVariables, stackVariableSets
} from "../db/schema";
import { eq, asc } from "drizzle-orm";
import { apiURL, signedApiURL , type DeepReadonly } from "./utils";
import { decodeStatePayload, parseStatePayload } from "./validation";
import { cachedOrganizationName, cacheOrganizationName } from "./metadata-cache";
import { vcsRepoResource } from "./vcs-repo";
import { moduleTestTokenTtlBounds } from "./workload-identity";


type UserParam = DeepReadonly<{ id: string; username: string; email?: string | null; emailVerifiedAt?: number | null; isSiteAdmin?: boolean | null; mustChangePassword?: boolean; theme?: string | null; ssoProvider?: string | null }>;
type AuthenticatedResourceParam = DeepReadonly<{ id: string; type: string }>;

// JSON:API convention (matching the reference format/Atlas): organizations are identified by their NAME,
// so every "organizations" resource reference carries the name in `id`. go-tfe decodes
// `Organization.Name` from the JSON:API primary (`data.id`) field.
export async function organizationName(orgId: string): Promise<string | null> {
  const cached = cachedOrganizationName(orgId);
  if (cached !== undefined) return cached;
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, orgId),
    columns: { name: true },
  });
  const name = org?.name ?? null;
  cacheOrganizationName(orgId, name);
  return name;
}

// Keep the precise nested response type available to callers and contract tests.
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function userResource(
  user: UserParam,
  authenticatedResource: AuthenticatedResourceParam = { id: user.id, type: "users" }
) {
  const rawAvatarUrl = typeof user.email === "string" && user.email !== ""
    ? `https://www.gravatar.com/avatar/${createHash('md5').update(user.email.toLowerCase().trim()).digest('hex')}?d=mp&s=80`
    : `https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&s=80&f=y`;
  // Same-origin avatar service: the browser never contacts Gravatar directly.
  const avatarUrl = AvatarService.resolveUrl("user-gravatar", rawAvatarUrl);

  return {
    id: user.id,
    type: "users",
    attributes: {
      username: user.username,
      email: user.email ?? null,
      "email-verified": user.emailVerifiedAt !== null && user.emailVerifiedAt !== undefined,
      "is-service-account": authenticatedResource.type !== "users",
      "auth-method": user.ssoProvider === "ldap"
        ? "ldap"
        : typeof user.ssoProvider === "string" && user.ssoProvider !== ""
          ? "sso"
          : "password",
      "avatar-url": avatarUrl,
      "v2-only": false,
      "is-site-admin": user.isSiteAdmin === true,
      "must-change-password": user.mustChangePassword === true,
      theme: user.theme ?? "original-light",
      permissions: {
        "can-create-organizations": authenticatedResource.type === "users",
        "can-change-email": authenticatedResource.type === "users",
        "can-change-username": authenticatedResource.type === "users",
      },
    },
    relationships: {
      "authentication-tokens": {
        links: { related: `/api/v2/users/${user.id}/authentication-tokens` },
      },
      "authenticated-resource": {
        data: authenticatedResource,
        links: { related: `/api/v2/${authenticatedResource.type}/${authenticatedResource.id}` },
      },
    },
    links: { self: `/api/v2/users/${user.id}` },
  };
}

type OrgMemParam = DeepReadonly<{ id: string; userId: string; orgId: string; role: string; status?: string | null }>;

export async function orgMembershipResource(
  mem: OrgMemParam,
  userObj?: UserParam | null,
  teamIds: readonly string[] = []
): Promise<Record<string, unknown>> {
  return {
    id: mem.id,
    type: "organization-memberships",
    attributes: {
      status: typeof mem.status === "string" && mem.status !== "" ? mem.status : "active",
      username: userObj?.username ?? null,
      email: userObj?.email ?? null,
      role: mem.role,
    },
    relationships: {
      user: {
        data: userObj !== null && userObj !== undefined ? { id: userObj.id, type: "users" } : null,
        links: userObj !== null && userObj !== undefined ? { related: `/api/v2/users/${userObj.id}` } : undefined,
      },
      organization: {
        data: { id: (await organizationName(mem.orgId)) ?? mem.orgId, type: "organizations" },
      },
      teams: {
        data: teamIds.map((id: string): { id: string; type: string } => ({ id, type: "teams" })),
      },
    },
    links: { self: `/api/v2/organization-memberships/${mem.id}` },
  };
}

type ApiTokenWithRaw = DeepReadonly<typeof apiTokens.$inferSelect & Partial<Record<"_rawToken", string>>>;

export function tokenResource(token: ApiTokenWithRaw, includeSecret = false): Record<string, unknown> {
  const iso = (value: number | null): string | null => value === null ? null : new Date(value).toISOString();
  const rawToken = (token as Record<string, unknown>)._rawToken;
  let scopes: unknown = null;
  if (typeof token.scopes === "string" && token.scopes !== "") {
    try {
      scopes = JSON.parse(token.scopes);
    } catch {
      scopes = null;
    }
  }

  return {
    id: token.id,
    type: "authentication-tokens",
    attributes: {
      "created-at": iso(token.createdAt),
      "last-used-at": iso(token.lastUsedAt),
      description: token.description,
      token: includeSecret && typeof rawToken === "string" ? rawToken : null,
      "expired-at": iso(token.expiresAt),
      scopes,
    },
    relationships: {
      "created-by": {
        data: token.userId !== null ? { id: token.userId, type: "users" } : null,
      },
    },
  };
}

type OrganizationParam = DeepReadonly<typeof organizations.$inferSelect>;

export function organizationResource(org: OrganizationParam): Record<string, unknown> {
  const name = encodeURIComponent(org.name);
  return {
    id: org.name,
    type: "organizations",
    attributes: {
      name: org.name,
      "external-id": org.id,
      email: org.email,
      "session-timeout": org.sessionTimeout,
      "session-remember": org.sessionRemember,
      "collaborator-auth-policy": org.collaboratorAuthPolicy,
      "cost-estimation-enabled": org.costEstimationEnabled === true,
      "send-passing-statuses-for-untriggered-speculative-plans": org.sendPassingStatusesForUntriggeredSpeculativePlans === true,
      "aggregated-commit-status-enabled": org.aggregatedCommitStatusEnabled !== false,
      "speculative-plan-management-enabled": true,
      "allow-force-delete-workspaces": org.allowForceDeleteWorkspaces === true,
      "default-execution-mode": org.defaultExecutionMode ?? "remote",
      "stacks-enabled": org.stacksEnabled === true,
      "show-pre-releases": org.showPreReleases === true,
      "user-tokens-enabled": org.userTokensEnabled === true,
      "default-iac-binary": org.defaultIacBinary ?? "terraform",
      "default-terraform-version": org.defaultTerraformVersion ?? "latest",
      "module-test-token-ttl": org.moduleTestTokenTtl ?? moduleTestTokenTtlBounds.default,
      "assessments-enforced": org.assessmentsEnforced,
      "saml-enabled": org.samlEnabled,
      "owners-team-saml-role-id": org.ownersTeamSamlRoleId,
    },
    relationships: {
      "oauth-tokens": { links: { related: `/api/v2/organizations/${name}/oauth-tokens` } },
      "authentication-token": { links: { related: `/api/v2/organizations/${name}/authentication-token` } },
      "entitlement-set": { links: { related: `/api/v2/organizations/${name}/entitlement-set` } },
      subscription: { links: { related: `/api/v2/organizations/${name}/subscription` } },
      "default-agent-pool": { data: org.defaultAgentPoolId === null ? null : { id: org.defaultAgentPoolId, type: "agent-pools" } },
    },
    links: { self: `/api/v2/organizations/${name}` },
  };
}

type WorkspaceParam = DeepReadonly<typeof workspaces.$inferSelect>;

export type WorkspaceResourcePermissions = Readonly<{
  canAdmin: boolean;
  canApply: boolean;
  canLock: boolean;
  canManageRunTasks: boolean;
  canPlan: boolean;
  canReadStateVersions: boolean;
  canWriteStateVersions?: boolean;
  canReadVariables: boolean;
  canWriteVariables: boolean;
}>;

type WorkspaceResourceOptions = Readonly<{
  /** Preloaded org name; skips the per-workspace organizations lookup. */
  readonly orgName?: string | null;
  /** Preloaded tags for this workspace; skips the per-workspace tags query. */
  readonly tags?: readonly DeepReadonly<typeof workspaceTags.$inferSelect>[];
  /**
   * Latest run for this workspace (10.4). `undefined` omits the
   * current-run relationship entirely; `null` emits `{ data: null }`
   * (requested via `include=current_run` but no run exists yet).
   */
  readonly currentRun?: Readonly<{ id: string }> | null;
}>;


function buildWorkspacePermissions(permissions: WorkspaceResourcePermissions): Record<string, unknown> {
  return {
    "can-destroy": permissions.canPlan,
    "can-force-unlock": permissions.canAdmin,
    "can-lock": permissions.canLock,
    "can-manage-run-tasks": permissions.canManageRunTasks,
    "can-queue-apply": permissions.canApply,
    "can-queue-destroy": permissions.canPlan,
    "can-queue-run": permissions.canPlan,
    "can-read-settings": true,
    "can-read-state-versions": permissions.canReadStateVersions,
    "can-write-state-versions": permissions.canWriteStateVersions === true,
    "can-read-variable": permissions.canReadVariables,
    "can-unlock": permissions.canLock,
    "can-update": permissions.canAdmin,
    "can-update-variable": permissions.canWriteVariables,
    "can-force-delete": permissions.canAdmin,
  };
}


function buildWorkspaceCoreAttributes(workspace: WorkspaceParam): Record<string, unknown> {
  return {
    name: workspace.name,
    description: workspace.description,
    "vcs-repo": vcsRepoResource(workspace.vcsRepo ?? null),
    "terraform-version": workspace.terraformVersion,
    "working-directory": workspace.workingDirectory,
    "source-name": workspace.sourceName,
    "source-url": workspace.sourceUrl,
    "execution-mode": workspace.executionMode,
    "created-at": new Date(workspace.createdAt).toISOString(),
    source: workspace.source ?? "tfe-api",
  };
}

function buildWorkspaceFlagAttributes(workspace: WorkspaceParam): Record<string, unknown> {
  return {
    "allow-destroy-plan": workspace.allowDestroyPlan ?? true,
    "auto-apply": workspace.autoApply === true,
    "auto-apply-run-trigger": workspace.autoApplyRunTrigger === true,
    "file-triggers-enabled": workspace.fileTriggersEnabled ?? true,
    "trigger-prefixes": workspace.triggerPrefixes ?? [],
    "trigger-patterns": workspace.triggerPatterns ?? [],
    "queue-all-runs": workspace.queueAllRuns ?? true,
    "speculative-enabled": workspace.speculativeEnabled ?? true,
    "global-remote-state": workspace.globalRemoteState === true,
    "project-remote-state": workspace.projectRemoteState === true,
    "assessments-enabled": workspace.assessmentsEnabled === true,
    operations: true,
    "structured-run-output-enabled": true,
  };
}

function buildWorkspaceAttributes(workspace: WorkspaceParam, permissions: WorkspaceResourcePermissions, tags: DeepReadonly<typeof workspaceTags.$inferSelect>[], iacBinary: string): Record<string, unknown> {
  return {
    actions: { "is-destroyable": permissions.canPlan },
    ...buildWorkspaceCoreAttributes(workspace),
    ...buildWorkspaceFlagAttributes(workspace),
    "agent-pool-id": workspace.agentPoolId ?? null,
    "auto-destroy-at": workspace.autoDestroyAt ?? null,
    "auto-destroy-activity-duration": workspace.autoDestroyActivityDuration ?? null,
    "inherits-project-auto-destroy": workspace.inheritsProjectAutoDestroy,
    "setting-overwrites": workspace.settingOverwrites ?? { "execution-mode": false, "agent-pool": false },
    "tag-names": tags.map((tag: DeepReadonly<typeof workspaceTags.$inferSelect>): string => tag.key),
    "iac-binary": iacBinary,
    locked: workspace.locked === true,
    "locked-reason": workspace.lockedReason ?? (workspace.locked === true ? "Locked manually" : null),
    permissions: buildWorkspacePermissions(permissions),
    "owned-by-type": workspace.ownedByType ?? null,
    "owned-by-id": workspace.ownedById ?? null,
    "contact-email": workspace.contactEmail ?? null,
  };
}

function buildWorkspaceRelationships(workspace: WorkspaceParam, orgName: string | null | undefined, options?: WorkspaceResourceOptions): Record<string, unknown> {
  const base: Record<string, unknown> = {
    organization: {
      data: { id: orgName ?? workspace.orgId, type: "organizations" },
    },
    project: {
      data: workspace.projectId !== null ? { id: workspace.projectId, type: "projects" } : null,
    },
    "ssh-key": {
      data: workspace.sshKeyId !== null ? { id: workspace.sshKeyId, type: "ssh-keys" } : null,
    },
    "tag-bindings": {
      links: { related: `/api/v2/workspaces/${workspace.id}/tag-bindings` },
    },
    "effective-tag-bindings": {
      links: { related: `/api/v2/workspaces/${workspace.id}/effective-tag-bindings` },
    },
    "remote-state-consumers": {
      links: { related: `/api/v2/workspaces/${workspace.id}/relationships/remote-state-consumers` },
    },
    "data-retention-policy": {
      links: { related: `/api/v2/workspaces/${workspace.id}/relationships/data-retention-policy` },
    },
    ...(options?.currentRun === undefined
      ? {}
      : {
          "current-run": {
            data: options.currentRun === null ? null : { id: options.currentRun.id, type: "runs" },
          },
        }),
  };
  return base;
}

async function fetchWorkspaceTagsAndOrg(workspace: WorkspaceParam, options?: WorkspaceResourceOptions): Promise<[DeepReadonly<typeof workspaceTags.$inferSelect>[], string | null | undefined]> {
  const [tags, orgName] = await Promise.all([
    options?.tags
      ?? db.query.workspaceTags.findMany({
        where: eq(workspaceTags.workspaceId, workspace.id),
        orderBy: [asc(workspaceTags.key)],
      }),
    options?.orgName
      ?? organizationName(workspace.orgId),
  ]);
  return [tags, orgName];
}

export async function workspaceResource(
  workspace: WorkspaceParam,
  defaultIacBinary: string | null | undefined,
  permissions: WorkspaceResourcePermissions,
  options?: WorkspaceResourceOptions,
): Promise<Record<string, unknown>> {
  const [tags, orgName] = await fetchWorkspaceTagsAndOrg(workspace, options);
  const iacBinary = workspace.iacBinary ?? defaultIacBinary ?? "terraform";
  return {
    id: workspace.id,
    type: "workspaces",
    attributes: buildWorkspaceAttributes(workspace, permissions, tags, iacBinary),
    relationships: buildWorkspaceRelationships(workspace, orgName, options),
    links: { self: `/api/v2/workspaces/${workspace.id}` },
  };
}

type ProjectParam = DeepReadonly<typeof projects.$inferSelect>;

export async function projectResource(
  project: ProjectParam,
  workspaceCount = 0,
  teamCount = 0,
  permissions: Record<string, boolean> = { "can-update": true, "can-destroy": true, "can-create-workspace": true },
  orgName?: string | null,
): Promise<Record<string, unknown>> {
  const relationshipOrgName = orgName !== undefined
    ? (orgName ?? null)
    : await organizationName(project.orgId);
  return {
    id: project.id,
    type: "projects",
    attributes: {
      name: project.name,
      description: project.description,
      "workspace-count": workspaceCount,
      "team-count": teamCount,
      "default-execution-mode": project.defaultExecutionMode ?? "remote",
      "auto-destroy-activity-duration": project.autoDestroyActivityDuration ?? null,
      "setting-overwrites": project.settingOverwrites ?? { "execution-mode": false },
      "created-at": new Date(project.createdAt).toISOString(),
      permissions,
    },
    relationships: {
      organization: {
        data: { id: relationshipOrgName ?? project.orgId, type: "organizations" },
      },
      "default-agent-pool": {
        data: project.defaultAgentPoolId === null
          ? null
          : { id: project.defaultAgentPoolId, type: "agent-pools" },
      },
      "tag-bindings": {
        links: { related: `/api/v2/projects/${project.id}/tag-bindings` },
      },
      "effective-tag-bindings": {
        links: { related: `/api/v2/projects/${project.id}/effective-tag-bindings` },
      },
    },
    links: { self: `/api/v2/projects/${project.id}` },
  };
}

type TagParam = DeepReadonly<typeof workspaceTags.$inferSelect>;

export function tagBindingResource(tag: TagParam, effective = false): Record<string, unknown> {
  return {
    id: tag.id,
    type: effective ? "effective-tag-bindings" : "tag-bindings",
    attributes: { key: tag.key, value: tag.value ?? "" },
  };
}

type ProjectTagParam = DeepReadonly<{ id: string; projectId: string; key: string; value?: string | null }>;

export function projectTagBindingResource(pt: ProjectTagParam): Record<string, unknown> {
  return {
    id: pt.id,
    type: "tag-bindings",
    attributes: {
      key: pt.key,
      value: pt.value ?? "",
    },
    relationships: {
      project: {
        data: { id: pt.projectId, type: "projects" },
      },
    },
    links: { self: `/api/v2/projects/${pt.projectId}/tag-bindings/${pt.id}` },
  };
}

type VarSetVariableParam = DeepReadonly<typeof variableSetVariables.$inferSelect>;

export function variableSetVariableResource(variable: VarSetVariableParam): Record<string, unknown> {
  return {
    id: variable.id,
    type: "vars",
    attributes: {
      key: variable.key,
      value: variable.sensitive === true ? null : variable.value,
      category: variable.category,
      sensitive: variable.sensitive === true,
      hcl: variable.hcl === true,
      description: variable.description,
    },
    relationships: {
      varset: { data: { id: variable.variableSetId, type: "varsets" } },
    },
  };
}

type VarAttrsParam = DeepReadonly<{
  key?: string;
  value?: string;
  category?: string;
  sensitive?: boolean;
  hcl?: boolean;
  description?: string;
}>;

export function variableSetVariableUpdate(
  variable: VarSetVariableParam,
  attributes: VarAttrsParam,
): Record<string, unknown> {
  let sensitive = attributes.sensitive ?? variable.sensitive === true;
  if (variable.sensitive === true && !sensitive && attributes.value === undefined) sensitive = true;
  return {
    key: attributes.key ?? variable.key,
    value: attributes.value ?? variable.value,
    category: attributes.category ?? variable.category,
    sensitive,
    hcl: attributes.hcl ?? variable.hcl === true,
    description: attributes.description ?? variable.description,
  };
}

type VarSetParam = DeepReadonly<typeof variableSets.$inferSelect>;

type VariableSetResourceOptions = Readonly<{
  readonly workspaceLinks?: readonly DeepReadonly<typeof variableSetWorkspaces.$inferSelect>[];
  readonly projectLinks?: readonly DeepReadonly<typeof variableSetProjects.$inferSelect>[];
  readonly stackLinks?: readonly DeepReadonly<typeof stackVariableSets.$inferSelect>[];
  readonly variables?: readonly DeepReadonly<typeof variableSetVariables.$inferSelect>[];
  readonly orgName?: string | null;
}>;

export async function variableSetResource(
  variableSet: VarSetParam,
  options?: VariableSetResourceOptions,
): Promise<Record<string, unknown>> {
  // Each collection is loaded independently: callers may preload some or all
  // of them (list handlers batch per page); anything omitted is fetched here.
  const [workspaceLinks, projectLinks, stackLinks, variables] = await Promise.all([
    options?.workspaceLinks
      ?? db.query.variableSetWorkspaces.findMany({
        where: eq(variableSetWorkspaces.variableSetId, variableSet.id),
      }),
    options?.projectLinks
      ?? db.query.variableSetProjects.findMany({
        where: eq(variableSetProjects.variableSetId, variableSet.id),
      }),
    options?.stackLinks
      ?? db.query.stackVariableSets.findMany({
        where: eq(stackVariableSets.variableSetId, variableSet.id),
      }),
    options?.variables
      ?? db.query.variableSetVariables.findMany({
        where: eq(variableSetVariables.variableSetId, variableSet.id),
      }),
  ]);
  const orgName = options?.orgName !== undefined
    ? options.orgName
    : await organizationName(variableSet.orgId);
  return {
    id: variableSet.id,
    type: "varsets",
    attributes: {
      name: variableSet.name,
      description: variableSet.description,
      global: variableSet.global === true,
      priority: variableSet.priority === true,
      "parent-project-id": variableSet.parentProjectId ?? null,
      "var-count": variables.length,
      "workspace-count": workspaceLinks.length,
      "project-count": projectLinks.length,
      "stack-count": stackLinks.length,
    },
    relationships: {
      organization: { data: { id: orgName ?? variableSet.orgId, type: "organizations" } },
      parent: variableSet.parentProjectId === null
        ? { data: { id: orgName ?? variableSet.orgId, type: "organizations" } }
        : { data: { id: variableSet.parentProjectId, type: "projects" } },
      workspaces: {
        data: workspaceLinks.map((link: DeepReadonly<typeof variableSetWorkspaces.$inferSelect>): { id: string; type: string } => ({ id: link.workspaceId, type: "workspaces" })),
      },
      projects: {
        data: projectLinks.map((link: DeepReadonly<typeof variableSetProjects.$inferSelect>): { id: string; type: string } => ({ id: link.projectId, type: "projects" })),
      },
      stacks: {
        data: stackLinks.map((link: DeepReadonly<typeof stackVariableSets.$inferSelect>): { id: string; type: string } => ({ id: link.stackId, type: "stacks" })),
      },
      vars: {
        data: variables.map((variable: DeepReadonly<typeof variableSetVariables.$inferSelect>): { id: string; type: string } => ({ id: variable.id, type: "vars" })),
      },
    },
    links: { self: `/api/v2/varsets/${variableSet.id}` },
  };
}

type WorkspaceVarParam = DeepReadonly<typeof workspaceVariables.$inferSelect>;

export function workspaceVariableResource(v: WorkspaceVarParam): Record<string, unknown> {
  return {
    id: v.id,
    type: "vars",
    attributes: {
      key: v.key,
      value: v.sensitive === true ? null : v.value,
      category: v.category,
      sensitive: v.sensitive === true,
      description: v.description,
      hcl: v.hcl === true,
    },
    relationships: {
      workspace: {
        data: { id: v.workspaceId, type: "workspaces" },
      },
      configurable: {
        data: { id: v.workspaceId, type: "workspaces" },
      },
    },
    links: { self: `/api/v2/workspaces/${v.workspaceId}/vars/${v.id}` },
  };
}

type RunParam = DeepReadonly<typeof runs.$inferSelect>;
type RunOrigin = Readonly<{
  source?: string | null;
  triggerReason?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  commitUrl?: string | null;
  triggeredBy?: string | null;
  triggeredByAvatarUrl?: string | null;
}>;

// Statuses that indicate the plan has completed past the "pending/queued"
// phase, regardless of success. The same set gates both change detection and
// the plan-resource status mapping below.
const PLAN_REACHED_TERMINAL_STATUSES = [
  "planned", "cost_estimating", "cost_estimated", "policy_checking", "policy_override",
  "policy_checked", "policy_soft_failed", "post_plan_running", "post_plan_completed",
  "planned_and_finished", "planned_and_saved", "confirmed", "apply_queued", "applying", "applied",
];

function runHasChanges(run: RunParam): boolean {
  const counts = [
    run.planResourceAdditions,
    run.planResourceChanges,
    run.planResourceDestructions,
    run.planResourceImports,
  ];
  if (counts.some((count): boolean => count !== null)) {
    return counts.reduce((total: number, count): number => total + (count ?? 0), 0) > 0;
  }
  return PLAN_REACHED_TERMINAL_STATUSES.includes(run.status);
}


function getRunStatusFlags(run: RunParam): { isPlanned: boolean; isConfirmable: boolean; isRunning: boolean; hasChanges: boolean } {
  const isPlanned = ["planned", "planned_and_saved", "policy_soft_failed"].includes(run.status);
  const isConfirmable = ["planned", "planned_and_saved"].includes(run.status);
  const isRunning = [
    "pending", "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed",
    "queuing", "plan_queued", "planning", "cost_estimating", "cost_estimated",
    "policy_checking", "policy_override", "policy_checked", "post_plan_running",
    "post_plan_completed", "confirmed", "apply_queued", "applying",
  ].includes(run.status);
  const hasChanges = runHasChanges(run);
  return { isPlanned, isConfirmable, isRunning, hasChanges };
}

function resolveRunOperation(run: RunParam): string {
  if (typeof run.operation === "string" && run.operation !== "") return run.operation;
  if (run.isDestroy === true) return "destroy";
  if (run.refreshOnly) return "refresh_only";
  if (run.savePlan) return "save_plan";
  if (run.allowEmptyApply) return "empty_apply";
  if (run.planOnly) return "plan_only";
  return "plan_and_apply";
}

function resolveNormalizedSource(origin?: RunOrigin): string {
  const src = origin?.source;
  if (src === "tfe-ui" || src === "tfe-api" || src === "tfe-configuration-version" || src === "github" || src === "gitlab" || src === "bitbucket") {
    return src;
  }
  if (src === undefined || src === null || src === "") return "tfe-api";
  if (src === "github" || src === "gitlab" || src === "bitbucket") return src;
  return "tfe-configuration-version";
}

function buildRunActionAttributes(flags: { isPlanned: boolean; isConfirmable: boolean; isRunning: boolean }, canApply: boolean, canAdmin: boolean): Record<string, unknown> {
  return {
    "is-cancelable": canApply && flags.isRunning,
    "is-confirmable": canApply && flags.isConfirmable,
    "is-discardable": canApply && flags.isPlanned,
    "is-force-cancelable": canAdmin && flags.isRunning,
  };
}

function buildRunCoreAttributes(run: RunParam, operation: string, normalizedSource: string, hasChanges: boolean): Record<string, unknown> {
  return {
    "allow-empty-apply": run.allowEmptyApply,
    "auto-apply": run.autoApply,
    "has-changes": hasChanges,
    message: run.message,
    operation,
    "plan-only": run.planOnly,
    refresh: run.refresh,
    "refresh-only": run.refreshOnly,
    "replace-addrs": run.replaceAddrs,
    "save-plan": run.savePlan,
    "allow-config-generation": run.allowConfigGeneration,
    "generated-configuration": run.generatedConfiguration === true,
    "execution-mode": run.executionMode,
    source: normalizedSource,
    status: run.status,
    "status-timestamps": run.statusTimestamps ?? null,
  };
}

function buildRunTimeAttributes(run: RunParam): Record<string, unknown> {
  return {
    "applied-at": run.appliedAt === null || run.appliedAt === undefined ? null : new Date(run.appliedAt).toISOString(),
    "target-addrs": run.targetAddrs,
    "terraform-version": run.terraformVersion,
    "invoke-action-addrs": run.invokeActionAddrs ?? [],
    "debugging-mode": run.debuggingMode,
    "is-destroy": run.isDestroy === true,
    "created-at": new Date(run.createdAt).toISOString(),
  };
}

function buildRunBaselineAttributes(baseline?: Readonly<{ "median-duration-seconds"?: number | null; "duration-seconds"?: number | null; "is-slow"?: boolean }> | null): Record<string, unknown> {
  if (baseline === undefined || baseline === null) return { "duration-baseline": undefined };
  return {
    "duration-baseline": {
      "duration-seconds": baseline["duration-seconds"] ?? null,
      "median-duration-seconds": baseline["median-duration-seconds"] ?? null,
      "is-slow": baseline["is-slow"] === true,
    },
  };
}

function resolveTriggeredByAvatarUrl(origin?: RunOrigin): string | null {
  const originRecord = origin as Record<string, unknown> | undefined;
  const avatar = originRecord?.triggeredByAvatarUrl;
  const providerId = originRecord?.triggeredByProviderId;
  return AvatarService.resolveVcsUrl(
    typeof providerId === "string" ? providerId : null,
    typeof avatar === "string" ? avatar : null,
  );
}

function buildRunTriggerAttributes(origin?: RunOrigin): Record<string, unknown> {
  const originRecord = origin as Record<string, unknown> | undefined;
  return {
    "trigger-reason": originRecord?.triggerReason ?? "manual",
    "branch": originRecord?.branch ?? null,
    "commit-sha": originRecord?.commitSha ?? null,
    "commit-url": originRecord?.commitUrl ?? null,
    "triggered-by": originRecord?.triggeredBy ?? null,
    "triggered-by-avatar-url": resolveTriggeredByAvatarUrl(origin),
  };
}

function getRunVariablesForResponse(run: RunParam): unknown[] {
  if (!Array.isArray(run.variables)) return [];
  return (run.variables as Record<string, unknown>[]).map((v) => ({
    ...v,
    value: v.sensitive === true ? "******" : v.value,
  }));
}

function buildRunResourceAttributes(run: RunParam): Record<string, unknown> {
  return {
    variables: getRunVariablesForResponse(run),
    "resource-additions": run.planResourceAdditions ?? 0,
    "resource-changes": run.planResourceChanges ?? 0,
    "resource-destructions": run.planResourceDestructions ?? 0,
    "resource-imports": run.planResourceImports ?? 0,
  };
}

function buildRunPermissionAttributes(flags: { isPlanned: boolean; isConfirmable: boolean; isRunning: boolean }, canApply: boolean, canAdmin: boolean, canOverridePolicy: boolean, status: string): Record<string, unknown> {
  return {
    "can-apply": canApply && flags.isConfirmable,
    "can-cancel": canApply && flags.isRunning,
    "can-discard": canApply && flags.isPlanned,
    "can-force-cancel": canAdmin && flags.isRunning,
    "can-force-execute": canAdmin && status === "canceled",
    "can-override-policy-check": canOverridePolicy && status === "policy_soft_failed",
    "can-comment": canApply,
  };
}

function buildRunAttributes(run: RunParam, flags: { isPlanned: boolean; isConfirmable: boolean; isRunning: boolean; hasChanges: boolean }, operation: string, normalizedSource: string, origin?: RunOrigin, baseline?: Readonly<{ "median-duration-seconds"?: number | null; "duration-seconds"?: number | null; "is-slow"?: boolean }> | null, canApply = false, canAdmin = false, canOverridePolicy = false): Record<string, unknown> {
  return {
    actions: buildRunActionAttributes(flags, canApply, canAdmin),
    ...buildRunCoreAttributes(run, operation, normalizedSource, flags.hasChanges),
    ...buildRunTimeAttributes(run),
    ...buildRunBaselineAttributes(baseline),
    ...buildRunTriggerAttributes(origin),
    ...buildRunResourceAttributes(run),
    permissions: buildRunPermissionAttributes(flags, canApply, canAdmin, canOverridePolicy, run.status),
  };
}

function buildRunRelationships(run: RunParam): Record<string, unknown> {
  return {
    workspace: {
      data: { id: run.workspaceId, type: "workspaces" },
      links: { related: `/api/v2/workspaces/${run.workspaceId}` },
    },
    "configuration-version": {
      data: run.configurationVersionId !== null
        ? { id: run.configurationVersionId, type: "configuration-versions" }
        : null,
      links: run.configurationVersionId !== null
        ? { related: `/api/v2/configuration-versions/${run.configurationVersionId}` }
        : undefined,
    },
    plan: {
      data: { id: `plan-${run.id}`, type: "plans" },
      links: { related: `/api/v2/runs/${run.id}/plan` },
    },
    apply: {
      data: { id: `apply-${run.id}`, type: "applies" },
      links: { related: `/api/v2/applies/apply-${run.id}` },
    },
    "run-events": {
      links: { related: `/api/v2/runs/${run.id}/run-events` },
    },
    "created-by": {
      data: run.createdBy !== null ? { id: run.createdBy, type: "users" } : null,
    },
    agent: {
      data: run.agentId !== null ? { id: run.agentId, type: "agents" } : null,
    },
    "agent-pool": {
      data: run.agentPoolId !== null ? { id: run.agentPoolId, type: "agent-pools" } : null,
    },
    "cost-estimate": {
      links: { related: `/api/v2/runs/${run.id}/cost-estimate` },
    },
    "policy-checks": {
      links: { related: `/api/v2/runs/${run.id}/policy-checks` },
    },
    comments: {
      links: { related: `/api/v2/runs/${run.id}/comments` },
    },
    "input-state-version": {
      links: { related: `/api/v2/runs/${run.id}/input-state-version` },
    },
    "workspace-run-alerts": {
      data: [],
    },
  };
}

export function runResource(
  run: RunParam,
  canApply: boolean,
  canOverridePolicy = false,
  origin?: RunOrigin,
  baseline?: Readonly<{
    "median-duration-seconds"?: number | null;
    "duration-seconds"?: number | null;
    "is-slow"?: boolean;
  }> | null,
  canAdmin = canApply,
): Record<string, unknown> {
  const flags = getRunStatusFlags(run);
  const operation = resolveRunOperation(run);
  const normalizedSource = resolveNormalizedSource(origin);
  return {
    id: run.id,
    type: "runs",
    attributes: buildRunAttributes(run, flags, operation, normalizedSource, origin, baseline, canApply, canAdmin, canOverridePolicy),
    relationships: buildRunRelationships(run),
    links: { self: `/api/v2/runs/${run.id}` },
  };
}

type RequestParam = Readonly<{ readonly url: string }>;


function resolvePlanStatus(run: RunParam, planStarted: boolean, planFinished: boolean): string {
  if (run.status === "planning") return "running";
  if (run.status === "plan_queued" || run.status === "queuing") return "queued";
  if (PLAN_REACHED_TERMINAL_STATUSES.includes(run.status)) return "finished";
  if (run.status === "errored") return planFinished ? "finished" : "errored";
  if (["canceled", "discarded", "force_canceled"].includes(run.status)) {
    if (planFinished) return "finished";
    if (planStarted) return "canceled";
    return "pending";
  }
  if (run.status === "unreachable") return planFinished ? "finished" : "unreachable";
  return "pending";
}

function resolveApplyStatus(run: RunParam, applyStarted: boolean): string {
  if (run.status === "applying") return "running";
  if (run.status === "confirmed" || run.status === "apply_queued") return "queued";
  if (run.status === "applied") return "finished";
  if (run.status === "errored") return applyStarted ? "errored" : "pending";
  if (["canceled", "discarded", "force_canceled"].includes(run.status)) return applyStarted ? "canceled" : "pending";
  if (run.status === "unreachable") return applyStarted ? "unreachable" : "pending";
  return "pending";
}

export function planResource(run: RunParam, request: RequestParam): Record<string, unknown> {
  const timestamps = run.statusTimestamps ?? {};
  const planStarted = typeof timestamps["planning-at"] === "string";
  const planFinished = typeof timestamps["planned-at"] === "string"
    || typeof timestamps["planned-and-finished-at"] === "string"
    || typeof timestamps["planned-and-saved-at"] === "string";
  const status = resolvePlanStatus(run, planStarted, planFinished);
  return {
    id: `plan-${run.id}`,
    type: "plans",
    attributes: {
      status,
      "has-changes": runHasChanges(run),
      "resource-additions": run.planResourceAdditions ?? null,
      "resource-changes": run.planResourceChanges ?? null,
      "resource-destructions": run.planResourceDestructions ?? null,
      "resource-imports": run.planResourceImports ?? null,
      "generated-configuration": run.generatedConfiguration === true,
      "execution-details": { mode: run.executionMode ?? "remote" },
      "log-read-url": typeof run.logToken === "string" && run.logToken !== "" ? apiURL(request, `/api/v2/runs/${run.id}/plan/log/${run.logToken}`) : null,
      "status-timestamps": run.statusTimestamps ?? null,
    },
    relationships: {
      "state-versions": {
        links: { related: `/api/v2/state-versions?filter[run][id]=${run.id}` },
      },
    },
    links: { self: `/api/v2/plans/plan-${run.id}` },
  };
}

export function applyResource(run: RunParam, request: RequestParam): Record<string, unknown> {
  const timestamps = run.statusTimestamps ?? {};
  const applyStarted = ["confirmed-at", "apply-queued-at", "applying-at", "applied-at"]
    .some((key: string): boolean => typeof timestamps[key] === "string");
  const status = resolveApplyStatus(run, applyStarted);
  return {
    id: `apply-${run.id}`,
    type: "applies",
    attributes: {
      status,
      "resource-additions": run.applyResourceAdditions ?? null,
      "resource-changes": run.applyResourceChanges ?? null,
      "resource-destructions": run.applyResourceDestructions ?? null,
      "resource-imports": run.applyResourceImports ?? null,
      "log-read-url": typeof run.logToken === "string" && run.logToken !== "" ? apiURL(request, `/api/v2/runs/${run.id}/apply/log/${run.logToken}`) : null,
      "status-timestamps": run.statusTimestamps ?? null,
    },
    relationships: {
      "state-versions": {
        links: { related: `/api/v2/state-versions?filter[run][id]=${run.id}` },
      },
    },
    links: { self: `/api/v2/applies/apply-${run.id}` },
  };
}

export type StateParam = DeepReadonly<typeof stateVersions.$inferSelect>;

export function stateOutputResources(state: StateParam): Record<string, unknown>[] {
  const parsed = parseStatePayload(state.statePayload);
  const outputs = parsed?.outputs;
  if (outputs === null || outputs === undefined || typeof outputs !== "object" || Array.isArray(outputs)) return [];

  return Object.entries(outputs).map(([name, raw]: readonly [string, unknown]): Record<string, unknown> => {
    const id = `wsout-${createHash("sha256").update(`${state.id}\0${name}`).digest("hex")}`;
    const output = raw !== null && raw !== undefined && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : { value: raw };
    const value = output.value;
    const rawType = output.type;
    const detailedType = rawType ?? (
      Array.isArray(value) ? ["tuple", value.map((item: unknown): string => typeof item)] :
      value === null ? "null" :
      typeof value === "object" ? "object" :
      typeof value
    );
    const type = typeof detailedType === "string"
      ? detailedType
      : (Array.isArray(value) ? "array" : "object");

    return {
      id,
      type: "state-version-outputs",
      attributes: {
        name,
        value,
        sensitive: output.sensitive === true,
        type,
        "detailed-type": detailedType,
      },
      links: {
        self: `/api/v2/state-version-outputs/${id}`,
      },
    };
  });
}

type OutputResourceRef = { id: string; type: string };

// go-tfe reads a workspace's outputs via GET /workspaces/:id?include=outputs,
// where the included resources are type "workspace-outputs" with a
// name/sensitive/output-type/value shape (see tfe.WorkspaceOutputs).
export function workspaceOutputResources(state: StateParam): Record<string, unknown>[] {
  return stateOutputResources(state).map((resource: Record<string, unknown>): Record<string, unknown> => {
    const attributes = (resource.attributes ?? {}) as Record<string, unknown>;
    return {
      id: resource.id,
      type: "workspace-outputs",
      attributes: {
        name: attributes.name,
        // Sensitive output values are never exposed through the workspace
        // include=outputs path; authorized clients fetch them via the
        // state-version-outputs endpoint instead.
        value: attributes.sensitive === true ? null : attributes.value,
        sensitive: attributes.sensitive,
        "output-type": attributes.type,
      },
      links: { self: `/api/v2/state-version-outputs/${String(resource.id)}` },
    };
  });
}

function isStateResourceRecord(resource: unknown): resource is Record<string, unknown> {
  return resource !== null && resource !== undefined && typeof resource === "object" &&
    typeof (resource as Record<string, unknown>).type === "string" &&
    typeof (resource as Record<string, unknown>).name === "string";
}

function normalizeStateResource(resource: Record<string, unknown>): { name: string; type: string; count: number; module: string; provider: string | null } {
  const rType = resource.type as string;
  const rName = resource.name as string;
  const rMode = resource.mode;
  const rInstances = resource.instances;
  const rModule = resource.module;
  const rProvider = resource.provider;
  return {
    name: rName,
    type: `${rMode === "data" ? "data." : ""}${rType}`,
    count: Array.isArray(rInstances) ? rInstances.length : 0,
    module: typeof rModule === "string" ? rModule : "root",
    provider: typeof rProvider === "string" ? rProvider : null,
  };
}

function extractStateResources(parsed: unknown): { name: string; type: string; count: number; module: string; provider: string | null }[] {
  const rawResources = Array.isArray((parsed as Record<string, unknown> | null)?.resources) ? (parsed as Record<string, unknown>).resources as unknown[] : [];
  return (rawResources)
    .filter(isStateResourceRecord)
    .map(normalizeStateResource);
}

function buildStateAggregates(resources: { name: string; type: string; count: number; module: string; provider: string | null }[]): { modules: Record<string, Record<string, number>>; providers: Record<string, Record<string, number>> } {
  const modules: Record<string, Record<string, number>> = {};
  const providers: Record<string, Record<string, number>> = {};
  for (const resource of resources) {
    const kind = resource.type.replaceAll("_", "-");
    const mod = modules[resource.module] ?? {};
    modules[resource.module] = mod;
    mod[kind] = (mod[kind] ?? 0) + resource.count;
    if (typeof resource.provider === "string") {
      const prov = providers[resource.provider] ?? {};
      providers[resource.provider] = prov;
      prov[kind] = (prov[kind] ?? 0) + resource.count;
    }
  }
  return { modules, providers };
}

function getStateAvailability(state: StateParam, payload: string): { rawStateAvailable: boolean; jsonStateAvailable: boolean; pending: boolean } {
  const backingDataAvailable = state.status !== "backing_data_soft_deleted" && state.status !== "backing_data_permanently_deleted" && state.status !== "discarded";
  const rawStateAvailable = backingDataAvailable && payload !== "";
  const jsonStateAvailable = backingDataAvailable && typeof state.jsonState === "string" && state.jsonState !== "";
  const pending = state.status === "pending";
  return { rawStateAvailable, jsonStateAvailable, pending };
}

function buildStateCoreAttributes(state: StateParam, parsed: Readonly<Record<string, unknown> | null>, resources: { name: string; type: string; count: number; module: string; provider: string | null }[], aggregates: { modules: Record<string, Record<string, number>>; providers: Record<string, Record<string, number>> }, payload: string, includeState: boolean): Record<string, unknown> {
  return {
    ...(includeState ? { state: payload } : {}),
    serial: state.serial,
    md5: createHash("md5").update(payload).digest("hex"),
    lineage: typeof (parsed as Record<string, unknown> | null)?.lineage === "string" ? (parsed as Record<string, unknown>).lineage : null,
    "terraform-version": typeof (parsed as Record<string, unknown> | null)?.terraform_version === "string" ? (parsed as Record<string, unknown>).terraform_version : null,
    "resources-processed": parsed !== null,
    resources,
    modules: aggregates.modules,
    providers: aggregates.providers,
    "state-version": parsed !== null && typeof (parsed as Record<string, unknown>).version === "number" && Number.isInteger((parsed as Record<string, unknown>).version) ? (parsed as Record<string, unknown>).version : null,
    status: state.status ?? "finalized",
    intermediate: state.intermediate,
    size: Buffer.byteLength(payload),
    "created-at": new Date(state.createdAt).toISOString(),
    "vcs-commit-sha": state.vcsCommitSha,
    "vcs-commit-url": state.vcsCommitUrl,
  };
}

function buildStateUrlAttributes(state: StateParam, flags: { rawStateAvailable: boolean; jsonStateAvailable: boolean; pending: boolean }, request: Readonly<{ url: string }>): Record<string, unknown> {
  return {
    "hosted-state-download-url": flags.rawStateAvailable ? signedApiURL(request, `/api/v2/state-versions/${state.id}/download`) : null,
    "hosted-state-upload-url": flags.pending && !flags.rawStateAvailable ? signedApiURL(request, `/api/v2/state-versions/${state.id}/upload`, "PUT") : null,
    "hosted-json-state-download-url": flags.jsonStateAvailable ? signedApiURL(request, `/api/v2/state-versions/${state.id}/json-download`) : null,
    "hosted-json-state-upload-url": flags.pending && !flags.jsonStateAvailable ? signedApiURL(request, `/api/v2/state-versions/${state.id}/json-upload`, "PUT") : null,
  };
}

function buildStateRunAttributes(run?: Readonly<{ status: string; message: string | null }> | null): Record<string, unknown> {
  return {
    "run-status": run !== null && run !== undefined ? run.status : null,
    "run-message": run !== null && run !== undefined ? run.message : null,
  };
}

function buildStateVersionAttributes(state: StateParam, parsed: Readonly<Record<string, unknown> | null>, resources: { name: string; type: string; count: number; module: string; provider: string | null }[], aggregates: { modules: Record<string, Record<string, number>>; providers: Record<string, Record<string, number>> }, payload: string, flags: { rawStateAvailable: boolean; jsonStateAvailable: boolean; pending: boolean }, request: Readonly<{ url: string }>, includeState: boolean, run?: Readonly<{ status: string; message: string | null }> | null): Record<string, unknown> {
  return {
    ...buildStateCoreAttributes(state, parsed, resources, aggregates, payload, includeState),
    ...buildStateUrlAttributes(state, flags, request),
    ...buildStateRunAttributes(run),
  };
}

function buildStateVersionRelationships(state: StateParam): Record<string, unknown> {
  const outputResources = stateOutputResources(state);
  return {
    workspace: { data: { id: state.workspaceId, type: "workspaces" } },
    run: state.runId !== null ? { data: { id: state.runId, type: "runs" } } : { data: null },
    outputs: {
      data: outputResources.map((output): OutputResourceRef => ({ id: output.id as string, type: output.type as string })),
    },
  };
}

export function stateVersionResource(
  state: StateParam,
  request: Readonly<{ url: string }>,
  includeState = false,
  run?: Readonly<{ status: string; message: string | null }> | null,
): Record<string, unknown> {
  const parsed = parseStatePayload(state.statePayload);
  const resources = extractStateResources(parsed);
  const aggregates = buildStateAggregates(resources);
  const payload = state.statePayload === null ? "" : decodeStatePayload(state.statePayload);
  const flags = getStateAvailability(state, payload);
  return {
    id: state.id,
    type: "state-versions",
    attributes: buildStateVersionAttributes(state, parsed, resources, aggregates, payload, flags, request, includeState, run),
    relationships: buildStateVersionRelationships(state),
    links: { self: `/api/v2/state-versions/${state.id}` },
  };
}
