import { and, eq, gt, lte, sql, type SQL } from "drizzle-orm";
import { databaseCurrentTimeMs, db } from "../db";
import { isPostgres } from "../db/driver";
import { controlPlaneLeases } from "../db/schema";
import { publish, subscribe } from "./event-bus";
import { log } from "./log";
import { conservativeLeaseRemainingMs } from "./lease-deadline";
import { controlPlaneInstanceId, controlPlaneNodeId, coordinatorEligible, haEnabled } from "./ha-config";

export const CONTROL_PLANE_LEASE_NAME = "scheduler";
export const CONTROL_PLANE_LEASE_TTL_MS = 15_000;
export const CONTROL_PLANE_LEASE_RENEW_MS = 5_000;
/** Broadcast so followers contend the instant a leader resigns, instead of
 * waiting out the lease TTL during planned maintenance. */
export const CONTROL_PLANE_RESIGNATION_TOPIC = "ha.coordinator.resigned";

export type ControlPlaneLeaseSnapshot = Readonly<{
  acquired: boolean;
  name: string;
  ownerNodeId: string;
  ownerInstanceId: string;
  fencingEpoch: number;
  expiresAt: number;
  heartbeatAt: number;
}>;

type LeaseIdentity = Readonly<{
  nodeId: string;
  instanceId: string;
}>;

function snapshot(
  row: Readonly<typeof controlPlaneLeases.$inferSelect>,
  identity: LeaseIdentity,
): ControlPlaneLeaseSnapshot {
  return {
    acquired: row.ownerInstanceId === identity.instanceId,
    name: row.name,
    ownerNodeId: row.ownerNodeId,
    ownerInstanceId: row.ownerInstanceId,
    fencingEpoch: row.fencingEpoch,
    expiresAt: row.expiresAt,
    heartbeatAt: row.heartbeatAt,
  };
}

export class StaleControlPlaneCoordinatorFenceError extends Error {
  constructor(fencingEpoch: number) {
    super(`Control-plane coordinator epoch ${String(fencingEpoch)} is no longer authoritative`);
    this.name = "StaleControlPlaneCoordinatorFenceError";
  }
}

function databaseNowExpression(): SQL {
  return isPostgres
    ? sql`CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)`
    : sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;
}

/** Lock and validate the current coordinator generation inside a transaction. */
export async function assertControlPlaneCoordinatorFenceTx(transaction: unknown, fencingEpoch: number): Promise<void> {
  if (!haEnabled()) return;
  const tx = transaction as typeof db;
  const locked = await tx
    .update(controlPlaneLeases)
    .set({ fencingEpoch })
    .where(
      and(
        eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME),
        eq(controlPlaneLeases.ownerNodeId, controlPlaneNodeId()),
        eq(controlPlaneLeases.ownerInstanceId, controlPlaneInstanceId),
        eq(controlPlaneLeases.fencingEpoch, fencingEpoch),
        gt(controlPlaneLeases.expiresAt, databaseNowExpression()),
      ),
    )
    .returning({ name: controlPlaneLeases.name });
  if (locked.length === 0) throw new StaleControlPlaneCoordinatorFenceError(fencingEpoch);
}

/**
 * Renew an active lease, create a missing lease, or atomically take over an
 * expired lease. Only takeover advances the fencing epoch.
 */
export async function claimControlPlaneLease(
  identity: LeaseIdentity,
  now?: number,
  ttlMs = CONTROL_PLANE_LEASE_TTL_MS,
): Promise<ControlPlaneLeaseSnapshot> {
  const currentNow = now ?? (await databaseCurrentTimeMs());
  const expiresAt = currentNow + ttlMs;

  const renewed = await db
    .update(controlPlaneLeases)
    .set({ ownerNodeId: identity.nodeId, expiresAt, heartbeatAt: currentNow })
    .where(
      and(
        eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME),
        eq(controlPlaneLeases.ownerInstanceId, identity.instanceId),
        gt(controlPlaneLeases.expiresAt, currentNow),
      ),
    )
    .returning();
  if (renewed[0] !== undefined) return snapshot(renewed[0], identity);

  const inserted = await db
    .insert(controlPlaneLeases)
    .values({
      name: CONTROL_PLANE_LEASE_NAME,
      ownerNodeId: identity.nodeId,
      ownerInstanceId: identity.instanceId,
      fencingEpoch: 1,
      expiresAt,
      heartbeatAt: currentNow,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0] !== undefined) return snapshot(inserted[0], identity);

  const takenOver = await db
    .update(controlPlaneLeases)
    .set({
      ownerNodeId: identity.nodeId,
      ownerInstanceId: identity.instanceId,
      fencingEpoch: sql`${controlPlaneLeases.fencingEpoch} + 1`,
      expiresAt,
      heartbeatAt: currentNow,
    })
    .where(and(eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME), lte(controlPlaneLeases.expiresAt, currentNow)))
    .returning();
  if (takenOver[0] !== undefined) return snapshot(takenOver[0], identity);

  const current = await db.query.controlPlaneLeases.findFirst({
    where: eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME),
  });
  if (current === undefined) {
    // A concurrent delete is not expected (release expires rows rather than
    // deleting them), but retry once rather than inventing an owner.
    return claimControlPlaneLease(identity, currentNow, ttlMs);
  }
  return snapshot(current, identity);
}

