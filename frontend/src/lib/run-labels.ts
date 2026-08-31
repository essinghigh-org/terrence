const RUN_STATUS_LABELS = {
  pending: "Pending",
  fetching: "Fetching configuration",
  fetching_completed: "Configuration fetched",
  pre_plan_running: "Running pre-plan tasks",
  pre_plan_completed: "Pre-plan tasks completed",
  queuing: "Queuing plan",
  plan_queued: "Plan queued",
  planning: "Planning",
  planned: "Needs confirmation",
  needs_confirmation: "Needs confirmation",
  cost_estimating: "Estimating cost",
  cost_estimated: "Cost estimated",
  policy_checking: "Checking policies",
  policy_override: "Policy override required",
  policy_checked: "Policy checks passed",
  policy_soft_failed: "Policy override required",
  post_plan_running: "Running post-plan tasks",
  post_plan_completed: "Post-plan tasks completed",
  planned_and_finished: "Planned and finished",
  planned_and_saved: "Plan saved",
  confirmed: "Confirmed",
  apply_queued: "Apply queued",
  applying: "Applying",
  applied: "Applied",
  errored: "Errored",
  failed: "Failed",
  canceled: "Canceled",
  discarded: "Discarded",
  force_canceled: "Force canceled",
  unreachable: "Unreachable",
  manual: "Manual",
  pull_request: "Pull request",
  push: "Push",
  tag: "Tag",
} as const;

const RUN_SOURCE_LABELS = {
  bitbucket: "Bitbucket",
  github: "GitHub",
  gitlab: "GitLab",
  "tfe-api": "API",
  "tfe-cli": "CLI",
  "tfe-configuration-version": "VCS",
  "tfe-no-code": "No-code module",
  "tfe-ui": "UI",
} as const;

const VCS_SOURCES = new Set(["bitbucket", "github", "gitlab"]);
const VCS_TRIGGER_REASONS = new Set(["vcs", "push", "pull_request", "tag"]);

export function formatRunStatus(status: string): string {
  const label = Object.prototype.hasOwnProperty.call(RUN_STATUS_LABELS, status)
    ? RUN_STATUS_LABELS[status as keyof typeof RUN_STATUS_LABELS]
    : undefined;
  return label ?? status.replace(/_/g, " ");
}

export function isVcsRunSource(source: string | undefined, triggerReason?: string): boolean {
  return (source !== undefined && VCS_SOURCES.has(source))
    || (source === "tfe-configuration-version" && VCS_TRIGGER_REASONS.has(triggerReason ?? ""));
}

export function formatRunSource(source: string | undefined, triggerReason?: string): string {
  if (source === undefined || source === "") return "Unknown source";
  if (isVcsRunSource(source, triggerReason) && source === "tfe-configuration-version") return "GitHub";
  const label = Object.prototype.hasOwnProperty.call(RUN_SOURCE_LABELS, source)
    ? RUN_SOURCE_LABELS[source as keyof typeof RUN_SOURCE_LABELS]
    : undefined;
  return label ?? formatRunStatus(source);
}
