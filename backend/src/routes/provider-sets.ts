import { Elysia } from "elysia";
import { db } from "../db";
import { organizations, providerSets, type users } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { checkOrganizationPermission, notFound } from "../lib/utils";
import { authPlugin } from "../auth";
import { cachedOrgByName } from "../lib/cached-lookups";

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  set: { status?: number | string; headers: Readonly<Record<string, string | number>> };
}>;

type ProviderSetRow = typeof providerSets.$inferSelect;

// go-tfe ProviderSet carries a pointer `organization` relationship whose Name
// the provider reads; the relationship id must be the org NAME (TFE uses names
// as org identifiers).
function providerSetResource(row: ProviderSetRow, orgName: string): Record<string, unknown> {
  return {
    id: row.id,
    type: "provider-sets",
    attributes: {
      name: row.name,
      description: row.description,
      "provider-source": row.providerSource,
      "configuration-hcl": row.configurationHcl,
      global: row.global === true,
    },
    relationships: {
      organization: { data: { id: orgName, type: "organizations" } },
      workspaces: { data: [] },
      projects: { data: [] },
    },
  };
}

function attrsFrom(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object") return {};
  const data = (body as Record<string, unknown>).data;
  if (data === null || typeof data !== "object") return {};
  const attributes = (data as Record<string, unknown>).attributes;
  return attributes !== null && typeof attributes === "object"
    ? attributes as Record<string, unknown>
    : {};
}

async function findOrg(orgName: string): Promise<{ id: string; name: string } | undefined> {
  const org = await cachedOrgByName(orgName);
  return org === undefined ? undefined : { id: org.id, name: org.name };
}

export const providerSetRoutes = new Elysia({ name: "provider-sets" })
  .use(authPlugin)
  .get("/api/v2/organizations/:org_name/provider-sets", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await findOrg(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    const rows = await db.query.providerSets.findMany({ where: eq(providerSets.orgId, org.id) });
    return { data: rows.map((r: ProviderSetRow): Record<string, unknown> => providerSetResource(r, orgName)) };
  })
  .post("/api/v2/organizations/:org_name/provider-sets", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const org = await findOrg(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    const attrs = attrsFrom(body);
    const name = typeof attrs.name === "string" ? attrs.name : "";
    const providerSource = typeof attrs["provider-source"] === "string" ? attrs["provider-source"] : "";
    if (name === "" || providerSource === "") {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "name and provider-source are required" }] };
    }
    const id = `pset-${crypto.randomUUID()}`;
    const row: ProviderSetRow = {
      id,
      orgId: org.id,
      name,
      description: typeof attrs.description === "string" ? attrs.description : null,
      providerSource,
      configurationHcl: typeof attrs["configuration-hcl"] === "string" ? attrs["configuration-hcl"] : null,
      global: typeof attrs.global === "boolean" ? attrs.global : false,
      createdAt: Date.now(),
    };
    await db.insert(providerSets).values(row);
    (set as { status: number }).status = 201;
    return { data: providerSetResource(row, orgName) };
  })
  .get("/api/v2/provider-sets/:provider_set_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const id = params.provider_set_id ?? "";
    const row = await db.query.providerSets.findFirst({ where: eq(providerSets.id, id) });
    if (row === undefined) return notFound(set);
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, row.orgId) });
    if (org === undefined || !(await checkOrganizationPermission(row.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    return { data: providerSetResource(row, org.name) };
  })
  .get("/api/v2/organizations/:org_name/provider-sets/:name", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params.org_name ?? "";
    const name = params.name ?? "";
    const org = await findOrg(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    const row = await db.query.providerSets.findFirst({ where: and(eq(providerSets.orgId, org.id), eq(providerSets.name, name)) });
    if (row === undefined) return notFound(set);
    return { data: providerSetResource(row, orgName) };
  })
  .patch("/api/v2/provider-sets/:provider_set_id", async ({ params, body, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const id = params.provider_set_id ?? "";
    const row = await db.query.providerSets.findFirst({ where: eq(providerSets.id, id) });
    if (row === undefined) return notFound(set);
    const org = await db.query.organizations.findFirst({ where: eq(organizations.id, row.orgId) });
    if (org === undefined || !(await checkOrganizationPermission(row.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    const attrs = attrsFrom(body);
    const updates: Partial<typeof providerSets.$inferInsert> = {};
    if (typeof attrs.name === "string") updates.name = attrs.name;
    if (attrs.description !== undefined) updates.description = typeof attrs.description === "string" ? attrs.description : null;
    if (typeof attrs["provider-source"] === "string") updates.providerSource = attrs["provider-source"];
    if (attrs["configuration-hcl"] !== undefined) updates.configurationHcl = typeof attrs["configuration-hcl"] === "string" ? attrs["configuration-hcl"] : null;
    if (typeof attrs.global === "boolean") updates.global = attrs.global;
    if (Object.keys(updates).length > 0) await db.update(providerSets).set(updates).where(eq(providerSets.id, id));
    const updated = await db.query.providerSets.findFirst({ where: eq(providerSets.id, id) });
    if (updated === undefined) return notFound(set);
    return { data: providerSetResource(updated, org.name) };
  })
  .delete("/api/v2/provider-sets/:provider_set_id", async ({ params, user, orgId: tokenOrgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const id = params.provider_set_id ?? "";
    const row = await db.query.providerSets.findFirst({ where: eq(providerSets.id, id) });
    if (row === undefined) return notFound(set);
    if (!(await checkOrganizationPermission(row.orgId, user?.id, tokenOrgId, teamId ?? null, "manage-providers"))) return notFound(set);
    await db.delete(providerSets).where(eq(providerSets.id, id));
    (set as { status: number }).status = 204;
    return {};
  });