/** Expire, rather than delete, so the next owner increments the epoch. */
export async function releaseControlPlaneLease(identity: LeaseIdentity, now?: number): Promise<boolean> {
  const currentNow = now ?? (await databaseCurrentTimeMs());
  const released = await db
    .update(controlPlaneLeases)
    .set({ expiresAt: 0, heartbeatAt: currentNow })
    .where(
      and(
        eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME),
        eq(controlPlaneLeases.ownerInstanceId, identity.instanceId),
      ),
    )
    .returning({ name: controlPlaneLeases.name });
  return released.length > 0;
}

export type CoordinatorRole = "disabled" | "ineligible" | "follower" | "leader";
export type CoordinatorState = Readonly<{
  role: CoordinatorRole;
  ownerNodeId: string | null;
  fencingEpoch: number | null;
  expiresAt: number | null;
  heartbeatAt: number | null;
}>;

const disabledState: CoordinatorState = Object.freeze({
  role: "disabled",
  ownerNodeId: null,
  fencingEpoch: null,
  expiresAt: null,
  heartbeatAt: null,
});

let coordinatorState: CoordinatorState = disabledState;
/** Suspended nodes observe the coordinator lease but do not contend for it. */
let coordinatorSuspended = false;
let coordinatorTimer: ReturnType<typeof setTimeout> | undefined;
let resignationSubscription: (() => void) | undefined;
let leadershipWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
let leadershipValidUntil = 0;
let coordinatorStarted = false;
let leadershipGeneration = 0;
/**
 * Monotonic lifecycle fence. Every awaited claim path records the generation
 * at entry; drain/stop/resume invalidate any claim that belongs to a stale
 * generation so a delayed election cannot reacquire ownership.
 */
let lifecycleGeneration = 0;
let inFlightTick: Promise<void> | null = null;
/** Test seam: lets tests inject a deferred claim to simulate a slow election. */
let claimControlPlaneLeaseImpl: typeof claimControlPlaneLease | null = null;

export function controlPlaneElectionInFlight(): boolean {
  return inFlightTick !== null;
}

export function setClaimControlPlaneLeaseForTests(impl: typeof claimControlPlaneLease | null): void {
  claimControlPlaneLeaseImpl = impl;
}

async function startCoordinatorTick(): Promise<void> {
  const tick = coordinatorTick().catch((error: unknown): void => {
    log.warn("Control-plane coordinator tick failed", { error: String(error) });
  });
  inFlightTick = tick;
  void tick.finally((): void => {
    if (inFlightTick === tick) inFlightTick = null;
  });
  return tick;
}

/** Wait for any in-flight election to settle after its generation changed. */
async function awaitInFlightTick(): Promise<void> {
  const pending = inFlightTick;
  if (pending !== null) await pending.catch((): void => undefined);
}

type CoordinatorCallbacks = Readonly<{
  onLeadershipAcquired: (fencingEpoch: number) => void | Promise<void>;
  onLeadershipLost: () => void | Promise<void>;
}>;

let coordinatorCallbacks: CoordinatorCallbacks | undefined;

export function controlPlaneCoordinatorState(): CoordinatorState {
  if (coordinatorState.role === "leader" && !isControlPlaneCoordinatorLeader()) {
    return { ...coordinatorState, role: "follower" };
  }
  return { ...coordinatorState };
}

