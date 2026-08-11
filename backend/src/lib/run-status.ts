/**
 * Run status state machine (single source of truth).
 *
 * TFE-compatible run lifecycle: pending → fetching → fetching_completed →
 * pre_plan_running → pre_plan_completed → queuing → plan_queued → planning →
 * planned → cost_estimating → cost_estimated → policy_checking →
 * policy_checked → post_plan_running → post_plan_completed →
 * planned_and_saved | planned_and_finished, then (for saved plans)
 * confirmed → apply_queued → applying → applied.
 *
 * Operator actions may interrupt most active states: cancel/discard/force-
 * cancel (routes/runs.ts), policy override (policy_soft_failed → planned),
 * force-execute (canceled → pending), and re-queue (plan_queued /
 * apply_queued → pending). Errors fold any active state into `errored`.
 *
 * worker.ts's updateRunStatus logs a loud warning when a transition violates
 * this table; tests/unit/run-status-property.test.ts pins the table itself
 * (completeness, reachability, terminal absorption, model conformance).
 */

/** Every run status the backend can write. */
export const RUN_STATUSES = [
  "pending",
  "fetching",
  "fetching_completed",
  "pre_plan_running",
  "pre_plan_completed",
  "queuing",
  "plan_queued",
  "planning",
  "planned",
  "cost_estimating",
  "cost_estimated",
  "policy_checking",
  "policy_override",
  "policy_soft_failed",
  "policy_checked",
  "post_plan_running",
  "post_plan_completed",
  "planned_and_saved",
  "planned_and_finished",
  "confirmed",
  "apply_queued",
  "applying",
  "applied",
  "errored",
  "canceled",
  "discarded",
  "force_canceled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Statuses with no legal outgoing edges: a run that reaches one stays there.
 * Note `canceled` is deliberately NOT here: the operator force-execute action
 * reopens canceled runs into `pending` (the only exit from an otherwise
 * resting state). `FINAL_RUN_STATUSES` in lib/utils.ts remains the worker's
 * "has this run stopped" check and is separate from this model.
 */
export const RUN_TERMINAL_STATUSES: readonly RunStatus[] = [
  "applied",
  "errored",
  "discarded",
  "force_canceled",
  "planned_and_finished",
];

const TERMINAL_SET: ReadonlySet<string> = new Set(RUN_TERMINAL_STATUSES);

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_SET.has(status);
}

const EDGES: Readonly<Record<string, readonly string[]>> = {
  pending: ["fetching", "errored", "canceled", "discarded"],
  fetching: ["fetching_completed", "errored", "canceled", "discarded"],
  fetching_completed: ["pre_plan_running", "errored", "canceled", "discarded"],
  pre_plan_running: ["pre_plan_completed", "errored", "canceled", "discarded"],
  pre_plan_completed: ["queuing", "errored", "canceled", "discarded"],
  queuing: ["plan_queued", "errored", "canceled", "discarded"],
  plan_queued: ["planning", "pending", "errored", "canceled", "discarded"],
  planning: ["planned", "errored", "canceled", "discarded"],
  planned: [
    "cost_estimating",
    "confirmed", // user confirm action
    "apply_queued", // user apply action (planned_and_saved only in practice)
    "errored",
    "canceled",
    "discarded",
  ],
  cost_estimating: ["cost_estimated", "errored", "canceled", "discarded"],
  cost_estimated: ["policy_checking", "errored", "canceled", "discarded"],
  policy_checking: [
    "policy_checked",
    "policy_override", // transient marker before soft-fail resting state
    "policy_soft_failed",
    "errored",
    "canceled",
    "discarded",
  ],
  policy_override: ["policy_soft_failed", "errored", "canceled", "discarded"],
  policy_soft_failed: ["planned", "errored", "canceled", "discarded"], // override-policy action
  policy_checked: ["post_plan_running", "errored", "canceled", "discarded"],
  post_plan_running: ["post_plan_completed", "errored", "canceled", "discarded"],
  post_plan_completed: [
    "planned_and_saved",
    "planned_and_finished",
    "planned", // auto-apply blocked / no-change drift handling
    "errored",
    "canceled",
    "discarded",
  ],
  planned_and_saved: ["confirmed", "apply_queued", "errored", "canceled", "discarded"],
  planned_and_finished: [],
  confirmed: ["apply_queued", "errored", "canceled", "discarded"],
  apply_queued: ["applying", "pending", "errored", "canceled", "discarded"], // re-queue action
  applying: ["applied", "errored", "canceled", "discarded"],
  applied: [],
  errored: [],
  canceled: ["pending"], // force-execute action
  discarded: [],
  force_canceled: [],
};

const TRANSITION_SET: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(EDGES).map(([from, to]) => [from, new Set(to)]),
);

/** Whether `from → to` is a legal run status transition (unknown statuses are illegal). */
export function canTransitionRunStatus(from: string, to: string): boolean {
  const targets = TRANSITION_SET.get(from);
  if (targets === undefined) return false;
  return targets.has(to);
}

/** All legal `to` statuses for a given `from` status. */
export function nextRunStatuses(from: string): readonly string[] {
  return EDGES[from] ?? [];
}
