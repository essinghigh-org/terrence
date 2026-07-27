import { Elysia } from "elysia";
import { db } from "../db";
import { runs, workspaces, configurationVersions, organizations, logs, stateVersions, policyChecks, runComments, type users } from "../db/schema";
import { eq, and, desc, asc, count, inArray, ne, notInArray } from "drizzle-orm";
import { runResource, planResource, applyResource } from "../lib/response";
import { validateVersion, checkOrgPermission, findAuthorizedWorkspace, findAuthorizedRun, findLogCapability, pageRequest, pagination, logChunk, workspaceRunHistoryWhere, CAPACITY_PENDING_STATUSES, CAPACITY_RUNNING_STATUSES, auditLog } from "../lib/utils";
import { authPlugin } from "../auth";

type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

type ParamCtx = Readonly<{
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly user?: Readonly<typeof users.$inferSelect> | null;
  readonly orgId?: string | null;
  readonly request: Readonly<{ readonly url: string; readonly headers: Readonly<{ readonly get: (h: string) => string | null }> }>;
  readonly set: SetObj;
}>;


type DeepReadonly<T> = T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;


type RunItem = DeepReadonly<typeof runs.$inferSelect>;
type LogItem = DeepReadonly<typeof logs.$inferSelect>;
type CommentItem = DeepReadonly<typeof runComments.$inferSelect>;


