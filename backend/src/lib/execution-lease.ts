import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, gt, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { databaseCurrentTimeMs, db } from "../db";
import { isPostgres } from "../db/driver";
import { runs, workspaces } from "../db/schema";
import { controlPlaneInstanceId, controlPlaneNodeId, haEnabled } from "./ha-config";
import { log } from "./log";
import { nodeDrainRequested } from "./node-drain";

export const RUN_EXECUTION_LEASE_TTL_MS = 30_000;
export const RUN_EXECUTION_LEASE_RENEW_MS = 5_000;

export type RunExecutionPhase = "plan" | "apply";

export type RunExecutionLeaseIdentity = Readonly<{
  nodeId: string;
  instanceId: string;
}>;

export type RunExecutionLease = Readonly<{
  runId: string;
  workspaceId: string;
  phase: RunExecutionPhase;
  ownerNodeId: string;
  ownerInstanceId: string;
  fencingToken: number;
  heartbeatAt: number;
  expiresAt: number;
}>;

type RunLeaseHooks = Readonly<{
  onLeaseLost: (lease: RunExecutionLease, reason: string) => void | Promise<void>;
}>;

const localIdentity = (): RunExecutionLeaseIdentity => ({
  nodeId: controlPlaneNodeId(),
  instanceId: controlPlaneInstanceId,
});

type RunExecutionLeaseContext = {
  lease: RunExecutionLease;
  valid: boolean;
  validUntil: number;
};

const leaseContext = new AsyncLocalStorage<RunExecutionLeaseContext>();

export class RunExecutionLeaseUnavailableError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} does not currently have an available execution lease`);
    this.name = "RunExecutionLeaseUnavailableError";
  }
}

export class StaleRunExecutionLeaseError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} execution lease is no longer current`);
    this.name = "StaleRunExecutionLeaseError";
  }
}

function databaseNowExpression(): SQL {
  return isPostgres
    ? sql`CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)`
    : sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;
}

export function currentRunExecutionLease(runId?: string): RunExecutionLease | undefined {
  const context = leaseContext.getStore();
  if (context === undefined || (runId !== undefined && context.lease.runId !== runId)) return undefined;
  if (!context.valid || performance.now() >= context.validUntil) {
    context.valid = false;
    throw new StaleRunExecutionLeaseError(context.lease.runId);
  }
  return context.lease;
}

/** Fail locally before starting another external process after lease loss. */
export function assertLocalRunExecutionLease(runId: string): void {
  if (!haEnabled()) return;
  const context = leaseContext.getStore();
  if (
    context === undefined ||
    context.lease.runId !== runId ||
    !context.valid ||
    performance.now() >= context.validUntil
  ) {
    if (context !== undefined && context.lease.runId === runId) context.valid = false;
    throw new StaleRunExecutionLeaseError(runId);
  }
}

/** Shared run evidence written outside a local execution context (for example
 * agent/API delivery) is unaffected. A stale local async continuation is
 * silently denied so it cannot append log evidence after its execution lease
 * has been fenced or released. */
