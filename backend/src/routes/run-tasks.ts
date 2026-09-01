import { Elysia } from "elysia";
import { db } from "../db";
import { envEnabled } from "../lib/env";
import {
  runTasks,
  workspaceRunTasks,
  runTaskResults,
  taskStages,
  type users,
  type workspaces,
} from "../db/schema";
import { eq, and, inArray, or, asc, count } from "drizzle-orm";
import { checkOrganizationPermission, findAuthorizedRun, findAuthorizedWorkspace, pageRequest, pagination, validSignedApiURL } from "../lib/utils";
import { authPlugin } from "../auth";
import { organizationName } from "../lib/response";
import { cachedOrgByName } from "../lib/cached-lookups";
import { encryptSecret } from "../lib/secrets";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  request: Readonly<{ url: string }>;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  set: SetObj;
}>;

type BindingItem = Readonly<{
  readonly id: string;
  readonly stage: string;
  readonly enforcementLevel: string;
  readonly runTaskId: string;
}>;

type ResultItem = Readonly<typeof runTaskResults.$inferSelect>;

async function findManageableWorkspace(
  workspaceId: string,
  userId: string | undefined,
  tokenOrgId: string | null,
  tokenTeamId: string | null,
): Promise<typeof workspaces.$inferSelect | undefined> {
  const workspace = await findAuthorizedWorkspace(
    workspaceId,
    userId,
    tokenOrgId,
    tokenTeamId,
    "run-tasks",
  );
  if (workspace === undefined) return undefined;
  return await checkOrganizationPermission(
    workspace.orgId,
    userId,
    tokenOrgId,
    tokenTeamId,
    "manage-run-tasks",
  ) ? workspace : undefined;
}

type CallbackCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  request: Readonly<{ url: string }>;
  set: SetObj;
}>;

function taskResultResource(result: ResultItem): Record<string, unknown> {
  return {
    id: result.id,
    type: "task-results",
    attributes: {
      status: result.status,
      message: result.message,
      url: result.url,
      "created-at": new Date(result.createdAt).toISOString(),
    },
    relationships: {
      run: { data: { id: result.runId, type: "runs" } },
      task: { data: { id: result.runTaskId, type: "run-tasks" } },
    },
  };
}

type RunTaskRow = typeof runTasks.$inferSelect;

type GlobalConfig = { enabled: boolean; stages: string[]; enforcementLevel: string };

// go-tfe serializes the run-task "global-configuration" object with the
// kebab-case "enforcement-level" key (see GlobalRunTask jsonapi tags).
function apiGlobalConfig(value: GlobalConfig | null | undefined): Record<string, unknown> {
  // go-tfe treats a missing "global-configuration" as a nil *GlobalRunTask,
  // so a nil/absent value is serialized as the default empty object rather
  // than null to keep the provider's task.Global non-nil.
  const v = value ?? { enabled: false, stages: [], enforcementLevel: "advisory" };
  return { enabled: v.enabled, stages: [...v.stages], "enforcement-level": v.enforcementLevel };
}

function parseGlobalConfig(value: unknown): GlobalConfig | null {
  if (value === null || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : true,
    stages: Array.isArray(o.stages) ? o.stages.filter((s: unknown): s is string => typeof s === "string") : [],
    enforcementLevel: typeof o["enforcement-level"] === "string"
      ? o["enforcement-level"]
      : (typeof o.enforcementLevel === "string" ? o.enforcementLevel : "advisory"),
  };
}

function globalRunTaskUrlError(url: string, configuration: GlobalConfig | null | undefined, taskEnabled = true): string | undefined {
  if (configuration?.enabled !== true || taskEnabled !== true || envEnabled(process.env.TERRENCE_ALLOW_INSECURE_RUN_TASK_URLS)) return undefined;
  try {
    return new URL(url).protocol === "https:"
      ? undefined
      : "Enabled organization-global run tasks require an HTTPS URL";
  } catch {
    return undefined;
  }
}

const runTaskResource = async (t: RunTaskRow, orgNameOverride?: string | null): Promise<Record<string, unknown>> => {
  const orgName = orgNameOverride !== undefined ? orgNameOverride : await organizationName(t.orgId);
  return {
    id: t.id,
    // the reference format's JSON:API type for an organization run task is "tasks" (go-tfe
    // v1.109's RunTask unmarshal rejects "run-tasks").
    type: "tasks",
    attributes: {
      name: t.name,
      description: t.description,
      url: t.url,
      category: t.category,
      enabled: t.enabled,
      "hmac-key": null,
      "global-configuration": apiGlobalConfig(t.globalConfiguration),
    },
    relationships: {
      // go-tfe requires the organization relationship — the framework
      // resource dereferences RunTask.Organization.Name.
      organization: { data: { id: orgName ?? t.orgId, type: "organizations" } },
    },
  };
};

