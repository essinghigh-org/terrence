/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { Elysia } from "elysia";
import { db } from "../db";
import { notificationConfigurations } from "../db/schema";
import { eq } from "drizzle-orm";
import { checkOrgPermission, findAuthorizedWorkspace } from "../lib/utils";
import { authPlugin } from "../auth";

export const notificationRoutes = new Elysia({ name: "notifications" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/notification-configurations", async ({ params: { workspace_id }, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ncList = await db.query.notificationConfigurations.findMany({ where: eq(notificationConfigurations.workspaceId, workspace_id) });
    return { data: ncList.map(nc => ({ id: nc.id, type: "notification-configurations", attributes: { name: nc.name, "destination-type": nc.destinationType, url: nc.url, triggers: nc.triggers, enabled: nc.enabled, token: nc.token } })) };
  })
  .post("/api/v2/workspaces/:workspace_id/notification-configurations", async ({ params: { workspace_id }, body, user, orgId: tokenOrgId, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, tokenOrgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes?.name || !attributes.url || !attributes["destination-type"]) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name, url, destination-type are required" }] }; }
    const id = `nc-${crypto.randomUUID()}`;
    await db.insert(notificationConfigurations).values({ id, workspaceId: workspace_id, name: attributes.name, destinationType: attributes["destination-type"], url: attributes.url, triggers: Array.isArray(attributes.triggers) ? attributes.triggers : ["run:created", "run:completed"], enabled: attributes.enabled ?? true, token: attributes.token ?? null, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "notification-configurations", attributes: { name: attributes.name, "destination-type": attributes["destination-type"], url: attributes.url, triggers: Array.isArray(attributes.triggers) ? attributes.triggers : ["run:created", "run:completed"], enabled: attributes.enabled ?? true, token: attributes.token ?? null } } };
  })
  .get("/api/v2/notification-configurations/:nc_id", async ({ params: { nc_id }, user, orgId: tokenOrgId, set }) => {
    const nc = await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, nc_id) });
    if (!nc) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, nc.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: nc.id, type: "notification-configurations", attributes: { name: nc.name, "destination-type": nc.destinationType, url: nc.url, triggers: nc.triggers, enabled: nc.enabled, token: nc.token } } };
  })
  .patch("/api/v2/notification-configurations/:nc_id", async ({ params: { nc_id }, body, user, orgId: tokenOrgId, set }) => {
    const nc = await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, nc_id) });
    if (!nc) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, nc.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof notificationConfigurations.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (typeof attributes["destination-type"] === "string") updates.destinationType = attributes["destination-type"];
    if (typeof attributes.url === "string") updates.url = attributes.url;
    if (Array.isArray(attributes.triggers)) updates.triggers = attributes.triggers;
    if (typeof attributes.enabled === "boolean") updates.enabled = attributes.enabled;
    if (attributes.token !== undefined) updates.token = attributes.token;
    if (Object.keys(updates).length > 0) await db.update(notificationConfigurations).set(updates).where(eq(notificationConfigurations.id, nc_id));
    const updated = (await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, nc_id) }))!;
    return { data: { id: updated.id, type: "notification-configurations", attributes: { name: updated.name, "destination-type": updated.destinationType, url: updated.url, triggers: updated.triggers, enabled: updated.enabled, token: updated.token } } };
  })
  .delete("/api/v2/notification-configurations/:nc_id", async ({ params: { nc_id }, user, orgId: tokenOrgId, set }) => {
    const nc = await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, nc_id) });
    if (!nc) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, nc.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, nc_id));
    set.status = 204;
  })
  .post("/api/v2/notification-configurations/:nc_id/actions/verify", async ({ params: { nc_id }, user, orgId: tokenOrgId, set }) => {
    const nc = await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, nc_id) });
    if (!nc) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, nc.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { status: "verification_sent" };
  });
