import { Elysia } from "elysia";
import { db } from "../db";
import { runs, workspaces, configurationVersions, organizations, logs, stateVersions, policyChecks, runComments, users, agentPools, auditLogs } from "../db/schema";
import { eq, and, desc, asc, count, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { runResource, planResource, applyResource } from "../lib/response";
import { validateVersion, checkOrgPermission, findAuthorizedWorkspace, findAuthorizedRun, findLogCapability, pageRequest, pagination, logChunk, workspaceRunHistoryWhere, FINAL_RUN_STATUSES, CAPACITY_PENDING_STATUSES, CAPACITY_RUNNING_STATUSES, DISCARDABLE_RUN_STATUSES, auditLog } from "../lib/utils";
import { authPlugin } from "../auth";

export const runRoutes = new Elysia({ name: "runs" })
  .use(authPlugin)
  .get("/api/v2/workspaces/:workspace_id/runs", async ({ params: { workspace_id }, user, orgId, request, set }) => {
    const workspace = await findAuthorizedWorkspace(workspace_id, user?.id, orgId);
    if (!workspace) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const { number, size } = pageRequest(request);
    const where = workspaceRunHistoryWhere(request, workspace_id);
    const [workspaceRuns, [{ total }]] = await Promise.all([
      db.query.runs.findMany({ where, orderBy: [desc(runs.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(runs).where(where),
    ]);
    return { data: workspaceRuns.map(run => runResource(run, Boolean(user))), ...pagination(request, number, size, total) };
  })
  .get("/api/v2/organizations/:org_name/runs", async ({ params: { org_name }, user, orgId, request, set }) => {
    const organization = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!organization || !(await checkOrgPermission(user?.id, organization.id, "member", orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const orgWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, organization.id) });
    const { number, size } = pageRequest(request);
    if (orgWorkspaces.length === 0) { return { data: [], ...pagination(request, number, size, 0) }; }
    const where = inArray(runs.workspaceId, orgWorkspaces.map(w => w.id));
    const [orgRuns, [{ total }]] = await Promise.all([
      db.query.runs.findMany({ where, orderBy: [desc(runs.createdAt)], limit: size, offset: (number - 1) * size }),
      db.select({ total: count() }).from(runs).where(where),
    ]);
    return { data: orgRuns.map(run => runResource(run, Boolean(user))), ...pagination(request, number, size, total) };
  })
  .get("/api/v2/organizations/:org_name/runs/queue", async ({ params: { org_name }, user, orgId, request, set }) => {
    const organization = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!organization || !(await checkOrgPermission(user?.id, organization.id, "member", orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const orgWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, organization.id) });
    const { number, size } = pageRequest(request);
    if (orgWorkspaces.length === 0) { return { data: [], ...pagination(request, number, size, 0) }; }
    const queue = await db.query.runs.findMany({
      where: and(inArray(runs.workspaceId, orgWorkspaces.map(w => w.id)), inArray(runs.status, [...CAPACITY_PENDING_STATUSES, ...CAPACITY_RUNNING_STATUSES])),
      orderBy: [asc(runs.createdAt)],
    });
    let position = queue.filter(r => CAPACITY_RUNNING_STATUSES.includes(r.status)).length;
    const data = queue.map(r => {
      const resource = runResource(r, Boolean(user));
      return { ...resource, attributes: { ...resource.attributes, "position-in-queue": CAPACITY_PENDING_STATUSES.includes(r.status) ? ++position : 0 } };
    }).slice((number - 1) * size, number * size);
    return { data, ...pagination(request, number, size, queue.length) };
  })
  .get("/api/v2/organizations/:org_name/capacity", async ({ params: { org_name }, user, orgId, set }) => {
    const organization = await db.query.organizations.findFirst({ where: eq(organizations.name, org_name) });
    if (!organization || !(await checkOrgPermission(user?.id, organization.id, "member", orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const orgWorkspaces = await db.query.workspaces.findMany({ where: eq(workspaces.orgId, organization.id) });
    const active = orgWorkspaces.length === 0 ? [] : await db.query.runs.findMany({
      columns: { status: true },
      where: and(inArray(runs.workspaceId, orgWorkspaces.map(w => w.id)), inArray(runs.status, [...CAPACITY_PENDING_STATUSES, ...CAPACITY_RUNNING_STATUSES])),
    });
    return { data: { id: organization.name, type: "organization-capacity", attributes: { pending: active.filter(r => CAPACITY_PENDING_STATUSES.includes(r.status)).length, running: active.filter(r => CAPACITY_RUNNING_STATUSES.includes(r.status)).length } } };
  })
  .post("/api/v2/runs", async ({ body, user, orgId, request, set }) => {
    const payload = body as any;
    const { message, "is-destroy": isDestroy, "auto-apply": autoApply, "plan-only": requestedPlanOnly, refresh = true, "refresh-only": refreshOnly = false, "target-addrs": targetAddrs, "replace-addrs": replaceAddrs, variables: runVariables, "terraform-version": terraformVersion, "debugging-mode": debuggingMode = false, "allow-empty-apply": allowEmptyApply = false, "save-plan": savePlan = false, "allow-config-generation": allowConfigGeneration = false } = payload?.data?.attributes || {};
    const workspaceId = payload?.data?.relationships?.workspace?.data?.id;
    const cvId = payload?.data?.relationships?.["configuration-version"]?.data?.id || payload?.data?.attributes?.["configuration-version-id"];
    if (!workspaceId) { set.status = 400; return { errors: [{ status: "400", title: "Bad Request", detail: "Workspace ID is required" }] }; }
    if ((autoApply !== undefined && typeof autoApply !== "boolean") || (isDestroy !== undefined && typeof isDestroy !== "boolean") || (requestedPlanOnly !== undefined && typeof requestedPlanOnly !== "boolean") || typeof refresh !== "boolean" || typeof refreshOnly !== "boolean" || typeof debuggingMode !== "boolean" || typeof allowEmptyApply !== "boolean" || typeof savePlan !== "boolean" || typeof allowConfigGeneration !== "boolean" || (terraformVersion !== undefined && (typeof terraformVersion !== "string" || !validateVersion(terraformVersion))) || (targetAddrs != null && (!Array.isArray(targetAddrs) || targetAddrs.some(v => typeof v !== "string"))) || (replaceAddrs != null && (!Array.isArray(replaceAddrs) || replaceAddrs.some(v => typeof v !== "string"))) || (runVariables != null && (!Array.isArray(runVariables) || runVariables.some(v => !v || typeof v.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key) || typeof v.value !== "string")))) {
      set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Invalid run attributes" }] };
    }
    const workspace = await findAuthorizedWorkspace(workspaceId, user?.id, orgId);
    if (!workspace) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (orgId) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    let configurationVersion: typeof configurationVersions.$inferSelect | undefined;
    if (cvId) {
      configurationVersion = typeof cvId === "string" ? await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, cvId) }) : undefined;
      if (!configurationVersion || configurationVersion.workspaceId !== workspaceId) { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity", detail: "Configuration version does not belong to workspace" }] }; }
    }
    if (!workspace.iacBinary && request.headers.get("Terraform-Version")) { await db.update(workspaces).set({ iacBinary: "terraform" }).where(eq(workspaces.id, workspace.id)); }
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const logToken = crypto.randomUUID();
    const planOnly = requestedPlanOnly ?? configurationVersion?.speculative ?? false;
    const nowIso = new Date(createdAt).toISOString();
    await db.insert(runs).values({ id, workspaceId, configurationVersionId: cvId || null, message: message || "Queued manually", status: "pending", isDestroy: isDestroy ?? false, autoApply: autoApply ?? false, planOnly, refresh, refreshOnly, targetAddrs: targetAddrs || null, replaceAddrs: replaceAddrs || null, variables: runVariables || null, logToken, terraformVersion: terraformVersion || null, debuggingMode, allowEmptyApply, savePlan, allowConfigGeneration, statusTimestamps: { "pending-at": nowIso }, createdBy: user?.id || null, createdAt });
    set.status = 201;
    return { data: runResource({ id, workspaceId, configurationVersionId: cvId || null, message: message || "Queued manually", status: "pending", isDestroy: isDestroy ?? false, autoApply: autoApply ?? false, planOnly, refresh, refreshOnly, targetAddrs: targetAddrs || null, replaceAddrs: replaceAddrs || null, variables: runVariables || null, logToken, terraformVersion: terraformVersion || null, debuggingMode, allowEmptyApply, savePlan, allowConfigGeneration, statusTimestamps: { "pending-at": nowIso }, planResourceAdditions: null, planResourceChanges: null, planResourceDestructions: null, applyResourceAdditions: null, applyResourceChanges: null, applyResourceDestructions: null, createdBy: user?.id || null, createdAt }, true) };
  })
  .get("/api/v2/runs/:run_id", async ({ params: { run_id }, user, orgId, set }) => {
    const authorized = await findAuthorizedRun(run_id, user?.id, orgId);
    if (!authorized) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: runResource(authorized.run, Boolean(user)) };
  })
  .delete("/api/v2/runs/:run_id", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(logs).where(eq(logs.runId, run_id));
    await db.delete(runs).where(eq(runs.id, run_id));
    set.status = 204;
  })
  .get("/api/v2/runs/:run_id/plan", async ({ params: { run_id }, user, orgId, request, set }) => {
    const authorized = await findAuthorizedRun(run_id, user?.id, orgId);
    if (!authorized) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: planResource(authorized.run, request) };
  })
  .get("/api/v2/plans/:plan_id", async ({ params: { plan_id }, user, orgId, request, set }) => {
    const authorized = await findAuthorizedRun(plan_id.replace(/^plan-/, ""), user?.id, orgId);
    if (!authorized) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: planResource(authorized.run, request) };
  })
  .get("/api/v2/applies/:apply_id", async ({ params: { apply_id }, user, orgId, request, set }) => {
    const authorized = await findAuthorizedRun(apply_id.replace(/^apply-/, ""), user?.id, orgId);
    if (!authorized) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: applyResource(authorized.run, request) };
  })
  .get("/api/v2/runs/:run_id/run-events", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: [] };
  })
  .get("/api/v2/runs/:run_id/input-state-version", async ({ params: { run_id }, user, orgId, request, set }) => {
    const authorized = await findAuthorizedRun(run_id, user?.id, orgId);
    if (!authorized) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const currentSV = await db.query.stateVersions.findFirst({
      where: and(eq(stateVersions.workspaceId, authorized.run.workspaceId), ne(stateVersions.runId, run_id)),
      orderBy: desc(stateVersions.serial),
    });
    if (!currentSV) return { data: null };
    const { stateVersionResource } = await import("../lib/response");
    return { data: stateVersionResource(currentSV, request) };
  })
  .get("/api/v2/runs/:run_id/logs", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const runLogs = await db.query.logs.findMany({ where: eq(logs.runId, run_id), orderBy: [asc(logs.createdAt)] });
    return { data: runLogs.map(l => ({ id: l.id, type: "logs", attributes: { phase: l.phase, "output-text": l.outputText, "created-at": l.createdAt } })) };
  })
  .get("/api/v2/runs/:run_id/plan/log/:log_token", async ({ params: { run_id, log_token }, request, set }) => {
    if (!(await findLogCapability(run_id, log_token))) { set.status = 404; return "Not Found"; }
    const planLogs = await db.query.logs.findMany({ where: (l, { and, eq }) => and(eq(l.runId, run_id), eq(l.phase, "plan")), orderBy: [asc(logs.createdAt)] });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(planLogs.map(l => l.outputText).join("\n"), request);
  })
  .get("/api/v2/runs/:run_id/apply/log/:log_token", async ({ params: { run_id, log_token }, request, set }) => {
    if (!(await findLogCapability(run_id, log_token))) { set.status = 404; return "Not Found"; }
    const applyLogs = await db.query.logs.findMany({ where: (l, { and, eq }) => and(eq(l.runId, run_id), eq(l.phase, "apply")), orderBy: [asc(logs.createdAt)] });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(applyLogs.map(l => l.outputText).join("\n"), request);
  })
  .get("/api/v2/runs/:run_id/plan/log", async ({ params: { run_id }, user, orgId, request, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const planLogs = await db.query.logs.findMany({ where: (l, { and, eq }) => and(eq(l.runId, run_id), eq(l.phase, "plan")), orderBy: [asc(logs.createdAt)] });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(planLogs.map(l => l.outputText).join("\n"), request);
  })
  .get("/api/v2/runs/:run_id/apply/log", async ({ params: { run_id }, user, orgId, request, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const applyLogs = await db.query.logs.findMany({ where: (l, { and, eq }) => and(eq(l.runId, run_id), eq(l.phase, "apply")), orderBy: [asc(logs.createdAt)] });
    set.headers["Content-Type"] = "text/plain";
    return logChunk(applyLogs.map(l => l.outputText).join("\n"), request);
  })
  .post("/api/v2/runs/:run_id/actions/apply", async ({ params: { run_id }, body, user, orgId, set }) => {
    const authorized = await findAuthorizedRun(run_id, user?.id, orgId);
    if (!authorized) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    if (orgId) { set.status = 403; return { errors: [{ status: "403", title: "Forbidden" }] }; }
    const before = await db.query.runs.findFirst({ where: and(eq(runs.id, run_id), inArray(runs.status, ["planned", "policy_soft_failed"])) });
    if (!before) { set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run must be planned or policy_soft_failed before apply" }] }; }
    await db.update(runs).set({ status: "applying" }).where(eq(runs.id, run_id));
    await auditLog("apply", "runs", run_id, user?.id || null, null, { fromStatus: before.status });
    if (before.status === "policy_soft_failed") {
      const failedChecks = await db.query.policyChecks.findMany({ where: and(eq(policyChecks.runId, run_id), inArray(policyChecks.status, ["soft_failed", "failed"])) });
      for (const check of failedChecks) await db.update(policyChecks).set({ status: "overridden" }).where(eq(policyChecks.id, check.id));
    }
    const commentStr = (body as any)?.comment || (body as any)?.data?.attributes?.comment;
    if (commentStr && typeof commentStr === "string") await db.insert(runComments).values({ id: `rc-${crypto.randomUUID()}`, runId: run_id, userId: user?.id ?? null, body: commentStr, createdAt: Date.now() });
    const { executeApply } = await import("../worker");
    executeApply(authorized.run.id).catch(console.error);
    return { data: { id: authorized.run.id, type: "runs", attributes: { status: "applying" } } };
  })
  .post("/api/v2/runs/:run_id/actions/discard", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const updated = await db.update(runs).set({ status: "discarded" }).where(and(eq(runs.id, run_id), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"]))).returning();
    if (updated.length === 0) { set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not discardable" }] }; }
    return { data: { id: run_id, type: "runs", attributes: { status: "discarded" } } };
  })
  .post("/api/v2/runs/:run_id/actions/cancel", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const updated = await db.update(runs).set({ status: "canceled" }).where(and(eq(runs.id, run_id), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"]))).returning();
    if (updated.length === 0) { set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not cancelable" }] }; }
    return { data: { id: run_id, type: "runs", attributes: { status: "canceled" } } };
  })
  .post("/api/v2/runs/:run_id/actions/force-cancel", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const updated = await db.update(runs).set({ status: "force_canceled" }).where(and(eq(runs.id, run_id), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"]))).returning();
    if (updated.length === 0) { set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not force-cancelable" }] }; }
    return { data: { id: run_id, type: "runs", attributes: { status: "force_canceled" } } };
  })
  .post("/api/v2/runs/:run_id/actions/override-policy", async ({ params: { run_id }, user, orgId, set }) => {
    const authorized = await findAuthorizedRun(run_id, user?.id, orgId);
    if (!authorized) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const run = authorized.run;
    if (run.status !== "policy_soft_failed") { set.status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run must be policy_soft_failed to override" }] }; }
    await db.update(policyChecks).set({ status: "overridden" }).where(and(eq(policyChecks.runId, run_id), inArray(policyChecks.status, ["soft_failed", "failed"])));
    await db.update(runs).set({ status: "planned" }).where(eq(runs.id, run_id));
    return { data: { id: run_id, type: "runs", attributes: { status: "planned" } } };
  })
  // --- Comments ---
  .get("/api/v2/runs/:run_id/comments", async ({ params: { run_id }, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const commentsList = await db.query.runComments.findMany({ where: eq(runComments.runId, run_id) });
    return { data: commentsList.map(c => ({ id: c.id, type: "comments", attributes: { body: c.body, "created-at": new Date(c.createdAt).toISOString() } })) };
  })
  .post("/api/v2/runs/:run_id/comments", async ({ params: { run_id }, body, user, orgId, set }) => {
    if (!(await findAuthorizedRun(run_id, user?.id, orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const text = (body as any)?.data?.attributes?.body || (body as any)?.body;
    if (!text || typeof text !== "string") { set.status = 422; return { errors: [{ status: "422", title: "Unprocessable Entity" }] }; }
    const id = `rc-${crypto.randomUUID()}`;
    await db.insert(runComments).values({ id, runId: run_id, userId: user?.id ?? null, body: text, createdAt: Date.now() });
    set.status = 201;
    return { data: { id, type: "comments", attributes: { body: text, "created-at": new Date().toISOString() } } };
  })
  .delete("/api/v2/comments/:comment_id", async ({ params: { comment_id }, user, orgId, set }) => {
    const c = await db.query.runComments.findFirst({ where: eq(runComments.id, comment_id) });
    if (!c || !(await findAuthorizedRun(c.runId, user?.id, orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    await db.delete(runComments).where(eq(runComments.id, comment_id));
    set.status = 204;
  })
  // --- Plan JSON Output ---
  .get("/api/v2/plans/:plan_id/json-output", async ({ params: { plan_id }, user, orgId, set }) => {
    const run = await db.query.runs.findFirst({ where: eq(runs.id, plan_id) });
    if (!run || !(await findAuthorizedWorkspace(run.workspaceId, user?.id, orgId))) { set.status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { format_version: "1.0", terraform_version: run.terraformVersion || "latest", changes: { resource_changes: [] } };
  });
