import { Elysia } from "elysia";
import { db } from "../db";
import { stateVersions, workspaces, runs, type users } from "../db/schema";
import { eq, and, desc, count, inArray } from "drizzle-orm";
import { stateVersionResource, stateOutputResources } from "../lib/response";
import {
  checkWorkspacePermission,
  findAuthorizedWorkspace,
  pageRequest,
  pagination,
  decodeStatePayload,
  parseStatePayload,
  validSignedApiURL,
} from "../lib/utils";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  request: Readonly<{ url: string; arrayBuffer: () => Promise<ArrayBuffer> }>;
  set: SetObj;
}>;

async function requestBodyText(
  body: unknown,
  request: Readonly<{ arrayBuffer: () => Promise<ArrayBuffer> }>,
): Promise<string> {
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  if (body instanceof Blob) return body.text();
  if (body !== undefined && body !== null) return JSON.stringify(body);
  return new TextDecoder().decode(await request.arrayBuffer());
}

export const stateVersionRoutes = new Elysia({ name: "stateVersions" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/state-versions", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "state-read");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const where = eq(stateVersions.workspaceId, workspaceId);
    const [versions, countRows] = await Promise.all([
      db.query.stateVersions.findMany({ where, orderBy: [desc(stateVersions.serial)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(stateVersions).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    // Batch-fetch runs for state versions that have runId set
    const runIds = [...new Set(versions.map((sv): string | null => sv.runId).filter((id): id is string => id !== null))];
    const runMap = new Map<string, Readonly<{ status: string; message: string | null }>>();
    if (runIds.length > 0) {
      const runRows = await db.query.runs.findMany({
        where: inArray(runs.id, runIds),
        columns: { id: true, status: true, message: true },
      });
      for (const r of runRows) {
        runMap.set(r.id, { status: r.status, message: r.message });
      }
    }
    return {
      data: versions.map((sv: Readonly<typeof stateVersions.$inferSelect>): Record<string, unknown> =>
        stateVersionResource(sv, request, false, sv.runId !== null ? (runMap.get(sv.runId) ?? null) : null),
      ),
      ...pagination(request, number, size, totalCount),
    };
  })
  .get("/api/v2/workspaces/:workspace_id/current-state-version", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "state-read");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const sv = await db.query.stateVersions.findFirst({
      where: and(
        eq(stateVersions.workspaceId, workspaceId),
        eq(stateVersions.status, "finalized"),
        eq(stateVersions.intermediate, false),
      ),
      orderBy: [desc(stateVersions.serial)],
    });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const runData = sv.runId !== null
      ? await db.query.runs.findFirst({ where: eq(runs.id, sv.runId), columns: { status: true, message: true } })
      : null;
    return { data: stateVersionResource(sv, request, true, runData ?? null) };
  })
  .get("/api/v2/workspaces/:workspace_id/current-state-version-outputs", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "state-outputs");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const sv = await db.query.stateVersions.findFirst({
      where: and(
        eq(stateVersions.workspaceId, workspaceId),
        eq(stateVersions.status, "finalized"),
        eq(stateVersions.intermediate, false),
      ),
      orderBy: [desc(stateVersions.serial)],
    });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: stateOutputResources(sv) };
  })
  .get("/api/v2/state-versions/:state_version_id", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-read"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(sv.status ?? "")) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const runData = sv.runId !== null
      ? await db.query.runs.findFirst({ where: eq(runs.id, sv.runId), columns: { status: true, message: true } })
      : null;
    return { data: stateVersionResource(sv, request, true, runData ?? null) };
  })
  .get("/api/v2/state-versions/:state_version_id/state-version-outputs", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    if ((user === undefined || user === null) && orgId === null && teamId === null) {
      (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-outputs"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(sv.status ?? "")) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const outputs = stateOutputResources(sv);
    const sliced = outputs.slice((number - 1) * size, number * size);
    return { data: sliced, ...pagination(request, number, size, outputs.length) };
  })
  .get("/api/v2/state-versions/:state_version_id/outputs", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if ((user === undefined || user === null) && orgId === null && teamId === null) {
      (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-outputs"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(sv.status ?? "")) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: stateOutputResources(sv) };
  })
  .get("/api/v2/state-version-outputs/:state_version_output_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    if ((user === undefined || user === null) && orgId === null && teamId === null) {
      (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const stateVersionOutputId = params.state_version_output_id ?? "";
    if (!/^wsout-[a-f0-9]{16}$/.test(stateVersionOutputId)) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const versions = await db.query.stateVersions.findMany();
    // Pre-fetch all relevant workspaces to avoid N+1
    const wsIds = [...new Set(versions.map((sv): string => sv.workspaceId))];
    const workspacesById = wsIds.length === 0
      ? new Map<string, typeof workspaces.$inferSelect>()
      : new Map(
          (await db.query.workspaces.findMany({
            where: inArray(workspaces.id, wsIds),
          })).map((ws): [string, typeof workspaces.$inferSelect] => [ws.id, ws]),
        );
    for (const stateVersion of versions) {
      if (["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(stateVersion.status ?? "")) continue;
      const output = stateOutputResources(stateVersion).find(({ id }): boolean => id === stateVersionOutputId);
      if (output === undefined) continue;
      const ws = workspacesById.get(stateVersion.workspaceId);
      if (ws !== undefined && await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-outputs")) {
        return { data: output };
      }
      break;
    }
    (set as { status: number }).status = 404;
    return { errors: [{ status: "404", title: "Not Found" }] };
  })
  .get("/api/v2/state-versions/:state_version_id/json-download", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    const path = `/api/v2/state-versions/${stateVersionId}/json-download`;
    if (ws === undefined || (!validSignedApiURL(request, path) && !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-read")))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (
      typeof sv.jsonState !== "string"
      || sv.jsonState === ""
      || ["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(sv.status ?? "")
    ) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    (set.headers as Record<string, string>)["Content-Type"] = "application/json";
    return sv.jsonState;
  })
  .delete("/api/v2/state-versions/:state_version_id", async ({ params, user, orgId, teamId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "admin"))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.update(stateVersions).set({ status: "discarded", softDeletedAt: null }).where(eq(stateVersions.id, stateVersionId));
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/state-versions/:state_version_id/download", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    const path = `/api/v2/state-versions/${stateVersionId}/download`;
    if (ws === undefined || (!validSignedApiURL(request, path) && !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-read")))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (
      typeof sv.statePayload !== "string"
      || sv.statePayload === ""
      || ["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(sv.status ?? "")
    ) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const payload = decodeStatePayload(sv.statePayload);
    (set.headers as Record<string, string>)["Content-Type"] = "application/json";
    return payload;
  })
  .put("/api/v2/state-versions/:state_version_id/upload", async ({ params, body, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    const path = `/api/v2/state-versions/${stateVersionId}/upload`;
    if (ws === undefined || (!validSignedApiURL(request, path, "PUT") && !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-write")))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (sv.status !== "pending" || (typeof sv.statePayload === "string" && sv.statePayload !== "")) {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "State content was already uploaded" }] };
    }
    const rawState = await requestBodyText(body, request);
    if (rawState === "" || parseStatePayload(rawState) === null) {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "State content must be valid JSON" }] };
    }
    await db.update(stateVersions).set({ statePayload: rawState, status: "finalized" }).where(eq(stateVersions.id, stateVersionId));
    (set as { status: number }).status = 200;
    return {};
  })
  .put("/api/v2/state-versions/:state_version_id/json-upload", async ({ params, body, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    const path = `/api/v2/state-versions/${stateVersionId}/json-upload`;
    if (ws === undefined || (!validSignedApiURL(request, path, "PUT") && !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-write")))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (typeof sv.jsonState === "string" && sv.jsonState !== "") {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "JSON state content was already uploaded" }] };
    }
    const jsonState = await requestBodyText(body, request);
    if (jsonState === "" || parseStatePayload(jsonState) === null) {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "JSON state content must be valid JSON" }] };
    }
    await db.update(stateVersions).set({ jsonState }).where(eq(stateVersions.id, stateVersionId));
    (set as { status: number }).status = 200;
    return {};
  })
  .put("/api/v2/state-versions/:state_version_id/json-outputs-upload", async ({ params, body, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    const path = `/api/v2/state-versions/${stateVersionId}/json-outputs-upload`;
    if (ws === undefined || (!validSignedApiURL(request, path, "PUT") && !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-write")))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const jsonStateOutputs = await requestBodyText(body, request);
    if (jsonStateOutputs === "" || parseStatePayload(jsonStateOutputs) === null) {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "JSON state outputs must be valid JSON" }] };
    }
    await db.update(stateVersions).set({ jsonStateOutputs }).where(eq(stateVersions.id, stateVersionId));
    (set as { status: number }).status = 200;
    return {};
  })
  .post("/api/v2/state-versions/:state_version_id/actions/rollback", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-write"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (sv.statePayload === null || sv.status !== "finalized") {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "State version cannot be rolled back" }] };
    }
    const latest = await db.query.stateVersions.findFirst({
      where: eq(stateVersions.workspaceId, sv.workspaceId),
      orderBy: [desc(stateVersions.serial)],
    });
    const newSerial = (latest?.serial ?? 0) + 1;
    const newId = crypto.randomUUID();
    await db.insert(stateVersions).values({
      id: newId,
      workspaceId: sv.workspaceId,
      serial: newSerial,
      runId: null,
      statePayload: sv.statePayload,
      jsonState: sv.jsonState,
      jsonStateOutputs: sv.jsonStateOutputs,
      intermediate: false,
      status: "finalized",
      createdAt: Date.now(),
    });
    const newSv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, newId) });
    if (newSv === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    (set as { status: number }).status = 201;
    return { data: stateVersionResource(newSv, request) };
  })
  .post("/api/v2/state-versions/:state_version_id/actions/soft_delete_backing_data", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "admin"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const current = await db.query.stateVersions.findFirst({
      where: and(
        eq(stateVersions.workspaceId, sv.workspaceId),
        eq(stateVersions.status, "finalized"),
        eq(stateVersions.intermediate, false),
      ),
      orderBy: [desc(stateVersions.serial)],
      columns: { id: true },
    });
    if (sv.status !== "finalized" || current?.id === sv.id) {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request" }] };
    }
    const softDeletedAt = Date.now();
    await db.update(stateVersions).set({ status: "backing_data_soft_deleted", softDeletedAt }).where(eq(stateVersions.id, sv.id));
    return { data: stateVersionResource({ ...sv, status: "backing_data_soft_deleted", softDeletedAt }, request) };
  })
  .post("/api/v2/state-versions/:state_version_id/actions/restore_backing_data", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "admin"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (sv.status !== "backing_data_soft_deleted") {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request" }] };
    }
    await db.update(stateVersions).set({ status: "finalized", softDeletedAt: null }).where(eq(stateVersions.id, sv.id));
    return { data: stateVersionResource({ ...sv, status: "finalized", softDeletedAt: null }, request) };
  })
  .post("/api/v2/state-versions/:state_version_id/actions/permanently_delete_backing_data", async ({ params, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "admin"))) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    if (sv.status !== "backing_data_soft_deleted") {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request" }] };
    }
    const deleted = await db.update(stateVersions).set({
      status: "backing_data_permanently_deleted",
      statePayload: null,
      jsonState: null,
      jsonStateOutputs: null,
    }).where(and(
      eq(stateVersions.id, sv.id),
      eq(stateVersions.status, "backing_data_soft_deleted"),
    )).returning({ id: stateVersions.id });
    if (deleted.length === 0) {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict" }] };
    }
    return {
      data: stateVersionResource({
        ...sv,
        status: "backing_data_permanently_deleted",
        statePayload: null,
        jsonState: null,
        jsonStateOutputs: null,
      }, request),
    };
  })
  .post("/api/v2/workspaces/:workspace_id/state-versions", async ({ params, body, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "state-write");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
    const runRel = typeof rels.run === "object" && rels.run !== null ? (rels.run as Record<string, unknown>) : {};
    const runData = typeof runRel.data === "object" && runRel.data !== null ? (runRel.data as Record<string, unknown>) : {};
    const serial = typeof attributes.serial === "number" ? attributes.serial : undefined;
    const inlineState = typeof attributes.state === "string" ? attributes.state : undefined;
    const statePayload = inlineState !== undefined && inlineState !== "" ? decodeStatePayload(inlineState) : null;
    const inlineJsonState = typeof attributes["json-state"] === "string" ? attributes["json-state"] : undefined;
    const jsonState = inlineJsonState !== undefined && inlineJsonState !== "" ? decodeStatePayload(inlineJsonState) : null;
    const inlineJsonStateOutputs = typeof attributes["json-state-outputs"] === "string" ? attributes["json-state-outputs"] : undefined;
    const jsonStateOutputs = inlineJsonStateOutputs !== undefined && inlineJsonStateOutputs !== ""
      ? decodeStatePayload(inlineJsonStateOutputs)
      : null;
    const runId = typeof runData.id === "string" ? runData.id : null;
    const intermediate = attributes.intermediate === true;
    if (serial === undefined) {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "param is missing or the value is empty: serial" }] };
    }
    if (ws.locked === true && !intermediate) {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace is locked" }] };
    }
    if (intermediate && ws.locked !== true) {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Intermediate state requires a locked workspace" }] };
    }
    if (statePayload !== null && parseStatePayload(statePayload) === null) {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "State content must be valid JSON" }] };
    }
    if (jsonState !== null && parseStatePayload(jsonState) === null) {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "JSON state content must be valid JSON" }] };
    }
    const id = crypto.randomUUID();
    await db.insert(stateVersions).values({
      id,
      workspaceId,
      serial,
      runId,
      statePayload,
      jsonState: jsonState ?? statePayload,
      jsonStateOutputs,
      intermediate,
      status: statePayload === null ? "pending" : "finalized",
      createdAt: Date.now(),
    });
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, id) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    (set as { status: number }).status = 201;
    return { data: stateVersionResource(sv, request) };
  });
