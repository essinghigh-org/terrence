import { formatRelativeTime } from "@/lib/utils";
import { safeHttpUrl } from "@/lib/safe-url";
import type { PlanOutputSummary } from "../components/PlanOutput";
import { resolvePhaseStatus, resolveRunDisplay } from "./run-status";
import {
  TERMINAL_STATUSES,
  type AuxKind,
  type CostEstimate,
  type PhaseResource,
  type PolicyCheck,
  type RunAttributes,
  type RunResource,
} from "./run-view-state";
import { isNumber, isString } from "./type-guards";
import {
  formatDuration,
  formatDurationMilliseconds,
  isAdvisoryPolicyIssue,
  runExecutionDurationMilliseconds,
} from "./run-detail-format";

/** Raw timestamp map for a run; missing maps behave as empty. */
export function resolveRunTimestamps(attributes: RunAttributes | undefined): Readonly<Record<string, string>> {
  return attributes?.["status-timestamps"] ?? {};
}

export function resolveWorkspaceId(run: RunResource | null): string {
  if (run === null) return "";
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
  return (run.relationships as { workspace?: { data?: { id?: string } } } | undefined)
    ?.workspace?.data?.id ?? "";
}

export function resolveRunPermissions(
  attributes: RunAttributes,
  fresh: boolean,
): Readonly<{ canApply: boolean; canComment: boolean }> {
  const actions = attributes.actions;
  const permissions = attributes.permissions;
  return {
    canApply: fresh
      && actions?.["is-confirmable"] === true
      && permissions?.["can-apply"] === true,
    canComment: fresh && permissions?.["can-comment"] === true,
  };
}

export type RerunModel = Readonly<{
  runInFlight: boolean;
  canRerun: boolean;
  rerunBlockedReason: string | null;
}>;

export function resolveRerunModel(args: Readonly<{
  workspaceId: string;
  status: string;
  attributes: RunAttributes;
}>): RerunModel {
  const { workspaceId, status, attributes } = args;
  // Statuses where a run is actively heading toward apply; re-running another
  // run from this page while one is in flight would queue a duplicate.
  const runInFlight = [
    "pending", "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed",
    "queuing", "plan_queued", "planning", "cost_estimating", "cost_estimated",
    "policy_checking", "policy_override", "policy_checked", "post_plan_running",
    "post_plan_completed", "confirmed", "apply_queued", "applying",
  ].includes(status);
  const canRerun = workspaceId !== ""
    && !runInFlight
    && attributes["is-destroy"] !== true
    && attributes["workspace-locked"] !== true;
  // Rerun hides entirely when it cannot work (issue #630); otherwise name
  // the blocker on a disabled button instead of leaving no path visible.
  const rerunBlockedReason = canRerun || workspaceId === ""
    ? null
    : runInFlight
      ? "A run is already in flight for this workspace."
      : attributes["is-destroy"] === true
        ? "Rerun is unavailable for destroy runs."
        : "The workspace is locked.";
  return { runInFlight, canRerun, rerunBlockedReason };
}

export function resolvePhaseStatuses(args: Readonly<{
  status: string;
  timestamps: Readonly<Record<string, string>>;
  plan: PhaseResource | null;
  apply: PhaseResource | null;
}>): Readonly<{ planStatus: string; applyStatus: string }> {
  return {
    planStatus: resolvePhaseStatus(args.status, "plan", args.timestamps, args.plan?.attributes.status),
    applyStatus: resolvePhaseStatus(args.status, "apply", args.timestamps, args.apply?.attributes.status),
  };
};

/**
 * Phase statuses before the run row has loaded. Falls back to "" so hooks
 * that depend on the statuses keep a stable call order across loading
 * states; the loading returns discard the preview before it can render.
 */
export function resolveRunPhasePreview(
  run: RunResource | null,
  plan: PhaseResource | null,
  apply: PhaseResource | null,
): Readonly<{ planStatus: string; applyStatus: string }> {
  return resolvePhaseStatuses({
    status: run?.attributes.status ?? "",
    timestamps: resolveRunTimestamps(run?.attributes),
    plan,
    apply,
  });
}

