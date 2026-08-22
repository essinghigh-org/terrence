/**
 * Worker execution phases (todo 13) — durable progress markers stub.
 *
 * Today the per-run lifecycle (queued -> planning -> planned -> etc.) is driven
 * entirely by direct DB updates inside worker.ts. This module is the explicit
 * durable-phase registry so 13 (durability) and 14 (SIGKILL chaos) can target
 * stable named checkpoints without string matching SQL inside tests.
 *
 * Implementation starts as a typed enum + no-op helpers; durability wiring
 * (persisted checkpoint rows) lands behind the same names.
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

export function phaseOrder(phase: ExecutionPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

/** True when a run can still be resumed from this phase after a crash. */
export function isDurablePhase(_phase: ExecutionPhase): boolean {
  // All phases are durable by design — a reconciler can pick up from any.
  return true;
}