export function isControlPlaneCoordinatorLeader(): boolean {
  return coordinatorState.role === "leader" && performance.now() < leadershipValidUntil;
}

function clearLeadershipWatchdog(): void {
  if (leadershipWatchdogTimer !== undefined) clearTimeout(leadershipWatchdogTimer);
  leadershipWatchdogTimer = undefined;
  leadershipValidUntil = 0;
}

function armLeadershipWatchdog(remainingMs: number): void {
  clearLeadershipWatchdog();
  const boundedRemaining = Math.max(0, remainingMs);
  leadershipValidUntil = performance.now() + boundedRemaining;
  const generation = leadershipGeneration;
  const fencingEpoch = coordinatorState.fencingEpoch;
  leadershipWatchdogTimer = setTimeout((): void => {
    if (
      !coordinatorStarted ||
      coordinatorState.role !== "leader" ||
      generation !== leadershipGeneration ||
      fencingEpoch !== coordinatorState.fencingEpoch
    ) {
      return;
    }
    log.error("Control-plane coordinator lease expired before a successful renewal", {
      nodeId: controlPlaneNodeId(),
      fencingEpoch,
    });
    void loseLeadership();
  }, boundedRemaining);
  leadershipWatchdogTimer.unref?.();
}

async function loseLeadership(): Promise<void> {
  if (coordinatorState.role !== "leader") return;
  clearLeadershipWatchdog();
  leadershipGeneration += 1;
  coordinatorState = {
    role: "follower",
    ownerNodeId: null,
    fencingEpoch: null,
    expiresAt: null,
    heartbeatAt: null,
  };
  try {
    await coordinatorCallbacks?.onLeadershipLost();
  } catch (error: unknown) {
    log.error("Control-plane leadership loss callback failed", { error: String(error) });
  }
}

function activateLeadership(fencingEpoch: number, generation: number): void {
  const callback = coordinatorCallbacks?.onLeadershipAcquired;
  if (callback === undefined) return;
  void Promise.resolve(callback(fencingEpoch)).catch(async (error: unknown): Promise<void> => {
    log.error("Control-plane coordinator activation failed", { fencingEpoch, error: String(error) });
    if (coordinatorStarted && generation === leadershipGeneration && coordinatorState.role === "leader") {
      await loseLeadership();
      await releaseControlPlaneLease({
        nodeId: controlPlaneNodeId(),
        instanceId: controlPlaneInstanceId,
      }).catch((): void => undefined);
    }
  });
}

function scheduleCoordinatorTick(): void {
  if (!coordinatorStarted) return;
  coordinatorTimer = setTimeout((): void => {
    void startCoordinatorTick();
  }, CONTROL_PLANE_LEASE_RENEW_MS);
  coordinatorTimer.unref?.();
}

/** Track the current owner without contending. Used while suspended so the
 * operations surfaces still report an accurate coordinator during a drain. */
async function observeCoordinatorTick(): Promise<void> {
  try {
    if (coordinatorState.role === "leader") await loseLeadership();
    const current = await db.query.controlPlaneLeases.findFirst({
      where: eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME),
    });
    coordinatorState = {
      role: "follower",
      ownerNodeId: current?.ownerNodeId ?? null,
      fencingEpoch: current?.fencingEpoch ?? null,
      expiresAt: current?.expiresAt ?? null,
      heartbeatAt: current?.heartbeatAt ?? null,
    };
  } catch (error: unknown) {
    log.warn("Control-plane coordinator observation failed while suspended", {
      nodeId: controlPlaneNodeId(),
      error: String(error),
    });
  } finally {
    scheduleCoordinatorTick();
  }
}

const followerState = (lease?: ControlPlaneLeaseSnapshot): CoordinatorState => ({
  role: "follower",
  ownerNodeId: lease?.ownerNodeId ?? null,
  fencingEpoch: lease?.fencingEpoch ?? null,
  expiresAt: lease?.expiresAt ?? null,
  heartbeatAt: lease?.heartbeatAt ?? null,
});