export type PlanCountSource = Readonly<{
  "resource-additions"?: number | null | undefined;
  "resource-changes"?: number | null | undefined;
  "resource-destructions"?: number | null | undefined;
  "resource-imports"?: number | null | undefined;
}>;

export type PlanCountsModel = Readonly<{
  planCounts: PlanCountSource;
  planImportCount: number | null;
  planActionCount: number | null;
}>;

export function resolvePlanCounts(args: Readonly<{
  plan: PhaseResource | null;
  attributes: RunAttributes;
  planSummary: Readonly<{ runId: string; summary: PlanOutputSummary }> | null;
  runId: string;
}>): PlanCountsModel {
  const planCounts = args.plan?.attributes ?? {
    "resource-additions": args.attributes["resource-additions"],
    "resource-changes": args.attributes["resource-changes"],
    "resource-destructions": args.attributes["resource-destructions"],
    "resource-imports": args.attributes["resource-imports"],
  };
  const backendPlanImportCount = planCounts["resource-imports"];
  const artifactImportCount = args.planSummary?.runId === args.runId ? args.planSummary.summary.importCount : null;
  const planImportCount = isNumber(backendPlanImportCount)
    ? isNumber(artifactImportCount)
      ? Math.max(backendPlanImportCount, artifactImportCount)
      : backendPlanImportCount
    : artifactImportCount;
  const planActionCount = args.planSummary?.runId === args.runId ? args.planSummary.summary.actionCount : null;
  return { planCounts, planImportCount, planActionCount };
}

export function resolvePhaseAutoOpen(args: Readonly<{
  planStatus: string;
  applyStatus: string;
}>): Readonly<{ autoPlanOpen: boolean; autoApplyOpen: boolean }> {
  // Surface the apply output once it starts, preserving explicit disclosure choices.
  const autoApplyOpen = ["running", "finished", "errored", "unreachable"].includes(args.applyStatus);
  const autoPlanOpen = !autoApplyOpen && ["running", "finished", "errored", "unreachable"].includes(args.planStatus);
  return { autoPlanOpen, autoApplyOpen };
}

export type PhaseCompletion = Readonly<{
  started: string | undefined;
  completed: string | undefined;
  completedLabel: string;
  hasLogUrl: boolean;
  phaseDurationLabel: string | null;
}>;

function resolvePhaseCompletedTimestamp(args: Readonly<{
  phase: "plan" | "apply";
  status: string;
  timestamps: Readonly<Record<string, string>>;
}>): string | undefined {
  // A phase that never started has no completion, even when the run row
  // carries terminal timestamps from another phase's failure.
  if (args.status === "running" || args.status === "pending" || args.status === "queued") return undefined;
  const phaseEnd = args.phase === "plan"
    ? args.timestamps["planned-at"]
      ?? args.timestamps["planned-and-finished-at"]
      ?? args.timestamps["planned-and-saved-at"]
    : args.timestamps["applied-at"];
  return phaseEnd
    ?? args.timestamps["errored-at"]
    ?? args.timestamps["unreachable-at"]
    ?? args.timestamps["canceled-at"]
    ?? args.timestamps["force-canceled-at"];
}

export function resolvePhaseCompletion(args: Readonly<{
  phase: "plan" | "apply";
  status: string;
  timestamps: Readonly<Record<string, string>>;
  logUrl: string | null | undefined;
}>): PhaseCompletion {
  const started = args.timestamps[args.phase === "plan" ? "planning-at" : "applying-at"];
  const completed = resolvePhaseCompletedTimestamp(args);
  const completedLabel = ["errored", "unreachable"].includes(args.status)
    ? "Errored"
    : args.status === "canceled"
      ? "Canceled"
      : "Finished";
  const hasLogUrl = !["pending", "queued"].includes(args.status) && safeHttpUrl(args.logUrl) !== null;
  const phaseDurationLabel = started !== undefined && completed !== undefined
    ? formatDuration(started, completed)
    : null;
  return { started, completed, completedLabel, hasLogUrl, phaseDurationLabel };
}

