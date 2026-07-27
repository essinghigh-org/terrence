import { Elysia } from "elysia";
import { db } from "../db";
import { notificationConfigurations, workspaces, type users } from "../db/schema";
import { eq } from "drizzle-orm";
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

type NcItem = Readonly<{
  readonly id: string;
  readonly name: string;
  readonly destinationType: string;
  readonly url: string;
  readonly triggers: unknown;
  readonly enabled: boolean;
  readonly token: string | null;
}>;

export const notificationRoutes = new Elysia({ name: "notifications" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/notification-configurations", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ncList = await db.query.notificationConfigurations.findMany({ where: eq(notificationConfigurations.workspaceId, workspaceId) });
    return { data: ncList.map((nc: NcItem): Record<string, unknown> => ({ id: nc.id, type: "notification-configurations", attributes: { name: nc.name, "destination-type": nc.destinationType, url: nc.url, triggers: nc.triggers, enabled: nc.enabled, token: nc.token } })) };
  })
  .post("/api/v2/workspaces/:workspace_id/notification-configurations", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, tokenOrgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};

    const name = typeof attributes.name === "string" ? attributes.name : "";
    const url = typeof attributes.url === "string" ? attributes.url : "";
    const destinationType = typeof attributes["destination-type"] === "string" ? attributes["destination-type"] : "";
    if (name === "" || url === "" || destinationType === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name, url, destination-type are required" }] }; }
    const id = `nc-${crypto.randomUUID()}`;
    const triggers = Array.isArray(attributes.triggers) ? (attributes.triggers as string[]) : ["run:created", "run:completed"];
    const enabled = typeof attributes.enabled === "boolean" ? attributes.enabled : true;
    const token = typeof attributes.token === "string" ? attributes.token : null;
    await db.insert(notificationConfigurations).values({ id, workspaceId, name, destinationType, url, triggers, enabled, token, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "notification-configurations", attributes: { name, "destination-type": destinationType, url, triggers, enabled, token } } };
  })
  .get("/api/v2/notification-configurations/:nc_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const ncId = params["nc_id"] ?? "";
    const nc = await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, ncId) });
    if (nc === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, nc.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: nc.id, type: "notification-configurations", attributes: { name: nc.name, "destination-type": nc.destinationType, url: nc.url, triggers: nc.triggers, enabled: nc.enabled, token: nc.token } } };
  })
  .patch("/api/v2/notification-configurations/:nc_id", async ({ params, body, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const ncId = params["nc_id"] ?? "";
    const nc = await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, ncId) });
    if (nc === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, nc.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};

    const updates: Partial<typeof notificationConfigurations.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (typeof attributes["destination-type"] === "string") updates.destinationType = attributes["destination-type"];
    if (typeof attributes.url === "string") updates.url = attributes.url;
    if (Array.isArray(attributes.triggers)) updates.triggers = attributes.triggers as string[];
    if (typeof attributes.enabled === "boolean") updates.enabled = attributes.enabled;
    if (attributes.token !== undefined) updates.token = typeof attributes.token === "string" ? attributes.token : null;
    if (Object.keys(updates).length > 0) await db.update(notificationConfigurations).set(updates).where(eq(notificationConfigurations.id, ncId));
    const updated = await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, ncId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "notification-configurations", attributes: { name: updated.name, "destination-type": updated.destinationType, url: updated.url, triggers: updated.triggers, enabled: updated.enabled, token: updated.token } } };
  })

  .delete("/api/v2/notification-configurations/:nc_id", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const ncId = params["nc_id"] ?? "";
    const nc = await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, ncId) });
    if (nc === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, nc.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, ncId));
    (set as { status: number }).status = 204;
    return {};
  })
  .post("/api/v2/notification-configurations/:nc_id/actions/verify", async ({ params, user, orgId: tokenOrgId, set }: ParamCtx): Promise<unknown> => {
    const ncId = params["nc_id"] ?? "";
    const nc = await db.query.notificationConfigurations.findFirst({ where: eq(notificationConfigurations.id, ncId) });
    if (nc === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, nc.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", tokenOrgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { status: "verification_sent" };
  });
