import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { rateLimit } from "elysia-rate-limit";
import { db } from "./db";
import { users, apiTokens, organizations, workspaces, organizationMemberships, runs, logs, stateVersions, workspaceVariables, workspaceTags, configurationVersions, variableSets, variableSetWorkspaces, variableSetProjects, variableSetVariables, teams, teamMemberships, teamWorkspaces, projects, projectTags, remoteStateConsumers, dataRetentionPolicies, sshKeys, notificationConfigurations, oauthClients, oauthTokens, policySets, policySetWorkspaces, policySetProjects, policySetExclusions, policySetParameters, oauthClientProjects, agentPools, agentPoolTokens, runTasks, workspaceRunTasks, runTaskResults, auditLogs, policies, policyChecks, registryModules, registryModuleVersions, registryProviders, registryProviderVersions, registryProviderPlatforms, runTriggers, runComments } from "./db/schema";
import { and, eq, desc, asc, count, gte, inArray, like, lt, notInArray, or, sql } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import { authPlugin } from "./auth";
import { oauthPlugin } from "./oauth";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { validateVersion } from "./binaryManager";
import { startWorkerQueue, executeRun, executeApply } from "./worker";
import { normalizeWorkingDirectory } from "./workspace";

// Initialize log level
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
type LogLevel = typeof LOG_LEVELS[number];
function isLogLevelEnabled(level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(LOG_LEVEL as LogLevel);
}
const log = {
  error: (...args: any[]) => isLogLevelEnabled("error") && console.error(...args),
  warn: (...args: any[]) => isLogLevelEnabled("warn") && console.warn(...args),
  info: (...args: any[]) => isLogLevelEnabled("info") && console.log(...args),
  debug: (...args: any[]) => isLogLevelEnabled("debug") && console.log("[DEBUG]", ...args),
};

// Initialize persistent worker queue loop
startWorkerQueue();

const CV_STORAGE_DIR = join(process.env.STORAGE_DIR || join(import.meta.dir, "../storage"), "cv");
const FRONTEND_INDEX = join(import.meta.dir, "../../frontend/dist/index.html");
const PUBLIC_URL = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL) : null;
const serveFrontend = () => Bun.file(FRONTEND_INDEX);

async function checkOrgPermission(
  userId: string | undefined,
  orgId: string,
  requiredRole: "owner" | "member" = "member",
  tokenOrgId: string | null = null,
): Promise<boolean> {
  if (tokenOrgId) return tokenOrgId === orgId && requiredRole === "member";
  if (!userId) return false;
  const membership = await db.query.organizationMemberships.findFirst({
    where: (m, { and, eq }) => and(eq(m.userId, userId), eq(m.orgId, orgId)),
  });
  if (!membership) return false;
  if (requiredRole === "owner" && membership.role !== "owner") return false;
  return true;
}

async function findWorkspaceVar(workspaceId: string, varId: string) {
  return db.query.workspaceVariables.findFirst({
    where: (vars, { and, eq }) => and(eq(vars.id, varId), eq(vars.workspaceId, workspaceId)),
  });
}

function validVariableAttributes(attributes: any, partial = false) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return false;
  const allowedFields = ["key", "value", "category", "sensitive", "hcl", "description"];
  const fields = Object.keys(attributes);
  const { key, value, category, sensitive, hcl, description } = attributes;
  return fields.every(field => allowedFields.includes(field))
    && (!partial || fields.length > 0)
    && (partial || value !== undefined)
    && (partial && key === undefined || typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key))
    && (value === undefined || typeof value === "string")
    && (category === undefined || category === "terraform" || category === "env")
    && (sensitive === undefined || typeof sensitive === "boolean")
    && (hcl === undefined || typeof hcl === "boolean")
    && (description === undefined || description === null || typeof description === "string");
}

function validVariableSetVariableAttributes(attributes: any, partial = false) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return false;
  const { key, value, category, sensitive, hcl, description } = attributes;
  const allowedFields = ["key", "value", "category", "sensitive", "hcl", "description"];
  const fields = Object.keys(attributes);
  return fields.every(field => allowedFields.includes(field))
    && (!partial || fields.length > 0)
    && (partial && key === undefined || typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key))
    && (value === undefined || typeof value === "string")
    && (category === undefined || category === "terraform" || category === "env")
    && (sensitive === undefined || typeof sensitive === "boolean")
    && (hcl === undefined || hcl === false)
    && (description === undefined || description === null || typeof description === "string");
}

function validVariableSetAttributes(attributes: any, partial = false) {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return false;
  const { name, description, global, priority } = attributes;
  const fields = Object.keys(attributes);
  return fields.length > 0
    && fields.every(field => ["name", "description", "global", "priority"].includes(field))
    && (partial && name === undefined || typeof name === "string" && Boolean(name.trim()))
    && (description === undefined || description === null || typeof description === "string")
    && (global === undefined || typeof global === "boolean")
    && (priority === undefined || typeof priority === "boolean");
}

function workspaceVariableResource(v: typeof workspaceVariables.$inferSelect) {
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

async function findAuthorizedVariableSet(
  variableSetId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
) {
  const variableSet = await db.query.variableSets.findFirst({ where: eq(variableSets.id, variableSetId) });
  return variableSet && await checkOrgPermission(userId, variableSet.orgId, "member", tokenOrgId)
    ? variableSet
    : undefined;
}

function variableSetVariableResource(variable: typeof variableSetVariables.$inferSelect) {
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

function variableSetVariableUpdate(
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

async function variableSetResource(variableSet: typeof variableSets.$inferSelect) {
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

function workspaceRelationshipIds(body: unknown) {
  const data = (body as any)?.data;
  if (!Array.isArray(data) || data.length === 0) return;
  if (data.some(item => item?.type !== "workspaces" || typeof item?.id !== "string" || !item.id)) return;
  return [...new Set(data.map(item => item.id as string))];
}

function projectRelationshipIds(body: unknown) {
  const data = (body as any)?.data;
  if (!Array.isArray(data) || data.length === 0) return;
  if (data.some(item => item?.type !== "projects" || typeof item?.id !== "string" || !item.id)) return;
  return [...new Set(data.map(item => item.id as string))];
}

function variableRelationshipResources(body: unknown) {
  const data = (body as any)?.data;
  const many = Array.isArray(data);
  const resources = many ? data : [data];
  if (
    resources.length === 0
    || resources.some(item => item?.type !== "vars" || typeof item?.id !== "string" || !item.id)
    || new Set(resources.map(item => item.id)).size !== resources.length
  ) return;
  return { many, resources };
}

function isUniqueConstraintError(error: any) {
  return [error, error?.cause].some(item =>
    item?.code === "SQLITE_CONSTRAINT_UNIQUE"
    || item?.message?.includes("UNIQUE constraint failed")
  );
}

async function findWorkspaceByName(orgId: string, name: string) {
  return db.query.workspaces.findFirst({
    where: and(eq(workspaces.orgId, orgId), eq(workspaces.name, name)),
  });
}

async function findAuthorizedWorkspace(
  workspaceId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
) {
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  return workspace && await checkOrgPermission(userId, workspace.orgId, "member", tokenOrgId)
    ? workspace
    : undefined;
}

async function findAuthorizedRun(runId: string, userId: string | undefined, tokenOrgId: string | null) {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run) return;
  const workspace = await findAuthorizedWorkspace(run.workspaceId, userId, tokenOrgId);
  return workspace ? { run, workspace } : undefined;
}

async function findLogCapability(runId: string, token: string) {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run || !run.logToken) return;
  const expected = Buffer.from(run.logToken);
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? run : undefined;
}

async function workspaceResource(
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

function projectResource(project: typeof projects.$inferSelect) {
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

function tagBindingResource(tag: typeof workspaceTags.$inferSelect, effective = false) {
  return {
    id: tag.id,
    type: effective ? "effective-tag-bindings" : "tag-bindings",
    attributes: { key: tag.key, value: tag.value || "" },
  };
}

function projectTagBindingResource(pt: { id: string; projectId: string; key: string; value?: string | null }) {
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

function parseTagBindings(data: unknown) {
  if (!Array.isArray(data)) return;
  const bindings = new Map<string, { key: string; value: string }>();
  for (const item of data) {
    const { key, value = "" } = item?.attributes || {};
    if (item?.type !== "tag-bindings" || typeof key !== "string" || !key.trim() || typeof value !== "string") {
      return;
    }
    bindings.set(key.trim(), { key: key.trim(), value });
  }
  return [...bindings.values()];
}

async function deleteWorkspaceData(workspaceId: string) {
  await db.transaction(async (tx) => {
    const wsRuns = await tx.query.runs.findMany({ where: eq(runs.workspaceId, workspaceId) });
    const runIds = wsRuns.map(run => run.id);
    if (runIds.length > 0) {
      await tx.delete(logs).where(inArray(logs.runId, runIds));
      await tx.delete(runs).where(eq(runs.workspaceId, workspaceId));
    }
    await tx.delete(configurationVersions).where(eq(configurationVersions.workspaceId, workspaceId));
    await tx.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
    await tx.delete(workspaceVariables).where(eq(workspaceVariables.workspaceId, workspaceId));
    await tx.delete(workspaceTags).where(eq(workspaceTags.workspaceId, workspaceId));
    await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });
}

async function safeDeleteWorkspace(workspaceId: string) {
  const state = await db.query.stateVersions.findFirst({
    where: eq(stateVersions.workspaceId, workspaceId),
    orderBy: [desc(stateVersions.serial)],
  });

  if (state?.statePayload) {
    try {
      const resources = JSON.parse(decodeStatePayload(state.statePayload))?.resources;
      if (Array.isArray(resources) && resources.some(resource => resource?.mode === "managed")) return false;
    } catch {
      return false;
    }
  }

  await deleteWorkspaceData(workspaceId);
  return true;
}

async function updateWorkspaceResponse(
  workspace: typeof workspaces.$inferSelect,
  defaultIacBinary: string | null | undefined,
  canRun: boolean,
  body: unknown,
  set: any,
) {
  const attributes = (body as any)?.data?.attributes || {};
  const rawTagBindings = (body as any)?.data?.relationships?.["tag-bindings"]?.data;
  const tagBindings = rawTagBindings === undefined ? undefined : parseTagBindings(rawTagBindings);
  const {
    name,
    description,
    "auto-apply": autoApply,
    "terraform-version": terraformVersion,
    "working-directory": workingDirectory,
    "source-name": sourceName,
    "source-url": sourceUrl,
    "iac-binary": iacBinary,
    "execution-mode": executionMode,
  } = attributes;

  if (rawTagBindings !== undefined && tagBindings === undefined) {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid tag bindings" }] };
  }
  if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name))) {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace name" }] };
  }
  if (description !== undefined && description !== null && typeof description !== "string") {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "description must be a string or null" }] };
  }
  if (
    (sourceName !== undefined && sourceName !== null && typeof sourceName !== "string")
    || (sourceUrl !== undefined && sourceUrl !== null && typeof sourceUrl !== "string")
  ) {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "source-name and source-url must be strings or null" }] };
  }
  if (terraformVersion !== undefined && (typeof terraformVersion !== "string" || !validateVersion(terraformVersion))) {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid terraformVersion format" }] };
  }
  if (executionMode !== undefined && executionMode !== "remote") {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Only remote execution mode is supported" }] };
  }
  if (iacBinary !== undefined && iacBinary !== null && !["tofu", "terraform"].includes(iacBinary)) {
    set.status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "iac-binary must be tofu or terraform" }] };
  }

  let normalizedWorkingDirectory = workspace.workingDirectory;
  if (workingDirectory !== undefined) {
    try {
      normalizedWorkingDirectory = normalizeWorkingDirectory(workingDirectory);
    } catch (error: any) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: error.message }] };
    }
  }

  if (name !== undefined && name !== workspace.name) {
    const duplicate = await findWorkspaceByName(workspace.orgId, name);
    if (duplicate && duplicate.id !== workspace.id) {
      set.status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Workspace name already exists in this organization" }] };
    }
  }

  const projectRel = (body as any)?.data?.relationships?.project?.data;
  let newProjectId = workspace.projectId;
  if (projectRel !== undefined) {
    newProjectId = projectRel ? projectRel.id : null;
  }

  const updated: Partial<typeof workspaces.$inferInsert> = {
    name: name ?? workspace.name,
    description: description !== undefined ? description : workspace.description,
    projectId: newProjectId,
    autoApply: autoApply !== undefined ? Boolean(autoApply) : workspace.autoApply,
    autoApplyRunTrigger: attributes["auto-apply-run-trigger"] !== undefined ? Boolean(attributes["auto-apply-run-trigger"]) : workspace.autoApplyRunTrigger,
    fileTriggersEnabled: attributes["file-triggers-enabled"] !== undefined ? Boolean(attributes["file-triggers-enabled"]) : workspace.fileTriggersEnabled,
    triggerPrefixes: attributes["trigger-prefixes"] !== undefined ? attributes["trigger-prefixes"] : workspace.triggerPrefixes,
    triggerPatterns: attributes["trigger-patterns"] !== undefined ? attributes["trigger-patterns"] : workspace.triggerPatterns,
    vcsRepo: attributes["vcs-repo"] !== undefined ? attributes["vcs-repo"] : workspace.vcsRepo,
    queueAllRuns: attributes["queue-all-runs"] !== undefined ? Boolean(attributes["queue-all-runs"]) : workspace.queueAllRuns,
    speculativeEnabled: attributes["speculative-enabled"] !== undefined ? Boolean(attributes["speculative-enabled"]) : workspace.speculativeEnabled,
    allowDestroyPlan: attributes["allow-destroy-plan"] !== undefined ? Boolean(attributes["allow-destroy-plan"]) : workspace.allowDestroyPlan,
    globalRemoteState: attributes["global-remote-state"] !== undefined ? Boolean(attributes["global-remote-state"]) : workspace.globalRemoteState,
    projectRemoteState: attributes["project-remote-state"] !== undefined ? Boolean(attributes["project-remote-state"]) : workspace.projectRemoteState,
    agentPoolId: attributes["agent-pool-id"] !== undefined ? attributes["agent-pool-id"] : workspace.agentPoolId,
    assessmentsEnabled: attributes["assessments-enabled"] !== undefined ? Boolean(attributes["assessments-enabled"]) : workspace.assessmentsEnabled,
    autoDestroyAt: attributes["auto-destroy-at"] !== undefined ? attributes["auto-destroy-at"] : workspace.autoDestroyAt,
    autoDestroyActivityDuration: attributes["auto-destroy-activity-duration"] !== undefined ? attributes["auto-destroy-activity-duration"] : workspace.autoDestroyActivityDuration,
    settingOverwrites: attributes["setting-overwrites"] !== undefined ? attributes["setting-overwrites"] : workspace.settingOverwrites,
    terraformVersion: terraformVersion ?? workspace.terraformVersion,
    workingDirectory: normalizedWorkingDirectory,
    sourceName: sourceName !== undefined ? sourceName : workspace.sourceName,
    sourceUrl: sourceUrl !== undefined ? sourceUrl : workspace.sourceUrl,
    iacBinary: iacBinary !== undefined ? iacBinary : workspace.iacBinary,
  };

  await db.update(workspaces).set(updated).where(eq(workspaces.id, workspace.id));
  if (tagBindings) {
    await db.transaction(async tx => {
      await tx.delete(workspaceTags).where(eq(workspaceTags.workspaceId, workspace.id));
      if (tagBindings.length > 0) {
        await tx.insert(workspaceTags).values(tagBindings.map(binding => ({
          id: crypto.randomUUID(),
          workspaceId: workspace.id,
          ...binding,
        })));
      }
    });
  }
  return { data: await workspaceResource({ ...workspace, ...updated }, defaultIacBinary, canRun) };
}