export type DurationModel = Readonly<{
  duration: string;
  durationLabel: string;
  planRawLogMessage: string;
  applyRawLogMessage: string;
}>;

export function resolveDurationModel(args: Readonly<{
  timestamps: Readonly<Record<string, string>>;
  planOnly: boolean;
  planStatus: string;
  applyStatus: string;
}>): DurationModel {
  const durationMilliseconds = runExecutionDurationMilliseconds(args.timestamps, args.planOnly);
  const duration = durationMilliseconds === undefined
    ? args.planStatus === "finished" ? "Unavailable" : "In progress"
    : formatDurationMilliseconds(durationMilliseconds);
  const durationLabel = args.planOnly ? "Plan duration" : "Plan & apply duration";
  // When a phase completed but left no captured raw log (e.g. structured JSON
  // output exists), don't claim the phase never produced output.
  const planRawLogMessage = args.planStatus === "finished"
    ? "No raw plan log was captured for this run (structured output is shown above)."
    : "Plan output is not available yet.";
  const applyRawLogMessage = args.applyStatus === "finished"
    ? "No raw apply log was captured for this run."
    : "Apply output is not available yet.";
  return { duration, durationLabel, planRawLogMessage, applyRawLogMessage };
}

export type CostResourceChange = Readonly<{
  module?: string | null;
  address?: string;
  "delta-monthly-cost"?: string | null;
}>;

export type CostModel = Readonly<{
  costStatus: string;
  costPending: boolean;
  costFailed: boolean;
  costUnavailable: boolean;
  showCostEstimate: boolean;
  costAttributes: CostEstimate["attributes"] | undefined;
  costProvenance: CostEstimate["attributes"]["provenance"];
  costComparison: CostEstimate["attributes"]["comparison"];
  costCurrency: string;
  costTimeBasis: string;
  costBaselineComparable: boolean;
  costWarnings: readonly string[];
  largestCostIncreases: readonly CostResourceChange[];
}>;

const EMPTY_COST_MODEL: CostModel = {
  costStatus: "unavailable",
  costPending: false,
  costFailed: false,
  costUnavailable: true,
  showCostEstimate: false,
  costAttributes: undefined,
  costProvenance: undefined,
  costComparison: undefined,
  costCurrency: "USD",
  costTimeBasis: "monthly",
  costBaselineComparable: false,
  costWarnings: [],
  largestCostIncreases: [],
};

export function resolveCostModel(costEstimate: CostEstimate | null): CostModel {
  if (costEstimate === null) return EMPTY_COST_MODEL;
  return resolvePresentCostModel(costEstimate.attributes);
}

function resolvePresentCostModel(costAttributes: CostEstimate["attributes"]): CostModel {
  const costStatus = costAttributes.status;
  const costPending = ["queued", "pending"].includes(costStatus);
  const costFailed = ["errored", "canceled"].includes(costStatus);
  // Issue #605: an "unavailable" artifact means estimation is not installed
  // in this image (permanent, not a transient failure). Show the section
  // with a one-line explanation instead of hiding it like a missing estimate.
  const costUnavailable = costStatus === "unavailable";
  const showCostEstimate = costAttributes["terrence:infracost-enabled"] !== false
    && !["skipped", "skipped_due_to_targeting", "disabled"].includes(costStatus);
  const costProvenance = costAttributes.provenance;
  const costComparison = costAttributes.comparison;
  const costCurrency = costProvenance?.currency ?? "USD";
  const costTimeBasis = costProvenance?.["time-basis"] ?? "monthly";
  const costBaselineComparable = costComparison?.baseline?.comparable !== false;
  const costWarnings = costComparison?.warnings?.filter((warning): warning is string => isString(warning)) ?? [];
  const costChanges = costComparison?.["resource-changes"] ?? [];
  const largestCostIncreases = costChanges
    .filter((change): boolean => {
      const delta = change["delta-monthly-cost"];
      return (change.action === "added" || change.action === "changed")
        && delta !== null
        && delta !== undefined
        && Number.isFinite(Number(delta))
        && Number(delta) > 0;
    })
    .slice(0, 5);
  return {
    costStatus,
    costPending,
    costFailed,
    costUnavailable,
    showCostEstimate,
    costAttributes,
    costProvenance,
    costComparison,
    costCurrency,
    costTimeBasis,
    costBaselineComparable,
    costWarnings,
    largestCostIncreases,
  };
}

