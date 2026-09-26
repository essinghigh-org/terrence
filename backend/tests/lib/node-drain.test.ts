import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { controlPlaneNodes } from "../../src/db/schema";
import { controlPlaneInstanceId } from "../../src/lib/ha-config";
import { HA_PROTOCOL_VERSION } from "../../src/lib/ha-protocol";
import { publish } from "../../src/lib/event-bus";
import { claimControlPlaneNodeIdentity } from "../../src/routes/health";
import {
  controlPlaneCoordinatorSuspended,
  isControlPlaneCoordinatorLeader,
  startControlPlaneCoordinator,
  stopControlPlaneCoordinator,
} from "../../src/lib/control-plane-coordinator";
import {
  beginLocalNodeDrain,
  cancelLocalNodeDrain,
  cancelNodeDrain,
  evaluateNodeDrainCompletion,
  nodeDrainPhase,
  nodeDrainRequested,
  nodeDrainSnapshot,
  NODE_DRAIN_TOPIC,
  reconcileRecordedDrainRequest,
  registerNodeDrainActivityProbe,
  requestNodeDrain,
  resetNodeDrainStateForTests,
  startNodeDrainWatch,
} from "../../src/lib/node-drain";

const NODE_ID = "drain-test-node";
const REMOTE_NODE_ID = "drain-test-remote-node";
const originalHaEnabled = process.env["TERRENCE_HA_ENABLED"];
const originalDisableWorker = process.env["TERRENCE_DISABLE_WORKER"];
const originalNodeId = process.env["TERRENCE_NODE_ID"];

let activeRunExecutions = 0;
let activeAssessments = 0;
let activeDurableJobs = 0;

function primeActivity(runs: number, jobs: number, assessments = 0): void {
  activeRunExecutions = runs;
  activeAssessments = assessments;
  activeDurableJobs = jobs;
}

beforeEach(async (): Promise<void> => {
  process.env["TERRENCE_HA_ENABLED"] = "true";
  process.env["TERRENCE_DISABLE_WORKER"] = "false";
  process.env["TERRENCE_NODE_ID"] = NODE_ID;
  resetNodeDrainStateForTests();
  primeActivity(0, 0);
  registerNodeDrainActivityProbe(
    (): { activeRunExecutions: number; activeAssessments: number; activeDurableJobs: number } => ({
      activeRunExecutions,
      activeAssessments,
      activeDurableJobs,
    }),
  );
  await db.delete(controlPlaneNodes).where(eq(controlPlaneNodes.id, NODE_ID));
  await db.delete(controlPlaneNodes).where(eq(controlPlaneNodes.id, REMOTE_NODE_ID));
  await db.insert(controlPlaneNodes).values({
    id: NODE_ID,
    hostname: NODE_ID,
    instanceId: controlPlaneInstanceId,
    role: "follower",
    status: "active",
    protocolVersion: HA_PROTOCOL_VERSION,
    readinessChecks: [],
    registeredAt: Date.now(),
    lastHeartbeatAt: Date.now(),
  });
});

afterEach(async (): Promise<void> => {
  await stopControlPlaneCoordinator();
  resetNodeDrainStateForTests();
  await db.delete(controlPlaneNodes).where(eq(controlPlaneNodes.id, NODE_ID));
  await db.delete(controlPlaneNodes).where(eq(controlPlaneNodes.id, REMOTE_NODE_ID));
  if (originalHaEnabled === undefined) delete process.env["TERRENCE_HA_ENABLED"];
  else process.env["TERRENCE_HA_ENABLED"] = originalHaEnabled;
  if (originalDisableWorker === undefined) delete process.env["TERRENCE_DISABLE_WORKER"];
  else process.env["TERRENCE_DISABLE_WORKER"] = originalDisableWorker;
  if (originalNodeId === undefined) delete process.env["TERRENCE_NODE_ID"];
  else process.env["TERRENCE_NODE_ID"] = originalNodeId;
});

async function nodeRow(): Promise<typeof controlPlaneNodes.$inferSelect | undefined> {
  return db.query.controlPlaneNodes.findFirst({ where: eq(controlPlaneNodes.id, NODE_ID) });
}

async function beginRecordedDrain(
  options: Readonly<{ requestedBy?: string | null; reason?: string | null }> = {},
): Promise<ReturnType<typeof nodeDrainSnapshot>> {
  expect(await requestNodeDrain(NODE_ID, options)).toBe("requested");
  return nodeDrainSnapshot();
}