// The org/workspace run-task handlers are registered under BOTH the /run-tasks
// paths (previous Terrence routes) and the reference-canonical /tasks paths —
// go-tfe's RunTasks service (used by the framework tfe_organization_run_task /
// tfe_workspace_run_task resources) calls /organizations/:org/tasks and
// /workspaces/:ws/tasks.
const listOrgRunTasks = async ({ params, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
  const orgName = params.org_name ?? "";
  const org = await cachedOrgByName(orgName);
  if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-run-tasks"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  const tasksList = await db.query.runTasks.findMany({
    where: eq(runTasks.orgId, org.id),
    orderBy: [asc(runTasks.id)],
  });
  const page = pageRequest(request);
  const pageTasks = tasksList.slice((page.number - 1) * page.size, page.number * page.size);
  return {
    data: await Promise.all(pageTasks.map(async (t): Promise<Record<string, unknown>> => runTaskResource(t, org.name))),
    ...pagination(request, page.number, page.size, tasksList.length),
  };
};

const createOrgRunTask = async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
  const orgName = params.org_name ?? "";
  const org = await cachedOrgByName(orgName);
  if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-run-tasks"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = payload.data as Record<string, unknown> | undefined;
  const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
  const name = typeof attrs.name === "string" ? attrs.name : "";
  const url = typeof attrs.url === "string" ? attrs.url : "";
  if (name === "" || url === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
  const id = `task-${crypto.randomUUID()}`;
  const description = typeof attrs.description === "string" ? attrs.description : null;
  const category = typeof attrs.category === "string" && attrs.category.trim() !== "" ? attrs.category : "general";
  const enabled = typeof attrs.enabled === "boolean" ? attrs.enabled : true;
  const hmacKey = typeof attrs["hmac-key"] === "string" && attrs["hmac-key"] !== ""
    ? await encryptSecret(attrs["hmac-key"], { force: true })
    : null;
  const globalConfiguration = parseGlobalConfig(attrs["global-configuration"]);
  const globalUrlError = globalRunTaskUrlError(url, globalConfiguration, enabled);
  if (globalUrlError !== undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: globalUrlError }] }; }
  const rowData = { id, orgId: org.id, name, description, url, category, enabled, hmacKey, globalConfiguration, createdAt: Date.now() };
  await db.insert(runTasks).values(rowData);
  (set as { status: number }).status = 201;
  return { data: await runTaskResource(rowData) };
};

const getRunTask = async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
  const taskId = params.task_id ?? "";
  const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
  if (task === undefined || !(await checkOrganizationPermission(task.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-run-tasks"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  return { data: await runTaskResource(task) };
};

const updateRunTask = async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
  const taskId = params.task_id ?? "";
  const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
  if (task === undefined || !(await checkOrganizationPermission(task.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-run-tasks"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = payload.data as Record<string, unknown> | undefined;
  const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
  const updates: Partial<typeof runTasks.$inferInsert> = {};
  if (typeof attrs.name === "string") {
    if (attrs.name.trim() === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name is required" }] }; }
    updates.name = attrs.name.trim();
  }
  if (attrs.description !== undefined) updates.description = typeof attrs.description === "string" ? attrs.description : null;
  if (typeof attrs.url === "string") {
    if (attrs.url.trim() === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "URL is required" }] }; }
    updates.url = attrs.url.trim();
  }
  if (typeof attrs.category === "string" && attrs.category.trim() !== "") updates.category = attrs.category;
  if (attrs["hmac-key"] !== undefined) {
    updates.hmacKey = typeof attrs["hmac-key"] === "string" && attrs["hmac-key"] !== ""
      ? await encryptSecret(attrs["hmac-key"], { force: true })
      : null;
  }
  if (typeof attrs.enabled === "boolean") updates.enabled = attrs.enabled;
  if (attrs["global-configuration"] !== undefined) {
    updates.globalConfiguration = parseGlobalConfig(attrs["global-configuration"]);
  }
  const nextGlobalConfiguration = updates.globalConfiguration !== undefined ? updates.globalConfiguration : task.globalConfiguration;
  const nextEnabled = updates.enabled !== undefined ? updates.enabled === true : task.enabled === true;
  const globalUrlError = globalRunTaskUrlError(updates.url ?? task.url, nextGlobalConfiguration, nextEnabled);
  if (globalUrlError !== undefined) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: globalUrlError }] }; }
  if (Object.keys(updates).length > 0) await db.update(runTasks).set(updates).where(eq(runTasks.id, taskId));
  const updated = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
  if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  return { data: await runTaskResource(updated) };
};

