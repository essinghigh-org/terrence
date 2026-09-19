/**
 * HA-3C: the acquisition gate that makes drain safe.
 *
 * A draining node must finish what it already owns and take nothing new. The
 * gate lives in withRunExecutionLease because that is the single entry point
 * every local execution path goes through, and it sits deliberately downstream
 * of the re-entrancy check so an in-flight plan can still proceed into its
 * apply.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { organizations, runs, workspaces } from "../../src/db/schema";
import {
  RunExecutionLeaseUnavailableError,
  releaseRunExecutionLease,
  withRunExecutionLease,
} from "../../src/lib/execution-lease";
import {
  beginLocalNodeDrain,
  cancelLocalNodeDrain,
  registerNodeDrainActivityProbe,
  resetNodeDrainStateForTests,
} from "../../src/lib/node-drain";

const suffix = crypto.randomUUID();
const orgId = `drain-gate-org-${suffix}`;
const workspaceId = `drain-gate-ws-${suffix}`;
const runA = `drain-gate-run-a-${suffix}`;
const runB = `drain-gate-run-b-${suffix}`;

const originalHaEnabled = process.env["TERRENCE_HA_ENABLED"];
const originalNodeId = process.env["TERRENCE_NODE_ID"];

let activeRunExecutions = 0;

const noLeaseLoss = { onLeaseLost: (): void => undefined };

/**
 * Assert the drain gate refused a claim. Written as an explicit catch rather
 * than an inline rejection matcher so the body can also prove the work callback
 * never ran.
 */
async function expectLeaseRefused(runId: string): Promise<void> {
  let caught: unknown;
  let executed = false;
  try {
    await withRunExecutionLease(runId, "plan", noLeaseLoss, async (): Promise<void> => {
      executed = true;
    });
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RunExecutionLeaseUnavailableError);
  expect(executed).toBe(false);
}

beforeEach(async (): Promise<void> => {
  process.env["TERRENCE_HA_ENABLED"] = "true";
  process.env["TERRENCE_NODE_ID"] = "drain-gate-node";
  resetNodeDrainStateForTests();
  activeRunExecutions = 0;
  registerNodeDrainActivityProbe((): { activeRunExecutions: number; activeDurableJobs: number } => ({
    activeRunExecutions,
    activeDurableJobs: 0,
  }));
  await db.insert(organizations).values({ id: orgId, name: orgId });
  await db.insert(workspaces).values({ id: workspaceId, orgId, name: workspaceId });
  await db.insert(runs).values([
    { id: runA, workspaceId, status: "planning", createdAt: Date.now() },
    { id: runB, workspaceId, status: "planning", createdAt: Date.now() + 1 },
  ]);
});

afterEach(async (): Promise<void> => {
  resetNodeDrainStateForTests();
  await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  if (originalHaEnabled === undefined) delete process.env["TERRENCE_HA_ENABLED"];
  else process.env["TERRENCE_HA_ENABLED"] = originalHaEnabled;
  if (originalNodeId === undefined) delete process.env["TERRENCE_NODE_ID"];
  else process.env["TERRENCE_NODE_ID"] = originalNodeId;
});

describe("draining node execution-lease gate", () => {
  test("a draining node claims no new execution lease", async () => {
    activeRunExecutions = 1;
    await beginLocalNodeDrain({ reason: "rolling upgrade" });

    await expectLeaseRefused(runB);

    // Refused, not errored: the run keeps no owner, so another replica can
    // claim it. Surfacing ordinary contention is what makes that true.
    const row = await db.query.runs.findFirst({ where: eq(runs.id, runB) });
    expect(row).toMatchObject({
      executionOwnerNodeId: null,
      executionOwnerInstanceId: null,
      executionFencingToken: 0,
    });
  });

  test("an execution already owned when the drain begins runs to completion", async () => {
    // The property the whole phase exists to protect: drain must not kill a
    // healthy Terraform execution.
    let observedInsideDrain = false;
    const result = await withRunExecutionLease(runA, "plan", noLeaseLoss, async (): Promise<string> => {
      activeRunExecutions = 1;
      await beginLocalNodeDrain({ reason: "drain during active plan" });
      observedInsideDrain = true;
      return "completed";
    });
    expect(result).toBe("completed");
    expect(observedInsideDrain).toBe(true);
  });

  test("an in-flight plan can still proceed into its apply while draining", async () => {
    // The gate is downstream of the re-entrancy check on purpose: automatic
    // plan-to-apply reuses the live lease generation rather than acquiring a
    // new one, so a drain must not strand a run half-way through.
    const phases: string[] = [];
    await withRunExecutionLease(runA, "plan", noLeaseLoss, async (): Promise<void> => {
      phases.push("plan");
      activeRunExecutions = 1;
      await beginLocalNodeDrain();
      await withRunExecutionLease(runA, "apply", noLeaseLoss, async (): Promise<void> => {
        phases.push("apply");
      });
    });
    expect(phases).toEqual(["plan", "apply"]);
  });

  test("canceling the drain lets the node claim work again", async () => {
    activeRunExecutions = 1;
    await beginLocalNodeDrain();
    await expectLeaseRefused(runB);

    await cancelLocalNodeDrain();
    const claimed = await withRunExecutionLease(runB, "plan", noLeaseLoss, async (): Promise<string> => "claimed");
    expect(claimed).toBe("claimed");
  });

  test("the drain gate releases nothing it did not acquire", async () => {
    // A refused claim must leave an existing owner untouched rather than
    // running the release path on someone else's lease.
    const lease = await withRunExecutionLease(
      runA,
      "plan",
      noLeaseLoss,
      async (): Promise<{ fencingToken: number }> => ({ fencingToken: 1 }),
    );
    expect(lease.fencingToken).toBe(1);

    activeRunExecutions = 0;
    await beginLocalNodeDrain();
    await expectLeaseRefused(runA);
    // The finally-release of the first lease already cleared ownership; the
    // refused claim must not have advanced the fencing token.
    const row = await db.query.runs.findFirst({ where: eq(runs.id, runA) });
    expect(row?.executionFencingToken).toBe(1);
    expect(row?.executionOwnerNodeId).toBeNull();
  });
});

describe("drain gate outside HA", () => {
  test("a single-node install is unaffected by drain state", async () => {
    delete process.env["TERRENCE_HA_ENABLED"];
    await beginLocalNodeDrain();
    // Without HA there is no second replica to hand work to, so refusing the
    // claim would simply stop the install from working.
    const result = await withRunExecutionLease(runA, "plan", noLeaseLoss, async (): Promise<string> => "ran");
    expect(result).toBe("ran");
    await releaseRunExecutionLease({
      runId: runA,
      workspaceId,
      phase: "plan",
      ownerNodeId: "drain-gate-node",
      ownerInstanceId: "unused",
      fencingToken: 0,
      heartbeatAt: 0,
      expiresAt: 0,
    }).catch((): void => undefined);
  });
});
