import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  History,
  Link2,
  MessageSquare,
  XCircle,
} from "lucide-react";
import { PlanOutput, type PlanOutputSummary } from "../components/PlanOutput";
import { formatDateTime } from "@/lib/utils";
import { ApplyOutput } from "../components/ApplyOutput";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { toast } from "../components/ui/toast";
import { ApiError, fetchApi } from "../lib/api";

type RunActions = {
  "is-cancelable"?: boolean;
  "is-confirmable"?: boolean;
  "is-discardable"?: boolean;
  "is-force-cancelable"?: boolean;
};

type ConfirmationAction = "apply" | "discard";

type RunPermissions = {
  "can-apply"?: boolean;
  "can-cancel"?: boolean;
  "can-comment"?: boolean;
  "can-discard"?: boolean;
  "can-force-cancel"?: boolean;
  "can-override-policy-check"?: boolean;
};

type RunAttributes = {
  actions?: RunActions;
  "allow-empty-apply"?: boolean;
  "auto-apply"?: boolean;
  "branch"?: string | null;
  "commit-sha"?: string | null;
  "commit-url"?: string | null;
  "created-at"?: string;
  "has-changes"?: boolean;
  "is-destroy"?: boolean;
  message?: string | null;
  operation?: string;
  permissions?: RunPermissions;
  "plan-only"?: boolean;
  "refresh-only"?: boolean;
  "resource-additions"?: number;
  "resource-changes"?: number;
  "resource-destructions"?: number;
  "resource-imports"?: number;
  source?: string;
  status: string;
  "status-timestamps"?: Record<string, string> | null;
  "terraform-version"?: string | null;
  "trigger-reason"?: string;
  "triggered-by"?: string | null;
  "triggered-by-avatar-url"?: string | null;
};

type RunResource = {
  id: string;
  attributes: RunAttributes;
  relationships?: {
    "created-by"?: {
      data: { id: string; type: string } | null;
    };
  };
};

type PhaseResource = {
  attributes: {
    "log-read-url"?: string | null;
    status: string;
    "resource-additions"?: number | null;
    "resource-changes"?: number | null;
    "resource-destructions"?: number | null;
    "resource-imports"?: number | null;
    "status-timestamps"?: Record<string, string> | null;
  };
};

type LogItem = {
  attributes?: {
    phase?: string;
    "output-text"?: string;
  };
};

type RunComment = {
  id: string;
  attributes: {
    "actor-username"?: string | null;
    "actor-avatar-url"?: string | null;
    body: string;
    "created-at"?: string;
  };
};

type RunEvent = {
  id: string;
  attributes: {
    action: string;
    "actor-username"?: string | null;
    "actor-avatar-url"?: string | null;
    "created-at"?: string;
    details?: {
      fromStatus?: string;
      source?: string;
      toStatus?: string;
      triggerReason?: string;
    };
  };
};

type CostEstimate = {
  id: string;
  attributes: {
    status: string;
    "prior-monthly-cost"?: string;
    "proposed-monthly-cost"?: string;
    "delta-monthly-cost"?: string;
    "resources-count"?: number;
    "matched-resources-count"?: number;
    "unmatched-resources-count"?: number;
    "error-message"?: string | null;
    "infracost-enabled"?: boolean;
  };
};

type IncludedUser = {
  id: string;
  type: string;
  attributes: {
    username: string;
    "avatar-url"?: string;
  };
};

type PolicyCheck = {
  id: string;
  attributes: {
    status: string;
    result?: unknown;
    "policy-name"?: string | null;
    "enforcement-level"?: string | null;
    "created-at"?: string;
  };
};

type AssessmentCheck = {
  id: string;
  attributes: {
    address?: string | null;
    kind?: string | null;
    status: string;
    message?: string | null;
    detail?: unknown;
  };
};

const TERMINAL_STATUSES = new Set([
  "applied",
  "canceled",
  "discarded",
  "errored",
  "failed",
  "force_canceled",
  "planned_and_finished",
  "unreachable",
]);

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  fetching: "Fetching configuration",
  fetching_completed: "Configuration fetched",
  pre_plan_running: "Running pre-plan tasks",
  pre_plan_completed: "Pre-plan tasks completed",
  queuing: "Queuing plan",
  plan_queued: "Plan queued",
  planning: "Planning",
  planned: "Needs confirmation",
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
};

const RUN_EVENT_LABELS: Readonly<Record<string, string>> = {
  apply: "Run confirmed",
  cancel: "Run canceled",
  create: "Run created",
  discard: "Run discarded",
  "force-cancel": "Run force canceled",
  "override-policy": "Policy check overridden",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

function sourceLabel(source: string | undefined): string {
  if (source === undefined || source === "") return "Unknown source";
  const labels: Readonly<Record<string, string>> = {
    bitbucket: "Bitbucket",
    github: "GitHub",
    gitlab: "GitLab",
    "tfe-api": "TFE API",
    "tfe-no-code": "No-code provisioning",
  };
  return labels[source] ?? statusLabel(source);
}

function formatDate(value: string | undefined): string {
  if (value === undefined || value === "") return "—";
  const date = new Date(value);
  return formatDateTime(date);
}

function formatDuration(start: string | undefined, end: string | undefined): string {
  if (start === undefined || end === undefined) return "Unavailable";
  const milliseconds = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "Unavailable";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "Less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${remainder === 0 ? "" : ` ${remainder} min`}`;
}

function formatMonthlyCost(value: string | undefined): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return `${new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)} / month`;
}

function policyResultText(result: unknown): string {
  if (result === null || result === undefined) return "No detailed result";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean" || typeof result === "bigint") return `${result}`;
  if (typeof result !== "object") return "No detailed result";
  const details = result as Record<string, unknown>;
  const summary: string[] = [];
  if (typeof details["policy"] === "string") summary.push(details["policy"]);
  if (typeof details["error"] === "string") summary.push(details["error"]);
  const violations = details["violations"];
  if (Array.isArray(violations)) {
    summary.push(`${violations.length} violation${violations.length === 1 ? "" : "s"}${
      violations.length > 0 ? `: ${violations.map(String).join(", ")}` : ""
    }`);
  }
  for (const [key, label] of [
    ["hard-failed", "hard failure"],
    ["soft-failed", "soft failure"],
    ["advisory-failed", "advisory failure"],
  ] as const) {
    const count = details[key];
    if (typeof count === "number" && count > 0) {
      summary.push(`${count} ${label}${count === 1 ? "" : "s"}`);
    }
  }
  return summary.length > 0 ? summary.join(" — ") : JSON.stringify(result);
}

