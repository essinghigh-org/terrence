import { Elysia } from "elysia";
import { createHash } from "node:crypto";
import { db } from "../db";
import { stateVersions, workspaces, runs, organizationMemberships, teams, type users } from "../db/schema";
import { eq, and, desc, count, inArray } from "drizzle-orm";
import { stateVersionResource, stateOutputResources } from "../lib/response";
import { encryptStatePayload, parseTerraformStatePayload } from "../lib/validation";
import {
  checkWorkspacePermission,
  checkRunStateAccess,
  findAuthorizedWorkspace,
  findRemoteStateReadableWorkspace,
  pageRequest,
  pagination,
  decodeStatePayload,
  parseStatePayload,
  validSignedApiURL,
  auditLog,
  workspaceIdsForPermission,
  lockPrincipal,
  ownsWorkspaceLock,
} from "../lib/utils";
import { isUniqueConstraintError } from "../lib/validation";
import { authPlugin } from "../auth";
import { scheduleExplorerInventory } from "../lib/explorer-inventory";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  params: Readonly<Record<string, string>>;
  body?: unknown;
  user?: Readonly<typeof users.$inferSelect> | null;
  orgId: string | null;
  teamId: string | null;
  run: { runId: string; workspaceId: string; organizationId: string } | null;
  request: Readonly<{ url: string; headers: Headers; arrayBuffer: () => Promise<ArrayBuffer> }>;
  set: SetObj;
}>;

const MAX_IMPORTED_STATE_BYTES = 100 * 1024 * 1024;

