import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { controlPlaneLeases } from "../../src/db/schema";
import {
  CONTROL_PLANE_LEASE_NAME,
  claimControlPlaneLease,
  controlPlaneCoordinatorState,
  releaseControlPlaneLease,
  runControlPlaneCoordinatorTickForTests,
  startControlPlaneCoordinator,
  stopControlPlaneCoordinator,
} from "../../src/lib/control-plane-coordinator";
import { controlPlaneInstanceId } from "../../src/lib/ha-config";
import {
  clearTrackedRunProcessesForTests,
  coordinatorWorkerRunningForTests,
  handleControlPlaneLeadershipLost,
  setCoordinatorWorkerRunningForTests,
  trackRunProcessForTests,
} from "../../src/worker";

const identityA = { nodeId: "node-a", instanceId: "instance-a" };
const identityB = { nodeId: "node-b", instanceId: "instance-b" };
const originalHaEnabled = process.env["TERRENCE_HA_ENABLED"];
const originalDisableWorker = process.env["TERRENCE_DISABLE_WORKER"];
const originalNodeId = process.env["TERRENCE_NODE_ID"];

afterEach(async (): Promise<void> => {
  await stopControlPlaneCoordinator();
  setCoordinatorWorkerRunningForTests(false);
  clearTrackedRunProcessesForTests();
  if (originalHaEnabled === undefined) delete process.env["TERRENCE_HA_ENABLED"];
  else process.env["TERRENCE_HA_ENABLED"] = originalHaEnabled;
  if (originalDisableWorker === undefined) delete process.env["TERRENCE_DISABLE_WORKER"];
  else process.env["TERRENCE_DISABLE_WORKER"] = originalDisableWorker;
  if (originalNodeId === undefined) delete process.env["TERRENCE_NODE_ID"];
  else process.env["TERRENCE_NODE_ID"] = originalNodeId;
  await db.delete(controlPlaneLeases).where(eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME));
});

describe("control-plane coordinator leases", () => {
  test("renews the current owner and fences a later takeover with a monotonically increasing epoch", async () => {
    const first = await claimControlPlaneLease(identityA, 1_000, 100);
    expect(first).toMatchObject({
      acquired: true,
      ownerNodeId: "node-a",
      ownerInstanceId: "instance-a",
      fencingEpoch: 1,
      expiresAt: 1_100,
    });

    const blocked = await claimControlPlaneLease(identityB, 1_050, 100);
    expect(blocked).toMatchObject({
      acquired: false,
      ownerNodeId: "node-a",
      ownerInstanceId: "instance-a",
      fencingEpoch: 1,
    });

    const renewed = await claimControlPlaneLease(identityA, 1_060, 100);
    expect(renewed).toMatchObject({
      acquired: true,
      fencingEpoch: 1,
      expiresAt: 1_160,
    });

    const takeover = await claimControlPlaneLease(identityB, 1_161, 100);
    expect(takeover).toMatchObject({
      acquired: true,
      ownerNodeId: "node-b",
      ownerInstanceId: "instance-b",
      fencingEpoch: 2,
      expiresAt: 1_261,
    });

    expect(await releaseControlPlaneLease(identityB, 1_170)).toBe(true);
    const reacquired = await claimControlPlaneLease(identityA, 1_171, 100);
    expect(reacquired).toMatchObject({
      acquired: true,
      ownerNodeId: "node-a",
      fencingEpoch: 3,
    });
  });

  test("allows exactly one winner when replicas concurrently claim a missing lease", async () => {
    const identities = [
      { nodeId: "node-a", instanceId: "instance-a" },
      { nodeId: "node-b", instanceId: "instance-b" },
      { nodeId: "node-c", instanceId: "instance-c" },
    ];

    const claims = await Promise.all(identities.map((identity) => claimControlPlaneLease(identity, 5_000, 500)));
    expect(claims.filter((claim) => claim.acquired)).toHaveLength(1);

    const owners = new Set(claims.map((claim) => claim.ownerInstanceId));
    expect(owners.size).toBe(1);
    expect(claims.every((claim) => claim.fencingEpoch === 1)).toBe(true);
  });

  test("does not let a stale instance release a lease after another instance takes over", async () => {
    await claimControlPlaneLease(identityA, 10_000, 100);
    const takeover = await claimControlPlaneLease(identityB, 10_101, 100);
    expect(takeover.acquired).toBe(true);
    expect(await releaseControlPlaneLease(identityA, 10_102)).toBe(false);

    const current = await db.query.controlPlaneLeases.findFirst({
      where: eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME),
    });
    expect(current).toMatchObject({
      ownerNodeId: "node-b",
      ownerInstanceId: "instance-b",
      fencingEpoch: 2,
    });
  });

  test("fences scheduler ownership and active executions when a live coordinator loses its lease", async () => {
    process.env["TERRENCE_HA_ENABLED"] = "true";
    process.env["TERRENCE_DISABLE_WORKER"] = "false";
    process.env["TERRENCE_NODE_ID"] = "node-a";

    let leadershipLost = 0;
    let killCalls = 0;
    const runId = "coordinator-lease-loss-" + crypto.randomUUID();
    trackRunProcessForTests(runId, {
      pid: null,
      kill: (): void => {
        killCalls += 1;
      },
      exited: new Promise<number>(() => undefined),
    });

    await startControlPlaneCoordinator({
      onLeadershipAcquired: (): void => undefined,
      onLeadershipLost: (): void => {
        leadershipLost += 1;
        handleControlPlaneLeadershipLost();
      },
    });
    expect(controlPlaneCoordinatorState()).toMatchObject({ role: "leader", fencingEpoch: 1 });
    setCoordinatorWorkerRunningForTests(true);
    expect(coordinatorWorkerRunningForTests()).toBe(true);

    const now = Date.now();
    await db
      .update(controlPlaneLeases)
      .set({
        ownerNodeId: "node-b",
        ownerInstanceId: "forced-" + controlPlaneInstanceId,
        fencingEpoch: 2,
        expiresAt: now + 60_000,
        heartbeatAt: now,
      })
      .where(eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME));

    await runControlPlaneCoordinatorTickForTests();

    expect(leadershipLost).toBe(1);
    expect(controlPlaneCoordinatorState()).toMatchObject({
      role: "follower",
      ownerNodeId: "node-b",
      fencingEpoch: 2,
    });
    expect(coordinatorWorkerRunningForTests()).toBe(false);
    expect(killCalls).toBe(1);
  });
});
