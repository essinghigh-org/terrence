import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "../../db";
import { agentPools, runs, runComments } from "../../db/schema";
import type { users } from "../../db/schema";
import { checkWorkspacePermission, findAuthorizedRun, findAuthorizedWorkspace, auditLog } from "../utils";
import { enqueueAgentApplyJob } from "../agent-jobs";
import { agentPoolAllowsWorkspace } from "../agent-pool-scope";
import { queueRunNotification } from "../notifications";
import { createRun } from "../../routes/runs";
import { toolBadRequest, toolError, type McpSession, type McpTool } from "./types";

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
      },
      required: ["workspace_id"],
    },
    requires: ["runs:read"],
    handler: async (session: McpSession, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const wsId = String(args.workspace_id);
      const ws = await findAuthorizedWorkspace(wsId, session.userId ?? undefined, session.orgId, session.teamId, "run-read");
      if (ws === undefined) return toolError("Workspace not found or not authorized");
      const runId = typeof args.run_id === "string" ? args.run_id : undefined;
      if (runId !== undefined) {
        const run = await db.query.runs.findFirst({
          where: eq(runs.id, runId),
          columns: { id: true, workspaceId: true, status: true, message: true, createdAt: true },
        });
        if (run === undefined) return toolBadRequest(`Run "${runId}" not found`);
        if (run.workspaceId !== wsId) return toolError("Run does not belong to the specified workspace");
        return run;
      }
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
      const offset = Math.max(Number(args.offset ?? 0), 0);
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
        "plan-only": { type: "boolean", description: "Skipp the apply" },
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
      const workspaceId = String(args.workspace_id);
      const attributes: Record<string, unknown> = {};
      for (const key of ["message", "terraform-version", "is-destroy", "auto-apply", "plan-only", "refresh", "refresh-only"]) {
        const value = args[key];
        if (value !== null && value !== undefined) attributes[key] = value;
      }
      if (Array.isArray(args["target-addrs"])) attributes["target-addrs"] = args["target-addrs"];
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
      return result.data;
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
      const runId = String(args.run_id);
      const authorized = await findAuthorizedRun(runId, session.userId ?? undefined, session.orgId, session.teamId);
      if (authorized === undefined) return toolError("Run not found or not authorized");
      if (!(await checkWorkspacePermission(authorized.workspace, session.userId ?? undefined, null, session.teamId, "apply"))) {
        return toolError("Not authorized to apply this run");
      }
      const before = await db.query.runs.findFirst({ where: and(eq(runs.id, runId), inArray(runs.status, ["planned", "planned_and_saved"])) });
      if (before === undefined) return toolBadRequest("Run must have a completed saved plan before apply");
      let agentPoolId: string | null = null;
      if (authorized.workspace.executionMode === "agent") {
        const pool = authorized.workspace.agentPoolId === null
          ? undefined
          : await db.query.agentPools.findFirst({ where: eq(agentPools.id, authorized.workspace.agentPoolId) });
        if (
          pool?.orgId !== authorized.workspace.orgId
          || !(await agentPoolAllowsWorkspace(pool, authorized.workspace.id, authorized.workspace.projectId))
        ) {
          return toolBadRequest("The workspace does not have an allowed agent pool");
        }
        agentPoolId = pool.id;
      }
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
      if (typeof args.comment === "string" && args.comment.trim() !== "") {
        await db.insert(runComments).values({ id: `rc-${crypto.randomUUID()}`, runId, userId: session.userId ?? null, body: args.comment.trim(), createdAt: Date.now() });
      }
      if (agentPoolId !== null) {
        const job = await enqueueAgentApplyJob(authorized.run.id, agentPoolId);
        if (job === undefined) return toolBadRequest("Run apply is already queued");
        return { id: authorized.run.id, status: "apply_queued" };
      }
      const { executeApply } = await import("../../worker");
      executeApply(authorized.run.id).catch((err: unknown): void => { if (err !== null && err !== undefined) console.error(err); });
      return { id: authorized.run.id, status: "applying" };
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
      const runId = String(args.run_id);
      const authorized = await findAuthorizedRun(runId, session.userId ?? undefined, session.orgId, session.teamId);
      if (authorized === undefined) return toolError("Run not found or not authorized");
      if (!(await checkWorkspacePermission(authorized.workspace, session.userId ?? undefined, null, session.teamId, "discard"))) {
        return toolError("Not authorized to discard this run");
      }
      const updated = await db.update(runs).set({ status: "discarded" }).where(and(eq(runs.id, runId), eq(runs.status, authorized.run.status), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"]))).returning();
      if (updated.length === 0) return toolBadRequest("Run is not discardable");
      if (typeof args.comment === "string" && args.comment.trim() !== "") {
        await db.insert(runComments).values({ id: `rc-${crypto.randomUUID()}`, runId, userId: session.userId ?? null, body: args.comment.trim(), createdAt: Date.now() });
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
      const runId = String(args.run_id);
      const authorized = await findAuthorizedRun(runId, session.userId ?? undefined, session.orgId, session.teamId);
      if (authorized === undefined) return toolError("Run not found or not authorized");
      if (!(await checkWorkspacePermission(authorized.workspace, session.userId ?? undefined, null, session.teamId, "cancel"))) {
        return toolError("Not authorized to cancel this run");
      }
      const updated = await db.update(runs).set({ status: "canceled" }).where(and(eq(runs.id, runId), eq(runs.status, authorized.run.status), notInArray(runs.status, ["applied", "planned_and_finished", "errored", "canceled", "discarded", "force_canceled"]))).returning();
      if (updated.length === 0) return toolBadRequest("Run is not cancelable");
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
];