export function localRunExecutionEvidenceAllowed(runId: string): boolean {
  if (!haEnabled()) return true;
  const context = leaseContext.getStore();
  if (context === undefined || context.lease.runId !== runId) return true;
  if (!context.valid || performance.now() >= context.validUntil) {
    context.valid = false;
    return false;
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle SQL is a mutable builder object used only as an opaque condition token.
export function runExecutionFenceCondition(runId: string, base: SQL | undefined): SQL {
  if (base === undefined) throw new Error("Execution fence requires a base run condition");
  const lease = currentRunExecutionLease(runId);
  if (!haEnabled() || lease === undefined) return base;
  const condition = and(
    base,
    eq(runs.executionOwnerNodeId, lease.ownerNodeId),
    eq(runs.executionOwnerInstanceId, lease.ownerInstanceId),
    eq(runs.executionFencingToken, lease.fencingToken),
    gt(runs.executionLeaseExpiresAt, databaseNowExpression()),
  );
  if (condition === undefined) throw new Error("Execution fence condition unexpectedly resolved empty");
  return condition;
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle SQL is a mutable builder object used only as an opaque condition token.
export function workspaceExecutionFenceCondition(runId: string, base: SQL | undefined): SQL {
  if (base === undefined) throw new Error("Execution fence requires a base workspace condition");
  const lease = currentRunExecutionLease(runId);
  if (!haEnabled() || lease === undefined) return base;
  const condition = and(
    base,
    eq(workspaces.executionRunId, lease.runId),
    eq(workspaces.executionOwnerNodeId, lease.ownerNodeId),
    eq(workspaces.executionOwnerInstanceId, lease.ownerInstanceId),
    eq(workspaces.executionFencingToken, lease.fencingToken),
    gt(workspaces.executionLeaseExpiresAt, databaseNowExpression()),
  );
  if (condition === undefined) throw new Error("Workspace execution fence condition unexpectedly resolved empty");
  return condition;
}

function exactRunLeaseCondition(lease: RunExecutionLease): SQL {
  const condition = and(
    eq(runs.id, lease.runId),
    eq(runs.executionOwnerNodeId, lease.ownerNodeId),
    eq(runs.executionOwnerInstanceId, lease.ownerInstanceId),
    eq(runs.executionFencingToken, lease.fencingToken),
    gt(runs.executionLeaseExpiresAt, databaseNowExpression()),
  );
  if (condition === undefined) throw new Error("Exact run execution lease condition unexpectedly resolved empty");
  return condition;
}

function exactWorkspaceLeaseCondition(lease: RunExecutionLease): SQL {
  const condition = and(
    eq(workspaces.id, lease.workspaceId),
    eq(workspaces.executionRunId, lease.runId),
    eq(workspaces.executionOwnerNodeId, lease.ownerNodeId),
    eq(workspaces.executionOwnerInstanceId, lease.ownerInstanceId),
    eq(workspaces.executionFencingToken, lease.fencingToken),
    gt(workspaces.executionLeaseExpiresAt, databaseNowExpression()),
  );
  if (condition === undefined) throw new Error("Exact workspace execution lease condition unexpectedly resolved empty");
  return condition;
}

export async function assertRunExecutionFenceTx(transaction: unknown, lease: RunExecutionLease): Promise<void> {
  const tx = transaction as typeof db;
  // These are deliberately conditional no-op writes rather than SELECTs. On
  // PostgreSQL they lock the ownership rows until the surrounding transaction
  // commits, so a takeover cannot race between fence validation and the
  // authoritative state/artifact database commit that follows.
  const run = await tx
    .update(runs)
    .set({ executionFencingToken: lease.fencingToken })
    .where(exactRunLeaseCondition(lease))
    .returning({ id: runs.id });
  if (run.length === 0) throw new StaleRunExecutionLeaseError(lease.runId);

  const workspace = await tx
    .update(workspaces)
    .set({ executionFencingToken: lease.fencingToken })
    .where(exactWorkspaceLeaseCondition(lease))
    .returning({ id: workspaces.id });
  if (workspace.length === 0) throw new StaleRunExecutionLeaseError(lease.runId);
}

/** Hold the current execution ownership rows locked while publishing a shared
 * filesystem artifact. The caller should prepare temporary bytes first and do
 * only the final atomic rename(s) inside work. */
export async function withCurrentRunExecutionFence<T>(runId: string, work: () => Promise<T>): Promise<T> {
  if (!haEnabled()) return work();
  const lease = currentRunExecutionLease(runId);
  if (lease === undefined) throw new StaleRunExecutionLeaseError(runId);
  return db.transaction(async (transaction): Promise<T> => {
    await assertRunExecutionFenceTx(transaction, lease);
    return work();
  });
}

export async function claimRunExecutionLease(
  runId: string,
  phase: RunExecutionPhase,
  identity: RunExecutionLeaseIdentity = localIdentity(),
  now?: number,
  ttlMs = RUN_EXECUTION_LEASE_TTL_MS,
): Promise<RunExecutionLease | null> {
  const currentNow = now ?? (await databaseCurrentTimeMs());
  const expiresAt = currentNow + ttlMs;

  return db
    .transaction(async (transaction): Promise<RunExecutionLease | null> => {
      const tx = transaction as unknown as typeof db;
      const run = await tx.query.runs.findFirst({
        where: eq(runs.id, runId),
        columns: {
          workspaceId: true,
          executionOwnerNodeId: true,
          executionOwnerInstanceId: true,
          executionFencingToken: true,
          executionLeaseExpiresAt: true,
        },
      });
      if (run === undefined) return null;

      const unowned = run.executionOwnerNodeId === null && run.executionOwnerInstanceId === null;
      const expired = run.executionLeaseExpiresAt !== null && run.executionLeaseExpiresAt <= currentNow;
      // Re-entrancy is allowed only through the in-process AsyncLocalStorage
      // context in withRunExecutionLease(). A second top-level invocation from
      // the same process is still a duplicate contender and must not share the
      // current fencing token. Partial owner metadata is treated as corrupt and
      // fails closed rather than constructing a NULL equality predicate.
      let priorOwnerCondition: SQL | undefined;
      if (unowned) {
        priorOwnerCondition = and(isNull(runs.executionOwnerNodeId), isNull(runs.executionOwnerInstanceId));
      } else {
        const previousNodeId = run.executionOwnerNodeId;
        const previousInstanceId = run.executionOwnerInstanceId;
        if (previousNodeId === null || previousInstanceId === null || !expired) return null;
        priorOwnerCondition = and(
          eq(runs.executionOwnerNodeId, previousNodeId),
          eq(runs.executionOwnerInstanceId, previousInstanceId),
          lte(runs.executionLeaseExpiresAt, currentNow),
        );
      }
      if (priorOwnerCondition === undefined) throw new Error("Execution lease prior-owner condition resolved empty");

      const currentToken = run.executionFencingToken;
      const fencingToken = currentToken + 1;
      const claimCondition = and(eq(runs.id, runId), eq(runs.executionFencingToken, currentToken), priorOwnerCondition);
      if (claimCondition === undefined) throw new Error("Execution lease claim condition resolved empty");

      const claimedRun = await tx
        .update(runs)
        .set({
          executionOwnerNodeId: identity.nodeId,
          executionOwnerInstanceId: identity.instanceId,
          executionFencingToken: fencingToken,
          executionLeaseExpiresAt: expiresAt,
          executionLeaseHeartbeatAt: currentNow,
          executionPhase: phase,
        })
        .where(claimCondition)
        .returning({ id: runs.id });
      if (claimedRun.length === 0) return null;

      const claimedWorkspace = await tx
        .update(workspaces)
        .set({
          executionRunId: runId,
          executionOwnerNodeId: identity.nodeId,
          executionOwnerInstanceId: identity.instanceId,
          executionFencingToken: fencingToken,
          executionLeaseExpiresAt: expiresAt,
          executionLeaseHeartbeatAt: currentNow,
        })
        .where(
          and(
            eq(workspaces.id, run.workspaceId),
            or(
              isNull(workspaces.executionRunId),
              and(
                eq(workspaces.executionRunId, runId),
                eq(workspaces.executionOwnerNodeId, identity.nodeId),
                eq(workspaces.executionOwnerInstanceId, identity.instanceId),
                eq(workspaces.executionFencingToken, fencingToken),
              ),
              lte(workspaces.executionLeaseExpiresAt, currentNow),
            ),
          ),
        )
        .returning({ id: workspaces.id });
      if (claimedWorkspace.length === 0) throw new RunExecutionLeaseUnavailableError(runId);

      return {
        runId,
        workspaceId: run.workspaceId,
        phase,
        ownerNodeId: identity.nodeId,
        ownerInstanceId: identity.instanceId,
        fencingToken,
        heartbeatAt: currentNow,
        expiresAt,
      };
    })
    .catch((error: unknown): RunExecutionLease | null => {
      if (error instanceof RunExecutionLeaseUnavailableError) return null;
      throw error;
    });
}

export async function renewRunExecutionLease(
  lease: RunExecutionLease,
  now?: number,
  ttlMs = RUN_EXECUTION_LEASE_TTL_MS,
): Promise<RunExecutionLease | null> {
  const currentNow = now ?? (await databaseCurrentTimeMs());
  const expiresAt = currentNow + ttlMs;

  return db
    .transaction(async (transaction): Promise<RunExecutionLease | null> => {
      const tx = transaction as unknown as typeof db;
      const renewedRun = await tx
        .update(runs)
        .set({
          executionLeaseExpiresAt: expiresAt,
          executionLeaseHeartbeatAt: currentNow,
        })
        .where(
          and(
            eq(runs.id, lease.runId),
            eq(runs.executionOwnerNodeId, lease.ownerNodeId),
            eq(runs.executionOwnerInstanceId, lease.ownerInstanceId),
            eq(runs.executionFencingToken, lease.fencingToken),
            gt(runs.executionLeaseExpiresAt, currentNow),
          ),
        )
        .returning({ id: runs.id });
      if (renewedRun.length === 0) return null;

      const renewedWorkspace = await tx
        .update(workspaces)
        .set({
          executionLeaseExpiresAt: expiresAt,
          executionLeaseHeartbeatAt: currentNow,
        })
        .where(
          and(
            eq(workspaces.id, lease.workspaceId),
            eq(workspaces.executionRunId, lease.runId),
            eq(workspaces.executionOwnerNodeId, lease.ownerNodeId),
            eq(workspaces.executionOwnerInstanceId, lease.ownerInstanceId),
            eq(workspaces.executionFencingToken, lease.fencingToken),
            gt(workspaces.executionLeaseExpiresAt, currentNow),
          ),
        )
        .returning({ id: workspaces.id });
      if (renewedWorkspace.length === 0) throw new StaleRunExecutionLeaseError(lease.runId);

      return { ...lease, heartbeatAt: currentNow, expiresAt };
    })
    .catch((error: unknown): RunExecutionLease | null => {
      if (error instanceof StaleRunExecutionLeaseError) return null;
      throw error;
    });
}

export async function updateRunExecutionLeasePhase(
  lease: RunExecutionLease,
  phase: RunExecutionPhase,
): Promise<RunExecutionLease> {
  if (lease.phase === phase) return lease;
  const updated = await db
    .update(runs)
    .set({ executionPhase: phase })
    .where(exactRunLeaseCondition(lease))
    .returning({ id: runs.id });
  if (updated.length === 0) throw new StaleRunExecutionLeaseError(lease.runId);
  return { ...lease, phase };
}

/** Clear an explicitly expired local execution owner without changing its
 * fencing token. This is recovery/garbage collection only: the compare-and-set
 * includes the old owner, token, and database-clock expiry so it cannot erase a
 * lease that another executor already renewed or replaced. */
export async function clearExpiredRunExecutionLease(runId: string, now?: number): Promise<boolean> {
  const currentNow = now ?? (await databaseCurrentTimeMs());
  return db.transaction(async (transaction): Promise<boolean> => {
    const tx = transaction as unknown as typeof db;
    const current = await tx.query.runs.findFirst({
      where: eq(runs.id, runId),
      columns: {
        workspaceId: true,
        executionOwnerNodeId: true,
        executionOwnerInstanceId: true,
        executionFencingToken: true,
        executionLeaseExpiresAt: true,
      },
    });
    if (
      current?.executionOwnerNodeId === null ||
      current?.executionOwnerNodeId === undefined ||
      current.executionOwnerInstanceId === null ||
      current.executionLeaseExpiresAt === null ||
      current.executionLeaseExpiresAt > currentNow
    ) {
      return false;
    }

    const clearedRun = await tx
      .update(runs)
      .set({
        executionOwnerNodeId: null,
        executionOwnerInstanceId: null,
        executionLeaseExpiresAt: null,
        executionLeaseHeartbeatAt: null,
        executionPhase: null,
      })
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.executionOwnerNodeId, current.executionOwnerNodeId),
          eq(runs.executionOwnerInstanceId, current.executionOwnerInstanceId),
          eq(runs.executionFencingToken, current.executionFencingToken),
          lte(runs.executionLeaseExpiresAt, currentNow),
        ),
      )
      .returning({ id: runs.id });
    if (clearedRun.length === 0) return false;

    // The workspace may already have been claimed by a different run after the
    // old lease expired. Only clear the exact old generation; zero rows is safe.
    await tx
      .update(workspaces)
      .set({
        executionRunId: null,
        executionOwnerNodeId: null,
        executionOwnerInstanceId: null,
        executionFencingToken: null,
        executionLeaseExpiresAt: null,
        executionLeaseHeartbeatAt: null,
      })
      .where(
        and(
          eq(workspaces.id, current.workspaceId),
          eq(workspaces.executionRunId, runId),
          eq(workspaces.executionOwnerNodeId, current.executionOwnerNodeId),
          eq(workspaces.executionOwnerInstanceId, current.executionOwnerInstanceId),
          eq(workspaces.executionFencingToken, current.executionFencingToken),
          lte(workspaces.executionLeaseExpiresAt, currentNow),
        ),
      );
    return true;
  });
}

