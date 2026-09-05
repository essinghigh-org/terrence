import { Check, Circle, CircleDot, Minus, X } from "lucide-react";
import { resolvePhaseStatus } from "@/lib/run-status";
import { cn } from "@/lib/utils";

/**
 * Where the run is, in one line.
 *
 * The page previously reported progress only through two large collapsible
 * sections whose headings embedded their own status ("Plan Finished", "Apply
 * Needs Confirmation"), so answering "where is this run?" meant reading two
 * headings, a header badge and a timestamp table, any of which could be a
 * refresh behind the others. This derives every stage from one status value,
 * so it cannot disagree with itself.
 */

export type StageState = "pending" | "active" | "done" | "failed" | "stopped" | "skipped";

export type Stage = Readonly<{
  id: string;
  label: string;
  state: StageState;
}>;

const STAGE_ORDER = ["queue", "plan", "policy", "apply"] as const;

const STAGE_LABELS: Readonly<Record<typeof STAGE_ORDER[number], string>> = {
  queue: "Queued",
  plan: "Plan",
  policy: "Checks",
  apply: "Apply",
};

/** Statuses grouped by the stage they belong to, in lifecycle order. */
const STAGE_OF_STATUS: Readonly<Record<string, typeof STAGE_ORDER[number]>> = {
  pending: "queue",
  fetching: "queue",
  fetching_completed: "queue",
  queuing: "queue",
  plan_queued: "queue",
  pre_plan_running: "plan",
  pre_plan_completed: "plan",
  planning: "plan",
  planned: "plan",
  needs_confirmation: "plan",
  planned_and_saved: "plan",
  planned_and_finished: "plan",
  cost_estimating: "policy",
  cost_estimated: "policy",
  policy_checking: "policy",
  policy_checked: "policy",
  policy_override: "policy",
  policy_soft_failed: "policy",
  policy_hard_failed: "policy",
  post_plan_running: "policy",
  post_plan_completed: "policy",
  confirmed: "apply",
  apply_queued: "apply",
  pre_apply_running: "apply",
  pre_apply_completed: "apply",
  applying: "apply",
  post_apply_running: "apply",
  post_apply_completed: "apply",
  applied: "apply",
};

const FAILED_STATUSES = new Set(["errored", "failed", "unreachable", "policy_hard_failed"]);
const STOPPED_STATUSES = new Set(["canceled", "force_canceled", "discarded"]);

/**
 * Build the stage strip.
 *
 * Terminal statuses carry no stage of their own — a run that errored could
 * have errored anywhere — so the timestamps decide how far it got, and the
 * stage it stopped in is marked failed while later stages are skipped rather
 * than left looking pending forever.
 */
