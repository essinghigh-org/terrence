import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { isPostgres } from "../../src/db/driver";
import { controlPlaneLeases } from "../../src/db/schema";
import {
  assertControlPlaneCoordinatorFenceTx,
  CONTROL_PLANE_LEASE_NAME,
  claimControlPlaneLease,
  controlPlaneCoordinatorElectionInFlight,
  controlPlaneCoordinatorState,
  controlPlaneCoordinatorSuspended,
  releaseControlPlaneLease,
  resignControlPlaneLease,
  resumeControlPlaneCoordinator,
  runControlPlaneCoordinatorTickForTests,
  startControlPlaneCoordinator,
  StaleControlPlaneCoordinatorFenceError,
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
const postgresTest = isPostgres ? test : test.skip;
const originalHaEnabled = process.env["TERRENCE_HA_ENABLED"];
const originalDisableWorker = process.env["TERRENCE_DISABLE_WORKER"];
const originalNodeId = process.env["TERRENCE_NODE_ID"];

beforeEach(async (): Promise<void> => {
  await stopControlPlaneCoordinator();
  await db.delete(controlPlaneLeases).where(eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME));
});

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

    expect(await releaseControlPlaneLease(identityB, takeover.fencingEpoch, 1_170)).toBe(true);
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
    expect(await releaseControlPlaneLease(identityA, 1, 10_102)).toBe(false);

    const current = await db.query.controlPlaneLeases.findFirst({
      where: eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME),
    });
    expect(current).toMatchObject({
      ownerNodeId: "node-b",
      ownerInstanceId: "instance-b",
      fencingEpoch: 2,
    });
  });

  test("does not let an older claim release a newer epoch owned by the same instance", async () => {
    const first = await claimControlPlaneLease(identityA, 10_000, 100);
    expect(await releaseControlPlaneLease(identityA, first.fencingEpoch, 10_050)).toBe(true);
    const resumed = await claimControlPlaneLease(identityA, 10_051, 100);
    expect(resumed.fencingEpoch).toBe(first.fencingEpoch + 1);

    expect(await releaseControlPlaneLease(identityA, first.fencingEpoch, 10_052)).toBe(false);
    const current = await db.query.controlPlaneLeases.findFirst({
      where: eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME),
    });
    expect(current).toMatchObject({ fencingEpoch: resumed.fencingEpoch, expiresAt: resumed.expiresAt });
    expect(await releaseControlPlaneLease(identityA, resumed.fencingEpoch, 10_053)).toBe(true);
  });

  test("stops scheduler and assessment work without revoking an independently leased run", async () => {
    process.env["TERRENCE_HA_ENABLED"] = "true";
    process.env["TERRENCE_DISABLE_WORKER"] = "false";
    process.env["TERRENCE_NODE_ID"] = "node-a";

    let leadershipLost = 0;
    let runKillCalls = 0;
    let assessmentKillCalls = 0;
    const runId = "coordinator-lease-loss-" + crypto.randomUUID();
    trackRunProcessForTests(runId, {
      pid: null,
      kill: (): void => {
        runKillCalls += 1;
      },
      exited: new Promise<number>(() => undefined),
    });
    trackRunProcessForTests(`assessment-${crypto.randomUUID()}`, {
      pid: null,
      kill: (): void => {
        assessmentKillCalls += 1;
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
    // Run/workspace execution leases remain independent of the scheduler,
    // while coordinator-owned assessments are fenced immediately.
    expect(runKillCalls).toBe(0);
    expect(assessmentKillCalls).toBe(1);
  });

  test("shutdown cannot release a newer same-instance epoch while its leadership callback settles", async () => {
    process.env["TERRENCE_HA_ENABLED"] = "true";
    process.env["TERRENCE_DISABLE_WORKER"] = "false";
    process.env["TERRENCE_NODE_ID"] = "node-a";
    let entered!: () => void;
    const blocked = new Promise<void>((resolve): void => {
      entered = resolve;
    });
    let resume!: () => void;
    const released = new Promise<void>((resolve): void => {
      resume = resolve;
    });
    await startControlPlaneCoordinator({
      onLeadershipAcquired: (): void => undefined,
      onLeadershipLost: async (): Promise<void> => {
        entered();
        await released;
      },
    });
    const first = controlPlaneCoordinatorState();
    if (first.expiresAt === null) throw new Error("expected coordinator lease");
    const stopping = stopControlPlaneCoordinator();
    await blocked;
    try {
      const resumed = await claimControlPlaneLease(
        { nodeId: "node-a", instanceId: controlPlaneInstanceId },
        first.expiresAt + 1,
      );
      expect(resumed.fencingEpoch).toBe((first.fencingEpoch ?? 0) + 1);
      resume();
      await stopping;
      const current = await db.query.controlPlaneLeases.findFirst({
        where: eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME),
      });
      expect(current).toMatchObject({ fencingEpoch: resumed.fencingEpoch, expiresAt: resumed.expiresAt });
    } finally {
      resume();
      await stopping;
    }
  });

  postgresTest("transactional coordinator fence rejects a stale epoch", async () => {
    process.env["TERRENCE_HA_ENABLED"] = "true";
    process.env["TERRENCE_DISABLE_WORKER"] = "false";
    process.env["TERRENCE_NODE_ID"] = "node-a";

    await startControlPlaneCoordinator({
      onLeadershipAcquired: (): void => undefined,
      onLeadershipLost: handleControlPlaneLeadershipLost,
    });
    const epoch = controlPlaneCoordinatorState().fencingEpoch;
    expect(epoch).toBe(1);
    if (epoch === null) throw new Error("expected coordinator epoch");

    await db.transaction(async (transaction): Promise<void> => {
      await assertControlPlaneCoordinatorFenceTx(transaction, epoch);
    });

    const now = Date.now();
    await db
      .update(controlPlaneLeases)
      .set({
        ownerNodeId: "node-b",
        ownerInstanceId: "other-instance",
        fencingEpoch: epoch + 1,
        expiresAt: now + 60_000,
        heartbeatAt: now,
      })
      .where(eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME));

    let staleError: unknown;
    try {
      await db.transaction(async (transaction): Promise<void> => {
        await assertControlPlaneCoordinatorFenceTx(transaction, epoch);
      });
    } catch (error: unknown) {
      staleError = error;
    }
    expect(staleError).toBeInstanceOf(StaleControlPlaneCoordinatorFenceError);
  });
});