export type PolicyModel = Readonly<{
  hasSoftFailedPolicy: boolean;
  hasHardFailedPolicy: boolean;
  hasFailedPolicy: boolean;
  advisoryIssues: readonly PolicyCheck[];
  policySummary: string;
  showPolicyChecks: boolean;
}>;

export function resolvePolicyModel(policyChecks: readonly PolicyCheck[], status: string): PolicyModel {
  const hasSoftFailedPolicy = status === "policy_soft_failed"
    || policyChecks.some((check: PolicyCheck): boolean => check.attributes.status === "soft_failed");
  const hasHardFailedPolicy = policyChecks.some((check: PolicyCheck): boolean =>
    ["failed", "hard_failed", "errored", "unreachable"].includes(check.attributes.status)
      && !isAdvisoryPolicyIssue(check),
  );
  const hasFailedPolicy = policyChecks.some((check: PolicyCheck): boolean =>
    ["failed", "soft_failed", "hard_failed", "errored", "unreachable"].includes(check.attributes.status)
      && !isAdvisoryPolicyIssue(check),
  );
  const advisoryIssues = policyChecks.filter(isAdvisoryPolicyIssue);
  const policySummary = policyChecks.length === 0
    ? status === "policy_checking" ? "checking" : "not required"
    : hasHardFailedPolicy ? "failed"
    : hasSoftFailedPolicy ? "soft failed"
    : status === "policy_checking"
      || policyChecks.some((check: PolicyCheck): boolean =>
        ["pending", "queued", "running"].includes(check.attributes.status),
      ) ? "checking"
    : policyChecks.every((check: PolicyCheck): boolean => check.attributes.status === "overridden")
      ? "overridden"
      : advisoryIssues.length > 0
        ? `passed · ${advisoryIssues.length} advisory ${
            advisoryIssues.every((check): boolean => check.attributes.status === "failed")
              ? "failed"
              : advisoryIssues.length === 1 ? "issue" : "issues"
          }`
        : "passed";
  const showPolicyChecks = policyChecks.length > 0 || [
    "policy_checking",
    "policy_override",
    "policy_checked",
    "policy_soft_failed",
  ].includes(status);
  return {
    hasSoftFailedPolicy,
    hasHardFailedPolicy,
    hasFailedPolicy,
    advisoryIssues,
    policySummary,
    showPolicyChecks,
  };
}

export type ApplyModel = Readonly<{
  applyStarted: boolean;
  terminatedBeforeApply: boolean;
  showApply: boolean;
  applyWaitingReason: string | null;
}>;

export function resolveApplyModel(args: Readonly<{
  planOnly: boolean;
  status: string;
  applyStatus: string;
  timestamps: Readonly<Record<string, string>>;
  canApply: boolean;
}>): ApplyModel {
  const applyStarted = ["confirmed-at", "apply-queued-at", "applying-at", "applied-at"]
    .some((key: string): boolean => isString(args.timestamps[key]));
  const terminatedBeforeApply = [
    "canceled",
    "discarded",
    "errored",
    "failed",
    "force_canceled",
    "unreachable",
  ].includes(args.status) && !applyStarted;
  const showApply = !args.planOnly
    && args.status !== "planned_and_finished"
    && !terminatedBeforeApply;
  // Why the apply has not started, said once, in the apply section. The
  // reasons the *user* can act on live in the decision panel; this is the
  // descriptive counterpart for the phase that has not begun.
  const applyWaitingReason = showApply
    && !args.canApply
    && args.applyStatus === "pending"
    && !applyStarted
    && !TERMINAL_STATUSES.has(args.status)
    && ["policy_checking", "policy_checked", "post_plan_running", "post_plan_completed", "queuing", "plan_queued", "planning", "pending", "fetching", "pre_plan_running"].includes(args.status)
    ? "The plan and its checks have to finish before anything can be applied."
    : null;
  return { applyStarted, terminatedBeforeApply, showApply, applyWaitingReason };
}

