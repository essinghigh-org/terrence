import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { controlPlaneNodes } from "../../src/db/schema";
import { controlPlaneInstanceId } from "../../src/lib/ha-config";
import {
  beginLocalNodeDrain,
  cancelLocalNodeDrain,
  cancelNodeDrain,
  evaluateNodeDrainCompletion,
  nodeDrainPhase,
  nodeDrainRequested,
  nodeDrainSnapshot,
  reconcileRecordedDrainRequest,
  registerNodeDrainActivityProbe,
  requestNodeDrain,
  resetNodeDrainStateForTests,
} from "../../src/lib/node-drain";

const NODE_ID = "drain-test-node";
const originalHaEnabled = process.env["TERRENCE_HA_ENABLED"];
const originalNodeId = process.env["TERRENCE_NODE_ID"];

let activeRunExecutions = 0;
let activeDurableJobs = 0;

function primeActivity(runs: number, jobs: number): void {
  activeRunExecutions = runs;
  activeDurableJobs = jobs;
}

beforeEach(async (): Promise<void> => {
  process.env["TERRENCE_HA_ENABLED"] = "true";
  process.env["TERRENCE_NODE_ID"] = NODE_ID;
  resetNodeDrainStateForTests();
  primeActivity(0, 0);
  registerNodeDrainActivityProbe((): { activeRunExecutions: number; activeDurableJobs: number } => ({
    activeRunExecutions,
    activeDurableJobs,
  }));
  await db.delete(controlPlaneNodes).where(eq(controlPlaneNodes.id, NODE_ID));
  await db.insert(controlPlaneNodes).values({
    id: NODE_ID,
    hostname: NODE_ID,
    instanceId: controlPlaneInstanceId,
    role: "follower",
    status: "active",
    readinessChecks: [],
    registeredAt: Date.now(),
    lastHeartbeatAt: Date.now(),
  });
});

afterEach(async (): Promise<void> => {
  resetNodeDrainStateForTests();
  await db.delete(controlPlaneNodes).where(eq(controlPlaneNodes.id, NODE_ID));
  if (originalHaEnabled === undefined) delete process.env["TERRENCE_HA_ENABLED"];
  else process.env["TERRENCE_HA_ENABLED"] = originalHaEnabled;
  if (originalNodeId === undefined) delete process.env["TERRENCE_NODE_ID"];
  else process.env["TERRENCE_NODE_ID"] = originalNodeId;
});

async function nodeRow(): Promise<typeof controlPlaneNodes.$inferSelect | undefined> {
  return db.query.controlPlaneNodes.findFirst({ where: eq(controlPlaneNodes.id, NODE_ID) });
}

describe("node drain lifecycle", () => {
  test("an idle node reaches DRAINED immediately", async () => {
    const snapshot = await beginLocalNodeDrain({ requestedBy: "operator", reason: "rolling upgrade" });
    expect(snapshot.phase).toBe("drained");
    expect(snapshot.requestedBy).toBe("operator");
    expect(snapshot.reason).toBe("rolling upgrade");
    expect(snapshot.drainedAt).not.toBeNull();
  });

  test("a node with a live run execution stays DRAINING until the run finishes", async () => {
    // The whole point of the phase: drain must not kill a healthy Terraform
    // execution. Phase 2 gave the run independent fenced ownership, so the
    // drain only has to wait for it.
    primeActivity(1, 0);
    const draining = await beginLocalNodeDrain();
    expect(draining.phase).toBe("draining");
    expect(draining.activeRunExecutions).toBe(1);

    expect(await evaluateNodeDrainCompletion()).toBe("draining");

    primeActivity(0, 0);
    expect(await evaluateNodeDrainCompletion()).toBe("drained");
  });

  test("an in-flight durable job also holds the drain open", async () => {
    primeActivity(0, 2);
    expect((await beginLocalNodeDrain()).phase).toBe("draining");
    primeActivity(0, 1);
    expect(await evaluateNodeDrainCompletion()).toBe("draining");
    primeActivity(0, 0);
    expect(await evaluateNodeDrainCompletion()).toBe("drained");
  });

  test("draining stops new work from the moment it is requested, not when it completes", async () => {
    // A node that waited until DRAINED to stop claiming would keep taking on
    // work it then has to wait for, and might never converge.
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
    await beginLocalNodeDrain({ requestedBy: "operator" });
    // The durable drained marker is written under the same request that set
    // drain_requested_at, so a cancelation racing completion cannot leave the
    // row claiming DRAINED.
    await requestNodeDrain(NODE_ID, { requestedBy: "operator" });
    await evaluateNodeDrainCompletion();
    const row = await nodeRow();
    expect(row?.drainRequestedAt).not.toBeNull();
    expect(row?.drainRequestedBy).toBe("operator");
  });
});

describe("recorded drain requests", () => {
  test("requestNodeDrain persists intent and drains the local node", async () => {
    primeActivity(1, 0);
    expect(await requestNodeDrain(NODE_ID, { requestedBy: "ops", reason: "node replacement" })).toBe(true);
    const row = await nodeRow();
    expect(row?.status).toBe("draining");
    expect(row?.drainRequestedBy).toBe("ops");
    expect(row?.drainReason).toBe("node replacement");
    expect(nodeDrainPhase()).toBe("draining");
  });

  test("an unknown node id is reported rather than silently accepted", async () => {
    expect(await requestNodeDrain("no-such-node")).toBe(false);
    expect(await cancelNodeDrain("no-such-node")).toBe(false);
  });

  test("a request recorded while the node was not listening is adopted on reconcile", async () => {
    // Durable intent is what makes a missed NOTIFY survivable: the control
    // event is only an accelerator.
    primeActivity(1, 0);
    await db
      .update(controlPlaneNodes)
      .set({ status: "draining", drainRequestedAt: Date.now(), drainRequestedBy: "ops", drainReason: "missed notify" })
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
});