describe("node drain lifecycle", () => {
  test("an idle node reaches DRAINED immediately", async () => {
    const snapshot = await beginRecordedDrain({ requestedBy: "operator", reason: "rolling upgrade" });
    expect(snapshot.phase).toBe("drained");
    expect(snapshot.requestedBy).toBe("operator");
    expect(snapshot.reason).toBe("rolling upgrade");
    expect(snapshot.drainedAt).not.toBeNull();
  });

  test("a node with a live run execution stays DRAINING until the run finishes", async () => {
    primeActivity(1, 0);
    const draining = await beginRecordedDrain();
    expect(draining.phase).toBe("draining");
    expect(draining.activeRunExecutions).toBe(1);

    expect(await evaluateNodeDrainCompletion()).toBe("draining");

    primeActivity(0, 0);
    expect(await evaluateNodeDrainCompletion()).toBe("drained");
  });

  test("an in-flight durable job also holds the drain open", async () => {
    primeActivity(0, 2);
    expect((await beginRecordedDrain()).phase).toBe("draining");
    primeActivity(0, 1);
    expect(await evaluateNodeDrainCompletion()).toBe("draining");
    primeActivity(0, 0);
    expect(await evaluateNodeDrainCompletion()).toBe("drained");
  });

  test("an in-flight assessment keeps the node draining", async () => {
    primeActivity(0, 0, 1);
    const draining = await beginRecordedDrain();
    expect(draining.phase).toBe("draining");
    expect(draining.activeAssessments).toBe(1);

    primeActivity(0, 0, 0);
    expect(await evaluateNodeDrainCompletion()).toBe("drained");
  });

  test("a leader keeps its coordinator lease until an in-flight assessment finishes", async () => {
    await startControlPlaneCoordinator({
      onLeadershipAcquired: (): void => undefined,
      onLeadershipLost: (): void => undefined,
    });
    expect(isControlPlaneCoordinatorLeader()).toBe(true);

    primeActivity(0, 0, 1);
    expect((await beginRecordedDrain()).phase).toBe("draining");
    expect(isControlPlaneCoordinatorLeader()).toBe(true);
    expect(controlPlaneCoordinatorSuspended()).toBe(false);

    primeActivity(0, 0, 0);
    expect(await evaluateNodeDrainCompletion()).toBe("drained");
    expect(isControlPlaneCoordinatorLeader()).toBe(false);
    expect(controlPlaneCoordinatorSuspended()).toBe(true);
  });

  test("draining stops new work from the moment it is requested, not when it completes", async () => {
    primeActivity(1, 0);
    expect(nodeDrainRequested()).toBe(false);
    await beginLocalNodeDrain();
    expect(nodeDrainPhase()).toBe("draining");
    expect(nodeDrainRequested()).toBe(true);
  });

  test("beginning a drain twice keeps the original request metadata", async () => {
    primeActivity(1, 0);
    await beginLocalNodeDrain({ requestedBy: "first", reason: "original" });
    await beginLocalNodeDrain({ requestedBy: "second", reason: "duplicate" });
    const snapshot = nodeDrainSnapshot();
    expect(snapshot.requestedBy).toBe("first");
    expect(snapshot.reason).toBe("original");
  });

  test("canceling a drain returns the node to service", async () => {
    primeActivity(1, 0);
    await beginLocalNodeDrain();
    expect(nodeDrainRequested()).toBe(true);
    const snapshot = await cancelLocalNodeDrain();
    expect(snapshot.phase).toBe("active");
    expect(snapshot.requestedAt).toBeNull();
    expect(nodeDrainRequested()).toBe(false);
  });

  test("a drained node records its phase durably so an orchestrator can poll it", async () => {
    expect((await beginRecordedDrain({ requestedBy: "operator" })).phase).toBe("drained");
    const row = await nodeRow();
    expect(row?.status).toBe("drained");
    expect(row?.drainRequestedAt).not.toBeNull();
    expect(row?.drainRequestedBy).toBe("operator");
    expect(row?.drainedAt).not.toBeNull();
  });

  test("a canceled durable request cannot race the local phase into DRAINED", async () => {
    primeActivity(1, 0);
    expect((await beginRecordedDrain({ requestedBy: "operator" })).phase).toBe("draining");

    await db
      .update(controlPlaneNodes)
      .set({ status: "active", drainRequestedAt: null, drainRequestedBy: null, drainReason: null })
      .where(eq(controlPlaneNodes.id, NODE_ID));
    primeActivity(0, 0);

    expect(await evaluateNodeDrainCompletion()).toBe("draining");
    await reconcileRecordedDrainRequest();
    expect(nodeDrainPhase()).toBe("active");
  });
});