async function withStateSerialRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error) || attempt === 2) throw error;
    }
  }
  throw new Error("State serial allocation failed");
}

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
  .get("/api/v2/state-versions", async ({ request, user, orgId, teamId, set }: ParamCtx): Promise<unknown> => {
    const url = new URL(request.url);
    const workspaceFilter = url.searchParams.get("filter[workspace][id]") || null;
    const runFilter = url.searchParams.get("filter[run][id]") || null;
    if ((user === null || user === undefined) && orgId === null && teamId === null) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    let candidateWorkspaces: Array<{ id: string; orgId: string }>;
    if (workspaceFilter !== null) {
      candidateWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.id, workspaceFilter), columns: { id: true, orgId: true } });
    } else {
      const teamOrg = teamId === null ? undefined : await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { orgId: true } });
      const principalOrgId = orgId ?? teamOrg?.orgId ?? null;
      const visibleOrgIds = principalOrgId !== null
        ? [principalOrgId]
        : user?.isSiteAdmin === true
          ? null
          : user === null || user === undefined
            ? []
            : (await db.query.organizationMemberships.findMany({ where: and(eq(organizationMemberships.userId, user.id), eq(organizationMemberships.status, "active")), columns: { orgId: true } })).map((membership) => membership.orgId);
      candidateWorkspaces = visibleOrgIds === null
        ? await db.query.workspaces.findMany({ columns: { id: true, orgId: true } })
        : visibleOrgIds.length === 0
          ? []
          : await db.query.workspaces.findMany({ where: inArray(workspaces.orgId, visibleOrgIds), columns: { id: true, orgId: true } });
    }
    const allowedWorkspaceIds = new Set<string>();
    for (const org of new Set(candidateWorkspaces.map((workspace): string => workspace.orgId))) {
      const authorized = await workspaceIdsForPermission(org, user?.id, orgId, teamId, "state-read");
      if (authorized === null) {
        for (const workspace of candidateWorkspaces) if (workspace.orgId === org) allowedWorkspaceIds.add(workspace.id);
      } else {
        for (const workspaceId of authorized) allowedWorkspaceIds.add(workspaceId);
      }
    }
    if (allowedWorkspaceIds.size === 0) {
      const { number, size } = pageRequest(request);
      return { data: [], ...pagination(request, number, size, 0) };
    }
    const conditions = [inArray(stateVersions.workspaceId, [...allowedWorkspaceIds])];
    if (workspaceFilter !== null) conditions.push(eq(stateVersions.workspaceId, workspaceFilter));
    if (runFilter !== null) conditions.push(eq(stateVersions.runId, runFilter));
    const where = and(...conditions);
    const { number, size } = pageRequest(request);
    const [versions, countRows] = await Promise.all([
      db.query.stateVersions.findMany({ where, orderBy: [desc(stateVersions.serial), desc(stateVersions.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(stateVersions).where(where),
    ]);
    const runIds = [...new Set(versions.map((version): string | null => version.runId).filter((id): id is string => id !== null))];
    const runRows = runIds.length === 0 ? [] : await db.query.runs.findMany({ where: inArray(runs.id, runIds), columns: { id: true, status: true, message: true } });
    const runMap = new Map(runRows.map((run): [string, { status: string; message: string | null }] => [run.id, { status: run.status, message: run.message }]));
    return {
      data: versions.map((version): Record<string, unknown> => stateVersionResource(version, request, false, version.runId === null ? null : runMap.get(version.runId) ?? null)),
      ...pagination(request, number, size, countRows[0]?.total ?? 0),
    };
  })
  .get("/api/v2/workspaces/:workspace_id/state-versions", async ({ params, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = run !== null && run.workspaceId === workspaceId
    ? await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) })
    : await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "state-read");
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
  .get("/api/v2/workspaces/:workspace_id/current-state-version", async ({ params, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = run !== null && run.workspaceId === workspaceId
      ? await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) })
      : await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "state-read");
    // Remote-state consumer grant: a run in another workspace may read this
    // workspace's current state when a consumer link / project / global grant
    // exists (the reference format remote-state sharing). Denied reads fall through to 404.
    const resolvedWs = ws === undefined && run !== null
      ? await findRemoteStateReadableWorkspace(workspaceId, run.workspaceId)
      : ws;
    if (resolvedWs === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
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
  .get("/api/v2/workspaces/:workspace_id/current-state-version-outputs", async ({ params, user, orgId, teamId, run, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = run !== null && run.workspaceId === workspaceId
      ? await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) })
      : await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "state-outputs");
    // Remote-state consumer grant (see current-state-version above).
    const resolvedWs = ws === undefined && run !== null
      ? await findRemoteStateReadableWorkspace(workspaceId, run.workspaceId)
      : ws;
    if (resolvedWs === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
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
  .patch("/api/v2/workspaces/:workspace_id/state-versions", async ({ params, body, user, orgId, teamId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const workspace = await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "state-write");
    if (workspace === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (orgId !== null && orgId !== undefined) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden", detail: "Organization tokens cannot roll back state" }] }; }
    if (!ownsWorkspaceLock(workspace, lockPrincipal(user?.id, orgId, teamId))) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace must be locked by the caller before rollback" }] }; }
    const payload = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const data = payload.data !== null && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const relationships = data.relationships !== null && typeof data.relationships === "object" ? data.relationships as Record<string, unknown> : {};
    const rollback = relationships["rollback-state-version"];
    const rollbackData = rollback !== null && typeof rollback === "object" ? (rollback as Record<string, unknown>).data : null;
    const sourceId = rollbackData !== null && typeof rollbackData === "object" && typeof (rollbackData as Record<string, unknown>).id === "string" ? (rollbackData as Record<string, unknown>).id as string : "";
    if (sourceId === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "rollback-state-version is required" }] }; }
    const source = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, sourceId) });
    if (source === undefined || source.workspaceId !== workspaceId || source.status !== "finalized" || source.statePayload === null) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "State version cannot be rolled back" }] }; }
    const id = crypto.randomUUID();
    await withStateSerialRetry(() => db.transaction(async (tx): Promise<void> => {
      const latest = await tx.query.stateVersions.findFirst({ where: eq(stateVersions.workspaceId, workspaceId), orderBy: [desc(stateVersions.serial)] });
      await tx.insert(stateVersions).values({
        id,
        workspaceId,
        serial: (latest?.serial ?? 0) + 1,
        statePayload: encryptStatePayload(source.statePayload),
        jsonState: encryptStatePayload(source.jsonState),
        jsonStateOutputs: encryptStatePayload(source.jsonStateOutputs),
        vcsCommitSha: source.vcsCommitSha,
        vcsCommitUrl: source.vcsCommitUrl,
        runId: null,
        terraformVersion: source.terraformVersion,
        intermediate: false,
        status: "finalized",
        createdAt: Date.now(),
      });
    }));
    scheduleExplorerInventory(workspaceId);
    const created = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, id) });
    if (created === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    (set as { status: number }).status = 201;
    return { data: stateVersionResource(created, request) };
  })
  .get("/api/v2/state-versions/:state_version_id", async ({ params, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    const runScoped = run !== undefined && run !== null && ws !== undefined && checkRunStateAccess(run, ws.id);
    if (ws === undefined || (!runScoped && !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-read")))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(sv.status ?? "")) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const runData = sv.runId !== null
      ? await db.query.runs.findFirst({ where: eq(runs.id, sv.runId), columns: { status: true, message: true } })
      : null;
    return { data: stateVersionResource(sv, request, true, runData ?? null) };
  })
  .get("/api/v2/state-versions/:state_version_id/state-version-outputs", async ({ params, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    if ((user === undefined || user === null) && orgId === null && teamId === null && run === null) {
      (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || (!(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-outputs")) && !checkRunStateAccess(run, ws.id))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(sv.status ?? "")) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    const { number, size } = pageRequest(request);
    const outputs = stateOutputResources(sv);
    const sliced = outputs.slice((number - 1) * size, number * size);
    return { data: sliced, ...pagination(request, number, size, outputs.length) };
  })
  .get("/api/v2/state-versions/:state_version_id/outputs", async ({ params, user, orgId, teamId, run, set }: ParamCtx): Promise<unknown> => {
    if ((user === undefined || user === null) && orgId === null && teamId === null && run === null) {
      (set as { status: number }).status = 401; return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    if (ws === undefined || (!(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-outputs")) && !checkRunStateAccess(run, ws.id))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (["discarded", "backing_data_soft_deleted", "backing_data_permanently_deleted"].includes(sv.status ?? "")) {
      (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: stateOutputResources(sv) };
  })
  .get("/api/v2/state-version-outputs/:state_version_output_id", async ({ params, user, orgId, teamId, run, set }: ParamCtx): Promise<unknown> => {
    if ((user === undefined || user === null) && orgId === null && teamId === null && run === null) {
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
      if (ws !== undefined && (await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-outputs") || checkRunStateAccess(run, ws.id))) {
        return { data: output };
      }
      break;
    }
    (set as { status: number }).status = 404;
    return { errors: [{ status: "404", title: "Not Found" }] };
  })
  .get("/api/v2/state-versions/:state_version_id/json-download", async ({ params, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    const path = `/api/v2/state-versions/${stateVersionId}/json-download`;
    if (ws === undefined || (!validSignedApiURL(request, path) && !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-read")) && !checkRunStateAccess(run, ws.id))) {
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
    await auditLog("read", "state-version", stateVersionId, user?.id ?? null, ws.orgId, {
      workspaceId: sv.workspaceId,
      endpoint: "json-download",
      stateVersionSerial: sv.serial,
    });
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
  .get("/api/v2/state-versions/:state_version_id/download", async ({ params, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const stateVersionId = params.state_version_id ?? "";
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, sv.workspaceId) });
    const path = `/api/v2/state-versions/${stateVersionId}/download`;
    if (ws === undefined || (!validSignedApiURL(request, path) && !(await checkWorkspacePermission(ws, user?.id, orgId, teamId, "state-read")) && !checkRunStateAccess(run, ws.id))) {
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
    await auditLog("read", "state-version", stateVersionId, user?.id ?? null, ws.orgId, {
      workspaceId: sv.workspaceId,
      endpoint: "download",
      stateVersionSerial: sv.serial,
    });
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
    await db.update(stateVersions).set({ statePayload: encryptStatePayload(rawState), status: "finalized" }).where(eq(stateVersions.id, stateVersionId));
    scheduleExplorerInventory(sv.workspaceId);
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
    await db.update(stateVersions).set({ jsonState: encryptStatePayload(jsonState) }).where(eq(stateVersions.id, stateVersionId));
    scheduleExplorerInventory(sv.workspaceId);
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
    await db.update(stateVersions).set({ jsonStateOutputs: encryptStatePayload(jsonStateOutputs) }).where(eq(stateVersions.id, stateVersionId));
    scheduleExplorerInventory(sv.workspaceId);
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
    if (orgId !== null && orgId !== undefined) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden", detail: "Organization tokens cannot roll back state" }] }; }
    if (!ownsWorkspaceLock(ws, lockPrincipal(user?.id, orgId, teamId))) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace must be locked by the caller before rollback" }] }; }
    if (sv.statePayload === null || sv.status !== "finalized") {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "State version cannot be rolled back" }] };
    }
    const newId = crypto.randomUUID();
    await withStateSerialRetry(() => db.transaction(async (tx): Promise<void> => {
      const latest = await tx.query.stateVersions.findFirst({
        where: eq(stateVersions.workspaceId, sv.workspaceId),
        orderBy: [desc(stateVersions.serial)],
      });
      await tx.insert(stateVersions).values({
        id: newId,
        workspaceId: sv.workspaceId,
        serial: (latest?.serial ?? 0) + 1,
        runId: null,
        statePayload: encryptStatePayload(sv.statePayload),
        jsonState: encryptStatePayload(sv.jsonState),
        jsonStateOutputs: encryptStatePayload(sv.jsonStateOutputs),
        vcsCommitSha: sv.vcsCommitSha,
        vcsCommitUrl: sv.vcsCommitUrl,
        terraformVersion: sv.terraformVersion,
        intermediate: false,
        status: "finalized",
        createdAt: Date.now(),
      });
    }));
    scheduleExplorerInventory(sv.workspaceId);
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
    scheduleExplorerInventory(sv.workspaceId);
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
  .post("/api/v2/workspaces/:workspace_id/state-versions", async ({ params, body, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = run !== null && run.workspaceId === workspaceId
      ? await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) })
      : await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "state-write");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    if (data?.type !== undefined && data.type !== "state-versions") {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "data.type must be state-versions" }] };
    }
    if (orgId !== null && orgId !== undefined) {
      (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden", detail: "Organization tokens cannot create state versions" }] };
    }
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
    if (runId !== null) {
      const relatedRun = await db.query.runs.findFirst({ where: eq(runs.id, runId), columns: { workspaceId: true } });
      if (relatedRun?.workspaceId !== workspaceId) {
        (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "run must belong to this workspace" }] };
      }
    }
    if (run === null && (!ownsWorkspaceLock(ws, lockPrincipal(user?.id, orgId, teamId)))) {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Workspace must be locked by the caller before writing state" }] };
    }
    // No locked-workspace rejection here: the reference format allows state uploads on locked
    // workspaces. The CLI holds the workspace lock for the whole
    // import/apply operation and uploads the state while still locked;
    // rejecting it breaks `terraform import`. Concurrent-writer protection
    // comes from the run-level lock and state serial numbers, not from
    // blocking the lock holder.
    if (intermediate && ws.locked !== true) {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Intermediate state requires a locked workspace" }] };
    }
    const parsedTerraformState = statePayload === null ? null : parseTerraformStatePayload(statePayload);
    if (statePayload !== null && parseStatePayload(statePayload) === null) {
      (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "State content must be valid JSON" }] };
    }
    if (parsedTerraformState !== null && parsedTerraformState.serial !== serial) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "serial does not match the Terraform state payload" }] };
    }
    if (statePayload !== null && typeof attributes.md5 === "string") {
      const expected = createHash("md5").update(statePayload).digest("base64");
      if (attributes.md5 !== expected && attributes.md5 !== createHash("md5").update(statePayload).digest("hex")) {
        (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "md5 does not match the state payload" }] };
      }
    }
    const latestState = await db.query.stateVersions.findFirst({
      where: and(eq(stateVersions.workspaceId, workspaceId), eq(stateVersions.status, "finalized")),
      orderBy: [desc(stateVersions.serial)],
    });
    if (latestState !== undefined && runId === null && serial <= latestState.serial) {
      (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "State serial must advance the current workspace state" }] };
    }
    if (parsedTerraformState !== null && latestState?.statePayload !== null && latestState?.statePayload !== undefined) {
      const previous = parseTerraformStatePayload(latestState.statePayload);
      if (previous?.lineage !== undefined && parsedTerraformState.lineage !== previous.lineage) {
        (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "State lineage does not match the workspace history" }] };
      }
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
      statePayload: encryptStatePayload(statePayload),
      jsonState: encryptStatePayload(jsonState ?? statePayload),
      jsonStateOutputs: encryptStatePayload(jsonStateOutputs),
      intermediate,
      status: statePayload === null ? "pending" : "finalized",
      createdAt: Date.now(),
    });
    scheduleExplorerInventory(workspaceId);
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, id) });
    if (sv === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    (set as { status: number }).status = 201;
    return { data: stateVersionResource(sv, request) };
  })
  .post("/api/v2/workspaces/:workspace_id/state-versions/upload", async ({ params, body, user, orgId, teamId, run, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params.workspace_id ?? "";
    const ws = run !== null && run.workspaceId === workspaceId
      ? await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) })
      : await findAuthorizedWorkspace(workspaceId, user?.id, orgId, teamId, "state-write");
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (orgId !== null && orgId !== undefined) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden", detail: "Organization tokens cannot upload state" }] }; }
    if (run === null && !ownsWorkspaceLock(ws, lockPrincipal(user?.id, orgId, teamId))) {
      (set as { status: number }).status = 409;
      return { errors: [{ status: "409", title: "Conflict", detail: "Workspace must be locked by the caller before writing state" }] };
    }
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_IMPORTED_STATE_BYTES) {
      (set as { status: number }).status = 413;
      return { errors: [{ status: "413", title: "Payload Too Large", detail: "Terraform state exceeds the 100 MiB maximum" }] };
    }
    const rawState = await requestBodyText(body, request);
    if (Buffer.byteLength(rawState, "utf8") > MAX_IMPORTED_STATE_BYTES) {
      (set as { status: number }).status = 413;
      return { errors: [{ status: "413", title: "Payload Too Large", detail: "Terraform state exceeds the 100 MiB maximum" }] };
    }
    const parsed = parseTerraformStatePayload(rawState);
    if (parsed === null) {
      (set as { status: number }).status = 400;
      return { errors: [{ status: "400", title: "Bad Request", detail: "Uploaded file is not a valid Terraform/OpenTofu state file" }] };
    }
    const latestImportedState = await db.query.stateVersions.findFirst({
      where: and(eq(stateVersions.workspaceId, workspaceId), eq(stateVersions.status, "finalized")),
      orderBy: [desc(stateVersions.serial)],
      columns: { serial: true, statePayload: true },
    });
    if (parsed.serial !== (latestImportedState?.serial ?? 0) + 1) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "serial must be the next workspace state serial" }] };
    }
    if (latestImportedState?.statePayload !== null && latestImportedState?.statePayload !== undefined) {
      const previous = parseTerraformStatePayload(latestImportedState.statePayload);
      if (previous?.lineage !== undefined && parsed.lineage !== previous.lineage) {
        (set as { status: number }).status = 422;
        return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "State lineage does not match the workspace history" }] };
      }
    }
    const contentMd5 = request.headers.get("content-md5");
    if (contentMd5 !== null && contentMd5 !== createHash("md5").update(rawState).digest("base64")) {
      (set as { status: number }).status = 422;
      return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Content-MD5 does not match the state payload" }] };
    }

    const stateVersionId = await withStateSerialRetry(() => db.transaction(async (tx: unknown): Promise<string> => {
      const t = tx as typeof db;
      const latest = await t.query.stateVersions.findFirst({
        where: eq(stateVersions.workspaceId, workspaceId),
        orderBy: [desc(stateVersions.serial)],
      });
      const id = crypto.randomUUID();
      await t.insert(stateVersions).values({
        id,
        workspaceId,
        serial: (latest?.serial ?? 0) + 1,
        statePayload: encryptStatePayload(rawState),
        jsonState: encryptStatePayload(rawState),
        jsonStateOutputs: encryptStatePayload(parsed.outputs === undefined ? null : JSON.stringify(parsed.outputs)),
        status: "finalized",
        terraformVersion: typeof parsed.terraform_version === "string" ? parsed.terraform_version : null,
        intermediate: false,
        createdAt: Date.now(),
      });
      return id;
    }));
    const sv = await db.query.stateVersions.findFirst({ where: eq(stateVersions.id, stateVersionId) });
    if (sv === undefined) { (set as { status: number }).status = 500; return { errors: [{ status: "500", title: "Internal Server Error" }] }; }
    scheduleExplorerInventory(sv.workspaceId);
    (set as { status: number }).status = 201;
    return { data: stateVersionResource(sv, request) };
  });
