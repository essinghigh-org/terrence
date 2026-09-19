import { and, eq, gt, lte, sql } from "drizzle-orm";
import { databaseCurrentTimeMs, db } from "../db";
import { controlPlaneLeases } from "../db/schema";
import { log } from "./log";
import { controlPlaneInstanceId, controlPlaneNodeId, coordinatorEligible, haEnabled } from "./ha-config";

export const CONTROL_PLANE_LEASE_NAME = "scheduler";
export const CONTROL_PLANE_LEASE_TTL_MS = 15_000;
export const CONTROL_PLANE_LEASE_RENEW_MS = 5_000;

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
let coordinatorTimer: ReturnType<typeof setTimeout> | undefined;
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

async function coordinatorTick(): Promise<void> {
  if (!coordinatorStarted) return;
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