const deleteRunTask = async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
  const taskId = params.task_id ?? "";
  const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
  if (task === undefined || !(await checkOrganizationPermission(task.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-run-tasks"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  await db.delete(runTasks).where(eq(runTasks.id, taskId));
  (set as { status: number }).status = 204;
  return {};
};

const listWorkspaceRunTasks = async ({ params, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
  const workspaceId = params.workspace_id ?? "";
  const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId, tokenTeamId ?? null);
  if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  const bindings = await db.query.workspaceRunTasks.findMany({
    where: eq(workspaceRunTasks.workspaceId, workspaceId),
    orderBy: [asc(workspaceRunTasks.id)],
  });
  const page = pageRequest(request);
  const pageBindings = bindings.slice((page.number - 1) * page.size, page.number * page.size);
  const attachedTasks = pageBindings.length === 0
    ? []
    : await db.query.runTasks.findMany({
        where: inArray(runTasks.id, pageBindings.map((binding: BindingItem): string => binding.runTaskId)),
      });
  const tasksById = new Map(attachedTasks.map((task): [string, typeof task] => [task.id, task]));
  return {
    data: pageBindings.map((binding: BindingItem): Record<string, unknown> => {
      const task = tasksById.get(binding.runTaskId);
      return {
        id: binding.id,
        type: "workspace-tasks",
        attributes: {
          stage: binding.stage,
          stages: [binding.stage],
          "enforcement-level": binding.enforcementLevel,
          "run-task-name": task?.name ?? binding.runTaskId,
          "run-task-description": task?.description ?? null,
          "run-task-enabled": task?.enabled ?? false,
        },
        relationships: {
          "task": { data: { id: binding.runTaskId, type: "tasks" } },
          workspace: { data: { id: workspaceId, type: "workspaces" } },
        },
      };
    }),
    ...pagination(request, page.number, page.size, bindings.length),
  };
};

const getWorkspaceRunTask = async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
  const workspaceId = params.workspace_id ?? "";
  const taskId = params.task_id ?? "";
  const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId, tokenTeamId ?? null);
  if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  const binding = await db.query.workspaceRunTasks.findFirst({
    where: and(
      eq(workspaceRunTasks.workspaceId, workspaceId),
      or(eq(workspaceRunTasks.id, taskId), eq(workspaceRunTasks.runTaskId, taskId)),
    ),
  });
  if (binding === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, binding.runTaskId) });
  return {
    data: {
      id: binding.id,
      type: "workspace-tasks",
      attributes: {
                stage: binding.stage,
                stages: [binding.stage],
                "enforcement-level": binding.enforcementLevel,
                "run-task-name": task?.name ?? binding.runTaskId,
                "run-task-description": task?.description ?? null,
                "run-task-enabled": task?.enabled ?? false,
              },
      relationships: {
        "task": { data: { id: binding.runTaskId, type: "tasks" } },
        workspace: { data: { id: workspaceId, type: "workspaces" } },
      },
    },
  };
};