describe("recorded drain requests", () => {
  test("requestNodeDrain persists intent and drains the local node", async () => {
    primeActivity(1, 0);
    expect(await requestNodeDrain(NODE_ID, { requestedBy: "ops", reason: "node replacement" })).toBe("requested");
    const row = await nodeRow();
    expect(row?.status).toBe("maintenance");
    expect(row?.drainRequestedBy).toBe("ops");
    expect(row?.drainReason).toBe("node replacement");
    expect(nodeDrainPhase()).toBe("draining");
  });

  test("retrying a completed drain preserves the original request and drained marker", async () => {
    expect(await requestNodeDrain(NODE_ID, { requestedBy: "first", reason: "rolling replacement" })).toBe("requested");
    const first = await nodeRow();
    expect(first?.status).toBe("drained");
    expect(first?.drainedAt).not.toBeNull();

    expect(await requestNodeDrain(NODE_ID, { requestedBy: "second", reason: "retry" })).toBe("requested");
    const retried = await nodeRow();
    expect(retried?.status).toBe("drained");
    expect(retried?.drainRequestedAt).toBe(first?.drainRequestedAt);
    expect(retried?.drainRequestedBy).toBe("first");
    expect(retried?.drainReason).toBe("rolling replacement");
    expect(retried?.drainedAt).toBe(first?.drainedAt);
  });

  test("canceling drain does not clear unrelated maintenance state", async () => {
    await db.insert(controlPlaneNodes).values({
      id: REMOTE_NODE_ID,
      hostname: REMOTE_NODE_ID,
      instanceId: "remote-instance",
      role: "follower",
      status: "maintenance",
      protocolVersion: HA_PROTOCOL_VERSION,
      readinessChecks: [],
      registeredAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    });

    expect(await cancelNodeDrain(REMOTE_NODE_ID)).toBe(false);
    const row = await db.query.controlPlaneNodes.findFirst({ where: eq(controlPlaneNodes.id, REMOTE_NODE_ID) });
    expect(row?.status).toBe("maintenance");
    expect(row?.drainRequestedAt).toBeNull();
  });

  test("an unknown node id is rejected", async () => {
    expect(await requestNodeDrain("no-such-node")).toBe("not-found");
    expect(await cancelNodeDrain("no-such-node")).toBe(false);
  });

  test("a pre-HA3 node reports remote drain as unsupported", async () => {
    await db.insert(controlPlaneNodes).values({
      id: REMOTE_NODE_ID,
      hostname: REMOTE_NODE_ID,
      instanceId: "legacy-instance",
      role: "follower",
      status: "active",
      protocolVersion: null,
      readinessChecks: [],
      registeredAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    });

    expect(await requestNodeDrain(REMOTE_NODE_ID, { requestedBy: "ops" })).toBe("unsupported");
    const row = await db.query.controlPlaneNodes.findFirst({ where: eq(controlPlaneNodes.id, REMOTE_NODE_ID) });
    expect(row?.drainRequestedAt).toBeNull();
    expect(row?.status).toBe("active");
  });

  test("a request recorded while the node was not listening is adopted on reconcile", async () => {
    // Persisted intent recovers a missed control event.
    primeActivity(1, 0);
    await db
      .update(controlPlaneNodes)
      .set({
        status: "maintenance",
        drainRequestedAt: Date.now(),
        drainRequestedBy: "ops",
        drainReason: "missed notify",
      })
      .where(eq(controlPlaneNodes.id, NODE_ID));
    expect(nodeDrainPhase()).toBe("active");

    await reconcileRecordedDrainRequest();
    expect(nodeDrainPhase()).toBe("draining");
    expect(nodeDrainSnapshot().reason).toBe("missed notify");
  });

  test("clearing the recorded request uncordons the node on reconcile", async () => {
    primeActivity(1, 0);
    await requestNodeDrain(NODE_ID, { requestedBy: "ops" });
    expect(nodeDrainPhase()).toBe("draining");

    expect(await cancelNodeDrain(NODE_ID)).toBe(true);
    expect(nodeDrainPhase()).toBe("active");

    await reconcileRecordedDrainRequest();
    expect(nodeDrainPhase()).toBe("active");
    const row = await nodeRow();
    expect(row?.status).toBe("active");
    expect(row?.drainRequestedAt).toBeNull();
  });

  test("uncordoning a remote node does not refresh its heartbeat", async () => {
    await db.insert(controlPlaneNodes).values({
      id: REMOTE_NODE_ID,
      hostname: REMOTE_NODE_ID,
      instanceId: "remote-instance",
      role: "follower",
      status: "active",
      protocolVersion: HA_PROTOCOL_VERSION,
      readinessChecks: [],
      registeredAt: 1_000,
      lastHeartbeatAt: 1_234,
    });

    expect(await requestNodeDrain(REMOTE_NODE_ID, { requestedBy: "ops" })).toBe("requested");
    expect(await cancelNodeDrain(REMOTE_NODE_ID)).toBe(true);

    const row = await db.query.controlPlaneNodes.findFirst({ where: eq(controlPlaneNodes.id, REMOTE_NODE_ID) });
    expect(row?.lastHeartbeatAt).toBe(1_234);
  });

  test("losing the registered node incarnation fences an active local process", async () => {
    expect(nodeDrainPhase()).toBe("active");
    await db
      .update(controlPlaneNodes)
      .set({
        instanceId: "replacement-instance",
        status: "active",
        drainRequestedAt: null,
        drainRequestedBy: null,
        drainReason: null,
        drainedAt: null,
      })
      .where(eq(controlPlaneNodes.id, NODE_ID));

    await reconcileRecordedDrainRequest();

    expect(nodeDrainPhase()).toBe("draining");
    expect(nodeDrainRequested()).toBe(true);
    expect(controlPlaneCoordinatorSuspended()).toBe(true);

    // A delayed pre-replacement uncordon event still names this process's
    // instance ID. Identity loss is a permanent local fence, so it must not
    // revive the displaced process.
    startNodeDrainWatch();
    publish(NODE_DRAIN_TOPIC, { nodeId: NODE_ID, instanceId: controlPlaneInstanceId, drain: false });
    await Bun.sleep(0);
    expect(nodeDrainPhase()).toBe("draining");
    expect(controlPlaneCoordinatorSuspended()).toBe(true);
  });

  test("a displaced drained process stays fenced when its node id is reused", async () => {
    primeActivity(0, 0);
    await db
      .update(controlPlaneNodes)
      .set({ drainRequestedAt: Date.now(), drainRequestedBy: "ops", drainReason: "replace", status: "maintenance" })
      .where(eq(controlPlaneNodes.id, NODE_ID));
    await reconcileRecordedDrainRequest();
    expect(nodeDrainPhase()).toBe("drained");
    expect(nodeDrainRequested()).toBe(true);

    // A replacement process takes the same durable node ID and starts active.
    await db
      .update(controlPlaneNodes)
      .set({
        instanceId: "replacement-instance",
        status: "active",
        drainRequestedAt: null,
        drainRequestedBy: null,
        drainReason: null,
        drainedAt: null,
      })
      .where(eq(controlPlaneNodes.id, NODE_ID));

    await reconcileRecordedDrainRequest();
    expect(nodeDrainPhase()).toBe("drained");
    expect(nodeDrainRequested()).toBe(true);
    expect(controlPlaneCoordinatorSuspended()).toBe(true);
  });

  test("a live planned-drain node id cannot be replaced until the node is DRAINED", async () => {
    await db
      .update(controlPlaneNodes)
      .set({
        instanceId: "old-instance",
        status: "maintenance",
        lastHeartbeatAt: Date.now(),
        drainRequestedAt: Date.now(),
      })
      .where(eq(controlPlaneNodes.id, NODE_ID));

    let drainingError: unknown;
    try {
      await claimControlPlaneNodeIdentity();
    } catch (error: unknown) {
      drainingError = error;
    }
    expect(drainingError).toBeInstanceOf(Error);
    expect(String(drainingError)).toContain("already registered");

    await db
      .update(controlPlaneNodes)
      .set({ status: "drained", drainedAt: Date.now() })
      .where(eq(controlPlaneNodes.id, NODE_ID));
    await claimControlPlaneNodeIdentity();

    const row = await nodeRow();
    expect(row?.instanceId).toBe(controlPlaneInstanceId);
    expect(row?.status).toBe("active");
    expect(row?.drainRequestedAt).toBeNull();
  });
});