export async function releaseRunExecutionLease(lease: RunExecutionLease): Promise<boolean> {
  return db.transaction(async (transaction): Promise<boolean> => {
    const tx = transaction as unknown as typeof db;
    const releasedRun = await tx
      .update(runs)
      .set({
        executionOwnerNodeId: null,
        executionOwnerInstanceId: null,
        executionLeaseExpiresAt: null,
        executionLeaseHeartbeatAt: null,
        executionPhase: null,
      })
      .where(
        and(
          eq(runs.id, lease.runId),
          eq(runs.executionOwnerNodeId, lease.ownerNodeId),
          eq(runs.executionOwnerInstanceId, lease.ownerInstanceId),
          eq(runs.executionFencingToken, lease.fencingToken),
        ),
      )
      .returning({ id: runs.id });
    if (releasedRun.length === 0) return false;

    const releasedWorkspace = await tx
      .update(workspaces)
      .set({
        executionRunId: null,
        executionOwnerNodeId: null,
        executionOwnerInstanceId: null,
        executionFencingToken: null,
        executionLeaseExpiresAt: null,
        executionLeaseHeartbeatAt: null,
      })
      .where(
        and(
          eq(workspaces.id, lease.workspaceId),
          eq(workspaces.executionRunId, lease.runId),
          eq(workspaces.executionOwnerNodeId, lease.ownerNodeId),
          eq(workspaces.executionOwnerInstanceId, lease.ownerInstanceId),
          eq(workspaces.executionFencingToken, lease.fencingToken),
        ),
      )
      .returning({ id: workspaces.id });
    if (releasedWorkspace.length === 0) throw new StaleRunExecutionLeaseError(lease.runId);
    return true;
  });
}