describe("coordinator resignation", () => {
  test("resigning expires the lease so a follower can claim without waiting out the TTL", async () => {
    process.env["TERRENCE_HA_ENABLED"] = "true";
    process.env["TERRENCE_DISABLE_WORKER"] = "false";
    process.env["TERRENCE_NODE_ID"] = "node-a";

    let leadershipLost = 0;
    await startControlPlaneCoordinator({
      onLeadershipAcquired: (): void => undefined,
      onLeadershipLost: (): void => {
        leadershipLost += 1;
        handleControlPlaneLeadershipLost();
      },
    });
    expect(controlPlaneCoordinatorState()).toMatchObject({ role: "leader", fencingEpoch: 1 });
    setCoordinatorWorkerRunningForTests(true);

    expect(await resignControlPlaneLease()).toBe(true);

    // The scheduler generation stops before the lease is surrendered; releasing
    // first would leave this node generating work against a cluster that
    // already has a new leader.
    expect(leadershipLost).toBe(1);
    expect(coordinatorWorkerRunningForTests()).toBe(false);
    expect(controlPlaneCoordinatorSuspended()).toBe(true);

    const lease = await db.query.controlPlaneLeases.findFirst({
      where: eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME),
    });
    expect(lease?.expiresAt).toBe(0);

    // A follower contends immediately rather than after CONTROL_PLANE_LEASE_TTL_MS.
    const successor = await claimControlPlaneLease(identityB, 50_000, 15_000);
    expect(successor).toMatchObject({ acquired: true, ownerNodeId: "node-b", fencingEpoch: 2 });
  });

  test("a resigned coordinator does not reclaim the lease on its next tick", async () => {
    process.env["TERRENCE_HA_ENABLED"] = "true";
    process.env["TERRENCE_DISABLE_WORKER"] = "false";
    process.env["TERRENCE_NODE_ID"] = "node-a";

    await startControlPlaneCoordinator({
      onLeadershipAcquired: (): void => undefined,
      onLeadershipLost: handleControlPlaneLeadershipLost,
    });
    expect(controlPlaneCoordinatorState().role).toBe("leader");
    await resignControlPlaneLease();

    // Suspension prevents the next renewal tick from taking the lease back.
    await runControlPlaneCoordinatorTickForTests();
    expect(controlPlaneCoordinatorState().role).not.toBe("leader");

    const lease = await db.query.controlPlaneLeases.findFirst({
      where: eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME),
    });
    expect(lease?.ownerInstanceId).toBe(controlPlaneInstanceId);
    expect(lease?.expiresAt).toBe(0);
  });

  test("a suspended coordinator still observes who leads", async () => {
    process.env["TERRENCE_HA_ENABLED"] = "true";
    process.env["TERRENCE_DISABLE_WORKER"] = "false";
    process.env["TERRENCE_NODE_ID"] = "node-a";

    await startControlPlaneCoordinator({
      onLeadershipAcquired: (): void => undefined,
      onLeadershipLost: handleControlPlaneLeadershipLost,
    });
    await resignControlPlaneLease();
    await claimControlPlaneLease(identityB, 60_000, 15_000);

    await runControlPlaneCoordinatorTickForTests();
    // Operations surfaces must keep reporting an accurate coordinator during a
    // drain, so suspension means "do not contend", not "stop looking".
    expect(controlPlaneCoordinatorState()).toMatchObject({ role: "follower", ownerNodeId: "node-b" });
  });

  test("resuming returns a resigned node to the election", async () => {
    process.env["TERRENCE_HA_ENABLED"] = "true";
    process.env["TERRENCE_DISABLE_WORKER"] = "false";
    process.env["TERRENCE_NODE_ID"] = "node-a";

    await startControlPlaneCoordinator({
      onLeadershipAcquired: (): void => undefined,
      onLeadershipLost: handleControlPlaneLeadershipLost,
    });
    await resignControlPlaneLease();
    expect(controlPlaneCoordinatorSuspended()).toBe(true);

    resumeControlPlaneCoordinator();
    expect(controlPlaneCoordinatorSuspended()).toBe(false);
    await runControlPlaneCoordinatorTickForTests();
    expect(controlPlaneCoordinatorState().role).toBe("leader");
  });

  test("resignation is a no-op when this node does not own the lease", async () => {
    process.env["TERRENCE_HA_ENABLED"] = "true";
    await claimControlPlaneLease(identityB, 70_000, 15_000);
    expect(await resignControlPlaneLease()).toBe(false);

    const lease = await db.query.controlPlaneLeases.findFirst({
      where: eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME),
    });
    // A node that never held the lease must not be able to expire someone
    // else's ownership by resigning.
    expect(lease).toMatchObject({ ownerNodeId: "node-b", fencingEpoch: 1 });
    expect(lease?.expiresAt).toBe(85_000);
  });

  test("a drain suspension requested before election startup is preserved", async () => {
    process.env["TERRENCE_HA_ENABLED"] = "true";
    process.env["TERRENCE_DISABLE_WORKER"] = "false";
    process.env["TERRENCE_NODE_ID"] = "node-a";

    expect(await resignControlPlaneLease()).toBe(false);
    expect(controlPlaneCoordinatorSuspended()).toBe(true);

    await startControlPlaneCoordinator({
      onLeadershipAcquired: (): void => undefined,
      onLeadershipLost: handleControlPlaneLeadershipLost,
    });
    await runControlPlaneCoordinatorTickForTests();

    expect(controlPlaneCoordinatorSuspended()).toBe(true);
    expect(controlPlaneCoordinatorState().role).toBe("follower");
    expect(
      await db.query.controlPlaneLeases.findFirst({ where: eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME) }),
    ).toBeUndefined();
  });

  postgresTest("an election completing after drain suspension releases ownership before the tick settles", async () => {
    process.env["TERRENCE_HA_ENABLED"] = "true";
    process.env["TERRENCE_DISABLE_WORKER"] = "false";
    process.env["TERRENCE_NODE_ID"] = "node-a";

    // Start suspended so initial coordinator startup only observes the lease.
    expect(await resignControlPlaneLease()).toBe(false);
    await startControlPlaneCoordinator({
      onLeadershipAcquired: (): void => undefined,
      onLeadershipLost: handleControlPlaneLeadershipLost,
    });
    await db.insert(controlPlaneLeases).values({
      name: CONTROL_PLANE_LEASE_NAME,
      ownerNodeId: "node-b",
      ownerInstanceId: "instance-b",
      fencingEpoch: 1,
      expiresAt: 0,
      heartbeatAt: 0,
    });

    let releaseRow!: () => void;
    const holdRow = new Promise<void>((resolve): void => {
      releaseRow = resolve;
    });
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve): void => {
      markLocked = resolve;
    });
    const blocker = db.transaction(async (tx): Promise<void> => {
      await tx
        .update(controlPlaneLeases)
        .set({ heartbeatAt: 1 })
        .where(eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME));
      markLocked();
      await holdRow;
    });
    await locked;

    try {
      resumeControlPlaneCoordinator();
      const electionDeadline = Date.now() + 2_000;
      while (!controlPlaneCoordinatorElectionInFlight()) {
        if (Date.now() >= electionDeadline) throw new Error("coordinator election did not enter the in-flight state");
        await Bun.sleep(10);
      }

      const resignation = resignControlPlaneLease();
      expect(controlPlaneCoordinatorSuspended()).toBe(true);
      expect(controlPlaneCoordinatorElectionInFlight()).toBe(true);

      releaseRow();
      await blocker;
      await resignation;
      const settleDeadline = Date.now() + 2_000;
      while (controlPlaneCoordinatorElectionInFlight()) {
        if (Date.now() >= settleDeadline) throw new Error("coordinator election did not settle after suspension");
        await Bun.sleep(10);
      }

      expect(controlPlaneCoordinatorState().role).not.toBe("leader");
      const lease = await db.query.controlPlaneLeases.findFirst({
        where: eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME),
      });
      expect(lease?.expiresAt).toBe(0);
    } finally {
      releaseRow();
      await blocker.catch((): void => undefined);
    }
  });
});