/** Install leader state for a freshly acquired lease, or relinquish it. */
async function applyAcquiredLease(
  identity: LeaseIdentity,
  lease: ControlPlaneLeaseSnapshot,
  generation: number,
): Promise<void> {
  // Verify the returned lease against the same authoritative clock after the
  // claim completes. A stalled network response must not resurrect a lease
  // that already expired while the process was waiting.
  const confirmationStartedAt = performance.now();
  const databaseNow = await databaseCurrentTimeMs();
  if (!coordinatorStarted || coordinatorSuspended || generation !== lifecycleGeneration) {
    // A drain/stop/resume transition completed while the election was still
    // waiting on the database. This claim belongs to a stale generation: never
    // install leader state from it, and relinquish it so the successor can
    // claim immediately.
    await releaseControlPlaneLease(identity).catch((): void => undefined);
    if (coordinatorState.role === "leader") await loseLeadership();
    coordinatorState = followerState();
    return;
  }
  const remainingMs = conservativeLeaseRemainingMs(lease.expiresAt, databaseNow, confirmationStartedAt);
  if (remainingMs <= 0) {
    if (coordinatorState.role === "leader") await loseLeadership();
    coordinatorState = followerState(lease);
    log.warn("Control-plane coordinator lease expired before confirmation", {
      nodeId: identity.nodeId,
      fencingEpoch: lease.fencingEpoch,
    });
    return;
  }

  const becameLeader = coordinatorState.role !== "leader" || coordinatorState.fencingEpoch !== lease.fencingEpoch;
  coordinatorState = { ...followerState(lease), role: "leader" };
  if (becameLeader) leadershipGeneration += 1;
  armLeadershipWatchdog(remainingMs);
  if (!becameLeader) return;
  const leaderGeneration = leadershipGeneration;
  log.info("Control-plane coordinator lease acquired", {
    nodeId: identity.nodeId,
    fencingEpoch: lease.fencingEpoch,
  });
  activateLeadership(lease.fencingEpoch, leaderGeneration);
}

async function coordinatorTick(): Promise<void> {
  if (!coordinatorStarted) return;
  if (coordinatorSuspended) {
    await observeCoordinatorTick();
    return;
  }
  const identity = {
    nodeId: controlPlaneNodeId(),
    instanceId: controlPlaneInstanceId,
  };
  const generation = lifecycleGeneration;
  try {
    const lease = await (claimControlPlaneLeaseImpl ?? claimControlPlaneLease)(identity);
    if (lease.acquired) {
      await applyAcquiredLease(identity, lease, generation);
    } else {
      if (coordinatorState.role === "leader") {
        log.warn("Control-plane coordinator lease lost", {
          nodeId: identity.nodeId,
          ownerNodeId: lease.ownerNodeId,
          fencingEpoch: lease.fencingEpoch,
        });
        await loseLeadership();
      } else {
        clearLeadershipWatchdog();
      }
      coordinatorState = followerState(lease);
    }
  } catch (error: unknown) {
    if (coordinatorState.role === "leader") {
      log.error("Control-plane coordinator renewal failed; relinquishing local execution ownership", {
        nodeId: identity.nodeId,
        error: String(error),
      });
      await loseLeadership();
    } else {
      log.warn("Control-plane coordinator election attempt failed", {
        nodeId: identity.nodeId,
        error: String(error),
      });
    }
  } finally {
    scheduleCoordinatorTick();
  }
}

/** Test-only deterministic renewal tick without leaving two renewal timers armed. */
export async function runControlPlaneCoordinatorTickForTests(): Promise<void> {
  if (coordinatorTimer !== undefined) clearTimeout(coordinatorTimer);
  coordinatorTimer = undefined;
  await startCoordinatorTick();
}

export function controlPlaneCoordinatorSuspended(): boolean {
  return coordinatorSuspended;
}

/**
 * Resign the local coordinator lease for planned maintenance.
 * Scheduler work stops before the lease is expired. The release is fenced by
 * owner instance and epoch; normal PostgreSQL election chooses the successor.
 */
