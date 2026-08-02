import { Elysia } from "elysia";
import { db } from "../db";
import { sshKeys, organizations } from "../db/schema";
import { eq } from "drizzle-orm";
import { checkOrganizationPermission } from "../lib/utils";
import { authPlugin } from "../auth";
import { encryptSecret } from "../lib/secrets";

function getAttrs(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};
  const data = (body as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return {};
  const attrs = (data as Record<string, unknown>).attributes;
  return typeof attrs === "object" && attrs !== null ? attrs as Record<string, unknown> : {};
}

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: { readonly id: string } | null;
  orgId: string | null;
  teamId: string | null;
  set: SetObj;
}>;

export const sshKeyRoutes = new Elysia({ name: "sshKeys" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/ssh-keys", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "read-vcs-settings"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const keyList = await db.query.sshKeys.findMany({ where: eq(sshKeys.orgId, org.id) });
    return { data: keyList.map((k: { readonly id: string; readonly name: string }): Record<string, unknown> => ({ id: k.id, type: "ssh-keys", attributes: { name: k.name } })) };
  })
  .post("/api/v2/organizations/:org_name/ssh-keys", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    const name = typeof attrs.name === "string" ? attrs.name : "";
    const value = typeof attrs.value === "string" ? attrs.value : "";
    if (name === "" || value === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Name and value are required" }] }; }
    const id = `ssh-${crypto.randomUUID()}`;
    await db.insert(sshKeys).values({ id, orgId: org.id, name, value: await encryptSecret(value), createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "ssh-keys", attributes: { name } } };
  })
  .get("/api/v2/ssh-keys/:ssh_key_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const sshKeyId = params.ssh_key_id ?? "";
    const key = await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, sshKeyId) });
    if (key === undefined || !(await checkOrganizationPermission(key.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "read-vcs-settings"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: key.id, type: "ssh-keys", attributes: { name: key.name } } };
  })
  .patch("/api/v2/ssh-keys/:ssh_key_id", async ({ params, body, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<unknown> => {
    const sshKeyId = params.ssh_key_id ?? "";
    const key = await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, sshKeyId) });
    if (key === undefined || !(await checkOrganizationPermission(key.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = getAttrs(body);
    const updates: Partial<typeof sshKeys.$inferInsert> = {};
    if (typeof attrs.name === "string") updates.name = attrs.name;
    if (typeof attrs.value === "string") updates.value = await encryptSecret(attrs.value);
    if (Object.keys(updates).length > 0) await db.update(sshKeys).set(updates).where(eq(sshKeys.id, sshKeyId));
    const updated = await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, sshKeyId) });
    return { data: { id: updated?.id ?? "unknown", type: "ssh-keys", attributes: { name: updated?.name ?? "" } } };
  })
  .delete("/api/v2/ssh-keys/:ssh_key_id", async ({ params, user, orgId: tokenOrgId, teamId: tokenTeamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const sshKeyId = params.ssh_key_id ?? "";
    const key = await db.query.sshKeys.findFirst({ where: eq(sshKeys.id, sshKeyId) });
    if (key === undefined || !(await checkOrganizationPermission(key.orgId, user?.id, tokenOrgId, tokenTeamId ?? null, "manage-vcs-settings"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(sshKeys).where(eq(sshKeys.id, sshKeyId));
    (set as { status: number }).status = 204;
    return {};
  });
