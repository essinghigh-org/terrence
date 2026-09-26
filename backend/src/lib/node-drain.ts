/** Planned node drain lifecycle.
 *
 * DRAINING blocks new local work while existing run leases and durable jobs
 * finish. Coordinator-owned assessments finish before leader resignation.
 * The node reaches DRAINED only after the durable request is still present and
 * no local work or coordinator ownership remains.
 */

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { databaseCurrentTimeMs, db } from "../db";
import { controlPlaneNodes } from "../db/schema";
import {
  controlPlaneCoordinatorSuspended,
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
export type NodeDrainRequestResult = "requested" | "not-found" | "unsupported";

/**
 * Live local work that keeps a drain from completing. The worker registers
 * this probe so that this module needs no worker import (the worker module
 * pulls in the entire execution sandbox).
 */
export type NodeDrainActivityProbe = () => Readonly<{
  activeRunExecutions: number;
  activeAssessments: number;
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
  activeAssessments: number;
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
let activityProbe: NodeDrainActivityProbe = (): {
  activeRunExecutions: number;
  activeAssessments: number;
  activeDurableJobs: number;
} => ({
  activeRunExecutions: 0,
  activeAssessments: 0,
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

export async function recordedNodeDrainPhase(nodeId: string): Promise<NodeDrainPhase | null> {
  const row = await db.query.controlPlaneNodes.findFirst({
    where: eq(controlPlaneNodes.id, nodeId),
    columns: { drainRequestedAt: true, drainedAt: true },
  });
  if (row === undefined) return null;
  if (row.drainedAt !== null) return "drained";
  return row.drainRequestedAt === null ? "active" : "draining";
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
    activeAssessments: activity.activeAssessments,
    activeDurableJobs: activity.activeDurableJobs,
    coordinator: isControlPlaneCoordinatorLeader(),
  };
}

function drainComplete(): boolean {
  const activity = activityProbe();
  return (
    activity.activeRunExecutions === 0 &&
    activity.activeAssessments === 0 &&
    activity.activeDurableJobs === 0 &&
    !isControlPlaneCoordinatorLeader() &&
    controlPlaneCoordinatorSuspended()
  );
}

async function persistDrainedAt(at: number): Promise<boolean> {
  try {
    const updated = await db
      .update(controlPlaneNodes)
      .set({ status: "drained", drainedAt: at, lastHeartbeatAt: at })
      .where(
        and(
          eq(controlPlaneNodes.id, controlPlaneNodeId()),
          eq(controlPlaneNodes.instanceId, controlPlaneInstanceId),
          isNotNull(controlPlaneNodes.drainRequestedAt),
        ),
      )
      .returning({ id: controlPlaneNodes.id });
    return updated.length > 0;
  } catch (error: unknown) {
    log.warn("Unable to record drained control-plane node", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
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

async function quiesceCoordinatorForDrain(): Promise<void> {
  const activity = activityProbe();

  // Assessments are coordinator-owned and do not have independent execution
  // leases. A leader keeps renewing while an assessment finishes so a new
  // coordinator cannot reconcile the same live assessment as interrupted.
  if (isControlPlaneCoordinatorLeader() && activity.activeAssessments > 0) return;

  if (controlPlaneCoordinatorSuspended()) return;
  await resignControlPlaneLease().catch((error: unknown): void => {
    log.warn("Coordinator resignation during drain failed; waiting for lease expiry", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Promote DRAINING to DRAINED once local work has settled and the node cannot
 * re-enter coordinator election.
 */
export async function evaluateNodeDrainCompletion(): Promise<NodeDrainPhase> {
  if (phase !== "draining") return phase;
  await quiesceCoordinatorForDrain();
  if (!drainComplete()) {
    scheduleCompletionCheck();
    return phase;
  }
  const completedAt = await databaseCurrentTimeMs().catch((): number => Date.now());
  if (!(await persistDrainedAt(completedAt))) {
    scheduleCompletionCheck();
    return phase;
  }

  clearCompletionCheck();
  phase = "drained";
  drainedAt = completedAt;
  log.info("Control-plane node drained; safe to terminate", {
    nodeId: controlPlaneNodeId(),
    requestedBy,
    reason,
  });
  return phase;
}

/** Enter local DRAINING state for an already-recorded drain request. */
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

async function wakeDrainTarget(
  targetNodeId: string,
  targetInstanceId: string,
  requestedBy: string | null,
  drainReason: string | null,
): Promise<void> {
  publish(NODE_DRAIN_TOPIC, {
    nodeId: targetNodeId,
    instanceId: targetInstanceId,
    drain: true,
    requestedBy,
    reason: drainReason,
  });
  if (targetNodeId === controlPlaneNodeId() && targetInstanceId === controlPlaneInstanceId) {
    await beginLocalNodeDrain({ requestedBy, reason: drainReason });
  }
}

async function persistDrainRequest(
  targetNodeId: string,
  targetInstanceId: string,
  requestedBy: string | null,
  drainReason: string | null,
): Promise<boolean> {
  const now = await databaseCurrentTimeMs();
  const updated = await db
    .update(controlPlaneNodes)
    .set({
      // Protocol-1 nodes treat "draining" as immediately replaceable.
      status: "maintenance",
      drainRequestedAt: now,
      drainRequestedBy: requestedBy,
      drainReason,
      drainedAt: null,
    })
    .where(
      and(
        eq(controlPlaneNodes.id, targetNodeId),
        eq(controlPlaneNodes.instanceId, targetInstanceId),
        isNull(controlPlaneNodes.drainRequestedAt),
      ),
    )
    .returning({ id: controlPlaneNodes.id });
  return updated.length > 0;
}

async function drainRequestExists(targetNodeId: string, targetInstanceId: string): Promise<boolean> {
  const current = await db.query.controlPlaneNodes.findFirst({
    where: and(eq(controlPlaneNodes.id, targetNodeId), eq(controlPlaneNodes.instanceId, targetInstanceId)),
    columns: { drainRequestedAt: true },
  });
  return current !== undefined && current.drainRequestedAt !== null;
}

function supportsNodeDrain(protocolVersion: number | null): boolean {
  return (protocolVersion ?? 1) >= 2;
}
/**
 * Record an operator's drain request for any node and wake that node now.
 * Callable from any replica: the row is the durable record of intent and the
 * control event is only an accelerator.
 */
export async function requestNodeDrain(
  targetNodeId: string,
  options: Readonly<{ requestedBy?: string | null; reason?: string | null }> = {},
): Promise<NodeDrainRequestResult> {
  const target = await db.query.controlPlaneNodes.findFirst({
    where: eq(controlPlaneNodes.id, targetNodeId),
    columns: {
      instanceId: true,
      protocolVersion: true,
      drainRequestedAt: true,
      drainRequestedBy: true,
      drainReason: true,
    },
  });
  if (target === undefined) return "not-found";

  if (!supportsNodeDrain(target.protocolVersion) || target.instanceId === null) return "unsupported";

  if (target.drainRequestedAt !== null) {
    await wakeDrainTarget(targetNodeId, target.instanceId, target.drainRequestedBy, target.drainReason);
    return "requested";
  }

  const requestedBy = options.requestedBy ?? null;
  const drainReason = options.reason ?? null;
  if (!(await persistDrainRequest(targetNodeId, target.instanceId, requestedBy, drainReason))) {
    return (await drainRequestExists(targetNodeId, target.instanceId)) ? "requested" : "not-found";
  }

  await wakeDrainTarget(targetNodeId, target.instanceId, requestedBy, drainReason);
  return "requested";
}

/** Clear a recorded drain request and return the node to service. */
export async function cancelNodeDrain(targetNodeId: string): Promise<boolean> {
  const updated = await db
    .update(controlPlaneNodes)
    .set({
      status: "active",
      drainRequestedAt: null,
      drainRequestedBy: null,
      drainReason: null,
      drainedAt: null,
    })
    .where(and(eq(controlPlaneNodes.id, targetNodeId), isNotNull(controlPlaneNodes.drainRequestedAt)))
    .returning({ id: controlPlaneNodes.id, instanceId: controlPlaneNodes.instanceId });
  const canceled = updated[0];
  if (canceled === undefined) return false;

  publish(NODE_DRAIN_TOPIC, { nodeId: targetNodeId, instanceId: canceled.instanceId, drain: false });
  if (targetNodeId === controlPlaneNodeId() && canceled.instanceId === controlPlaneInstanceId) {
    await cancelLocalNodeDrain();
  }
  return true;
}

function handleDrainEvent(payload: Readonly<Record<string, unknown>>): void {
  const target = payload["nodeId"];
  const targetInstance = payload["instanceId"];
  if (
    typeof target !== "string" ||
    target !== controlPlaneNodeId() ||
    typeof targetInstance !== "string" ||
    targetInstance !== controlPlaneInstanceId
  )
    return;
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

/** Reconcile the local phase with the drain request persisted on the node row. */
export async function reconcileRecordedDrainRequest(): Promise<void> {
  const row = await db.query.controlPlaneNodes
    .findFirst({
      where: eq(controlPlaneNodes.id, controlPlaneNodeId()),
      columns: { instanceId: true, drainRequestedAt: true, drainRequestedBy: true, drainReason: true },
    })
    .catch((): undefined => undefined);
  if (row === undefined) return;
  if (row.instanceId !== controlPlaneInstanceId) {
    // The node ID has been reused by a replacement process. The displaced
    // incarnation must remain locally fenced even though the replacement row
    // has no drain request. Never interpret replacement metadata as an
    // uncordon for this process.
    clearCompletionCheck();
    if (phase === "active") {
      phase = "draining";
      requestedAt = Date.now();
      requestedBy = "system";
      reason = "control-plane node identity replaced";
      drainedAt = null;
    }
    await resignControlPlaneLease().catch((error: unknown): void => {
      log.warn("Unable to resign coordinator after control-plane identity loss", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }
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
  activityProbe = (): { activeRunExecutions: number; activeAssessments: number; activeDurableJobs: number } => ({
    activeRunExecutions: 0,
    activeAssessments: 0,
    activeDurableJobs: 0,
  });
}
