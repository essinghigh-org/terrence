import { Elysia } from "elysia";
import { count, desc, eq } from "drizzle-orm";
import { authPlugin } from "../../auth";
import { db } from "../../db";
import { adminTfpolicyVersions } from "../../db/schema";
import { newResourceId } from "../../lib/resource-id";
import { pageRequest, pagination } from "../../lib/utils";
import type { ParamCtx } from "./types";

type Version = typeof adminTfpolicyVersions.$inferSelect;
function resource(v: Version): Record<string, unknown> {
  return {
    id: v.id,
    type: "tfpolicy-versions",
    attributes: {
      version: v.version,
      official: v.official,
      enabled: v.enabled,
      beta: v.beta,
      deprecated: v.deprecated,
      "deprecated-reason": v.deprecatedReason,
      archs: v.archs,
    },
  };
}
function error(set: ParamCtx["set"], status: number, detail: string): Record<string, unknown> {
  (set as { status: number }).status = status;
  return { errors: [{ status: String(status), title: status === 404 ? "Not Found" : "Unprocessable Entity", detail }] };
}
function attributes(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object") return {};
  const data = (body as Record<string, unknown>)["data"];
  if (data === null || typeof data !== "object") return {};
  const attrs = (data as Record<string, unknown>)["attributes"];
  return attrs !== null && typeof attrs === "object" && !Array.isArray(attrs) ? (attrs as Record<string, unknown>) : {};
}
function validate(v: Record<string, unknown>): string | undefined {
  if (typeof v["version"] !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v["version"]))
    return "A semantic version is required";
  for (const field of ["official", "enabled", "beta", "deprecated"]) {
    if (typeof v[field] !== "boolean") return `${field} must be a boolean`;
  }
  const reason = v["deprecatedReason"];
  if (reason !== null && typeof reason !== "string") return "deprecated-reason must be a string or null";
  if (v["deprecated"] === true && (typeof reason !== "string" || reason.trim() === ""))
    return "A deprecated version requires a reason";
  if (v["deprecated"] === false && typeof reason === "string" && reason.trim() !== "")
    return "Only deprecated versions may have a reason";
  return validateArchitectures(v["archs"]);
}
function validateArchitectures(archs: unknown): string | undefined {
  if (!Array.isArray(archs) || archs.length === 0) return "At least one architecture is required";
  const seen = new Set<string>();
  for (const value of archs) {
    if (value === null || typeof value !== "object") return "Invalid architecture";
    const arch = value as Record<string, unknown>;
    if (arch["os"] !== "linux" || !["amd64", "arm64", "s390x"].includes(String(arch["arch"])))
      return "Unsupported OS or architecture";
    if (typeof arch["sha"] !== "string" || !/^[a-f0-9]{64}$/.test(arch["sha"]))
      return "A lowercase SHA-256 checksum is required";
    try {
      const url = new URL(String(arch["url"]));
      if (!["http:", "https:"].includes(url.protocol)) return "Binary URL must use HTTP or HTTPS";
    } catch {
      return "Invalid binary URL";
    }
    const key = `${arch["os"]}/${String(arch["arch"])}`;
    if (seen.has(key)) return "Duplicate OS/architecture pair";
    seen.add(key);
  }
  return undefined;
}
function values(attrs: Record<string, unknown>, prior?: Version): Record<string, unknown> {
  const result: Record<string, unknown> =
    prior === undefined
      ? { official: false, enabled: true, beta: false, deprecated: false, deprecatedReason: null }
      : { ...prior };
  for (const key of ["version", "official", "enabled", "beta", "deprecated", "archs"]) {
    if (Object.hasOwn(attrs, key)) result[key] = attrs[key];
  }
  if (attrs["deprecated"] === false) result["deprecatedReason"] = null;
  if (Object.hasOwn(attrs, "deprecated-reason")) result["deprecatedReason"] = attrs["deprecated-reason"];
  return result;
}
export const tfpolicyVersionsRoutes = new Elysia({ name: "admin-tfpolicy-versions" })
  .use(authPlugin)
  .get("/api/v2/admin/tfpolicy-versions", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return error(set, 404, "Not Found");
    const { number, size } = pageRequest(request);
    const filter = new URL(request.url).searchParams.get("filter[version]");
    const where = filter === null ? undefined : eq(adminTfpolicyVersions.version, filter);
    const [rows, totals] = await Promise.all([
      db
        .select()
        .from(adminTfpolicyVersions)
        .where(where)
        .orderBy(desc(adminTfpolicyVersions.createdAt))
        .limit(size)
        .offset((number - 1) * size),
      db.select({ total: count() }).from(adminTfpolicyVersions).where(where),
    ]);
    return { data: rows.map(resource), ...pagination(request, number, size, totals[0]?.total ?? 0) };
  })
  .post("/api/v2/admin/tfpolicy-versions", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return error(set, 404, "Not Found");
    const candidate = values(attributes(body));
    const invalid = validate(candidate);
    if (invalid !== undefined) return error(set, 422, invalid);
    const v = { ...candidate, id: newResourceId("tool"), createdAt: Date.now() } as Version;
    const inserted = await db.insert(adminTfpolicyVersions).values(v).onConflictDoNothing().returning();
    if (inserted.length === 0) return error(set, 422, "Version already exists");
    (set as { status: number }).status = 201;
    return { data: resource(v) };
  })
  .get("/api/v2/admin/tfpolicy-versions/:version_id", async ({ user, params, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return error(set, 404, "Not Found");
    const v = await db.query.adminTfpolicyVersions.findFirst({
      where: eq(adminTfpolicyVersions.id, params["version_id"] ?? ""),
    });
    return v === undefined ? error(set, 404, "Not Found") : { data: resource(v) };
  })
  .patch(
    "/api/v2/admin/tfpolicy-versions/:version_id",
    async ({ user, params, body, set }: ParamCtx): Promise<unknown> => {
      if (user?.isSiteAdmin !== true) return error(set, 404, "Not Found");
      const id = params["version_id"] ?? "";
      const prior = await db.query.adminTfpolicyVersions.findFirst({ where: eq(adminTfpolicyVersions.id, id) });
      if (prior === undefined) return error(set, 404, "Not Found");
      const candidate = values(attributes(body), prior);
      const invalid = validate(candidate);
      if (invalid !== undefined) return error(set, 422, invalid);
      const duplicate = await db.query.adminTfpolicyVersions.findFirst({
        where: eq(adminTfpolicyVersions.version, candidate["version"] as string),
      });
      if (duplicate !== undefined && duplicate.id !== id) return error(set, 422, "Version already exists");
      const updated = await db
        .update(adminTfpolicyVersions)
        .set(candidate as Version)
        .where(eq(adminTfpolicyVersions.id, id))
        .returning();
      const row = updated[0];
      return row === undefined ? error(set, 404, "Not Found") : { data: resource(row) };
    },
  )
  .delete("/api/v2/admin/tfpolicy-versions/:version_id", async ({ user, params, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) return error(set, 404, "Not Found");
    const id = params["version_id"] ?? "";
    const v = await db.query.adminTfpolicyVersions.findFirst({ where: eq(adminTfpolicyVersions.id, id) });
    if (v === undefined) return error(set, 404, "Not Found");
    if (v.official) return error(set, 422, "Official versions cannot be deleted");
    await db.delete(adminTfpolicyVersions).where(eq(adminTfpolicyVersions.id, id));
    (set as { status: number }).status = 204;
    return {};
  });
