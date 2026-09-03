import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { agentPools, runs, runComments } from "../../db/schema";
import type { users } from "../../db/schema";
import { checkWorkspacePermission, findAuthorizedRun, findAuthorizedWorkspace, auditLog } from "../utils";
import { cancelAgentJobsForRun, insertAgentApplyJobTx } from "../agent-jobs";
import { agentPoolAllowsWorkspace } from "../agent-pool-scope";
import { queueRunNotification } from "../notifications";
import { createRun } from "../../routes/runs";
import { planStatusForRun } from "../response";
import { readPlanJsonArtifact, readPlanJsonSideArtifact, sanitizePlanJson } from "../plan-json";
import { toolBadRequest, toolError, type McpSession, type McpTool } from "./types";

function runCreationAttributes(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const key of ["message", "terraform-version", "is-destroy", "auto-apply", "plan-only", "save-plan", "refresh", "refresh-only"]) {
    const value = args[key];
    if (value !== null && value !== undefined) attributes[key] = value;
  }
  if (Array.isArray(args["target-addrs"])) attributes["target-addrs"] = args["target-addrs"];
  return attributes;
}

function requestedRunIncludes(args: Readonly<Record<string, unknown>>): Readonly<{ plan: boolean; workspace: boolean }> {
  const names = String(args["include"] ?? "").split(",").map((part): string => part.trim()).filter((part): boolean => part !== "");
  return { plan: names.includes("plan"), workspace: names.includes("workspace") };
}

type AuthorizedRun = NonNullable<Awaited<ReturnType<typeof findAuthorizedRun>>>;
type ApplyRun = Readonly<Pick<typeof runs.$inferSelect, "id" | "status" | "statusTimestamps">>;

type AgentPoolSelection = Readonly<{ id: string | null; error: string | null }>;

async function selectApplyAgentPool(authorized: AuthorizedRun): Promise<AgentPoolSelection> {
  if (authorized.workspace.executionMode !== "agent") return { id: null, error: null };
  const pool = authorized.workspace.agentPoolId === null
    ? undefined
    : await db.query.agentPools.findFirst({ where: eq(agentPools.id, authorized.workspace.agentPoolId) });
  if (
    pool?.orgId !== authorized.workspace.orgId
    || !(await agentPoolAllowsWorkspace(pool, authorized.workspace.id, authorized.workspace.projectId))
  ) {
    return { id: null, error: "The workspace does not have an allowed agent pool" };
  }
  return { id: pool.id, error: null };
}

async function addRunComment(runId: string, comment: unknown, userId: string | null): Promise<void> {
  if (typeof comment === "string" && comment.trim() !== "") {
    await db.insert(runComments).values({ id: `rc-${crypto.randomUUID()}`, runId, userId, body: comment.trim(), createdAt: Date.now() });
  }
}

async function queueAgentApply(
  runId: string,
  agentPoolId: string,
  before: ApplyRun,
): Promise<unknown> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as typeof db;
    const confirmedTimestamps = {
      ...(before.statusTimestamps ?? {}),
      "confirmed-at": new Date().toISOString(),
    };
    const confirmed = await tx.update(runs).set({
      status: "confirmed",
      statusTimestamps: confirmedTimestamps,
    }).where(and(eq(runs.id, runId), eq(runs.status, before.status))).returning({ id: runs.id });
    if (confirmed.length === 0) return undefined;
    return insertAgentApplyJobTx(tx, runId, agentPoolId, confirmedTimestamps);
  });
}

async function applyRunThroughAgent(
  session: McpSession,
  args: Readonly<Record<string, unknown>>,
  authorized: AuthorizedRun,
  before: ApplyRun,
  runId: string,
  agentPoolId: string,
): Promise<unknown> {
  const job = await queueAgentApply(runId, agentPoolId, before);
  if (job === undefined) return toolBadRequest("Run apply is already queued");
  await auditLog("apply", "runs", runId, session.userId ?? null, authorized.workspace.orgId, {
    workspaceId: authorized.workspace.id,
    fromStatus: before.status,
    toStatus: "apply_queued",
    ...(session.teamId !== null ? { teamId: session.teamId } : {}),
  });
  await addRunComment(runId, args["comment"], session.userId ?? null);
  return { id: authorized.run.id, status: "apply_queued" };
}