export function resolveStages(
  status: string,
  timestamps: Readonly<Record<string, string>>,
  options: Readonly<{ planOnly: boolean; hasPolicyChecks: boolean }>,
): readonly Stage[] {
  const reached = (key: string): boolean => typeof timestamps[key] === "string";
  const planReached = reached("planning-at") || reached("pre-plan-running-at");
  const planDone = reached("planned-at") || reached("planned-and-finished-at") || reached("planned-and-saved-at");
  const policyReached = reached("policy-checking-at") || reached("cost-estimating-at") || reached("post-plan-running-at");
  const applyReached = reached("confirmed-at") || reached("apply-queued-at") || reached("applying-at");

  const stopped = FAILED_STATUSES.has(status) || STOPPED_STATUSES.has(status);
  const failed = FAILED_STATUSES.has(status);
  const currentStage = STAGE_OF_STATUS[status];

  // Where the run got to, for a terminal status with no stage of its own.
  const furthest: typeof STAGE_ORDER[number] = currentStage ?? (applyReached
    ? "apply"
    : policyReached
      ? "policy"
      : planReached || planDone
        ? "plan"
        : "queue");

  const stageDone: Readonly<Record<typeof STAGE_ORDER[number], boolean>> = {
    queue: planReached || planDone || policyReached || applyReached,
    plan: resolvePhaseStatus(status, "plan", timestamps) === "finished",
    policy: !["policy_checking", "cost_estimating", "post_plan_running"].includes(status)
      && (applyReached || status === "planned_and_finished"
        || reached("policy-checked-at") || reached("post-plan-completed-at")
        || ["policy_checked", "post_plan_completed", "needs_confirmation", "planned_and_saved"].includes(status)),
    apply: resolvePhaseStatus(status, "apply", timestamps) === "finished",
  };

  const currentIndex = currentStage === undefined ? 0 : STAGE_ORDER.indexOf(currentStage);
  const furthestIndex = STAGE_ORDER.indexOf(furthest);

  const stateFor = (id: typeof STAGE_ORDER[number]): StageState => {
    const index = STAGE_ORDER.indexOf(id);
    if (stopped) {
      if (stageDone[id] || index < furthestIndex) return "done";
      if (index === furthestIndex) return failed ? "failed" : "stopped";
      return "skipped";
    }
    if (id === "apply" && status === "planned_and_finished") return "skipped";
    if (stageDone[id]) return "done";
    if (id === currentStage) return "active";
    return index < currentIndex ? "done" : "pending";
  };

  return STAGE_ORDER
    // The policy stage is noise on an instance with no policies configured and
    // no cost estimation: it would sit permanently grey between two real
    // stages. Show it only once something has actually run there.
    .filter((id: typeof STAGE_ORDER[number]): boolean =>
      id !== "policy" || options.hasPolicyChecks || policyReached || currentStage === "policy")
    .filter((id: typeof STAGE_ORDER[number]): boolean =>
      id !== "apply" || !options.planOnly)
    .map((id: typeof STAGE_ORDER[number]): Stage => ({
      id,
      label: STAGE_LABELS[id],
      state: stateFor(id),
    }));
}

function StageIcon({ state }: Readonly<{ state: StageState }>): React.JSX.Element {
  const base = "size-4 shrink-0";
  if (state === "done") return <Check className={cn(base, "text-success")} aria-hidden="true" />;
  if (state === "active") return <CircleDot className={cn(base, "text-primary")} aria-hidden="true" />;
  if (state === "failed") return <X className={cn(base, "text-destructive")} aria-hidden="true" />;
  if (state === "skipped" || state === "stopped") return <Minus className={cn(base, "text-muted-foreground/50")} aria-hidden="true" />;
  return <Circle className={cn(base, "text-muted-foreground/40")} aria-hidden="true" />;
}

const STAGE_TEXT: Readonly<Record<StageState, string>> = {
  done: "text-foreground",
  active: "font-medium text-primary",
  failed: "font-medium text-destructive",
  stopped: "text-muted-foreground",
  skipped: "text-muted-foreground/60 line-through decoration-muted-foreground/40",
  pending: "text-muted-foreground/70",
};

const STAGE_STATE_WORDS: Readonly<Record<StageState, string>> = {
  done: "complete",
  active: "in progress",
  failed: "failed",
  stopped: "stopped",
  skipped: "not reached",
  pending: "not started",
};

export function RunStageStrip({
  stages,
  className,
}: Readonly<{ stages: readonly Stage[]; className?: string }>): React.JSX.Element {
  return (
    <ol
      aria-label="Run progress"
      className={cn("grid grid-flow-col auto-cols-fr overflow-hidden rounded-lg border border-border bg-card text-sm", className)}
    >
      {stages.map((stage: Stage, index: number): React.JSX.Element => (
        <li key={stage.id} aria-current={stage.state === "active" ? "step" : undefined}
          className={cn("relative flex min-w-0 flex-col items-center gap-2 px-2 py-3 sm:flex-row sm:gap-3 sm:px-5 sm:py-4",
            index > 0 && "border-l border-border",
            stage.state === "active" && "bg-primary/5 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary")}
        >
          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-background",
            stage.state === "active" && "border-primary/30",
            stage.state === "done" && "border-success/20 bg-success/5")}
          ><StageIcon state={stage.state} /></span>
          <span className="min-w-0">
            <span className={cn("block", STAGE_TEXT[stage.state])}>{stage.label}</span>
            <span className="hidden text-xs capitalize text-muted-foreground sm:block">{STAGE_STATE_WORDS[stage.state]}</span>
            <span className="sr-only sm:hidden">{STAGE_STATE_WORDS[stage.state]}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
