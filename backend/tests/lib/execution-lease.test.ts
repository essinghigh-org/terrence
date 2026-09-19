import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { isPostgres } from "../../src/db/driver";
import { organizations, runs, stateVersions, workspaces } from "../../src/db/schema";
import {
  StaleRunExecutionLeaseError,
  assertRunExecutionFenceTx,
  claimRunExecutionLease,
  releaseRunExecutionLease,
  renewRunExecutionLease,
} from "../../src/lib/execution-lease";
import { insertStateVersionWithSerialRetry } from "../../src/lib/state-serial";

const suffix = crypto.randomUUID();
const orgId = `execution-lease-org-${suffix}`;
const workspaceId = `execution-lease-ws-${suffix}`;
const runA = `execution-lease-run-a-${suffix}`;
const runB = `execution-lease-run-b-${suffix}`;
const identityA = { nodeId: "node-a", instanceId: "instance-a" };
const identityB = { nodeId: "node-b", instanceId: "instance-b" };
const postgresTest = isPostgres ? test : test.skip;

beforeEach(async (): Promise<void> => {
  await db.insert(organizations).values({ id: orgId, name: orgId });
  await db.insert(workspaces).values({ id: workspaceId, orgId, name: workspaceId });
  await db.insert(runs).values([
    { id: runA, workspaceId, status: "planning", createdAt: Date.now() },
    { id: runB, workspaceId, status: "planning", createdAt: Date.now() + 1 },
  ]);
});

afterEach(async (): Promise<void> => {
  await db.delete(stateVersions).where(eq(stateVersions.workspaceId, workspaceId));
  await db.delete(runs).where(eq(runs.workspaceId, workspaceId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
});

describe("run execution leases", () => {
  test("serializes a workspace, renews ownership, and monotonically fences takeover", async () => {
    const first = await claimRunExecutionLease(runA, "plan", identityA, 1_000, 100);
    expect(first).toMatchObject({
      runId: runA,
      workspaceId,
      ownerNodeId: "node-a",
      ownerInstanceId: "instance-a",
      fencingToken: 1,
      heartbeatAt: 1_000,
      expiresAt: 1_100,
    });
    if (first === null) throw new Error("expected initial execution lease");

    // Re-entrancy belongs to the live async execution context. A separate
    // top-level invocation from the same process is still a duplicate.
    expect(await claimRunExecutionLease(runA, "plan", identityA, 1_040, 100)).toBeNull();

    // A different run cannot execute the same workspace while the lease is live.
    expect(await claimRunExecutionLease(runB, "plan", identityB, 1_050, 100)).toBeNull();
    const blockedRun = await db.query.runs.findFirst({ where: eq(runs.id, runB) });
    expect(blockedRun).toMatchObject({
      executionOwnerNodeId: null,
      executionOwnerInstanceId: null,
      executionFencingToken: 0,
    });

    const renewed = await renewRunExecutionLease(first, 1_060, 100);
    expect(renewed).toMatchObject({ fencingToken: 1, heartbeatAt: 1_060, expiresAt: 1_160 });
    if (renewed === null) throw new Error("expected renewed execution lease");

    const takeover = await claimRunExecutionLease(runA, "apply", identityB, 1_161, 100);
    expect(takeover).toMatchObject({
      ownerNodeId: "node-b",
      ownerInstanceId: "instance-b",
      fencingToken: 2,
      phase: "apply",
      heartbeatAt: 1_161,
      expiresAt: 1_261,
    });
    if (takeover === null) throw new Error("expected execution lease takeover");

    expect(await renewRunExecutionLease(renewed, 1_162, 100)).toBeNull();
    expect(await releaseRunExecutionLease(renewed)).toBe(false);

    expect(await releaseRunExecutionLease(takeover)).toBe(true);
    const reacquired = await claimRunExecutionLease(runA, "plan", identityA, 1_170, 100);
    expect(reacquired).toMatchObject({ fencingToken: 3, ownerNodeId: "node-a" });
  });

  test("allows exactly one concurrent workspace owner", async () => {
    const claims = await Promise.all([
      claimRunExecutionLease(runA, "plan", identityA, 5_000, 500),
      claimRunExecutionLease(runB, "plan", identityB, 5_000, 500),
    ]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);

    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const winner = claims.find((claim) => claim !== null);
    expect(winner).not.toBeNull();
    expect(workspace?.executionRunId).toBe(winner?.runId);
    expect(workspace?.executionFencingToken).toBe(winner?.fencingToken);
  });

  test("rejects stale state publication in the same transaction as serial allocation", async () => {
    const now = Date.now();
    const first = await claimRunExecutionLease(runA, "apply", identityA, now, 60_000);
    if (first === null) throw new Error("expected initial execution lease");

    const serial = await insertStateVersionWithSerialRetry(
      {
        id: `state-current-${suffix}`,
        workspaceId,
        runId: runA,
        statePayload: null,
        jsonState: null,
        jsonStateOutputs: null,
        status: "finalized",
        createdAt: now,
      },
      first,
    );
    expect(serial).toBeGreaterThan(0);

    expect(await releaseRunExecutionLease(first)).toBe(true);
    const replacement = await claimRunExecutionLease(runA, "apply", identityB, now + 1, 60_000);
    expect(replacement?.fencingToken).toBe(2);

    let stalePublicationError: unknown;
    try {
      await insertStateVersionWithSerialRetry(
        {
          id: `state-stale-${suffix}`,
          workspaceId,
          runId: runA,
          statePayload: null,
          jsonState: null,
          jsonStateOutputs: null,
          status: "finalized",
          createdAt: now + 2,
        },
        first,
      );
    } catch (error: unknown) {
      stalePublicationError = error;
    }
    expect(stalePublicationError).toBeInstanceOf(StaleRunExecutionLeaseError);

    expect(await db.query.stateVersions.findMany({ where: eq(stateVersions.workspaceId, workspaceId) })).toHaveLength(
      1,
    );
  });

  postgresTest("blocks takeover behind an authoritative execution fence transaction", async () => {
    const now = Date.now();
    const first = await claimRunExecutionLease(runA, "apply", identityA, now, 60_000);
    if (first === null) throw new Error("expected initial execution lease");

    let releaseFence!: () => void;
    const holdFence = new Promise<void>((resolve): void => {
      releaseFence = resolve;
    });
    let fenceLocked!: () => void;
    const fenceReady = new Promise<void>((resolve): void => {
      fenceLocked = resolve;
    });

    const fencedCommit = db.transaction(async (transaction): Promise<void> => {
      await assertRunExecutionFenceTx(transaction, first);
      fenceLocked();
      await holdFence;
    });
    await fenceReady;

    let takeoverSettled = false;
    const takeoverPromise = claimRunExecutionLease(runA, "apply", identityB, first.expiresAt + 1, 60_000).then(
      (lease) => {
        takeoverSettled = true;
        return lease;
      },
    );

    await Bun.sleep(75);
    expect(takeoverSettled).toBe(false);

    releaseFence();
    await fencedCommit;
    const takeover = await takeoverPromise;
    expect(takeover).toMatchObject({
      ownerNodeId: "node-b",
      ownerInstanceId: "instance-b",
      fencingToken: 2,
    });
  });
});
