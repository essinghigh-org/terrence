import { isString } from "./type-guards";

/** Shared visual-tone vocabulary for run and phase status. */
export type RunTone = "neutral" | "active" | "success" | "attention" | "danger";

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
const PHASE_LABELS: Readonly<Record<PhaseState, string>> = {
  pending: "Not started",
  queued: "Queued",
  running: "Running",
  finished: "Finished",
  errored: "Failed",
  canceled: "Canceled",
  unreachable: "Unreachable",
};

export function formatPhaseState(state: string): string {
  return PHASE_LABELS[state as PhaseState] ?? state.replace(/_/g, " ");
}

/** The run lifecycle takes precedence over phase snapshots fetched earlier. */
export function resolvePhaseStatus(
  status: string,
  phase: "plan" | "apply",
  timestamps: Readonly<Record<string, string>>,
  artifactStatus?: string,
): string {
  const planStarted = isString(timestamps["planning-at"]) || isString(timestamps["pre-plan-running-at"]);
  const planFinished = artifactStatus === "finished" && phase === "plan"
    || isString(timestamps["planned-at"])
    || isString(timestamps["planned-and-finished-at"])
    || isString(timestamps["planned-and-saved-at"]);
  const applyStarted = ["confirmed-at", "apply-queued-at", "applying-at", "applied-at"]
    .some((key: string): boolean => isString(timestamps[key]));
  if (phase === "apply") {
    if (["applied", "post_apply_completed"].includes(status)) return "finished";
    if (["applying", "post_apply_running"].includes(status)) return "running";
    if (["confirmed", "apply_queued", "pre_apply_running", "pre_apply_completed"].includes(status)) return "queued";
    if (artifactStatus === "finished" || isString(timestamps["applied-at"])) return "finished";
    if (["errored", "failed", "unreachable"].includes(status)) return applyStarted ? "errored" : artifactStatus ?? "pending";
    if (["canceled", "discarded", "force_canceled"].includes(status)) return applyStarted ? "canceled" : "pending";
    return artifactStatus ?? "pending";
  }
  if (status === "planning") return "running";
  if (["queuing", "plan_queued", "pre_plan_running", "pre_plan_completed"].includes(status)) return "queued";
  if ([
    "planned",
    "needs_confirmation",
    "policy_hard_failed",
    "pre_apply_running",
    "pre_apply_completed",
    "post_apply_running",
    "post_apply_completed",
    "cost_estimating",
    "cost_estimated",
    "policy_checking",
    "policy_override",
    "policy_checked",
    "policy_soft_failed",
    "post_plan_running",
    "post_plan_completed",
    "planned_and_finished",
    "planned_and_saved",
    "confirmed",
    "apply_queued",
    "applying",
    "applied",
  ].includes(status)) return "finished";
  if (["errored", "failed", "unreachable"].includes(status)) return planFinished ? "finished" : "errored";
  if (["canceled", "discarded", "force_canceled"].includes(status)) {
    return planFinished ? "finished" : planStarted ? "canceled" : "pending";
  }
  return artifactStatus ?? "pending";
}
