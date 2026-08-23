/**
 * Worker execution phases (todo 13) — durable progress markers.
 *
 * The per-run lifecycle (queued -> planning -> planned -> etc.) was previously
 * driven entirely by direct DB updates inside worker.ts. This module is the
 * explicit durable-phase registry so durability and SIGKILL chaos can target
 * stable named checkpoints without string matching SQL inside tests.
 *
 * Durability wiring: every phase transition flows through updateRunStatus which
 * is CAS-guarded (WHERE status = current). The phase itself is the durable
 * marker — a crash before the CAS is not committed, after it the reconciler
 * re-reads the current row.
 */
export type ExecutionPhase =
  | "queued"
  | "planning"
  | "cost_estimating"
  | "policy_checking"
  | "planned"
  | "confirmed"
  | "applying"
  | "applied"
  | "errored"
  | "canceled"
  | "discarded";

const PHASE_ORDER: ExecutionPhase[] = [
  "queued","planning","cost_estimating","policy_checking",
  "planned","confirmed","applying","applied",
];

// Terminal phases that never need resume — the run has stopped.
const TERMINAL_PHASES: ReadonlySet<ExecutionPhase> = new Set([
  "applied","errored","canceled","discarded",
]);

// Phases that have been observed to hold significant persisted state.
const DURABLE_PHASES: ReadonlySet<ExecutionPhase> = new Set([
  "planning","cost_estimating","policy_checking","planned","applying",
]);

export function phaseOrder(phase: ExecutionPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

/** True when the phase represents a durable checkpoint (has persisted state worth resuming). */
export function isDurablePhase(phase: ExecutionPhase): boolean {
  return DURABLE_PHASES.has(phase) || TERMINAL_PHASES.has(phase);
}

/**
 * Durable checkpoint — validates the phase is a known ExecutionPhase and
 * returns it. Every transition flows through updateRunStatus which is
 * CAS-guarded (WHERE status = current). This helper documents the invariant
 * for durability and chaos tests.
 */
export function checkpointPhase(phase: ExecutionPhase): ExecutionPhase {
  const idx = PHASE_ORDER.indexOf(phase);
  if (idx === -1 && !TERMINAL_PHASES.has(phase)) {
    throw new Error(`Unknown execution phase: ${phase}`);
  }
  return phase;
}

/** Whether a phase has reached a terminal state (the run has stopped). */
export function isTerminalPhase(phase: ExecutionPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}
