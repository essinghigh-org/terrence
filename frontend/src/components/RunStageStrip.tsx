import { Check, Circle, CircleDot, Minus, PauseCircle, X } from "lucide-react";
import { resolvePhaseStatus, resolveRunDisplay, type RunDisplay } from "@/lib/run-status";
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

export type StageState = "pending" | "active" | "waiting" | "done" | "failed" | "stopped" | "skipped";

export type Stage = Readonly<{
  id: string;
  label: string;
  state: StageState;
  startedAt: string | null;
  finishedAt: string | null;
  durationLabel: string | null;
  waitingReason: string | null;
}>;

const STAGE_ORDER = ["queue", "plan", "policy", "apply"] as const;

const STAGE_LABELS: Readonly<Record<typeof STAGE_ORDER[number], string>> = {
  queue: "Queued",
  plan: "Plan",
  policy: "Checks",
  apply: "Apply",
};

/** Statuses grouped by the stage they belong to, in lifecycle order. */
const FAILED_STATUSES = new Set(["errored", "failed", "unreachable", "policy_hard_failed"]);
const STOPPED_STATUSES = new Set(["canceled", "force_canceled", "discarded"]);
const TERMINAL_STAGE_OF_STATUS: Readonly<Record<string, typeof STAGE_ORDER[number]>> = {
  // A hard policy failure is the only terminal status that carries its own
  // stage; the other terminal outcomes need timestamps to locate the stop.
  policy_hard_failed: "policy",
};

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
  options: Readonly<{
    planOnly: boolean;
    hasPolicyChecks: boolean;
    executionMode?: string | null | undefined;
    positionInQueue?: number | null | undefined;
    scheduledAt?: string | null | undefined;
    waitingReason?: string | null | undefined;
  }>,
): readonly Stage[] {
  const display: RunDisplay = resolveRunDisplay({
    status,
    "status-timestamps": timestamps,
    "execution-mode": options.executionMode,
    "plan-only": options.planOnly,
    "position-in-queue": options.positionInQueue,
    "scheduled-at": options.scheduledAt,
    "waiting-reason": options.waitingReason,
  });
  // The reader-facing model calls this phase "Checks" while the strip keeps
  // its historical internal id, "policy". Keep the mapping at this boundary
  // so waits still land on the visible checks stage.
  const displayStage: typeof STAGE_ORDER[number] = display.stage === "checks" ? "policy" : display.stage;
  const reached = (key: string): boolean => typeof timestamps[key] === "string";
  const planReached = reached("planning-at") || reached("pre-plan-running-at");
  const planDone = reached("planned-at") || reached("planned-and-finished-at") || reached("planned-and-saved-at");
  const policyReached = reached("policy-checking-at") || reached("cost-estimating-at") || reached("post-plan-running-at");
  const applyReached = reached("confirmed-at") || reached("apply-queued-at") || reached("applying-at");

  const stopped = FAILED_STATUSES.has(status) || STOPPED_STATUSES.has(status);
  const failed = FAILED_STATUSES.has(status);
  // The display model knows that a finished plan waits in the apply decision
  // for ordinary runs. Terminal statuses use timestamps below instead.
  const currentStage = stopped ? TERMINAL_STAGE_OF_STATUS[status] : displayStage;

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
    // Approval, policy review, scheduled start and queue capacity are waits,
    // not activity. A separate state keeps the strip from animating a spinner
    // while a person or an external worker is the next actor.
    if (stageDone[id]) return "done";
    if (display.waitingReason !== null && id === displayStage && id === currentStage) return "waiting";
    if (id === currentStage) return "active";
    return index < currentIndex ? "done" : "pending";
  };

  const timeFor = (id: typeof STAGE_ORDER[number]): Readonly<{ startedAt: string | null; finishedAt: string | null }> => {
    const startedAt = id === "queue"
      ? timestamps["pending-at"]
      : id === "plan"
        ? timestamps["pre-plan-running-at"] ?? timestamps["planning-at"]
        : id === "policy"
          ? timestamps["cost-estimating-at"] ?? timestamps["policy-checking-at"]
          : timestamps["confirmed-at"] ?? timestamps["applying-at"];
    const finishedAt = id === "queue"
      ? timestamps["pre-plan-running-at"] ?? timestamps["planning-at"]
      : id === "plan"
        ? timestamps["cost-estimating-at"] ?? timestamps["policy-checking-at"] ?? timestamps["planned-at"] ?? timestamps["planned-and-finished-at"] ?? timestamps["planned-and-saved-at"]
        : id === "policy"
          ? timestamps["confirmed-at"] ?? timestamps["apply-queued-at"] ?? timestamps["applying-at"] ?? timestamps["policy-checked-at"] ?? timestamps["post-plan-completed-at"]
          : timestamps["applied-at"] ?? timestamps["errored-at"] ?? timestamps["unreachable-at"] ?? timestamps["canceled-at"] ?? timestamps["force-canceled-at"];
    return { startedAt: startedAt ?? null, finishedAt: finishedAt ?? null };
  };
  const durationFor = (startedAt: string | null, finishedAt: string | null, state: StageState): string | null => {
    if (startedAt === null) return null;
    const start = Date.parse(startedAt);
    const end = finishedAt === null && state === "active" ? Date.now() : finishedAt === null ? null : Date.parse(finishedAt);
    if (!Number.isFinite(start) || end === null || !Number.isFinite(end) || end < start) return null;
    const minutes = Math.floor((end - start) / 60_000);
    if (minutes < 1) return "Less than a minute";
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return `${hours} hour${hours === 1 ? "" : "s"}${remainder === 0 ? "" : ` ${remainder} min`}`;
  };

  return STAGE_ORDER
    // The policy stage is noise on an instance with no policies configured and
    // no cost estimation: it would sit permanently grey between two real
    // stages. Show it only once something has actually run there.
    .filter((id: typeof STAGE_ORDER[number]): boolean =>
      id !== "policy" || options.hasPolicyChecks || policyReached || currentStage === "policy")
    .filter((id: typeof STAGE_ORDER[number]): boolean =>
      id !== "apply" || !options.planOnly)
    .map((id: typeof STAGE_ORDER[number]): Stage => {
      const state = stateFor(id);
      const times = timeFor(id);
      return {
        id,
        label: STAGE_LABELS[id],
        state,
        ...times,
        durationLabel: durationFor(times.startedAt, times.finishedAt, state),
        waitingReason: display.waitingReason !== null && displayStage === id ? display.waitingLabel : null,
      };
    });
}