async function applyRunDirectly(
  session: McpSession,
  args: Readonly<Record<string, unknown>>,
  authorized: AuthorizedRun,
  before: ApplyRun,
  runId: string,
): Promise<unknown> {
  const confirmed = await db.update(runs).set({
    status: "confirmed",
    statusTimestamps: {
      ...(before.statusTimestamps ?? {}),
      "confirmed-at": new Date().toISOString(),
    },
  }).where(and(eq(runs.id, runId), eq(runs.status, before.status))).returning({ id: runs.id });
  if (confirmed.length === 0) return toolBadRequest("Run apply is already queued");
  await auditLog("apply", "runs", runId, session.userId ?? null, authorized.workspace.orgId, {
    workspaceId: authorized.workspace.id,
    fromStatus: before.status,
    toStatus: "confirmed",
    ...(session.teamId !== null ? { teamId: session.teamId } : {}),
  });
  await addRunComment(runId, args["comment"], session.userId ?? null);
  const { executeApply } = await import("../../worker");
  executeApply(authorized.run.id).catch((err: unknown): void => { if (err !== null && err !== undefined) console.error(err); });
  return { id: authorized.run.id, status: "applying" };
}

/**
 * Run tools. Reads require the `runs:read` grant (the `run-read` workspace
 * permission maps to it). Targets are always re-authorized via
 * findAuthorizedWorkspace so fine-grained scopes are enforced.
 */
