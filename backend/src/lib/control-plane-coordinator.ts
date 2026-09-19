import { and, eq, gt, lte, sql } from "drizzle-orm";
import { databaseCurrentTimeMs, db } from "../db";
import { controlPlaneLeases } from "../db/schema";
import { publish, subscribe } from "./event-bus";
import { log } from "./log";
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
/** Set while this node has deliberately stepped down (drain/maintenance). A
 * suspended coordinator keeps observing who leads but never contends, so a
 * resignation cannot be immediately undone by its own next renewal tick. */
let coordinatorSuspended = false;
let coordinatorTimer: ReturnType<typeof setTimeout> | undefined;
let resignationSubscription: (() => void) | undefined;
let leadershipWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
let leadershipValidUntil = 0;
let coordinatorStarted = false;
let leadershipGeneration = 0;

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
    void coordinatorTick();
  }, CONTROL_PLANE_LEASE_RENEW_MS);
  coordinatorTimer.unref?.();
}

/** Track the current owner without contending. Used while suspended so the
 * operations surfaces still report an accurate coordinator during a drain. */
async function observeCoordinatorTick(): Promise<void> {
  try {
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
  try {
    const lease = await claimControlPlaneLease(identity);
    if (lease.acquired) {
      // Verify the returned lease against the same authoritative clock after
      // the claim completes. A stalled network response must not resurrect a
      // lease that already expired while the process was waiting.
      const databaseNow = await databaseCurrentTimeMs();
      if (lease.expiresAt <= databaseNow) {
        if (coordinatorState.role === "leader") await loseLeadership();
        coordinatorState = {
          role: "follower",
          ownerNodeId: lease.ownerNodeId,
          fencingEpoch: lease.fencingEpoch,
          expiresAt: lease.expiresAt,
          heartbeatAt: lease.heartbeatAt,
        };
        log.warn("Control-plane coordinator lease expired before confirmation", {
          nodeId: identity.nodeId,
          fencingEpoch: lease.fencingEpoch,
        });
        return;
      }

      const becameLeader = coordinatorState.role !== "leader" || coordinatorState.fencingEpoch !== lease.fencingEpoch;
      coordinatorState = {
        role: "leader",
        ownerNodeId: lease.ownerNodeId,
        fencingEpoch: lease.fencingEpoch,
        expiresAt: lease.expiresAt,
        heartbeatAt: lease.heartbeatAt,
      };
      if (becameLeader) leadershipGeneration += 1;
      armLeadershipWatchdog(lease.expiresAt - databaseNow);
      if (becameLeader) {
        const generation = leadershipGeneration;
        log.info("Control-plane coordinator lease acquired", {
          nodeId: identity.nodeId,
          fencingEpoch: lease.fencingEpoch,
        });
        activateLeadership(lease.fencingEpoch, generation);
      }
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
      coordinatorState = {
        role: "follower",
        ownerNodeId: lease.ownerNodeId,
        fencingEpoch: lease.fencingEpoch,
        expiresAt: lease.expiresAt,
        heartbeatAt: lease.heartbeatAt,
      };
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
  await coordinatorTick();
}

export function controlPlaneCoordinatorSuspended(): boolean {
  return coordinatorSuspended;
}

/**
 * HA-3C: explicit leader resignation for planned maintenance.
 *
 * Failover by TTL expiry is correct but costs up to `CONTROL_PLANE_LEASE_TTL_MS`
 * of scheduler downtime, which is a pointless price to pay when an operator is
 * deliberately replacing a node. Resignation collapses that to the time it
 * takes a follower to run one claim.
 *
 * The order is deliberate: suspend contention, stop generating scheduler work,
 * and only then give up the lease. Releasing first would leave this node's
 * scheduler briefly running against a cluster that already has a new leader.
 *
 * No successor is nominated. `expires_at` is set to the database's own clock
 * floor under a compare-and-set on the owning instance and epoch, and whichever
 * eligible replica wins the ordinary atomic claim becomes leader. That keeps
 * PostgreSQL as the single coordination boundary rather than introducing a
 * second consensus mechanism for handoff.
 */
export async function resignControlPlaneLease(): Promise<boolean> {
  const alreadySuspended = coordinatorSuspended;
  coordinatorSuspended = true;
  if (!haEnabled()) return false;

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
  // Wake the followers now rather than letting them discover the vacancy on
  // their own renewal cadence.
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
  if (!coordinatorStarted) return;
  if (coordinatorTimer !== undefined) clearTimeout(coordinatorTimer);
  coordinatorTimer = undefined;
  void coordinatorTick();
}

function handleResignationEvent(payload: Readonly<Record<string, unknown>>): void {
  if (!coordinatorStarted || coordinatorSuspended) return;
  if (payload["instanceId"] === controlPlaneInstanceId) return;
  if (coordinatorState.role === "leader") return;
  if (coordinatorTimer !== undefined) clearTimeout(coordinatorTimer);
  coordinatorTimer = undefined;
  void coordinatorTick();
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
  coordinatorSuspended = false;
  resignationSubscription ??= subscribe(CONTROL_PLANE_RESIGNATION_TOPIC, handleResignationEvent);
  coordinatorState = {
    role: "follower",
    ownerNodeId: null,
    fencingEpoch: null,
    expiresAt: null,
    heartbeatAt: null,
  };
  await coordinatorTick();
}

export async function stopControlPlaneCoordinator(): Promise<void> {
  resignationSubscription?.();
  resignationSubscription = undefined;
  coordinatorSuspended = false;
  if (!coordinatorStarted) return;
  coordinatorStarted = false;
  if (coordinatorTimer !== undefined) clearTimeout(coordinatorTimer);
  coordinatorTimer = undefined;
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
