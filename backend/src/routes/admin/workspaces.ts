import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import { db } from "../../db";
import { workspaces } from "../../db/schema";
import { eq } from "drizzle-orm";
import type { ParamCtx } from "./types";
import type { WsItem } from "./helpers";
export const workspacesRoutes = new Elysia({ name: "admin-workspaces" })
  .use(authPlugin)
  .get("/api/v2/admin/workspaces", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const allWs = await db.query.workspaces.findMany();
    return { data: allWs.map((w: WsItem): Record<string, unknown> => ({ id: w.id, type: "workspaces", attributes: { name: w.name, "terraform-version": w.terraformVersion, locked: w.locked } })) };
  })
  .get("/api/v2/admin/workspaces/:ws_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const wsId = params.ws_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: ws.id, type: "workspaces", attributes: { name: ws.name, "terraform-version": ws.terraformVersion, locked: ws.locked } } };
  })
  .patch("/api/v2/admin/workspaces/:ws_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const wsId = params.ws_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof workspaces.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (typeof attributes["terraform-version"] === "string") updates.terraformVersion = attributes["terraform-version"];
    if (typeof attributes.locked === "boolean") updates.locked = attributes.locked;
    if (Object.keys(updates).length > 0) await db.update(workspaces).set(updates).where(eq(workspaces.id, wsId));
    const updated = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "workspaces", attributes: { name: updated.name, "terraform-version": updated.terraformVersion, locked: updated.locked } } };
  })
  .delete("/api/v2/admin/workspaces/:ws_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const wsId = params.ws_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
    (set as { status: number }).status = 204;
    return {};
  });
