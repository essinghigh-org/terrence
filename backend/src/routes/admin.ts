/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { Elysia } from "elysia";
import { db } from "../db";
import { users, organizations, workspaces, runs, adminTerraformVersions, adminSentinelVersions, adminOpaVersions } from "../db/schema";
import { eq, and, desc, count, notInArray } from "drizzle-orm";
import { runResource } from "../lib/response";
import { pageRequest, pagination } from "../lib/utils";
import { authPlugin } from "../auth";

export const adminRoutes = new Elysia({ name: "admin" })
  .use(authPlugin)
  .get("/api/v2/admin/users", async ({ user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const allUsers = await db.query.users.findMany();
    return { data: allUsers.map(u => ({ id: u.id, type: "users", attributes: { username: u.username, email: u.email, "is-site-admin": u.isSiteAdmin === true } })) };
  })
  .get("/api/v2/admin/users/:user_id", async ({ params: { user_id }, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, user_id) });
    if (!targetUser) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: targetUser.id, type: "users", attributes: { username: targetUser.username, email: targetUser.email, "is-site-admin": targetUser.isSiteAdmin === true } } };
  })
  .patch("/api/v2/admin/users/:user_id", async ({ params: { user_id }, body, user }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, user_id) });
    if (!targetUser) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof users.$inferInsert> = {};
    if (typeof attributes.username === "string") updates.username = attributes.username;
    if (attributes.email !== undefined) updates.email = attributes.email;
    if (Object.keys(updates).length > 0) await db.update(users).set(updates).where(eq(users.id, user_id));
    const updated = (await db.query.users.findFirst({ where: eq(users.id, user_id) }))!;
    return { data: { id: updated.id, type: "users", attributes: { username: updated.username, email: updated.email, "is-site-admin": updated.isSiteAdmin === true } } };
  })
  .delete("/api/v2/admin/users/:user_id", async ({ params: { user_id }, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const targetUser = await db.query.users.findFirst({ where: eq(users.id, user_id) });
    if (!targetUser) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(users).where(eq(users.id, user_id));
    set.status = 204;
  })
  .get("/api/v2/admin/organizations", async ({ user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const allOrgs = await db.query.organizations.findMany();
    return { data: allOrgs.map(o => ({ id: o.id, type: "organizations", attributes: { name: o.name } })) };
  })
  .get("/api/v2/admin/organizations/:org_name", async ({ params: { org_name }, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: org.id, type: "organizations", attributes: { name: org.name } } };
  })
  .patch("/api/v2/admin/organizations/:org_name", async ({ params: { org_name }, body, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof organizations.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (Object.keys(updates).length > 0) await db.update(organizations).set(updates).where(eq(organizations.id, org.id));
    const updated = (await db.query.organizations.findFirst({ where: eq(organizations.id, org.id) }))!;
    return { data: { id: updated.id, type: "organizations", attributes: { name: updated.name } } };
  })
  .delete("/api/v2/admin/organizations/:org_name", async ({ params: { org_name }, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const org = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!org) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(organizations).where(eq(organizations.id, org.id));
    set.status = 204;
  })
  .get("/api/v2/admin/workspaces", async ({ user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const allWs = await db.query.workspaces.findMany();
    return { data: allWs.map(w => ({ id: w.id, type: "workspaces", attributes: { name: w.name, "terraform-version": w.terraformVersion, locked: w.locked } })) };
  })
  .get("/api/v2/admin/workspaces/:ws_id", async ({ params: { ws_id }, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, ws_id) });
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: ws.id, type: "workspaces", attributes: { name: ws.name, "terraform-version": ws.terraformVersion, locked: ws.locked } } };
  })
  .patch("/api/v2/admin/workspaces/:ws_id", async ({ params: { ws_id }, body, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, ws_id) });
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attributes = (body as any)?.data?.attributes ?? {};
    const updates: Partial<typeof workspaces.$inferInsert> = {};
    if (typeof attributes.name === "string") updates.name = attributes.name;
    if (typeof attributes["terraform-version"] === "string") updates.terraformVersion = attributes["terraform-version"];
    if (typeof attributes.locked === "boolean") updates.locked = attributes.locked;
    if (Object.keys(updates).length > 0) await db.update(workspaces).set(updates).where(eq(workspaces.id, ws_id));
    const updated = (await db.query.workspaces.findFirst({ where: eq(workspaces.id, ws_id) }))!;
    return { data: { id: updated.id, type: "workspaces", attributes: { name: updated.name, "terraform-version": updated.terraformVersion, locked: updated.locked } } };
  })
  .delete("/api/v2/admin/workspaces/:ws_id", async ({ params: { ws_id }, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, ws_id) });
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(workspaces).where(eq(workspaces.id, ws_id));
    set.status = 204;
  })
  .get("/api/v2/admin/runs", async ({ user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const allRuns = await db.query.runs.findMany();
    return { data: allRuns.map(r => ({ id: r.id, type: "runs", attributes: { status: r.status, "created-at": new Date(r.createdAt).toISOString() } })) };
  })
  .get("/api/v2/admin/runs/:run_id", async ({ params: { run_id }, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, run_id) });
    if (!run) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: runResource(run, true) };
  })
  .post("/api/v2/admin/runs/:run_id/actions/cancel", async ({ params: { run_id }, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, run_id) });
    if (!run) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const updated = await db.update(runs).set({ status: "canceled" }).where(and(eq(runs.id, run_id), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"]))).returning();
    if (updated.length === 0) { set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not cancelable" }] }; }
    return { data: runResource(updated[0], true) };
  })
  .post("/api/v2/admin/runs/:run_id/actions/force-cancel", async ({ params: { run_id }, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, run_id) });
    if (!run) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const updated = await db.update(runs).set({ status: "force_canceled" }).where(and(eq(runs.id, run_id), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"]))).returning();
    if (updated.length === 0) { set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not force-cancelable" }] }; }
    return { data: runResource(updated[0], true) };
  })
  // --- Terraform Versions ---
  .get("/api/v2/admin/terraform-versions", async ({ user, request, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const { number, size } = pageRequest(request);
    const [versions, [{ total }]] = await Promise.all([
      db.query.adminTerraformVersions.findMany({ orderBy: [desc(adminTerraformVersions.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(adminTerraformVersions),
    ]);
    return { data: versions.map(v => ({ id: v.id, type: "terraform-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } })), ...pagination(request, number, size, total) };
  })
  .post("/api/v2/admin/terraform-versions", async ({ body, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const attrs = (body as any)?.data?.attributes || {};
    if (!attrs.version) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Version is required" }] }; }
    const id = `tfver-${crypto.randomUUID()}`;
    await db.insert(adminTerraformVersions).values({ id, version: attrs.version, url: attrs.url ?? null, sha: attrs.sha ?? null, deprecated: attrs.deprecated ?? false, isDefault: attrs.default ?? false, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "terraform-versions", attributes: { version: attrs.version, url: attrs.url ?? null, sha: attrs.sha ?? null, default: attrs.default ?? false, deprecated: attrs.deprecated ?? false } } };
  })
  .get("/api/v2/admin/terraform-versions/:version_id", async ({ params: { version_id }, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminTerraformVersions.findFirst({ where: eq(adminTerraformVersions.id, version_id) });
    if (!v) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: v.id, type: "terraform-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } } };
  })
  .patch("/api/v2/admin/terraform-versions/:version_id", async ({ params: { version_id }, body, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminTerraformVersions.findFirst({ where: eq(adminTerraformVersions.id, version_id) });
    if (!v) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = (body as any)?.data?.attributes || {};
    const updates: Partial<typeof adminTerraformVersions.$inferInsert> = {};
    if (attrs.version !== undefined) updates.version = attrs.version;
    if (attrs.url !== undefined) updates.url = attrs.url;
    if (attrs.sha !== undefined) updates.sha = attrs.sha;
    if (attrs.deprecated !== undefined) updates.deprecated = attrs.deprecated;
    if (attrs.default !== undefined) updates.isDefault = attrs.default;
    if (Object.keys(updates).length > 0) await db.update(adminTerraformVersions).set(updates).where(eq(adminTerraformVersions.id, version_id));
    const updated = (await db.query.adminTerraformVersions.findFirst({ where: eq(adminTerraformVersions.id, version_id) }))!;
    return { data: { id: updated.id, type: "terraform-versions", attributes: { version: updated.version, url: updated.url, sha: updated.sha, default: updated.isDefault, deprecated: updated.deprecated } } };
  })
  .delete("/api/v2/admin/terraform-versions/:version_id", async ({ params: { version_id }, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminTerraformVersions.findFirst({ where: eq(adminTerraformVersions.id, version_id) });
    if (!v) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(adminTerraformVersions).where(eq(adminTerraformVersions.id, version_id));
    set.status = 204;
  })
  // --- Sentinel Versions ---
  .get("/api/v2/admin/sentinel-versions", async ({ user, request, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const { number, size } = pageRequest(request);
    const [versions, [{ total }]] = await Promise.all([
      db.query.adminSentinelVersions.findMany({ orderBy: [desc(adminSentinelVersions.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(adminSentinelVersions),
    ]);
    return { data: versions.map(v => ({ id: v.id, type: "sentinel-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } })), ...pagination(request, number, size, total) };
  })
  .post("/api/v2/admin/sentinel-versions", async ({ body, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const attrs = (body as any)?.data?.attributes || {};
    if (!attrs.version) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `sver-${crypto.randomUUID()}`;
    await db.insert(adminSentinelVersions).values({ id, version: attrs.version, url: attrs.url ?? null, sha: attrs.sha ?? null, deprecated: attrs.deprecated ?? false, isDefault: attrs.default ?? false, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "sentinel-versions", attributes: { version: attrs.version, url: attrs.url ?? null, sha: attrs.sha ?? null, default: attrs.default ?? false, deprecated: attrs.deprecated ?? false } } };
  })
  .get("/api/v2/admin/sentinel-versions/:version_id", async ({ params: { version_id }, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminSentinelVersions.findFirst({ where: eq(adminSentinelVersions.id, version_id) });
    if (!v) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: v.id, type: "sentinel-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } } };
  })
  .patch("/api/v2/admin/sentinel-versions/:version_id", async ({ params: { version_id }, body, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminSentinelVersions.findFirst({ where: eq(adminSentinelVersions.id, version_id) });
    if (!v) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = (body as any)?.data?.attributes || {};
    const updates: Partial<typeof adminSentinelVersions.$inferInsert> = {};
    if (attrs.version !== undefined) updates.version = attrs.version;
    if (attrs.url !== undefined) updates.url = attrs.url;
    if (attrs.sha !== undefined) updates.sha = attrs.sha;
    if (attrs.deprecated !== undefined) updates.deprecated = attrs.deprecated;
    if (attrs.default !== undefined) updates.isDefault = attrs.default;
    if (Object.keys(updates).length > 0) await db.update(adminSentinelVersions).set(updates).where(eq(adminSentinelVersions.id, version_id));
    const updated = (await db.query.adminSentinelVersions.findFirst({ where: eq(adminSentinelVersions.id, version_id) }))!;
    return { data: { id: updated.id, type: "sentinel-versions", attributes: { version: updated.version, url: updated.url, sha: updated.sha, default: updated.isDefault, deprecated: updated.deprecated } } };
  })
  .delete("/api/v2/admin/sentinel-versions/:version_id", async ({ params: { version_id }, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminSentinelVersions.findFirst({ where: eq(adminSentinelVersions.id, version_id) });
    if (!v) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(adminSentinelVersions).where(eq(adminSentinelVersions.id, version_id));
    set.status = 204;
  })
  // --- OPA Versions ---
  .get("/api/v2/admin/opa-versions", async ({ user, request, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const { number, size } = pageRequest(request);
    const [versions, [{ total }]] = await Promise.all([
      db.query.adminOpaVersions.findMany({ orderBy: [desc(adminOpaVersions.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(adminOpaVersions),
    ]);
    return { data: versions.map(v => ({ id: v.id, type: "opa-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } })), ...pagination(request, number, size, total) };
  })
  .post("/api/v2/admin/opa-versions", async ({ body, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const attrs = (body as any)?.data?.attributes || {};
    if (!attrs.version) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `opa-${crypto.randomUUID()}`;
    await db.insert(adminOpaVersions).values({ id, version: attrs.version, url: attrs.url ?? null, sha: attrs.sha ?? null, deprecated: attrs.deprecated ?? false, isDefault: attrs.default ?? false, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "opa-versions", attributes: { version: attrs.version, url: attrs.url ?? null, sha: attrs.sha ?? null, default: attrs.default ?? false, deprecated: attrs.deprecated ?? false } } };
  })
  .get("/api/v2/admin/opa-versions/:version_id", async ({ params: { version_id }, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminOpaVersions.findFirst({ where: eq(adminOpaVersions.id, version_id) });
    if (!v) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: { id: v.id, type: "opa-versions", attributes: { version: v.version, url: v.url, sha: v.sha, default: v.isDefault, deprecated: v.deprecated } } };
  })
  .patch("/api/v2/admin/opa-versions/:version_id", async ({ params: { version_id }, body, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminOpaVersions.findFirst({ where: eq(adminOpaVersions.id, version_id) });
    if (!v) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const attrs = (body as any)?.data?.attributes || {};
    const updates: Partial<typeof adminOpaVersions.$inferInsert> = {};
    if (attrs.version !== undefined) updates.version = attrs.version;
    if (attrs.url !== undefined) updates.url = attrs.url;
    if (attrs.sha !== undefined) updates.sha = attrs.sha;
    if (attrs.deprecated !== undefined) updates.deprecated = attrs.deprecated;
    if (attrs.default !== undefined) updates.isDefault = attrs.default;
    if (Object.keys(updates).length > 0) await db.update(adminOpaVersions).set(updates).where(eq(adminOpaVersions.id, version_id));
    const updated = (await db.query.adminOpaVersions.findFirst({ where: eq(adminOpaVersions.id, version_id) }))!;
    return { data: { id: updated.id, type: "opa-versions", attributes: { version: updated.version, url: updated.url, sha: updated.sha, default: updated.isDefault, deprecated: updated.deprecated } } };
  })
  .delete("/api/v2/admin/opa-versions/:version_id", async ({ params: { version_id }, user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const v = await db.query.adminOpaVersions.findFirst({ where: eq(adminOpaVersions.id, version_id) });
    if (!v) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(adminOpaVersions).where(eq(adminOpaVersions.id, version_id));
    set.status = 204;
  })
  // --- Admin Settings ---
  .get("/api/v2/admin/settings", async ({ user, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    return { data: { id: "settings", type: "settings", attributes: { "cost-estimation-enabled": false, "sentinel-enabled": true, "opa-enabled": true, "agent-enabled": false, "module-registry-enabled": true, "provider-registry-enabled": true, "max-run-timeout": 43200, "default-terraform-version": "latest" } } };
  })
  .patch("/api/v2/admin/settings", async ({ user, body, set }) => {
    if (!user?.isSiteAdmin) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    return { data: { id: "settings", type: "settings", attributes: { "cost-estimation-enabled": (body as any)?.data?.attributes?.["cost-estimation-enabled"] ?? false, "sentinel-enabled": true, "opa-enabled": true, "agent-enabled": false, "module-registry-enabled": true, "provider-registry-enabled": true, "max-run-timeout": 43200, "default-terraform-version": "latest" } } };
  });
