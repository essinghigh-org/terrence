import { isString } from "./type-guards";

/**
 * Reader-facing run model. The API status is intentionally kept as input only:
 * a status describes a transition, while these fields describe what an
 * operator can do about the run right now.
 */
export type RunStageId = "queue" | "plan" | "checks" | "apply";
export type RunOutcome = "queued" | "running" | "waiting" | "succeeded" | "failed" | "canceled" | "discarded";
export type RunWaitingReason = "workspace-queue" | "agent-capacity" | "scheduled-start" | "human-approval" | "policy-override";

export type RunDisplayInput = Readonly<{
  status: string;
  "status-timestamps"?: Readonly<Record<string, string>> | null;
  "execution-mode"?: string | null | undefined;
  "plan-only"?: boolean | null | undefined;
  "position-in-queue"?: number | null | undefined;
  "scheduled-at"?: string | null | undefined;
  "waiting-reason"?: string | null | undefined;
}>;

export type RunDisplay = Readonly<{
  stage: RunStageId;
  stageLabel: string;
  outcome: RunOutcome;
  outcomeLabel: string;
  waitingReason: RunWaitingReason | null;
  waitingLabel: string | null;
  responsible: string;
  startedAt: string | null;
  finishedAt: string | null;
}>;

const STAGE_LABELS: Readonly<Record<RunStageId, string>> = {
  queue: "Queue",
  plan: "Plan",
  checks: "Checks",
  apply: "Apply",
};

const QUEUED_STATUSES = new Set(["pending", "queuing", "plan_queued", "confirmed", "apply_queued"]);
const RUNNING_STATUSES = new Set([
  "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed", "planning",
  "cost_estimating", "cost_estimated", "policy_checking", "policy_checked",
  "post_plan_running", "post_plan_completed", "pre_apply_running", "pre_apply_completed",
  "applying", "post_apply_running", "post_apply_completed",
]);
const HUMAN_WAIT_STATUSES = new Set(["planned", "needs_confirmation", "planned_and_saved"]);
const POLICY_WAIT_STATUSES = new Set(["policy_soft_failed", "policy_override"]);
const SUCCESS_STATUSES = new Set(["applied", "planned_and_finished"]);
const FAILED_STATUSES = new Set(["errored", "failed", "unreachable", "policy_hard_failed"]);
const CANCELED_STATUSES = new Set(["canceled", "force_canceled"]);

function timestampValue(input: RunDisplayInput, key: string): string | null {
  const value = input["status-timestamps"]?.[key] ?? (key === "scheduled-at" ? input["scheduled-at"] : undefined);
  return isString(value) && value !== "" ? value : null;
}

const STAGE_STATUS_GROUPS: readonly Readonly<{ stage: RunStageId; statuses: ReadonlySet<string> }>[] = [
  { stage: "checks", statuses: new Set(["cost_estimating", "cost_estimated", "policy_checking", "policy_override", "policy_soft_failed", "policy_checked", "policy_hard_failed", "post_plan_running", "post_plan_completed"]) },
  { stage: "apply", statuses: new Set(["confirmed", "apply_queued", "pre_apply_running", "pre_apply_completed", "applying", "post_apply_running", "post_apply_completed", "applied"]) },
  { stage: "plan", statuses: new Set(["pre_plan_running", "pre_plan_completed", "planning"]) },
];

function stageForTimestamps(input: RunDisplayInput): RunStageId {
  // Terminal states do not carry a stage of their own. Timestamps preserve the
  // useful answer about where an interrupted run stopped.
  const timestamps = input["status-timestamps"] ?? {};
  if (timestampValue(input, "applied-at") !== null || timestampValue(input, "applying-at") !== null) return "apply";
  if (timestampValue(input, "policy-checking-at") !== null || timestampValue(input, "cost-estimating-at") !== null) return "checks";
  if (timestampValue(input, "planning-at") !== null || timestampValue(input, "planned-at") !== null) return "plan";
  if (Object.keys(timestamps).length > 0) return "plan";
  return "queue";
}

function stageForStatus(input: RunDisplayInput): RunStageId {
  const { status } = input;
  for (const group of STAGE_STATUS_GROUPS) {
    if (group.statuses.has(status)) return group.stage;
  }
  if (["planned", "needs_confirmation", "planned_and_saved"].includes(status)) {
    return input["plan-only"] === true ? "plan" : "apply";
  }
  if (status === "planned_and_finished") return "plan";
  return stageForTimestamps(input);
}

function waitingReasonForExplicitReason(explicit: string | null | undefined): RunWaitingReason | null {
  if (explicit === "workspace" || explicit === "workspace-queue" || explicit === "serialization") return "workspace-queue";
  if (explicit === "agent" || explicit === "agent-capacity" || explicit === "agent_pool") return "agent-capacity";
  if (explicit === "scheduled" || explicit === "scheduled-start") return "scheduled-start";
  if (explicit === "approval" || explicit === "human-approval") return "human-approval";
  if (explicit === "policy" || explicit === "policy-override") return "policy-override";
  return null;
}

function waitingReasonFor(input: RunDisplayInput): RunWaitingReason | null {
  const { status } = input;
  const explicit = waitingReasonForExplicitReason(input["waiting-reason"]);
  if (explicit !== null) return explicit;
  if (POLICY_WAIT_STATUSES.has(status)) return "policy-override";
  if (HUMAN_WAIT_STATUSES.has(status) && input["plan-only"] !== true) return "human-approval";
  if (timestampValue(input, "scheduled-at") !== null && status === "confirmed") return "scheduled-start";
  if (["plan_queued", "apply_queued"].includes(status) && input["execution-mode"] === "agent") return "agent-capacity";
  if (QUEUED_STATUSES.has(status)) return "workspace-queue";
  return null;
}