export async function withRunExecutionLease<T>(
  runId: string,
  phase: RunExecutionPhase,
  hooks: RunLeaseHooks,
  work: () => Promise<T>,
): Promise<T> {
  if (!haEnabled()) return work();

  const inheritedContext = leaseContext.getStore();
  if (inheritedContext !== undefined && inheritedContext.lease.runId === runId) {
    if (!inheritedContext.valid || performance.now() >= inheritedContext.validUntil) {
      inheritedContext.valid = false;
      throw new StaleRunExecutionLeaseError(runId);
    }
    inheritedContext.lease = await updateRunExecutionLeasePhase(inheritedContext.lease, phase);
    return work();
  }

  // HA-3C: a draining node finishes what it already owns but must not take on
  // a new generation. Refusing here is the single chokepoint that covers every
  // acquisition path (queue claim, scheduled apply dispatch, assessments).
  // Surfacing ordinary contention lets the run stay claimable elsewhere rather
  // than erroring, and the re-entrant path above is deliberately upstream of
  // this check so an in-flight plan can still proceed into its apply.
  if (nodeDrainRequested()) throw new RunExecutionLeaseUnavailableError(runId);

  const claimedLease = await claimRunExecutionLease(runId, phase);
  if (claimedLease === null) throw new RunExecutionLeaseUnavailableError(runId);
  let claimConfirmedAt: number;
  try {
    claimConfirmedAt = await databaseCurrentTimeMs();
  } catch {
    // The lease was committed before the confirmation read. If PostgreSQL is
    // no longer reachable, release best-effort and surface ordinary contention
    // so callers return the run to a retryable state rather than leaving it
    // fetching/apply_queued behind a lease that nobody is executing.
    await releaseRunExecutionLease(claimedLease).catch((): void => undefined);
    throw new RunExecutionLeaseUnavailableError(runId);
  }
  if (claimedLease.expiresAt <= claimConfirmedAt) {
    await releaseRunExecutionLease(claimedLease).catch((): void => undefined);
    throw new RunExecutionLeaseUnavailableError(runId);
  }
  const context: RunExecutionLeaseContext = {
    lease: claimedLease,
    valid: true,
    validUntil: performance.now() + (claimedLease.expiresAt - claimConfirmedAt),
  };

  let stopped = false;
  let lost = false;
  let renewTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

  const stopTimers = (): void => {
    if (renewTimer !== undefined) clearTimeout(renewTimer);
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    renewTimer = undefined;
    watchdogTimer = undefined;
  };

  const lose = async (reason: string): Promise<void> => {
    if (stopped || lost) return;
    lost = true;
    context.valid = false;
    stopTimers();
    log.error("Run execution lease lost; fencing local execution", {
      runId,
      workspaceId: context.lease.workspaceId,
      fencingToken: context.lease.fencingToken,
      reason,
    });
    await hooks.onLeaseLost(context.lease, reason);
  };

  const armWatchdog = (databaseNow: number): void => {
    if (stopped || lost) return;
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    const remainingMs = Math.max(0, context.lease.expiresAt - databaseNow);
    context.validUntil = performance.now() + remainingMs;
    watchdogTimer = setTimeout((): void => {
      void lose("lease watchdog expired before a successful renewal");
    }, remainingMs);
    watchdogTimer.unref?.();
  };

  const scheduleRenewal = (): void => {
    if (stopped || lost) return;
    renewTimer = setTimeout((): void => {
      void (async (): Promise<void> => {
        try {
          const renewed = await renewRunExecutionLease(context.lease);
          if (renewed === null) {
            await lose("database lease ownership changed or expired");
            return;
          }
          if (lost || stopped) {
            // A renewal may complete after the local watchdog has already
            // fenced this executor. Do not leave that late success extending
            // ownership and unnecessarily delaying takeover.
            await releaseRunExecutionLease(renewed).catch((): void => undefined);
            return;
          }

          const renewalConfirmedAt = await databaseCurrentTimeMs();
          if (lost || stopped) {
            await releaseRunExecutionLease(renewed).catch((): void => undefined);
            return;
          }
          context.lease = renewed;
          if (renewed.expiresAt <= renewalConfirmedAt) {
            await releaseRunExecutionLease(renewed).catch((): void => undefined);
            await lose("renewed lease expired before post-response database confirmation");
            return;
          }
          armWatchdog(renewalConfirmedAt);
          scheduleRenewal();
        } catch (error: unknown) {
          await lose(`lease renewal failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    }, RUN_EXECUTION_LEASE_RENEW_MS);
    renewTimer.unref?.();
  };

  armWatchdog(claimConfirmedAt);
  scheduleRenewal();

  try {
    const result = await leaseContext.run(context, work);
    if (lost) throw new StaleRunExecutionLeaseError(runId);
    return result;
  } finally {
    stopped = true;
    context.valid = false;
    stopTimers();
    const releaseLease = context.lease;
    await releaseRunExecutionLease(releaseLease).catch((error: unknown): void => {
      log.warn("Unable to release run execution lease", {
        runId,
        fencingToken: releaseLease.fencingToken,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
