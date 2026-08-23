/**
 * SIGKILL chaos contract (todo 14).
 *
 * Every durable phase checkpoint (see phases.ts) must tolerate an abrupt worker
 * crash (SIGKILL) without corrupting run state. The guarantee:
 *
 *  1. No transition that failed to CAS-persist is treated as committed.
 *  2. A restarted worker re-reads the current DB row and can resume or mark
 *     the run errored canonically.
 *  3. No run is left permanently non-terminal due to a crash.
 *
 * This module exposes the predicate that chaos tests assert against. The
 * underlying guarantee lives in worker.ts updateRunStatus:
 * WHERE status = currentStatus guards every transition atomically.
 */
import { isDurablePhase, isTerminalPhase, type ExecutionPhase } from "./phases";
import { canTransitionRunStatus, isTerminalRunStatus } from "../lib/run-status";

/** Whether a checkpoint is safe to crash at — only durable phases hold committed state. */
export function crashSafe(phase: ExecutionPhase): boolean {
  return isDurablePhase(phase);
}

/** Idempotent resume eligibility: a non-terminal run can always be recovered. */
export function canRecoverAfterCrash(status: string): boolean {
  return !isTerminalRunStatus(status) && status !== "discarded";
}

/** Whether a proposed post-crash transition is still legal from the persisted status. */
export function postCrashTransitionAllowed(from: string, to: string): boolean {
  return canTransitionRunStatus(from, to);
}

/** Whether the run status indicates a phase that the crash reconciler should retry. */
export function shouldRetryAfterCrash(status: string): boolean {
  return !isTerminalRunStatus(status) && status !== "discarded" && status !== "force_canceled";
}

/** Whether a phase is terminal (the run has stopped; no crash recovery needed). */
export function needsCrashRecovery(phase: ExecutionPhase): boolean {
  return !isTerminalPhase(phase);
}
