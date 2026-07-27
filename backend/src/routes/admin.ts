import { Elysia } from "elysia";
import { db } from "../db";
import { users, organizations, workspaces, runs, adminTerraformVersions, adminSentinelVersions, adminOpaVersions } from "../db/schema";
import { eq, and, desc, count, notInArray } from "drizzle-orm";
import { runResource } from "../lib/response";
import { pageRequest, pagination } from "../lib/utils";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  readonly params: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly user?: Readonly<typeof users.$inferSelect> | null;
  readonly request: Readonly<{ url: string }>;
  readonly set: SetObj;
}>;

type DeepReadonly<T> = T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

type UserItem = DeepReadonly<typeof users.$inferSelect>;
type OrgItem = DeepReadonly<typeof organizations.$inferSelect>;
type WsItem = DeepReadonly<typeof workspaces.$inferSelect>;
type RunItem = DeepReadonly<typeof runs.$inferSelect>;
type VerItem = Readonly<{
  readonly id: string;
  readonly version: string;
  readonly url: string | null;
  readonly sha: string | null;
  readonly isDefault: boolean | null;
  readonly deprecated: boolean | null;
}>;

export const adminRoutes = new Elysia({ name: "admin" })
  .use(authPlugin)
  .get("/api/v2/admin/users", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const allUsers = await db.query.users.findMany();
    return { data: allUsers.map((u: UserItem): Record<string, unknown> => ({ id: u.id, type: "users", attributes: { username: u.username, email: u.email, "is-site-admin": u.isSiteAdmin === true } })) };
  })
  .get("/api/v2/admin/users/:user_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const userId = params["user_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: targetUser.id, type: "users", attributes: { username: targetUser.username, email: targetUser.email, "is-site-admin": targetUser.isSiteAdmin === true } } };
  })
  .patch("/api/v2/admin/users/:user_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const userId = params["user_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof users.$inferInsert> = {};
    if (typeof attributes.username === "string") updates.username = attributes.username;
    if (typeof attributes.email === "string") updates.email = attributes.email;
    if (Object.keys(updates).length > 0) await db.update(users).set(updates).where(eq(users.id, userId));
    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "users", attributes: { username: updated.username, email: updated.email, "is-site-admin": updated.isSiteAdmin === true } } };
  })
  .delete("/api/v2/admin/users/:user_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const userId = params["user_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (targetUser === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(users).where(eq(users.id, userId));
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/admin/organizations", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const allOrgs = await db.query.organizations.findMany();
    return { data: allOrgs.map((o: OrgItem): Record<string, unknown> => ({ id: o.id, type: "organizations", attributes: { name: o.name } })) };
  })
  .get("/api/v2/admin/organizations/:org_name", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: org.id, type: "organizations", attributes: { name: org.name } } };
  })
  .patch("/api/v2/admin/organizations/:org_name", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const updates: Partial<typeof organizations.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (Object.keys(updates).length > 0) await db.update(organizations).set(updates).where(eq(organizations.id, org.id));
    const updated = await db.query.organizations.findFirst({ where: eq(organizations.id, org.id) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "organizations", attributes: { name: updated.name } } };
  })
  .delete("/api/v2/admin/organizations/:org_name", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const orgName = params["org_name"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (org === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(organizations).where(eq(organizations.id, org.id));
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/admin/workspaces", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const allWs = await db.query.workspaces.findMany();
    return { data: allWs.map((w: WsItem): Record<string, unknown> => ({ id: w.id, type: "workspaces", attributes: { name: w.name, "terraform-version": w.terraformVersion, locked: w.locked } })) };
  })
  .get("/api/v2/admin/workspaces/:ws_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const wsId = params["ws_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: ws.id, type: "workspaces", attributes: { name: ws.name, "terraform-version": ws.terraformVersion, locked: ws.locked } } };
  })
  .patch("/api/v2/admin/workspaces/:ws_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const wsId = params["ws_id"] ?? "";
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
    const wsId = params["ws_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/admin/runs", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const allRuns = await db.query.runs.findMany();
    return { data: allRuns.map((r: RunItem): Record<string, unknown> => ({ id: r.id, type: "runs", attributes: { status: r.status, "created-at": new Date(r.createdAt).toISOString() } })) };
  })
  .get("/api/v2/admin/runs/:run_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: runResource(run, true) };
  })
  .post("/api/v2/admin/runs/:run_id/actions/cancel", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const updated = await db.update(runs).set({ status: "canceled" }).where(and(eq(runs.id, runId), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"]))).returning();
    if (updated.length === 0 || updated[0] === undefined) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not cancelable" }] }; }
    return { data: runResource(updated[0], true) };
  })
  .post("/api/v2/admin/runs/:run_id/actions/force-cancel", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const updated = await db.update(runs).set({ status: "force_canceled" }).where(and(eq(runs.id, runId), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"]))).returning();
    if (updated.length === 0 || updated[0] === undefined) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not force-cancelable" }] }; }
    return { data: runResource(updated[0], true) };
  })
  // --- Terraform Versions ---
  .get("/api/v2/admin/terraform-versions", async ({ user, request, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const { number, size } = pageRequest(request);
    const [versions, countRows] = await Promise.all([
      db.query.adminTerraformVersions.findMany({ orderBy: [desc(adminTerraformVersions.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(adminTerraformVersions),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: versions.map((v: VerItem): Record<string, unknown> => ({ id: v.id, type: "terraform-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } })), ...pagination(request, number, size, totalCount) };
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
    await db.insert(adminTerraformVersions).values({ id, version, url, sha, deprecated, isDefault, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "terraform-versions", attributes: { version, url, sha, default: isDefault, deprecated } } };
  })
  .get("/api/v2/admin/terraform-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params["version_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminTerraformVersions.findFirst({ where: eq(adminTerraformVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: v.id, type: "terraform-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } } };
  })
  .patch("/api/v2/admin/terraform-versions/:version_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params["version_id"] ?? "";
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
    if (Object.keys(updates).length > 0) await db.update(adminTerraformVersions).set(updates).where(eq(adminTerraformVersions.id, versionId));
    const updated = await db.query.adminTerraformVersions.findFirst({ where: eq(adminTerraformVersions.id, versionId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "terraform-versions", attributes: { version: updated.version, url: updated.url, sha: updated.sha, default: updated.isDefault, deprecated: updated.deprecated } } };
  })
  .delete("/api/v2/admin/terraform-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const versionId = params["version_id"] ?? "";
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
    return { data: versions.map((v: VerItem): Record<string, unknown> => ({ id: v.id, type: "sentinel-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } })), ...pagination(request, number, size, totalCount) };
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
    await db.insert(adminSentinelVersions).values({ id, version, url, sha, deprecated, isDefault, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "sentinel-versions", attributes: { version, url, sha, default: isDefault, deprecated } } };
  })
  .get("/api/v2/admin/sentinel-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params["version_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminSentinelVersions.findFirst({ where: eq(adminSentinelVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: v.id, type: "sentinel-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } } };
  })
  .patch("/api/v2/admin/sentinel-versions/:version_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params["version_id"] ?? "";
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
    if (Object.keys(updates).length > 0) await db.update(adminSentinelVersions).set(updates).where(eq(adminSentinelVersions.id, versionId));
    const updated = await db.query.adminSentinelVersions.findFirst({ where: eq(adminSentinelVersions.id, versionId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "sentinel-versions", attributes: { version: updated.version, url: updated.url, sha: updated.sha, default: updated.isDefault, deprecated: updated.deprecated } } };
  })
  .delete("/api/v2/admin/sentinel-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const versionId = params["version_id"] ?? "";
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
    return { data: versions.map((v: VerItem): Record<string, unknown> => ({ id: v.id, type: "opa-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } })), ...pagination(request, number, size, totalCount) };
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
    await db.insert(adminOpaVersions).values({ id, version, url, sha, deprecated, isDefault, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "opa-versions", attributes: { version, url, sha, default: isDefault, deprecated } } };
  })
  .get("/api/v2/admin/opa-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params["version_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminOpaVersions.findFirst({ where: eq(adminOpaVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: v.id, type: "opa-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } } };
  })
  .patch("/api/v2/admin/opa-versions/:version_id", async ({ params, body, user, set }: ParamCtx): Promise<unknown> => {
    const versionId = params["version_id"] ?? "";
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
    if (Object.keys(updates).length > 0) await db.update(adminOpaVersions).set(updates).where(eq(adminOpaVersions.id, versionId));
    const updated = await db.query.adminOpaVersions.findFirst({ where: eq(adminOpaVersions.id, versionId) });
    if (updated === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: updated.id, type: "opa-versions", attributes: { version: updated.version, url: updated.url, sha: updated.sha, default: updated.isDefault, deprecated: updated.deprecated } } };
  })
  .delete("/api/v2/admin/opa-versions/:version_id", async ({ params, user, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const versionId = params["version_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminOpaVersions.findFirst({ where: eq(adminOpaVersions.id, versionId) });
    if (v === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(adminOpaVersions).where(eq(adminOpaVersions.id, versionId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Admin Settings ---
  .get("/api/v2/admin/settings", ({ user, set }: ParamCtx): unknown => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    return { data: { id: "settings", type: "settings", attributes: { "cost-estimation-enabled": false, "sentinel-enabled": true, "opa-enabled": true, "agent-enabled": false, "module-registry-enabled": true, "provider-registry-enabled": true, "max-run-timeout": 43200, "default-terraform-version": "latest" } } };
  })
  .patch("/api/v2/admin/settings", ({ user, body, set }: ParamCtx): unknown => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const costEst = typeof attrs["cost-estimation-enabled"] === "boolean" ? attrs["cost-estimation-enabled"] : false;
    return { data: { id: "settings", type: "settings", attributes: { "cost-estimation-enabled": costEst, "sentinel-enabled": true, "opa-enabled": true, "agent-enabled": false, "module-registry-enabled": true, "provider-registry-enabled": true, "max-run-timeout": 43200, "default-terraform-version": "latest" } } };
  });