function isAdvisoryPolicyIssue(check: PolicyCheck): boolean {
  const failureLike = ["failed", "errored", "unreachable"].includes(check.attributes.status);
  if (!failureLike) return false;
  if (check.attributes["enforcement-level"] === "advisory") return true;
  if (check.attributes.status !== "failed") return false;
  const result = check.attributes.result;
  return result !== null
    && typeof result === "object"
    && !Array.isArray(result)
    && typeof (result as Record<string, unknown>)["advisory-failed"] === "number"
    && ((result as Record<string, unknown>)["advisory-failed"] as number) > 0;
}

function phaseStatusFromRun(
  status: string,
  phase: "plan" | "apply",
  timestamps: Readonly<Record<string, string>>,
): string {
  const planStarted = typeof timestamps["planning-at"] === "string";
  const planFinished = typeof timestamps["planned-at"] === "string"
    || typeof timestamps["planned-and-finished-at"] === "string"
    || typeof timestamps["planned-and-saved-at"] === "string";
  const applyStarted = ["confirmed-at", "apply-queued-at", "applying-at", "applied-at"]
    .some((key: string): boolean => typeof timestamps[key] === "string");
  if (phase === "apply") {
    if (status === "applied") return "finished";
    if (status === "applying") return "running";
    if (["confirmed", "apply_queued"].includes(status)) return "queued";
    if (["errored", "failed", "unreachable"].includes(status)) return applyStarted ? "errored" : "pending";
    if (["canceled", "discarded", "force_canceled"].includes(status)) return applyStarted ? "canceled" : "pending";
    return "pending";
  }
  if (status === "planning") return "running";
  if (["queuing", "plan_queued"].includes(status)) return "queued";
  if ([
    "planned",
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
  return "pending";
}

function PhaseIcon({ status }: Readonly<{ status: string }>): React.JSX.Element {
  if (status === "finished") return <CheckCircle2 className="size-5 text-emerald-600" aria-hidden="true" />;
  if (status === "errored" || status === "unreachable") return <XCircle className="size-5 text-red-600" aria-hidden="true" />;
  if (status === "canceled") return <AlertCircle className="size-5 text-gray-500" aria-hidden="true" />;
  if (status === "running") {
    return (
      <span className="relative flex size-5 items-center justify-center">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-400 opacity-75" />
        <Clock className="relative size-4 text-blue-600" aria-hidden="true" />
      </span>
    );
  }
  if (status === "queued") return <Clock className="size-5 text-blue-600" aria-hidden="true" />;
  return <Circle className="size-5 text-gray-300" aria-hidden="true" />;
}

function ResourceCounts({
  additions,
  changes,
  destructions,
  imports,
  status,
}: Readonly<{
  additions: number | null | undefined;
  changes: number | null | undefined;
  destructions: number | null | undefined;
  imports?: number | null;
  status: string;
}>): React.JSX.Element {
  const pending = ["pending", "queued", "running"].includes(status);
  if (pending
    || typeof additions !== "number"
    || typeof changes !== "number"
    || typeof destructions !== "number") {
    return (
      <span className="text-xs font-medium text-gray-500">
        {pending ? "Resources pending" : "Resources unavailable"}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium">
      {typeof imports === "number" && imports > 0 && <span className="text-gray-950">&amp;{imports} to import</span>}
      <span className="text-emerald-700">+{additions} to add</span>
      <span className="text-blue-700">~{changes} to change</span>
      <span className="text-red-700">−{destructions} to destroy</span>
    </div>
  );
}

function PhaseMeta({
  phase,
  status,
  timestamps,
  logUrl,
}: Readonly<{
  phase: "plan" | "apply";
  status: string;
  timestamps: Readonly<Record<string, string>>;
  logUrl: string | null | undefined;
}>): React.JSX.Element {
  const started = timestamps[phase === "plan" ? "planning-at" : "applying-at"];
  const completed = (phase === "plan"
    ? timestamps["planned-at"]
      ?? timestamps["planned-and-finished-at"]
      ?? timestamps["planned-and-saved-at"]
    : timestamps["applied-at"])
    ?? timestamps["errored-at"]
    ?? timestamps["unreachable-at"]
    ?? timestamps["canceled-at"]
    ?? timestamps["force-canceled-at"];
  const completedLabel = ["errored", "unreachable"].includes(status)
    ? "Errored"
    : status === "canceled"
      ? "Canceled"
      : "Finished";
  const hasLogUrl = logUrl !== null && logUrl !== undefined && logUrl !== "";
  if (started === undefined && completed === undefined && !hasLogUrl) return <></>;
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs text-gray-500">
      {started !== undefined && <span>Started <time dateTime={started}>{formatDate(started)}</time></span>}
      {completed !== undefined && (
        <span>{completedLabel} <time dateTime={completed}>{formatDate(completed)}</time></span>
      )}
      {hasLogUrl && (
        <a href={logUrl} download className="font-medium text-blue-700 hover:underline">
          Download raw log
        </a>
      )}
    </div>
  );
}

export function RunDetail({
  showBreadcrumb = true,
}: Readonly<{ readonly showBreadcrumb?: boolean }>): React.JSX.Element {
  const {
    orgName: rawOrgName,
    workspaceName: rawWorkspaceName,
    runId: rawRunId,
  } = useParams<{ orgName: string; workspaceName: string; runId: string }>();
  const orgName = rawOrgName ?? "";
  const workspaceName = rawWorkspaceName ?? "";
  const runId = rawRunId ?? "";
  const orgPath = `/app/${encodeURIComponent(orgName)}`;
  const workspacePath = `${orgPath}/workspaces/${encodeURIComponent(workspaceName)}`;
  const [run, setRun] = useState<RunResource | null>(null);
  const [plan, setPlan] = useState<PhaseResource | null>(null);
  const [apply, setApply] = useState<PhaseResource | null>(null);
  const [planLogs, setPlanLogs] = useState("");
  const [applyLogs, setApplyLogs] = useState("");
  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  const [policyChecks, setPolicyChecks] = useState<PolicyCheck[]>([]);
  const [assessmentChecks, setAssessmentChecks] = useState<AssessmentCheck[]>([]);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [comments, setComments] = useState<RunComment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [confirmationAction, setConfirmationAction] = useState<ConfirmationAction | null>(null);
  const [actionComment, setActionComment] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [auxiliaryError, setAuxiliaryError] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [creatorUsername, setCreatorUsername] = useState("");
  const [creatorAvatarUrl, setCreatorAvatarUrl] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [copiedPermalink, setCopiedPermalink] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [planSummary, setPlanSummary] = useState<Readonly<{
    runId: string;
    summary: PlanOutputSummary;
  }> | null>(null);
  const activeRunId = useRef<string | null>(null);
  const handlePlanSummaryChange = useCallback((summary: PlanOutputSummary | null): void => {
    setPlanSummary(summary === null ? null : { runId, summary });
  }, [runId]);

  const runPermalink = `${window.location.origin}${orgPath}/workspaces/${encodeURIComponent(workspaceName)}/runs/${encodeURIComponent(runId)}`;

  async function copyRunPermalink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(runPermalink);
      setCopiedPermalink(true);
      toast.add({ title: "Run permalink copied", type: "success" });
      window.setTimeout((): void => setCopiedPermalink(false), 2000);
    } catch {
      toast.add({ title: "Could not copy link", type: "error" });
    }
  }

  useEffect((): void => {
    setRunEvents([]);
  }, [runId]);

  const loadRun = useCallback(async (signal: AbortSignal): Promise<string | null> => {
    try {
      const response = await fetchApi(`/api/v2/runs/${runId}`, { signal }) as { data: RunResource; included?: IncludedUser[] };
      if (signal.aborted) return null;
      setRun(response.data);
      setFresh(true);
      setLoadError("");

      // Extract creator user info from included data
      const creatorId = response.data.relationships?.["created-by"]?.data?.id;
      if (creatorId !== undefined && Array.isArray(response.included)) {
        const creator = response.included.find((u: IncludedUser): boolean => u.id === creatorId && u.type === "users");
        if (creator !== undefined) {
          setCreatorUsername(creator.attributes.username);
          setCreatorAvatarUrl(creator.attributes["avatar-url"] ?? "");
        } else {
          setCreatorUsername(response.data.attributes["triggered-by"] ?? "");
          setCreatorAvatarUrl(response.data.attributes["triggered-by-avatar-url"] ?? "");
        }
      } else {
        setCreatorUsername(response.data.attributes["triggered-by"] ?? "");
        setCreatorAvatarUrl(response.data.attributes["triggered-by-avatar-url"] ?? "");
      }

      const [logResult, planResult, applyResult, costResult, policyResult, assessmentResult, eventResult, commentResult] = await Promise.allSettled([
        fetchApi(`/api/v2/runs/${runId}/logs`, { signal }),
        fetchApi(`/api/v2/runs/${runId}/plan`, { signal }),
        fetchApi(`/api/v2/applies/apply-${runId}`, { signal }),
        fetchApi(`/api/v2/runs/${runId}/cost-estimate`, { signal }),
        fetchApi(`/api/v2/runs/${runId}/policy-checks`, { signal }),
        fetchApi(`/api/v2/runs/${runId}/check-results`, { signal }),
        fetchApi(`/api/v2/runs/${runId}/run-events`, { signal }),
        fetchApi(`/api/v2/runs/${runId}/comments`, { signal }),
      ]);
      signal.throwIfAborted();
      setAuxiliaryError([
        logResult,
        planResult,
        applyResult,
        costResult,
        policyResult,
        assessmentResult,
        eventResult,
        commentResult,
      ].some((result): boolean => result.status === "rejected"));

      if (logResult.status === "fulfilled") {
        const logData = logResult.value as {
          data?: LogItem[];
          logs?: { message: string; phase?: string }[];
        };
        if (Array.isArray(logData.data)) {
          setPlanLogs(logData.data
            .filter((entry: LogItem): boolean => (entry.attributes?.phase ?? "plan") === "plan")
            .map((entry: LogItem): string => entry.attributes?.["output-text"] ?? "")
            .join("\n"));
          setApplyLogs(logData.data
            .filter((entry: LogItem): boolean => entry.attributes?.phase === "apply")
            .map((entry: LogItem): string => entry.attributes?.["output-text"] ?? "")
            .join("\n"));
        } else if (Array.isArray(logData.logs)) {
          setPlanLogs(logData.logs
            .filter((entry): boolean => (entry.phase ?? "plan") === "plan")
            .map((entry): string => entry.message)
            .join("\n"));
          setApplyLogs(logData.logs
            .filter((entry): boolean => entry.phase === "apply")
            .map((entry): string => entry.message)
            .join("\n"));
        }
      }
      if (planResult.status === "fulfilled") {
        setPlan((planResult.value as { data?: PhaseResource }).data ?? null);
      }
      if (applyResult.status === "fulfilled") {
        setApply((applyResult.value as { data?: PhaseResource }).data ?? null);
      }
      if (costResult.status === "fulfilled") {
        setCostEstimate((costResult.value as { data?: CostEstimate }).data ?? null);
      }
      if (policyResult.status === "fulfilled") {
        const data = (policyResult.value as { data?: PolicyCheck[] }).data;
        setPolicyChecks(Array.isArray(data) ? data : []);
      }
      if (assessmentResult.status === "fulfilled") {
        const data = (assessmentResult.value as { data?: AssessmentCheck[] }).data;
        setAssessmentChecks(Array.isArray(data) ? data : []);
      }
      if (eventResult.status === "fulfilled") {
        const data = (eventResult.value as { data?: RunEvent[] }).data;
        setRunEvents(Array.isArray(data) ? data : []);
      }
      if (commentResult.status === "fulfilled") {
        const data = (commentResult.value as { data?: RunComment[] }).data;
        setComments(Array.isArray(data) ? data : []);
      }
      return response.data.attributes.status;
    } catch (error: unknown) {
      if (signal.aborted) return null;
      setFresh(false);
      setLoadError(error instanceof Error ? error.message : "Could not load run");
      if (error instanceof ApiError && error.status === 404) {
        setRun(null);
        return "not_found";
      }
      return null;
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [runId]);

  useEffect((): (() => void) => {
    let stopped = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const runChanged = activeRunId.current !== runId;
    activeRunId.current = runId;
    if (runChanged) {
      setRun(null);
      setPlan(null);
      setApply(null);
      setPlanLogs("");
      setApplyLogs("");
      setCostEstimate(null);
      setPolicyChecks([]);
      setAssessmentChecks([]);
      setComments([]);
      setAuxiliaryError(false);
      setCreatorUsername("");
      setCreatorAvatarUrl("");
      setCommentBody("");
      setConfirmationAction(null);
      setActionComment("");
      setLoading(true);
    }
    setLoadError("");
    setFresh(false);

    const refresh = async (): Promise<void> => {
      const status = await loadRun(controller.signal);
      if (!stopped && !controller.signal.aborted && status !== "not_found"
        && (status === null || !TERMINAL_STATUSES.has(status))) {
        timer = window.setTimeout((): void => { void refresh(); }, 3000);
      }
    };
    void refresh();

    return (): void => {
      stopped = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadRun, refreshVersion]);

  async function performRunAction(
    action: "apply" | "cancel" | "discard" | "force-cancel" | "override-policy",
    successTitle: string,
    comment = "",
  ): Promise<boolean> {
    setPendingAction(action);
    try {
      const trimmedComment = comment.trim();
      await fetchApi(`/api/v2/runs/${runId}/actions/${action}`, {
        method: "POST",
        ...(trimmedComment === "" ? {} : {
          body: JSON.stringify({
            data: {
              type: "runs",
              attributes: { comment: trimmedComment },
            },
          }),
        }),
      });
      toast.add({ title: successTitle, type: "success" });
      setRefreshVersion((value: number): number => value + 1);
      return true;
    } catch (error: unknown) {
      toast.add({
        title: error instanceof Error ? error.message : `Failed to ${action.replace("-", " ")} run`,
        type: "error",
      });
      return false;
    } finally {
      setPendingAction("");
    }
  }

  function beginRunConfirmation(action: ConfirmationAction): void {
    setConfirmationAction(action);
    setActionComment("");
  }

  async function confirmRunAction(): Promise<void> {
    if (confirmationAction === null) return;
    const action = confirmationAction;
    const succeeded = await performRunAction(
      action,
      action === "apply" ? "Run queued for apply" : "Run discarded",
      actionComment,
    );
    if (succeeded) {
      setConfirmationAction(null);
      setActionComment("");
    }
  }

  async function handleCommentSubmit(event: React.SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const body = commentBody.trim();
    if (body === "") return;
    setPendingAction("comment");
    try {
      await fetchApi(`/api/v2/runs/${runId}/comments`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "comments",
            attributes: { body },
          },
        }),
      });
      setCommentBody("");
      toast.add({ title: "Comment added", type: "success" });
      setRefreshVersion((value: number): number => value + 1);
    } catch (error: unknown) {
      toast.add({
        title: error instanceof Error ? error.message : "Failed to add comment",
        type: "error",
      });
    } finally {
      setPendingAction("");
    }
  }

  if (run !== null && run.id !== runId) return <div className="p-8 text-gray-500">Loading run...</div>;
  if (loading && run === null) return (
    <div role="status" aria-label="Loading run" className="flex flex-col gap-5">
      <div className="h-3 w-40 animate-pulse rounded bg-muted" />
      <div className="h-10 w-72 animate-pulse rounded bg-muted" />
      <div className="h-28 animate-pulse rounded-md border bg-muted/50" />
      <div className="h-64 animate-pulse rounded-md border bg-muted/50" />
    </div>
  );
  if (run === null) {
    return (
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-5 text-sm text-red-800">
        <p className="font-medium">{loadError !== "" ? loadError : "Run not found"}</p>
        <Button className="mt-3" variant="outline" onClick={(): void => { setRefreshVersion((value): number => value + 1); }}>
          Try again
        </Button>
      </div>
    );
  }

  const attributes = run.attributes;
  const { actions, permissions, status } = attributes;
  const canApply = fresh
    && actions?.["is-confirmable"] === true
    && permissions?.["can-apply"] === true;
  const canDiscard = fresh
    && actions?.["is-discardable"] === true
    && permissions?.["can-discard"] === true;
  const canCancel = fresh
    && actions?.["is-cancelable"] === true
    && permissions?.["can-cancel"] === true;
  const canForceCancel = fresh
    && actions?.["is-force-cancelable"] === true
    && permissions?.["can-force-cancel"] === true;
  const canOverridePolicy = fresh
    && status === "policy_soft_failed"
    && permissions?.["can-override-policy-check"] === true;
  const canComment = fresh && permissions?.["can-comment"] === true;

  const timestamps = attributes["status-timestamps"] ?? {};
  const planStatus = plan?.attributes.status ?? phaseStatusFromRun(status, "plan", timestamps);
  const applyStatus = apply?.attributes.status ?? phaseStatusFromRun(status, "apply", timestamps);
  // Once a run has applied, surface the apply phase as the default-expanded
  // section and collapse the plan (user preference).
  const applied = applyStatus === "finished";
  const planActionCount = planSummary?.runId === runId ? planSummary.summary.actionCount : null;
  const artifactImportCount = planSummary?.runId === runId ? planSummary.summary.importCount : null;
  const planCounts = plan?.attributes ?? {
    "resource-additions": attributes["resource-additions"],
    "resource-changes": attributes["resource-changes"],
    "resource-destructions": attributes["resource-destructions"],
    "resource-imports": attributes["resource-imports"],
  };
  const backendPlanImportCount = planCounts["resource-imports"];
  const planImportCount = typeof backendPlanImportCount === "number"
    ? typeof artifactImportCount === "number"
      ? Math.max(backendPlanImportCount, artifactImportCount)
      : backendPlanImportCount
    : artifactImportCount;
  const applyCounts = apply?.attributes;
  const timestampEntries = Object.entries(timestamps);
  const validTimestampValues = Object.values(timestamps)
    .filter((value: string): boolean => Number.isFinite(Date.parse(value)))
    .sort((left: string, right: string): number => Date.parse(left) - Date.parse(right));
  const durationStart = validTimestampValues[0] ?? attributes["created-at"];
  const durationEnd = TERMINAL_STATUSES.has(status)
    ? validTimestampValues[validTimestampValues.length - 1]
    : undefined;
  const duration = TERMINAL_STATUSES.has(status)
    ? formatDuration(durationStart, durationEnd)
    : planStatus === "finished"
      ? formatDuration(durationStart, validTimestampValues[validTimestampValues.length - 1] ?? durationStart)
      : "In progress";
  // When a phase completed but left no captured raw log (e.g. structured JSON
  // output exists), don't claim the phase never produced output.
  const planRawLogMessage = planStatus === "finished"
    ? "No raw plan log was captured for this run (structured output is shown above)."
    : "Plan output is not available yet.";
  const applyRawLogMessage = applyStatus === "finished"
    ? "No raw apply log was captured for this run."
    : "Apply output is not available yet.";
  const summaryCounts = applyStatus === "finished" ? applyCounts : planCounts;
  const summaryImportCount = applyStatus === "finished"
    ? applyCounts?.["resource-imports"] ?? planImportCount
    : planImportCount;
  const costAttributes = costEstimate?.attributes;
  const costStatus = costAttributes?.status ?? "unavailable";
  const costPending = ["queued", "pending"].includes(costStatus);
  const costFailed = ["errored", "canceled"].includes(costStatus);
  const showCostEstimate = costEstimate !== null
    && costEstimate.attributes["infracost-enabled"] === true
    && !["skipped", "disabled", "unavailable"].includes(costStatus);
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
  const applyStarted = ["confirmed-at", "apply-queued-at", "applying-at", "applied-at"]
    .some((key: string): boolean => typeof timestamps[key] === "string");
  const terminatedBeforeApply = [
    "canceled",
    "discarded",
    "errored",
    "failed",
    "force_canceled",
    "unreachable",
  ].includes(status) && !applyStarted;
  const showApply = attributes["plan-only"] !== true
    && status !== "planned_and_finished"
    && !terminatedBeforeApply;
  const successfulStatus = ["applied", "planned_and_finished"].includes(status);
  const showCombinedEmptyActivity = TERMINAL_STATUSES.has(status)
    && runEvents.length === 0
    && comments.length === 0;

  const commentForm = canComment ? (
    <form onSubmit={(event): void => { void handleCommentSubmit(event); }} className="border-t border-gray-200 p-5">
      <label htmlFor="run-comment" className="mb-2 block text-sm font-medium text-gray-900">Add a comment</label>
      <textarea
        id="run-comment"
        rows={3}
        value={commentBody}
        onChange={(event): void => { setCommentBody(event.target.value); }}
        className="w-full resize-y rounded-md border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
        placeholder="Share context about this run"
      />
      <div className="mt-2 flex justify-end">
        <Button type="submit" disabled={commentBody.trim() === "" || pendingAction !== ""}>Add comment</Button>
      </div>
    </form>
  ) : null;

  return (
    <div className="w-full">
      {showBreadcrumb && <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1.5 text-xs font-medium text-gray-500">
        <Link to={orgPath} className="hover:text-gray-900 hover:underline">{orgName}</Link>
        <span aria-hidden="true" className="text-gray-300">/</span>
        <Link to={workspacePath} className="hover:text-gray-900 hover:underline">
          {workspaceName}
        </Link>
        <span aria-hidden="true" className="text-gray-300">/</span>
        <span className="text-gray-900">Runs</span>
        <span aria-hidden="true" className="text-gray-300">/</span>
        <span className="font-mono text-gray-900">{runId}</span>
      </nav>}

      {!fresh && loadError !== "" && (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>Run data may be out of date. Actions are disabled until it refreshes.</span>
          <Button variant="outline" onClick={(): void => { setRefreshVersion((value): number => value + 1); }}>
            Try again
          </Button>
        </div>
      )}
      {fresh && auxiliaryError && (
        <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>Some run details could not be refreshed.</span>
          <Button variant="outline" onClick={(): void => { setRefreshVersion((value): number => value + 1); }}>
            Try again
          </Button>
        </div>
      )}

      <header className="mb-6 flex flex-col gap-4 border-b border-gray-200 pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge
              variant={["errored", "failed", "unreachable"].includes(status) ? "destructive" : "secondary"}
              className={successfulStatus ? "rounded bg-emerald-100 text-emerald-800" : "rounded"}
            >
              {statusLabel(status)}
            </Badge>
            <span aria-live="polite" className="sr-only">Run status: {statusLabel(status)}</span>
            {attributes["plan-only"] === true && <Badge variant="outline" className="rounded">Plan only</Badge>}
            {attributes["is-destroy"] === true && <Badge variant="destructive" className="rounded">Destroy</Badge>}
            {attributes["refresh-only"] === true && <Badge variant="outline" className="rounded text-purple-700 border-purple-200 bg-purple-50">Refresh only</Badge>}
            {attributes["allow-empty-apply"] === true && <Badge variant="outline" className="rounded text-blue-700 border-blue-200 bg-blue-50">Allow empty apply</Badge>}
          </div>
          <h1 className="break-words text-3xl font-bold tracking-tight text-gray-950">
            {attributes.message ?? "Manual run"}
          </h1>
          <p className="mt-2 text-[13px] text-gray-600">
            {statusLabel(attributes["trigger-reason"] ?? "manual")} · {attributes["trigger-reason"] === "manual" ? "UI" : sourceLabel(attributes.source)} · Created {formatDate(attributes["created-at"])}
          </p>
          {(attributes["trigger-reason"] === "vcs" || attributes.source === "github" || attributes.source === "gitlab" || attributes.source === "bitbucket") && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{typeof attributes.branch === "string" ? attributes.branch : "Default branch"}</span>
              {attributes["commit-sha"] !== undefined && attributes["commit-sha"] !== null && attributes["commit-sha"] !== "" && (
                typeof attributes["commit-url"] === "string" && attributes["commit-url"] !== "" ? (
                  <a
                    href={attributes["commit-url"]}
                    target="_blank"
                    rel="noreferrer"
                    title={attributes["commit-sha"]}
                    className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-primary underline decoration-primary/40 hover:no-underline"
                  >
                    {attributes["commit-sha"].slice(0, 12)}
                    <ArrowUpRight className="size-3" aria-hidden="true" />
                  </a>
                ) : (
                  <code title={attributes["commit-sha"]}>{attributes["commit-sha"].slice(0, 12)}</code>
                )
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            aria-label="Copy run permalink"
            disabled={pendingAction !== ""}
            onClick={(): void => { void copyRunPermalink(); }}
          >
            <Link2 className="size-3.5" aria-hidden="true" />
            {copiedPermalink ? "Copied" : "Copy link"}
          </Button>
          {(canCancel || canForceCancel || canOverridePolicy) && (
            <div aria-label="Run actions" className="flex shrink-0 flex-wrap gap-2">
                {canCancel && (
                  <Button
                    variant="outline"
                    disabled={pendingAction !== ""}
                    onClick={(): void => { void performRunAction("cancel", "Run canceled"); }}
                  >
                    Cancel run
                  </Button>
                )}
                {canForceCancel && (
                  <Button
                    variant="destructive"
                    disabled={pendingAction !== ""}
                    onClick={(): void => { void performRunAction("force-cancel", "Run force canceled"); }}
                  >
                    Force cancel
                  </Button>
                )}
                {canOverridePolicy && (
                  <Button
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                    disabled={pendingAction !== ""}
                    onClick={(): void => { void performRunAction("override-policy", "Policy check overridden"); }}
                  >
                    Override policy
                  </Button>
                )}
              </div>
            )}
          </div>
      </header>

      <dl className="mb-5 grid overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm sm:grid-cols-3">
        <div className="border-b border-gray-200 px-5 py-4 sm:border-b-0 sm:border-r">
          <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            {attributes["plan-only"] === true ? "Plan duration" : "Plan & apply duration"}
          </dt>
          <dd className="mt-1 text-sm font-semibold text-gray-950">{duration}</dd>
        </div>
        <div className="border-b border-gray-200 px-5 py-4 sm:border-b-0 sm:border-r">
          <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">Resources changed</dt>
          <dd className="mt-1">
            <ResourceCounts
              additions={summaryCounts?.["resource-additions"]}
              changes={summaryCounts?.["resource-changes"]}
              destructions={summaryCounts?.["resource-destructions"]}
              imports={summaryImportCount}
              status={applyStatus === "finished" ? applyStatus : planStatus}
            />
          </dd>
        </div>
        <div className="px-5 py-4">
          <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">Actions</dt>
          <dd className="mt-1 text-sm font-semibold text-gray-950">
            {planActionCount === null
              ? "Unavailable"
              : `${planActionCount} ${applyStatus === "finished" ? "invoked" : "to invoke"}`}
          </dd>
        </div>
      </dl>

      <details className="mb-5 overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm">
        <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-gray-950 hover:bg-gray-50">
          Run details
        </summary>
        <dl className="grid gap-4 border-t border-gray-200 px-5 py-4 text-[13px] sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">Status</dt>
            <dd className="mt-1 font-medium text-gray-950">{statusLabel(status)}</dd>
          </div>
          {creatorUsername !== "" && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">Created by</dt>
              <dd className="mt-1 flex items-center gap-2">
                <Avatar className="size-6 rounded-full">
                  {creatorAvatarUrl !== "" ? (
                    <AvatarImage src={creatorAvatarUrl} alt={creatorUsername} className="rounded-full object-cover" />
                  ) : (
                    <AvatarFallback className="rounded-full bg-gray-100 text-[10px] text-gray-600">
                      {creatorUsername.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  )}
                </Avatar>
                <span className="font-medium text-gray-700">{creatorUsername}</span>
              </dd>
            </div>
          )}
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">Workspace</dt>
            <dd className="mt-1">
              <Link to={workspacePath} className="font-medium text-blue-700 hover:underline">
                {workspaceName}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">Operation</dt>
            <dd className="mt-1 capitalize text-gray-900">{statusLabel(attributes.operation ?? "plan_and_apply")}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">Auto apply</dt>
            <dd className="mt-1 text-gray-900">{attributes["auto-apply"] === true ? "Enabled" : "Disabled"}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">Terraform version</dt>
            <dd className="mt-1 text-gray-900">{attributes["terraform-version"] ?? "Workspace default"}</dd>
          </div>
        </dl>
        {timestampEntries.length > 0 && (
          <div className="border-t border-gray-200 px-5 py-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Run timeline</h2>
            <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
              {timestampEntries.map(([key, value]): React.JSX.Element => (
                <div key={key}>
                  <dt className="capitalize text-gray-500">{key.replace(/-at$/, "").replace(/-/g, " ")}</dt>
                  <dd className="mt-0.5 text-gray-900">{formatDate(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </details>

      <div className="min-w-0 space-y-5">
          <details
            aria-labelledby="plan-heading"
            className="group overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm"
            open={!applied && ["running", "finished", "errored", "unreachable"].includes(planStatus)}
          >
            <summary className="cursor-pointer list-none border-b border-gray-200 px-5 py-4 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <ChevronRight className="size-4 text-gray-400 transition-transform group-open:rotate-90" aria-hidden="true" />
                  <PhaseIcon status={planStatus} />
                  <h2 id="plan-heading" className="font-semibold capitalize text-gray-950">
                    Plan {planStatus.replace(/_/g, " ")}
                  </h2>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-4">
                  <PhaseMeta
                    phase="plan"
                    status={planStatus}
                    timestamps={plan?.attributes["status-timestamps"] ?? timestamps}
                    logUrl={plan?.attributes["log-read-url"]}
                  />
                  {applyStatus === "finished" && (
                    <ResourceCounts
                      additions={planCounts["resource-additions"]}
                      changes={planCounts["resource-changes"]}
                      destructions={planCounts["resource-destructions"]}
                      imports={planImportCount}
                      status={planStatus}
                    />
                  )}
                </div>
              </div>
            </summary>

            <PlanOutput
              runId={runId}
              status={status}
              planStatus={planStatus}
              onSummaryChange={handlePlanSummaryChange}
            />

            <details
              className="group border-t border-gray-200"
            >
              <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600">
                Raw plan log
              </summary>
              <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap border-t border-code-background bg-code-background p-4 font-mono text-xs leading-5 text-code-foreground">
                {planLogs !== "" ? planLogs : planRawLogMessage}
              </pre>
            </details>
          </details>

          {showCostEstimate && (
          <section aria-labelledby="cost-heading" className="overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm">
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="flex items-center gap-3">
                {costPending ? (
                  <Clock className="size-5 text-blue-600" aria-hidden="true" />
                ) : costFailed ? (
                  <XCircle className="size-5 text-red-600" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="size-5 text-gray-400" aria-hidden="true" />
                )}
                <h2 id="cost-heading" className="font-semibold text-gray-950">Cost estimation</h2>
              </div>
              <Badge variant={costFailed ? "destructive" : "secondary"} className="rounded capitalize">{costStatus}</Badge>
            </div>
            {costAttributes !== undefined && (
              <dl aria-label="Cost estimate details" className="grid grid-cols-2 gap-4 border-t border-gray-200 px-5 py-4 text-sm md:grid-cols-4">
                <div>
                  <dt className="text-xs text-gray-500">Prior monthly</dt>
                  <dd className="mt-1 font-medium">{formatMonthlyCost(costAttributes["prior-monthly-cost"])}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Proposed monthly</dt>
                  <dd className="mt-1 font-medium">{formatMonthlyCost(costAttributes["proposed-monthly-cost"])}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Monthly delta</dt>
                  <dd className="mt-1 font-medium">{formatMonthlyCost(costAttributes["delta-monthly-cost"])}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Priced resources</dt>
                  <dd className="mt-1 font-medium">
                    {costAttributes["matched-resources-count"] ?? 0} of {costAttributes["resources-count"] ?? 0}
                  </dd>
                </div>
                {costAttributes["error-message"] !== null && costAttributes["error-message"] !== undefined && (
                  <div className="col-span-full text-red-700">{costAttributes["error-message"]}</div>
                )}
              </dl>
            )}
          </section>
          )}

          {showPolicyChecks && (
          <section aria-labelledby="policy-heading" className="overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div className="flex items-center gap-3">
                {hasFailedPolicy ? (
                  <AlertCircle className="size-5 text-red-600" aria-hidden="true" />
                ) : policySummary === "checking" ? (
                  <Clock className="size-5 text-blue-600" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="size-5 text-gray-400" aria-hidden="true" />
                )}
                <h2 id="policy-heading" className="font-semibold text-gray-950">Policy check</h2>
              </div>
              <Badge variant={hasFailedPolicy ? "destructive" : "secondary"} className="rounded capitalize">
                {policySummary}
              </Badge>
            </div>
            {policyChecks.length > 0 && (
              <div className="border-t border-gray-200 px-5 py-3">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Check</TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {policyChecks.map((check: PolicyCheck): React.JSX.Element => (
                      <TableRow key={check.id}>
                        <TableCell>
                          <div className="text-sm font-medium">
                            {check.attributes["policy-name"] ?? check.id}
                          </div>
                          {check.attributes["policy-name"] !== null
                            && check.attributes["policy-name"] !== undefined && (
                            <code className="text-[11px] text-gray-500">{check.id}</code>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-normal">{policyResultText(check.attributes.result)}</TableCell>
                        <TableCell>
                          <Badge
                            variant={["failed", "soft_failed", "hard_failed", "errored", "unreachable"].includes(check.attributes.status)
                              && !isAdvisoryPolicyIssue(check)
                              ? "destructive"
                              : "secondary"}
                            className="rounded capitalize"
                          >
                            {isAdvisoryPolicyIssue(check)
                              ? `advisory ${check.attributes.status === "failed"
                                  ? "failed"
                                  : check.attributes.status.replace(/_/g, " ")}`
                              : check.attributes.status.replace(/_/g, " ")}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>
          )}

          {assessmentChecks.length > 0 && (
            <details className="group overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm">
              <summary className="cursor-pointer list-none">
                <div className="flex items-center justify-between gap-3 px-5 py-4 group-open:border-b group-open:border-gray-200">
                  <div className="flex items-center gap-3">
                    <ChevronRight className="size-4 text-gray-400 transition-transform group-open:rotate-90" aria-hidden="true" />
                    <div>
                      <h2 id="assessment-heading" className="font-semibold text-gray-950">Health checks</h2>
                      <p className="mt-1 text-xs text-muted-foreground">Terraform checks and drift validation reported for this run.</p>
                    </div>
                  </div>
                  <Badge variant={assessmentChecks.some((check): boolean => ["failed", "errored"].includes(check.attributes.status)) ? "destructive" : "secondary"}>
                    {assessmentChecks.filter((check): boolean => check.attributes.status === "passed").length} / {assessmentChecks.length} passed
                  </Badge>
                </div>
              </summary>
              <div className="px-5 py-3">
                <Table>
                  <TableHeader><TableRow><TableHead>Check</TableHead><TableHead>Result</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {assessmentChecks.map((check): React.JSX.Element => (
                      <TableRow key={check.id}>
                        <TableCell>
                          <div className="font-medium">{check.attributes.address ?? check.id}</div>
                          {check.attributes.kind !== null && check.attributes.kind !== undefined && <div className="text-xs text-muted-foreground">{check.attributes.kind}</div>}
                        </TableCell>
                        <TableCell className="whitespace-normal">{check.attributes.message ?? (typeof check.attributes.detail === "string" ? check.attributes.detail : "—")}</TableCell>
                        <TableCell><Badge variant={["failed", "errored"].includes(check.attributes.status) ? "destructive" : "secondary"}>{check.attributes.status.replace(/_/g, " ")}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </details>
          )}

          {showApply && (
          <details
            aria-labelledby="apply-heading"
            className={`group overflow-hidden rounded-md border bg-white shadow-sm ${
              ["errored", "unreachable"].includes(applyStatus) ? "border-red-300" : "border-gray-200"
            }`}
            open={applied || ["running", "errored", "unreachable"].includes(applyStatus) ? true : false}
          >
            <summary className="cursor-pointer list-none border-b border-gray-200 px-5 py-4 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <ChevronRight className="size-4 text-gray-400 transition-transform group-open:rotate-90" aria-hidden="true" />
                  <PhaseIcon status={applyStatus} />
                  <h2 id="apply-heading" className="font-semibold capitalize text-gray-950">
                    Apply {canApply ? "needs confirmation" : applyStatus.replace(/_/g, " ")}
                  </h2>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-4">
                  <PhaseMeta
                    phase="apply"
                    status={applyStatus}
                    timestamps={apply?.attributes["status-timestamps"] ?? timestamps}
                    logUrl={apply?.attributes["log-read-url"]}
                  />
                  {applyStatus !== "finished" && (
                    <ResourceCounts
                      additions={applyCounts?.["resource-additions"]}
                      changes={applyCounts?.["resource-changes"]}
                      destructions={applyCounts?.["resource-destructions"]}
                      imports={applyCounts?.["resource-imports"] ?? planImportCount}
                      status={applyStatus}
                    />
                  )}
                </div>
              </div>
            </summary>

            {applyStatus !== "pending" && (
              <ApplyOutput
                runId={runId}
                status={status}
                applyStatus={applyStatus}
                applyLogs={applyLogs}
              />
            )}

            {["errored", "unreachable"].includes(applyStatus) && (
              <section aria-labelledby="apply-diagnostics-heading" className="border-t border-red-200 bg-red-50/70 px-5 py-4">
                <h3 id="apply-diagnostics-heading" className="text-sm font-semibold text-red-900">Diagnostics</h3>
                <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-red-200 bg-white p-4 font-mono text-xs leading-5 text-red-900">
                  {applyLogs !== "" ? applyLogs : "The apply failed before diagnostic output became available."}
                </pre>
              </section>
            )}
            <details className="group">
              <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600">
                Raw apply log
              </summary>
              <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap border-t border-code-background bg-code-background p-4 font-mono text-xs leading-5 text-code-foreground">
                {applyLogs !== "" ? applyLogs : applyRawLogMessage}
              </pre>
            </details>
          </details>
          )}

          {(canApply || canDiscard) && (
            <section
              aria-labelledby="run-confirmation-heading"
              className="mx-auto w-full max-w-2xl rounded-md border border-amber-200 bg-amber-50 px-5 py-4 shadow-sm"
            >
              {confirmationAction === null ? (
                <>
                  <h2 id="run-confirmation-heading" className="font-semibold text-amber-950">
                    Please review the planned changes before continuing
                  </h2>
                  <div className="mt-3">
                    <ResourceCounts
                      additions={planCounts["resource-additions"]}
                      changes={planCounts["resource-changes"]}
                      destructions={planCounts["resource-destructions"]}
                      imports={planImportCount}
                      status={planStatus}
                    />
                  </div>
                  <p className="mt-3 text-sm text-amber-900">
                    Choose an action to review it, then confirm it in the next step.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {canApply && (
                      <Button
                        className="bg-primary text-primary-foreground hover:bg-primary/90"
                        disabled={pendingAction !== ""}
                        onClick={(): void => { beginRunConfirmation("apply"); }}
                      >
                        Review &amp; apply
                      </Button>
                    )}
                    {canDiscard && (
                      <Button
                        variant="outline"
                        disabled={pendingAction !== ""}
                        onClick={(): void => { beginRunConfirmation("discard"); }}
                      >
                        Review &amp; discard
                      </Button>
                    )}
                    {canComment && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={(): void => { document.getElementById("run-comment")?.focus(); }}
                      >
                        Add comment
                      </Button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <h2 id="run-confirmation-heading" className="font-semibold text-amber-950">
                    {confirmationAction === "apply" ? "Confirm apply" : "Confirm discard"}
                  </h2>
                  <p className="mt-2 text-sm text-amber-900">
                    {confirmationAction === "apply"
                      ? "This will execute the planned changes against this workspace."
                      : "This will discard the plan without changing the workspace."}
                  </p>
                  {canComment && (
                    <div className="mt-4">
                      <label htmlFor="run-action-comment" className="mb-2 block text-sm font-medium text-amber-950">
                        Optional comment
                      </label>
                      <textarea
                        id="run-action-comment"
                        rows={3}
                        autoFocus
                        value={actionComment}
                        onInput={(event): void => { setActionComment(event.currentTarget.value); }}
                        className="w-full resize-y rounded-md border border-amber-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
                        placeholder="Add context for this decision"
                      />
                    </div>
                  )}
                  <div className="mt-4 flex flex-wrap justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pendingAction !== ""}
                      onClick={(): void => { setConfirmationAction(null); setActionComment(""); }}
                    >
                      Back
                    </Button>
                    <Button
                      type="button"
                      variant={confirmationAction === "discard" ? "destructive" : "default"}
                      disabled={pendingAction !== ""}
                      onClick={(): void => { void confirmRunAction(); }}
                    >
                      {confirmationAction === "apply" ? "Confirm & apply" : "Confirm discard"}
                    </Button>
                  </div>
                </>
              )}
            </section>
          )}

          {showCombinedEmptyActivity ? (
            <section aria-labelledby="activity-heading" className="rounded-md border border-gray-200 bg-white shadow-sm">
              <div className="flex items-center gap-3 border-b border-gray-200 px-5 py-4">
                <History className="size-5 text-gray-400" aria-hidden="true" />
                <MessageSquare className="size-5 text-gray-400" aria-hidden="true" />
                <h2 id="activity-heading" className="font-semibold text-gray-950">Activity &amp; comments</h2>
                <span className="text-xs text-gray-500">0</span>
              </div>
              <p className="px-5 py-4 text-sm text-gray-500">No run activity or comments yet.</p>
              {commentForm}
            </section>
          ) : (
            <>
          <section aria-labelledby="activity-heading" className="rounded-md border border-gray-200 bg-white shadow-sm">
            <div className="flex items-center gap-3 border-b border-gray-200 px-5 py-4">
              <History className="size-5 text-gray-400" aria-hidden="true" />
              <h2 id="activity-heading" className="font-semibold text-gray-950">Activity</h2>
              <span className="text-xs text-gray-500">{runEvents.length}</span>
            </div>
            {runEvents.length === 0 ? (
              <p className="px-5 py-3 text-xs text-gray-500">No run activity yet.</p>
            ) : (
              <ol className="divide-y divide-gray-100">
                {runEvents.map((event: RunEvent): React.JSX.Element => {
                  const actor = event.attributes["actor-username"] ?? "System";
                  const fromStatus = event.attributes.details?.fromStatus;
                  const toStatus = event.attributes.details?.toStatus;
                  const eventSource = event.attributes.details?.source;
                  const triggerReason = event.attributes.details?.triggerReason;
                  return (
                    <li key={event.id} className="flex gap-3 px-5 py-3">
                      <Avatar className="size-8 rounded-full">
                        {event.attributes["actor-avatar-url"] ? (
                          <AvatarImage src={event.attributes["actor-avatar-url"]} alt={actor} className="rounded-full object-cover" />
                        ) : (
                          <AvatarFallback className="rounded-full bg-gray-100 text-xs font-semibold text-gray-600">
                            {actor.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        )}
                      </Avatar>
                      <div className="min-w-0 flex-1 text-sm">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                          <p className="text-gray-800">
                            <span className="font-semibold text-gray-950">{actor}</span>{" "}
                            {RUN_EVENT_LABELS[event.attributes.action] ?? statusLabel(event.attributes.action)}
                          </p>
                          <time
                            className="text-xs text-gray-500"
                            dateTime={event.attributes["created-at"]}
                          >
                            {formatDate(event.attributes["created-at"])}
                          </time>
                        </div>
                        {fromStatus !== undefined && toStatus !== undefined && (
                          <p className="mt-0.5 text-xs text-gray-500">
                            {statusLabel(fromStatus)} → {statusLabel(toStatus)}
                          </p>
                        )}
                        {event.attributes.action === "create" && eventSource !== undefined && (
                          <p className="mt-0.5 text-xs text-gray-500">
                            {statusLabel(triggerReason ?? "manual")} from {sourceLabel(eventSource)}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section aria-labelledby="comments-heading" className="rounded-md border border-gray-200 bg-white shadow-sm">
            <div className="flex items-center gap-3 border-b border-gray-200 px-5 py-4">
              <MessageSquare className="size-5 text-gray-400" aria-hidden="true" />
              <h2 id="comments-heading" className="font-semibold text-gray-950">Comments</h2>
              <span className="text-xs text-gray-500">{comments.length}</span>
            </div>
            <div className="divide-y divide-gray-100">
              {comments.length === 0 ? (
                <p className="px-5 py-4 text-sm text-gray-500">No comments yet.</p>
              ) : comments.map((comment: RunComment): React.JSX.Element => (
                <article key={comment.id} className="px-5 py-4">
                  <div className="mb-1 flex items-center justify-between gap-3 text-xs text-gray-500">
                    <span className="flex items-center gap-2 font-medium text-gray-700">
                      <Avatar className="size-5 rounded-full">
                        {comment.attributes["actor-avatar-url"] ? (
                          <AvatarImage src={comment.attributes["actor-avatar-url"]} alt={comment.attributes["actor-username"] ?? "User"} className="rounded-full object-cover" />
                        ) : (
                          <AvatarFallback className="rounded-full bg-gray-100 text-[9px] text-gray-600">
                            {(comment.attributes["actor-username"] ?? "S").slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        )}
                      </Avatar>
                      {comment.attributes["actor-username"] ?? "System"}
                    </span>
                    <time dateTime={comment.attributes["created-at"]}>{formatDate(comment.attributes["created-at"])}</time>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-gray-800">{comment.attributes.body}</p>
                </article>
              ))}
            </div>
            {commentForm}
          </section>
            </>
          )}
      </div>
    </div>
  );
}