const updateWorkspaceRunTask = async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
  const workspaceId = params.workspace_id ?? "";
  const taskId = params.task_id ?? "";
  // Mirrors the create handler: workspace run-tasks access AND org-level
  // task-management permission are both required to modify a binding.
  const ws = await findManageableWorkspace(workspaceId, user?.id, tokenOrgId, tokenTeamId ?? null);
  if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  const binding = await db.query.workspaceRunTasks.findFirst({
    where: and(
      eq(workspaceRunTasks.workspaceId, workspaceId),
      or(eq(workspaceRunTasks.id, taskId), eq(workspaceRunTasks.runTaskId, taskId)),
    ),
  });
  if (binding === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = payload.data as Record<string, unknown> | undefined;
  const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
  const updates: Partial<typeof workspaceRunTasks.$inferInsert> = {};
  if (typeof attrs["enforcement-level"] === "string") {
    const level = attrs["enforcement-level"];
    if (!["advisory", "mandatory", "must_pass"].includes(level)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "enforcement-level must be advisory, mandatory, or must_pass" }] };
    }
    updates.enforcementLevel = level;
  }
  const rawStages = attrs.stages;
  if (Array.isArray(rawStages) && (rawStages as unknown[]).some((s): boolean => typeof s !== "string")) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "stages must contain only strings" }] };
  }
  // The provider sends either a singular `stage` or the `stages` array; honor
  // whichever is present (single-stage binding, so >1 is rejected).
  const requestedStages = Array.isArray(rawStages)
    ? (rawStages as unknown[]).filter((s): s is string => typeof s === "string")
    : typeof attrs.stage === "string" && attrs.stage !== ""
      ? [attrs.stage]
      : [];
  if (requestedStages.length > 1) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "this binding stores a single stage; provide exactly one" }] };
  }
  if (requestedStages.length === 1) {
    const stage = requestedStages[0] ?? "";
    if (!["pre_plan", "post_plan", "pre_apply", "post_apply"].includes(stage)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "stage must be one of pre_plan, post_plan, pre_apply, post_apply" }] };
    }
    updates.stage = stage;
  }
  if (Object.keys(updates).length > 0) await db.update(workspaceRunTasks).set(updates).where(eq(workspaceRunTasks.id, binding.id));
  const updated = await db.query.workspaceRunTasks.findFirst({ where: eq(workspaceRunTasks.id, binding.id) });
  if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, updated.runTaskId) });
  return {
    data: {
      id: updated.id,
      type: "workspace-tasks",
      attributes: {
        stage: updated.stage,
        stages: [updated.stage],
        "enforcement-level": updated.enforcementLevel,
        "run-task-name": task?.name ?? updated.runTaskId,
        "run-task-description": task?.description ?? null,
        "run-task-enabled": task?.enabled ?? false,
      },
      relationships: {
        "task": { data: { id: updated.runTaskId, type: "tasks" } },
        workspace: { data: { id: workspaceId, type: "workspaces" } },
      },
    },
  };
};

const attachWorkspaceRunTask = async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
  const workspaceId = params.workspace_id ?? "";
  const ws = await findManageableWorkspace(workspaceId, user?.id, tokenOrgId, tokenTeamId ?? null);
  if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = payload.data as Record<string, unknown> | undefined;
  const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
  const { task: taskRelationship } = rels;
  const runTaskRel = typeof taskRelationship === "object" && taskRelationship !== null
    ? (taskRelationship as Record<string, unknown>)
    : typeof rels["run-task"] === "object" && rels["run-task"] !== null
      ? (rels["run-task"] as Record<string, unknown>)
      : {};
  const runTaskData = typeof runTaskRel.data === "object" && runTaskRel.data !== null ? (runTaskRel.data as Record<string, unknown>) : {};
  const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
  const taskId = typeof runTaskData.id === "string" ? runTaskData.id : (typeof attrs["run-task-id"] === "string" ? attrs["run-task-id"] : "");
  if (taskId === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
  const requestedStages = Array.isArray(attrs.stages) ? (attrs.stages as unknown[]).filter((s): s is string => typeof s === "string") : [];
  if (requestedStages.length > 1) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Only a single stage is supported" }] };
  }
  const stage = typeof attrs.stage === "string" && attrs.stage !== "" ? attrs.stage : (requestedStages[0] ?? "post_plan");
  const enforcementLevel = typeof attrs["enforcement-level"] === "string" && attrs["enforcement-level"] !== "" ? attrs["enforcement-level"] : "advisory";
  const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
  if (task?.orgId !== ws.orgId) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  if (!["pre_plan", "post_plan", "pre_apply", "post_apply"].includes(stage) || !["advisory", "mandatory", "must_pass"].includes(enforcementLevel)) {
    (set as { status: number }).status = 422;
    return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
  }
  const id = `wrt-${crypto.randomUUID()}`;
  await db.insert(workspaceRunTasks).values({ id, workspaceId, runTaskId: taskId, stage, enforcementLevel }).onConflictDoNothing();
  const persisted = await db.query.workspaceRunTasks.findFirst({
    where: and(eq(workspaceRunTasks.workspaceId, workspaceId), eq(workspaceRunTasks.runTaskId, taskId)),
  });
  if (persisted === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
  (set as { status: number }).status = 201;
  return { data: { id: persisted.id, type: "workspace-tasks", attributes: { stage: persisted.stage, stages: [persisted.stage], "enforcement-level": persisted.enforcementLevel }, relationships: { "task": { data: { id: taskId, type: "tasks" } }, workspace: { data: { id: workspaceId, type: "workspaces" } } } } };
};

