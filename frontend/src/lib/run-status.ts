/**
 * One classification of run status into a visual tone, for the whole app.
 *
 * Before this existed, the run page derived colour from inline status arrays in
 * seven places and `StatusBadge` kept an eighth list, and the two vocabularies
 * disagreed: the badge knew `policy_hard_failed` but not `failed`, the page
 * knew `failed` and `unreachable` but not `policy_hard_failed`. Statuses that
 * appeared in neither list — `apply_queued`, `confirmed`, `queuing`,
 * `post_plan_running`, `force_canceled` — fell through to a neutral grey clock,
 * so a force-canceled run and a queued one looked identical.
 *
 * Every status the backend can emit is classified here, exactly once.
 */
export type RunTone = "neutral" | "active" | "success" | "attention" | "danger";

const TONE_BY_STATUS: Readonly<Record<string, RunTone>> = {
  // Waiting to start: nothing is happening yet.
  pending: "neutral",
  queuing: "neutral",
  plan_queued: "neutral",
  apply_queued: "neutral",
  confirmed: "neutral",
  fetching_completed: "neutral",
  pre_plan_completed: "neutral",
  post_plan_completed: "neutral",
  cost_estimated: "neutral",
  policy_checked: "neutral",

  // Work in progress: the run is moving under its own power.
  fetching: "active",
  pre_plan_running: "active",
  planning: "active",
  cost_estimating: "active",
  policy_checking: "active",
  post_plan_running: "active",
  applying: "active",
  pre_apply_running: "active",
  post_apply_running: "active",

  // Finished well.
  applied: "success",
  planned_and_finished: "success",
  planned_and_saved: "success",

  // Finished the plan, waiting on a person.
  planned: "attention",
  needs_confirmation: "attention",
  policy_soft_failed: "attention",
  policy_override: "attention",

  // Finished badly.
  errored: "danger",
  failed: "danger",
  policy_hard_failed: "danger",
  unreachable: "danger",

  // Stopped deliberately: a real outcome, but not a failure of the code.
  canceled: "neutral",
  force_canceled: "neutral",
  discarded: "neutral",
};

export function runTone(status: string | null | undefined): RunTone {
  if (status === null || status === undefined || status === "") return "neutral";
  return TONE_BY_STATUS[status] ?? "neutral";
}

/**
 * Tailwind classes for a tinted surface in each tone. Kept as whole recipes
 * rather than composed at call sites, because the app previously grew three
 * separate hand-written spellings of the amber warning panel that had drifted
 * apart.
 */
export const TONE_SURFACE: Readonly<Record<RunTone, string>> = {
  neutral: "border-border bg-muted/40 text-foreground",
  active: "border-primary/30 bg-primary/10 text-foreground",
  success: "border-success/30 bg-success/10 text-foreground",
  attention: "border-warning/40 bg-warning/10 text-foreground",
  danger: "border-destructive/30 bg-destructive/10 text-foreground",
};

/** Foreground colour for icons and emphasis text in each tone. */
export const TONE_ACCENT: Readonly<Record<RunTone, string>> = {
  neutral: "text-muted-foreground",
  active: "text-primary",
  success: "text-success",
  attention: "text-warning",
  danger: "text-destructive",
};

/** Phase status vocabulary used by the plan and apply artifacts. */
export type PhaseState = "pending" | "queued" | "running" | "finished" | "errored" | "canceled" | "unreachable";

export function phaseTone(state: string): RunTone {
  switch (state) {
    case "finished": return "success";
    case "running": return "active";
    case "queued": return "neutral";
    case "errored":
    case "unreachable": return "danger";
    case "canceled": return "neutral";
    default: return "neutral";
  }
}

/** Human phase label — "Running", not "running", and never a raw enum. */
const PHASE_LABELS: Readonly<Record<string, string>> = {
  pending: "Not started",
  queued: "Queued",
  running: "Running",
  finished: "Finished",
  errored: "Failed",
  canceled: "Canceled",
  unreachable: "Unreachable",
};

export function formatPhaseState(state: string): string {
  return PHASE_LABELS[state] ?? state.replace(/_/g, " ");
}
