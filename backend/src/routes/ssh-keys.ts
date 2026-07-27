import { Elysia } from "elysia";
import { db } from "../db";
import { sshKeys, organizations } from "../db/schema";
import { eq } from "drizzle-orm";
import { checkOrgPermission } from "../lib/utils";
import { authPlugin } from "../auth";

function getAttrs(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};
  const data = (body as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return {};
  const attrs = (data as Record<string, unknown>).attributes;
  return typeof attrs === "object" && attrs !== null ? attrs as Record<string, unknown> : {};
}

export const sshKeyRoutes = new Elysia({ name: "sshKeys" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/ssh-keys", async ({ params: { org_name: orgName }, user, orgId: tokenOrgId, set }): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === null || org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const keyList = await db.query.sshKeys.findMany({ where: eq(sshKeys.orgId, org.id) });
    return { data: keyList.map(k => ({ id: k.id, type: "ssh-keys", attributes: { name: k.name } })) };
  })
  .post("/api/v2/organizations/:org_name/ssh-keys", async ({ params: { org_name: orgName }, body, user, orgId: tokenOrgId, set }): Promise<unknown> => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === null || org === undefined || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    const name = typeof attrs.name === "string" ? attrs.name : "";
    const value = typeof attrs.value === "string" ? attrs.value : "";
    if (name === "" || value === "") { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name and value are required" }] }; }
    const id = `ssh-${crypto.randomUUID()}`;
    await db.insert(sshKeys).values({ id, orgId: org.id, name, value, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "ssh-keys", attributes: { name } } };
  })
  .get("/api/v2/ssh-keys/:ssh_key_id", async ({ params: { ssh_key_id: sshKeyId }, user, orgId: tokenOrgId, set }): Promise<unknown> => {
    const key = await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, sshKeyId) });
    if (key === null || key === undefined || !(await checkOrgPermission(user?.id, key.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: key.id, type: "ssh-keys", attributes: { name: key.name } } };
  })
  .patch("/api/v2/ssh-keys/:ssh_key_id", async ({ params: { ssh_key_id: sshKeyId }, body, user, orgId: tokenOrgId, set }): Promise<unknown> => {
    const key = await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, sshKeyId) });
    if (key === null || key === undefined || !(await checkOrgPermission(user?.id, key.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    const updates: Partial<typeof sshKeys.$inferInsert> = {};
    if (typeof attrs.name === "string") updates.name = attrs.name;
    if (typeof attrs.value === "string") updates.value = attrs.value;
    if (Object.keys(updates).length > 0) await db.update(sshKeys).set(updates).where(eq(sshKeys.id, sshKeyId));
    const updated = await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, sshKeyId) });
    return { data: { id: updated?.id ?? "unknown", type: "ssh-keys", attributes: { name: updated?.name ?? "" } } };
  })
  .delete("/api/v2/ssh-keys/:ssh_key_id", async ({ params: { ssh_key_id: sshKeyId }, user, orgId: tokenOrgId, set }): Promise<Record<string, never> | undefined> => {
    const key = await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, sshKeyId) });
    if (key === null || key === undefined || !(await checkOrgPermission(user?.id, key.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(sshKeys).where(eq(sshKeys.id, sshKeyId));
    set.status = 204;
    return undefined;
  });