export async function resignControlPlaneLease(): Promise<boolean> {
  const alreadySuspended = coordinatorSuspended;
  coordinatorSuspended = true;
  lifecycleGeneration += 1;
  if (!haEnabled()) return false;
  // Wait for a claim already waiting on the database: it must not install
  // leader state after resignation, and its stale claim must be released
  // before the successor is expected to contend.
  await awaitInFlightTick();

  const epoch = coordinatorState.fencingEpoch;
  const wasLeader = coordinatorState.role === "leader";
  // Stop the local scheduler generation before the lease is surrendered.
  if (wasLeader) await loseLeadership();
  if (!wasLeader && alreadySuspended) return false;

  const currentNow = await databaseCurrentTimeMs();
  const ownership = and(
    eq(controlPlaneLeases.name, CONTROL_PLANE_LEASE_NAME),
    eq(controlPlaneLeases.ownerInstanceId, controlPlaneInstanceId),
    epoch === null ? undefined : eq(controlPlaneLeases.fencingEpoch, epoch),
  );
  const resigned = await db
    .update(controlPlaneLeases)
    .set({ expiresAt: 0, heartbeatAt: currentNow })
    .where(ownership)
    .returning({ fencingEpoch: controlPlaneLeases.fencingEpoch });
  if (resigned.length === 0) return false;

  log.info("Control-plane coordinator lease resigned", {
    nodeId: controlPlaneNodeId(),
    fencingEpoch: resigned[0]?.fencingEpoch ?? epoch,
  });
  // Wake followers immediately after planned resignation.
  publish(CONTROL_PLANE_RESIGNATION_TOPIC, {
    nodeId: controlPlaneNodeId(),
    instanceId: controlPlaneInstanceId,
    fencingEpoch: resigned[0]?.fencingEpoch ?? epoch,
  });
  return true;
}

/** Return a resigned node to the election (drain cancelation, uncordon). */
export function resumeControlPlaneCoordinator(): void {
  if (!coordinatorSuspended) return;
  coordinatorSuspended = false;
  lifecycleGeneration += 1;
  if (!coordinatorStarted) return;
  if (coordinatorTimer !== undefined) clearTimeout(coordinatorTimer);
  coordinatorTimer = undefined;
  void startCoordinatorTick();
}

function handleResignationEvent(payload: Readonly<Record<string, unknown>>): void {
  if (!coordinatorStarted || coordinatorSuspended) return;
  if (payload["instanceId"] === controlPlaneInstanceId) return;
  if (coordinatorState.role === "leader") return;
  if (coordinatorTimer !== undefined) clearTimeout(coordinatorTimer);
  coordinatorTimer = undefined;
  void startCoordinatorTick();
}

export async function startControlPlaneCoordinator(callbacks: CoordinatorCallbacks): Promise<void> {
  if (!haEnabled()) {
    clearLeadershipWatchdog();
    coordinatorState = disabledState;
    return;
  }
  if (!coordinatorEligible()) {
    clearLeadershipWatchdog();
    coordinatorState = {
      role: "ineligible",
      ownerNodeId: null,
      fencingEpoch: null,
      expiresAt: null,
      heartbeatAt: null,
    };
    return;
  }
  if (coordinatorStarted) return;
  coordinatorCallbacks = callbacks;
  coordinatorStarted = true;
  lifecycleGeneration += 1;
  // Preserve a suspension requested before election startup (for example a
  // node that boots already draining). A fresh process starts unsuspended by
  // module initialization; stopControlPlaneCoordinator resets it on shutdown.
  resignationSubscription ??= subscribe(CONTROL_PLANE_RESIGNATION_TOPIC, handleResignationEvent);
  coordinatorState = {
    role: "follower",
    ownerNodeId: null,
    fencingEpoch: null,
    expiresAt: null,
    heartbeatAt: null,
  };
  await startCoordinatorTick();
}

export async function stopControlPlaneCoordinator(): Promise<void> {
  resignationSubscription?.();
  resignationSubscription = undefined;
  coordinatorSuspended = false;
  if (!coordinatorStarted) return;
  coordinatorStarted = false;
  lifecycleGeneration += 1;
  if (coordinatorTimer !== undefined) clearTimeout(coordinatorTimer);
  coordinatorTimer = undefined;
  // A delayed election must not be able to reacquire ownership after shutdown.
  await awaitInFlightTick();
  const wasLeader = coordinatorState.role === "leader";
  if (wasLeader) await loseLeadership();
  else clearLeadershipWatchdog();
  await releaseControlPlaneLease({
    nodeId: controlPlaneNodeId(),
    instanceId: controlPlaneInstanceId,
  }).catch((error: unknown): void => {
    log.warn("Unable to release control-plane coordinator lease during shutdown", { error: String(error) });
  });
  coordinatorCallbacks = undefined;
  coordinatorState = haEnabled()
    ? {
        role: coordinatorEligible() ? "follower" : "ineligible",
        ownerNodeId: null,
        fencingEpoch: null,
        expiresAt: null,
        heartbeatAt: null,
      }
    : disabledState;
}