function StageIcon({ state }: Readonly<{ state: StageState }>): React.JSX.Element {
  const base = "size-4 shrink-0";
  if (state === "done") return <Check className={cn(base, "text-success")} aria-hidden="true" />;
  if (state === "active") return <CircleDot className={cn(base, "text-primary")} aria-hidden="true" />;
  if (state === "waiting") return <PauseCircle className={cn(base, "text-warning")} aria-hidden="true" />;
  if (state === "failed") return <X className={cn(base, "text-destructive")} aria-hidden="true" />;
  if (state === "skipped" || state === "stopped") return <Minus className={cn(base, "text-muted-foreground/50")} aria-hidden="true" />;
  return <Circle className={cn(base, "text-muted-foreground/40")} aria-hidden="true" />;
}

const STAGE_TEXT: Readonly<Record<StageState, string>> = {
  done: "text-foreground",
  active: "font-medium text-primary",
  waiting: "font-medium text-warning",
  failed: "font-medium text-destructive",
  stopped: "text-muted-foreground",
  skipped: "text-muted-foreground/60 line-through decoration-muted-foreground/40",
  pending: "text-muted-foreground/70",
};

const STAGE_STATE_WORDS: Readonly<Record<StageState, string>> = {
  done: "complete",
  active: "in progress",
  waiting: "waiting",
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
        <li key={stage.id} aria-current={stage.state === "active" || stage.state === "waiting" ? "step" : undefined}
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
            {stage.durationLabel !== null && <span className="hidden text-xs text-muted-foreground sm:block">Duration · {stage.durationLabel}</span>}
            {stage.waitingReason !== null && <span className="block text-xs text-warning sm:max-w-44">{stage.waitingReason}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
