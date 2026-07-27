import { Elysia } from "elysia";
import { db } from "../db";
import { runTasks, workspaceRunTasks, organizations } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { checkOrgPermission, findAuthorizedWorkspace } from "../lib/utils";
import { authPlugin } from "../auth";

export const runTaskRoutes = new Elysia({ name: "runTasks" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/run-tasks", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const tasksList = await db.query.runTasks.findMany({ where: eq(runTasks.orgId, org.id) });
    return { data: tasksList.map(t => ({ id: t.id, type: "run-tasks", attributes: { name: t.name, description: t.description, url: t.url, category: t.category, enabled: t.enabled } })) };
  })
  .post("/api/v2/organizations/:org_name/run-tasks", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = (body as any)?.data?.attributes || {};
    if (!attrs.name || !attrs.url) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `task-${crypto.randomUUID()}`;
    await db.insert(runTasks).values({ id, orgId: org.id, name: attrs.name, description: attrs.description ?? null, url: attrs.url, category: attrs.category || "general", enabled: attrs.enabled ?? true, hmacKey: attrs["hmac-key"] ?? null, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "run-tasks", attributes: { name: attrs.name, description: attrs.description ?? null, url: attrs.url, category: attrs.category || "general", enabled: attrs.enabled ?? true } } };
  })
  .get("/api/v2/run-tasks/:task_id", async ({ params: { task_id }, user, orgId: tokenOrgId, set }) => {
    const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, task_id) });
    if (!task || !(await checkOrgPermission(user?.id, task.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: task.id, type: "run-tasks", attributes: { name: task.name, description: task.description, url: task.url, category: task.category, enabled: task.enabled } } };
  })
  .patch("/api/v2/run-tasks/:task_id", async ({ params: { task_id }, body, user, orgId: tokenOrgId, set }) => {
    const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, task_id) });
    if (!task || !(await checkOrgPermission(user?.id, task.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = (body as any)?.data?.attributes || {};
    const updates: Partial<typeof runTasks.$inferInsert> = {};
    if (attrs.name !== undefined) updates.name = attrs.name;
    if (attrs.description !== undefined) updates.description = attrs.description;
    if (attrs.url !== undefined) updates.url = attrs.url;
    if (attrs.enabled !== undefined) updates.enabled = attrs.enabled;
    if (Object.keys(updates).length > 0) await db.update(runTasks).set(updates).where(eq(runTasks.id, task_id));
    const updated = (await db.query.runTasks.findFirst({ where: eq(runTasks.id, task_id) }))!;
    return { data: { id: updated.id, type: "run-tasks", attributes: { name: updated.name, description: updated.description, url: updated.url, category: updated.category, enabled: updated.enabled } } };
  })
  .delete("/api/v2/run-tasks/:task_id", async ({ params: { task_id }, user, orgId: tokenOrgId, set }) => {
    const task = await db.query.runTasks.findFirst({ where: eq(runTasks.id, task_id) });
    if (!task || !(await checkOrgPermission(user?.id, task.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(runTasks).where(eq(runTasks.id, task_id));
    set.status = 204;
  })
  // --- Workspace Run Tasks ---
  .get("/api/v2/workspaces/:workspace_id/run-tasks", async ({ params: { workspace_id }, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const bindings = await db.query.workspaceRunTasks.findMany({ where: eq(workspaceRunTasks.workspaceId, workspace_id) });
    return { data: bindings.map(b => ({ id: b.id, type: "workspace-run-tasks", attributes: { stage: b.stage, "enforcement-level": b.enforcementLevel }, relationships: { "run-task": { data: { id: b.runTaskId, type: "run-tasks" } } } })) };
  })
  .post("/api/v2/workspaces/:workspace_id/run-tasks", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const taskId = (body as any)?.data?.relationships?.["run-task"]?.data?.id || (body as any)?.data?.attributes?.["run-task-id"];
    if (!taskId) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const attrs = (body as any)?.data?.attributes || {};
    const id = `wrt-${crypto.randomUUID()}`;
    await db.insert(workspaceRunTasks).values({ id, workspaceId: workspace_id, runTaskId: taskId, stage: attrs.stage || "post_plan", enforcementLevel: attrs["enforcement-level"] || "advisory" }).onConflictDoNothing();
    set.status = 201;
    return { data: { id, type: "workspace-run-tasks", attributes: { stage: attrs.stage || "post_plan", "enforcement-level": attrs["enforcement-level"] || "advisory" } } };
  })
  .delete("/api/v2/workspaces/:workspace_id/run-tasks/:task_id", async ({ params: { workspace_id, task_id }, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(workspaceRunTasks).where(and(eq(workspaceRunTasks.workspaceId, workspace_id), eq(workspaceRunTasks.runTaskId, task_id)));
    set.status = 204;
  });
