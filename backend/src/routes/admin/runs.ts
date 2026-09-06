import { cancelAgentJobsForRun } from "../../lib/agent-jobs";
import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import { db } from "../../db";
import { databaseMetrics } from "../../db";
import { runs, workspaces } from "../../db/schema";
import { eq, and, desc, notInArray } from "drizzle-orm";
import { runResource } from "../../lib/response";
import { linkageForRuns } from "../runs";
import { FINAL_RUN_STATUSES } from "../../lib/utils";
import { auditLog } from "../../lib/utils";
import { inspectRunQueue, queueInspectionResource, queueInspectorCapacity } from "../../lib/queue-inspector";
import providerSurface from "../../data/provider_surface.json";
import providerLifecycleContract from "../../data/provider_lifecycle_contract.json" with { type: "json" };
import { getLatestTfeProviderVersion } from "../../lib/provider-version";
import type { ParamCtx } from "./types";
import type { RunItem } from "./helpers";
export const runsRoutes = new Elysia({ name: "admin-runs" })
  .use(authPlugin)
  .get("/api/v2/admin/runs", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const activeRuns = await db.query.runs.findMany({
      where: notInArray(runs.status, FINAL_RUN_STATUSES),
      orderBy: [desc(runs.createdAt)],
      limit: 200,
    });
    const snapshotAt = Date.now();
    let workerDraining = false;
    let localConcurrencyLimit: number | undefined;
    let localExecuting: number | undefined;
    try {
      const worker = await import("../../worker");
      workerDraining = worker.workerQueueDraining();
      localConcurrencyLimit = worker.localRunConcurrencyLimit();
      localExecuting = worker.activeLocalRunExecutionCount();
    } catch {
      // Diagnostics remain useful when the optional worker module is not
      // available during a degraded startup or an isolated API test.
    }
    const queueContext = {
      now: snapshotAt,
      workerDraining,
      ...(localConcurrencyLimit === undefined ? {} : { localConcurrencyLimit }),
      ...(localExecuting === undefined ? {} : { localExecuting }),
    };
    const [capacity, inspections] = await Promise.all([
      queueInspectorCapacity(snapshotAt),
      Promise.all(activeRuns.map(async (run): Promise<readonly [string, Record<string, unknown>]> => [
        run.id,
        queueInspectionResource(await inspectRunQueue(run, queueContext)),
      ])),
    ]);
    const inspectionByRunId = new Map(inspections);
    return {
      data: activeRuns.map((r: RunItem): Record<string, unknown> => ({
        id: r.id,
        type: "runs",
        attributes: {
          status: r.status,
          message: r.message,
          "created-at": new Date(r.createdAt).toISOString(),
          "queue-inspection": inspectionByRunId.get(r.id) ?? null,
          actions: {
            "is-cancelable": true,
            "is-force-cancelable": true,
          },
        },
      })),
      meta: {
        "queue-inspector": {
          "snapshot-at": new Date(snapshotAt).toISOString(),
          "position-note": "Queue positions are qualified snapshot estimates. Worker claims, cancellations, locks and heartbeats can change them.",
          capacity,
          controls: {
            "cancel-supported": true,
            "reprioritize-supported": false,
            "reprioritize-reason": "Queued runs do not have a persisted priority field; cancellation preserves scheduler gates and serialization.",
          },
          "truncated-at": 200,
        },
      },
    };
  })
  .get("/api/v2/admin/provider-surface", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return {
      data: {
        ...providerSurface,
        // Schema coverage and lifecycle evidence are separate contracts. The
        // checked-in contract tells the dashboard which named fixtures must
        // pass before a family can be called fully exercised.
        lifecycle_contract: providerLifecycleContract,
        // Latest stable hashicorp/tfe release (cached, 24h TTL). Null when
        // the upstream lookup fails; the dashboard hides the chip then.
        "latest-available": await getLatestTfeProviderVersion(),
      },
    };
  })
  .get("/api/v2/admin/database-metrics", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return { data: await databaseMetrics() };
  })
  .get("/api/v2/admin/runs/:run_id", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const linkage = await linkageForRuns([run]);
    return { data: runResource(run, true, false, undefined, undefined, true, linkage.get(run.id)) };
  })
  .post("/api/v2/admin/runs/:run_id/actions/cancel", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
    const updated = await db.update(runs).set({ status: "canceled" }).where(and(eq(runs.id, runId), notInArray(runs.status, FINAL_RUN_STATUSES))).returning();
    if (updated.length === 0 || updated[0] === undefined) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not cancelable" }] }; }
    await auditLog("cancel", "runs", runId, user.id, workspace?.orgId ?? null, {
      source: "site-admin-queue-inspector",
      before: { status: run.status },
      after: { status: "canceled" },
    });
    const { cancelRunExecution, cleanupSavedPlan } = await import("../../worker");
    cancelRunExecution(runId);
    await Promise.allSettled([cleanupSavedPlan(runId), cancelAgentJobsForRun(runId)]);
    const linkage = await linkageForRuns([updated[0]]);
    return { data: runResource(updated[0], true, false, undefined, undefined, true, linkage.get(updated[0].id)) };
  })
  .post("/api/v2/admin/runs/:run_id/actions/force-cancel", async ({ params, user, set }: ParamCtx): Promise<unknown> => {
    const runId = params["run_id"] ?? "";
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run === undefined) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
    const updated = await db.update(runs).set({ status: "force_canceled" }).where(and(eq(runs.id, runId), notInArray(runs.status, FINAL_RUN_STATUSES))).returning();
    if (updated.length === 0 || updated[0] === undefined) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not force-cancelable" }] }; }
    await auditLog("force-cancel", "runs", runId, user.id, workspace?.orgId ?? null, {
      source: "site-admin-queue-inspector",
      before: { status: run.status },
      after: { status: "force_canceled" },
    });
    const { cancelRunExecution, cleanupSavedPlan } = await import("../../worker");
    cancelRunExecution(runId, true);
    await Promise.allSettled([cleanupSavedPlan(runId), cancelAgentJobsForRun(runId)]);
    const linkage = await linkageForRuns([updated[0]]);
    return { data: runResource(updated[0], true, false, undefined, undefined, true, linkage.get(updated[0].id)) };
  });
