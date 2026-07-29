import { Elysia } from "elysia";
import { db } from "../db";
import { runTasks, workspaceRunTasks, runTaskResults, taskStages, organizations, type users } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { checkOrganizationPermission, findAuthorizedRun, findAuthorizedWorkspace, validSignedApiURL } from "../lib/utils";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
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
  .get("/api/v2/runs/:run_id/run-tasks", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, tokenOrgId, tokenTeamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const results = await db.query.runTaskResults.findMany({ where: eq(runTaskResults.runId, runId) });
    return { data: results.map(taskResultResource) };
  })
  .get("/api/v2/run-tasks/:task_id/task-results", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const taskId = params.task_id ?? "";
    const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
    if (task === undefined || !(await checkOrganizationPermission(task.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-run-tasks"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const results = await db.query.runTaskResults.findMany({ where: eq(runTaskResults.runTaskId, taskId) });
    return { data: results.map(taskResultResource) };
  })
  .get("/api/v2/runs/:run_id/task-stages", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const runId = params.run_id ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, tokenOrgId, tokenTeamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const stages = await db.query.taskStages.findMany({ where: eq(taskStages.runId, runId) });
    return {
      data: stages.map((s) => ({
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
          "task-results": { data: results.map((r) => ({ id: r.id, type: "task-results" })) },
        },
      },
    };
  })
  .patch("/api/v2/task-stages/:task_stage_id/actions/override", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const stageId = params.task_stage_id ?? "";
    const stage = await db.query.taskStages.findFirst({ where: eq(taskStages.id, stageId) });
    if (stage === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const authorized = await findAuthorizedRun(stage.runId, user?.id, tokenOrgId, tokenTeamId ?? null);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!["failed", "awaiting_override", "errored"].includes(stage.status)) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Task stage cannot be overridden in current status" }] };
    }
    const timestamps = { ...((stage.statusTimestamps as Record<string, string>) ?? {}), "overridden-at": new Date().toISOString() };
    await db.update(taskStages).set({ status: "passed", statusTimestamps: timestamps }).where(eq(taskStages.id, stage.id));
    return {
      data: {
        id: stage.id,
        type: "task-stages",
        attributes: {
          stage: stage.stage,
          status: "passed",
          "status-timestamps": timestamps,
        },
      },
    };
  })
  .get("/api/v2/organizations/:org_name/run-tasks", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-run-tasks"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tasksList = await db.query.runTasks.findMany({ where: eq(runTasks.orgId, org.id) });
    return {
      data: tasksList.map((t) => ({
        id: t.id,
        type: "run-tasks",
        attributes: {
          name: t.name,
          description: t.description,
          url: t.url,
          category: t.category,
          enabled: t.enabled,
          "hmac-key": null,
          "global-configuration": t.globalConfiguration ?? null,
        },
      })),
    };
  })
  .post("/api/v2/organizations/:org_name/run-tasks", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
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
    const hmacKey = typeof attrs["hmac-key"] === "string" ? attrs["hmac-key"] : null;
    const globalConfiguration = attrs["global-configuration"] !== null && typeof attrs["global-configuration"] === "object"
      ? (attrs["global-configuration"] as { enabled: boolean; stages: string[]; enforcementLevel: string })
      : null;
    await db.insert(runTasks).values({ id, orgId: org.id, name, description, url, category, enabled, hmacKey, globalConfiguration, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return {
      data: {
        id,
        type: "run-tasks",
        attributes: {
          name,
          description,
          url,
          category,
          enabled,
          "hmac-key": null,
          "global-configuration": globalConfiguration,
        },
      },
    };
  })
  .get("/api/v2/run-tasks/:task_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const taskId = params.task_id ?? "";
    const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
    if (task === undefined || !(await checkOrganizationPermission(task.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-run-tasks"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
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
          "hmac-key": null,
          "global-configuration": task.globalConfiguration ?? null,
        },
      },
    };
  })
  .patch("/api/v2/run-tasks/:task_id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const taskId = params.task_id ?? "";
    const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
    if (task === undefined || !(await checkOrganizationPermission(task.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-run-tasks"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof runTasks.$inferInsert> = {};
    if (typeof attrs.name === "string") updates.name = attrs.name;
    if (attrs.description !== undefined) updates.description = typeof attrs.description === "string" ? attrs.description : null;
    if (typeof attrs.url === "string") updates.url = attrs.url;
    if (typeof attrs.enabled === "boolean") updates.enabled = attrs.enabled;
    if (attrs["global-configuration"] !== undefined) {
      updates.globalConfiguration = attrs["global-configuration"] !== null && typeof attrs["global-configuration"] === "object"
        ? (attrs["global-configuration"] as { enabled: boolean; stages: string[]; enforcementLevel: string })
        : null;
    }
    if (Object.keys(updates).length > 0) await db.update(runTasks).set(updates).where(eq(runTasks.id, taskId));
    const updated = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
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
          "hmac-key": null,
          "global-configuration": updated.globalConfiguration ?? null,
        },
      },
    };
  })
  .delete("/api/v2/run-tasks/:task_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const taskId = params.task_id ?? "";
    const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
    if (task === undefined || !(await checkOrganizationPermission(task.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-run-tasks"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(runTasks).where(eq(runTasks.id, taskId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Workspace Run Tasks ---
  .get("/api/v2/workspaces/:workspace_id/run-tasks", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId, tokenTeamId ?? null);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const bindings = await db.query.workspaceRunTasks.findMany({ where: eq(workspaceRunTasks.workspaceId, workspaceId) });
    return { data: bindings.map((b: BindingItem): Record<string, unknown> => ({ id: b.id, type: "workspace-run-tasks", attributes: { stage: b.stage, "enforcement-level": b.enforcementLevel }, relationships: { "run-task": { data: { id: b.runTaskId, type: "run-tasks" } } } })) };
  })
  .post("/api/v2/workspaces/:workspace_id/run-tasks", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId, tokenTeamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
    const runTaskRel = typeof rels["run-task"] === "object" && rels["run-task"] !== null ? (rels["run-task"] as Record<string, unknown>) : {};
    const runTaskData = typeof runTaskRel.data === "object" && runTaskRel.data !== null ? (runTaskRel.data as Record<string, unknown>) : {};
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const taskId = typeof runTaskData.id === "string" ? runTaskData.id : (typeof attrs["run-task-id"] === "string" ? attrs["run-task-id"] : "");
    if (taskId === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const stage = typeof attrs.stage === "string" && attrs.stage !== "" ? attrs.stage : "post_plan";
    const enforcementLevel = typeof attrs["enforcement-level"] === "string" && attrs["enforcement-level"] !== "" ? attrs["enforcement-level"] : "advisory";
    const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
    if (task?.orgId !== ws.orgId) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!["pre_plan", "post_plan", "pre_apply", "post_apply"].includes(stage) || !["advisory", "mandatory", "must_pass"].includes(enforcementLevel)) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const id = `wrt-${crypto.randomUUID()}`;
    await db.insert(workspaceRunTasks).values({ id, workspaceId, runTaskId: taskId, stage, enforcementLevel }).onConflictDoNothing();
    (set as { status: number }).status = 201;
    return { data: { id, type: "workspace-run-tasks", attributes: { stage, "enforcement-level": enforcementLevel } } };
  })
  .delete("/api/v2/workspaces/:workspace_id/run-tasks/:task_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params.workspace_id ?? "";
    const taskId = params.task_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId, tokenTeamId ?? null, "admin");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(workspaceRunTasks).where(and(eq(workspaceRunTasks.workspaceId, workspaceId), eq(workspaceRunTasks.runTaskId, taskId)));
    (set as { status: number }).status = 204;
    return {};
  });
