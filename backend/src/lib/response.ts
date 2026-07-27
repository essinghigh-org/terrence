/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { db } from "../db";
import type {
  workspaces, stateVersions, apiTokens, organizations, variableSets, workspaceVariables,
  projects, runs} from "../db/schema";
import { workspaceTags, users,
  organizationMemberships, variableSetWorkspaces,
  variableSetProjects, variableSetVariables, configurationVersions, logs, agentPools,
} from "../db/schema";
import { eq, asc } from "drizzle-orm";
import { apiURL } from "./utils";
import { parseStatePayload, decodeStatePayload } from "./validation";

export function userResource(user: { id: string; username: string; email?: string | null }, authenticatedResource = { id: user.id, type: "users" }) {
  const avatarUrl = user.email
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
      "is-site-admin": (user as any).isSiteAdmin === true,
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

export function orgMembershipResource(
  mem: { id: string; userId: string; orgId: string; role: string; status?: string | null },
  userObj?: { id: string; username: string; email?: string | null } | null,
  teamIds: string[] = []
) {
  return {
    id: mem.id,
    type: "organization-memberships",
    attributes: {
      status: mem.status || "active",
      email: userObj?.email ?? null,
      role: mem.role,
    },
    relationships: {
      user: {
        data: userObj ? { id: userObj.id, type: "users" } : null,
        links: userObj ? { related: `/api/v2/users/${userObj.id}` } : undefined,
      },
      organization: {
        data: { id: mem.orgId, type: "organizations" },
      },
      teams: {
        data: teamIds.map(id => ({ id, type: "teams" })),
      },
    },
    links: { self: `/api/v2/organization-memberships/${mem.id}` },
  };
}

export function tokenResource(token: typeof apiTokens.$inferSelect & { _rawToken?: string }, includeSecret = false) {
  const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();

  return {
    id: token.id,
    type: "authentication-tokens",
    attributes: {
      "created-at": iso(token.createdAt),
      "last-used-at": iso(token.lastUsedAt),
      description: token.description,
      token: includeSecret ? (token._rawToken || null) : null,
      "expired-at": iso(token.expiresAt),
    },
    relationships: {
      "created-by": {
        data: token.userId ? { id: token.userId, type: "users" } : null,
      },
    },
  };
}

export function organizationResource(org: typeof organizations.$inferSelect) {
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

export async function workspaceResource(
  workspace: typeof workspaces.$inferSelect,
  defaultIacBinary: string | null | undefined,
  canRun: boolean,
) {
  const tags = await db.query.workspaceTags.findMany({
    where: eq(workspaceTags.workspaceId, workspace.id),
    orderBy: [asc(workspaceTags.key)],
  });

  return {
    id: workspace.id,
    type: "workspaces",
    attributes: {
      actions: { "is-destroyable": canRun },
      "allow-destroy-plan": workspace.allowDestroyPlan ?? true,
      name: workspace.name,
      description: workspace.description,
      "auto-apply": workspace.autoApply,
      "auto-apply-run-trigger": Boolean(workspace.autoApplyRunTrigger),
      "file-triggers-enabled": workspace.fileTriggersEnabled ?? true,
      "trigger-prefixes": workspace.triggerPrefixes ?? [],
      "trigger-patterns": workspace.triggerPatterns ?? [],
      "vcs-repo": workspace.vcsRepo ?? null,
      "queue-all-runs": workspace.queueAllRuns ?? true,
      "speculative-enabled": workspace.speculativeEnabled ?? true,
      "global-remote-state": Boolean(workspace.globalRemoteState),
      "project-remote-state": Boolean(workspace.projectRemoteState),
      "agent-pool-id": workspace.agentPoolId ?? null,
      "assessments-enabled": Boolean(workspace.assessmentsEnabled),
      "auto-destroy-at": workspace.autoDestroyAt ?? null,
      "auto-destroy-activity-duration": workspace.autoDestroyActivityDuration ?? null,
      "setting-overwrites": workspace.settingOverwrites ?? null,
      "terraform-version": workspace.terraformVersion,
      "working-directory": workspace.workingDirectory,
      "source-name": workspace.sourceName,
      "source-url": workspace.sourceUrl,
      "tag-names": tags.map(tag => tag.key),
      "iac-binary": workspace.iacBinary || defaultIacBinary || "tofu",
      "execution-mode": "remote",
      locked: workspace.locked,
      "locked-reason": workspace.lockedReason ?? (workspace.locked ? "Locked manually" : null),
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
        data: workspace.projectId ? { id: workspace.projectId, type: "projects" } : null,
      },
      "ssh-key": {
        data: workspace.sshKeyId ? { id: workspace.sshKeyId, type: "ssh-keys" } : null,
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

export function projectResource(project: typeof projects.$inferSelect) {
  return {
    id: project.id,
    type: "projects",
    attributes: {
      name: project.name,
      description: project.description,
      "default-execution-mode": project.defaultExecutionMode ?? "remote",
      "auto-destroy-activity-duration": project.autoDestroyActivityDuration ?? null,
      "setting-overwrites": project.settingOverwrites ?? null,
      "created-at": new Date(project.createdAt).toISOString(),
    },
    relationships: {
      organization: {
        data: { id: project.orgId, type: "organizations" },
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

export function tagBindingResource(tag: typeof workspaceTags.$inferSelect, effective = false) {
  return {
    id: tag.id,
    type: effective ? "effective-tag-bindings" : "tag-bindings",
    attributes: { key: tag.key, value: tag.value || "" },
  };
}

export function projectTagBindingResource(pt: { id: string; projectId: string; key: string; value?: string | null }) {
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

export function variableSetVariableResource(variable: typeof variableSetVariables.$inferSelect) {
  return {
    id: variable.id,
    type: "vars",
    attributes: {
      key: variable.key,
      value: variable.sensitive ? null : variable.value,
      category: variable.category,
      sensitive: variable.sensitive,
      hcl: false,
      description: variable.description,
    },
    relationships: {
      varset: { data: { id: variable.variableSetId, type: "varsets" } },
    },
  };
}

export function variableSetVariableUpdate(
  variable: typeof variableSetVariables.$inferSelect,
  attributes: any,
) {
  let sensitive = attributes.sensitive === undefined ? variable.sensitive : attributes.sensitive;
  if (variable.sensitive && sensitive === false && attributes.value === undefined) sensitive = true;
  return {
    key: attributes.key === undefined ? variable.key : attributes.key,
    value: attributes.value === undefined ? variable.value : attributes.value,
    category: attributes.category === undefined ? variable.category : attributes.category,
    sensitive,
    description: attributes.description === undefined ? variable.description : attributes.description,
  };
}

export async function variableSetResource(variableSet: typeof variableSets.$inferSelect) {
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
      global: variableSet.global,
      priority: Boolean(variableSet.priority),
      "var-count": variables.length,
      "workspace-count": workspaceLinks.length,
      "project-count": projectLinks.length,
    },
    relationships: {
      organization: { data: { id: variableSet.orgId, type: "organizations" } },
      parent: { data: { id: variableSet.orgId, type: "organizations" } },
      workspaces: {
        data: workspaceLinks.map(link => ({ id: link.workspaceId, type: "workspaces" })),
      },
      projects: {
        data: projectLinks.map(link => ({ id: link.projectId, type: "projects" })),
      },
      vars: {
        data: variables.map(variable => ({ id: variable.id, type: "vars" })),
      },
    },
    links: { self: `/api/v2/varsets/${variableSet.id}` },
  };
}

export function workspaceVariableResource(v: typeof workspaceVariables.$inferSelect) {
  return {
    id: v.id,
    type: "vars",
    attributes: {
      key: v.key,
      value: v.sensitive ? null : v.value,
      category: v.category,
      sensitive: v.sensitive,
      description: v.description,
      hcl: v.hcl,
    },
  };
}

export function runResource(run: typeof runs.$inferSelect, canRun: boolean) {
  const isPlanned = ["planned", "planned_and_saved", "policy_soft_failed"].includes(run.status);
  const isRunning = ["pending", "planning", "fetching", "fetching_completed", "plan_queued", "queuing", "applying", "apply_queued"].includes(run.status);
  const hasChanges = ["planned", "planned_and_finished", "planned_and_saved", "applying", "applied"].includes(run.status);

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
      "allow-empty-apply": run.allowEmptyApply ?? false,
      "auto-apply": run.autoApply,
      "has-changes": hasChanges,
      message: run.message,
      operation: run.isDestroy
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
      "save-plan": run.savePlan ?? false,
      "allow-config-generation": run.allowConfigGeneration ?? false,
      source: "tfe-api",
      status: run.status,
      "status-timestamps": run.statusTimestamps ?? null,
      "target-addrs": run.targetAddrs,
      "terraform-version": run.terraformVersion,
      "debugging-mode": run.debuggingMode,
      "is-destroy": run.isDestroy,
      "created-at": new Date(run.createdAt).toISOString(),
      "trigger-reason": "manual",
      variables: run.variables || [],
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
        data: run.configurationVersionId
          ? { id: run.configurationVersionId, type: "configuration-versions" }
          : null,
        links: run.configurationVersionId
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
        data: run.createdBy ? { id: run.createdBy, type: "users" } : null,
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

export function planResource(run: typeof runs.$inferSelect, request: Request) {
  const status = run.status === "planning"
    ? "running"
    : run.status === "plan_queued" || run.status === "queuing"
      ? "queued"
      : ["planned", "planned_and_finished", "planned_and_saved", "applying", "applied"].includes(run.status)
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
      "has-changes": ["planned", "planned_and_finished", "planned_and_saved", "applying", "applied"].includes(run.status),
      "resource-additions": run.planResourceAdditions ?? 0,
      "resource-changes": run.planResourceChanges ?? 0,
      "resource-destructions": run.planResourceDestructions ?? 0,
      "resource-imports": 0,
      "generated-configuration": false,
      "execution-details": { mode: "remote" },
      "log-read-url": run.logToken ? apiURL(request, `/api/v2/runs/${run.id}/plan/log/${run.logToken}`) : null,
      "status-timestamps": run.statusTimestamps ?? null,
    },
    relationships: {
      "state-versions": {
        links: { related: `/api/v2/state-versions?filter[run][id]=${run.id}` },
      },
    },
  };
}

export function applyResource(run: typeof runs.$inferSelect, request: Request) {
  const status = run.status === "applying"
    ? "running"
    : run.status === "apply_queued"
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
      "log-read-url": run.logToken ? apiURL(request, `/api/v2/runs/${run.id}/apply/log/${run.logToken}`) : null,
      "status-timestamps": run.statusTimestamps ?? null,
    },
    relationships: {
      "state-versions": {
        links: { related: `/api/v2/state-versions?filter[run][id]=${run.id}` },
      },
    },
  };
}

export function stateOutputResources(state: typeof stateVersions.$inferSelect) {
  const outputs = parseStatePayload(state.statePayload)?.outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return [];

  return Object.entries(outputs).map(([name, raw]) => {
    const id = `wsout-${createHash("sha256").update(`${state.id}\0${name}`).digest("hex").slice(0, 16)}`;
    const output = raw && typeof raw === "object" ? raw : { value: raw };
    const value = output.value;
    const detailedType = output.type ?? (
      Array.isArray(value) ? ["tuple", value.map(item => typeof item)] :
      value === null ? "null" :
      typeof value === "object" ? "object" :
      typeof value
    );
    const type = typeof detailedType === "string"
      ? detailedType
      : Array.isArray(value) ? "array" : "object";

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

export function stateVersionResource(
  state: typeof stateVersions.$inferSelect,
  request: Request,
  includeState = false,
) {
  const parsed = parseStatePayload(state.statePayload);
  const rawResources = Array.isArray(parsed?.resources) ? parsed.resources : [];
  const resources = rawResources
    .filter(resource => resource && typeof resource.type === "string" && typeof resource.name === "string")
    .map(resource => ({
      name: resource.name,
      type: `${resource.mode === "data" ? "data." : ""}${resource.type}`,
      count: Array.isArray(resource.instances) ? resource.instances.length : 0,
      module: typeof resource.module === "string" ? resource.module : "root",
      provider: typeof resource.provider === "string" ? resource.provider : null,
    }));
  const modules: Record<string, Record<string, number>> = {};
  const providers: Record<string, Record<string, number>> = {};

  for (const resource of resources) {
    const kind = resource.type.replaceAll("_", "-");
    modules[resource.module] ||= {};
    modules[resource.module][kind] = (modules[resource.module][kind] || 0) + resource.count;
    if (resource.provider) {
      providers[resource.provider] ||= {};
      providers[resource.provider][kind] = (providers[resource.provider][kind] || 0) + resource.count;
    }
  }

  const outputResources = stateOutputResources(state);
  const payload = state.statePayload || "";
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
      "state-version": Number.isInteger(parsed?.version) ? parsed.version : null,
      status: state.status ?? "finalized",
      intermediate: false,
      size: Buffer.byteLength(payload),
      "vcs-commit-sha": state.vcsCommitSha,
      "vcs-commit-url": state.vcsCommitUrl,
      "hosted-state-download-url": apiURL(request, `/api/v2/state-versions/${state.id}/download`),
      "hosted-state-upload-url": null,
      "hosted-json-state-download-url": state.jsonState ? apiURL(request, `/api/v2/state-versions/${state.id}/json-download`) : null,
      "hosted-json-state-upload-url": null,
    },
    relationships: {
      workspace: { data: { id: state.workspaceId, type: "workspaces" } },
      run: state.runId ? { data: { id: state.runId, type: "runs" } } : { data: null },
      outputs: {
        data: outputResources.map(output => ({ id: output.id, type: output.type })),
      },
    },
    links: { self: `/api/v2/state-versions/${state.id}` },
  };
}
