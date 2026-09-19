/**
 * HA-3C: node drain as a real lifecycle rather than a status label.
 *
 *   ACTIVE
 *      | operator requests drain
 *      v
 *   DRAINING
 *      |-- stop accepting new coordinator work (resign the lease immediately)
 *      |-- stop claiming durable jobs
 *      |-- stop taking new local execution leases
 *      |-- allow existing run leases to finish
 *      v
 *   DRAINED   (0 run executions, 0 durable jobs, not coordinator)
 *
 * The crucial property is that draining must not kill a healthy Terraform or
 * OpenTofu execution. Phase 2 gave every run independent, fenced ownership, so
 * a drain only has to stop *acquisition*: run-123 with token 47 stays valid on
 * a draining node while run-789 is refused and claimed elsewhere.
 *
 * Authority split:
 *   - the durable request lives in `control_plane_nodes.drain_requested_at`,
 *     so an operator's intent survives a missed NOTIFY or a brief outage;
 *   - a control event makes the transition immediate instead of waiting for
 *     the next heartbeat;
 *   - the live process owns its own phase, so a restarted node comes back
 *     ACTIVE unless the request is still recorded against it.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { databaseCurrentTimeMs, db } from "../db";
import { controlPlaneNodes } from "../db/schema";
import {
  isControlPlaneCoordinatorLeader,
  resignControlPlaneLease,
  resumeControlPlaneCoordinator,
} from "./control-plane-coordinator";
import { publish, subscribe } from "./event-bus";
import { controlPlaneInstanceId, controlPlaneNodeId } from "./ha-config";
import { log } from "./log";

export const NODE_DRAIN_TOPIC = "ha.node.drain";
const DRAIN_COMPLETION_POLL_MS = 1_000;

export type NodeDrainPhase = "active" | "draining" | "drained";

/**
 * Live local work that keeps a drain from completing. The worker registers
 * this probe so that this module needs no worker import (the worker module
 * pulls in the entire execution sandbox).
 */
export type NodeDrainActivityProbe = () => Readonly<{
  activeRunExecutions: number;
  activeDurableJobs: number;
}>;

export type NodeDrainSnapshot = Readonly<{
  nodeId: string;
  phase: NodeDrainPhase;
  requestedAt: number | null;
  requestedBy: string | null;
  reason: string | null;
  drainedAt: number | null;
  activeRunExecutions: number;
  activeDurableJobs: number;
  coordinator: boolean;
}>;

let phase: NodeDrainPhase = "active";
let requestedAt: number | null = null;
let requestedBy: string | null = null;
let reason: string | null = null;
let drainedAt: number | null = null;
let completionTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribeDrainEvents: (() => void) | undefined;
let activityProbe: NodeDrainActivityProbe = (): { activeRunExecutions: number; activeDurableJobs: number } => ({
  activeRunExecutions: 0,
  activeDurableJobs: 0,
});

export function registerNodeDrainActivityProbe(probe: NodeDrainActivityProbe): void {
  activityProbe = probe;
}

/**
 * True once a drain has been requested locally. Every "should I take on new
 * work?" gate in the worker and the execution-lease claim path consults this.
 * Work already owned is unaffected.
 */
export function nodeDrainRequested(): boolean {
  return phase !== "active";
}

export function nodeDrainPhase(): NodeDrainPhase {
  return phase;
}

export function nodeDrainSnapshot(): NodeDrainSnapshot {
  const activity = activityProbe();
  return {
    nodeId: controlPlaneNodeId(),
    phase,
    requestedAt,
    requestedBy,
    reason,
    drainedAt,
    activeRunExecutions: activity.activeRunExecutions,
    activeDurableJobs: activity.activeDurableJobs,
    coordinator: isControlPlaneCoordinatorLeader(),
  };
}

function drainComplete(): boolean {
  const activity = activityProbe();
  return activity.activeRunExecutions === 0 && activity.activeDurableJobs === 0 && !isControlPlaneCoordinatorLeader();
}