function responsibleFor(input: RunDisplayInput, waitingReason: RunWaitingReason | null): string {
  if (waitingReason === "human-approval") return "You or an authorized reviewer";
  if (waitingReason === "policy-override") return "A policy reviewer";
  if (waitingReason === "agent-capacity") return "Agent pool";
  if (waitingReason === "scheduled-start") return "Terrence scheduler";
  if (input["execution-mode"] === "local") return "Terraform CLI";
  return "Terrence worker";
}

function outcomeFor(input: RunDisplayInput, waitingReason: RunWaitingReason | null): RunOutcome {
  const { status } = input;
  if (SUCCESS_STATUSES.has(status)) return "succeeded";
  if (status === "discarded") return "discarded";
  if (CANCELED_STATUSES.has(status)) return "canceled";
  if (FAILED_STATUSES.has(status)) return "failed";
  if (input["plan-only"] === true && HUMAN_WAIT_STATUSES.has(status)) return "succeeded";
  if (waitingReason !== null) return "waiting";
  if (RUNNING_STATUSES.has(status)) return "running";
  return QUEUED_STATUSES.has(status) ? "queued" : "running";
}

function outcomeLabelFor(input: RunDisplayInput, outcome: RunOutcome): string {
  const { status } = input;
  if (status === "policy_hard_failed") return "Rejected by policy";
  if (status === "unreachable") return "Worker unavailable";
  if (FAILED_STATUSES.has(status)) return "Execution failed";
  if (status === "discarded") return "Plan discarded";
  if (CANCELED_STATUSES.has(status)) return "Run canceled";
  if (SUCCESS_STATUSES.has(status)) return status === "applied" ? "Applied successfully" : "Plan complete";
  if (HUMAN_WAIT_STATUSES.has(status)) return input["plan-only"] === true ? "Plan complete" : "Awaiting approval";
  if (POLICY_WAIT_STATUSES.has(status)) return "Policy review required";
  if (outcome === "queued") return "Queued";
  if (outcome === "running") return "In progress";
  return "Waiting";
}

function waitingLabelFor(reason: RunWaitingReason | null, input: RunDisplayInput): string | null {
  if (reason === "workspace-queue") {
    const position = input["position-in-queue"];
    return typeof position === "number" && Number.isFinite(position) && position > 0
      ? `Waiting for workspace capacity · position ${position}`
      : "Waiting for workspace capacity";
  }
  if (reason === "agent-capacity") return "Waiting for an available agent";
  if (reason === "scheduled-start") return "Scheduled to start";
  if (reason === "human-approval") return "Needs confirmation";
  if (reason === "policy-override") return "Waiting for a policy decision";
  return null;
}

function startedAtFor(input: RunDisplayInput, stage: RunStageId): string | null {
  if (stage === "queue") return timestampValue(input, "pending-at");
  if (stage === "plan") return timestampValue(input, "pre-plan-running-at") ?? timestampValue(input, "planning-at");
  if (stage === "checks") return timestampValue(input, "cost-estimating-at") ?? timestampValue(input, "policy-checking-at");
  return timestampValue(input, "confirmed-at") ?? timestampValue(input, "applying-at");
}

function finishedAtFor(input: RunDisplayInput, outcome: RunOutcome, stage: RunStageId): string | null {
  if (outcome === "succeeded") {
    return stage === "apply"
      ? timestampValue(input, "applied-at")
      : timestampValue(input, "planned-at") ?? timestampValue(input, "planned-and-finished-at");
  }
  if (outcome === "failed") {
    return timestampValue(input, "errored-at") ?? timestampValue(input, "unreachable-at");
  }
  if (outcome === "canceled") {
    return timestampValue(input, "canceled-at") ?? timestampValue(input, "force-canceled-at");
  }
  return null;
}

/** Resolve every backend lifecycle status into stage, outcome and wait data. */
export function resolveRunDisplay(input: RunDisplayInput): RunDisplay {
  const waitingReason = waitingReasonFor(input);
  const outcome = outcomeFor(input, waitingReason);
  const stage = stageForStatus(input);
  return {
    stage,
    stageLabel: STAGE_LABELS[stage],
    outcome,
    outcomeLabel: outcomeLabelFor(input, outcome),
    waitingReason,
    waitingLabel: waitingLabelFor(waitingReason, input),
    responsible: responsibleFor(input, waitingReason),
    startedAt: startedAtFor(input, stage),
    finishedAt: finishedAtFor(input, outcome, stage),
  };
}

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

function applyPhaseStatus(
  status: string,
  timestamps: Readonly<Record<string, string>>,
  artifactStatus: string | undefined,
  applyStarted: boolean,
): string {
  if (["applied", "post_apply_completed"].includes(status)) return "finished";
  if (["applying", "post_apply_running"].includes(status)) return "running";
  if (["confirmed", "apply_queued", "pre_apply_running", "pre_apply_completed"].includes(status)) return "queued";
  if (artifactStatus === "finished" || isString(timestamps["applied-at"])) return "finished";
  if (["errored", "failed", "unreachable"].includes(status)) return applyStarted ? "errored" : artifactStatus ?? "pending";
  if (["canceled", "discarded", "force_canceled"].includes(status)) return applyStarted ? "canceled" : "pending";
  return artifactStatus ?? "pending";
}

function planPhaseStatus(
  status: string,
  planStarted: boolean,
  planFinished: boolean,
  artifactStatus: string | undefined,
): string {
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
    return applyPhaseStatus(status, timestamps, artifactStatus, applyStarted);
  }
  return planPhaseStatus(status, planStarted, planFinished, artifactStatus);
}
