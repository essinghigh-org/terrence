import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

const previousHa = process.env["TERRENCE_HA_ENABLED"];
const previousNodeId = process.env["TERRENCE_NODE_ID"];
process.env["TERRENCE_HA_ENABLED"] = "true";
process.env["TERRENCE_NODE_ID"] = "recovery-node";

const { db } = await import("../../src/db");
const { organizations, runs, workspaces } = await import("../../src/db/schema");
const { reconcileExpiredLocalRunExecutions } = await import("../../src/worker");

const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const orgId = `org-execution-recovery-${suffix}`;
const expiredPlanWs = `ws-expired-plan-${suffix}`;
const expiredFetchWs = `ws-expired-fetch-${suffix}`;
const expiredConfirmedWs = `ws-expired-confirmed-${suffix}`;
const expiredFinalWs = `ws-expired-final-${suffix}`;
const liveWs = `ws-live-plan-${suffix}`;
const expiredPlanRun = `run-expired-plan-${suffix}`;
const expiredFetchRun = `run-expired-fetch-${suffix}`;
const expiredConfirmedRun = `run-expired-confirmed-${suffix}`;
const expiredFinalRun = `run-expired-final-${suffix}`;
const liveRun = `run-live-plan-${suffix}`;
const workspaceIds = [expiredPlanWs, expiredFetchWs, expiredConfirmedWs, expiredFinalWs, liveWs];
const runIds = [expiredPlanRun, expiredFetchRun, expiredConfirmedRun, expiredFinalRun, liveRun];

function executionWorkspace(id: string, runId: string, expiresAt: number): typeof workspaces.$inferInsert {
  return {
    id,
    orgId,
    name: id,
    executionMode: "remote",
    executionRunId: runId,
    executionOwnerNodeId: "dead-node",
    executionOwnerInstanceId: "dead-instance",
    executionFencingToken: 1,
    executionLeaseHeartbeatAt: expiresAt - 30_000,
    executionLeaseExpiresAt: expiresAt,
  };
}

function executionRun(
  id: string,
  workspaceId: string,
  status: string,
  phase: "plan" | "apply",
  expiresAt: number,
): typeof runs.$inferInsert {
  return {
    id,
    workspaceId,
    status,
    planOnly: false,
    executionOwnerNodeId: "dead-node",
    executionOwnerInstanceId: "dead-instance",
    executionFencingToken: 1,
    executionLeaseHeartbeatAt: expiresAt - 30_000,
    executionLeaseExpiresAt: expiresAt,
    executionPhase: phase,
    createdAt: Date.now(),
  };
}

beforeAll(async (): Promise<void> => {
  const now = Date.now();
  const expired = now - 1_000;
  const live = now + 60_000;
  await db.insert(organizations).values({ id: orgId, name: orgId });
  await db
    .insert(workspaces)
    .values([
      executionWorkspace(expiredPlanWs, expiredPlanRun, expired),
      executionWorkspace(expiredFetchWs, expiredFetchRun, expired),
      executionWorkspace(expiredConfirmedWs, expiredConfirmedRun, expired),
      executionWorkspace(expiredFinalWs, expiredFinalRun, expired),
      executionWorkspace(liveWs, liveRun, live),
    ]);
  await db
    .insert(runs)
    .values([
      executionRun(expiredPlanRun, expiredPlanWs, "planning", "plan", expired),
      executionRun(expiredFetchRun, expiredFetchWs, "fetching", "plan", expired),
      executionRun(expiredConfirmedRun, expiredConfirmedWs, "confirmed", "apply", expired),
      executionRun(expiredFinalRun, expiredFinalWs, "applied", "apply", expired),
      executionRun(liveRun, liveWs, "planning", "plan", live),
    ]);
});

afterAll(async (): Promise<void> => {
  await db
    .delete(runs)
    .where(inArray(runs.id, runIds))
    .catch((): void => undefined);
  await db
    .delete(workspaces)
    .where(inArray(workspaces.id, workspaceIds))
    .catch((): void => undefined);
  await db
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .catch((): void => undefined);
  if (previousHa === undefined) delete process.env["TERRENCE_HA_ENABLED"];
  else process.env["TERRENCE_HA_ENABLED"] = previousHa;
  if (previousNodeId === undefined) delete process.env["TERRENCE_NODE_ID"];
  else process.env["TERRENCE_NODE_ID"] = previousNodeId;
});

describe("expired local execution recovery", () => {
  test("recovers only expired database leases and leaves a live owner authoritative", async () => {
    const result = await reconcileExpiredLocalRunExecutions();
    expect(result).toEqual({ requeued: 1, errored: 1, rearmed: 1 });

    const rows = await db.query.runs.findMany({ where: inArray(runs.id, runIds) });
    const byId = new Map(rows.map((row) => [row.id, row]));

    const expiredPlan = byId.get(expiredPlanRun);
    expect(expiredPlan?.status).toBe("errored");
    expect(expiredPlan?.executionOwnerNodeId).toBeNull();
    expect(expiredPlan?.executionOwnerInstanceId).toBeNull();
    expect(expiredPlan?.executionFencingToken).toBe(2);

    const expiredFetch = byId.get(expiredFetchRun);
    expect(expiredFetch?.status).toBe("pending");
    expect(expiredFetch?.executionOwnerNodeId).toBeNull();
    expect(expiredFetch?.executionFencingToken).toBe(2);

    const expiredConfirmed = byId.get(expiredConfirmedRun);
    expect(expiredConfirmed?.status).toBe("confirmed");
    expect(expiredConfirmed?.scheduledAt).not.toBeNull();
    expect(expiredConfirmed?.executionOwnerNodeId).toBeNull();
    expect(expiredConfirmed?.executionOwnerInstanceId).toBeNull();
    expect(expiredConfirmed?.executionFencingToken).toBe(1);

    const expiredFinal = byId.get(expiredFinalRun);
    expect(expiredFinal?.status).toBe("applied");
    expect(expiredFinal?.executionOwnerNodeId).toBeNull();
    expect(expiredFinal?.executionOwnerInstanceId).toBeNull();
    // Cleanup never rewinds the fencing generation.
    expect(expiredFinal?.executionFencingToken).toBe(1);

    const live = byId.get(liveRun);
    expect(live?.status).toBe("planning");
    expect(live?.executionOwnerNodeId).toBe("dead-node");
    expect(live?.executionOwnerInstanceId).toBe("dead-instance");
    expect(live?.executionFencingToken).toBe(1);

    const recoveredWorkspaces = await db.query.workspaces.findMany({
      where: inArray(workspaces.id, [expiredPlanWs, expiredFetchWs, expiredConfirmedWs, expiredFinalWs]),
    });
    expect(recoveredWorkspaces.every((workspace) => workspace.executionRunId === null)).toBe(true);

    expect(await reconcileExpiredLocalRunExecutions()).toEqual({ requeued: 0, errored: 0, rearmed: 0 });
  });
});