const detachWorkspaceRunTask = async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
  const workspaceId = params.workspace_id ?? "";
  const taskId = params.task_id ?? "";
  const ws = await findManageableWorkspace(workspaceId, user?.id, tokenOrgId, tokenTeamId ?? null);
  if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  await db.delete(workspaceRunTasks).where(and(
    eq(workspaceRunTasks.workspaceId, workspaceId),
    or(eq(workspaceRunTasks.id, taskId), eq(workspaceRunTasks.runTaskId, taskId)),
  ));
  (set as { status: number }).status = 204;
  return {};
};

const overrideTaskStage = async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
  const stageId = params.task_stage_id ?? "";
  const stage = await db.query.taskStages.findFirst({ where: eq(taskStages.id, stageId) });
  if (stage === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  const authorized = await findAuthorizedRun(stage.runId, user?.id, tokenOrgId, tokenTeamId ?? null);
  if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
  if (!(await checkOrganizationPermission(authorized.workspace.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-run-tasks"))) {
    (set as { status: number }).status = 403;
    return { errors: [{ status: "403", title: "Forbidden" }] };
  }
  if (!["failed", "awaiting_override", "errored"].includes(stage.status)) {
    (set as { status: number }).status = 409;
    return { errors: [{ status: "409", title: "Conflict", detail: "Task stage cannot be overridden in current status" }] };
  }
  const timestamps = { ...(stage.statusTimestamps ?? {}), "overridden-at": new Date().toISOString() };
  const updated = await db.update(taskStages).set({ status: "passed", statusTimestamps: timestamps }).where(and(eq(taskStages.id, stage.id), eq(taskStages.status, stage.status))).returning({ id: taskStages.id });
  if (updated.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Task stage changed before it could be overridden" }] }; }
  return { data: { id: stage.id, type: "task-stages", attributes: { stage: stage.stage, status: "passed", "status-timestamps": timestamps } } };
};

export const runTaskRoutes = new Elysia({ name: "runTasks" })
  .patch("/api/v2/task-results/:task_result_id/callback", async ({ params, body, request, set }: CallbackCtx): Promise<unknown> => {
    const resultId = params.task_result_id ?? "";
    const path = `/api/v2/task-results/${resultId}/callback`;
    if (!validSignedApiURL(request, path, "PATCH")) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data;
    const dataObject = data !== null && typeof data === "object" ? data as Record<string, unknown> : {};
    const attributes = dataObject.attributes;
    const attrs = attributes !== null && typeof attributes === "object" ? attributes as Record<string, unknown> : {};
    const status = attrs.status;
    if (dataObject.type !== "task-results" || !["running", "passed", "failed"].includes(String(status))) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const result = await db.query.runTaskResults.findFirst({ where: eq(runTaskResults.id, resultId) });
    if (result === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (["passed", "failed"].includes(result.status) && status !== result.status) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict" }] };
    }
    await db.update(runTaskResults).set({
      status: String(status),
      ...(typeof attrs.message === "string" ? { message: attrs.message } : {}),
      ...(typeof attrs.url === "string" ? { url: attrs.url } : {}),
    }).where(eq(runTaskResults.id, resultId));
    (set as { status: number }).status = 200;
    return {};
  })
  .use(authPlugin)
  .get("/api/v2/runs/:run_id/run-tasks", async ({ params, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, tokenOrgId, tokenTeamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const where = eq(runTaskResults.runId, runId);
    const page = pageRequest(request);
    const [results, countRows] = await Promise.all([
      db.query.runTaskResults.findMany({ where, orderBy: [asc(runTaskResults.createdAt), asc(runTaskResults.id)], limit: page.size, offset: (page.number - 1) * page.size }),
      db.select({ total: count() }).from(runTaskResults).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: results.map(taskResultResource), ...pagination(request, page.number, page.size, totalCount) };
  })
  .get("/api/v2/run-tasks/:task_id/task-results", async ({ params, request, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const taskId = params.task_id ?? "";
    const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
    if (task === undefined || !(await checkOrganizationPermission(task.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-run-tasks"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const where = eq(runTaskResults.runTaskId, taskId);
    const page = pageRequest(request);
    const [results, countRows] = await Promise.all([
      db.query.runTaskResults.findMany({ where, orderBy: [asc(runTaskResults.createdAt), asc(runTaskResults.id)], limit: page.size, offset: (page.number - 1) * page.size }),
      db.select({ total: count() }).from(runTaskResults).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: results.map(taskResultResource), ...pagination(request, page.number, page.size, totalCount) };
  })
  .get("/api/v2/task-results/:task_result_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const result = await db.query.runTaskResults.findFirst({ where: eq(runTaskResults.id, params.task_result_id ?? "") });
    if (result === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const authorized = await findAuthorizedRun(result.runId, user?.id, tokenOrgId, tokenTeamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: taskResultResource(result) };
  })
  .get("/api/v2/runs/:run_id/task-stages", async ({ params, request, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, tokenOrgId, teamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const where = eq(taskStages.runId, runId);
    const page = pageRequest(request);
    const [stages, countRows] = await Promise.all([
      db.query.taskStages.findMany({ where, orderBy: [asc(taskStages.createdAt), asc(taskStages.id)], limit: page.size, offset: (page.number - 1) * page.size }),
      db.select({ total: count() }).from(taskStages).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return {
      data: stages.map((s): Record<string, unknown> => ({
        id: s.id,
        type: "task-stages",
        attributes: {
          stage: s.stage,
          status: s.status,
          "status-timestamps": s.statusTimestamps ?? {},
        },
        relationships: {
          run: { data: { id: s.runId, type: "runs" } },
        },
      })),
      ...pagination(request, page.number, page.size, totalCount),
    };
  })
  .get("/api/v2/task-stages/:task_stage_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const stageId = params.task_stage_id ?? "";
    const stage = await db.query.taskStages.findFirst({ where: eq(taskStages.id, stageId) });
    if (stage === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const authorized = await findAuthorizedRun(stage.runId, user?.id, tokenOrgId, tokenTeamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const results = await db.query.runTaskResults.findMany({ where: eq(runTaskResults.taskStageId, stage.id) });
    return {
      data: {
        id: stage.id,
        type: "task-stages",
        attributes: {
          stage: stage.stage,
          status: stage.status,
          "status-timestamps": stage.statusTimestamps ?? {},
        },
        relationships: {
          run: { data: { id: stage.runId, type: "runs" } },
          "task-results": {
            data: results.map((r): Record<string, string> => ({ id: r.id, type: "task-results" })),
          },
        },
      },
    };
  })
  .patch("/api/v2/task-stages/:task_stage_id/actions/override", overrideTaskStage)
  .post("/api/v2/task-stages/:task_stage_id/actions/override", overrideTaskStage)
  .get("/api/v2/organizations/:org_name/run-tasks", listOrgRunTasks)
  .get("/api/v2/organizations/:org_name/tasks", listOrgRunTasks)
  .post("/api/v2/organizations/:org_name/run-tasks", createOrgRunTask)
  .post("/api/v2/organizations/:org_name/tasks", createOrgRunTask)
  .get("/api/v2/run-tasks/:task_id", getRunTask)
  .get("/api/v2/tasks/:task_id", getRunTask)
  .patch("/api/v2/run-tasks/:task_id", updateRunTask)
  .patch("/api/v2/tasks/:task_id", updateRunTask)
  .delete("/api/v2/run-tasks/:task_id", deleteRunTask)
  .delete("/api/v2/tasks/:task_id", deleteRunTask)
  // --- Workspace Run Tasks ---
  .get("/api/v2/workspaces/:workspace_id/run-tasks", listWorkspaceRunTasks)
  .get("/api/v2/workspaces/:workspace_id/tasks", listWorkspaceRunTasks)
  .get("/api/v2/workspaces/:workspace_id/run-tasks/:task_id", getWorkspaceRunTask)
  .get("/api/v2/workspaces/:workspace_id/tasks/:task_id", getWorkspaceRunTask)
  .post("/api/v2/workspaces/:workspace_id/run-tasks", attachWorkspaceRunTask)
  .post("/api/v2/workspaces/:workspace_id/tasks", attachWorkspaceRunTask)
  .patch("/api/v2/workspaces/:workspace_id/run-tasks/:task_id", updateWorkspaceRunTask)
  .patch("/api/v2/workspaces/:workspace_id/tasks/:task_id", updateWorkspaceRunTask)
  .delete("/api/v2/workspaces/:workspace_id/run-tasks/:task_id", detachWorkspaceRunTask)
  .delete("/api/v2/workspaces/:workspace_id/tasks/:task_id", detachWorkspaceRunTask);