export const runRoutes = new Elysia({ name: "runs" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/runs", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const workspaceId = params["workspace_id"] ?? "";
    const workspace = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (workspace === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const where = workspaceRunHistoryWhere(request, workspaceId);
    const [workspaceRuns, countRows] = await Promise.all([
      db.query.runs.findMany({ where, orderBy: [desc(runs.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(runs).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: workspaceRuns.map((r: RunItem): Record<string, unknown> => runResource(r, Boolean(user))), ...pagination(request, number, size, totalCount) };
  })
  .get("/api/v2/organizations/:org_name/runs", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const organization = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (organization === undefined || !(await checkOrgPermission(user?.id, organization.id, "member", orgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const orgWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, organization.id) });
    const { number, size } = pageRequest(request);
    if (orgWorkspaces.length === 0) { return { data: [], ...pagination(request, number, size, 0) }; }
    const where = inArray(runs.workspaceId, orgWorkspaces.map((w: Readonly<{ readonly id: string }>): string => w.id));
    const [orgRuns, countRows] = await Promise.all([
      db.query.runs.findMany({ where, orderBy: [desc(runs.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(runs).where(where),
    ]);
    const totalCount = countRows[0]?.total ?? 0;
    return { data: orgRuns.map((r: RunItem): Record<string, unknown> => runResource(r, Boolean(user))), ...pagination(request, number, size, totalCount) };
  })
  .get("/api/v2/organizations/:org_name/runs/queue", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const organization = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (organization === undefined || !(await checkOrgPermission(user?.id, organization.id, "member", orgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const orgWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, organization.id) });
    const { number, size } = pageRequest(request);
    if (orgWorkspaces.length === 0) { return { data: [], ...pagination(request, number, size, 0) }; }
    const queue = await db.query.runs.findMany({
      where: and(inArray(runs.workspaceId, orgWorkspaces.map((w: Readonly<{ readonly id: string }>): string => w.id)), inArray(runs.status, [...CAPACITY_PENDING_STATUSES, ...CAPACITY_RUNNING_STATUSES])),
      orderBy: [asc(runs.createdAt)],
    });
    let position = queue.filter((r: Readonly<{ readonly status: string }>): boolean => CAPACITY_RUNNING_STATUSES.some((s: string): boolean => s === r.status)).length;
    const data = queue.map((r: RunItem): Record<string, unknown> => {
      const resource = runResource(r, Boolean(user));
      const isPending = CAPACITY_PENDING_STATUSES.some((s: string): boolean => s === r.status);
      if (isPending) { position += 1; }
      const attrs = typeof resource.attributes === "object" && resource.attributes !== null ? (resource.attributes as Record<string, unknown>) : {};
      return { ...resource, attributes: { ...attrs, "position-in-queue": isPending ? position : 0 } };
    }).slice((number - 1) * size, number * size);
    return { data, ...pagination(request, number, size, queue.length) };
  })
  .get("/api/v2/organizations/:org_name/capacity", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const orgName = params["org_name"] ?? "";
    const organization = await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) });
    if (organization === undefined || !(await checkOrgPermission(user?.id, organization.id, "member", orgId))) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const orgWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, organization.id) });
    const active = orgWorkspaces.length === 0 ? [] : await db.query.runs.findMany({
      columns: { status: true },
      where: and(inArray(runs.workspaceId, orgWorkspaces.map((w: Readonly<{ readonly id: string }>): string => w.id)), inArray(runs.status, [...CAPACITY_PENDING_STATUSES, ...CAPACITY_RUNNING_STATUSES])),
    });
    return { data: { id: organization.name, type: "organization-capacity", attributes: { pending: active.filter((r: Readonly<{ readonly status: string }>): boolean => CAPACITY_PENDING_STATUSES.some((s: string): boolean => s === r.status)).length, running: active.filter((r: Readonly<{ readonly status: string }>): boolean => CAPACITY_RUNNING_STATUSES.some((s: string): boolean => s === r.status)).length } } };
  })
  .post("/api/v2/runs", async ({ body, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attributes = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const rels = typeof data?.relationships === "object" && data.relationships !== null ? (data.relationships as Record<string, unknown>) : {};
    const wsRel = typeof rels.workspace === "object" && rels.workspace !== null ? (rels.workspace as Record<string, unknown>) : {};
    const wsData = typeof wsRel.data === "object" && wsRel.data !== null ? (wsRel.data as Record<string, unknown>) : {};
    const cvRel = typeof rels["configuration-version"] === "object" && rels["configuration-version"] !== null ? (rels["configuration-version"] as Record<string, unknown>) : {};
    const cvData = typeof cvRel.data === "object" && cvRel.data !== null ? (cvRel.data as Record<string, unknown>) : {};
    const message = typeof attributes.message === "string" ? attributes.message : "";
    const isDestroy = typeof attributes["is-destroy"] === "boolean" ? attributes["is-destroy"] : false;
    const autoApply = typeof attributes["auto-apply"] === "boolean" ? attributes["auto-apply"] : false;
    const requestedPlanOnly = typeof attributes["plan-only"] === "boolean" ? attributes["plan-only"] : undefined;
    const refresh = typeof attributes.refresh === "boolean" ? attributes.refresh : true;
    const refreshOnly = typeof attributes["refresh-only"] === "boolean" ? attributes["refresh-only"] : false;
    const targetAddrs = Array.isArray(attributes["target-addrs"]) ? (attributes["target-addrs"] as string[]) : null;
    const replaceAddrs = Array.isArray(attributes["replace-addrs"]) ? (attributes["replace-addrs"] as string[]) : null;
    const runVariables = Array.isArray(attributes.variables) ? attributes.variables : null;
    const terraformVersion = typeof attributes["terraform-version"] === "string" ? attributes["terraform-version"] : undefined;
    const debuggingMode = typeof attributes["debugging-mode"] === "boolean" ? attributes["debugging-mode"] : false;
    const allowEmptyApply = typeof attributes["allow-empty-apply"] === "boolean" ? attributes["allow-empty-apply"] : false;
    const savePlan = typeof attributes["save-plan"] === "boolean" ? attributes["save-plan"] : false;
    const allowConfigGeneration = typeof attributes["allow-config-generation"] === "boolean" ? attributes["allow-config-generation"] : false;
    const workspaceId = typeof wsData.id === "string" ? wsData.id : "";
    const cvId = typeof cvData.id === "string" ? cvData.id : (typeof attributes["configuration-version-id"] === "string" ? attributes["configuration-version-id"] : undefined);
    if (workspaceId === "") { (set as { status: number }).status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Workspace ID is required" }] }; }
    if (terraformVersion !== undefined && !validateVersion(terraformVersion)) {
      (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid run attributes" }] };
    }
    const workspace = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (workspace === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (orgId !== null && orgId !== undefined) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    let configurationVersion: typeof configurationVersions.$inferSelect | undefined;
    if (cvId !== undefined) {
      configurationVersion = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) });
      if (configurationVersion?.workspaceId !== workspaceId) { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Configuration version does not belong to workspace" }] }; }
    }
    if (workspace.iacBinary === null && request.headers.get("Terraform-Version") !== null) { await db.update(workspaces).set({ iacBinary: "terraform" }).where(eq(workspaces.id, workspace.id)); }
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const logToken = crypto.randomUUID();
    const planOnly = requestedPlanOnly ?? configurationVersion?.speculative ?? false;
    const nowIso = new Date(createdAt).toISOString();
    const finalMsg = message !== "" ? message : "Queued manually";
    await db.insert(runs).values({ id, workspaceId, configurationVersionId: cvId ?? null, message: finalMsg, status: "pending", isDestroy, autoApply, planOnly, refresh, refreshOnly, targetAddrs, replaceAddrs, variables: runVariables, logToken, terraformVersion: terraformVersion ?? null, debuggingMode, allowEmptyApply, savePlan, allowConfigGeneration, statusTimestamps: { "pending-at": nowIso }, createdBy: user?.id ?? null, createdAt });
    (set as { status: number }).status = 201;
    return { data: runResource({ id, workspaceId, configurationVersionId: cvId ?? null, message: finalMsg, status: "pending", isDestroy, autoApply, planOnly, refresh, refreshOnly, targetAddrs, replaceAddrs, variables: runVariables, logToken, terraformVersion: terraformVersion ?? null, debuggingMode, allowEmptyApply, savePlan, allowConfigGeneration, statusTimestamps: { "pending-at": nowIso }, planResourceAdditions: null, planResourceChanges: null, planResourceDestructions: null, applyResourceAdditions: null, applyResourceChanges: null, applyResourceDestructions: null, createdBy: user?.id ?? null, createdAt }, true) };
  })
  .get("/api/v2/runs/:run_id", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: runResource(authorized.run, Boolean(user)) };
  })
  .delete("/api/v2/runs/:run_id", async ({ params, user, orgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(logs).where(eq(logs.runId, runId));
    await db.delete(runs).where(eq(runs.id, runId));
    (set as { status: number }).status = 204;
    return {};
  })
  .get("/api/v2/runs/:run_id/plan", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: planResource(authorized.run, request) };
  })
  .get("/api/v2/plans/:plan_id", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const rawPlanId = params["plan_id"] ?? "";
    const runId = rawPlanId.replace(/^plan-/, "");
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: planResource(authorized.run, request) };
  })
  .get("/api/v2/applies/:apply_id", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const rawApplyId = params["apply_id"] ?? "";
    const runId = rawApplyId.replace(/^apply-/, "");
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: applyResource(authorized.run, request) };
  })
  .get("/api/v2/runs/:run_id/run-events", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: [] };
  })
  .get("/api/v2/runs/:run_id/input-state-version", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const currentSV = await db.query.stateVersions.findFirst({
      where: and(eq(stateVersions.workspaceId, authorized.run.workspaceId), ne(stateVersions.runId, runId)),
      orderBy: desc(stateVersions.serial),
    });
    if (currentSV === undefined) return { data: null };
    const { stateVersionResource } = await import("../lib/response");
    return { data: stateVersionResource(currentSV, request) };
  })
  .get("/api/v2/runs/:run_id/logs", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const runLogs = await db.query.logs.findMany({ where: eq(logs.runId, runId), orderBy: [asc(logs.createdAt)] });
    return { data: runLogs.map((l: LogItem): Record<string, unknown> => ({ id: l.id, type: "logs", attributes: { phase: l.phase, "output-text": l.outputText, "created-at": l.createdAt } })) };
  })
  .get("/api/v2/runs/:run_id/plan/log/:log_token", async ({ params, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const logToken = params["log_token"] ?? "";
    if ((await findLogCapability(runId, logToken)) !== true) { (set as { status: number }).status = 404; return "Not Found"; }
    const planLogs = await db.query.logs.findMany({ where: and(eq(logs.runId, runId), eq(logs.phase, "plan")), orderBy: [asc(logs.createdAt)] });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(planLogs.map((l: Readonly<{ readonly outputText: string }>): string => l.outputText).join("\n"), request);
  })
  .get("/api/v2/runs/:run_id/apply/log/:log_token", async ({ params, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const logToken = params["log_token"] ?? "";
    if ((await findLogCapability(runId, logToken)) !== true) { (set as { status: number }).status = 404; return "Not Found"; }
    const applyLogs = await db.query.logs.findMany({ where: and(eq(logs.runId, runId), eq(logs.phase, "apply")), orderBy: [asc(logs.createdAt)] });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(applyLogs.map((l: Readonly<{ readonly outputText: string }>): string => l.outputText).join("\n"), request);
  })
  .get("/api/v2/runs/:run_id/plan/log", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const planLogs = await db.query.logs.findMany({ where: and(eq(logs.runId, runId), eq(logs.phase, "plan")), orderBy: [asc(logs.createdAt)] });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(planLogs.map((l: Readonly<{ readonly outputText: string }>): string => l.outputText).join("\n"), request);
  })
  .get("/api/v2/runs/:run_id/apply/log", async ({ params, user, orgId, request, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const applyLogs = await db.query.logs.findMany({ where: and(eq(logs.runId, runId), eq(logs.phase, "apply")), orderBy: [asc(logs.createdAt)] });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(applyLogs.map((l: Readonly<{ readonly outputText: string }>): string => l.outputText).join("\n"), request);
  })
  .post("/api/v2/runs/:run_id/actions/apply", async ({ params, body, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (orgId !== null && orgId !== undefined) { (set as { status: number }).status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const before = await db.query.runs.findFirst({ where: and(eq(runs.id, runId), inArray(runs.status, ["planned", "policy_soft_failed"])) });
    if (before === undefined) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run must be planned or policy_soft_failed before apply" }] }; }
    await db.update(runs).set({ status: "applying" }).where(eq(runs.id, runId));
    await auditLog("apply", "runs", runId, user?.id ?? null, null, { fromStatus: before.status });
    if (before.status === "policy_soft_failed") {
      const failedChecks = await db.query.policyChecks.findMany({ where: and(eq(policyChecks.runId, runId), inArray(policyChecks.status, ["soft_failed", "failed"])) });
      for (const check of failedChecks) await db.update(policyChecks).set({ status: "overridden" }).where(eq(policyChecks.id, check.id));
    }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const commentVal = payload.comment ?? attrs.comment;
    const commentStr = typeof commentVal === "string" ? commentVal : "";
    if (commentStr !== "") await db.insert(runComments).values({ id: `rc-${crypto.randomUUID()}`, runId, userId: user?.id ?? null, body: commentStr, createdAt: Date.now() });
    const { executeApply } = await import("../worker");
    executeApply(authorized.run.id).catch((err: unknown): void => { if (err !== null && err !== undefined) { console.error(err); } });
    return { data: { id: authorized.run.id, type: "runs", attributes: { status: "applying" } } };
  })
  .post("/api/v2/runs/:run_id/actions/discard", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const updated = await db.update(runs).set({ status: "discarded" }).where(and(eq(runs.id, runId), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"]))).returning();
    if (updated.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not discardable" }] }; }
    return { data: { id: runId, type: "runs", attributes: { status: "discarded" } } };
  })
  .post("/api/v2/runs/:run_id/actions/cancel", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const updated = await db.update(runs).set({ status: "canceled" }).where(and(eq(runs.id, runId), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"]))).returning();
    if (updated.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not cancelable" }] }; }
    return { data: { id: runId, type: "runs", attributes: { status: "canceled" } } };
  })
  .post("/api/v2/runs/:run_id/actions/force-cancel", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const updated = await db.update(runs).set({ status: "force_canceled" }).where(and(eq(runs.id, runId), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"]))).returning();
    if (updated.length === 0) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not force-cancelable" }] }; }
    return { data: { id: runId, type: "runs", attributes: { status: "force_canceled" } } };
  })
  .post("/api/v2/runs/:run_id/actions/override-policy", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const run = authorized.run;
    if (run.status !== "policy_soft_failed") { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run must be policy_soft_failed to override" }] }; }
    await db.update(policyChecks).set({ status: "overridden" }).where(and(eq(policyChecks.runId, runId), inArray(policyChecks.status, ["soft_failed", "failed"])));
    await db.update(runs).set({ status: "planned" }).where(eq(runs.id, runId));
    return { data: { id: runId, type: "runs", attributes: { status: "planned" } } };
  })
  // --- Comments ---
  .get("/api/v2/runs/:run_id/comments", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const commentsList = await db.query.runComments.findMany({ where: eq(runComments.runId, runId) });
    return { data: commentsList.map((c: CommentItem): Record<string, unknown> => ({ id: c.id, type: "comments", attributes: { body: c.body, "created-at": new Date(c.createdAt).toISOString() } })) };
  })
  .post("/api/v2/runs/:run_id/comments", async ({ params, body, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    const authorized = await findAuthorizedRun(runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const payload = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = payload.data as Record<string, unknown> | undefined;
    const attrs = typeof data?.attributes === "object" && data.attributes !== null ? (data.attributes as Record<string, unknown>) : {};
    const textVal = attrs.body ?? payload.body;
    const text = typeof textVal === "string" ? textVal : "";
    if (text === "") { (set as { status: number }).status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `rc-${crypto.randomUUID()}`;
    await db.insert(runComments).values({ id, runId, userId: user?.id ?? null, body: text, createdAt: Date.now() });
    (set as { status: number }).status = 201;
    return { data: { id, type: "comments", attributes: { body: text, "created-at": new Date().toISOString() } } };
  })
  .delete("/api/v2/comments/:comment_id", async ({ params, user, orgId, set }: ParamCtx): Promise<Record<string, never> | { errors: { status: string; title: string }[] }> => {
    const commentId = params["comment_id"] ?? "";
    const c = await db.query.runComments.findFirst({ where: eq(runComments.id, commentId) });
    if (c === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const authorized = await findAuthorizedRun(c.runId, user?.id, orgId);
    if (authorized === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(runComments).where(eq(runComments.id, commentId));
    (set as { status: number }).status = 204;
    return {};
  })
  // --- Plan JSON Output ---
  .get("/api/v2/plans/:plan_id/json-output", async ({ params, user, orgId, set }: ParamCtx): Promise<unknown> => {
    const planId = params["plan_id"] ?? "";
    const run = await db.query.runs.findFirst({ where: eq(runs.id, planId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const ws = await findAuthorizedWorkspace(run.workspaceId, user?.id, orgId);
    if (ws === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { format_version: "1.0", terraform_version: run.terraformVersion ?? "latest", changes: { resource_changes: [] } };
  });
