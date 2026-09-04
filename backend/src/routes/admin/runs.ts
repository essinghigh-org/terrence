import { cancelAgentJobsForRun } from "../../lib/agent-jobs";
import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import { db } from "../../db";
import { databaseMetrics } from "../../db";
import { runs } from "../../db/schema";
import { eq, and, desc, notInArray } from "drizzle-orm";
import { runResource } from "../../lib/response";
import { linkageForRuns } from "../runs";
import { FINAL_RUN_STATUSES } from "../../lib/utils";
import providerSurface from "../../data/provider_surface.json";
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
    });
    return {
      data: activeRuns.map((r: RunItem): Record<string, unknown> => ({
        id: r.id,
        type: "runs",
        attributes: {
          status: r.status,
          message: r.message,
          "created-at": new Date(r.createdAt).toISOString(),
          actions: {
            "is-cancelable": true,
            "is-force-cancelable": true,
          },
        },
      })),
    };
  })
  .get("/api/v2/admin/provider-surface", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (user?.isSiteAdmin !== true) { (set as { status: number }).status = 404; return { errors: [{ status: "404", title: "Not Found" }] }; }
    return {
      data: {
        ...providerSurface,
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
    const updated = await db.update(runs).set({ status: "canceled" }).where(and(eq(runs.id, runId), notInArray(runs.status, FINAL_RUN_STATUSES))).returning();
    if (updated.length === 0 || updated[0] === undefined) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not cancelable" }] }; }
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
    const updated = await db.update(runs).set({ status: "force_canceled" }).where(and(eq(runs.id, runId), notInArray(runs.status, FINAL_RUN_STATUSES))).returning();
    if (updated.length === 0 || updated[0] === undefined) { (set as { status: number }).status = 409; return { errors: [{ status: "409", title: "Conflict", detail: "Run is not force-cancelable" }] }; }
    const { cancelRunExecution, cleanupSavedPlan } = await import("../../worker");
    cancelRunExecution(runId, true);
    await Promise.allSettled([cleanupSavedPlan(runId), cancelAgentJobsForRun(runId)]);
    const linkage = await linkageForRuns([updated[0]]);
    return { data: runResource(updated[0], true, false, undefined, undefined, true, linkage.get(updated[0].id)) };
  });
