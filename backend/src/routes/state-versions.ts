import { Elysia } from "elysia";
import { db } from "../db";
import { stateVersions, workspaces, type users } from "../db/schema";
import { eq, and, desc, count } from "drizzle-orm";
import { stateVersionResource, stateOutputResources } from "../lib/response";
import { checkOrgPermission, findAuthorizedWorkspace, pageRequest, pagination, decodeStatePayload, parseStatePayload } from "../lib/utils";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId?: string | null;
  request: Readonly<{ url: string }>;
  set: SetObj;
}>;

export const stateVersionRoutes = new Elysia({ name: "stateVersions" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/state-versions", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const where = eq(stateVersions.workspaceId, workspaceId);
    const [versions, countRows] = await Promise.all([
      db.query.stateVersions.findMany({ where, orderBy: [desc(stateVersions.serial)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(stateVersions).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: versions.map((sv: Readonly<typeof stateVersions.$inferSelect>): Record<string, unknown> => stateVersionResource(sv, request)), ...pagination(request, number, size, totalCount) };
  })
  .get("/api/v2/workspaces/:workspace_id/current-state-version", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.workspaceId, workspaceId), orderBy: [desc(stateVersions.serial)] });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stateVersionResource(sv, request) };
  })
  .get("/api/v2/workspaces/:workspace_id/current-state-version-outputs", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.workspaceId, workspaceId), orderBy: [desc(stateVersions.serial)] });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stateOutputResources(sv) };
  })
  .get("/api/v2/state-versions/:state_version_id", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", orgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stateVersionResource(sv, request) };
  })
  .get("/api/v2/state-versions/:state_version_id/state-version-outputs", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", orgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const outputs = stateOutputResources(sv);
    const sliced = outputs.slice((number - 1) * size, number * size);
    return { data: sliced, ...pagination(request, number, size, outputs.length) };
  })
  .get("/api/v2/state-versions/:state_version_id/outputs", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", orgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stateOutputResources(sv) };
  })
  .get("/api/v2/state-version-outputs/:state_version_output_id", ({ params, set }: ParamCtx): unknown => {
    const stateVersionOutputId = params["state_version_output_id"] ?? "";
    const match = /^wsout-([a-f0-9]+)$/.exec(stateVersionOutputId);
    if (match === null) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: null };
  })
  .get("/api/v2/state-versions/:state_version_id/json-download", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", orgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (sv.jsonState === "") { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    (set.headers as Record<string, string>)["Content-Type"] = "application/json";
    return sv.jsonState;
  })
  .delete("/api/v2/state-versions/:state_version_id", async ({ params, user, orgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "owner", orgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(stateVersions).where(eq(stateVersions.id, stateVersionId));
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/state-versions/:state_version_id/download", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params["state_version_id"] ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkOrgPermission(user?.id, ws.orgId, "member", orgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = decodeStatePayload(sv.statePayload);
    (set.headers as Record<string, string>)["Content-Type"] = "application/json";
    return payload;
  })
  .post("/api/v2/workspaces/:workspace_id/state-versions", async ({ params, body, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
    const runRel = typeof rels.run === "object" && rels.run !== null ? (rels.run as Record<string, unknown>) : {};
    const runData = typeof runRel.data === "object" && runRel.data !== null ? (runRel.data as Record<string, unknown>) : {};
    const serial = typeof attributes.serial === "number" ? attributes.serial : undefined;
    const statePayload = typeof attributes.state === "string" ? attributes.state : undefined;
    const runId = typeof runData.id === "string" ? runData.id : null;
    if (serial === undefined || statePayload === undefined || statePayload === "") {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "param is missing or the value is empty: state" }] };
    }
    await db.update(stateVersions).set({ status: "backing_data_soft_deleted" }).where(and(eq(stateVersions.workspaceId, workspaceId), eq(stateVersions.status, "finalized")));
    const id = crypto.randomUUID();
    const parsed = parseStatePayload(statePayload);
    const lineage = typeof parsed?.lineage === "string" ? parsed.lineage : null;
    const jsonState = statePayload;
    await db.insert(stateVersions).values({
      id, workspaceId, serial, runId, statePayload, jsonState,
      lineage, status: "finalized", createdAt: Date.now(),
    });
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, id) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    (set as { status: number }).status = 201;
    return { data: stateVersionResource(sv, request) };
  });
