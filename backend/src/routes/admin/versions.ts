import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import { db } from "../../db";
import { adminTerraformVersions, adminSentinelVersions, adminOpaVersions } from "../../db/schema";
import { eq, desc, count } from "drizzle-orm";
import { pageRequest, pagination } from "../../lib/utils";
import type { ParamCtx } from "./types";
import { type VerItem, versionResource } from "./helpers";
export const versionsRoutes = new Elysia({ name: "admin-versions" })
  .use(authPlugin)
  .get("/api/v2/admin/terraform-versions", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const { number, size } = pageRequest(request);
    const [versions, countRows] = await Promise.all([
      db.query.adminTerraformVersions.findMany({ orderBy: [desc(adminTerraformVersions.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(adminTerraformVersions),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: versions.map((v: VerItem): Record<string, unknown> => (versionResource(v, "terraform-versions"))), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/admin/terraform-versions", async ({ body, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const version = typeof attrs.version === "string" ? attrs.version : "";
    if (version === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Version is required" }] }; }
    const id = `tfver-${crypto.randomUUID()}`;
    const url = typeof attrs.url === "string" ? attrs.url : null;
    const sha = typeof attrs.sha === "string" ? attrs.sha : null;
    const deprecated = typeof attrs.deprecated === "boolean" ? attrs.deprecated : false;
    const isDefault = typeof attrs.default === "boolean" ? attrs.default : false;
    const enabled = typeof attrs.enabled === "boolean" ? attrs.enabled : true;
    await db.insert(adminTerraformVersions).values({ id, version, url, sha, deprecated, enabled, isDefault, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: versionResource({ id, version, url, sha, isDefault, enabled, deprecated }, "terraform-versions") };
  })
  .get("/api/v2/admin/terraform-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminTerraformVersions.findFirst({ where: eq(adminTerraformVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: versionResource(v, "terraform-versions") };
  })
  .patch("/api/v2/admin/terraform-versions/:version_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminTerraformVersions.findFirst({ where: eq(adminTerraformVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof adminTerraformVersions.$inferInsert> = {};
    if (typeof attrs.version === "string") updates.version = attrs.version;
    if (attrs.url !== undefined) updates.url = typeof attrs.url === "string" ? attrs.url : null;
    if (attrs.sha !== undefined) updates.sha = typeof attrs.sha === "string" ? attrs.sha : null;
    if (typeof attrs.deprecated === "boolean") updates.deprecated = attrs.deprecated;
    if (typeof attrs.default === "boolean") updates.isDefault = attrs.default;
    if (typeof attrs.enabled === "boolean") updates.enabled = attrs.enabled;
    if (Object.keys(updates).length > 0) await db.update(adminTerraformVersions).set(updates).where(eq(adminTerraformVersions.id, versionId));
    const updated = await db.query.adminTerraformVersions.findFirst({ where: eq(adminTerraformVersions.id, versionId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: versionResource(updated, "terraform-versions") };
  })
  .delete("/api/v2/admin/terraform-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminTerraformVersions.findFirst({ where: eq(adminTerraformVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(adminTerraformVersions).where(eq(adminTerraformVersions.id, versionId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Sentinel Versions ---
  .get("/api/v2/admin/sentinel-versions", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const { number, size } = pageRequest(request);
    const [versions, countRows] = await Promise.all([
      db.query.adminSentinelVersions.findMany({ orderBy: [desc(adminSentinelVersions.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(adminSentinelVersions),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: versions.map((v: VerItem): Record<string, unknown> => (versionResource(v, "sentinel-versions"))), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/admin/sentinel-versions", async ({ body, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const version = typeof attrs.version === "string" ? attrs.version : "";
    if (version === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `sver-${crypto.randomUUID()}`;
    const url = typeof attrs.url === "string" ? attrs.url : null;
    const sha = typeof attrs.sha === "string" ? attrs.sha : null;
    const deprecated = typeof attrs.deprecated === "boolean" ? attrs.deprecated : false;
    const isDefault = typeof attrs.default === "boolean" ? attrs.default : false;
    const enabled = typeof attrs.enabled === "boolean" ? attrs.enabled : true;
    await db.insert(adminSentinelVersions).values({ id, version, url, sha, deprecated, enabled, isDefault, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: versionResource({ id, version, url, sha, isDefault, enabled, deprecated }, "sentinel-versions") };
  })
  .get("/api/v2/admin/sentinel-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminSentinelVersions.findFirst({ where: eq(adminSentinelVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: versionResource(v, "sentinel-versions") };
  })
  .patch("/api/v2/admin/sentinel-versions/:version_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminSentinelVersions.findFirst({ where: eq(adminSentinelVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof adminSentinelVersions.$inferInsert> = {};
    if (typeof attrs.version === "string") updates.version = attrs.version;
    if (attrs.url !== undefined) updates.url = typeof attrs.url === "string" ? attrs.url : null;
    if (attrs.sha !== undefined) updates.sha = typeof attrs.sha === "string" ? attrs.sha : null;
    if (typeof attrs.deprecated === "boolean") updates.deprecated = attrs.deprecated;
    if (typeof attrs.default === "boolean") updates.isDefault = attrs.default;
    if (typeof attrs.enabled === "boolean") updates.enabled = attrs.enabled;
    if (Object.keys(updates).length > 0) await db.update(adminSentinelVersions).set(updates).where(eq(adminSentinelVersions.id, versionId));
    const updated = await db.query.adminSentinelVersions.findFirst({ where: eq(adminSentinelVersions.id, versionId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: versionResource(updated, "sentinel-versions") };
  })
  .delete("/api/v2/admin/sentinel-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminSentinelVersions.findFirst({ where: eq(adminSentinelVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(adminSentinelVersions).where(eq(adminSentinelVersions.id, versionId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- OPA Versions ---
  .get("/api/v2/admin/opa-versions", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const { number, size } = pageRequest(request);
    const [versions, countRows] = await Promise.all([
      db.query.adminOpaVersions.findMany({ orderBy: [desc(adminOpaVersions.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(adminOpaVersions),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: versions.map((v: VerItem): Record<string, unknown> => (versionResource(v, "opa-versions"))), ...pagination(request, number, size, totalCount) };
  })
  .post("/api/v2/admin/opa-versions", async ({ body, user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const version = typeof attrs.version === "string" ? attrs.version : "";
    if (version === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `opa-${crypto.randomUUID()}`;
    const url = typeof attrs.url === "string" ? attrs.url : null;
    const sha = typeof attrs.sha === "string" ? attrs.sha : null;
    const deprecated = typeof attrs.deprecated === "boolean" ? attrs.deprecated : false;
    const isDefault = typeof attrs.default === "boolean" ? attrs.default : false;
    const enabled = typeof attrs.enabled === "boolean" ? attrs.enabled : true;
    await db.insert(adminOpaVersions).values({ id, version, url, sha, deprecated, enabled, isDefault, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: versionResource({ id, version, url, sha, isDefault, enabled, deprecated }, "opa-versions") };
  })
  .get("/api/v2/admin/opa-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminOpaVersions.findFirst({ where: eq(adminOpaVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: versionResource(v, "opa-versions") };
  })
  .patch("/api/v2/admin/opa-versions/:version_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminOpaVersions.findFirst({ where: eq(adminOpaVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof adminOpaVersions.$inferInsert> = {};
    if (typeof attrs.version === "string") updates.version = attrs.version;
    if (attrs.url !== undefined) updates.url = typeof attrs.url === "string" ? attrs.url : null;
    if (attrs.sha !== undefined) updates.sha = typeof attrs.sha === "string" ? attrs.sha : null;
    if (typeof attrs.deprecated === "boolean") updates.deprecated = attrs.deprecated;
    if (typeof attrs.default === "boolean") updates.isDefault = attrs.default;
    if (typeof attrs.enabled === "boolean") updates.enabled = attrs.enabled;
    if (Object.keys(updates).length > 0) await db.update(adminOpaVersions).set(updates).where(eq(adminOpaVersions.id, versionId));
    const updated = await db.query.adminOpaVersions.findFirst({ where: eq(adminOpaVersions.id, versionId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: versionResource(updated, "opa-versions") };
  })
  .delete("/api/v2/admin/opa-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const versionId = params.version_id ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminOpaVersions.findFirst({ where: eq(adminOpaVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(adminOpaVersions).where(eq(adminOpaVersions.id, versionId));
    (set as { status: number }).status = 204;
    return {};
  });
