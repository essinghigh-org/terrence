import { createHash } from "node:crypto";
import { db } from "../db";
import type {
  workspaces, stateVersions, apiTokens, organizations, variableSets, workspaceVariables,
  projects, runs
} from "../db/schema";
import { workspaceTags, variableSetWorkspaces,
  variableSetProjects, variableSetVariables
} from "../db/schema";
import { eq, asc } from "drizzle-orm";
import { apiURL, signedApiURL } from "./utils";
import { parseStatePayload } from "./validation";

type DeepReadonly<T> = T extends ((...args: readonly unknown[]) => unknown) | boolean | number | string | null | undefined
  ? T
  : T extends readonly (infer R)[]
    ? readonly DeepReadonly<R>[]
    : T extends (infer R)[]
      ? readonly DeepReadonly<R>[]
      : { readonly [K in keyof T]: DeepReadonly<T[K]> };

type UserParam = DeepReadonly<{ id: string; username: string; email?: string | null; isSiteAdmin?: boolean; mustChangePassword?: boolean }>;
type AuthenticatedResourceParam = DeepReadonly<{ id: string; type: string }>;

export function userResource(
  user: UserParam,
  authenticatedResource: AuthenticatedResourceParam = { id: user.id, type: "users" }
): Record<string, unknown> {
  const avatarUrl = typeof user.email === "string" && user.email !== ""
    ? `https://www.gravatar.com/avatar/${Bun.hash(user.email)}?d=identicon`
    : `https://www.gravatar.com/avatar/${user.id}?d=identicon`;

  return {
    id: user.id,
    type: "users",
    attributes: {
      username: user.username,
      email: user.email ?? null,
      "is-service-account": authenticatedResource.type !== "users",
      "auth-method": "local",
      "avatar-url": avatarUrl,
      "v2-only": false,
      "is-site-admin": user.isSiteAdmin === true,
      "must-change-password": user.mustChangePassword === true,
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

export function orgMembershipResource(
  mem: OrgMemParam,
  userObj?: UserParam | null,
  teamIds: readonly string[] = []
): Record<string, unknown> {
  return {
    id: mem.id,
    type: "organization-memberships",
    attributes: {
      status: typeof mem.status === "string" && mem.status !== "" ? mem.status : "active",
      email: userObj?.email ?? null,
      role: mem.role,
    },
    relationships: {
      user: {
        data: userObj !== null && userObj !== undefined ? { id: userObj.id, type: "users" } : null,
        links: userObj !== null && userObj !== undefined ? { related: `/api/v2/users/${userObj.id}` } : undefined,
      },
      organization: {
        data: { id: mem.orgId, type: "organizations" },
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
  const rawToken = (token as Record<string, unknown>)["_rawToken"];

  return {
    id: token.id,
    type: "authentication-tokens",
    attributes: {
      "created-at": iso(token.createdAt),
      "last-used-at": iso(token.lastUsedAt),
      description: token.description,
      token: includeSecret && typeof rawToken === "string" ? rawToken : null,
      "expired-at": iso(token.expiresAt),
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
    id: org.id,
    type: "organizations",
    attributes: {
      name: org.name,
      "external-id": org.id,
      email: null,
      "session-timeout": null,
      "session-remember": null,
      "collaborator-auth-policy": "password",
      "cost-estimation-enabled": false,
      "send-passing-statuses-for-untriggered-speculative-plans": false,
      "aggregated-commit-status-enabled": false,
      "speculative-plan-management-enabled": true,
      "allow-force-delete-workspaces": true,
      "default-execution-mode": "remote",
      "user-tokens-enabled": true,
      "default-iac-binary": org.defaultIacBinary ?? "tofu",
      "default-terraform-version": org.defaultTerraformVersion ?? "latest",
      "assessments-enforced": org.assessmentsEnforced,
      "saml-enabled": org.samlEnabled,
      "owners-team-saml-role-id": org.ownersTeamSamlRoleId,
    },
    relationships: {
      "oauth-tokens": { links: { related: `/api/v2/organizations/${name}/oauth-tokens` } },
      "authentication-token": { links: { related: `/api/v2/organizations/${name}/authentication-token` } },
      "entitlement-set": { links: { related: `/api/v2/organizations/${name}/entitlement-set` } },
      subscription: { links: { related: `/api/v2/organizations/${name}/subscription` } },
      "default-agent-pool": { data: null },
    },
    links: { self: `/api/v2/organizations/${name}` },
  };
}

type WorkspaceParam = DeepReadonly<typeof workspaces.$inferSelect>;

export async function workspaceResource(
  workspace: WorkspaceParam,
  defaultIacBinary: string | null | undefined,
  canRun: boolean,
): Promise<Record<string, unknown>> {
  const tags = await db.query.workspaceTags.findMany({
    where: eq(workspaceTags.workspaceId, workspace.id),
    orderBy: [asc(workspaceTags.key)],
  });

  const iacBinary = workspace.iacBinary ?? defaultIacBinary ?? "tofu";

  return {
    id: workspace.id,
    type: "workspaces",
    attributes: {
      actions: { "is-destroyable": canRun },
      "allow-destroy-plan": workspace.allowDestroyPlan ?? true,
      name: workspace.name,
      description: workspace.description,
      "auto-apply": workspace.autoApply === true,
      "auto-apply-run-trigger": workspace.autoApplyRunTrigger === true,
      "file-triggers-enabled": workspace.fileTriggersEnabled ?? true,
      "trigger-prefixes": workspace.triggerPrefixes ?? [],
      "trigger-patterns": workspace.triggerPatterns ?? [],
      "vcs-repo": workspace.vcsRepo ?? null,
      "queue-all-runs": workspace.queueAllRuns ?? true,
      "speculative-enabled": workspace.speculativeEnabled ?? true,
      "global-remote-state": workspace.globalRemoteState === true,
      "project-remote-state": workspace.projectRemoteState === true,
      "agent-pool-id": workspace.agentPoolId ?? null,
      "assessments-enabled": workspace.assessmentsEnabled === true,
      "auto-destroy-at": workspace.autoDestroyAt ?? null,
      "auto-destroy-activity-duration": workspace.autoDestroyActivityDuration ?? null,
      "inherits-project-auto-destroy": workspace.inheritsProjectAutoDestroy,
      "setting-overwrites": workspace.settingOverwrites ?? { "execution-mode": false, "agent-pool": false },
      "terraform-version": workspace.terraformVersion,
      "working-directory": workspace.workingDirectory,
      "source-name": workspace.sourceName,
      "source-url": workspace.sourceUrl,
      "tag-names": tags.map((tag: DeepReadonly<typeof workspaceTags.$inferSelect>): string => tag.key),
      "iac-binary": iacBinary,
      "execution-mode": workspace.executionMode,
      locked: workspace.locked === true,
      "locked-reason": workspace.lockedReason ?? (workspace.locked === true ? "Locked manually" : null),
      operations: true,
      permissions: {
        "can-destroy": canRun,
        "can-force-unlock": canRun,
        "can-lock": canRun,
        "can-manage-run-tasks": false,
        "can-queue-apply": canRun,
        "can-queue-destroy": canRun,
        "can-queue-run": canRun,
        "can-read-settings": true,
        "can-read-state-versions": true,
        "can-read-variable": true,
        "can-unlock": canRun,
        "can-update": canRun,
        "can-update-variable": canRun,
        "can-force-delete": canRun,
      },
      source: "tfe-api",
      "structured-run-output-enabled": false,
    },
    relationships: {
      organization: {
        data: { id: workspace.orgId, type: "organizations" },
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
    },
    links: { self: `/api/v2/workspaces/${workspace.id}` },
  };
}

type ProjectParam = DeepReadonly<typeof projects.$inferSelect>;

export function projectResource(project: ProjectParam): Record<string, unknown> {
  return {
    id: project.id,
    type: "projects",
    attributes: {
      name: project.name,
      description: project.description,
      "default-execution-mode": project.defaultExecutionMode ?? "remote",
      "auto-destroy-activity-duration": project.autoDestroyActivityDuration ?? null,
      "setting-overwrites": project.settingOverwrites ?? { "execution-mode": false },
      "created-at": new Date(project.createdAt).toISOString(),
    },
    relationships: {
      organization: {
        data: { id: project.orgId, type: "organizations" },
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
      hcl: false,
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
    description: attributes.description ?? variable.description,
  };
}

type VarSetParam = DeepReadonly<typeof variableSets.$inferSelect>;

export async function variableSetResource(variableSet: VarSetParam): Promise<Record<string, unknown>> {
  const [workspaceLinks, projectLinks, variables] = await Promise.all([
    db.query.variableSetWorkspaces.findMany({
      where: eq(variableSetWorkspaces.variableSetId, variableSet.id),
    }),
    db.query.variableSetProjects.findMany({
      where: eq(variableSetProjects.variableSetId, variableSet.id),
    }),
    db.query.variableSetVariables.findMany({
      where: eq(variableSetVariables.variableSetId, variableSet.id),
    }),
  ]);
  return {
    id: variableSet.id,
    type: "varsets",
    attributes: {
      name: variableSet.name,
      description: variableSet.description,
      global: variableSet.global === true,
      priority: variableSet.priority === true,
      "var-count": variables.length,
      "workspace-count": workspaceLinks.length,
      "project-count": projectLinks.length,
    },
    relationships: {
      organization: { data: { id: variableSet.orgId, type: "organizations" } },
      parent: { data: { id: variableSet.orgId, type: "organizations" } },
      workspaces: {
        data: workspaceLinks.map((link: DeepReadonly<typeof variableSetWorkspaces.$inferSelect>): { id: string; type: string } => ({ id: link.workspaceId, type: "workspaces" })),
      },
      projects: {
        data: projectLinks.map((link: DeepReadonly<typeof variableSetProjects.$inferSelect>): { id: string; type: string } => ({ id: link.projectId, type: "projects" })),
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
  };
}

type RunParam = DeepReadonly<typeof runs.$inferSelect>;

function runHasChanges(run: RunParam): boolean {
  const counts = [run.planResourceAdditions, run.planResourceChanges, run.planResourceDestructions];
  if (counts.some((count): boolean => count !== null)) {
    return counts.reduce((total: number, count): number => total + (count ?? 0), 0) > 0;
  }
  return [
    "planned", "cost_estimating", "cost_estimated", "policy_checking", "policy_override",
    "policy_checked", "policy_soft_failed", "post_plan_running", "post_plan_completed",
    "planned_and_finished", "planned_and_saved", "confirmed", "apply_queued", "applying", "applied",
  ].includes(run.status);
}

export function runResource(run: RunParam, canRun: boolean): Record<string, unknown> {
  const isPlanned = ["planned", "planned_and_saved", "policy_soft_failed"].includes(run.status);
  const isRunning = [
    "pending", "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed",
    "queuing", "plan_queued", "planning", "cost_estimating", "cost_estimated",
    "policy_checking", "policy_override", "policy_checked", "post_plan_running",
    "post_plan_completed", "confirmed", "apply_queued", "applying",
  ].includes(run.status);
  const hasChanges = runHasChanges(run);

  return {
    id: run.id,
    type: "runs",
    attributes: {
      actions: {
        "is-cancelable": canRun && isRunning,
        "is-confirmable": canRun && isPlanned,
        "is-discardable": canRun && isPlanned,
        "is-force-cancelable": canRun && isRunning,
      },
      "allow-empty-apply": run.allowEmptyApply,
      "auto-apply": run.autoApply,
      "has-changes": hasChanges,
      message: run.message,
      operation: run.isDestroy === true
        ? "destroy"
        : run.refreshOnly
          ? "refresh_only"
          : run.planOnly
            ? "plan_only"
            : "plan_and_apply",
      "plan-only": run.planOnly,
      refresh: run.refresh,
      "refresh-only": run.refreshOnly,
      "replace-addrs": run.replaceAddrs,
      "save-plan": run.savePlan,
      "allow-config-generation": run.allowConfigGeneration,
      source: "tfe-api",
      status: run.status,
      "status-timestamps": run.statusTimestamps ?? null,
      "target-addrs": run.targetAddrs,
      "terraform-version": run.terraformVersion,
      "debugging-mode": run.debuggingMode,
      "is-destroy": run.isDestroy === true,
      "created-at": new Date(run.createdAt).toISOString(),
      "trigger-reason": "manual",
      variables: run.variables ?? [],
      "resource-additions": run.planResourceAdditions ?? 0,
      "resource-changes": run.planResourceChanges ?? 0,
      "resource-destructions": run.planResourceDestructions ?? 0,
      permissions: {
        "can-apply": canRun && isPlanned,
        "can-cancel": canRun && isRunning,
        "can-discard": canRun && isPlanned,
        "can-force-cancel": canRun && isRunning,
        "can-force-execute": false,
        "can-override-policy-check": canRun && run.status === "policy_soft_failed",
        "can-comment": canRun,
      },
    },
    relationships: {
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
    },
  };
}

type RequestParam = DeepReadonly<Request>;

export function planResource(run: RunParam, request: RequestParam): Record<string, unknown> {
  const status = run.status === "planning"
    ? "running"
    : run.status === "plan_queued" || run.status === "queuing"
      ? "queued"
      : [
          "planned", "cost_estimating", "cost_estimated", "policy_checking", "policy_override",
          "policy_checked", "policy_soft_failed", "post_plan_running", "post_plan_completed",
          "planned_and_finished", "planned_and_saved", "confirmed", "apply_queued", "applying", "applied",
        ].includes(run.status)
        ? "finished"
        : run.status === "errored"
          ? "errored"
          : ["canceled", "discarded", "force_canceled"].includes(run.status)
            ? "canceled"
            : run.status === "unreachable"
              ? "unreachable"
              : "pending";

  return {
    id: `plan-${run.id}`,
    type: "plans",
    attributes: {
      status,
      "has-changes": runHasChanges(run),
      "resource-additions": run.planResourceAdditions ?? 0,
      "resource-changes": run.planResourceChanges ?? 0,
      "resource-destructions": run.planResourceDestructions ?? 0,
      "resource-imports": 0,
      "generated-configuration": false,
      "execution-details": { mode: "remote" },
      "log-read-url": typeof run.logToken === "string" && run.logToken !== "" ? apiURL(request, `/api/v2/runs/${run.id}/plan/log/${run.logToken}`) : null,
      "status-timestamps": run.statusTimestamps ?? null,
    },
    relationships: {
      "state-versions": {
        links: { related: `/api/v2/state-versions?filter[run][id]=${run.id}` },
      },
    },
  };
}

export function applyResource(run: RunParam, request: RequestParam): Record<string, unknown> {
  const status = run.status === "applying"
    ? "running"
    : run.status === "confirmed" || run.status === "apply_queued"
      ? "queued"
      : run.status === "applied"
        ? "finished"
        : run.status === "errored"
          ? "errored"
          : ["canceled", "discarded", "force_canceled"].includes(run.status)
            ? "canceled"
            : run.status === "unreachable"
              ? "unreachable"
              : "pending";

  return {
    id: `apply-${run.id}`,
    type: "applies",
    attributes: {
      status,
      "resource-additions": run.applyResourceAdditions ?? 0,
      "resource-changes": run.applyResourceChanges ?? 0,
      "resource-destructions": run.applyResourceDestructions ?? 0,
      "resource-imports": 0,
      "log-read-url": typeof run.logToken === "string" && run.logToken !== "" ? apiURL(request, `/api/v2/runs/${run.id}/apply/log/${run.logToken}`) : null,
      "status-timestamps": run.statusTimestamps ?? null,
    },
    relationships: {
      "state-versions": {
        links: { related: `/api/v2/state-versions?filter[run][id]=${run.id}` },
      },
    },
  };
}

type StateParam = DeepReadonly<typeof stateVersions.$inferSelect>;

export function stateOutputResources(state: StateParam): Record<string, unknown>[] {
  const parsed = parseStatePayload(state.statePayload);
  const outputs = parsed?.outputs;
  if (outputs === null || outputs === undefined || typeof outputs !== "object" || Array.isArray(outputs)) return [];

  return Object.entries(outputs).map(([name, raw]: readonly [string, unknown]): Record<string, unknown> => {
    const id = `wsout-${createHash("sha256").update(`${state.id}\0${name}`).digest("hex").slice(0, 16)}`;
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

export function stateVersionResource(
  state: StateParam,
  request: Readonly<{ url: string }>,
  includeState = false,
): Record<string, unknown> {
  const parsed = parseStatePayload(state.statePayload);
  const rawResources = Array.isArray(parsed?.resources) ? parsed.resources : [];
  const resources = rawResources
    .filter((resource: unknown): resource is Record<string, unknown> =>
      resource !== null && resource !== undefined && typeof resource === "object" &&
      typeof (resource as Record<string, unknown>).type === "string" &&
      typeof (resource as Record<string, unknown>).name === "string"
    )
    .map((resource: DeepReadonly<Record<string, unknown>>): { name: string; type: string; count: number; module: string; provider: string | null } => {
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
    });

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

  const outputResources = stateOutputResources(state);
  const payload = state.statePayload ?? "";
  const backingDataAvailable = state.status !== "backing_data_soft_deleted"
    && state.status !== "backing_data_permanently_deleted"
    && state.status !== "discarded";
  const rawStateAvailable = backingDataAvailable && payload !== "";
  const jsonStateAvailable = backingDataAvailable && typeof state.jsonState === "string" && state.jsonState !== "";
  const pending = state.status === "pending";
  return {
    id: state.id,
    type: "state-versions",
    attributes: {
      ...(includeState ? { state: state.statePayload } : {}),
      serial: state.serial,
      md5: createHash("md5").update(payload).digest("hex"),
      lineage: typeof parsed?.lineage === "string" ? parsed.lineage : null,
      "terraform-version": typeof parsed?.terraform_version === "string" ? parsed.terraform_version : null,
      "resources-processed": parsed !== null,
      resources,
      modules,
      providers,
      "state-version": parsed !== null && typeof parsed.version === "number" && Number.isInteger(parsed.version) ? parsed.version : null,
      status: state.status ?? "finalized",
      intermediate: state.intermediate,
      size: Buffer.byteLength(payload),
      "vcs-commit-sha": state.vcsCommitSha,
      "vcs-commit-url": state.vcsCommitUrl,
      "hosted-state-download-url": rawStateAvailable
        ? signedApiURL(request, `/api/v2/state-versions/${state.id}/download`)
        : null,
      "hosted-state-upload-url": pending && !rawStateAvailable
        ? signedApiURL(request, `/api/v2/state-versions/${state.id}/upload`, "PUT")
        : null,
      "hosted-json-state-download-url": jsonStateAvailable
        ? signedApiURL(request, `/api/v2/state-versions/${state.id}/json-download`)
        : null,
      "hosted-json-state-upload-url": pending && !jsonStateAvailable
        ? signedApiURL(request, `/api/v2/state-versions/${state.id}/json-upload`, "PUT")
        : null,
    },
    relationships: {
      workspace: { data: { id: state.workspaceId, type: "workspaces" } },
      run: state.runId !== null ? { data: { id: state.runId, type: "runs" } } : { data: null },
      outputs: {
        data: outputResources.map((output: DeepReadonly<Record<string, unknown>>): OutputResourceRef => ({ id: output.id as string, type: output.type as string })),
      },
    },
    links: { self: `/api/v2/state-versions/${state.id}` },
  };
}