export type FreshnessModel = Readonly<{
  savedPlanVersion: string | null;
  stalePlanWarning: string | null;
}>;

export function resolveFreshnessModel(args: Readonly<{
  timestamps: Readonly<Record<string, string>>;
  plan: PhaseResource | null;
  fresh: boolean;
  failedSections: readonly AuxKind[];
}>): FreshnessModel {
  const savedPlanVersion = isString(args.timestamps["saved-plan-sha256"]) ? args.timestamps["saved-plan-sha256"] : null;
  const artifactTimestamps = args.plan?.attributes["status-timestamps"];
  const rawArtifactVersion = artifactTimestamps?.["saved-plan-sha256"];
  const artifactPlanVersion = isString(rawArtifactVersion) ? rawArtifactVersion : null;
  const stalePlanWarning = savedPlanVersion !== null && artifactPlanVersion !== null && savedPlanVersion !== artifactPlanVersion
    ? "The run metadata and plan artifact use different versions. Refresh before making a decision."
    : !args.fresh
      ? "Run data may be out of date. Refresh before making a decision."
      : args.failedSections.includes("plan")
        ? "The plan could not be refreshed. Refresh before making a decision."
        : null;
  return { savedPlanVersion, stalePlanWarning };
}

export type DecisionContext = Readonly<{
  planId?: string;
  planVersion?: string | null;
  additions?: number | null | undefined;
  changes?: number | null | undefined;
  destructions?: number | null | undefined;
  age?: string | null;
  actor?: string | null;
  policyOutcome?: string | null;
  taskOutcome?: string | null;
  waitingReason?: string | null;
  responsible?: string | null;
  staleWarning?: string | null | undefined;
}>;

export function resolveDecisionContext(args: Readonly<{
  runId: string;
  savedPlanVersion: string | null;
  planCounts: PlanCountSource;
  createdAt: string | undefined;
  creatorUsername: string;
  triggeredBy: string | null | undefined;
  policySummary: string;
  taskOutcome: string;
  staleWarning: string | null;
  attributes: RunAttributes;
  status: string;
  timestamps: Readonly<Record<string, string>>;
}>): DecisionContext {
  const runDisplay = resolveRunDisplay({
    ...args.attributes,
    status: args.status,
    "status-timestamps": args.timestamps,
  });
  return {
    planId: `plan-${args.runId}`,
    planVersion: args.savedPlanVersion,
    additions: args.planCounts["resource-additions"],
    changes: args.planCounts["resource-changes"],
    destructions: args.planCounts["resource-destructions"],
    age: formatRelativeTime(args.createdAt),
    actor: args.creatorUsername !== "" ? args.creatorUsername : args.triggeredBy ?? "System",
    // The badge and policy section already show the raw summary. Prefixing it
    // in the rail keeps the compact context useful without creating a second
    // indistinguishable status announcement for screen readers or tests.
    policyOutcome: args.policySummary === "not required" ? "Not required" : `Result: ${args.policySummary}`,
    taskOutcome: args.taskOutcome,
    waitingReason: runDisplay.waitingLabel,
    responsible: runDisplay.responsible,
    staleWarning: args.staleWarning,
  };
}

export type SummaryCountsModel = Readonly<{
  summaryCounts: PlanCountSource;
  summaryImportCount: number | null;
}>;

export function resolveSummaryCounts(args: Readonly<{
  applyStatus: string;
  apply: PhaseResource | null;
  planCounts: PlanCountSource;
  planImportCount: number | null;
}>): SummaryCountsModel {
  const applyCounts = args.apply?.attributes;
  const summaryCounts = args.applyStatus === "finished" ? (applyCounts ?? {}) : args.planCounts;
  const summaryImportCount = args.applyStatus === "finished"
    ? applyCounts?.["resource-imports"] ?? args.planImportCount
    : args.planImportCount;
  return { summaryCounts, summaryImportCount };
}