export const runTools: readonly McpTool[] = [
  {
    name: "get_run",
    description: "Get details for a specific run, or list recent runs for a workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Workspace ID" },
        run_id: { type: "string", description: "Specific run ID (if absent, returns list)" },
        limit: { type: "number", description: "Max results (default 20)", default: 20 },
        offset: { type: "number", description: "Pagination offset", default: 0 },
        include: { type: "string", description: "Comma-separated related resources for a single run: plan,workspace" },
      },
      required: ["workspace_id"],
    },
    requires: ["runs:read"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const wsId = String(args["workspace_id"]);
      const ws = await findAuthorizedWorkspace(wsId, session.userId ?? undefined, session.orgId, session.teamId, "run-read");
      if (ws === undefined) return toolError("Workspace not found or not authorized");
      const runId = typeof args["run_id"] === "string" ? args["run_id"] : undefined;
      if (runId !== undefined) {
        const run = await db.query.runs.findFirst({
          where: eq(runs.id, runId),
          columns: { id: true, workspaceId: true, status: true, message: true, createdAt: true, statusTimestamps: true },
        });
        if (run === undefined) return toolBadRequest(`Run "${runId}" not found`);
        if (run.workspaceId !== wsId) return toolError("Run does not belong to the specified workspace");
        const { id, workspaceId, status, message, createdAt } = run;
        const result: Record<string, unknown> = { id, workspaceId, status, message, createdAt };
        const includes = requestedRunIncludes(args);
        if (includes.plan || includes.workspace) {
          const included: Record<string, unknown> = {};
          if (includes.plan) included["plan"] = { id: `plan-${run.id}`, status: planStatusForRun(run) };
          if (includes.workspace) included["workspace"] = { id: ws.id, name: ws.name, locked: ws.locked };
          result["included"] = included;
        }
        return result;
      }
      const limit = Math.min(Math.max(Number(args["limit"] ?? 20), 1), 100);
      const offset = Math.max(Number(args["offset"] ?? 0), 0);
      const rows = await db.query.runs.findMany({
        where: eq(runs.workspaceId, wsId),
        orderBy: [desc(runs.createdAt)],
        limit,
        offset,
        columns: { id: true, workspaceId: true, status: true, message: true, createdAt: true },
      });
      return rows;
    },
  },
  {
    name: "create_run",
    description: "Create (plan) a new run on a workspace. Requires the runs:plan grant.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Workspace ID" },
        message: { type: "string", description: "Run message" },
        "is-destroy": { type: "boolean", description: "Destroy plan" },
        "auto-apply": { type: "boolean", description: "Auto-apply when the plan succeeds (needs runs:apply)" },
        "plan-only": { type: "boolean", description: "Skip the apply" },
        "save-plan": { type: "boolean", description: "Save the plan for later apply (terraform plan -out support)" },
        refresh: { type: "boolean", description: "Refresh state before planning (default true)" },
        "refresh-only": { type: "boolean", description: "Only refresh state, no changes" },
        "target-addrs": {
          type: "array", items: { type: "string" },
          description: "Addresses to target for the plan",
        },
        "terraform-version": { type: "string", description: "Terraform/OpenTofu version to use" },
      },
      required: ["workspace_id"],
    },
    requires: ["runs:plan"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const workspaceId = String(args["workspace_id"]);
      const attributes = runCreationAttributes(args);
      const set: { status?: number | string; headers: Record<string, string | number> } = { headers: {} };
      const result = await createRun(
        workspaceId,
        attributes,
        undefined,
        session.userId === null ? null : { id: session.userId } as typeof users.$inferSelect,
        session.orgId ?? undefined,
        session.teamId ?? undefined,
        set,
      );
      if ("errors" in result) {
        const first = (result as { errors?: { detail?: string; title?: string }[] }).errors?.[0];
        const detail = first?.detail ?? first?.title ?? "Run creation failed";
        const status = set.status;
        if (status === 403 || status === 404) return toolError(detail);
        return toolBadRequest(detail);
      }
      return result["data"];
    },
  },
  {
    name: "apply_run",
    description: "Apply a completed plan on a run. Requires the runs:apply grant.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Run ID" },
        comment: { type: "string", description: "Optional comment recorded on the run" },
      },
      required: ["run_id"],
    },
    requires: ["runs:apply"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const runId = String(args["run_id"]);
      const authorized = await findAuthorizedRun(runId, session.userId ?? undefined, session.orgId, session.teamId);
      if (authorized === undefined) return toolError("Run not found or not authorized");
      if (!(await checkWorkspacePermission(authorized.workspace, session.userId ?? undefined, null, session.teamId, "apply"))) {
        return toolError("Not authorized to apply this run");
      }
      const before = await db.query.runs.findFirst({ where: and(eq(runs.id, runId), inArray(runs.status, ["planned", "planned_and_saved"])) });
      if (before === undefined) return toolBadRequest("Run must have a completed saved plan before apply");
      const pool = await selectApplyAgentPool(authorized);
      if (pool.error !== null) return toolBadRequest(pool.error);
      if (pool.id !== null) return applyRunThroughAgent(session, args, authorized, before, runId, pool.id);
      return applyRunDirectly(session, args, authorized, before, runId);
    },
  },
  {
    name: "discard_run",
    description: "Discard a run (mark it discarded). Requires the runs:discard grant.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Run ID" },
        comment: { type: "string", description: "Optional comment recorded on the run" },
      },
      required: ["run_id"],
    },
    requires: ["runs:discard"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const runId = String(args["run_id"]);
      const authorized = await findAuthorizedRun(runId, session.userId ?? undefined, session.orgId, session.teamId);
      if (authorized === undefined) return toolError("Run not found or not authorized");
      if (!(await checkWorkspacePermission(authorized.workspace, session.userId ?? undefined, session.orgId, session.teamId, "discard"))) {
        return toolError("Not authorized to discard this run");
      }
      const updated = await db.update(runs).set({ status: "discarded" }).where(and(
        eq(runs.id, runId),
        eq(runs.status, authorized.run.status),
        inArray(runs.status, ["pending", "planned", "planned_and_saved", "policy_soft_failed", "unreachable"]),
      )).returning();
      if (updated.length === 0) return toolBadRequest("Run is not discardable");
      if (typeof args["comment"] === "string" && args["comment"].trim() !== "") {
        await db.insert(runComments).values({ id: `rc-${crypto.randomUUID()}`, runId, userId: session.userId ?? null, body: args["comment"].trim(), createdAt: Date.now() });
      }
      await auditLog("discard", "runs", runId, session.userId ?? null, authorized.workspace.orgId, {
        workspaceId: authorized.workspace.id,
        fromStatus: authorized.run.status,
        toStatus: "discarded",
        ...(session.teamId !== null ? { teamId: session.teamId } : {}),
      });
      queueRunNotification(runId, "run:errored", "discarded");
      return { id: runId, status: "discarded" };
    },
  },
  {
    name: "cancel_run",
    description: "Cancel a run (mark it canceled). Requires the runs:cancel grant.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string", description: "Run ID" } },
      required: ["run_id"],
    },
    requires: ["runs:cancel"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const runId = String(args["run_id"]);
      const authorized = await findAuthorizedRun(runId, session.userId ?? undefined, session.orgId, session.teamId);
      if (authorized === undefined) return toolError("Run not found or not authorized");
      if (!(await checkWorkspacePermission(authorized.workspace, session.userId ?? undefined, session.orgId, session.teamId, "cancel"))) {
        return toolError("Not authorized to cancel this run");
      }
      const updated = await db.update(runs).set({
        status: "canceled",
        statusTimestamps: { ...(authorized.run.statusTimestamps ?? {}), "cancel-requested-at": new Date().toISOString() },
      }).where(and(
        eq(runs.id, runId),
        eq(runs.status, authorized.run.status),
        inArray(runs.status, [
          "pending", "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed",
          "queuing", "plan_queued", "planning", "cost_estimating", "cost_estimated",
          "policy_checking", "policy_override", "policy_checked", "post_plan_running",
          "post_plan_completed", "confirmed", "apply_queued", "applying",
        ]),
      )).returning();
      if (updated.length === 0) return toolBadRequest("Run is not cancelable");
      const { cancelRunExecution, cleanupSavedPlan } = await import("../../worker");
      cancelRunExecution(runId);
      await cleanupSavedPlan(runId);
      await cancelAgentJobsForRun(runId);
      await auditLog("cancel", "runs", runId, session.userId ?? null, authorized.workspace.orgId, {
        workspaceId: authorized.workspace.id,
        fromStatus: authorized.run.status,
        toStatus: "canceled",
        ...(session.teamId !== null ? { teamId: session.teamId } : {}),
      });
      queueRunNotification(runId, "run:errored", "canceled");
      return { id: runId, status: "canceled" };
    },
  },
  {
    name: "get_plan_json",
    description: "Return the sanitized JSON plan for a run (sensitive values redacted). Requires the runs:read grant.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string", description: "Run ID" } },
      required: ["run_id"],
    },
    requires: ["runs:read"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const runId = String(args["run_id"]);
      const authorized = await findAuthorizedRun(runId, session.userId ?? undefined, session.orgId, session.teamId);
      if (authorized === undefined) return toolError("Run not found or not authorized");
      if (!(await checkWorkspacePermission(authorized.workspace, session.userId ?? undefined, session.orgId, session.teamId, "run-read"))) {
        return toolError("Not authorized to read this run");
      }
      const planJson = await readPlanJsonSideArtifact(runId, "sanitized") ?? await readPlanJsonArtifact(runId);
      if (planJson === undefined) return toolBadRequest("Plan JSON output is unavailable for this run");
      return { run_id: runId, plan: sanitizePlanJson(planJson) };
    },
  },
];