async function persistDrainedAt(at: number): Promise<void> {
  await db
    .update(controlPlaneNodes)
    .set({ status: "drained", drainedAt: at, lastHeartbeatAt: at })
    .where(
      and(
        eq(controlPlaneNodes.id, controlPlaneNodeId()),
        eq(controlPlaneNodes.instanceId, controlPlaneInstanceId),
        isNotNull(controlPlaneNodes.drainRequestedAt),
      ),
    )
    .catch((error: unknown): void => {
      log.warn("Unable to record drained control-plane node", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

function scheduleCompletionCheck(): void {
  if (completionTimer !== undefined) clearTimeout(completionTimer);
  completionTimer = setTimeout((): void => {
    void evaluateNodeDrainCompletion();
  }, DRAIN_COMPLETION_POLL_MS);
  completionTimer.unref?.();
}

function clearCompletionCheck(): void {
  if (completionTimer !== undefined) clearTimeout(completionTimer);
  completionTimer = undefined;
}

/**
 * Promote DRAINING to DRAINED once nothing local is still owned. Exported so
 * callers (and tests) can force an immediate evaluation rather than waiting
 * for the poll.
 */
export async function evaluateNodeDrainCompletion(): Promise<NodeDrainPhase> {
  if (phase !== "draining") return phase;
  if (!drainComplete()) {
    scheduleCompletionCheck();
    return phase;
  }
  clearCompletionCheck();
  phase = "drained";
  drainedAt = await databaseCurrentTimeMs().catch((): number => Date.now());
  await persistDrainedAt(drainedAt);
  log.info("Control-plane node drained; safe to terminate", {
    nodeId: controlPlaneNodeId(),
    requestedBy,
    reason,
  });
  return phase;
}

/**
 * Enter DRAINING on this node.
 *
 * Coordinator ownership is relinquished first and explicitly. Waiting for the
 * 15s lease TTL to lapse is correct but needlessly slow for planned
 * maintenance; resigning lets a follower win the existing atomic claim right
 * away. This is leader resignation, not leader transfer: no successor is
 * nominated, so no second consensus mechanism is introduced.
 */
export async function beginLocalNodeDrain(
  options: Readonly<{ requestedBy?: string | null; reason?: string | null }> = {},
): Promise<NodeDrainSnapshot> {
  if (phase === "active") {
    phase = "draining";
    requestedAt = await databaseCurrentTimeMs().catch((): number => Date.now());
    requestedBy = options.requestedBy ?? null;
    reason = options.reason ?? null;
    drainedAt = null;
    log.info("Control-plane node draining", {
      nodeId: controlPlaneNodeId(),
      requestedBy,
      reason,
    });
    await resignControlPlaneLease().catch((error: unknown): void => {
      // A failed resignation is not fatal: the lease still expires on its own
      // TTL and the local scheduler generation has already stopped.
      log.warn("Coordinator resignation during drain failed; falling back to lease expiry", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  await evaluateNodeDrainCompletion();
  return nodeDrainSnapshot();
}

/** Return a drained or draining node to service (an "uncordon"). */
export async function cancelLocalNodeDrain(): Promise<NodeDrainSnapshot> {
  if (phase !== "active") {
    clearCompletionCheck();
    phase = "active";
    requestedAt = null;
    requestedBy = null;
    reason = null;
    drainedAt = null;
    resumeControlPlaneCoordinator();
    log.info("Control-plane node drain canceled; resuming normal work", { nodeId: controlPlaneNodeId() });
  }
  return nodeDrainSnapshot();
}

/**
 * Record an operator's drain request for any node and wake that node now.
 * Callable from any replica: the row is the durable record of intent and the
 * control event is only an accelerator.
 */
export async function requestNodeDrain(
  targetNodeId: string,
  options: Readonly<{ requestedBy?: string | null; reason?: string | null }> = {},
): Promise<boolean> {
  const now = await databaseCurrentTimeMs();
  const updated = await db
    .update(controlPlaneNodes)
    .set({
      status: "draining",
      drainRequestedAt: now,
      drainRequestedBy: options.requestedBy ?? null,
      drainReason: options.reason ?? null,
      drainedAt: null,
    })
    .where(eq(controlPlaneNodes.id, targetNodeId))
    .returning({ id: controlPlaneNodes.id });
  if (updated.length === 0) return false;

  publish(NODE_DRAIN_TOPIC, {
    nodeId: targetNodeId,
    drain: true,
    requestedBy: options.requestedBy ?? null,
    reason: options.reason ?? null,
  });
  if (targetNodeId === controlPlaneNodeId()) {
    await beginLocalNodeDrain({ requestedBy: options.requestedBy ?? null, reason: options.reason ?? null });
  }
  return true;
}

/** Clear a recorded drain request and return the node to service. */
export async function cancelNodeDrain(targetNodeId: string): Promise<boolean> {
  const now = await databaseCurrentTimeMs();
  const updated = await db
    .update(controlPlaneNodes)
    .set({
      status: "active",
      drainRequestedAt: null,
      drainRequestedBy: null,
      drainReason: null,
      drainedAt: null,
      lastHeartbeatAt: now,
    })
    .where(eq(controlPlaneNodes.id, targetNodeId))
    .returning({ id: controlPlaneNodes.id });
  if (updated.length === 0) return false;

  publish(NODE_DRAIN_TOPIC, { nodeId: targetNodeId, drain: false });
  if (targetNodeId === controlPlaneNodeId()) await cancelLocalNodeDrain();
  return true;
}

function handleDrainEvent(payload: Readonly<Record<string, unknown>>): void {
  const target = payload["nodeId"];
  if (typeof target !== "string" || target !== controlPlaneNodeId()) return;
  const drain = payload["drain"];
  if (drain === false) {
    void cancelLocalNodeDrain();
    return;
  }
  const by = payload["requestedBy"];
  const why = payload["reason"];
  void beginLocalNodeDrain({
    requestedBy: typeof by === "string" ? by : null,
    reason: typeof why === "string" ? why : null,
  });
}

/**
 * Adopt a drain request recorded against this node while it was not running
 * (or that arrived while NOTIFY was unavailable). Called from the heartbeat so
 * intent is never silently lost.
 */
export async function reconcileRecordedDrainRequest(): Promise<void> {
  const row = await db.query.controlPlaneNodes
    .findFirst({
      where: eq(controlPlaneNodes.id, controlPlaneNodeId()),
      columns: { drainRequestedAt: true, drainRequestedBy: true, drainReason: true },
    })
    .catch((): undefined => undefined);
  if (row === undefined) return;
  if (row.drainRequestedAt !== null && phase === "active") {
    await beginLocalNodeDrain({ requestedBy: row.drainRequestedBy, reason: row.drainReason });
    return;
  }
  if (row.drainRequestedAt === null && phase !== "active") await cancelLocalNodeDrain();
}

export function startNodeDrainWatch(): void {
  unsubscribeDrainEvents ??= subscribe(NODE_DRAIN_TOPIC, handleDrainEvent);
}

export function stopNodeDrainWatch(): void {
  unsubscribeDrainEvents?.();
  unsubscribeDrainEvents = undefined;
  clearCompletionCheck();
}

/** Test-only: return the module to its pristine ACTIVE state. */
export function resetNodeDrainStateForTests(): void {
  stopNodeDrainWatch();
  phase = "active";
  requestedAt = null;
  requestedBy = null;
  reason = null;
  drainedAt = null;
  activityProbe = (): { activeRunExecutions: number; activeDurableJobs: number } => ({
    activeRunExecutions: 0,
    activeDurableJobs: 0,
  });
}
