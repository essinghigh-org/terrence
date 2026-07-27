import { Elysia } from "elysia";
import { db } from "../db";
import { sshKeys, organizations } from "../db/schema";
import { eq } from "drizzle-orm";
import { checkOrgPermission } from "../lib/utils";
import { authPlugin } from "../auth";

export const sshKeyRoutes = new Elysia({ name: "sshKeys" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/ssh-keys", async ({ params: { org_name }, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const keyList = await db.query.sshKeys.findMany({ where: eq(sshKeys.orgId, org.id) });
    return { data: keyList.map(k => ({ id: k.id, type: "ssh-keys", attributes: { name: k.name } })) };
  })
  .post("/api/v2/organizations/:org_name/ssh-keys", async ({ params: { org_name }, body, user, orgId: tokenOrgId, set }) => {
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org || !(await checkOrgPermission(user?.id, org.id, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes;
    if (!attributes || !attributes.name || !attributes.value) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name and value are required" }] }; }
    const id = `ssh-${crypto.randomUUID()}`;
    await db.insert(sshKeys).values({ id, orgId: org.id, name: attributes.name, value: attributes.value, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "ssh-keys", attributes: { name: attributes.name } } };
  })
  .get("/api/v2/ssh-keys/:ssh_key_id", async ({ params: { ssh_key_id }, user, orgId: tokenOrgId, set }) => {
    const key = await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, ssh_key_id) });
    if (!key || !(await checkOrgPermission(user?.id, key.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: key.id, type: "ssh-keys", attributes: { name: key.name } } };
  })
  .patch("/api/v2/ssh-keys/:ssh_key_id", async ({ params: { ssh_key_id }, body, user, orgId: tokenOrgId, set }) => {
    const key = await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, ssh_key_id) });
    if (!key || !(await checkOrgPermission(user?.id, key.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof sshKeys.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (typeof attributes.value === "string") updates.value = attributes.value;
    if (Object.keys(updates).length > 0) await db.update(sshKeys).set(updates).where(eq(sshKeys.id, ssh_key_id));
    const updated = (await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, ssh_key_id) }))!;
    return { data: { id: updated.id, type: "ssh-keys", attributes: { name: updated.name } } };
  })
  .delete("/api/v2/ssh-keys/:ssh_key_id", async ({ params: { ssh_key_id }, user, orgId: tokenOrgId, set }) => {
    const key = await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, ssh_key_id) });
    if (!key || !(await checkOrgPermission(user?.id, key.orgId, "member", tokenOrgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(sshKeys).where(eq(sshKeys.id, ssh_key_id));
    set.status = 204;
  });