function userResource(user: { id: string; username: string; email?: string | null }, authenticatedResource = { id: user.id, type: "users" }) {
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

function orgMembershipResource(
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

function tokenResource(token: typeof apiTokens.$inferSelect & { _rawToken?: string }, includeSecret = false) {
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

function tokenExpiry(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return Number.NaN;
  return Date.parse(value);
}

function organizationResource(org: typeof organizations.$inferSelect) {
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

function pageRequest(request: Request) {
  const params = new URL(request.url).searchParams;
  const number = Number.parseInt(params.get("page[number]") ?? "1", 10);
  const size = Number.parseInt(params.get("page[size]") ?? "20", 10);
  return {
    number: Number.isSafeInteger(number) && number > 0 ? number : 1,
    size: Number.isSafeInteger(size) && size > 0 ? Math.min(size, 100) : 20,
  };
}

function pagination(request: Request, currentPage: number, pageSize: number, totalCount: number) {
  const totalPages = Math.ceil(totalCount / pageSize);
  const pageLink = (page: number) => {
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

function apiURL(request: Request, path: string) {
  return new URL(path, PUBLIC_URL || request.url).toString();
}

function decodeStatePayload(state: unknown) {
  if (typeof state !== "string") return JSON.stringify(state);
  try {
    JSON.parse(state);
    return state;
  } catch {
    try {
      const decoded = Buffer.from(state, "base64").toString("utf8");
      JSON.parse(decoded);
      return decoded;
    } catch {
      return state;
    }
  }
}

function parseStatePayload(payload: string | null) {
  try {
    const state = JSON.parse(payload || "{}");
    return state && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}

function stateOutputResources(state: typeof stateVersions.$inferSelect) {
  const outputs = parseStatePayload(state.statePayload)?.outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return [];

  return Object.entries(outputs).map(([name, raw]) => {
    const id = `wsout-${createHash("sha256").update(`${state.id}\0${name}`).digest("hex").slice(0, 16)}`;
    const output = raw && typeof raw === "object" ? raw as any : { value: raw };
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

function stateVersionResource(
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
      status: "finalized",
      intermediate: false,
      size: Buffer.byteLength(payload),
      "vcs-commit-sha": null,
      "vcs-commit-url": null,
      "hosted-state-download-url": apiURL(request, `/api/v2/state-versions/${state.id}/download`),
      "hosted-state-upload-url": null,
      "hosted-json-state-upload-url": null,
    },
    relationships: {
      workspace: { data: { id: state.workspaceId, type: "workspaces" } },
      run: { data: null },
      outputs: {
        data: outputResources.map(output => ({ id: output.id, type: output.type })),
      },
    },
    links: { self: `/api/v2/state-versions/${state.id}` },
  };
}

const FINAL_RUN_STATUSES = [
  "applied",
  "planned_and_finished",
  "policy_soft_failed",
  "discarded",
  "errored",
  "canceled",
  "force_canceled",
];
const CAPACITY_PENDING_STATUSES = ["pending", "queuing", "plan_queued", "apply_queued"];
const CAPACITY_RUNNING_STATUSES = ["planning", "applying"];
const DISCARDABLE_RUN_STATUSES = [
  "planned",
  "planned_and_saved",
  "cost_estimated",
  "policy_checked",
  "policy_override",
  "post_plan_running",
  "post_plan_completed",
];

function workspaceRunHistoryWhere(request: Request, workspaceId: string) {
  const params = new URL(request.url).searchParams;
  const csv = (name: string) => params.get(name)?.split(",").map(value => value.trim()).filter(Boolean);
  const conditions = [eq(runs.workspaceId, workspaceId)];
  const statuses = csv("filter[status]");
  if (statuses?.length) conditions.push(inArray(runs.status, statuses));

  const operations = csv("filter[operation]");
  if (operations?.length) {
    const destroy = operations.includes("destroy");
    const planAndApply = operations.includes("plan_and_apply");
    if (destroy !== planAndApply) conditions.push(eq(runs.isDestroy, destroy));
    else if (!destroy) conditions.push(sql`false`);
  }

  const sources = csv("filter[source]");
  if (sources?.length && !sources.includes("tfe-api")) conditions.push(sql`false`);

  const statusGroup = params.get("filter[status_group]");
  if (statusGroup === "final") conditions.push(inArray(runs.status, FINAL_RUN_STATUSES));
  else if (statusGroup === "non_final") conditions.push(notInArray(runs.status, FINAL_RUN_STATUSES));
  else if (statusGroup === "discardable") conditions.push(inArray(runs.status, DISCARDABLE_RUN_STATUSES));
  else if (statusGroup) conditions.push(sql`false`);

  const timeframe = params.get("filter[timeframe]");
  if (timeframe === "year") {
    conditions.push(gte(runs.createdAt, Date.now() - 365 * 24 * 60 * 60 * 1000));
  } else if (timeframe && /^\d{4}$/.test(timeframe)) {
    const year = Number(timeframe);
    conditions.push(gte(runs.createdAt, Date.UTC(year, 0, 1)));
    conditions.push(lt(runs.createdAt, Date.UTC(year + 1, 0, 1)));
  } else if (timeframe) {
    conditions.push(sql`false`);
  }

  const basic = params.get("search[basic]")?.trim();
  if (basic) conditions.push(or(like(runs.id, `%${basic}%`), like(runs.message, `%${basic}%`))!);

  const userSearch = params.get("search[user]")?.trim();
  if (userSearch) {
    const userMatches = db.select({ id: users.id }).from(users)
      .where(like(users.username, `%${userSearch}%`));
    conditions.push(inArray(runs.createdBy, userMatches));
  }

  const agentPoolNames = csv("filter[agent_pool_names]");
  if (agentPoolNames?.length) {
    const matchingPools = db.select({ id: agentPools.id }).from(agentPools)
      .where(inArray(agentPools.name, agentPoolNames));
    const matchingWorkspaces = db.select({ id: workspaces.id }).from(workspaces)
      .where(inArray(workspaces.agentPoolId, matchingPools));
    conditions.push(inArray(runs.workspaceId, matchingWorkspaces));
  }

  const commitSearch = params.get("search[commit]")?.trim();
  if (commitSearch) {
    conditions.push(
      inArray(runs.id,
        db.select({ id: runs.id }).from(runs)
          .innerJoin(configurationVersions, eq(runs.configurationVersionId, configurationVersions.id))
          .where(like(
            sql<string>(`COALESCE(${configurationVersions.ingressAttributes}->>'$.commitSha', '')`),
            `%${commitSearch}%`
          ))
      )
    );
  }

  return and(...conditions)!;
}

function runResource(run: typeof runs.$inferSelect, canRun: boolean) {
  const isPlanned = run.status === "planned";
  const isRunning = ["pending", "planning", "applying"].includes(run.status);
  const hasChanges = ["planned", "planned_and_finished", "applying", "applied"].includes(run.status);

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
      source: "tfe-api",
      status: run.status,
      "target-addrs": run.targetAddrs,
      "terraform-version": run.terraformVersion,
      "debugging-mode": run.debuggingMode,
      "is-destroy": run.isDestroy,
      "created-at": new Date(run.createdAt).toISOString(),
      "trigger-reason": "manual",
      variables: run.variables || [],
      permissions: {
        "can-apply": canRun && isPlanned,
        "can-cancel": canRun && isRunning,
        "can-discard": canRun && isPlanned,
        "can-force-cancel": canRun && isRunning,
        "can-force-execute": false,
        "can-override-policy-check": false,
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
    },
  };
}

function planResource(run: typeof runs.$inferSelect, request: Request) {
  const status = run.status === "planning"
    ? "running"
    : ["planned", "planned_and_finished", "applying", "applied"].includes(run.status)
      ? "finished"
      : run.status === "errored"
        ? "errored"
        : ["canceled", "discarded", "force_canceled"].includes(run.status)
          ? "canceled"
          : "pending";

  return {
    id: `plan-${run.id}`,
    type: "plans",
    attributes: {
      status,
      "has-changes": ["planned", "planned_and_finished", "applying", "applied"].includes(run.status),
      "generated-configuration": false,
      "execution-details": { mode: "remote" },
      "log-read-url": run.logToken ? apiURL(request, `/api/v2/runs/${run.id}/plan/log/${run.logToken}`) : null,
    },
  };
}

function applyResource(run: typeof runs.$inferSelect, request: Request) {
  const status = run.status === "applying"
    ? "running"
    : run.status === "applied"
      ? "finished"
      : run.status === "errored"
        ? "errored"
        : ["canceled", "discarded", "force_canceled"].includes(run.status)
          ? "canceled"
          : "pending";

  return {
    id: `apply-${run.id}`,
    type: "applies",
    attributes: {
      status,
      "log-read-url": run.logToken ? apiURL(request, `/api/v2/runs/${run.id}/apply/log/${run.logToken}`) : null,
    },
  };
}

function logChunk(output: string, request: Request) {
  const params = new URL(request.url).searchParams;
  const parsedOffset = Number.parseInt(params.get("offset") || "0", 10);
  const parsedLimit = Number.parseInt(params.get("limit") || "", 10);
  const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
  const bytes = Buffer.from(output);
  const limit = Number.isInteger(parsedLimit) && parsedLimit >= 0 ? parsedLimit : bytes.length;
  return bytes.subarray(offset, offset + limit);
}

export const app = new Elysia()
  .use(authPlugin)
  .use(rateLimit({
    max: 30,
    duration: 1000,
    generator: async (request, server) => {
      const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (bearer) {
        return `token:${Bun.hash(bearer)}`;
      }
      return `ip:${server?.requestIP(request)?.address || "unknown"}`;
    },
  }))
  .use(oauthPlugin)
  .onRequest(({ request, set }) => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;
    const timestamp = Date.now();
    (set as any).__startTime = timestamp;
    (set as any).__method = method;
    (set as any).__path = pathname;

    const allowOrigin = process.env.CORS_ORIGIN || (process.env.NODE_ENV === "production" ? undefined : "*");
    if (allowOrigin) {
      set.headers["Access-Control-Allow-Origin"] = allowOrigin;
    }
    set.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
    set.headers["Access-Control-Allow-Headers"] = "Authorization,Content-Type";
    set.headers["Access-Control-Expose-Headers"] = "TFP-API-Version,X-RateLimit-Limit,X-RateLimit-Remaining";
  })
  .onAfterHandle(({ request, response, set }) => {
    const startTime = (set as any).__startTime as number | undefined;
    if (startTime) {
      const duration = Date.now() - startTime;
      const method = (set as any).__method || request.method;
      const path = (set as any).__path || new URL(request.url).pathname;
      const status = set.status || 200;
      if (path.startsWith("/api/")) {
        log.info(`[${new Date().toISOString()}] ${method} ${path} ${status} ${duration}ms`);
      }
    }
    const isJsonDocument = response !== null
      && typeof response === "object"
      && (Array.isArray(response) || Object.getPrototypeOf(response) === Object.prototype);
    if (new URL(request.url).pathname.startsWith("/api/") && isJsonDocument) {
      set.headers["Content-Type"] = "application/vnd.api+json";
    }
    const limit = set.headers["RateLimit-Limit"];
    const remaining = set.headers["RateLimit-Remaining"];
    if (limit) set.headers["X-RateLimit-Limit"] = limit;
    if (remaining) set.headers["X-RateLimit-Remaining"] = remaining;
  })
  .onParse(async ({ request, contentType }) => {
    if (contentType === 'application/vnd.api+json') {
      const text = await request.text();
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }
  })
  .use(staticPlugin({
    assets: "../frontend/dist",
    prefix: ""
  }))
  .get("/login", serveFrontend)
  .get("/register", serveFrontend)
  .get("/app", serveFrontend)
  .get("/app/*", serveFrontend)
  .options("/*", ({ set }) => {
    set.status = 204;
  })
  .onError(({ code, error, set }) => {
    set.headers["Content-Type"] = "application/vnd.api+json";
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    set.status = 500;
    return {
      errors: [{
        status: "500",
        title: "Internal Server Error",
        detail: error.message || "An unexpected error occurred"
      }]
    };
  })
  .get("/.well-known/terraform.json", () => ({
    "login.v1": {
      client: "terraform-cli",
      grant_types: ["authz_code"],
      authz: "/oauth/authorization",
      token: "/oauth/token",
      ports: [10000, 10010],
    },
    "tfe.v2": "/api/v2/",
    "tfe.v2.1": "/api/v2/",
    "tfe.v2.2": "/api/v2/",
    "state.v2": "/api/v2/",
    "modules.v1": "/api/registry/v1/modules/",
    "providers.v1": "/api/registry/v1/providers/",
  }))
  .get("/api", () => "Terrence API")
  .get("/api/v2/ping", ({ set }) => {
    set.headers["TFP-API-Version"] = "2.5";
    set.headers["TFP-AppName"] = "Terraform Enterprise";
    return {};
  })
  .get("/healthz", () => "ok")
  .get("/readyz", async ({ set }) => {
    try {
      await db.query.users.findFirst();
      return "ready";
    } catch {
      set.status = 503;
      return "not ready";
    }
  })
  .get("/api/v1/ping", () => "pong", { isAuth: true })
  .get("/api/v1/readiness", async ({ set }) => {
    try {
      await db.query.users.findFirst();
      return { status: "ready" };
    } catch {
      set.status = 503;
      return { status: "not_ready" };
    }
  })
  .get("/api/v1/health/readiness", async ({ set }) => {
    try {
      await db.query.users.findFirst();
      return { status: "ready" };
    } catch {
      set.status = 503;
      return { status: "not_ready" };
    }
  })
  .get("/api/v1/metadata", () => ({
    version: process.env.BUILD_VERSION || "dev",
    build: process.env.BUILD_SHA || "unknown",
  }), { isAuth: true })
  .post("/api/v2/users/login", async ({ body, set }) => {
    let payload;
    if (typeof body === 'string') {
        try {
            payload = JSON.parse(body);
        } catch (e) {
            set.status = 400;
            return { errors: [{ status: "400", title: "Bad Request", detail: "Invalid JSON string" }] };
        }
    } else {
        payload = body;
    }

    const { username, password } = payload?.data?.attributes || {};

    if (!username || !password) {
      set.status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Missing credentials" }] };
    }

    const user = await db.query.users.findFirst({
      where: eq(users.username, username)
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Invalid username or password" }] };
    }

    const tokenStr = `user-${crypto.randomUUID()}`;
    const tokenId = crypto.randomUUID();

    const tokenHash = createHash("sha256").update(tokenStr).digest("hex");
    await db.insert(apiTokens).values({
      id: tokenId,
      token: tokenHash,
      userId: user.id,
      description: "User login token",
      createdAt: Date.now(),
    });

    return {
      data: {
        id: tokenId,
        type: "tokens",
        attributes: {
          token: tokenStr
        }
      }
    };
  })
  .post("/api/v2/users", async ({ body, set }) => {
    const payload = body as any;
    const { username, password, email } = payload?.data?.attributes || {};

    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      set.status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Missing username or password" }] };
    }

    if (password.length < 10) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Password must be at least 10 characters" }] };
    }
    if (email !== undefined && email !== null && typeof email !== "string") {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Email must be a string" }] };
    }

    const existing = await db.query.users.findFirst({
      where: eq(users.username, username)
    });
    if (existing) {
      set.status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] };
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const id = crypto.randomUUID();
    const normalizedEmail = typeof email === "string" && email.trim() ? email.trim() : null;

    // First registered user becomes site admin
    const userCount = (await db.select({ val: count() }).from(users))[0]?.val ?? 0;
    const isSiteAdmin = userCount === 0;

    try {
      await db.insert(users).values({ id, username, email: normalizedEmail, passwordHash, isSiteAdmin });
      set.status = 201;
      return {
        data: {
          id,
          type: "users",
          attributes: { username, email: normalizedEmail, "is-site-admin": isSiteAdmin }
        }
      };
    } catch (e: any) {
      if (e.message?.includes("UNIQUE") || e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message?.includes("SQLITE_CONSTRAINT")) {
        set.status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "User already exists" }] };
      }
      throw e;
    }
  })
  .get("/api/v2/account/details", async ({ user, orgId, set }) => {
    if (user) return { data: userResource(user) };

    const org = orgId
      ? await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) })
      : null;
    if (!org) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const synthetic = { id: `service-user-${org.id}`, username: `${org.name}-service-user` };
    return { data: userResource(synthetic, { id: org.id, type: "organizations" }) };
  }, { isAuth: true })
  .patch("/api/v2/account/update", async ({ user, body, set }) => {
    if (!user) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const attributes = (body as any)?.data?.attributes;
    if (!attributes || typeof attributes !== "object") {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }

    const changes: { username?: string; email?: string | null } = {};
    if (Object.hasOwn(attributes, "username")) {
      if (typeof attributes.username !== "string" || !attributes.username.trim()) {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Username cannot be empty" }] };
      }
      changes.username = attributes.username.trim();
    }
    if (Object.hasOwn(attributes, "email")) {
      if (attributes.email !== null && (typeof attributes.email !== "string" || !attributes.email.trim())) {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Email must be a string or null" }] };
      }
      changes.email = attributes.email === null ? null : attributes.email.trim();
    }
    if (Object.keys(changes).length === 0) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "No account fields provided" }] };
    }

    try {
      await db.update(users).set(changes).where(eq(users.id, user.id));
    } catch (error: any) {
      if (isUniqueConstraintError(error)) {
        set.status = 409;
        return { errors: [{ status: "409", title: "Conflict", detail: "Username is already in use" }] };
      }
      throw error;
    }

    return { data: userResource({ ...user, ...changes }) };
  }, { isAuth: true })
  .patch("/api/v2/account/password", async ({ user, body, set }) => {
    if (!user) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const attributes = (body as any)?.data?.attributes || {};
    const currentPassword = attributes.current_password ?? attributes["current-password"];
    const password = attributes.password;
    const confirmation = attributes.password_confirmation ?? attributes["password-confirmation"];
    if (!currentPassword || !password || password !== confirmation || password.length < 10) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid password change request" }] };
    }
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized", detail: "Current password is incorrect" }] };
    }

    await db.update(users).set({ passwordHash: await bcrypt.hash(password, 10) }).where(eq(users.id, user.id));
    return { data: userResource(user) };
  }, { isAuth: true })

  // --- USERS API ---
  .get("/api/v2/users", async ({ query, user, set }) => {
    if (!user) { set.status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    const usernameFilter = (query as any)?.["filter[username]"] || (query as any)?.q;
    let allUsers;
    if (usernameFilter) {
      allUsers = await db.query.users.findMany({
        where: (u, { like }) => like(u.username, `%${usernameFilter}%`),
      });
    } else {
      allUsers = await db.query.users.findMany();
    }
    return { data: allUsers.map(u => userResource(u)) };
  }, { isAuth: true })
  .get("/api/v2/users/:user_id", async ({ params: { user_id }, user, set }) => {
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, user_id) });
    if (!targetUser || !user) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: userResource(targetUser) };
  }, { isAuth: true })
  .patch("/api/v2/users/:user_id", async ({ params: { user_id }, body, user, set }) => {
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, user_id) });
    if (!targetUser || !user || (user.id !== user_id)) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attrs = (body as any)?.data?.attributes || {};
    const updates: Partial<typeof users.$inferInsert> = {};
    if (typeof attrs.username === "string" && attrs.username.trim()) updates.username = attrs.username.trim();
    if (typeof attrs.email === "string") updates.email = attrs.email.trim();
    if (Object.keys(updates).length > 0) {
      await db.update(users).set(updates).where(eq(users.id, user_id));
    }
    const updated = (await db.query.users.findFirst({ where: eq(users.id, user_id) }))!;
    return { data: userResource(updated) };
  }, { isAuth: true })
  .delete("/api/v2/users/:user_id", async ({ params: { user_id }, user, set }) => {
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, user_id) });
    if (!targetUser || !user || user.id !== user_id) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(users).where(eq(users.id, user_id));
    set.status = 204;
    return;
  }, { isAuth: true })

  // --- ORGANIZATION MEMBERSHIPS API ---
  .post("/api/v2/organizations/:org_name/organization-memberships", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "owner", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attrs = (body as any)?.data?.attributes || {};
    const email = attrs.email;
    const username = attrs.username;
    let targetUser = null;
    if (email) targetUser = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (!targetUser && username) targetUser = await db.query.users.findFirst({ where: eq(users.username, username) });

    if (!targetUser && email) {
      const uid = `usr-${crypto.randomUUID()}`;
      const uname = email.split("@")[0] + "_" + crypto.randomUUID().substring(0, 4);
      await db.insert(users).values({ id: uid, username: uname, email, passwordHash: "invited" });
      targetUser = (await db.query.users.findFirst({ where: eq(users.id, uid) }))!;
    }

    if (!targetUser) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "User email or username required" }] };
    }

    const existingMem = await db.query.organizationMemberships.findFirst({
      where: and(eq(organizationMemberships.orgId, org.id), eq(organizationMemberships.userId, targetUser.id)),
    });

    if (existingMem) {
      set.status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "User is already a member of this organization" }] };
    }

    const memId = `orgmem-${crypto.randomUUID()}`;
    const status = attrs.status || "active";
    await db.insert(organizationMemberships).values({
      id: memId,
      orgId: org.id,
      userId: targetUser.id,
      role: "member",
      status,
    });

    const teamRelData = (body as any)?.data?.relationships?.teams?.data;
    const teamIds: string[] = [];
    if (Array.isArray(teamRelData)) {
      for (const t of teamRelData) {
        if (t?.id) {
          teamIds.push(t.id);
          await db.insert(teamMemberships).values({
            id: `tmem-${crypto.randomUUID()}`,
            teamId: t.id,
            userId: targetUser.id,
            createdAt: Date.now(),
          }).catch(() => {});
        }
      }
    }

    const mem = (await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, memId) }))!;
    set.status = 201;
    return { data: orgMembershipResource(mem, targetUser, teamIds) };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/organization-memberships", async ({ params: { org_name }, query, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const mems = await db.query.organizationMemberships.findMany({ where: eq(organizationMemberships.orgId, org.id) });
    const userIds = mems.map(m => m.userId);
    const userList = userIds.length > 0 ? await db.query.users.findMany({ where: inArray(users.id, userIds) }) : [];
    const userMap = new Map(userList.map(u => [u.id, u]));

    const includeUsers = (query as any)?.include?.split(",").includes("user");

    const data = mems.map(m => orgMembershipResource(m, userMap.get(m.userId) || null));
    const result: any = { data };

    if (includeUsers && userList.length > 0) {
      result.included = userList.map(u => userResource(u));
    }

    return result;
  }, { isAuth: true })
  .get("/api/v2/organization-memberships/:id", async ({ params: { id }, query, user, orgId: tokenOrgId, set }) => {
    const mem = await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, id) });
    if (!mem || !(await checkOrgPermission(user?.id, mem.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, mem.userId) });
    const includeUsers = (query as any)?.include?.split(",").includes("user");

    const result: any = { data: orgMembershipResource(mem, targetUser) };
    if (includeUsers && targetUser) {
      result.included = [userResource(targetUser)];
    }
    return result;
  }, { isAuth: true })
  .delete("/api/v2/organization-memberships/:id", async ({ params: { id }, user, orgId: tokenOrgId, set }) => {
    const mem = await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, id) });
    if (!mem || !(await checkOrgPermission(user?.id, mem.orgId, "owner", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, id));
    set.status = 204;
    return;
  }, { isAuth: true })
  .get("/api/v2/users/:user_id/authentication-tokens", async ({ params: { user_id }, user, request, set }) => {
    const target = await db.query.users.findFirst({ where: eq(users.id, user_id) });
    if (!target || !user || user.id !== user_id) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);

    const where = eq(apiTokens.userId, user_id);
    const [tokens, [{ total }]] = await Promise.all([
      db.query.apiTokens.findMany({
        where,
        orderBy: [desc(apiTokens.createdAt)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(apiTokens).where(where),
    ]);
    return {
      data: tokens.map(token => tokenResource(token)),
      ...pagination(request, number, size, total),
    };
  }, { isAuth: true })
  .get("/api/v2/authentication-tokens/:token_id", async ({ params: { token_id }, user, set }) => {
    const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, token_id) });
    if (!token || !user || token.userId !== user.id) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: tokenResource(token) };
  }, { isAuth: true })
  .delete("/api/v2/authentication-tokens/:token_id", async ({ params: { token_id }, user, set }) => {
    const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, token_id) });
    if (!token || !user || token.userId !== user.id) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(apiTokens).where(eq(apiTokens.id, token_id));
    set.status = 204;
  }, { isAuth: true })
  .post("/api/v2/tokens", async ({ body, user, set }) => {
    if (!user) {
      set.status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }

    const payload = body as any;
    const attributes = payload?.data?.attributes || {};
    const description = attributes.description ?? "API token";
    const orgId = payload?.data?.relationships?.organization?.data?.id;
    const expiresAt = tokenExpiry(attributes["expired-at"]);

    if (typeof description !== "string" || (orgId !== undefined && typeof orgId !== "string") || Number.isNaN(expiresAt)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }

    if (orgId) {
      if (!(await checkOrgPermission(user.id, orgId, "owner"))) {
        set.status = 403;
        return { errors: [{ status: "403", title: "Forbidden" }] };
      }
    }

    const rawToken = `${orgId ? "org" : "user"}-${crypto.randomUUID()}`;
    const createdToken: typeof apiTokens.$inferSelect = {
      id: crypto.randomUUID(),
      token: createHash("sha256").update(rawToken).digest("hex"),
      userId: orgId ? null : user.id,
      orgId: orgId || null,
      description,
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt,
    };

    if (orgId) {
      await db.transaction(async tx => {
        await tx.delete(apiTokens).where(eq(apiTokens.orgId, orgId));
        await tx.insert(apiTokens).values(createdToken);
      });
    } else {
      await db.insert(apiTokens).values(createdToken);
    }

    set.status = 201;
    return { data: tokenResource({ ...createdToken, _rawToken: rawToken }, true) };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/authentication-token", async ({ params: { org_name }, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || (orgId !== org.id && !(await checkOrgPermission(user?.id, org.id, "owner")))) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.orgId, org.id) });
    if (!token) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: tokenResource(token) };
  }, { isAuth: true })
  .post("/api/v2/organizations/:org_name/authentication-token", async ({ params: { org_name }, body, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || (orgId !== org.id && !(await checkOrgPermission(user?.id, org.id, "owner")))) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const attributes = (body as any)?.data?.attributes || {};
    const expiresAt = tokenExpiry(attributes["expired-at"]);
    if (Number.isNaN(expiresAt)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }

    const rawToken = `org-${crypto.randomUUID()}`;
    const createdToken = {
      id: crypto.randomUUID(),
      token: createHash("sha256").update(rawToken).digest("hex"),
      userId: null,
      orgId: org.id,
      description: null,
      createdAt: Date.now(),
      lastUsedAt: null,
      expiresAt,
      _rawToken: rawToken,
    };
    await db.transaction(async tx => {
      await tx.delete(apiTokens).where(eq(apiTokens.orgId, org.id));
      await tx.insert(apiTokens).values(createdToken);
    });

    set.status = 201;
    return { data: tokenResource(createdToken, true) };
  }, { isAuth: true })
  .delete("/api/v2/organizations/:org_name/authentication-token", async ({ params: { org_name }, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || (orgId !== org.id && !(await checkOrgPermission(user?.id, org.id, "owner")))) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    await db.delete(apiTokens).where(eq(apiTokens.orgId, org.id));
    set.status = 204;
  }, { isAuth: true })
  .post("/api/v2/organizations", async ({ user, body, set }) => {
    const payload = body as any;
    const attributes = payload?.data?.attributes || {};
    const name = typeof attributes.name === "string" ? attributes.name.trim() : "";
    const defaultIacBinary = attributes["default-iac-binary"] ?? "tofu";
    const defaultTerraformVersion = attributes["default-terraform-version"] ?? "latest";

    if (!name) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Missing name" }] };
    }
    if (!user) {
      set.status = 403;
      return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    if (!["tofu", "terraform"].includes(defaultIacBinary) || typeof defaultTerraformVersion !== "string" || !defaultTerraformVersion.trim()) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }

    try {
        const id = crypto.randomUUID();
        const org = {
          id,
          name,
          defaultIacBinary,
          defaultTerraformVersion: defaultTerraformVersion.trim(),
        };
        await db.transaction(async tx => {
          await tx.insert(organizations).values(org);
          await tx.insert(organizationMemberships).values({
            id: crypto.randomUUID(),
            userId: user.id,
            orgId: id,
            role: "owner",
          });
        });

        set.status = 201;
        return { data: organizationResource(org) };
    } catch (e: any) {
        if (e.message?.includes("UNIQUE") || e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message?.includes("SQLITE_CONSTRAINT")) {
            set.status = 409; return { errors: [{ status: "409", title: "Conflict" }] };
        }
        throw e;
    }
  }, { isAuth: true })
  .get("/api/v2/organizations", async ({ user, orgId, request }) => {
    const { number, size } = pageRequest(request);
    const params = new URL(request.url).searchParams;
    const search = (params.get("q[name]") ?? params.get("q") ?? "").trim();
    const organizationIds = orgId
      ? [orgId]
      : user
        ? [...new Set((await db.query.organizationMemberships.findMany({
            where: eq(organizationMemberships.userId, user.id),
          })).map(membership => membership.orgId))]
        : [];

    if (organizationIds.length === 0) {
      return { data: [], ...pagination(request, number, size, 0) };
    }

    const scope = inArray(organizations.id, organizationIds);
    const where = search ? and(scope, like(organizations.name, `%${search}%`)) : scope;
    const [orgs, [{ total }]] = await Promise.all([
      db.query.organizations.findMany({
        where,
        orderBy: [asc(organizations.name)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(organizations).where(where),
    ]);
    return {
      data: orgs.map(organizationResource),
      ...pagination(request, number, size, total),
    };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name", async ({ params: { org_name }, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({
        where: eq(organizations.name, org_name)
    });

    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
        set.status = 404;
        return { errors: [{ status: "404", title: "Not Found" }] };
    }

    return { data: organizationResource(org) };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/entitlement-set", async ({ params: { org_name }, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    return {
      data: {
        id: org.id,
        type: "entitlement-sets",
        attributes: {
          operations: true,
          "state-storage": true,
          teams: true,
          "vcs-integrations": false,
          "policy-enforcement": false,
          "cost-estimation": false,
          "private-module-registry": false,
          agents: false,
          sso: false,
          "run-tasks": false,
          "audit-logging": false,
          "self-serve-billing": false,
          "user-limit": null,
        },
        links: { self: `/api/v2/entitlement-sets/${org.id}` },
      },
    };
  }, { isAuth: true })
  .patch("/api/v2/organizations/:org_name", async ({ params: { org_name }, body, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({
        where: eq(organizations.name, org_name)
    });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "owner", orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const payload = body as any;
    const attributes = payload?.data?.attributes || {};
    const newName = attributes.name === undefined ? org.name : typeof attributes.name === "string" ? attributes.name.trim() : "";
    const defaultIacBinary = attributes["default-iac-binary"] ?? org.defaultIacBinary ?? "tofu";
    const defaultTerraformVersion = attributes["default-terraform-version"] ?? org.defaultTerraformVersion ?? "latest";
    if (!newName || !["tofu", "terraform"].includes(defaultIacBinary) || typeof defaultTerraformVersion !== "string" || !defaultTerraformVersion.trim()) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }

    try {
      const updated = {
        ...org,
        name: newName,
        defaultIacBinary,
        defaultTerraformVersion: defaultTerraformVersion.trim(),
      };
      await db.update(organizations).set({
        name: updated.name,
        defaultIacBinary: updated.defaultIacBinary,
        defaultTerraformVersion: updated.defaultTerraformVersion,
      }).where(eq(organizations.id, org.id));
      return { data: organizationResource(updated) };
    } catch (e: any) {
      if (e.message?.includes("UNIQUE") || e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message?.includes("SQLITE_CONSTRAINT")) {
        set.status = 409; return { errors: [{ status: "409", title: "Conflict" }] };
      }
      throw e;
    }
  }, { isAuth: true })
  .delete("/api/v2/organizations/:org_name", async ({ params: { org_name }, user, orgId, set }) => {
    const org = await db.query.organizations.findFirst({
        where: eq(organizations.name, org_name)
    });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "owner", orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    await db.transaction(async (tx) => {
      const orgWsList = await tx.query.workspaces.findMany({ where: eq(workspaces.orgId, org.id) });
      const wsIds = orgWsList.map(w => w.id);

      if (wsIds.length > 0) {
        const orgRuns = await tx.query.runs.findMany({ where: inArray(runs.workspaceId, wsIds) });
        const runIds = orgRuns.map(r => r.id);

        if (runIds.length > 0) {
          await tx.delete(logs).where(inArray(logs.runId, runIds));
          await tx.delete(runs).where(inArray(runs.workspaceId, wsIds));
        }

        await tx.delete(configurationVersions).where(inArray(configurationVersions.workspaceId, wsIds));
        await tx.delete(stateVersions).where(inArray(stateVersions.workspaceId, wsIds));
        await tx.delete(workspaceVariables).where(inArray(workspaceVariables.workspaceId, wsIds));
        await tx.delete(workspaceTags).where(inArray(workspaceTags.workspaceId, wsIds));
        await tx.delete(workspaces).where(eq(workspaces.orgId, org.id));
      }

      await tx.delete(organizationMemberships).where(eq(organizationMemberships.orgId, org.id));
      await tx.delete(apiTokens).where(eq(apiTokens.orgId, org.id));
      await tx.delete(organizations).where(eq(organizations.id, org.id));
    });

    set.status = 204;
    return;
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/varsets", async ({ params: { org_name }, user, orgId, request, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { number, size } = pageRequest(request);
    const search = new URL(request.url).searchParams.get("q")?.trim();
    const scope = eq(variableSets.orgId, org.id);
    const where = search ? and(scope, like(variableSets.name, `%${search}%`)) : scope;
    const [records, [{ total }]] = await Promise.all([
      db.query.variableSets.findMany({
        where,
        orderBy: [asc(variableSets.name)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(variableSets).where(where),
    ]);
    return {
      data: await Promise.all(records.map(variableSetResource)),
      ...pagination(request, number, size, total),
    };
  }, { isAuth: true })
  .post("/api/v2/organizations/:org_name/varsets", async ({ params: { org_name }, user, orgId, body, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", orgId))) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const data = (body as any)?.data;
    const attributes = data?.attributes;
    if (data?.type !== "varsets" || !validVariableSetAttributes(attributes)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable set attributes" }] };
    }

    const record = {
      id: `varset-${crypto.randomUUID()}`,
      orgId: org.id,
      name: attributes.name.trim(),
      description: attributes.description ?? null,
      global: attributes.global ?? false,
      priority: attributes.priority ?? false,
    };
    await db.insert(variableSets).values(record);
    set.status = 201;
    return { data: await variableSetResource(record) };
  }, { isAuth: true })
  .get("/api/v2/varsets/:varset_id", async ({ params: { varset_id }, user, orgId, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: await variableSetResource(record) };
  }, { isAuth: true })
  .patch("/api/v2/varsets/:varset_id", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const data = (body as any)?.data;
    const attributes = data?.attributes;
    if (data?.type !== "varsets" || !validVariableSetAttributes(attributes, true)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable set attributes" }] };
    }

    const updated = {
      name: attributes.name === undefined ? record.name : attributes.name.trim(),
      description: attributes.description === undefined ? record.description : attributes.description,
      global: attributes.global === undefined ? record.global : attributes.global,
      priority: attributes.priority === undefined ? record.priority : attributes.priority,
    };
    await db.update(variableSets).set(updated).where(eq(variableSets.id, record.id));
    return { data: await variableSetResource({ ...record, ...updated }) };
  }, { isAuth: true })
  .delete("/api/v2/varsets/:varset_id", async ({ params: { varset_id }, user, orgId, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(variableSets).where(eq(variableSets.id, record.id));
    set.status = 204;
  }, { isAuth: true })
  .post("/api/v2/varsets/:varset_id/relationships/workspaces", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const workspaceIds = workspaceRelationshipIds(body);
    if (!workspaceIds) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace relationships" }] };
    }
    const targets = await db.query.workspaces.findMany({ where: inArray(workspaces.id, workspaceIds) });
    if (targets.length !== workspaceIds.length || targets.some(workspace => workspace.orgId !== record.orgId)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Workspaces must belong to the variable set organization" }] };
    }

    await db.insert(variableSetWorkspaces).values(workspaceIds.map(workspaceId => ({
      id: crypto.randomUUID(),
      variableSetId: record.id,
      workspaceId,
    }))).onConflictDoNothing();
    set.status = 204;
  }, { isAuth: true })
  .delete("/api/v2/varsets/:varset_id/relationships/workspaces", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const workspaceIds = workspaceRelationshipIds(body);
    if (!workspaceIds) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace relationships" }] };
    }
    const targets = await db.query.workspaces.findMany({ where: inArray(workspaces.id, workspaceIds) });
    if (targets.length !== workspaceIds.length || targets.some(workspace => workspace.orgId !== record.orgId)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Workspaces must belong to the variable set organization" }] };
    }

    await db.delete(variableSetWorkspaces).where(and(
      eq(variableSetWorkspaces.variableSetId, record.id),
      inArray(variableSetWorkspaces.workspaceId, workspaceIds),
    ));
    set.status = 204;
  }, { isAuth: true })
  .post("/api/v2/varsets/:varset_id/relationships/projects", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const projectIds = projectRelationshipIds(body);
    if (!projectIds) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid project relationships" }] };
    }
    const targets = await db.query.projects.findMany({ where: inArray(projects.id, projectIds) });
    if (targets.length !== projectIds.length || targets.some(p => p.orgId !== record.orgId)) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Projects must belong to the variable set organization" }] };
    }
    for (const pid of projectIds) {
      await db.insert(variableSetProjects).values({
        id: `vsp-${crypto.randomUUID()}`,
        variableSetId: record.id,
        projectId: pid,
      }).onConflictDoNothing();
    }
    set.status = 204;
  }, { isAuth: true })
  .delete("/api/v2/varsets/:varset_id/relationships/projects", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const projectIds = projectRelationshipIds(body);
    if (!projectIds) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid project relationships" }] };
    }
    await db.delete(variableSetProjects).where(and(
      eq(variableSetProjects.variableSetId, record.id),
      inArray(variableSetProjects.projectId, projectIds),
    ));
    set.status = 204;
  }, { isAuth: true })
  .get("/api/v2/varsets/:varset_id/relationships/vars", async ({ params: { varset_id }, user, orgId, request, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const where = eq(variableSetVariables.variableSetId, record.id);
    const [variables, [{ total }]] = await Promise.all([
      db.query.variableSetVariables.findMany({
        where,
        orderBy: [asc(variableSetVariables.key)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(variableSetVariables).where(where),
    ]);
    return {
      data: variables.map(variableSetVariableResource),
      ...pagination(request, number, size, total),
    };
  }, { isAuth: true })
  .get("/api/v2/varsets/:varset_id/relationships/vars/:var_id", async ({ params: { varset_id, var_id }, user, orgId, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    const variable = record
      ? await db.query.variableSetVariables.findFirst({
          where: and(eq(variableSetVariables.id, var_id), eq(variableSetVariables.variableSetId, record.id)),
        })
      : undefined;
    if (!variable) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: variableSetVariableResource(variable) };
  }, { isAuth: true })
  .post("/api/v2/varsets/:varset_id/relationships/vars", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const data = (body as any)?.data;
    const attributes = data?.attributes;
    if (data?.type !== "vars" || !validVariableSetVariableAttributes(attributes)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }

    const variable = {
      id: `var-${crypto.randomUUID()}`,
      variableSetId: record.id,
      key: attributes.key,
      value: attributes.value ?? "",
      category: attributes.category ?? "terraform",
      sensitive: attributes.sensitive ?? false,
      description: attributes.description ?? null,
    };
    try {
      await db.insert(variableSetVariables).values(variable);
    } catch (error: any) {
      if (isUniqueConstraintError(error)) {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this set" }] };
      }
      throw error;
    }
    return { data: variableSetVariableResource(variable) };
  }, { isAuth: true })
  .patch("/api/v2/varsets/:varset_id/relationships/vars", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const relationship = variableRelationshipResources(body);
    if (!relationship || relationship.resources.some(item =>
      !validVariableSetVariableAttributes(item.attributes, true)
    )) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable resources" }] };
    }

    const ids = relationship.resources.map(item => item.id as string);
    const variables = await db.query.variableSetVariables.findMany({
      where: and(
        eq(variableSetVariables.variableSetId, record.id),
        inArray(variableSetVariables.id, ids),
      ),
    });
    if (variables.length !== ids.length) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const byId = new Map(variables.map(variable => [variable.id, variable]));
    const updates = relationship.resources.map(item => {
      const variable = byId.get(item.id)!;
      return { variable, values: variableSetVariableUpdate(variable, item.attributes) };
    });
    try {
      await db.transaction(async tx => {
        for (const update of updates) {
          await tx.update(variableSetVariables)
            .set(update.values)
            .where(eq(variableSetVariables.id, update.variable.id));
        }
      });
    } catch (error: any) {
      if (isUniqueConstraintError(error)) {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this set" }] };
      }
      throw error;
    }

    const resources = updates.map(update =>
      variableSetVariableResource({ ...update.variable, ...update.values })
    );
    return { data: relationship.many ? resources : resources[0] };
  }, { isAuth: true })
  .delete("/api/v2/varsets/:varset_id/relationships/vars", async ({ params: { varset_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    if (!record) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const relationship = variableRelationshipResources(body);
    if (!relationship) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable resources" }] };
    }
    const ids = relationship.resources.map(item => item.id as string);
    const variables = await db.query.variableSetVariables.findMany({
      where: and(
        eq(variableSetVariables.variableSetId, record.id),
        inArray(variableSetVariables.id, ids),
      ),
    });
    if (variables.length !== ids.length) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(variableSetVariables).where(and(
      eq(variableSetVariables.variableSetId, record.id),
      inArray(variableSetVariables.id, ids),
    ));
    set.status = 204;
  }, { isAuth: true })
  .patch("/api/v2/varsets/:varset_id/relationships/vars/:var_id", async ({ params: { varset_id, var_id }, user, orgId, body, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    const variable = record
      ? await db.query.variableSetVariables.findFirst({
          where: and(eq(variableSetVariables.id, var_id), eq(variableSetVariables.variableSetId, record.id)),
        })
      : undefined;
    if (!record || !variable) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const data = (body as any)?.data;
    const attributes = data?.attributes;
    if (data?.type !== "vars" || !validVariableSetVariableAttributes(attributes, true)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }

    const updated = variableSetVariableUpdate(variable, attributes);
    try {
      await db.update(variableSetVariables).set(updated).where(eq(variableSetVariables.id, variable.id));
    } catch (error: any) {
      if (error.message?.includes("UNIQUE") || error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Variable key already exists in this set" }] };
      }
      throw error;
    }
    return { data: variableSetVariableResource({ ...variable, ...updated }) };
  }, { isAuth: true })
  .delete("/api/v2/varsets/:varset_id/relationships/vars/:var_id", async ({ params: { varset_id, var_id }, user, orgId, set }) => {
    const record = await findAuthorizedVariableSet(varset_id, user?.id, orgId);
    const variable = record
      ? await db.query.variableSetVariables.findFirst({
          where: and(eq(variableSetVariables.id, var_id), eq(variableSetVariables.variableSetId, record.id)),
        })
      : undefined;
    if (!record || !variable) {
      set.status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(variableSetVariables).where(eq(variableSetVariables.id, variable.id));
    set.status = 204;
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/workspaces", async ({ params: { org_name }, user, orgId: principalOrgId, request, set }) => {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.name, org_name),
    });
    if (!org) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, org.id, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const { number, size } = pageRequest(request);
    const params = new URL(request.url).searchParams;
    const csv = (name: string) => [...new Set(
      (params.get(name) || "").split(",").map(value => value.trim()).filter(Boolean)
    )];
    const included = csv("search[tags]");
    const excluded = csv("search[exclude-tags]");
    const tagged = new Map<string, { key?: string; value?: string }>();
    for (const [name, value] of params) {
      const match = name.match(/^filter\[tagged]\[(\d+)]\[(key|value)]$/);
      if (!match) continue;
      const filter = tagged.get(match[1]) || {};
      filter[match[2] as "key" | "value"] = value;
      tagged.set(match[1], filter);
    }
    const taggedFilters = [...tagged.values()].filter(
      (filter): filter is { key: string; value: string } =>
        filter.key !== undefined && filter.value !== undefined,
    );
    const [includedRows, excludedRows, taggedRows] = await Promise.all([
      included.length === 0
        ? []
        : db.select({ workspaceId: workspaceTags.workspaceId, key: workspaceTags.key })
            .from(workspaceTags)
            .innerJoin(workspaces, eq(workspaceTags.workspaceId, workspaces.id))
            .where(and(eq(workspaces.orgId, org.id), inArray(workspaceTags.key, included))),
      excluded.length === 0
        ? []
        : db.select({ workspaceId: workspaceTags.workspaceId })
            .from(workspaceTags)
            .innerJoin(workspaces, eq(workspaceTags.workspaceId, workspaces.id))
            .where(and(eq(workspaces.orgId, org.id), inArray(workspaceTags.key, excluded))),
      taggedFilters.length === 0
        ? []
        : db.select({
            workspaceId: workspaceTags.workspaceId,
            key: workspaceTags.key,
            value: workspaceTags.value,
          })
            .from(workspaceTags)
            .innerJoin(workspaces, eq(workspaceTags.workspaceId, workspaces.id))
            .where(and(
              eq(workspaces.orgId, org.id),
              or(...taggedFilters.map(filter =>
                and(eq(workspaceTags.key, filter.key), eq(workspaceTags.value, filter.value))
              ))!
            )),
    ]);
    const conditions = [eq(workspaces.orgId, org.id)];
    const nameSearch = (params.get("search[name]") || params.get("search[wildcard-name]"))?.trim();
    if (nameSearch) conditions.push(like(workspaces.name, `%${nameSearch}%`));
    if (included.length > 0) {
      const matches = new Map<string, Set<string>>();
      for (const row of includedRows) {
        const keys = matches.get(row.workspaceId) || new Set<string>();
        keys.add(row.key);
        matches.set(row.workspaceId, keys);
      }
      const ids = [...matches].filter(([, keys]) => keys.size === included.length).map(([id]) => id);
      conditions.push(ids.length > 0 ? inArray(workspaces.id, ids) : sql`false`);
    }
    if (excludedRows.length > 0) {
      conditions.push(notInArray(workspaces.id, [...new Set(excludedRows.map(row => row.workspaceId))]));
    }
    if (taggedFilters.length > 0) {
      const matches = new Map<string, Set<string>>();
      for (const row of taggedRows) {
        const pairs = matches.get(row.workspaceId) || new Set<string>();
        pairs.add(`${row.key}\0${row.value}`);
        matches.set(row.workspaceId, pairs);
      }
      const ids = [...matches]
        .filter(([, pairs]) => pairs.size === taggedFilters.length)
        .map(([id]) => id);
      conditions.push(ids.length > 0 ? inArray(workspaces.id, ids) : sql`false`);
    }
    const where = and(...conditions)!;
    const [orgWorkspaces, [{ total }]] = await Promise.all([
      db.query.workspaces.findMany({
        where,
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(workspaces).where(where),
    ]);

    return {
      data: await Promise.all(orgWorkspaces.map(workspace =>
        workspaceResource(workspace, org.defaultIacBinary, Boolean(user))
      )),
      ...pagination(request, number, size, total),
    };
  }, { isAuth: true })
  .post("/api/v2/organizations/:org_name/workspaces", async ({ params: { org_name }, body, user, orgId: principalOrgId, request, set }) => {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.name, org_name),
    });
    if (!org) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, org.id, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const attributes = (body as any)?.data?.attributes || {};
    const rawTagBindings = (body as any)?.data?.relationships?.["tag-bindings"]?.data;
    const tagBindings = rawTagBindings === undefined ? [] : parseTagBindings(rawTagBindings);
    const {
      name,
      description,
      "auto-apply": autoApply,
      "terraform-version": terraformVersion,
      "working-directory": workingDirectory,
      "source-name": sourceName,
      "source-url": sourceUrl,
      "iac-binary": iacBinary,
      "execution-mode": executionMode,
    } = attributes;

    if (tagBindings === undefined) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid tag bindings" }] };
    }
    if (!name) {
      set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Missing name" }] };
    }
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid workspace name" }] };
    }
    if (description !== undefined && description !== null && typeof description !== "string") {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "description must be a string or null" }] };
    }
    if (
      (sourceName !== undefined && sourceName !== null && typeof sourceName !== "string")
      || (sourceUrl !== undefined && sourceUrl !== null && typeof sourceUrl !== "string")
    ) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "source-name and source-url must be strings or null" }] };
    }
    if (terraformVersion !== undefined && (typeof terraformVersion !== "string" || !validateVersion(terraformVersion))) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid terraformVersion format" }] };
    }
    if (executionMode !== undefined && executionMode !== "remote") {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Only remote execution mode is supported" }] };
    }
    if (iacBinary !== undefined && iacBinary !== null && !["tofu", "terraform"].includes(iacBinary)) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "iac-binary must be tofu or terraform" }] };
    }
    if (await findWorkspaceByName(org.id, name)) {
      set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace name already exists in this organization" }] };
    }

    let normalizedWorkingDirectory: string | null;
    try {
      normalizedWorkingDirectory = normalizeWorkingDirectory(workingDirectory);
    } catch (error: any) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: error.message }] };
    }

    const projectRel = (body as any)?.data?.relationships?.project?.data;
    let projectId = projectRel?.id || null;
    if (!projectId) {
      let defaultProj = await db.query.projects.findFirst({
        where: and(eq(projects.orgId, org.id), eq(projects.name, "Default Project")),
      });
      if (!defaultProj) {
        const pid = `proj-${crypto.randomUUID()}`;
        await db.insert(projects).values({
          id: pid,
          orgId: org.id,
          name: "Default Project",
          description: "Default project for org",
          createdAt: Date.now(),
        }).onConflictDoNothing();
        defaultProj = (await db.query.projects.findFirst({ where: eq(projects.id, pid) }))!;
      }
      if (defaultProj) projectId = defaultProj.id;
    }

    const workspace = await db.transaction(async tx => {
      const [created] = await tx.insert(workspaces).values({
        id: crypto.randomUUID(),
        name,
        description: description ?? null,
        orgId: org.id,
        projectId,
        autoApply: autoApply ?? false,
        autoApplyRunTrigger: Boolean(attributes["auto-apply-run-trigger"]),
        fileTriggersEnabled: attributes["file-triggers-enabled"] ?? true,
        triggerPrefixes: attributes["trigger-prefixes"] ?? null,
        triggerPatterns: attributes["trigger-patterns"] ?? null,
        vcsRepo: attributes["vcs-repo"] ?? null,
        queueAllRuns: attributes["queue-all-runs"] ?? true,
        speculativeEnabled: attributes["speculative-enabled"] ?? true,
        allowDestroyPlan: attributes["allow-destroy-plan"] ?? true,
        globalRemoteState: Boolean(attributes["global-remote-state"]),
        projectRemoteState: Boolean(attributes["project-remote-state"]),
        agentPoolId: attributes["agent-pool-id"] ?? null,
        assessmentsEnabled: Boolean(attributes["assessments-enabled"]),
        autoDestroyAt: attributes["auto-destroy-at"] ?? null,
        autoDestroyActivityDuration: attributes["auto-destroy-activity-duration"] ?? null,
        settingOverwrites: attributes["setting-overwrites"] ?? null,
        terraformVersion: terraformVersion ?? "latest",
        workingDirectory: normalizedWorkingDirectory,
        sourceName: sourceName ?? null,
        sourceUrl: sourceUrl ?? null,
        iacBinary: iacBinary || (request.headers.get("Terraform-Version") ? "terraform" : null),
      }).returning();
      if (tagBindings.length > 0) {
        await tx.insert(workspaceTags).values(tagBindings.map(binding => ({
          id: crypto.randomUUID(),
          workspaceId: created.id,
          ...binding,
        })));
      }
      return created;
    });

    set.status = 201;
    return { data: await workspaceResource(workspace, org.defaultIacBinary, Boolean(user)) };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params: { org_name, workspace_name }, user, orgId: principalOrgId, set }) => {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.name, org_name),
    });
    if (!org) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, org.id, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const workspace = await findWorkspaceByName(org.id, workspace_name);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    return { data: await workspaceResource(workspace, org.defaultIacBinary, Boolean(user)) };
  }, { isAuth: true })
  .patch("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params: { org_name, workspace_name }, body, user, orgId: principalOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, org.id, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const workspace = await findWorkspaceByName(org.id, workspace_name);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return updateWorkspaceResponse(workspace, org.defaultIacBinary, Boolean(user), body, set);
  }, { isAuth: true })
  .delete("/api/v2/organizations/:org_name/workspaces/:workspace_name", async ({ params: { org_name, workspace_name }, user, orgId: principalOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    const workspace = org ? await findWorkspaceByName(org.id, workspace_name) : null;
    if (!org || !workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, org.id, "owner", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    await deleteWorkspaceData(workspace.id);
    set.status = 204;
  }, { isAuth: true })
  .post("/api/v2/organizations/:org_name/workspaces/:workspace_name/actions/safe-delete", async ({ params: { org_name, workspace_name }, user, orgId: principalOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    const workspace = org ? await findWorkspaceByName(org.id, workspace_name) : null;
    if (!org || !workspace || !(await checkOrgPermission(user?.id, org.id, "owner", principalOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await safeDeleteWorkspace(workspace.id))) {
      set.status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Workspace is managing resources" }] };
    }
    set.status = 204;
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspace_id),
    });

    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, workspace.orgId),
    });

    return { data: await workspaceResource(workspace, org?.defaultIacBinary, Boolean(user)) };
  }, { isAuth: true })
  .patch("/api/v2/workspaces/:workspace_id", async ({ params: { workspace_id }, body, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspace_id),
    });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, workspace.orgId),
    });
    return updateWorkspaceResponse(workspace, org?.defaultIacBinary, Boolean(user), body, set);
  }, { isAuth: true })
  .delete("/api/v2/workspaces/:workspace_id", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspace_id),
    });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "owner", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    await deleteWorkspaceData(workspace_id);
    set.status = 204;
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/actions/safe-delete", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace || !(await checkOrgPermission(user?.id, workspace?.orgId || "", "owner", principalOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await safeDeleteWorkspace(workspace_id))) {
      set.status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Workspace is managing resources" }] };
    }
    set.status = 204;
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/tag-bindings", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    if (!(await findAuthorizedWorkspace(workspace_id, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const tags = await db.query.workspaceTags.findMany({
      where: eq(workspaceTags.workspaceId, workspace_id),
      orderBy: [asc(workspaceTags.key)],
    });
    return {
      data: tags.slice((number - 1) * size, number * size).map(tag => tagBindingResource(tag)),
      ...pagination(request, number, size, tags.length),
    };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/effective-tag-bindings", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!ws) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const directTags = await db.query.workspaceTags.findMany({
      where: eq(workspaceTags.workspaceId, workspace_id),
      orderBy: [asc(workspaceTags.key)],
    });

    const tagMap = new Map<string, { id: string; workspaceId: string; key: string; value: string | null }>();

    if (ws.projectId) {
      const projTags = await db.query.projectTags.findMany({
        where: eq(projectTags.projectId, ws.projectId),
      });
      for (const pt of projTags) {
        tagMap.set(pt.key, { id: pt.id, workspaceId: workspace_id, key: pt.key, value: pt.value });
      }
    }

    for (const dt of directTags) {
      tagMap.set(dt.key, dt);
    }

    const combinedTags = Array.from(tagMap.values()).sort((a, b) => a.key.localeCompare(b.key));

    return {
      data: combinedTags.slice((number - 1) * size, number * size).map(tag => tagBindingResource(tag, true)),
      ...pagination(request, number, size, combinedTags.length),
    };
  }, { isAuth: true })
  .patch("/api/v2/workspaces/:workspace_id/tag-bindings", async ({ params: { workspace_id }, body, user, orgId, set }) => {
    if (!(await findAuthorizedWorkspace(workspace_id, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const bindings = parseTagBindings((body as any)?.data);
    if (!bindings?.length) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "At least one valid tag binding is required" }] };
    }
    const updated = [];
    for (const binding of bindings) {
      const existing = await db.query.workspaceTags.findFirst({
        where: and(eq(workspaceTags.workspaceId, workspace_id), eq(workspaceTags.key, binding.key)),
      });
      if (existing) {
        await db.update(workspaceTags).set({ value: binding.value }).where(eq(workspaceTags.id, existing.id));
        updated.push({ ...existing, value: binding.value });
      } else {
        const tag = { id: crypto.randomUUID(), workspaceId: workspace_id, ...binding };
        await db.insert(workspaceTags).values(tag);
        updated.push(tag);
      }
    }
    return { data: updated.map(tag => tagBindingResource(tag)) };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    const tags = await db.query.workspaceTags.findMany({
        where: eq(workspaceTags.workspaceId, workspace_id)
    });

    return {
        data: tags.map(t => ({
            id: t.id,
            type: "tags",
            attributes: { key: t.key }
        }))
    };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params: { workspace_id }, body, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const payload = body as any;
    const tagsData = payload?.data || [];
    const created = [];

    for (const tagItem of tagsData) {
      const key = tagItem?.attributes?.key || tagItem?.id;
      if (!key || typeof key !== "string" || !key.trim()) continue;
      const id = crypto.randomUUID();
      try {
        await db.insert(workspaceTags).values({ id, workspaceId: workspace_id, key: key.trim() });
        created.push({ id, type: "tags", attributes: { key: key.trim() } });
      } catch (err) {}
    }

    if (created.length === 0) {
      set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "No valid tags provided" }] };
    }

    set.status = 201;
    return { data: created };
  }, { isAuth: true })
  .delete("/api/v2/workspaces/:workspace_id/relationships/tags", async ({ params: { workspace_id }, body, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }

    const data = (body as any)?.data;
    const ids: string[] = [];
    const names: string[] = [];
    if (Array.isArray(data)) {
      for (const tag of data) {
        if (tag?.type !== "tags") continue;
        if (typeof tag.id === "string") ids.push(tag.id);
        const name = tag?.attributes?.name ?? tag?.attributes?.key;
        if (typeof name === "string") names.push(name);
      }
    }
    if (ids.length === 0 && names.length === 0) {
      set.status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Each tag requires an id or name" }] };
    }

    if (ids.length > 0) {
      await db.delete(workspaceTags).where(and(eq(workspaceTags.workspaceId, workspace_id), inArray(workspaceTags.id, ids)));
    }
    if (names.length > 0) {
      await db.delete(workspaceTags).where(and(eq(workspaceTags.workspaceId, workspace_id), inArray(workspaceTags.key, names)));
    }
    set.status = 204;
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/vars", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { number, size } = pageRequest(request);
    const where = eq(workspaceVariables.workspaceId, workspace_id);
    const [vars, [{ total }]] = await Promise.all([
      db.query.workspaceVariables.findMany({
        where,
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(workspaceVariables).where(where),
    ]);

    return {
        data: vars.map(v => ({
            id: v.id,
            type: "vars",
            attributes: {
                key: v.key,
                value: v.sensitive ? null : v.value,
                category: v.category,
                sensitive: v.sensitive,
                description: v.description,
                hcl: v.hcl
            }
        })),
        ...pagination(request, number, size, total)
    };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/vars", async ({ params: { workspace_id }, body, user, orgId, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const payload = body as any;
    const { key, value, category, sensitive, description, hcl } = payload?.data?.attributes || {};

    if (!validVariableAttributes(payload?.data?.attributes || {})) {
        set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }

    const id = crypto.randomUUID();
    await db.insert(workspaceVariables).values({
        id,
        workspaceId: workspace_id,
        key,
        value: String(value),
        category: category || "terraform",
        sensitive: sensitive ?? false,
        hcl: hcl ?? false,
        description: description || null
    });

    set.status = 201;
    return {
        data: {
            id,
            type: "vars",
            attributes: {
                key,
                value: sensitive ? null : String(value),
                category: category || "terraform",
                sensitive: sensitive ?? false,
                description: description || null,
                hcl: hcl ?? false
            }
        }
    };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params: { workspace_id, var_id }, user, orgId, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    const v = await findWorkspaceVar(workspace_id, var_id);
    if (!workspace || !v) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
        data: {
            id: v.id,
            type: "vars",
            attributes: {
                key: v.key,
                value: v.sensitive ? null : v.value,
                category: v.category,
                sensitive: v.sensitive,
                description: v.description,
                hcl: v.hcl
            }
        }
    };
  }, { isAuth: true })
  .patch("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params: { workspace_id, var_id }, body, user, orgId, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const v = await findWorkspaceVar(workspace_id, var_id);
    if (!v) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const payload = body as any;
    const { key, value, category, sensitive, description, hcl } = payload?.data?.attributes || {};
    if (!validVariableAttributes(payload?.data?.attributes || {}, true)) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid variable attributes" }] };
    }

    let newSensitive = sensitive !== undefined ? sensitive : v.sensitive;
    let newValue = value !== undefined ? String(value) : v.value;

    if (v.sensitive && !newSensitive && value === undefined) {
      newSensitive = true;
    }

    const updated = {
        key: key !== undefined ? key : v.key,
        value: newValue,
        category: category !== undefined ? category : v.category,
        sensitive: newSensitive,
        hcl: hcl !== undefined ? hcl : v.hcl,
        description: description !== undefined ? description : v.description,
    };

    await db.update(workspaceVariables).set(updated).where(eq(workspaceVariables.id, var_id));

    return {
        data: {
            id: v.id,
            type: "vars",
            attributes: {
                key: updated.key,
                value: updated.sensitive ? null : updated.value,
                category: updated.category,
                sensitive: updated.sensitive,
                description: updated.description,
                hcl: updated.hcl
            }
        }
    };
  }, { isAuth: true })
  .delete("/api/v2/workspaces/:workspace_id/vars/:var_id", async ({ params: { workspace_id, var_id }, user, orgId, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const v = await findWorkspaceVar(workspace_id, var_id);
    if (!v) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(workspaceVariables).where(eq(workspaceVariables.id, var_id));
    set.status = 204;
    return;
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/actions/lock", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspace_id)
    });
    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    await db.update(workspaces).set({ locked: true }).where(eq(workspaces.id, workspace_id));
    return { data: { type: "workspaces", id: workspace_id, attributes: { locked: true, "locked-reason": "Locked manually" } } };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/actions/unlock", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspace_id)
    });
    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "member", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    await db.update(workspaces).set({ locked: false }).where(eq(workspaces.id, workspace_id));
    return { data: { type: "workspaces", id: workspace_id, attributes: { locked: false, "locked-reason": null } } };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/actions/force-unlock", async ({ params: { workspace_id }, user, orgId: principalOrgId, set }) => {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (!(await checkOrgPermission(user?.id, workspace.orgId, "owner", principalOrgId))) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    await db.update(workspaces).set({ locked: false }).where(eq(workspaces.id, workspace_id));
    return { data: { type: "workspaces", id: workspace_id, attributes: { locked: false, "locked-reason": null } } };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/state-versions", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { number, size } = pageRequest(request);
    const where = eq(stateVersions.workspaceId, workspace_id);
    const [list, [{ total }]] = await Promise.all([
      db.query.stateVersions.findMany({
        where,
        orderBy: [desc(stateVersions.serial)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(stateVersions).where(where),
    ]);

    return {
        data: list.map(state => stateVersionResource(state, request)),
        ...pagination(request, number, size, total)
    };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/current-state-version", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const state = await db.query.stateVersions.findFirst({
        where: eq(stateVersions.workspaceId, workspace_id),
        orderBy: [desc(stateVersions.serial)]
    });
    if (!state) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: stateVersionResource(state, request, true) };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/current-state-version-outputs", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const state = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.workspaceId, workspace_id),
      orderBy: [desc(stateVersions.serial)],
    });
    if (!state) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const outputs = stateOutputResources(state);
    return {
      data: outputs,
      ...pagination(request, 1, Math.max(outputs.length, 1), outputs.length),
    };
  }, { isAuth: true })
  .get("/api/v2/state-versions/:state_version_id", async ({ params: { state_version_id }, user, orgId, request, set }) => {
    const state = await db.query.stateVersions.findFirst({
        where: eq(stateVersions.id, state_version_id)
    });
    if (!state || !(await findAuthorizedWorkspace(state.workspaceId, user?.id, orgId))) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: stateVersionResource(state, request, true) };
  }, { isAuth: true })
  .get("/api/v2/state-versions/:state_version_id/state-version-outputs", async ({ params: { state_version_id }, user, orgId, request, set }) => {
    const state = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.id, state_version_id),
    });
    if (!state || !(await findAuthorizedWorkspace(state.workspaceId, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { number, size } = pageRequest(request);
    const outputs = stateOutputResources(state);
    return {
      data: outputs.slice((number - 1) * size, number * size),
      ...pagination(request, number, size, outputs.length),
    };
  }, { isAuth: true })
  .get("/api/v2/state-versions/:state_version_id/outputs", async ({ params: { state_version_id }, user, orgId, request, set }) => {
    const state = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.id, state_version_id),
    });
    if (!state || !(await findAuthorizedWorkspace(state.workspaceId, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { number, size } = pageRequest(request);
    const outputs = stateOutputResources(state);
    return {
      data: outputs.slice((number - 1) * size, number * size),
      ...pagination(request, number, size, outputs.length),
    };
  }, { isAuth: true })
  .get("/api/v2/state-version-outputs/:state_version_output_id", async ({ params: { state_version_output_id }, user, orgId, set }) => {
    const userOrgs = orgId
      ? [orgId]
      : user?.id
      ? (await db.select({ orgId: organizationMemberships.orgId }).from(organizationMemberships).where(eq(organizationMemberships.userId, user.id))).map(m => m.orgId)
      : [];
    if (userOrgs.length > 0) {
      const wsRows = await db.select({ id: workspaces.id }).from(workspaces).where(inArray(workspaces.orgId, userOrgs));
      const wsIds = wsRows.map(w => w.id);
      if (wsIds.length > 0) {
        const states = await db.select({ id: stateVersions.id, workspaceId: stateVersions.workspaceId, statePayload: stateVersions.statePayload })
          .from(stateVersions)
          .where(inArray(stateVersions.workspaceId, wsIds));
        for (const state of states) {
          const output = stateOutputResources(state as any).find(({ id }) => id === state_version_output_id);
          if (output) {
            return { data: output };
          }
        }
      }
    }
    set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
  }, { isAuth: true })
  .get("/api/v2/state-versions/:state_version_id/json-download", async ({ params: { state_version_id }, user, orgId, set }) => {
    const state = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.id, state_version_id),
    });
    if (!state || !(await findAuthorizedWorkspace(state.workspaceId, user?.id, orgId))) {
      set.status = 404; return "Not Found";
    }
    if (state.jsonState) return state.jsonState;
    const parsed = parseStatePayload(state.statePayload);
    return JSON.stringify(parsed || {});
  }, { isAuth: true })
  .delete("/api/v2/state-versions/:state_version_id", async ({ params: { state_version_id }, user, orgId, set }) => {
    const state = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.id, state_version_id),
    });
    if (!state || !(await findAuthorizedWorkspace(state.workspaceId, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.update(stateVersions).set({ status: "discarded" }).where(eq(stateVersions.id, state_version_id));
    set.status = 204;
  }, { isAuth: true })

  // --- DEPRECATED GLOBAL VARS API ---
  .get("/api/v2/vars", async ({ user, orgId: tokenOrgId, set }) => {
    const userOrgs = tokenOrgId
      ? [tokenOrgId]
      : user?.id
      ? (await db.select({ orgId: organizationMemberships.orgId }).from(organizationMemberships).where(eq(organizationMemberships.userId, user.id))).map(m => m.orgId)
      : [];
    if (userOrgs.length === 0) return { data: [] };
    const wsRows = await db.select({ id: workspaces.id }).from(workspaces).where(inArray(workspaces.orgId, userOrgs));
    const wsIds = wsRows.map(w => w.id);
    if (wsIds.length === 0) return { data: [] };
    const vars = await db.query.workspaceVariables.findMany({ where: inArray(workspaceVariables.workspaceId, wsIds) });
    return { data: vars.map(v => workspaceVariableResource(v)) };
  }, { isAuth: true })
  .post("/api/v2/vars", async ({ body, user, orgId: tokenOrgId, set }) => {
    const attrs = (body as any)?.data?.attributes || {};
    const wsId = (body as any)?.data?.relationships?.workspace?.data?.id;
    if (!wsId || !attrs.key || attrs.value === undefined) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const ws = await findAuthorizedWorkspace(wsId, user?.id, tokenOrgId);
    if (!ws) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const id = `var-${crypto.randomUUID()}`;
    await db.insert(workspaceVariables).values({
      id,
      workspaceId: wsId,
      key: attrs.key,
      value: attrs.value,
      category: attrs.category || "terraform",
      hcl: Boolean(attrs.hcl),
      sensitive: Boolean(attrs.sensitive),
      description: attrs.description ?? null,
    });
    const created = (await db.query.workspaceVariables.findFirst({ where: eq(workspaceVariables.id, id) }))!;
    set.status = 201;
    return { data: workspaceVariableResource(created) };
  }, { isAuth: true })
  .patch("/api/v2/vars/:var_id", async ({ params: { var_id }, body, user, orgId: tokenOrgId, set }) => {
    const v = await db.query.workspaceVariables.findFirst({ where: eq(workspaceVariables.id, var_id) });
    if (!v || !(await findAuthorizedWorkspace(v.workspaceId, user?.id, tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attrs = (body as any)?.data?.attributes || {};
    const updates: Partial<typeof workspaceVariables.$inferInsert> = {};
    if (attrs.key !== undefined) updates.key = attrs.key;
    if (attrs.value !== undefined) updates.value = attrs.value;
    if (attrs.category !== undefined) updates.category = attrs.category;
    if (attrs.hcl !== undefined) updates.hcl = Boolean(attrs.hcl);
    if (attrs.sensitive !== undefined) updates.sensitive = Boolean(attrs.sensitive);
    if (attrs.description !== undefined) updates.description = attrs.description;
    if (Object.keys(updates).length > 0) {
      await db.update(workspaceVariables).set(updates).where(eq(workspaceVariables.id, var_id));
    }
    const updated = (await db.query.workspaceVariables.findFirst({ where: eq(workspaceVariables.id, var_id) }))!;
    return { data: workspaceVariableResource(updated) };
  }, { isAuth: true })
  .delete("/api/v2/vars/:var_id", async ({ params: { var_id }, user, orgId: tokenOrgId, set }) => {
    const v = await db.query.workspaceVariables.findFirst({ where: eq(workspaceVariables.id, var_id) });
    if (!v || !(await findAuthorizedWorkspace(v.workspaceId, user?.id, tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(workspaceVariables).where(eq(workspaceVariables.id, var_id));
    set.status = 204;
  }, { isAuth: true })
  .get("/api/v2/state-versions/:state_version_id/download", async ({ params: { state_version_id }, user, orgId, set }) => {
    const state = await db.query.stateVersions.findFirst({
        where: eq(stateVersions.id, state_version_id)
    });
    if (!state || !(await findAuthorizedWorkspace(state.workspaceId, user?.id, orgId))) {
        set.status = 404; return "Not Found";
    }

    set.headers["Content-Type"] = "application/json";
    return state.statePayload || "{}";
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/state-versions", async ({ params: { workspace_id }, body, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const payload = body as any;
    const { serial, state } = payload?.data?.attributes || {};
    if (serial === undefined) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request" }] };
    }
    if (state === undefined || state === null || state === "") {
        set.status = 400;
        return { errors: [{ status: "400", title: "Bad Request", detail: "param is missing or the value is empty: state" }] };
    }
    const statePayload = decodeStatePayload(state);
    const id = crypto.randomUUID();
    await db.insert(stateVersions).values({
        id,
        workspaceId: workspace_id,
        serial,
        statePayload
    });

    set.status = 201;
    return {
      data: stateVersionResource({ id, workspaceId: workspace_id, serial, statePayload }, request, true),
    };
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/configuration-versions", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { number, size } = pageRequest(request);
    const where = eq(configurationVersions.workspaceId, workspace_id);
    const [list, [{ total }]] = await Promise.all([
      db.query.configurationVersions.findMany({
        where,
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(configurationVersions).where(where),
    ]);
    return {
      data: list.map(cv => ({
        id: cv.id,
        type: "configuration-versions",
        attributes: {
          status: cv.status,
          source: "tfe-api",
          speculative: cv.speculative,
          provisional: cv.provisional,
          "upload-url": apiURL(request, `/api/v2/configuration-versions/${cv.id}/upload`),
        },
      })),
      ...pagination(request, number, size, total),
    };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/configuration-versions", async ({ params: { workspace_id }, body, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { speculative = false, provisional = false } = (body as any)?.data?.attributes || {};
    if (typeof speculative !== "boolean" || typeof provisional !== "boolean") {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "speculative and provisional must be booleans" }] };
    }

    const id = crypto.randomUUID();
    await db.insert(configurationVersions).values({
        id,
        workspaceId: workspace_id,
        status: "pending",
        speculative,
        provisional,
    });

    set.status = 201;
    return {
        data: {
            id,
            type: "configuration-versions",
            attributes: {
                status: "pending",
                source: "tfe-api",
                speculative,
                provisional,
                "upload-url": apiURL(request, `/api/v2/configuration-versions/${id}/upload`)
            }
        }
    };
  }, { isAuth: true })
  .get("/api/v2/configuration-versions/:cv_id", async ({ params: { cv_id }, user, orgId, request, set }) => {
    const cv = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, cv_id)
    });
    if (!cv || !(await findAuthorizedWorkspace(cv.workspaceId, user?.id, orgId))) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
        data: {
            id: cv.id,
            type: "configuration-versions",
            attributes: {
                status: cv.status,
                source: "tfe-api",
                speculative: cv.speculative,
                provisional: cv.provisional,
                "upload-url": apiURL(request, `/api/v2/configuration-versions/${cv.id}/upload`)
            }
        }
    };
  }, { isAuth: true })
  .put("/api/v2/configuration-versions/:cv_id/upload", async ({ params: { cv_id }, body, request, set }) => {
    const cv = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, cv_id)
    });
    if (!cv) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (cv.status !== "pending") {
        set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Configuration version already uploaded" }] };
    }

    await mkdir(CV_STORAGE_DIR, { recursive: true });
    const archivePath = join(CV_STORAGE_DIR, `${cv_id}.tar.gz`);

    let bufferData: Buffer;
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
      bufferData = Buffer.from(body as any);
    } else if (Buffer.isBuffer(body)) {
      bufferData = body;
    } else if (!request.bodyUsed) {
      const buffer = await request.arrayBuffer();
      bufferData = Buffer.from(buffer);
    } else {
      bufferData = Buffer.from("");
    }

    await writeFile(archivePath, bufferData);

    await db.update(configurationVersions).set({ status: "uploaded", archivePath }).where(eq(configurationVersions.id, cv_id));
    set.status = 200;
    return "Upload successful";
  })
  .get("/api/v2/configuration-versions/:cv_id/download", async ({ params: { cv_id }, user, orgId, set }) => {
    const cv = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, cv_id)
    });
    if (!cv || !(await findAuthorizedWorkspace(cv.workspaceId, user?.id, orgId)) || !cv.archivePath) {
        set.status = 404; return "Not Found";
    }
    return Bun.file(cv.archivePath);
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/runs", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const { number, size } = pageRequest(request);
    const where = workspaceRunHistoryWhere(request, workspace_id);
    const [workspaceRuns, [{ total }]] = await Promise.all([
      db.query.runs.findMany({
        where,
        orderBy: [desc(runs.createdAt)],
        limit: size,
        offset: (number - 1) * size,
      }),
      db.select({ total: count() }).from(runs).where(where),
    ]);
    return {
        data: workspaceRuns.map(run => runResource(run, Boolean(user))),
        ...pagination(request, number, size, total)
    };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/runs", async ({ params: { org_name }, user, orgId, request, set }) => {
    const organization = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!organization || !(await checkOrgPermission(user?.id, organization.id, "member", orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const orgWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, organization.id) });
    const { number, size } = pageRequest(request);
    if (orgWorkspaces.length === 0) {
      return { data: [], ...pagination(request, number, size, 0) };
    }

    const where = inArray(runs.workspaceId, orgWorkspaces.map(workspace => workspace.id));
    const [orgRuns, [{ total }]] = await Promise.all([
      db.query.runs.findMany({
          where,
          orderBy: [desc(runs.createdAt)],
          limit: size,
          offset: (number - 1) * size,
        }),
      db.select({ total: count() }).from(runs).where(where),
    ]);
    return {
      data: orgRuns.map(run => runResource(run, Boolean(user))),
      ...pagination(request, number, size, total),
    };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/runs/queue", async ({ params: { org_name }, user, orgId, request, set }) => {
    const organization = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!organization || !(await checkOrgPermission(user?.id, organization.id, "member", orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const orgWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, organization.id) });
    const { number, size } = pageRequest(request);
    if (orgWorkspaces.length === 0) {
      return { data: [], ...pagination(request, number, size, 0) };
    }

    // ponytail: rank the small active queue in-process; use SQL windowing if org queues reach thousands.
    const queue = await db.query.runs.findMany({
      where: and(
        inArray(runs.workspaceId, orgWorkspaces.map(workspace => workspace.id)),
        inArray(runs.status, [...CAPACITY_PENDING_STATUSES, ...CAPACITY_RUNNING_STATUSES]),
      ),
      orderBy: [asc(runs.createdAt)],
    });
    let position = queue.filter(run => CAPACITY_RUNNING_STATUSES.includes(run.status)).length;
    const data = queue.map(run => {
      const resource = runResource(run, Boolean(user));
      return {
        ...resource,
        attributes: {
          ...resource.attributes,
          "position-in-queue": CAPACITY_PENDING_STATUSES.includes(run.status) ? ++position : 0,
        },
      };
    }).slice((number - 1) * size, number * size);

    return { data, ...pagination(request, number, size, queue.length) };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/capacity", async ({ params: { org_name }, user, orgId, set }) => {
    const organization = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!organization || !(await checkOrgPermission(user?.id, organization.id, "member", orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const orgWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, organization.id) });
    const active = orgWorkspaces.length === 0 ? [] : await db.query.runs.findMany({
      columns: { status: true },
      where: and(
        inArray(runs.workspaceId, orgWorkspaces.map(workspace => workspace.id)),
        inArray(runs.status, [...CAPACITY_PENDING_STATUSES, ...CAPACITY_RUNNING_STATUSES]),
      ),
    });
    return {
      data: {
        id: organization.name,
        type: "organization-capacity",
        attributes: {
          pending: active.filter(run => CAPACITY_PENDING_STATUSES.includes(run.status)).length,
          running: active.filter(run => CAPACITY_RUNNING_STATUSES.includes(run.status)).length,
        },
      },
    };
  }, { isAuth: true })
  .post("/api/v2/runs", async ({ body, user, orgId, request, set }) => {
    const payload = body as any;
    const {
      message,
      "is-destroy": isDestroy,
      "auto-apply": autoApply,
      "plan-only": requestedPlanOnly,
      refresh = true,
      "refresh-only": refreshOnly = false,
      "target-addrs": targetAddrs,
      "replace-addrs": replaceAddrs,
      variables: runVariables,
      "terraform-version": terraformVersion,
      "debugging-mode": debuggingMode = false,
    } = payload?.data?.attributes || {};
    const workspaceId = payload?.data?.relationships?.workspace?.data?.id;
    const cvId = payload?.data?.relationships?.["configuration-version"]?.data?.id || payload?.data?.attributes?.["configuration-version-id"];

    if (!workspaceId) {
        set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Workspace ID is required" }] };
    }
    if (
      (autoApply !== undefined && typeof autoApply !== "boolean")
      || (isDestroy !== undefined && typeof isDestroy !== "boolean")
      || (requestedPlanOnly !== undefined && typeof requestedPlanOnly !== "boolean")
      || typeof refresh !== "boolean"
      || typeof refreshOnly !== "boolean"
      || typeof debuggingMode !== "boolean"
      || (terraformVersion !== undefined && (typeof terraformVersion !== "string" || !validateVersion(terraformVersion)))
      || (targetAddrs != null && (!Array.isArray(targetAddrs) || targetAddrs.some(value => typeof value !== "string")))
      || (replaceAddrs != null && (!Array.isArray(replaceAddrs) || replaceAddrs.some(value => typeof value !== "string")))
      || (runVariables != null && (!Array.isArray(runVariables) || runVariables.some(variable =>
        !variable
        || typeof variable.key !== "string"
        || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.key)
        || typeof variable.value !== "string"
      )))
    ) {
      set.status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid run attributes" }] };
    }

    const workspace = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (!workspace) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (orgId) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    let configurationVersion: typeof configurationVersions.$inferSelect | undefined;
    if (cvId) {
      configurationVersion = typeof cvId === "string"
        ? await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) })
        : undefined;
      if (!configurationVersion || configurationVersion.workspaceId !== workspaceId) {
        set.status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Configuration version does not belong to workspace" }] };
      }
    }
    if (!workspace.iacBinary && request.headers.get("Terraform-Version")) {
      await db.update(workspaces).set({ iacBinary: "terraform" }).where(eq(workspaces.id, workspace.id));
    }

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const logToken = crypto.randomUUID();
    const planOnly = requestedPlanOnly ?? configurationVersion?.speculative ?? false;

    await db.insert(runs).values({
        id,
        workspaceId,
        configurationVersionId: cvId || null,
        message: message || "Queued manually",
        status: "pending",
        isDestroy: isDestroy ?? false,
        autoApply: autoApply ?? false,
        planOnly,
        refresh,
        refreshOnly,
        targetAddrs: targetAddrs || null,
        replaceAddrs: replaceAddrs || null,
        variables: runVariables || null,
        logToken,
        terraformVersion: terraformVersion || null,
        debuggingMode,
        createdBy: user?.id || null,
        createdAt,
    });

    set.status = 201;
    return { data: runResource({
      id,
      workspaceId,
      configurationVersionId: cvId || null,
      message: message || "Queued manually",
      status: "pending",
      isDestroy: isDestroy ?? false,
      autoApply: autoApply ?? false,
      planOnly,
      refresh,
      refreshOnly,
      targetAddrs: targetAddrs || null,
      replaceAddrs: replaceAddrs || null,
      variables: runVariables || null,
      logToken,
      terraformVersion: terraformVersion || null,
      debuggingMode,
      createdBy: user?.id || null,
      createdAt,
    }, true) };
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id", async ({ params: { run_id }, user, orgId, set }) => {
    const authorized = await findAuthorizedRun(run_id, user?.id, orgId);
    if (!authorized) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    return { data: runResource(authorized.run, Boolean(user)) };
  }, { isAuth: true })
  .delete("/api/v2/runs/:run_id", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(logs).where(eq(logs.runId, run_id));
    await db.delete(runs).where(eq(runs.id, run_id));
    set.status = 204;
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id/plan", async ({ params: { run_id }, user, orgId, request, set }) => {
    const authorized = await findAuthorizedRun(run_id, user?.id, orgId);
    if (!authorized) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: planResource(authorized.run, request) };
  }, { isAuth: true })
  .get("/api/v2/plans/:plan_id", async ({ params: { plan_id }, user, orgId, request, set }) => {
    const authorized = await findAuthorizedRun(plan_id.replace(/^plan-/, ""), user?.id, orgId);
    if (!authorized) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: planResource(authorized.run, request) };
  }, { isAuth: true })
  .get("/api/v2/applies/:apply_id", async ({ params: { apply_id }, user, orgId, request, set }) => {
    const authorized = await findAuthorizedRun(apply_id.replace(/^apply-/, ""), user?.id, orgId);
    if (!authorized) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: applyResource(authorized.run, request) };
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id/run-events", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: [] };
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id/logs", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const runLogs = await db.query.logs.findMany({
        where: eq(logs.runId, run_id),
        orderBy: [asc(logs.createdAt)]
    });
    return {
        data: runLogs.map(l => ({
            id: l.id,
            type: "logs",
            attributes: {
                phase: l.phase,
                "output-text": l.outputText,
                "created-at": l.createdAt
            }
        }))
    };
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id/plan/log/:log_token", async ({ params: { run_id, log_token }, request, set }) => {
    if (!(await findLogCapability(run_id, log_token))) {
      set.status = 404; return "Not Found";
    }
    const planLogs = await db.query.logs.findMany({
      where: (log, { and, eq }) => and(eq(log.runId, run_id), eq(log.phase, "plan")),
      orderBy: [asc(logs.createdAt)],
    });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(planLogs.map(log => log.outputText).join("\n"), request);
  })
  .get("/api/v2/runs/:run_id/apply/log/:log_token", async ({ params: { run_id, log_token }, request, set }) => {
    if (!(await findLogCapability(run_id, log_token))) {
      set.status = 404; return "Not Found";
    }
    const applyLogs = await db.query.logs.findMany({
      where: (log, { and, eq }) => and(eq(log.runId, run_id), eq(log.phase, "apply")),
      orderBy: [asc(logs.createdAt)],
    });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(applyLogs.map(log => log.outputText).join("\n"), request);
  })
  .get("/api/v2/runs/:run_id/plan/log", async ({ params: { run_id }, user, orgId, request, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const planLogs = await db.query.logs.findMany({
        where: (l, { and, eq }) => and(eq(l.runId, run_id), eq(l.phase, "plan")),
        orderBy: [asc(logs.createdAt)]
    });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(planLogs.map(l => l.outputText).join("\n"), request);
  }, { isAuth: true })
  .get("/api/v2/runs/:run_id/apply/log", async ({ params: { run_id }, user, orgId, request, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }

    const applyLogs = await db.query.logs.findMany({
        where: (l, { and, eq }) => and(eq(l.runId, run_id), eq(l.phase, "apply")),
        orderBy: [asc(logs.createdAt)]
    });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(applyLogs.map(l => l.outputText).join("\n"), request);
  }, { isAuth: true })
  .post("/api/v2/runs/:run_id/actions/apply", async ({ params: { run_id }, body, user, orgId, set }) => {
    const authorized = await findAuthorizedRun(run_id, user?.id, orgId);
    if (!authorized) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (orgId) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    // Allow apply from "planned" (normal) or "policy_soft_failed" (policy override)
    const before = await db.query.runs.findFirst({
      where: and(eq(runs.id, run_id), inArray(runs.status, ["planned", "policy_soft_failed"])),
    });
    if (!before) {
      set.status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Run must be planned or policy_soft_failed before apply" }] };
    }

    await db.update(runs)
      .set({ status: "applying" })
      .where(eq(runs.id, run_id));

    // If this was a policy override, record the override action on all soft-failed policy checks
    if (before.status === "policy_soft_failed") {
      const failedChecks = await db.query.policyChecks.findMany({
        where: and(eq(policyChecks.runId, run_id), inArray(policyChecks.status, ["soft_failed", "failed"])),
      });
      for (const check of failedChecks) {
        await db.update(policyChecks)
          .set({ status: "overridden" })
          .where(eq(policyChecks.id, check.id));
      }
    }

    const commentStr = (body as any)?.comment || (body as any)?.data?.attributes?.comment;
    if (commentStr && typeof commentStr === "string") {
      await db.insert(runComments).values({
        id: `rc-${crypto.randomUUID()}`,
        runId: run_id,
        userId: user?.id ?? null,
        body: commentStr,
        createdAt: Date.now(),
      });
    }

    executeApply(authorized.run.id).catch(console.error);

    return {
        data: {
            id: authorized.run.id,
            type: "runs",
            attributes: { status: "applying" }
        }
    };
  }, { isAuth: true })

  // --- AGENT POOLS API ---
  .get("/api/v2/organizations/:org_name/agent-pools", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const pools = await db.query.agentPools.findMany({ where: eq(agentPools.orgId, org.id) });
    return {
      data: pools.map(p => ({
        id: p.id,
        type: "agent-pools",
        attributes: {
          name: p.name,
          "organization-scoped": p.organizationScoped,
          "agent-count": 0,
        },
      })),
    };
  }, { isAuth: true })
  .post("/api/v2/organizations/:org_name/agent-pools", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attrs = (body as any)?.data?.attributes || {};
    if (!attrs.name) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const id = `apool-${crypto.randomUUID()}`;
    await db.insert(agentPools).values({
      id,
      orgId: org.id,
      name: attrs.name,
      organizationScoped: attrs["organization-scoped"] ?? true,
      createdAt: Date.now(),
    });
    set.status = 201;
    return {
      data: {
        id,
        type: "agent-pools",
        attributes: {
          name: attrs.name,
          "organization-scoped": attrs["organization-scoped"] ?? true,
          "agent-count": 0,
        },
      },
    };
  }, { isAuth: true })
  .get("/api/v2/agent-pools/:pool_id", async ({ params: { pool_id }, user, orgId: tokenOrgId, set }) => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, pool_id) });
    if (!pool || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: pool.id,
        type: "agent-pools",
        attributes: {
          name: pool.name,
          "organization-scoped": pool.organizationScoped,
          "agent-count": 0,
        },
      },
    };
  }, { isAuth: true })
  .delete("/api/v2/agent-pools/:pool_id", async ({ params: { pool_id }, user, orgId: tokenOrgId, set }) => {
    const pool = await db.query.agentPools.findFirst({ where: eq(agentPools.id, pool_id) });
    if (!pool || !(await checkOrgPermission(user?.id, pool.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(agentPools).where(eq(agentPools.id, pool_id));
    set.status = 204;
  }, { isAuth: true })

  // --- POLICY SET PARAMETERS & EXCLUSIONS API ---
  .get("/api/v2/policy-sets/:policy_set_id/parameters", async ({ params: { policy_set_id }, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const paramsList = await db.query.policySetParameters.findMany({ where: eq(policySetParameters.policySetId, policy_set_id) });
    return {
      data: paramsList.map(p => ({
        id: p.id,
        type: "vars",
        attributes: {
          key: p.key,
          value: p.sensitive ? null : p.value,
          sensitive: p.sensitive,
          hcl: p.hcl,
        },
      })),
    };
  }, { isAuth: true })
  .post("/api/v2/policy-sets/:policy_set_id/parameters", async ({ params: { policy_set_id }, body, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attrs = (body as any)?.data?.attributes || {};
    if (!attrs.key) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const id = `psparam-${crypto.randomUUID()}`;
    await db.insert(policySetParameters).values({
      id,
      policySetId: policy_set_id,
      key: attrs.key,
      value: attrs.value ?? "",
      sensitive: attrs.sensitive ?? false,
      hcl: attrs.hcl ?? false,
    });
    set.status = 201;
    return {
      data: {
        id,
        type: "vars",
        attributes: {
          key: attrs.key,
          value: attrs.sensitive ? null : (attrs.value ?? ""),
          sensitive: attrs.sensitive ?? false,
          hcl: attrs.hcl ?? false,
        },
      },
    };
  }, { isAuth: true })

  // --- WEBHOOK RECEIVERS (GITHUB, GITLAB, BITBUCKET) ---
  .post("/api/webhooks/github", async ({ body, set }) => {
    return { status: "received", provider: "github" };
  })
  .post("/api/webhooks/gitlab", async ({ body, set }) => {
    return { status: "received", provider: "gitlab" };
  })
  .post("/api/webhooks/bitbucket", async ({ body, set }) => {
    return { status: "received", provider: "bitbucket" };
  })
  .get("/api/v2/runs/:run_id/comments", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const commentsList = await db.query.runComments.findMany({ where: eq(runComments.runId, run_id) });
    return {
      data: commentsList.map(c => ({
        id: c.id,
        type: "comments",
        attributes: {
          body: c.body,
          "created-at": new Date(c.createdAt).toISOString(),
        },
      })),
    };
  }, { isAuth: true })
  .post("/api/v2/runs/:run_id/comments", async ({ params: { run_id }, body, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const text = (body as any)?.data?.attributes?.body || (body as any)?.body;
    if (!text || typeof text !== "string") {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const id = `rc-${crypto.randomUUID()}`;
    await db.insert(runComments).values({
      id,
      runId: run_id,
      userId: user?.id ?? null,
      body: text,
      createdAt: Date.now(),
    });
    set.status = 201;
    return {
      data: {
        id,
        type: "comments",
        attributes: {
          body: text,
          "created-at": new Date().toISOString(),
        },
      },
    };
  }, { isAuth: true })
  .delete("/api/v2/comments/:comment_id", async ({ params: { comment_id }, user, orgId, set }) => {
    const c = await db.query.runComments.findFirst({ where: eq(runComments.id, comment_id) });
    if (!c || !(await findAuthorizedRun(c.runId, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(runComments).where(eq(runComments.id, comment_id));
    set.status = 204;
  }, { isAuth: true })

  // --- PLAN JSON OUTPUT API ---
  .get("/api/v2/plans/:plan_id/json-output", async ({ params: { plan_id }, user, orgId, set }) => {
    const run = await db.query.runs.findFirst({ where: eq(runs.id, plan_id) });
    if (!run || !(await findAuthorizedWorkspace(run.workspaceId, user?.id, orgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      format_version: "1.0",
      terraform_version: run.terraformVersion || "latest",
      changes: { resource_changes: [] },
    };
  }, { isAuth: true })

  // --- TEAM AUTHENTICATION TOKEN API ---
  .post("/api/v2/teams/:team_id/authentication-token", async ({ params: { team_id }, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "owner", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const token = `team-tok-${crypto.randomUUID()}`;
    const id = `tok-${crypto.randomUUID()}`;
    await db.delete(apiTokens).where(eq(apiTokens.teamId, team_id));
    await db.insert(apiTokens).values({
      id,
      token,
      teamId: team_id,
      orgId: team.orgId,
      description: `Team token for ${team.name}`,
      createdAt: Date.now(),
    });
    set.status = 201;
    return {
      data: {
        id,
        type: "authentication-tokens",
        attributes: {
          token,
          "created-at": new Date().toISOString(),
        },
      },
    };
  }, { isAuth: true })
  .get("/api/v2/teams/:team_id/authentication-token", async ({ params: { team_id }, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "owner", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const tok = await db.query.apiTokens.findFirst({ where: eq(apiTokens.teamId, team_id) });
    if (!tok) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: tok.id,
        type: "authentication-tokens",
        attributes: {
          "created-at": new Date(tok.createdAt).toISOString(),
        },
      },
    };
  }, { isAuth: true })
  .delete("/api/v2/teams/:team_id/authentication-token", async ({ params: { team_id }, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "owner", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(apiTokens).where(eq(apiTokens.teamId, team_id));
    set.status = 204;
  }, { isAuth: true })

  // --- ORGANIZATION AUTHENTICATION TOKEN API ---
  .post("/api/v2/organizations/:org_name/authentication-token", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "owner", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const token = `org-tok-${crypto.randomUUID()}`;
    const id = `tok-${crypto.randomUUID()}`;
    await db.delete(apiTokens).where(and(eq(apiTokens.orgId, org.id), eq(apiTokens.userId, null), eq(apiTokens.teamId, null)));
    await db.insert(apiTokens).values({
      id,
      token,
      orgId: org.id,
      description: `Organization token for ${org.name}`,
      createdAt: Date.now(),
    });
    set.status = 201;
    return {
      data: {
        id,
        type: "authentication-tokens",
        attributes: {
          token,
          "created-at": new Date().toISOString(),
        },
      },
    };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/authentication-token", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "owner", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const tok = await db.query.apiTokens.findFirst({ where: and(eq(apiTokens.orgId, org.id), eq(apiTokens.userId, null), eq(apiTokens.teamId, null)) });
    if (!tok) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: tok.id,
        type: "authentication-tokens",
        attributes: {
          "created-at": new Date(tok.createdAt).toISOString(),
        },
      },
    };
  }, { isAuth: true })
  .delete("/api/v2/organizations/:org_name/authentication-token", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "owner", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(apiTokens).where(and(eq(apiTokens.orgId, org.id), eq(apiTokens.userId, null), eq(apiTokens.teamId, null)));
    set.status = 204;
  }, { isAuth: true })

  // --- RUN TASKS API ---
  .get("/api/v2/organizations/:org_name/run-tasks", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const tasksList = await db.query.runTasks.findMany({ where: eq(runTasks.orgId, org.id) });
    return {
      data: tasksList.map(t => ({
        id: t.id,
        type: "run-tasks",
        attributes: {
          name: t.name,
          description: t.description,
          url: t.url,
          category: t.category,
          enabled: t.enabled,
        },
      })),
    };
  }, { isAuth: true })
  .post("/api/v2/organizations/:org_name/run-tasks", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attrs = (body as any)?.data?.attributes || {};
    if (!attrs.name || !attrs.url) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const id = `task-${crypto.randomUUID()}`;
    await db.insert(runTasks).values({
      id,
      orgId: org.id,
      name: attrs.name,
      description: attrs.description ?? null,
      url: attrs.url,
      category: attrs.category || "general",
      enabled: attrs.enabled ?? true,
      hmacKey: attrs["hmac-key"] ?? null,
      createdAt: Date.now(),
    });
    set.status = 201;
    return {
      data: {
        id,
        type: "run-tasks",
        attributes: {
          name: attrs.name,
          description: attrs.description ?? null,
          url: attrs.url,
          category: attrs.category || "general",
          enabled: attrs.enabled ?? true,
        },
      },
    };
  }, { isAuth: true })
  .get("/api/v2/run-tasks/:task_id", async ({ params: { task_id }, user, orgId: tokenOrgId, set }) => {
    const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, task_id) });
    if (!task || !(await checkOrgPermission(user?.id, task.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: task.id,
        type: "run-tasks",
        attributes: {
          name: task.name,
          description: task.description,
          url: task.url,
          category: task.category,
          enabled: task.enabled,
        },
      },
    };
  }, { isAuth: true })
  .patch("/api/v2/run-tasks/:task_id", async ({ params: { task_id }, body, user, orgId: tokenOrgId, set }) => {
    const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, task_id) });
    if (!task || !(await checkOrgPermission(user?.id, task.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attrs = (body as any)?.data?.attributes || {};
    const updates: Partial<typeof runTasks.$inferInsert> = {};
    if (attrs.name !== undefined) updates.name = attrs.name;
    if (attrs.description !== undefined) updates.description = attrs.description;
    if (attrs.url !== undefined) updates.url = attrs.url;
    if (attrs.enabled !== undefined) updates.enabled = attrs.enabled;
    if (Object.keys(updates).length > 0) {
      await db.update(runTasks).set(updates).where(eq(runTasks.id, task_id));
    }
    const updated = (await db.query.runTasks.findFirst({ where: eq(runTasks.id, task_id) }))!;
    return {
      data: {
        id: updated.id,
        type: "run-tasks",
        attributes: {
          name: updated.name,
          description: updated.description,
          url: updated.url,
          category: updated.category,
          enabled: updated.enabled,
        },
      },
    };
  }, { isAuth: true })
  .delete("/api/v2/run-tasks/:task_id", async ({ params: { task_id }, user, orgId: tokenOrgId, set }) => {
    const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, task_id) });
    if (!task || !(await checkOrgPermission(user?.id, task.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(runTasks).where(eq(runTasks.id, task_id));
    set.status = 204;
  }, { isAuth: true })
  .get("/api/v2/workspaces/:workspace_id/run-tasks", async ({ params: { workspace_id }, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const bindings = await db.query.workspaceRunTasks.findMany({ where: eq(workspaceRunTasks.workspaceId, workspace_id) });
    return {
      data: bindings.map(b => ({
        id: b.id,
        type: "workspace-run-tasks",
        attributes: {
          stage: b.stage,
          "enforcement-level": b.enforcementLevel,
        },
        relationships: {
          "run-task": { data: { id: b.runTaskId, type: "run-tasks" } },
        },
      })),
    };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/run-tasks", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const taskId = (body as any)?.data?.relationships?.["run-task"]?.data?.id || (body as any)?.data?.attributes?.["run-task-id"];
    if (!taskId) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const attrs = (body as any)?.data?.attributes || {};
    const id = `wrt-${crypto.randomUUID()}`;
    await db.insert(workspaceRunTasks).values({
      id,
      workspaceId: workspace_id,
      runTaskId: taskId,
      stage: attrs.stage || "post_plan",
      enforcementLevel: attrs["enforcement-level"] || "advisory",
    }).onConflictDoNothing();
    set.status = 201;
    return {
      data: {
        id,
        type: "workspace-run-tasks",
        attributes: {
          stage: attrs.stage || "post_plan",
          "enforcement-level": attrs["enforcement-level"] || "advisory",
        },
      },
    };
  }, { isAuth: true })

  // --- AUDIT LOGS & ENTITLEMENTS API ---
  .get("/api/v2/admin/audit-logs", async ({ user, orgId: tokenOrgId, set }) => {
    if (!user?.isSiteAdmin) {
      set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] };
    }
    const logsList = await db.query.auditLogs.findMany({ limit: 100, orderBy: [desc(auditLogs.createdAt)] });
    return {
      data: logsList.map(al => ({
        id: al.id,
        type: "audit-logs",
        attributes: {
          action: al.action,
          "resource-type": al.resourceType,
          "resource-id": al.resourceId,
          details: al.details,
          "created-at": new Date(al.createdAt).toISOString(),
        },
      })),
    };
  }, { isAuth: true })
  .get("/api/v2/organizations/:org_name/audit-logs", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "owner", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const logsList = await db.query.auditLogs.findMany({ where: eq(auditLogs.orgId, org.id), limit: 100, orderBy: [desc(auditLogs.createdAt)] });
    return {
      data: logsList.map(al => ({
        id: al.id,
        type: "audit-logs",
        attributes: {
          action: al.action,
          "resource-type": al.resourceType,
          "resource-id": al.resourceId,
          details: al.details,
          "created-at": new Date(al.createdAt).toISOString(),
        },
      })),
    };
  }, { isAuth: true })
  .get("/api/v2/entitlements", async ({ set }) => {
    return {
      data: {
        id: "entitlements",
        type: "entitlements",
        attributes: {
          agents: true,
          audit_logging: true,
          sentinel: true,
          state_storage: true,
          teams: true,
          vcs_integrations: true,
          run_tasks: true,
        },
      },
    };
  })
  .post("/api/v2/runs/:run_id/actions/discard", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const updated = await db.update(runs)
      .set({ status: "discarded" })
      .where(and(eq(runs.id, run_id), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"])))
      .returning();
    if (updated.length === 0) {
      set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not discardable" }] };
    }
    return { data: { id: run_id, type: "runs", attributes: { status: "discarded" } } };
  }, { isAuth: true })
  .post("/api/v2/runs/:run_id/actions/override-policy", async ({ params: { run_id }, user, orgId, set }) => {
    const authorized = await findAuthorizedRun(run_id, user?.id, orgId);
    if (!authorized) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const run = authorized.run;
    if (run.status !== "policy_soft_failed") {
      set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run must be policy_soft_failed to override" }] };
    }
    // Override all failed policy checks
    await db.update(policyChecks)
      .set({ status: "overridden" })
      .where(and(eq(policyChecks.runId, run_id), inArray(policyChecks.status, ["soft_failed", "failed"])));
    // Move to planned so user can then apply
    await db.update(runs).set({ status: "planned" }).where(eq(runs.id, run_id));
    return { data: { id: run_id, type: "runs", attributes: { status: "planned" } } };
  }, { isAuth: true })
  // --- TEAMS API ---
  .get("/api/v2/organizations/:org_name/teams", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const teamList = await db.query.teams.findMany({ where: eq(teams.orgId, org.id) });
    const data = await Promise.all(teamList.map(async (t) => {
      const userCount = (await db.select({ val: count() }).from(teamMemberships).where(eq(teamMemberships.teamId, t.id)))[0]?.val ?? 0;
      return {
        id: t.id,
        type: "teams",
        attributes: {
          name: t.name,
          description: t.description,
          visibility: t.visibility,
          "sso-team-id": t.ssoTeamId,
          "users-count": userCount,
          permissions: { "can-update": true, "can-destroy": true },
        },
        relationships: {
          users: { links: { related: `/api/v2/teams/${t.id}/relationships/users` } },
        },
      };
    }));
    return { data };
  }, { isAuth: true })

  .post("/api/v2/organizations/:org_name/teams", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name || typeof attributes.name !== "string") {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] };
    }
    const id = `team-${crypto.randomUUID()}`;
    const newTeam = {
      id,
      orgId: org.id,
      name: attributes.name,
      description: attributes.description ?? null,
      visibility: attributes.visibility ?? "organization",
      ssoTeamId: attributes["sso-team-id"] ?? null,
      createdAt: Date.now(),
    };
    await db.insert(teams).values(newTeam);
    set.status = 201;
    return {
      data: {
        id,
        type: "teams",
        attributes: {
          name: newTeam.name,
          description: newTeam.description,
          visibility: newTeam.visibility,
          "sso-team-id": newTeam.ssoTeamId,
          "users-count": 0,
          permissions: { "can-update": true, "can-destroy": true },
        },
      },
    };
  }, { isAuth: true })

  .get("/api/v2/teams/:team_id", async ({ params: { team_id }, user, orgId: tokenOrgId, query, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const userCount = (await db.select({ val: count() }).from(teamMemberships).where(eq(teamMemberships.teamId, team.id)))[0]?.val ?? 0;
    const includeUsers = (query as any)?.include?.split(",").includes("users");
    let included: any[] = [];
    if (includeUsers) {
      const members = await db.query.teamMemberships.findMany({ where: eq(teamMemberships.teamId, team.id) });
      const userIds = members.map(m => m.userId);
      if (userIds.length > 0) {
        const uList = await db.query.users.findMany({ where: inArray(users.id, userIds) });
        included = uList.map(u => ({
          id: u.id,
          type: "users",
          attributes: { username: u.username, email: u.email },
        }));
      }
    }
    return {
      data: {
        id: team.id,
        type: "teams",
        attributes: {
          name: team.name,
          description: team.description,
          visibility: team.visibility,
          "sso-team-id": team.ssoTeamId,
          "users-count": userCount,
          permissions: { "can-update": true, "can-destroy": true },
        },
      },
      ...(included.length > 0 ? { included } : {}),
    };
  }, { isAuth: true })

  .patch("/api/v2/teams/:team_id", async ({ params: { team_id }, body, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof teams.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = attributes.description;
    if (typeof attributes.visibility === "string") updates.visibility = attributes.visibility;
    if (attributes["sso-team-id"] !== undefined) updates.ssoTeamId = attributes["sso-team-id"];

    if (Object.keys(updates).length > 0) {
      await db.update(teams).set(updates).where(eq(teams.id, team_id));
    }
    const updated = (await db.query.teams.findFirst({ where: eq(teams.id, team_id) }))!;
    const userCount = (await db.select({ val: count() }).from(teamMemberships).where(eq(teamMemberships.teamId, team_id)))[0]?.val ?? 0;
    return {
      data: {
        id: updated.id,
        type: "teams",
        attributes: {
          name: updated.name,
          description: updated.description,
          visibility: updated.visibility,
          "sso-team-id": updated.ssoTeamId,
          "users-count": userCount,
          permissions: { "can-update": true, "can-destroy": true },
        },
      },
    };
  }, { isAuth: true })

  .delete("/api/v2/teams/:team_id", async ({ params: { team_id }, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(apiTokens).where(eq(apiTokens.teamId, team_id));
    await db.delete(teamMemberships).where(eq(teamMemberships.teamId, team_id));
    await db.delete(teamWorkspaces).where(eq(teamWorkspaces.teamId, team_id));
    await db.delete(teams).where(eq(teams.id, team_id));
    set.status = 204;
    return;
  }, { isAuth: true })

  .post("/api/v2/teams/:team_id/relationships/users", async ({ params: { team_id }, body, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const userItems = (body as any)?.data;
    if (Array.isArray(userItems)) {
      for (const item of userItems) {
        if (item?.id) {
          const id = `tm-${crypto.randomUUID()}`;
          await db.insert(teamMemberships).values({ id, teamId: team_id, userId: item.id, createdAt: Date.now() }).onConflictDoNothing();
        }
      }
    }
    set.status = 204;
    return;
  }, { isAuth: true })

  .delete("/api/v2/teams/:team_id/relationships/users", async ({ params: { team_id }, body, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const userItems = (body as any)?.data;
    if (Array.isArray(userItems)) {
      const uIds = userItems.map(i => i.id).filter(Boolean);
      if (uIds.length > 0) {
        await db.delete(teamMemberships).where(and(eq(teamMemberships.teamId, team_id), inArray(teamMemberships.userId, uIds)));
      }
    }
    set.status = 204;
    return;
  }, { isAuth: true })

  .post("/api/v2/teams/:team_id/relationships/organization-memberships", async ({ params: { team_id }, body, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const items = (body as any)?.data;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item?.id) {
          const mem = await db.query.organizationMemberships.findFirst({ where: eq(organizationMemberships.id, item.id) });
          if (mem && mem.orgId === team.orgId) {
            const id = `tm-${crypto.randomUUID()}`;
            await db.insert(teamMemberships).values({ id, teamId: team_id, userId: mem.userId, createdAt: Date.now() }).onConflictDoNothing();
          }
        }
      }
    }
    set.status = 204;
    return;
  }, { isAuth: true })

  .post("/api/v2/teams/:team_id/authentication-tokens", async ({ params: { team_id }, body, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const secret = `team-${crypto.randomUUID().replace(/-/g, "")}`;
    const tokenId = `tok-${crypto.randomUUID()}`;
    const attrs = (body as any)?.data?.attributes || {};
    const description = attrs.description ?? `Team token for ${team.name}`;
    const expiredAtStr = attrs["expired-at"] || attrs["expires-at"] || attrs.expiredAt || attrs.expiresAt;
    const expiresAt = expiredAtStr ? new Date(expiredAtStr).getTime() : null;

    const tokenHash = createHash("sha256").update(secret).digest("hex");
    await db.insert(apiTokens).values({
      id: tokenId,
      token: tokenHash,
      orgId: team.orgId,
      teamId: team.id,
      description,
      createdAt: Date.now(),
      expiresAt,
    });
    set.status = 201;
    return {
      data: {
        id: tokenId,
        type: "authentication-tokens",
        attributes: {
          token: secret,
          description,
          "created-at": new Date().toISOString(),
          "expired-at": expiresAt ? new Date(expiresAt).toISOString() : null,
        },
      },
    };
  }, { isAuth: true })

  .get("/api/v2/teams/:team_id/authentication-tokens", async ({ params: { team_id }, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const tokenList = await db.query.apiTokens.findMany({ where: eq(apiTokens.teamId, team_id) });
    const data = tokenList.map(t => ({
      id: t.id,
      type: "authentication-tokens",
      attributes: {
        description: t.description,
        "created-at": new Date(t.createdAt).toISOString(),
        "last-used-at": t.lastUsedAt ? new Date(t.lastUsedAt).toISOString() : null,
      },
    }));
    return { data };
  }, { isAuth: true })

  .delete("/api/v2/teams/:team_id/authentication-tokens/:token_id", async ({ params: { team_id, token_id }, user, orgId: tokenOrgId, set }) => {
    const team = await db.query.teams.findFirst({ where: eq(teams.id, team_id) });
    if (!team || !(await checkOrgPermission(user?.id, team.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(apiTokens).where(and(eq(apiTokens.id, token_id), eq(apiTokens.teamId, team_id)));
    set.status = 204;
    return;
  }, { isAuth: true })

  // --- TEAM WORKSPACES API ---
  .get("/api/v2/team-workspaces", async ({ query, user, orgId: tokenOrgId, set }) => {
    const workspaceId = (query as any)?.["filter[workspace][id]"];
    if (!workspaceId) return { data: [] };
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const twList = await db.query.teamWorkspaces.findMany({ where: eq(teamWorkspaces.workspaceId, workspaceId) });
    const data = twList.map(tw => ({
      id: tw.id,
      type: "team-workspaces",
      attributes: {
        access: tw.access,
        permissions: tw.permissions ?? { runs: "write", variables: "write", "state-versions": "write" },
      },
      relationships: {
        team: { data: { id: tw.teamId, type: "teams" } },
        workspace: { data: { id: tw.workspaceId, type: "workspaces" } },
      },
    }));
    return { data };
  }, { isAuth: true })

  .post("/api/v2/team-workspaces", async ({ body, user, orgId: tokenOrgId, set }) => {
    const data = (body as any)?.data;
    const teamId = data?.relationships?.team?.data?.id;
    const workspaceId = data?.relationships?.workspace?.data?.id;
    const access = data?.attributes?.access ?? "write";
    const permissions = data?.attributes?.permissions ?? null;
    if (!teamId || !workspaceId) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const id = `tw-${crypto.randomUUID()}`;
    await db.insert(teamWorkspaces).values({ id, teamId, workspaceId, access, permissions });
    set.status = 201;
    return {
      data: {
        id,
        type: "team-workspaces",
        attributes: { access, permissions: permissions ?? { runs: "write", variables: "write" } },
        relationships: {
          team: { data: { id: teamId, type: "teams" } },
          workspace: { data: { id: workspaceId, type: "workspaces" } },
        },
      },
    };
  }, { isAuth: true })

  .patch("/api/v2/team-workspaces/:id", async ({ params: { id }, body, user, orgId: tokenOrgId, set }) => {
    const tw = await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, id) });
    if (!tw) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, tw.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof teamWorkspaces.$inferInsert> = {};
    if (typeof attributes.access === "string") updates.access = attributes.access;
    if (attributes.permissions !== undefined) updates.permissions = attributes.permissions;
    if (Object.keys(updates).length > 0) {
      await db.update(teamWorkspaces).set(updates).where(eq(teamWorkspaces.id, id));
    }
    const updated = (await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, id) }))!;
    return {
      data: {
        id: updated.id,
        type: "team-workspaces",
        attributes: { access: updated.access, permissions: updated.permissions },
        relationships: {
          team: { data: { id: updated.teamId, type: "teams" } },
          workspace: { data: { id: updated.workspaceId, type: "workspaces" } },
        },
      },
    };
  }, { isAuth: true })

  .delete("/api/v2/team-workspaces/:id", async ({ params: { id }, user, orgId: tokenOrgId, set }) => {
    const tw = await db.query.teamWorkspaces.findFirst({ where: eq(teamWorkspaces.id, id) });
    if (!tw) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, tw.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(teamWorkspaces).where(eq(teamWorkspaces.id, id));
    set.status = 204;
    return;
  }, { isAuth: true })

  // --- PROJECTS API ---
  .get("/api/v2/organizations/:org_name/projects", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    let projList = await db.query.projects.findMany({ where: eq(projects.orgId, org.id) });
    if (projList.length === 0) {
      const defaultId = `prj-${crypto.randomUUID()}`;
      await db.insert(projects).values({ id: defaultId, orgId: org.id, name: "Default Project", description: "Default Project for Organization", defaultExecutionMode: "remote", createdAt: Date.now() });
      projList = await db.query.projects.findMany({ where: eq(projects.orgId, org.id) });
    }
    const data = projList.map(p => ({
      id: p.id,
      type: "projects",
      attributes: {
        name: p.name,
        description: p.description,
        "default-execution-mode": p.defaultExecutionMode,
      },
    }));
    return { data };
  }, { isAuth: true })

  .post("/api/v2/organizations/:org_name/projects", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name || typeof attributes.name !== "string") {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] };
    }
    const id = `prj-${crypto.randomUUID()}`;
    const newProj = {
      id,
      orgId: org.id,
      name: attributes.name,
      description: attributes.description ?? null,
      defaultExecutionMode: attributes["default-execution-mode"] ?? "remote",
      createdAt: Date.now(),
    };
    await db.insert(projects).values(newProj);
    set.status = 201;
    return {
      data: {
        id,
        type: "projects",
        attributes: {
          name: newProj.name,
          description: newProj.description,
          "default-execution-mode": newProj.defaultExecutionMode,
        },
      },
    };
  }, { isAuth: true })

  .get("/api/v2/projects/:project_id", async ({ params: { project_id }, user, orgId: tokenOrgId, set }) => {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, project_id) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: project.id,
        type: "projects",
        attributes: {
          name: project.name,
          description: project.description,
          "default-execution-mode": project.defaultExecutionMode,
        },
      },
    };
  }, { isAuth: true })

  .patch("/api/v2/projects/:project_id", async ({ params: { project_id }, body, user, orgId: tokenOrgId, set }) => {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, project_id) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof projects.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = attributes.description;
    if (typeof attributes["default-execution-mode"] === "string") updates.defaultExecutionMode = attributes["default-execution-mode"];
    if (Object.keys(updates).length > 0) {
      await db.update(projects).set(updates).where(eq(projects.id, project_id));
    }
    const updated = (await db.query.projects.findFirst({ where: eq(projects.id, project_id) }))!;
    return {
      data: {
        id: updated.id,
        type: "projects",
        attributes: {
          name: updated.name,
          description: updated.description,
          "default-execution-mode": updated.defaultExecutionMode,
        },
      },
    };
  }, { isAuth: true })

  .delete("/api/v2/projects/:project_id", async ({ params: { project_id }, user, orgId: tokenOrgId, set }) => {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, project_id) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(projects).where(eq(projects.id, project_id));
    set.status = 204;
    return;
  }, { isAuth: true })

  // --- PROJECT TAG BINDINGS API ---
  .get("/api/v2/projects/:project_id/tag-bindings", async ({ params: { project_id }, user, orgId: tokenOrgId, set }) => {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, project_id) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const tags = await db.query.projectTags.findMany({ where: eq(projectTags.projectId, project_id) });
    return { data: tags.map(t => projectTagBindingResource(t)) };
  }, { isAuth: true })
  .get("/api/v2/projects/:project_id/effective-tag-bindings", async ({ params: { project_id }, user, orgId: tokenOrgId, set }) => {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, project_id) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const tags = await db.query.projectTags.findMany({ where: eq(projectTags.projectId, project_id) });
    return { data: tags.map(t => projectTagBindingResource(t)) };
  }, { isAuth: true })
  .post("/api/v2/projects/:project_id/tag-bindings", async ({ params: { project_id }, body, user, orgId: tokenOrgId, set }) => {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, project_id) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const items = (body as any)?.data;
    const tagList = Array.isArray(items) ? items : [items];
    const created: any[] = [];
    for (const item of tagList) {
      const key = item?.attributes?.key;
      const value = item?.attributes?.value ?? null;
      if (key && typeof key === "string") {
        const existing = await db.query.projectTags.findFirst({
          where: and(eq(projectTags.projectId, project_id), eq(projectTags.key, key)),
        });
        if (existing) {
          await db.update(projectTags).set({ value }).where(eq(projectTags.id, existing.id));
        } else {
          const id = `ptag-${crypto.randomUUID()}`;
          await db.insert(projectTags).values({ id, projectId: project_id, key, value });
        }
        const pt = (await db.query.projectTags.findFirst({ where: and(eq(projectTags.projectId, project_id), eq(projectTags.key, key)) }))!;
        created.push(projectTagBindingResource(pt));
      }
    }
    set.status = 201;
    return { data: created.length === 1 ? created[0] : created };
  }, { isAuth: true })
  .delete("/api/v2/projects/:project_id/tag-bindings", async ({ params: { project_id }, body, user, orgId: tokenOrgId, set }) => {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, project_id) });
    if (!project || !(await checkOrgPermission(user?.id, project.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const items = (body as any)?.data;
    const tagList = Array.isArray(items) ? items : [items];
    const keys = tagList.map((i: any) => i?.attributes?.key || i?.key).filter(Boolean);
    if (keys.length > 0) {
      await db.delete(projectTags).where(and(eq(projectTags.projectId, project_id), inArray(projectTags.key, keys)));
    }
    set.status = 204;
    return;
  }, { isAuth: true })

  // --- WORKSPACE REMOTE STATE CONSUMERS API ---
  .get("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params: { workspace_id }, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const consumers = await db.query.remoteStateConsumers.findMany({ where: eq(remoteStateConsumers.workspaceId, workspace_id) });
    return {
      data: consumers.map(c => ({
        id: c.consumerWorkspaceId,
        type: "workspaces",
      })),
    };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const items = (body as any)?.data;
    const list = Array.isArray(items) ? items : [items];
    for (const item of list) {
      if (item?.id) {
        await db.insert(remoteStateConsumers).values({
          id: `rsc-${crypto.randomUUID()}`,
          workspaceId: workspace_id,
          consumerWorkspaceId: item.id,
        }).onConflictDoNothing();
      }
    }
    set.status = 204;
    return;
  }, { isAuth: true })
  .patch("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(remoteStateConsumers).where(eq(remoteStateConsumers.workspaceId, workspace_id));
    const items = (body as any)?.data;
    const list = Array.isArray(items) ? items : [items];
    for (const item of list) {
      if (item?.id) {
        await db.insert(remoteStateConsumers).values({
          id: `rsc-${crypto.randomUUID()}`,
          workspaceId: workspace_id,
          consumerWorkspaceId: item.id,
        }).onConflictDoNothing();
      }
    }
    set.status = 204;
    return;
  }, { isAuth: true })
  .delete("/api/v2/workspaces/:workspace_id/relationships/remote-state-consumers", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const items = (body as any)?.data;
    if (Array.isArray(items)) {
      const ids = items.map(i => i?.id).filter(Boolean);
      if (ids.length > 0) {
        await db.delete(remoteStateConsumers).where(and(eq(remoteStateConsumers.workspaceId, workspace_id), inArray(remoteStateConsumers.consumerWorkspaceId, ids)));
      }
    }
    set.status = 204;
    return;
  }, { isAuth: true })

  // --- WORKSPACE DATA RETENTION POLICY API ---
  .get("/api/v2/workspaces/:workspace_id/relationships/data-retention-policy", async ({ params: { workspace_id }, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const policy = await db.query.dataRetentionPolicies.findFirst({ where: eq(dataRetentionPolicies.workspaceId, workspace_id) });
    if (!policy) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: policy.id,
        type: "data-retention-policies",
        attributes: {
          "state-versions-count": policy.stateVersionsCount,
          "auto-destroy-at": policy.autoDestroyAt,
          "auto-destroy-activity-duration": policy.autoDestroyActivityDuration,
        },
      },
    };
  }, { isAuth: true })
  .post("/api/v2/workspaces/:workspace_id/relationships/data-retention-policy", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attrs = (body as any)?.data?.attributes || {};
    const existing = await db.query.dataRetentionPolicies.findFirst({ where: eq(dataRetentionPolicies.workspaceId, workspace_id) });
    const pid = existing ? existing.id : `drp-${crypto.randomUUID()}`;
    const values = {
      id: pid,
      workspaceId: workspace_id,
      stateVersionsCount: attrs["state-versions-count"] ?? null,
      autoDestroyAt: attrs["auto-destroy-at"] ?? null,
      autoDestroyActivityDuration: attrs["auto-destroy-activity-duration"] ?? null,
      createdAt: Date.now(),
    };
    if (existing) {
      await db.update(dataRetentionPolicies).set(values).where(eq(dataRetentionPolicies.id, pid));
    } else {
      await db.insert(dataRetentionPolicies).values(values);
    }
    set.status = 201;
    return {
      data: {
        id: pid,
        type: "data-retention-policies",
        attributes: {
          "state-versions-count": values.stateVersionsCount,
          "auto-destroy-at": values.autoDestroyAt,
          "auto-destroy-activity-duration": values.autoDestroyActivityDuration,
        },
      },
    };
  }, { isAuth: true })
  .delete("/api/v2/workspaces/:workspace_id/relationships/data-retention-policy", async ({ params: { workspace_id }, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(dataRetentionPolicies).where(eq(dataRetentionPolicies.workspaceId, workspace_id));
    set.status = 204;
    return;
  }, { isAuth: true })

  // --- CONFIGURATION VERSION INGRESS ATTRIBUTES API ---
  .get("/api/v2/configuration-versions/:cv_id/ingress-attributes", async ({ params: { cv_id }, user, orgId: tokenOrgId, set }) => {
    const cv = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cv_id) });
    if (!cv) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, cv.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ingress = cv.ingressAttributes || {};
    return {
      data: {
        id: cv.id,
        type: "ingress-attributes",
        attributes: {
          "commit-sha": ingress.commitSha ?? null,
          "commit-url": ingress.commitUrl ?? null,
          "commit-message": ingress.commitMessage ?? null,
          branch: ingress.branch ?? null,
          tag: ingress.tag ?? null,
          "pull-request-number": ingress.pullRequestNumber ?? null,
          "sender-username": ingress.senderUsername ?? null,
          "clone-url": ingress.cloneUrl ?? null,
          "compare-url": ingress.compareUrl ?? null,
        },
      },
    };
  }, { isAuth: true })

  // --- SSH KEYS API ---
  .get("/api/v2/organizations/:org_name/ssh-keys", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const keyList = await db.query.sshKeys.findMany({ where: eq(sshKeys.orgId, org.id) });
    const data = keyList.map(k => ({
      id: k.id,
      type: "ssh-keys",
      attributes: { name: k.name },
    }));
    return { data };
  }, { isAuth: true })

  .post("/api/v2/organizations/:org_name/ssh-keys", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name || !attributes.value) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name and value are required" }] };
    }
    const id = `ssh-${crypto.randomUUID()}`;
    await db.insert(sshKeys).values({
      id,
      orgId: org.id,
      name: attributes.name,
      value: attributes.value,
      createdAt: Date.now(),
    });
    set.status = 201;
    return {
      data: {
        id,
        type: "ssh-keys",
        attributes: { name: attributes.name },
      },
    };
  }, { isAuth: true })

  .get("/api/v2/ssh-keys/:ssh_key_id", async ({ params: { ssh_key_id }, user, orgId: tokenOrgId, set }) => {
    const key = await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, ssh_key_id) });
    if (!key || !(await checkOrgPermission(user?.id, key.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: key.id,
        type: "ssh-keys",
        attributes: { name: key.name },
      },
    };
  }, { isAuth: true })

  .patch("/api/v2/ssh-keys/:ssh_key_id", async ({ params: { ssh_key_id }, body, user, orgId: tokenOrgId, set }) => {
    const key = await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, ssh_key_id) });
    if (!key || !(await checkOrgPermission(user?.id, key.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof sshKeys.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (typeof attributes.value === "string") updates.value = attributes.value;
    if (Object.keys(updates).length > 0) {
      await db.update(sshKeys).set(updates).where(eq(sshKeys.id, ssh_key_id));
    }
    const updated = (await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, ssh_key_id) }))!;
    return {
      data: {
        id: updated.id,
        type: "ssh-keys",
        attributes: { name: updated.name },
      },
    };
  }, { isAuth: true })

  .delete("/api/v2/ssh-keys/:ssh_key_id", async ({ params: { ssh_key_id }, user, orgId: tokenOrgId, set }) => {
    const key = await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, ssh_key_id) });
    if (!key || !(await checkOrgPermission(user?.id, key.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(sshKeys).where(eq(sshKeys.id, ssh_key_id));
    set.status = 204;
    return;
  }, { isAuth: true })

  .patch("/api/v2/workspaces/:workspace_id/relationships/ssh-key", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const sshKeyData = (body as any)?.data;
    const sshKeyId = sshKeyData?.id ?? null;
    await db.update(workspaces).set({ sshKeyId }).where(eq(workspaces.id, workspace_id));
    return {
      data: {
        id: workspace_id,
        type: "workspaces",
        relationships: {
          "ssh-key": { data: sshKeyId ? { id: sshKeyId, type: "ssh-keys" } : null },
        },
      },
    };
  }, { isAuth: true })

  // --- NOTIFICATION CONFIGURATIONS API ---
  .get("/api/v2/workspaces/:workspace_id/notification-configurations", async ({ params: { workspace_id }, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ncList = await db.query.notificationConfigurations.findMany({ where: eq(notificationConfigurations.workspaceId, workspace_id) });
    const data = ncList.map(nc => ({
      id: nc.id,
      type: "notification-configurations",
      attributes: {
        name: nc.name,
        "destination-type": nc.destinationType,
        url: nc.url,
        triggers: nc.triggers,
        enabled: nc.enabled,
        token: nc.token,
      },
    }));
    return { data };
  }, { isAuth: true })

  .post("/api/v2/workspaces/:workspace_id/notification-configurations", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name || !attributes.url || !attributes["destination-type"]) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name, url, destination-type are required" }] };
    }
    const id = `nc-${crypto.randomUUID()}`;
    const newNc = {
      id,
      workspaceId: workspace_id,
      name: attributes.name,
      destinationType: attributes["destination-type"],
      url: attributes.url,
      triggers: Array.isArray(attributes.triggers) ? attributes.triggers : ["run:created", "run:completed"],
      enabled: attributes.enabled ?? true,
      token: attributes.token ?? null,
      createdAt: Date.now(),
    };
    await db.insert(notificationConfigurations).values(newNc);
    set.status = 201;
    return {
      data: {
        id,
        type: "notification-configurations",
        attributes: {
          name: newNc.name,
          "destination-type": newNc.destinationType,
          url: newNc.url,
          triggers: newNc.triggers,
          enabled: newNc.enabled,
          token: newNc.token,
        },
      },
    };
  }, { isAuth: true })

  .get("/api/v2/notification-configurations/:nc_id", async ({ params: { nc_id }, user, orgId: tokenOrgId, set }) => {
    const nc = await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, nc_id) });
    if (!nc) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, nc.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: nc.id,
        type: "notification-configurations",
        attributes: {
          name: nc.name,
          "destination-type": nc.destinationType,
          url: nc.url,
          triggers: nc.triggers,
          enabled: nc.enabled,
          token: nc.token,
        },
      },
    };
  }, { isAuth: true })

  .patch("/api/v2/notification-configurations/:nc_id", async ({ params: { nc_id }, body, user, orgId: tokenOrgId, set }) => {
    const nc = await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, nc_id) });
    if (!nc) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, nc.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof notificationConfigurations.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (typeof attributes["destination-type"] === "string") updates.destinationType = attributes["destination-type"];
    if (typeof attributes.url === "string") updates.url = attributes.url;
    if (Array.isArray(attributes.triggers)) updates.triggers = attributes.triggers;
    if (typeof attributes.enabled === "boolean") updates.enabled = attributes.enabled;
    if (attributes.token !== undefined) updates.token = attributes.token;

    if (Object.keys(updates).length > 0) {
      await db.update(notificationConfigurations).set(updates).where(eq(notificationConfigurations.id, nc_id));
    }
    const updated = (await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, nc_id) }))!;
    return {
      data: {
        id: updated.id,
        type: "notification-configurations",
        attributes: {
          name: updated.name,
          "destination-type": updated.destinationType,
          url: updated.url,
          triggers: updated.triggers,
          enabled: updated.enabled,
          token: updated.token,
        },
      },
    };
  }, { isAuth: true })

  .delete("/api/v2/notification-configurations/:nc_id", async ({ params: { nc_id }, user, orgId: tokenOrgId, set }) => {
    const nc = await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, nc_id) });
    if (!nc) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, nc.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, nc_id));
    set.status = 204;
    return;
  }, { isAuth: true })

  .post("/api/v2/notification-configurations/:nc_id/actions/verify", async ({ params: { nc_id }, user, orgId: tokenOrgId, set }) => {
    const nc = await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, nc_id) });
    if (!nc) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, nc.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { status: "verification_sent" };
  }, { isAuth: true })

  // --- OAUTH CLIENTS & TOKENS API ---
  .get("/api/v2/organizations/:org_name/oauth-clients", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const clientList = await db.query.oauthClients.findMany({ where: eq(oauthClients.orgId, org.id) });
    const data = clientList.map(oc => ({
      id: oc.id,
      type: "oauth-clients",
      attributes: {
        name: oc.name,
        "service-provider": oc.serviceProvider,
        "api-url": oc.apiUrl,
        "http-url": oc.httpUrl,
        "rsa-public-key": oc.rsaPublicKey,
      },
    }));
    return { data };
  }, { isAuth: true })

  .post("/api/v2/organizations/:org_name/oauth-clients", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name || typeof attributes.name !== "string") {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] };
    }
    const id = `oc-${crypto.randomUUID()}`;
    const newOc = {
      id,
      orgId: org.id,
      name: attributes.name,
      serviceProvider: attributes["service-provider"] ?? "github",
      apiUrl: attributes["api-url"] ?? null,
      httpUrl: attributes["http-url"] ?? null,
      key: attributes.key ?? null,
      secret: attributes.secret ?? null,
      rsaPublicKey: attributes["rsa-public-key"] ?? null,
      createdAt: Date.now(),
    };
    await db.insert(oauthClients).values(newOc);
    set.status = 201;
    return {
      data: {
        id,
        type: "oauth-clients",
        attributes: {
          name: newOc.name,
          "service-provider": newOc.serviceProvider,
          "api-url": newOc.apiUrl,
          "http-url": newOc.httpUrl,
          "rsa-public-key": newOc.rsaPublicKey,
        },
      },
    };
  }, { isAuth: true })

  .get("/api/v2/oauth-clients/:oc_id", async ({ params: { oc_id }, user, orgId: tokenOrgId, set }) => {
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, oc_id) });
    if (!oc || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: oc.id,
        type: "oauth-clients",
        attributes: {
          name: oc.name,
          "service-provider": oc.serviceProvider,
          "api-url": oc.apiUrl,
          "http-url": oc.httpUrl,
          "rsa-public-key": oc.rsaPublicKey,
        },
      },
    };
  }, { isAuth: true })

  .patch("/api/v2/oauth-clients/:oc_id", async ({ params: { oc_id }, body, user, orgId: tokenOrgId, set }) => {
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, oc_id) });
    if (!oc || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof oauthClients.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (typeof attributes["service-provider"] === "string") updates.serviceProvider = attributes["service-provider"];
    if (attributes["api-url"] !== undefined) updates.apiUrl = attributes["api-url"];
    if (attributes["http-url"] !== undefined) updates.httpUrl = attributes["http-url"];
    if (attributes.key !== undefined) updates.key = attributes.key;
    if (attributes.secret !== undefined) updates.secret = attributes.secret;
    if (attributes["rsa-public-key"] !== undefined) updates.rsaPublicKey = attributes["rsa-public-key"];

    if (Object.keys(updates).length > 0) {
      await db.update(oauthClients).set(updates).where(eq(oauthClients.id, oc_id));
    }
    const updated = (await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, oc_id) }))!;
    return {
      data: {
        id: updated.id,
        type: "oauth-clients",
        attributes: {
          name: updated.name,
          "service-provider": updated.serviceProvider,
          "api-url": updated.apiUrl,
          "http-url": updated.httpUrl,
          "rsa-public-key": updated.rsaPublicKey,
        },
      },
    };
  }, { isAuth: true })

  .delete("/api/v2/oauth-clients/:oc_id", async ({ params: { oc_id }, user, orgId: tokenOrgId, set }) => {
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, oc_id) });
    if (!oc || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(oauthClients).where(eq(oauthClients.id, oc_id));
    set.status = 204;
    return;
  }, { isAuth: true })

  .get("/api/v2/oauth-clients/:oc_id/oauth-tokens", async ({ params: { oc_id }, user, orgId: tokenOrgId, set }) => {
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, oc_id) });
    if (!oc || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const tokenList = await db.query.oauthTokens.findMany({ where: eq(oauthTokens.oauthClientId, oc_id) });
    const data = tokenList.map(ot => ({
      id: ot.id,
      type: "oauth-tokens",
      attributes: {
        "service-provider-user": ot.serviceProviderUser,
        "has-ssh-key": ot.hasSshKey,
        "created-at": new Date(ot.createdAt).toISOString(),
      },
    }));
    return { data };
  }, { isAuth: true })

  .get("/api/v2/oauth-tokens/:ot_id", async ({ params: { ot_id }, user, orgId: tokenOrgId, set }) => {
    const ot = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, ot_id) });
    if (!ot) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ot.oauthClientId) });
    if (!oc || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: ot.id,
        type: "oauth-tokens",
        attributes: {
          "service-provider-user": ot.serviceProviderUser,
          "has-ssh-key": ot.hasSshKey,
          "created-at": new Date(ot.createdAt).toISOString(),
        },
      },
    };
  }, { isAuth: true })

  .delete("/api/v2/oauth-tokens/:ot_id", async ({ params: { ot_id }, user, orgId: tokenOrgId, set }) => {
    const ot = await db.query.oauthTokens.findFirst({ where: eq(oauthTokens.id, ot_id) });
    if (!ot) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const oc = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, ot.oauthClientId) });
    if (!oc || !(await checkOrgPermission(user?.id, oc.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(oauthTokens).where(eq(oauthTokens.id, ot_id));
    set.status = 204;
    return;
  }, { isAuth: true })

  // --- POLICY SETS & POLICIES API (SENTINEL / OPA) ---
  .get("/api/v2/organizations/:org_name/policy-sets", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const psList = await db.query.policySets.findMany({ where: eq(policySets.orgId, org.id) });
    const data = psList.map(ps => ({
      id: ps.id,
      type: "policy-sets",
      attributes: {
        name: ps.name,
        description: ps.description,
        kind: ps.kind,
        global: ps.global,
        overridable: ps.overridable,
      },
    }));
    return { data };
  }, { isAuth: true })

  .post("/api/v2/organizations/:org_name/policy-sets", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name || typeof attributes.name !== "string") {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] };
    }
    const id = `polset-${crypto.randomUUID()}`;
    const newPs = {
      id,
      orgId: org.id,
      name: attributes.name,
      description: attributes.description ?? null,
      kind: attributes.kind ?? "sentinel",
      global: attributes.global ?? false,
      overridable: attributes.overridable ?? true,
      createdAt: Date.now(),
    };
    await db.insert(policySets).values(newPs);
    set.status = 201;
    return {
      data: {
        id,
        type: "policy-sets",
        attributes: {
          name: newPs.name,
          description: newPs.description,
          kind: newPs.kind,
          global: newPs.global,
          overridable: newPs.overridable,
        },
      },
    };
  }, { isAuth: true })

  .get("/api/v2/policy-sets/:policy_set_id", async ({ params: { policy_set_id }, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: ps.id,
        type: "policy-sets",
        attributes: {
          name: ps.name,
          description: ps.description,
          kind: ps.kind,
          global: ps.global,
          overridable: ps.overridable,
        },
      },
    };
  }, { isAuth: true })

  .patch("/api/v2/policy-sets/:policy_set_id", async ({ params: { policy_set_id }, body, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof policySets.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = attributes.description;
    if (typeof attributes.kind === "string") updates.kind = attributes.kind;
    if (typeof attributes.global === "boolean") updates.global = attributes.global;
    if (typeof attributes.overridable === "boolean") updates.overridable = attributes.overridable;

    if (Object.keys(updates).length > 0) {
      await db.update(policySets).set(updates).where(eq(policySets.id, policy_set_id));
    }
    const updated = (await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) }))!;
    return {
      data: {
        id: updated.id,
        type: "policy-sets",
        attributes: {
          name: updated.name,
          description: updated.description,
          kind: updated.kind,
          global: updated.global,
          overridable: updated.overridable,
        },
      },
    };
  }, { isAuth: true })

  .delete("/api/v2/policy-sets/:policy_set_id", async ({ params: { policy_set_id }, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(policySets).where(eq(policySets.id, policy_set_id));
    set.status = 204;
    return;
  }, { isAuth: true })

  .post("/api/v2/policy-sets/:policy_set_id/relationships/workspaces", async ({ params: { policy_set_id }, body, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const wsItems = (body as any)?.data;
    if (Array.isArray(wsItems)) {
      for (const item of wsItems) {
        if (item?.id) {
          const id = `psw-${crypto.randomUUID()}`;
          await db.insert(policySetWorkspaces).values({ id, policySetId: policy_set_id, workspaceId: item.id }).onConflictDoNothing();
        }
      }
    }
    set.status = 204;
    return;
  }, { isAuth: true })

  .delete("/api/v2/policy-sets/:policy_set_id/relationships/workspaces", async ({ params: { policy_set_id }, body, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const wsItems = (body as any)?.data;
    if (Array.isArray(wsItems)) {
      const wsIds = wsItems.map(i => i.id).filter(Boolean);
      if (wsIds.length > 0) {
        await db.delete(policySetWorkspaces).where(and(eq(policySetWorkspaces.policySetId, policy_set_id), inArray(policySetWorkspaces.workspaceId, wsIds)));
      }
    }
    set.status = 204;
    return;
  }, { isAuth: true })

  .get("/api/v2/policy-sets/:policy_set_id/policies", async ({ params: { policy_set_id }, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const polList = await db.query.policies.findMany({ where: eq(policies.policySetId, policy_set_id) });
    const data = polList.map(p => ({
      id: p.id,
      type: "policies",
      attributes: {
        name: p.name,
        description: p.description,
        "enforcement-level": p.enforcementLevel,
        query: p.query,
      },
    }));
    return { data };
  }, { isAuth: true })

  .post("/api/v2/policy-sets/:policy_set_id/policies", async ({ params: { policy_set_id }, body, user, orgId: tokenOrgId, set }) => {
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, policy_set_id) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name || typeof attributes.name !== "string") {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] };
    }
    const id = `pol-${crypto.randomUUID()}`;
    const newPol = {
      id,
      policySetId: policy_set_id,
      name: attributes.name,
      description: attributes.description ?? null,
      enforcementLevel: attributes["enforcement-level"] ?? "soft-mandatory",
      query: attributes.query ?? null,
      createdAt: Date.now(),
    };
    await db.insert(policies).values(newPol);
    set.status = 201;
    return {
      data: {
        id,
        type: "policies",
        attributes: {
          name: newPol.name,
          description: newPol.description,
          "enforcement-level": newPol.enforcementLevel,
          query: newPol.query,
        },
      },
    };
  }, { isAuth: true })

  .get("/api/v2/policies/:policy_id", async ({ params: { policy_id }, user, orgId: tokenOrgId, set }) => {
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policy_id) });
    if (!pol) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: pol.id,
        type: "policies",
        attributes: {
          name: pol.name,
          description: pol.description,
          "enforcement-level": pol.enforcementLevel,
          query: pol.query,
        },
      },
    };
  }, { isAuth: true })

  .patch("/api/v2/policies/:policy_id", async ({ params: { policy_id }, body, user, orgId: tokenOrgId, set }) => {
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policy_id) });
    if (!pol) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof policies.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (attributes.description !== undefined) updates.description = attributes.description;
    if (typeof attributes["enforcement-level"] === "string") updates.enforcementLevel = attributes["enforcement-level"];
    if (attributes.query !== undefined) updates.query = attributes.query;

    if (Object.keys(updates).length > 0) {
      await db.update(policies).set(updates).where(eq(policies.id, policy_id));
    }
    const updated = (await db.query.policies.findFirst({ where: eq(policies.id, policy_id) }))!;
    return {
      data: {
        id: updated.id,
        type: "policies",
        attributes: {
          name: updated.name,
          description: updated.description,
          "enforcement-level": updated.enforcementLevel,
          query: updated.query,
        },
      },
    };
  }, { isAuth: true })

  .delete("/api/v2/policies/:policy_id", async ({ params: { policy_id }, user, orgId: tokenOrgId, set }) => {
    const pol = await db.query.policies.findFirst({ where: eq(policies.id, policy_id) });
    if (!pol) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ps = await db.query.policySets.findFirst({ where: eq(policySets.id, pol.policySetId) });
    if (!ps || !(await checkOrgPermission(user?.id, ps.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(policies).where(eq(policies.id, policy_id));
    set.status = 204;
    return;
  }, { isAuth: true })

  .get("/api/v2/runs/:run_id/policy-checks", async ({ params: { run_id }, user, orgId: tokenOrgId, set }) => {
    const pcList = await db.query.policyChecks.findMany({ where: eq(policyChecks.runId, run_id) });
    const data = pcList.map(pc => ({
      id: pc.id,
      type: "policy-checks",
      attributes: {
        status: pc.status,
        result: pc.result,
        "created-at": new Date(pc.createdAt).toISOString(),
      },
    }));
    return { data };
  }, { isAuth: true })

  .get("/api/v2/policy-checks/:check_id", async ({ params: { check_id }, user, orgId: tokenOrgId, set }) => {
    const pc = await db.query.policyChecks.findFirst({ where: eq(policyChecks.id, check_id) });
    if (!pc) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: pc.id,
        type: "policy-checks",
        attributes: {
          status: pc.status,
          result: pc.result,
          "created-at": new Date(pc.createdAt).toISOString(),
        },
      },
    };
  }, { isAuth: true })

  .post("/api/v2/policy-checks/:check_id/actions/override", async ({ params: { check_id }, user, orgId: tokenOrgId, set }) => {
    const pc = await db.query.policyChecks.findFirst({ where: eq(policyChecks.id, check_id) });
    if (!pc) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.update(policyChecks).set({ status: "overridden" }).where(eq(policyChecks.id, check_id));
    return {
      data: {
        id: pc.id,
        type: "policy-checks",
        attributes: {
          status: "overridden",
          result: pc.result,
        },
      },
    };
  }, { isAuth: true })

  // --- MODULE REGISTRY PROTOCOL (Standard Terraform Registry Protocol) ---
  .get("/api/registry/v1/modules/:namespace/:name/:provider/versions", async ({ params: { namespace, name, provider }, set }) => {
    const mod = await db.query.registryModules.findFirst({
      where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name), eq(registryModules.provider, provider)),
    });
    if (!mod) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const verList = await db.query.registryModuleVersions.findMany({ where: eq(registryModuleVersions.moduleId, mod.id) });
    return {
      modules: [
        {
          versions: verList.map(v => ({ version: v.version })),
        },
      ],
    };
  })

  .get("/api/registry/v1/modules/:namespace/:name/:provider/:version", async ({ params: { namespace, name, provider, version }, set }) => {
    const mod = await db.query.registryModules.findFirst({
      where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name), eq(registryModules.provider, provider)),
    });
    if (!mod) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ver = await db.query.registryModuleVersions.findFirst({
      where: and(eq(registryModuleVersions.moduleId, mod.id), eq(registryModuleVersions.version, version)),
    });
    if (!ver) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      id: `${namespace}/${name}/${provider}/${version}`,
      owner: namespace,
      namespace,
      name,
      provider,
      version: ver.version,
      status: ver.status,
      download_url: `/api/registry/v1/modules/${namespace}/${name}/${provider}/${version}/download`,
    };
  })

  .get("/api/registry/v1/modules/:namespace/:name/:provider/:version/download", async ({ params: { namespace, name, provider, version }, set }) => {
    const mod = await db.query.registryModules.findFirst({
      where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name), eq(registryModules.provider, provider)),
    });
    if (!mod) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ver = await db.query.registryModuleVersions.findFirst({
      where: and(eq(registryModuleVersions.moduleId, mod.id), eq(registryModuleVersions.version, version)),
    });
    if (!ver) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    set.headers["X-Terraform-Get"] = `/api/registry/v1/modules/${namespace}/${name}/${provider}/${version}/archive`;
    set.status = 204;
    return;
  })

  // --- MODULE REGISTRY: additional protocol endpoints ---
  .get("/api/registry/v1/modules/:namespace/:name", async ({ params: { namespace, name }, set }) => {
    const mods = await db.query.registryModules.findMany({
      where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name)),
    });
    if (mods.length === 0) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      modules: mods.map(m => ({
        id: `${namespace}/${name}/${m.provider}`,
        owner: namespace,
        namespace,
        name,
        provider: m.provider,
        versions: [],
      })),
    };
  })

  .get("/api/registry/v1/modules/:namespace/:name/:provider", async ({ params: { namespace, name, provider }, set }) => {
    const mod = await db.query.registryModules.findFirst({
      where: and(eq(registryModules.namespace, namespace), eq(registryModules.name, name), eq(registryModules.provider, provider)),
    });
    if (!mod) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const verList = await db.query.registryModuleVersions.findMany({
      where: eq(registryModuleVersions.moduleId, mod.id),
      orderBy: [desc(registryModuleVersions.createdAt)],
    });
    const latestVersion = verList[0]?.version || "0.0.0";
    return {
      id: `${namespace}/${name}/${provider}/${latestVersion}`,
      owner: namespace,
      namespace,
      name,
      provider,
      version: latestVersion,
      status: verList[0]?.status || "pending",
      versions: verList.map(v => ({ version: v.version })),
    };
  })

  .get("/api/registry/v1/modules/:namespace", async ({ params: { namespace }, query, set }) => {
    const mods = await db.query.registryModules.findMany({ where: eq(registryModules.namespace, namespace) });
    return {
      modules: await Promise.all(mods.map(async m => {
        const verList = await db.query.registryModuleVersions.findMany({
          where: eq(registryModuleVersions.moduleId, m.id),
          orderBy: [desc(registryModuleVersions.createdAt)],
        });
        return {
          id: `${m.namespace}/${m.name}/${m.provider}`,
          owner: m.namespace,
          namespace: m.namespace,
          name: m.name,
          provider: m.provider,
          version: verList[0]?.version || null,
          versions: verList.map(v => ({ version: v.version })),
        };
      })),
    };
  })

  .get("/api/registry/v1/modules", async ({ query, set }) => {
    const searchQuery = ((query as any)?.q || "").trim();
    let mods: (typeof registryModules.$inferSelect)[];
    if (searchQuery) {
      mods = await db.query.registryModules.findMany({
        where: or(
          like(registryModules.name, `%${searchQuery}%`),
          like(registryModules.namespace, `%${searchQuery}%`),
          like(registryModules.provider, `%${searchQuery}%`),
        ),
        limit: 50,
      });
    } else {
      mods = await db.query.registryModules.findMany({ limit: 50 });
    }
    return {
      modules: await Promise.all(mods.map(async m => {
        const verList = await db.query.registryModuleVersions.findMany({
          where: eq(registryModuleVersions.moduleId, m.id),
          orderBy: [desc(registryModuleVersions.createdAt)],
        });
        return {
          id: `${m.namespace}/${m.name}/${m.provider}`,
          owner: m.namespace,
          namespace: m.namespace,
          name: m.name,
          provider: m.provider,
          version: verList[0]?.version || null,
          versions: verList.map(v => ({ version: v.version })),
        };
      })),
    };
  })

  // --- MODULE MANAGEMENT API (TFE v2 API) ---
  .get("/api/v2/organizations/:org_name/registry-modules", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const modList = await db.query.registryModules.findMany({ where: eq(registryModules.orgId, org.id) });
    const data = modList.map(m => ({
      id: m.id,
      type: "registry-modules",
      attributes: {
        name: m.name,
        provider: m.provider,
        namespace: m.namespace,
        "created-at": new Date(m.createdAt).toISOString(),
      },
    }));
    return { data };
  }, { isAuth: true })

  .post("/api/v2/organizations/:org_name/registry-modules", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name || !attributes.provider) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name and provider are required" }] };
    }
    const id = `mod-${crypto.randomUUID()}`;
    const namespace = attributes.namespace ?? org.name;
    const newMod = {
      id,
      orgId: org.id,
      namespace,
      name: attributes.name,
      provider: attributes.provider,
      createdAt: Date.now(),
    };
    await db.insert(registryModules).values(newMod);
    set.status = 201;
    return {
      data: {
        id,
        type: "registry-modules",
        attributes: {
          name: newMod.name,
          provider: newMod.provider,
          namespace: newMod.namespace,
          "created-at": new Date(newMod.createdAt).toISOString(),
        },
      },
    };
  }, { isAuth: true })

  .delete("/api/v2/registry-modules/:module_id", async ({ params: { module_id }, user, orgId: tokenOrgId, set }) => {
    const mod = await db.query.registryModules.findFirst({ where: eq(registryModules.id, module_id) });
    if (!mod || !(await checkOrgPermission(user?.id, mod.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(registryModules).where(eq(registryModules.id, module_id));
    set.status = 204;
    return;
  }, { isAuth: true })

  // --- PROVIDER REGISTRY PROTOCOL (Standard Terraform Registry Protocol) ---
  .get("/api/registry/v1/providers/-/versions", async ({ query, set }) => {
    const searchQuery = ((query as any)?.q || "").trim();
    let provs: (typeof registryProviders.$inferSelect)[];
    if (searchQuery) {
      provs = await db.query.registryProviders.findMany({
        where: or(
          like(registryProviders.namespace, `%${searchQuery}%`),
          like(registryProviders.type, `%${searchQuery}%`),
        ),
        limit: 50,
      });
    } else {
      provs = await db.query.registryProviders.findMany({ limit: 50 });
    }
    const versions = await Promise.all(provs.map(async p => {
      const verList = await db.query.registryProviderVersions.findMany({
        where: eq(registryProviderVersions.providerId, p.id),
        orderBy: [desc(registryProviderVersions.createdAt)],
      });
      return {
        id: `${p.namespace}/${p.type}`,
        namespace: p.namespace,
        versions: verList.map(v => ({
          version: v.version,
          protocols: v.protocols ?? ["5.0"],
          platforms: [],
        })),
      };
    }));
    return { versions };
  })

  .get("/api/registry/v1/providers/:namespace/:type/versions", async ({ params: { namespace, type }, set }) => {
    const prov = await db.query.registryProviders.findFirst({
      where: and(eq(registryProviders.namespace, namespace), eq(registryProviders.type, type)),
    });
    if (!prov) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const verList = await db.query.registryProviderVersions.findMany({ where: eq(registryProviderVersions.providerId, prov.id) });
    const versions = await Promise.all(verList.map(async (v) => {
      const platList = await db.query.registryProviderPlatforms.findMany({ where: eq(registryProviderPlatforms.versionId, v.id) });
      return {
        version: v.version,
        protocols: v.protocols ?? ["5.0"],
        platforms: platList.map(p => ({ os: p.os, arch: p.arch })),
      };
    }));
    return { versions };
  })

  .get("/api/registry/v1/providers/:namespace/:type/:version/download/:os/:arch", async ({ params: { namespace, type, version, os, arch }, set }) => {
    const prov = await db.query.registryProviders.findFirst({
      where: and(eq(registryProviders.namespace, namespace), eq(registryProviders.type, type)),
    });
    if (!prov) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const ver = await db.query.registryProviderVersions.findFirst({
      where: and(eq(registryProviderVersions.providerId, prov.id), eq(registryProviderVersions.version, version)),
    });
    if (!ver) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const plat = await db.query.registryProviderPlatforms.findFirst({
      where: and(eq(registryProviderPlatforms.versionId, ver.id), eq(registryProviderPlatforms.os, os), eq(registryProviderPlatforms.arch, arch)),
    });
    if (!plat) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      protocols: ver.protocols ?? ["5.0"],
      os: plat.os,
      arch: plat.arch,
      filename: plat.filename,
      download_url: plat.downloadUrl,
      shasum: plat.shasum,
    };
  })

  // --- PROVIDER MANAGEMENT API (TFE v2 API) ---
  .get("/api/v2/organizations/:org_name/registry-providers", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const provList = await db.query.registryProviders.findMany({ where: eq(registryProviders.orgId, org.id) });
    const data = provList.map(p => ({
      id: p.id,
      type: "registry-providers",
      attributes: {
        namespace: p.namespace,
        name: p.type,
        "registry-name": p.registryName,
        "created-at": new Date(p.createdAt).toISOString(),
      },
    }));
    return { data };
  }, { isAuth: true })

  .post("/api/v2/organizations/:org_name/registry-providers", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name (type) is required" }] };
    }
    const id = `prov-${crypto.randomUUID()}`;
    const namespace = attributes.namespace ?? org.name;
    const newProv = {
      id,
      orgId: org.id,
      namespace,
      type: attributes.name,
      registryName: attributes["registry-name"] ?? "private",
      createdAt: Date.now(),
    };
    await db.insert(registryProviders).values(newProv);
    set.status = 201;
    return {
      data: {
        id,
        type: "registry-providers",
        attributes: {
          namespace: newProv.namespace,
          name: newProv.type,
          "registry-name": newProv.registryName,
          "created-at": new Date(newProv.createdAt).toISOString(),
        },
      },
    };
  }, { isAuth: true })

  .delete("/api/v2/registry-providers/:provider_id", async ({ params: { provider_id }, user, orgId: tokenOrgId, set }) => {
    const prov = await db.query.registryProviders.findFirst({ where: eq(registryProviders.id, provider_id) });
    if (!prov || !(await checkOrgPermission(user?.id, prov.orgId, "member", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(registryProviders).where(eq(registryProviders.id, provider_id));
    set.status = 204;
    return;
  }, { isAuth: true })

  .post("/api/v2/runs/:run_id/actions/cancel", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const updated = await db.update(runs)
      .set({ status: "canceled" })
      .where(and(eq(runs.id, run_id), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"])))
      .returning();
    if (updated.length === 0) {
      set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not cancelable" }] };
    }
    return { data: { id: run_id, type: "runs", attributes: { status: "canceled" } } };
  }, { isAuth: true })
  .post("/api/v2/runs/:run_id/actions/force-cancel", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) {
        set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const updated = await db.update(runs)
      .set({ status: "force_canceled" })
      .where(and(eq(runs.id, run_id), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"])))
      .returning();
    if (updated.length === 0) {
      set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not force-cancelable" }] };
    }
    return { data: { id: run_id, type: "runs", attributes: { status: "force_canceled" } } };
  }, { isAuth: true })

  // --- ADMIN OPERATIONS API (TFE-Specific Site Admin) ---
  .get("/api/v2/admin/users", async ({ user, set }) => {
    if (!user || !user.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const allUsers = await db.query.users.findMany();
    const data = allUsers.map(u => ({
      id: u.id,
      type: "users",
      attributes: {
        username: u.username,
        email: u.email,
        "is-site-admin": true,
      },
    }));
    return { data };
  }, { isAuth: true })

  .get("/api/v2/admin/users/:user_id", async ({ params: { user_id }, user, set }) => {
    if (!user || !user.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, user_id) });
    if (!targetUser) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: targetUser.id,
        type: "users",
        attributes: {
          username: targetUser.username,
          email: targetUser.email,
          "is-site-admin": true,
        },
      },
    };
  }, { isAuth: true })

  .patch("/api/v2/admin/users/:user_id", async ({ params: { user_id }, body, user, set }) => {
    if (!user || !user.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, user_id) });
    if (!targetUser) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof users.$inferInsert> = {};
    if (typeof attributes.username === "string") updates.username = attributes.username;
    if (attributes.email !== undefined) updates.email = attributes.email;

    if (Object.keys(updates).length > 0) {
      await db.update(users).set(updates).where(eq(users.id, user_id));
    }
    const updated = (await db.query.users.findFirst({ where: eq(users.id, user_id) }))!;
    return {
      data: {
        id: updated.id,
        type: "users",
        attributes: {
          username: updated.username,
          email: updated.email,
          "is-site-admin": true,
        },
      },
    };
  }, { isAuth: true })

  .delete("/api/v2/admin/users/:user_id", async ({ params: { user_id }, user, set }) => {
    if (!user || !user.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, user_id) });
    if (!targetUser) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(users).where(eq(users.id, user_id));
    set.status = 204;
    return;
  }, { isAuth: true })

  .get("/api/v2/admin/organizations", async ({ user, set }) => {
    if (!user || !user.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const allOrgs = await db.query.organizations.findMany();
    const data = allOrgs.map(o => ({
      id: o.id,
      type: "organizations",
      attributes: {
        name: o.name,
        email: o.email,
      },
    }));
    return { data };
  }, { isAuth: true })

  .get("/api/v2/admin/organizations/:org_name", async ({ params: { org_name }, user, set }) => {
    if (!user || !user.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: org.id,
        type: "organizations",
        attributes: {
          name: org.name,
          email: org.email,
        },
      },
    };
  }, { isAuth: true })

  .delete("/api/v2/admin/organizations/:org_name", async ({ params: { org_name }, user, set }) => {
    if (!user || !user.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(organizations).where(eq(organizations.id, org.id));
    set.status = 204;
    return;
  }, { isAuth: true })

  .get("/api/v2/admin/workspaces", async ({ user, set }) => {
    if (!user || !user.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const allWs = await db.query.workspaces.findMany();
    const data = allWs.map(w => ({
      id: w.id,
      type: "workspaces",
      attributes: {
        name: w.name,
        "terraform-version": w.terraformVersion,
        locked: w.locked,
      },
    }));
    return { data };
  }, { isAuth: true })

  .get("/api/v2/admin/workspaces/:ws_id", async ({ params: { ws_id }, user, set }) => {
    if (!user || !user.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, ws_id) });
    if (!ws) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return {
      data: {
        id: ws.id,
        type: "workspaces",
        attributes: {
          name: ws.name,
          "terraform-version": ws.terraformVersion,
          locked: ws.locked,
        },
      },
    };
  }, { isAuth: true })

  .delete("/api/v2/admin/workspaces/:ws_id", async ({ params: { ws_id }, user, set }) => {
    if (!user || !user.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, ws_id) });
    if (!ws) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    await db.delete(workspaces).where(eq(workspaces.id, ws_id));
    set.status = 204;
    return;
  }, { isAuth: true })

  .get("/api/v2/admin/runs", async ({ user, set }) => {
    if (!user || !user.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const allRuns = await db.query.runs.findMany();
    const data = allRuns.map(r => ({
      id: r.id,
      type: "runs",
      attributes: {
        status: r.status,
        "created-at": new Date(r.createdAt).toISOString(),
      },
    }));
    return { data };
  }, { isAuth: true })

  .get("/api/v2/admin/runs/:run_id", async ({ params: { run_id }, user, set }) => {
    if (!user || !user.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, run_id) });
    if (!run) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: runResource(run, true) };
  }, { isAuth: true })

  .post("/api/v2/admin/runs/:run_id/actions/cancel", async ({ params: { run_id }, user, set }) => {
    if (!user || !user.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, run_id) });
    if (!run) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const updated = await db.update(runs)
      .set({ status: "canceled" })
      .where(and(eq(runs.id, run_id), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"])))
      .returning();
    if (updated.length === 0) {
      set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not cancelable" }] };
    }
    return { data: runResource(updated[0], true) };
  }, { isAuth: true })

  .post("/api/v2/admin/runs/:run_id/actions/force-cancel", async ({ params: { run_id }, user, set }) => {
    if (!user || !user.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, run_id) });
    if (!run) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const updated = await db.update(runs)
      .set({ status: "force_canceled" })
      .where(and(eq(runs.id, run_id), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"])))
      .returning();
    if (updated.length === 0) {
      set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not force-cancelable" }] };
    }
    return { data: runResource(updated[0], true) };
  }, { isAuth: true })

  .get("/api/v2/admin/terraform-versions", async ({ user, set }) => {
    if (!user || !user.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    return {
      data: [
        { id: "1.10.5", type: "terraform-versions", attributes: { version: "1.10.5", default: true, deprecated: false } },
        { id: "1.9.8", type: "terraform-versions", attributes: { version: "1.9.8", default: false, deprecated: false } },
        { id: "1.8.5", type: "terraform-versions", attributes: { version: "1.8.5", default: false, deprecated: false } },
      ],
    };
  }, { isAuth: true })

  // --- WORKSPACE RUN TRIGGERS API ---
  .get("/api/v2/workspaces/:workspace_id/run-triggers", async ({ params: { workspace_id }, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "read", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const triggers = await db.query.runTriggers.findMany({ where: eq(runTriggers.workspaceId, workspace_id) });
    const data = triggers.map(t => ({
      id: t.id,
      type: "run-triggers",
      attributes: {
        "created-at": new Date(t.createdAt).toISOString(),
      },
      relationships: {
        "sourceable-workspace": {
          data: { id: t.sourceWorkspaceId, type: "workspaces" },
        },
      },
    }));
    return { data };
  }, { isAuth: true })

  .post("/api/v2/workspaces/:workspace_id/relationships/run-triggers", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "read", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const items = (body as any)?.data;
    if (Array.isArray(items)) {
      for (const item of items) {
        const srcId = item?.id ?? item?.attributes?.["source-workspace-id"];
        if (srcId) {
          const id = `rt-${crypto.randomUUID()}`;
          await db.insert(runTriggers).values({ id, workspaceId: workspace_id, sourceWorkspaceId: srcId }).onConflictDoNothing();
        }
      }
    }
    set.status = 204;
    return;
  }, { isAuth: true })

  .delete("/api/v2/workspaces/:workspace_id/relationships/run-triggers", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace_id) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "read", tokenOrgId))) {
      set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const items = (body as any)?.data;
    if (Array.isArray(items)) {
      const srcIds = items.map(i => i.id).filter(Boolean);
      if (srcIds.length > 0) {
        await db.delete(runTriggers).where(and(eq(runTriggers.workspaceId, workspace_id), inArray(runTriggers.sourceWorkspaceId, srcIds)));
      }
    }
    set.status = 204;
    return;
  }, { isAuth: true })

  // --- AUDIT TRAILS API ---
  .get("/api/v2/organization-audit-trailers", async ({ user, set }) => {
    if (!user) { set.status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    return { data: [] };
  }, { isAuth: true })

  .get("/api/v2/audit-trails", async ({ user, set }) => {
    if (!user) { set.status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] }; }
    return { data: [] };
  }, { isAuth: true })

  // --- COST ESTIMATION API ---
  .get("/api/v2/runs/:run_id/cost-estimate", async ({ params: { run_id }, user, orgId, set }) => {
    const run = await findAuthorizedRun(run_id, user?.id, orgId);
    if (!run) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return {
      data: {
        id: `ce-${run_id}`,
        type: "cost-estimates",
        attributes: {
          status: "finished",
          "delta-monthly-cost": "0.0",
          "prior-monthly-cost": "0.0",
          "proposed-monthly-cost": "0.0",
        },
      },
    };
  }, { isAuth: true });
