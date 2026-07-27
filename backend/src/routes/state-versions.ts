/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { Elysia } from "elysia";
import { db } from "../db";
import { stateVersions, workspaces, organizations, logs } from "../db/schema";
import { eq, and, desc, asc, inArray, count } from "drizzle-orm";
import { createHash } from "node:crypto";
import { stateVersionResource, stateOutputResources } from "../lib/response";
import { checkOrgPermission, findAuthorizedWorkspace, pageRequest, pagination, decodeStatePayload, parseStatePayload } from "../lib/utils";
import { join } from "path";
import { authPlugin } from "../auth";

const CV_STORAGE_DIR = join(process.env.STORAGE_DIR || join(import.meta.dir, "../storage"), "cv");

export const stateVersionRoutes = new Elysia({ name: "stateVersions" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/state-versions", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const where = eq(stateVersions.workspaceId, workspace_id);
    const [versions, [{ total }]] = await Promise.all([
      db.query.stateVersions.findMany({ where, orderBy: [desc(stateVersions.serial)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(stateVersions).where(where),
    ]);
    return { data: versions.map(sv => stateVersionResource(sv, request)), ...pagination(request, number, size, total) };
  })
  .get("/api/v2/workspaces/:workspace_id/current-state-version", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.workspaceId, workspace_id), orderBy: [desc(stateVersions.serial)] });
    if (!sv) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stateVersionResource(sv, request) };
  })
  .get("/api/v2/workspaces/:workspace_id/current-state-version-outputs", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.workspaceId, workspace_id), orderBy: [desc(stateVersions.serial)] });
    if (!sv) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stateOutputResources(sv) };
  })
  .get("/api/v2/state-versions/:state_version_id", async ({ params: { state_version_id }, user, orgId, request, set }) => {
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, state_version_id) });
    if (!sv) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stateVersionResource(sv, request) };
  })
  .get("/api/v2/state-versions/:state_version_id/state-version-outputs", async ({ params: { state_version_id }, user, orgId, request, set }) => {
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, state_version_id) });
    if (!sv) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const outputs = stateOutputResources(sv);
    const sliced = outputs.slice((number - 1) * size, number * size);
    return { data: sliced, ...pagination(request, number, size, outputs.length) };
  })
  .get("/api/v2/state-versions/:state_version_id/outputs", async ({ params: { state_version_id }, user, orgId, request, set }) => {
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, state_version_id) });
    if (!sv) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stateOutputResources(sv) };
  })
  .get("/api/v2/state-version-outputs/:state_version_output_id", async ({ params: { state_version_output_id }, user, orgId, set }) => {
    const match = /^wsout-([a-f0-9]+)$/.exec(state_version_output_id);
    if (!match) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: null };
  })
  .get("/api/v2/state-versions/:state_version_id/json-download", async ({ params: { state_version_id }, user, orgId, set }) => {
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, state_version_id) });
    if (!sv) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (!sv.jsonState) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    set.headers["Content-Type"] = "application/json";
    return sv.jsonState;
  })
  .delete("/api/v2/state-versions/:state_version_id", async ({ params: { state_version_id }, user, orgId, set }) => {
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, state_version_id) });
    if (!sv) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "owner", orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(stateVersions).where(eq(stateVersions.id, state_version_id));
    set.status = 204;
  })
  .get("/api/v2/state-versions/:state_version_id/download", async ({ params: { state_version_id }, user, orgId, set }) => {
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, state_version_id) });
    if (!sv) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (!ws || !(await checkOrgPermission(user?.id, ws.orgId, "member", orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = decodeStatePayload(sv.statePayload);
    set.headers["Content-Type"] = "application/json";
    return payload;
  })
  .post("/api/v2/workspaces/:workspace_id/state-versions", async ({ params: { workspace_id }, body, user, orgId, request, set }) => {
    const ws = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!ws) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body as any;
    const serial = payload?.data?.attributes?.serial;
    const statePayload = payload?.data?.attributes?.state;
    const runId = payload?.data?.relationships?.run?.data?.id ?? null;
    if (typeof serial !== "number" || !statePayload) {
      set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "param is missing or the value is empty: state" }] };
    }
    await db.update(stateVersions).set({ status: "backing_data_soft_deleted" }).where(and(eq(stateVersions.workspaceId, workspace_id), eq(stateVersions.status, "finalized")));
    const id = crypto.randomUUID();
    const parsed = parseStatePayload(statePayload);
    const lineage = typeof parsed?.lineage === "string" ? parsed.lineage : null;
    const jsonState = statePayload;
    await db.insert(stateVersions).values({
      id, workspaceId: workspace_id, serial, runId, statePayload, jsonState,
      lineage, status: "finalized", createdAt: Date.now(),
    });
    const sv = (await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, id) }))!;
    set.status = 201;
    return { data: stateVersionResource(sv, request) };
  });
