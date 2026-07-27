import { Elysia } from "elysia";
import { db } from "../db";
import { runTasks, workspaceRunTasks, organizations, type users } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { checkOrgPermission, findAuthorizedWorkspace } from "../lib/utils";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  set: SetObj;
}>;

type TaskItem = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly url: string;
  readonly category: string;
  readonly enabled: boolean;
}>;

type BindingItem = Readonly<{
  readonly id: string;
  readonly stage: string;
  readonly enforcementLevel: string;
  readonly runTaskId: string;
}>;

export const runTaskRoutes = new Elysia({ name: "runTasks" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/run-tasks", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tasksList = await db.query.runTasks.findMany({ where: eq(runTasks.orgId, org.id) });
    return { data: tasksList.map((t: TaskItem): Record<string, unknown> => ({ id: t.id, type: "run-tasks", attributes: { name: t.name, description: t.description, url: t.url, category: t.category, enabled: t.enabled } })) };
  })
  .post("/api/v2/organizations/:org_name/run-tasks", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
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
    await db.insert(runTasks).values({ id, orgId: org.id, name, description, url, category, enabled, hmacKey, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "run-tasks", attributes: { name, description, url, category, enabled } } };
  })
  .get("/api/v2/run-tasks/:task_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const taskId = params["task_id"] ?? "";
    const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
    if (task === undefined || !(await checkOrgPermission(user?.id, task.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: task.id, type: "run-tasks", attributes: { name: task.name, description: task.description, url: task.url, category: task.category, enabled: task.enabled } } };
  })
  .patch("/api/v2/run-tasks/:task_id", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const taskId = params["task_id"] ?? "";
    const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
    if (task === undefined || !(await checkOrgPermission(user?.id, task.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof runTasks.$inferInsert> = {};
    if (typeof attrs.name === "string") updates.name = attrs.name;
    if (attrs.description !== undefined) updates.description = typeof attrs.description === "string" ? attrs.description : null;
    if (typeof attrs.url === "string") updates.url = attrs.url;
    if (typeof attrs.enabled === "boolean") updates.enabled = attrs.enabled;
    if (Object.keys(updates).length > 0) await db.update(runTasks).set(updates).where(eq(runTasks.id, taskId));
    const updated = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "run-tasks", attributes: { name: updated.name, description: updated.description, url: updated.url, category: updated.category, enabled: updated.enabled } } };
  })
  .delete("/api/v2/run-tasks/:task_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const taskId = params["task_id"] ?? "";
    const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, taskId) });
    if (task === undefined || !(await checkOrgPermission(user?.id, task.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(runTasks).where(eq(runTasks.id, taskId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Workspace Run Tasks ---
  .get("/api/v2/workspaces/:workspace_id/run-tasks", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const bindings = await db.query.workspaceRunTasks.findMany({ where: eq(workspaceRunTasks.workspaceId, workspaceId) });
    return { data: bindings.map((b: BindingItem): Record<string, unknown> => ({ id: b.id, type: "workspace-run-tasks", attributes: { stage: b.stage, "enforcement-level": b.enforcementLevel }, relationships: { "run-task": { data: { id: b.runTaskId, type: "run-tasks" } } } })) };
  })
  .post("/api/v2/workspaces/:workspace_id/run-tasks", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
    const runTaskRel = typeof rels["run-task"] === "object" && rels["run-task"] !== null ? (rels["run-task"] as Record<string, unknown>) : {};
    const runTaskData = typeof runTaskRel.data === "object" && runTaskRel.data !== null ? (runTaskRel.data as Record<string, unknown>) : {};
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const taskId = typeof runTaskData.id === "string" ? runTaskData.id : (typeof attrs["run-task-id"] === "string" ? attrs["run-task-id"] : "");
    if (taskId === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `wrt-${crypto.randomUUID()}`;
    const stage = typeof attrs.stage === "string" && attrs.stage !== "" ? attrs.stage : "post_plan";
    const enforcementLevel = typeof attrs["enforcement-level"] === "string" && attrs["enforcement-level"] !== "" ? attrs["enforcement-level"] : "advisory";
    await db.insert(workspaceRunTasks).values({ id, workspaceId, runTaskId: taskId, stage, enforcementLevel }).onConflictDoNothing();
    (set as { status: number }).status = 201;
    return { data: { id, type: "workspace-run-tasks", attributes: { stage, "enforcement-level": enforcementLevel } } };
  })
  .delete("/api/v2/workspaces/:workspace_id/run-tasks/:task_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const workspaceId = params["workspace_id"] ?? "";
    const taskId = params["task_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(workspaceRunTasks).where(and(eq(workspaceRunTasks.workspaceId, workspaceId), eq(workspaceRunTasks.runTaskId, taskId)));
    (set as { status: number }).status = 204;
    return {};
  });
