import { Elysia } from "elysia";
import { db } from "../db";
import { registryComponents } from "../db/schema";
import { eq } from "drizzle-orm";
import { authPlugin } from "../auth";
import { TFP_API_VERSION } from "../lib/constants";
import { checkOrganizationPermission } from "../lib/utils";
import { isUniqueConstraintError } from "../lib/validation";
import { cachedOrgByName } from "../lib/cached-lookups";

type Ctx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: { id: string } | null;
  orgId?: string | null;
  teamId?: string | null;
  request: Readonly<{ url: string }>;
  set: Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;
}>;

function componentResource(row: typeof registryComponents.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    type: "registry-components",
    attributes: {
      name: row.name,
      namespace: row.namespace,
      description: row.description,
      source: row.source,
      "source-identifier": row.sourceIdentifier,
      version: row.version,
      status: row.status,
      "published-at": row.publishedAt === null ? null : new Date(row.publishedAt).toISOString(),
      "created-at": new Date(row.createdAt).toISOString(),
      "updated-at": new Date((row.updatedAt ?? row.createdAt)).toISOString(),
    },
    relationships: { organization: { data: { id: row.orgId, type: "organizations" } } },
  };
}

export const registryComponentsRoutes = new Elysia({ name: "registry-components" })
  .use(authPlugin)
  .get("/api/registry/v1/components", async ({ request, set }: Ctx): Promise<unknown> => {
    const url = new URL(request.url);
    const orgName = url.searchParams.get("organization") ?? url.searchParams.get("filter[organization]") ?? "";
    if (orgName === "") {
      const rows = await db.query.registryComponents.findMany({ orderBy: (t, { desc }) => [desc(t.createdAt)], limit: 50 });
      const h = (set as { headers: Record<string, string | number> }).headers;
      (h)["TFP-API-Version"] = TFP_API_VERSION;
      return { data: rows.map(componentResource), meta: { pagination: { "current-page": 1, "total-pages": 1, "total-count": rows.length } } };
    }
    const org = await cachedOrgByName(orgName);
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const rows = await db.query.registryComponents.findMany({ where: eq(registryComponents.orgId, org.id), orderBy: (t, { desc }) => [desc(t.createdAt)] });
    const h = (set as { headers: Record<string, string | number> }).headers;
    (h)["TFP-API-Version"] = TFP_API_VERSION;
    return { data: rows.map(componentResource), meta: { pagination: { "current-page": 1, "total-pages": 1, "total-count": rows.length } } };
  })
  .get("/api/registry/v1/components/:id", async ({ params, set }: Ctx): Promise<unknown> => {
    const id = params["id"] ?? "";
    const row = await db.query.registryComponents.findFirst({ where: eq(registryComponents.id, id) });
    if (row === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found", detail: `Component ${id} not found` }] }; }
    return { data: componentResource(row) };
  })
  .post("/api/registry/v1/components", async ({ body, user, orgId: tokenOrgId, teamId, set }: Ctx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload["data"] !== null && typeof payload["data"] === "object" ? payload["data"] as Record<string, unknown> : {};
    const attrs = data["attributes"] !== null && typeof data["attributes"] === "object" ? data["attributes"] as Record<string, unknown> : {};
    const rels = data["relationships"] !== null && typeof data["relationships"] === "object" ? data["relationships"] as Record<string, unknown> : {};
    const orgRel = rels["organization"] !== null && typeof rels["organization"] === "object" ? rels["organization"] as Record<string, unknown> : {};
    const orgData = orgRel["data"] !== null && typeof orgRel["data"] === "object" ? orgRel["data"] as Record<string, unknown> : {};
    const orgName = typeof orgData["id"] === "string" ? orgData["id"] : typeof attrs["organization"] === "string" ? String(attrs["organization"]) : "";
    const name = typeof attrs["name"] === "string" ? attrs["name"].trim() : typeof data["id"] === "string" ? String(data["id"]).trim() : "";
    if (orgName === "" || name === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "organization and name are required" }] }; }
    const org = await cachedOrgByName(orgName);
    if (org === undefined || !(await checkOrganizationPermission(org.id, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const namespace = typeof attrs["namespace"] === "string" && attrs["namespace"].trim() !== "" ? attrs["namespace"].trim() : "hashicorp";
    const sourceIdentifier = typeof attrs["source-identifier"] === "string" && String(attrs["source-identifier"]).trim() !== "" ? String(attrs["source-identifier"]).trim() : name;
    const version = typeof attrs["version"] === "string" && attrs["version"].trim() !== "" ? attrs["version"].trim() : "0.1.0";
    const description = typeof attrs["description"] === "string" ? attrs["description"] : null;
    const id = `rcomp-${crypto.randomUUID()}`;
    const now = Date.now();
    const row: typeof registryComponents.$inferInsert = { id, orgId: org.id, name, namespace, description, source: "registry", sourceIdentifier, version, status: "pending", publishedAt: now, createdAt: now, updatedAt: now };
    try {
      await db.insert(registryComponents).values(row);
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: `Component ${namespace}/${name} already exists in ${orgName}` }] }; }
      throw error;
    }
    const created = await db.query.registryComponents.findFirst({ where: eq(registryComponents.id, id) });
    if (created === undefined) throw new Error("Created registry component could not be loaded");
    (set as { status: number }).status = 201;
    return { data: componentResource(created) };
  })
  .delete("/api/registry/v1/components/:id", async ({ params, user, orgId: tokenOrgId, teamId, set }: Ctx): Promise<unknown> => {
    const id = params["id"] ?? "";
    const row = await db.query.registryComponents.findFirst({ where: eq(registryComponents.id, id) });
    if (row === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found", detail: `Component ${id} not found` }] }; }
    if (!(await checkOrganizationPermission(row.orgId, user?.id, tokenOrgId ?? null, teamId ?? null, "manage-modules"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(registryComponents).where(eq(registryComponents.id, id));
    (set as { status: number }).status = 204;
    return null;
  });
