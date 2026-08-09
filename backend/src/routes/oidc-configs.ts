import { Elysia } from "elysia";
import { db } from "../db";
import { oidcConfigs, organizations, type users } from "../db/schema";
import { eq } from "drizzle-orm";
import { checkOrganizationPermission, notFound } from "../lib/utils";
import { authPlugin } from "../auth";

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  set: { status?: number | string; headers: Readonly<Record<string, string | number>> };
}>;

type OidcRow = typeof oidcConfigs.$inferSelect;

// go-tfe OIDC configuration resources carry a pointer `organization`
// relationship whose Name the provider dereferences.
function oidcResource(row: OidcRow, orgName: string): Record<string, unknown> {
  return {
    id: row.id,
    type: row.configType,
    attributes: row.config,
    relationships: { organization: { data: { id: orgName, type: "organizations" } } },
  };
}

function bodyData(body: unknown): { type?: string | undefined; attributes?: Record<string, unknown> | undefined } {
  if (body === null || typeof body !== "object") return {};
  const data = (body as Record<string, unknown>).data;
  if (data === null || typeof data !== "object") return {};
  const d = data as Record<string, unknown>;
  return {
    type: typeof d.type === "string" ? d.type : undefined,
    attributes: d.attributes !== null && typeof d.attributes === "object" ? d.attributes as Record<string, unknown> : undefined,
  };
}

export const oidcConfigRoutes = new Elysia({ name: "oidc-configs" })
  .use(authPlugin)
  .post("/api/v2/organizations/:org_name/oidc-configurations", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    const { type, attributes } = bodyData(body);
    if (type === undefined || attributes === undefined || Object.keys(attributes).length === 0) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "OIDC configuration type and attributes are required" }] };
    }
    const id = `oidc-${crypto.randomUUID()}`;
    const now = Date.now();
    const row: OidcRow = { id, orgId: org.id, configType: type, config: attributes, createdAt: now, updatedAt: now };
    await db.insert(oidcConfigs).values(row);
    (set as { status: number }).status = 201;
    return { data: oidcResource(row, org.name) };
  })
  .get("/api/v2/organizations/:org_name/oidc-configurations", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    const rows = await db.query.oidcConfigs.findMany({ where: eq(oidcConfigs.orgId, org.id) });
    return { data: rows.map((row): Record<string, unknown> => oidcResource(row, org.name)) };
  })
  .get("/api/v2/oidc-configurations/:oidc_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const id = params.oidc_id ?? "";
    const row = await db.query.oidcConfigs.findFirst({ where: eq(oidcConfigs.id, id) });
    if (row === undefined) return notFound(set);
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, row.orgId) });
    if (org === undefined || !(await checkOrganizationPermission(row.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    return { data: oidcResource(row, org.name) };
  })
  .patch("/api/v2/oidc-configurations/:oidc_id", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const id = params.oidc_id ?? "";
    const row = await db.query.oidcConfigs.findFirst({ where: eq(oidcConfigs.id, id) });
    if (row === undefined) return notFound(set);
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, row.orgId) });
    if (org === undefined || !(await checkOrganizationPermission(row.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    const { attributes } = bodyData(body);
    if (attributes === undefined) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity" }] };
    }
    const updated: OidcRow = { ...row, config: { ...row.config, ...attributes }, updatedAt: Date.now() };
    await db.update(oidcConfigs).set({ config: updated.config, updatedAt: updated.updatedAt }).where(eq(oidcConfigs.id, id));
    return { data: oidcResource(updated, org.name) };
  })
  .delete("/api/v2/oidc-configurations/:oidc_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const id = params.oidc_id ?? "";
    const row = await db.query.oidcConfigs.findFirst({ where: eq(oidcConfigs.id, id) });
    if (row === undefined) return notFound(set);
    if (!(await checkOrganizationPermission(row.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    await db.delete(oidcConfigs).where(eq(oidcConfigs.id, id));
    (set as { status: number }).status = 204;
    return {};
  });
