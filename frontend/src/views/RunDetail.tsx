import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  History,
  Link2,
  Maximize2,
  RotateCcw,
  MessageSquare,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import { Spinner } from "../components/ui/spinner";
import { PlanOutput, type PlanOutputSummary } from "../components/PlanOutput";
import { MarkdownContent } from "../components/MarkdownContent";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { DegradedBanner } from "../components/DegradedBanner";
import { formatDateTime, formatRelativeTime } from "@/lib/utils";
import { ApplyOutput } from "../components/ApplyOutput";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { toast } from "../components/ui/toast";
import { ApiError, fetchApi, streamExplain, type ExplainKind, type ReasoningEffort } from "../lib/api";
import { subscribeEvents, type SseEvent } from "../lib/events";
import { CAPABILITY_PLAN_EXPLAINER, useCapability } from "../lib/capabilities";
import { useUnsavedChangesWarning } from "../lib/use-unsaved-changes";

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
  "duration-baseline"?: {
    "duration-seconds"?: number | null;
    "median-duration-seconds"?: number | null;
    "is-slow"?: boolean;
  } | null;
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
  "workspace-locked"?: boolean;
  "workspace-locked-reason"?: string | null;
};

type RunResource = {
  id: string;
  attributes: RunAttributes;
  relationships?: {
    "created-by"?: {
      data: { id: string; type: string } | null;
    };
    workspace?: {
      data: { id: string; type: string };
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

/** Format a duration stored as seconds (e.g. "300" -> "5 minutes"). */
function formatDurationSeconds(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return "Unavailable";
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 1) return "Less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${remainder === 0 ? "" : ` ${remainder} min`}`;
}

export function formatExplainElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
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
  if (status === "finished") return <CheckCircle2 className="size-5 text-success" aria-hidden="true" />;
  if (status === "errored" || status === "unreachable") return <XCircle className="size-5 text-destructive" aria-hidden="true" />;
  if (status === "canceled") return <AlertCircle className="size-5 text-muted-foreground" aria-hidden="true" />;
  if (status === "running") {
    return (
      <span className="relative flex size-5 items-center justify-center">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
        <Clock className="relative size-4 text-primary" aria-hidden="true" />
      </span>
    );
  }
  if (status === "queued") return <Clock className="size-5 text-primary" aria-hidden="true" />;
  return <Circle className="size-5 text-muted-foreground/50" aria-hidden="true" />;
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
      <span className="text-xs font-medium text-muted-foreground">
        {pending ? "Resources pending" : "Resources unavailable"}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium">
      {typeof imports === "number" && imports > 0 && <span className="text-foreground">&amp;{imports} to import</span>}
      <span className="text-success">+{additions} to add</span>
      <span className="text-primary">~{changes} to change</span>
      <span className="text-destructive">−{destructions} to destroy</span>
    </div>
  );
}

function PhaseMeta({
  phase,
  status,
  timestamps,
  logUrl,
  logWrap,
  onToggleLogWrap,
}: Readonly<{
  phase: "plan" | "apply";
  status: string;
  timestamps: Readonly<Record<string, string>>;
  logUrl: string | null | undefined;
  logWrap: boolean;
  onToggleLogWrap: () => void;
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
  const phaseDurationLabel = started !== undefined && completed !== undefined
    ? formatDuration(started, completed)
    : null;
  if (started === undefined && completed === undefined && !hasLogUrl) return <></>;
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {started !== undefined && (
        <span>Started <time dateTime={started} title={formatDateTime(started)}>{formatRelativeTime(started)}</time></span>
      )}
      {completed !== undefined && (
        <span>{completedLabel} <time dateTime={completed} title={formatDateTime(completed)}>{formatRelativeTime(completed)}</time>{phaseDurationLabel !== null && phaseDurationLabel !== "Unavailable" && (<span title="Phase duration"> · {phaseDurationLabel}</span>)}</span>
      )}
      {hasLogUrl && (
        <>
          <button
            type="button"
            onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
              event.preventDefault();
              event.stopPropagation();
              onToggleLogWrap();
            }}
            aria-pressed={logWrap}
            className="rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Wrap {logWrap ? "on" : "off"}
          </button>
          <a
            href={logUrl}
            download
            onClick={(event: React.MouseEvent<HTMLAnchorElement>): void => { event.stopPropagation(); }}
            className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Download raw log
          </a>
        </>
      )}
    </div>
  );
}

export function RunDetail({
  showBreadcrumb = true,
}: Readonly<{ readonly showBreadcrumb?: boolean }>): React.JSX.Element {
  const navigate = useNavigate();
  const {
    orgName: rawOrgName,
    workspaceName: rawWorkspaceName,
    runId: rawRunId,
  } = useParams<{ orgName: string; workspaceName: string; runId: string }>();
  const orgName = rawOrgName ?? "";
  const workspaceName = rawWorkspaceName ?? "";
  const runId = rawRunId ?? "";
  const planExplainerEnabled = useCapability(CAPABILITY_PLAN_EXPLAINER);
  const orgPath = `/app/${encodeURIComponent(orgName)}`;
  const workspacePath = `${orgPath}/workspaces/${encodeURIComponent(workspaceName)}`;
  const [run, setRun] = useState<RunResource | null>(null);
  const [plan, setPlan] = useState<PhaseResource | null>(null);
  const [apply, setApply] = useState<PhaseResource | null>(null);
  const [planLogs, setPlanLogs] = useState("");
  const [applyLogs, setApplyLogs] = useState("");
  const [rerunPending, setRerunPending] = useState(false);
  const [rerunError, setRerunError] = useState("");
  const [fullscreenLog, setFullscreenLog] = useState<"plan" | "apply" | null>(null);
  // Focus management for the fullscreen log dialog (kanban 25.2): remember
  // whichever control opened it so focus can return there after close.
  const fullscreenTriggerRef = useRef<HTMLElement | null>(null);
  const fullscreenCloseRef = useRef<HTMLButtonElement | null>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement | null>(null);
  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  const [policyChecks, setPolicyChecks] = useState<PolicyCheck[]>([]);
  const [assessmentChecks, setAssessmentChecks] = useState<AssessmentCheck[]>([]);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [comments, setComments] = useState<RunComment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [confirmationAction, setConfirmationAction] = useState<ConfirmationAction | null>(null);
  const [actionComment, setActionComment] = useState("");
  const [explainerOpen, setExplainerOpen] = useState(false);
  const [explainerKind, setExplainerKind] = useState<ExplainKind>("plan");
  const [explaining, setExplaining] = useState(false);
  const [explanation, setExplanation] = useState("");
  const [explainerThinking, setExplainerThinking] = useState("");
  const [explainerThinkingOpen, setExplainerThinkingOpen] = useState(false);
  const [explainerElapsedSeconds, setExplainerElapsedSeconds] = useState(0);
  const [explainerStartedAt, setExplainerStartedAt] = useState<number | null>(null);
  const [explainerReasoningEffort, setExplainerReasoningEffort] = useState<ReasoningEffort | null>(null);
  const [explainerModel, setExplainerModel] = useState("");
  const [explainError, setExplainError] = useState("");
  const explainerAbortRef = useRef<AbortController | null>(null);
  // Abort any in-flight explanation when the view unmounts (e.g. the user
  // navigates away mid-stream).
  useEffect((): (() => void) => {
    return (): void => {
      explainerAbortRef.current?.abort();
      explainerAbortRef.current = null;
    };
  }, []);
  useEffect((): (() => void) | undefined => {
    if (explainerStartedAt === null) return undefined;
    const updateElapsed = (): void => {
      setExplainerElapsedSeconds(Math.floor((Date.now() - explainerStartedAt) / 1000));
    };
    updateElapsed();
    if (!explaining) return undefined;
    const timer = window.setInterval(updateElapsed, 1000);
    return (): void => { window.clearInterval(timer); };
  }, [explainerStartedAt, explaining]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [auxiliaryError, setAuxiliaryError] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [creatorUsername, setCreatorUsername] = useState("");
  const [creatorAvatarUrl, setCreatorAvatarUrl] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [copiedPermalink, setCopiedPermalink] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [logWrap, setLogWrap] = useState<boolean>(true);
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
      window.setTimeout((): void => { setCopiedPermalink(false); }, 2000);
    } catch {
      toast.add({ title: "Could not copy link", type: "error" });
    }
  }

  useEffect((): void => {
    setRunEvents([]);
  }, [runId]);

  useEffect((): (() => void) => {
    if (fullscreenLog === null) return () => {};
    // The overlay renders after this effect commits, so the close button ref
    // is already populated; move focus into the dialog. Remember the trigger
    // so cleanup can hand focus back when the dialog goes away.
    fullscreenTriggerRef.current = document.activeElement as HTMLElement | null;
    fullscreenCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setFullscreenLog(null);
        return;
      }
      // Trap Tab/Shift+Tab inside the dialog so keyboard focus can never
      // escape into the page behind the overlay.
      if (event.key === "Tab") {
        const container = fullscreenContainerRef.current;
        if (container === null) return;
        const focusable = Array.from(
          container.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (first === undefined || last === undefined) return;
        const active = document.activeElement;
        if (event.shiftKey) {
          if (active === null || active === first || !container.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else if (active === null || active === last || !container.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      fullscreenTriggerRef.current?.focus();
      fullscreenTriggerRef.current = null;
    };
  }, [fullscreenLog]);

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
    let refreshing = false;
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
      // Guard against overlapping loops: a visibility-triggered refresh can
      // fire while a timer refresh is still awaiting loadRun.
      if (stopped || controller.signal.aborted || refreshing) return;
      refreshing = true;
      try {
        const status = await loadRun(controller.signal);
        if (!stopped && !controller.signal.aborted && status !== "not_found"
          && (status === null || !TERMINAL_STATUSES.has(status))) {
          // Pause polling while the tab is hidden; visibilitychange resumes it.
          if (document.hidden) return;
          timer = window.setTimeout((): void => { void refresh(); }, 30000);
        }
      } finally {
        refreshing = false;
      }
    };
    const onVisibilityChange = (): void => {
      if (document.hidden) {
        // Tab hidden mid-poll: drop any pending timer so a scheduled refresh
        // can never fire (and fetch) while the page is invisible.
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
        return;
      }
      if (!stopped) {
        // Drop any pending timer so a visibility resume starts exactly one
        // fresh refresh instead of stacking on the scheduled one.
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void refresh();

    // Authenticated SSE replaces the fast poll (10.20): status transitions
    // for this run trigger a trailing-debounced refresh (the final
    // transition of a burst wins), while the timer above degrades to a slow
    // safety net for streams that fail.
    let debounceTimer: number | undefined;
    const stream = subscribeEvents((event: SseEvent): void => {
      if (event.name !== "run.status") return;
      const data = event.data;
      if (data["run-id"] !== runId) return;
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout((): void => {
        debounceTimer = undefined;
        // Drop the armed poll timer: an SSE-triggered refresh supersedes it,
        // so the two cannot chain duplicate refreshes.
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
        if (!stopped && !controller.signal.aborted) void refresh();
      }, 500);
    }, controller.signal);

    return (): void => {
      stopped = true;
      controller.abort();
      stream.close();
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadRun, refreshVersion, runId]);

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

  // kanban 21.2: plain-language explanation of the stored plan JSON or a
  // failed apply log via the configured OpenAI-compatible endpoint. Read-only;
  // never mutates the run. Streaming path: the backend relays upstream deltas
  // as SSE events and replays cached generations under the same envelope, so
  // re-opening the dialog never re-burns tokens.
  async function handleExplain(kind: ExplainKind, refresh: boolean): Promise<void> {
    setExplainerOpen(true);
    setExplainerKind(kind);
    setExplaining(true);
    setExplanation("");
    setExplainerThinking("");
    setExplainerThinkingOpen(false);
    setExplainerElapsedSeconds(0);
    setExplainerStartedAt(Date.now());
    setExplainerReasoningEffort(null);
    setExplainerModel("");
    setExplainError("");
    // Only the latest stream may update the dialog state; abort any earlier
    // generation (e.g. a double-click on the button).
    explainerAbortRef.current?.abort();
    const controller = new AbortController();
    explainerAbortRef.current = controller;
    try {
      await streamExplain(
        runId,
        kind,
        refresh,
        (event): void => {
          if (explainerAbortRef.current !== controller) return;
          if (event.name === "meta") {
            setExplainerModel(event.data.model);
            setExplainerReasoningEffort(event.data["reasoning-effort"]);
          } else if (event.name === "thinking") {
            setExplainerThinking((current): string => `${current}${event.data.text}`);
          } else if (event.name === "content") {
            setExplanation((current): string => `${current}${event.data.text}`);
          } else if (event.name === "content-reset") {
            // Replace the accumulated text: the provider streamed thinking
            // inline inside content deltas, so the cleaned text supersedes
            // everything already appended.
            setExplanation(event.data.text);
          }
        },
        controller.signal,
      );
    } catch (caught: unknown) {
      if (controller.signal.aborted) {
        // Intentional cancel: keep whatever was already generated on screen,
        // the stream helpfully never persisted a partial generation.
        return;
      }
      setExplainError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (explainerAbortRef.current === controller) {
        explainerAbortRef.current = null;
        setExplaining(false);
        setExplainerThinking("");
      }
    }
  }

  function cancelExplanation(): void {
    const controller = explainerAbortRef.current;
    if (controller === null) return;
    controller.abort();
    explainerAbortRef.current = null;
    setExplaining(false);
    setExplainerThinking("");
    if (explanation === "") setExplainError("Generation canceled. Try again when ready.");
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

  useUnsavedChangesWarning(
    commentBody.trim() !== "",
    "You have an unsaved comment draft. Are you sure you want to leave this page?",
  );

  if (run !== null && run.id !== runId) return <div className="p-8 text-muted-foreground">Loading run…</div>;
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
      <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-5 text-sm text-destructive">
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

  // Statuses where a run is actively heading toward apply; re-running another
  // run from this page while one is in flight would queue a duplicate.
  const runInFlight = [
    "pending", "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed",
    "queuing", "plan_queued", "planning", "cost_estimating", "cost_estimated",
    "policy_checking", "policy_override", "policy_checked", "post_plan_running",
    "post_plan_completed", "confirmed", "apply_queued", "applying",
  ].includes(status);

  const workspaceId = (run.relationships as { workspace?: { data?: { id?: string } } } | undefined)
    ?.workspace?.data?.id ?? "";
  const canRerun = workspaceId !== ""
    && !runInFlight
    && attributes["is-destroy"] !== true
    && attributes["workspace-locked"] !== true;

  const performRerun = async (): Promise<void> => {
    if (workspaceId === "" || rerunPending) return;
    setRerunPending(true);
    setRerunError("");
    try {
      const body = await fetchApi("/api/v2/runs", {
        method: "POST",
        body: JSON.stringify({
          data: {
            attributes: { message: `Re-run of ${runId}` },
            relationships: { workspace: { data: { type: "workspaces", id: workspaceId } } },
          },
        }),
      });
      const newRunId = (body as { data?: { id?: string } }).data?.id;
      if (typeof newRunId === "string" && newRunId !== "") {
        navigate(`${workspacePath}/runs/${encodeURIComponent(newRunId)}`);
      } else {
        setRerunError("The run was created but the response did not include a run id.");
      }
    } catch (err: unknown) {
      setRerunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunPending(false);
    }
  };

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
    && costAttributes !== undefined
    && costAttributes["infracost-enabled"] !== false
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

  // Explain why Apply is disabled (kanban 15.10), mirroring the gate at top:
  // fresh && is-confirmable && can-apply, plus policy/lock/task states.
  const applyDisabledReasons: string[] = [];
  const applyGated = showApply && !canApply && applyStatus !== "finished";
  if (applyGated) {
    if (["policy_checking", "policy_checked", "post_plan_running", "post_plan_completed", "queuing", "plan_queued", "planning"].includes(status)) {
      applyDisabledReasons.push("Plan, policy checks, and pre-apply tasks are still running. Apply becomes available once they finish.");
    }
    if (status === "policy_soft_failed") {
      applyDisabledReasons.push("A policy check soft-failed. Someone with override permission must override it before this run can be applied.");
    }
    if (attributes["workspace-locked"] === true) {
      applyDisabledReasons.push(`Workspace is locked: ${typeof attributes["workspace-locked-reason"] === "string" ? attributes["workspace-locked-reason"] : "Locked manually"}`);
    }
    if (permissions?.["can-apply"] !== true) {
      applyDisabledReasons.push("You do not have permission to apply in this workspace.");
    }
    if (!fresh) {
      applyDisabledReasons.push("This run is no longer current. Start a new run to apply these changes.");
    }
  }
  const successfulStatus = ["applied", "planned_and_finished"].includes(status);
  const showCombinedEmptyActivity = TERMINAL_STATUSES.has(status)
    && runEvents.length === 0
    && comments.length === 0;

  const commentForm = canComment ? (
    <form onSubmit={(event): void => { void handleCommentSubmit(event); }} className="border-t border-border p-5">
      <label htmlFor="run-comment" className="mb-2 block text-sm font-medium text-foreground">Add a comment</label>
      <textarea
        id="run-comment"
        name="run-comment"
        autoComplete="off"
        spellCheck={false}
        rows={3}
        value={commentBody}
        onChange={(event): void => { setCommentBody(event.target.value); }}
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20"
        placeholder="Share context about this run"
      />
      <div className="mt-2 flex justify-end">
        <Button type="submit" disabled={commentBody.trim() === "" || pendingAction !== ""}>Add comment</Button>
      </div>
    </form>
  ) : null;

  return (
    <div className="w-full">
      {showBreadcrumb && (
        <Breadcrumbs
          items={[
            { label: orgName, to: orgPath },
            { label: workspaceName, to: workspacePath },
            { label: "Runs", to: `${workspacePath}/runs` },
            { label: runId },
          ]}
        />
      )}

      {!fresh && loadError !== "" && (
        <DegradedBanner
          title="Run data may be out of date. Actions are disabled until it refreshes."
          actionLabel="Try again"
          onAction={(): void => { setRefreshVersion((value): number => value + 1); }}
        />
      )}
      {fresh && auxiliaryError && (
        <DegradedBanner
          title="Some run details could not be refreshed."
          actionLabel="Try again"
          onAction={(): void => { setRefreshVersion((value): number => value + 1); }}
        />
      )}

      <header className="mb-6 flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge
              variant={["errored", "failed", "unreachable"].includes(status) ? "destructive" : "secondary"}
              className={successfulStatus ? "rounded bg-success/10 text-success" : "rounded"}
            >
              {statusLabel(status)}
            </Badge>
            <span aria-live="polite" className="sr-only">Run status: {statusLabel(status)}</span>
            {attributes["plan-only"] === true && <Badge variant="outline" className="rounded">Plan only</Badge>}
            {attributes["is-destroy"] === true && <Badge variant="destructive" className="rounded">Destroy</Badge>}
            {attributes["refresh-only"] === true && <Badge variant="outline" className="rounded text-primary border-primary/30 bg-primary/10">Refresh only</Badge>}
            {attributes["allow-empty-apply"] === true && <Badge variant="outline" className="rounded text-primary border-primary/30 bg-primary/10">Allow empty apply</Badge>}
          </div>
          <h2 className="break-words text-3xl font-bold tracking-tight text-foreground">
            {attributes.message ?? "Manual run"}
          </h2>
          <p className="mt-2 text-[13px] text-muted-foreground">
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
          {canRerun && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={rerunPending || pendingAction !== ""}
              onClick={(): void => { void performRerun(); }}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {rerunPending ? "Queuing…" : "Re-run"}
            </Button>
          )}
          {rerunError !== "" && (
            <p role="alert" className="w-full text-xs text-destructive">{rerunError}</p>
          )}
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

      <dl className="mb-5 grid overflow-hidden rounded-md border border-border bg-background shadow-sm sm:grid-cols-3">
        <div className="border-b border-border px-5 py-4 sm:border-b-0 sm:border-r">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {attributes["plan-only"] === true ? "Plan duration" : "Plan & apply duration"}
          </dt>
          <dd className="mt-1 text-sm font-semibold text-foreground">{duration}</dd>
          {(() => {
            const baseline = attributes["duration-baseline"];
            if (baseline?.["is-slow"] !== true || baseline["median-duration-seconds"] === null || baseline["median-duration-seconds"] === undefined) {
              return null;
            }
            return (
              <p className="mt-1 text-xs font-medium text-warning">
                Slower than typical (median {formatDurationSeconds(baseline["median-duration-seconds"])})
              </p>
            );
          })()}
        </div>
        <div className="border-b border-border px-5 py-4 sm:border-b-0 sm:border-r">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Resources changed</dt>
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
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</dt>
          <dd className="mt-1 text-sm font-semibold text-foreground">
            {planActionCount === null
              ? "Unavailable"
              : `${planActionCount} ${applyStatus === "finished" ? "invoked" : "to invoke"}`}
          </dd>
        </div>
      </dl>

      <details className="mb-5 overflow-hidden rounded-md border border-border bg-background shadow-sm">
        <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          Run details
        </summary>
        <dl className="grid gap-4 border-t border-border px-5 py-4 text-[13px] sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</dt>
            <dd className="mt-1 font-medium text-foreground">{statusLabel(status)}</dd>
          </div>
          {creatorUsername !== "" && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Created by</dt>
              <dd className="mt-1 flex items-center gap-2">
                <Avatar className="size-6 rounded-full">
                  {creatorAvatarUrl !== "" ? (
                    <AvatarImage src={creatorAvatarUrl} alt={creatorUsername} className="rounded-full object-cover" />
                  ) : (
                    <AvatarFallback className="rounded-full bg-muted text-[10px] text-muted-foreground">
                      {creatorUsername.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  )}
                </Avatar>
                <span className="font-medium text-foreground/85">{creatorUsername}</span>
              </dd>
            </div>
          )}
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Workspace</dt>
            <dd className="mt-1">
              <Link to={workspacePath} className="font-medium text-primary hover:underline">
                {workspaceName}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Operation</dt>
            <dd className="mt-1 capitalize text-foreground">{statusLabel(attributes.operation ?? "plan_and_apply")}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Auto apply</dt>
            <dd className="mt-1 text-foreground">{attributes["auto-apply"] === true ? "Enabled" : "Disabled"}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Terraform version</dt>
            <dd className="mt-1 text-foreground">{attributes["terraform-version"] ?? "Workspace default"}</dd>
          </div>
        </dl>
        {timestampEntries.length > 0 && (
          <div className="border-t border-border px-5 py-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Run timeline</h3>
            <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
              {timestampEntries.map(([key, value]): React.JSX.Element => (
                <div key={key}>
                  <dt className="capitalize text-muted-foreground">{key.replace(/-at$/, "").replace(/-/g, " ")}</dt>
                  <dd className="mt-0.5 text-foreground">{formatDate(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </details>

      <div className="min-w-0 space-y-5">
          <details
            aria-labelledby="plan-heading"
            className="group overflow-hidden rounded-md border border-border bg-background shadow-sm"
            open={!applied && ["running", "finished", "errored", "unreachable"].includes(planStatus)}
          >
            <summary className="cursor-pointer list-none border-b border-border px-5 py-4 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <ChevronRight className="size-4 text-muted-foreground/70 transition-transform group-open:rotate-90" aria-hidden="true" />
                  <PhaseIcon status={planStatus} />
                  <h3 id="plan-heading" className="font-semibold capitalize text-foreground">
                    Plan {planStatus.replace(/_/g, " ")}
                  </h3>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-4">
                  {["finished", "planned_and_saved"].includes(planStatus) && planExplainerEnabled && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
                        // Inside the plan <summary>: opening the dialog must
                        // not toggle the details section open/closed.
                        event.preventDefault();
                        event.stopPropagation();
                        void handleExplain("plan", false);
                      }}
                      aria-haspopup="dialog"
                    >
                      <Sparkles className="mr-2 size-4" aria-hidden="true" />
                      Explain plan
                    </Button>
                  )}
                  <PhaseMeta
                    phase="plan"
                    status={planStatus}
                    timestamps={plan?.attributes["status-timestamps"] ?? timestamps}
                    logUrl={plan?.attributes["log-read-url"]}
                    logWrap={logWrap}
                    onToggleLogWrap={() => { setLogWrap((wrap) => !wrap); }}
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
              className="group border-t border-border"
            >
              <summary className="flex cursor-pointer items-center justify-between gap-4 px-5 py-3 text-sm font-medium text-foreground/85 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                <span>Raw plan log</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={(event: React.MouseEvent<HTMLButtonElement>) => { event.preventDefault(); event.stopPropagation(); setFullscreenLog("plan"); }}
                  aria-label="Open raw plan log fullscreen"
                >
                  <Maximize2 className="size-4" aria-hidden="true" />
                </Button>
              </summary>
              <pre className={`max-h-[420px] overflow-auto ${logWrap ? "whitespace-pre-wrap" : "whitespace-pre"} border-t border-code-background bg-code-background p-4 font-mono text-xs leading-5 text-code-foreground`}>
                {planLogs !== "" ? planLogs : planRawLogMessage}
              </pre>
            </details>
          </details>

          {showCostEstimate && (
          <section aria-labelledby="cost-heading" className="overflow-hidden rounded-md border border-border bg-background shadow-sm">
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="flex items-center gap-3">
                {costPending ? (
                  <Clock className="size-5 text-primary" aria-hidden="true" />
                ) : costFailed ? (
                  <XCircle className="size-5 text-destructive" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="size-5 text-muted-foreground/70" aria-hidden="true" />
                )}
                <h3 id="cost-heading" className="font-semibold text-foreground">Cost estimation</h3>
              </div>
              <Badge variant={costFailed ? "destructive" : "secondary"} className="rounded capitalize">{costStatus}</Badge>
            </div>
            {costAttributes !== undefined && (
              <dl aria-label="Cost estimate details" className="grid grid-cols-2 gap-4 border-t border-border px-5 py-4 text-sm md:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted-foreground">Prior monthly</dt>
                  <dd className="mt-1 font-medium">{formatMonthlyCost(costAttributes["prior-monthly-cost"])}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Proposed monthly</dt>
                  <dd className="mt-1 font-medium">{formatMonthlyCost(costAttributes["proposed-monthly-cost"])}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Monthly delta</dt>
                  <dd className="mt-1 font-medium">{formatMonthlyCost(costAttributes["delta-monthly-cost"])}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Priced resources</dt>
                  <dd className="mt-1 font-medium">
                    {costAttributes["matched-resources-count"] ?? 0} of {costAttributes["resources-count"] ?? 0}
                  </dd>
                </div>
                {costAttributes["error-message"] !== null && costAttributes["error-message"] !== undefined && (
                  <div className="col-span-full text-destructive">{costAttributes["error-message"]}</div>
                )}
              </dl>
            )}
          </section>
          )}

          {showPolicyChecks && (
          <section aria-labelledby="policy-heading" className="overflow-hidden rounded-md border border-border bg-background shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div className="flex items-center gap-3">
                {hasFailedPolicy ? (
                  <AlertCircle className="size-5 text-destructive" aria-hidden="true" />
                ) : policySummary === "checking" ? (
                  <Clock className="size-5 text-primary" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="size-5 text-muted-foreground/70" aria-hidden="true" />
                )}
                <h3 id="policy-heading" className="font-semibold text-foreground">Policy check</h3>
              </div>
              <Badge variant={hasFailedPolicy ? "destructive" : "secondary"} className="rounded capitalize">
                {policySummary}
              </Badge>
            </div>
            {policyChecks.length > 0 && (
              <div className="border-t border-border px-5 py-3">
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
                            <code className="text-[11px] text-muted-foreground">{check.id}</code>
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
            <details className="group overflow-hidden rounded-md border border-border bg-background shadow-sm">
              <summary className="cursor-pointer list-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                <div className="flex items-center justify-between gap-3 px-5 py-4 group-open:border-b group-open:border-border">
                  <div className="flex items-center gap-3">
                    <ChevronRight className="size-4 text-muted-foreground/70 transition-transform group-open:rotate-90" aria-hidden="true" />
                    <div>
                      <h3 id="assessment-heading" className="font-semibold text-foreground">Health checks</h3>
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
            className={`group overflow-hidden rounded-md border bg-background shadow-sm ${
              ["errored", "unreachable"].includes(applyStatus) ? "border-destructive/50" : "border-border"
            }`}
            open={applied || ["running", "errored", "unreachable"].includes(applyStatus) ? true : false}
          >
            <summary className="cursor-pointer list-none border-b border-border px-5 py-4 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <ChevronRight className="size-4 text-muted-foreground/70 transition-transform group-open:rotate-90" aria-hidden="true" />
                  <PhaseIcon status={applyStatus} />
                  <h3 id="apply-heading" className="font-semibold capitalize text-foreground">
                    Apply {canApply ? "needs confirmation" : applyStatus.replace(/_/g, " ")}
                  </h3>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-4">
                  {["errored", "unreachable"].includes(applyStatus) && planExplainerEnabled && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={(event: React.MouseEvent<HTMLButtonElement>): void => {
                        // Inside the apply <summary>: opening the dialog must
                        // not toggle the details section open/closed.
                        event.preventDefault();
                        event.stopPropagation();
                        void handleExplain("apply", false);
                      }}
                      aria-haspopup="dialog"
                    >
                      <Sparkles className="mr-2 size-4" aria-hidden="true" />
                      Explain failure
                    </Button>
                  )}
                  <PhaseMeta
                    phase="apply"
                    status={applyStatus}
                    timestamps={apply?.attributes["status-timestamps"] ?? timestamps}
                    logUrl={apply?.attributes["log-read-url"]}
                    logWrap={logWrap}
                    onToggleLogWrap={() => { setLogWrap((wrap) => !wrap); }}
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

            {applyDisabledReasons.length > 0 && (
              <div className="border-b border-border bg-muted px-5 py-3">
                <p className="text-sm font-medium text-foreground/85">Why is Apply disabled?</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {applyDisabledReasons.map((reason: string): React.JSX.Element => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}

            {applyStatus !== "pending" && (
              <ApplyOutput
                runId={runId}
                status={status}
                applyStatus={applyStatus}
                applyLogs={applyLogs}
              />
            )}

            {["errored", "unreachable"].includes(applyStatus) && (
              <section aria-labelledby="apply-diagnostics-heading" className="border-t border-destructive/30 bg-destructive/10 px-5 py-4">
                <h4 id="apply-diagnostics-heading" className="text-sm font-semibold text-destructive">Diagnostics</h4>
                <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-destructive/30 bg-background p-4 font-mono text-xs leading-5 text-destructive">
                  {applyLogs !== "" ? applyLogs : "The apply failed before diagnostic output became available."}
                </pre>
              </section>
            )}
            <details className="group">
              <summary className="flex cursor-pointer items-center justify-between gap-4 px-5 py-3 text-sm font-medium text-foreground/85 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                <span>Raw apply log</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={(event: React.MouseEvent<HTMLButtonElement>) => { event.preventDefault(); event.stopPropagation(); setFullscreenLog("apply"); }}
                  aria-label="Open raw apply log fullscreen"
                >
                  <Maximize2 className="size-4" aria-hidden="true" />
                </Button>
              </summary>
              <pre className={`max-h-[420px] overflow-auto ${logWrap ? "whitespace-pre-wrap" : "whitespace-pre"} border-t border-code-background bg-code-background p-4 font-mono text-xs leading-5 text-code-foreground`}>
                {applyLogs !== "" ? applyLogs : applyRawLogMessage}
              </pre>
            </details>
          </details>
          )}

          {(canApply || canDiscard) && (
            <section
              aria-labelledby="run-confirmation-heading"
              className="mx-auto w-full max-w-2xl rounded-md border border-warning/30 bg-warning/10 px-5 py-4 shadow-sm"
            >
              {confirmationAction === null ? (
                <>
                  <h3 id="run-confirmation-heading" className="font-semibold text-warning">
                    Please review the planned changes before continuing
                  </h3>
                  <div className="mt-3">
                    <ResourceCounts
                      additions={planCounts["resource-additions"]}
                      changes={planCounts["resource-changes"]}
                      destructions={planCounts["resource-destructions"]}
                      imports={planImportCount}
                      status={planStatus}
                    />
                  </div>
                  <p className="mt-3 text-sm text-warning">
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
                  <h3 id="run-confirmation-heading" className="font-semibold text-warning">
                    {confirmationAction === "apply" ? "Confirm apply" : "Confirm discard"}
                  </h3>
                  <p className="mt-2 text-sm text-warning">
                    {confirmationAction === "apply"
                      ? "This will execute the planned changes against this workspace."
                      : "This will discard the plan without changing the workspace."}
                  </p>
                  {canComment && (
                    <div className="mt-4">
                      <label htmlFor="run-action-comment" className="mb-2 block text-sm font-medium text-warning">
                        Optional comment
                      </label>
                      <textarea
                        id="run-action-comment"
                        name="run-action-comment"
                        autoComplete="off"
                        spellCheck={false}
                        rows={3}
                        autoFocus
                        value={actionComment}
                        onInput={(event): void => { setActionComment(event.currentTarget.value); }}
                        className="w-full resize-y rounded-md border border-warning/50 bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20"
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
            <section aria-labelledby="activity-heading" className="rounded-md border border-border bg-background shadow-sm">
              <div className="flex items-center gap-3 border-b border-border px-5 py-4">
                <History className="size-5 text-muted-foreground/70" aria-hidden="true" />
                <MessageSquare className="size-5 text-muted-foreground/70" aria-hidden="true" />
                <h3 id="activity-heading" className="font-semibold text-foreground">Activity &amp; comments</h3>
                <span className="text-xs text-muted-foreground">0</span>
              </div>
              <p className="px-5 py-4 text-sm text-muted-foreground">No run activity or comments yet.</p>
              {commentForm}
            </section>
          ) : (
            <>
          <section aria-labelledby="activity-heading" className="rounded-md border border-border bg-background shadow-sm">
            <div className="flex items-center gap-3 border-b border-border px-5 py-4">
              <History className="size-5 text-muted-foreground/70" aria-hidden="true" />
              <h3 id="activity-heading" className="font-semibold text-foreground">Activity</h3>
              <span className="text-xs text-muted-foreground">{runEvents.length}</span>
            </div>
            {runEvents.length === 0 ? (
              <p className="px-5 py-3 text-xs text-muted-foreground">No run activity yet.</p>
            ) : (
              <ol className="divide-y divide-border/60">
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
                          <AvatarFallback className="rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                            {actor.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        )}
                      </Avatar>
                      <div className="min-w-0 flex-1 text-sm">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                          <p className="text-foreground/85">
                            <span className="font-semibold text-foreground">{actor}</span>{" "}
                            {RUN_EVENT_LABELS[event.attributes.action] ?? statusLabel(event.attributes.action)}
                          </p>
                          <time
                            className="text-xs text-muted-foreground"
                            dateTime={event.attributes["created-at"]}
                          >
                            {formatDate(event.attributes["created-at"])}
                          </time>
                        </div>
                        {fromStatus !== undefined && toStatus !== undefined && (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {statusLabel(fromStatus)} → {statusLabel(toStatus)}
                          </p>
                        )}
                        {event.attributes.action === "create" && eventSource !== undefined && (
                          <p className="mt-0.5 text-xs text-muted-foreground">
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

          <section aria-labelledby="comments-heading" className="rounded-md border border-border bg-background shadow-sm">
            <div className="flex items-center gap-3 border-b border-border px-5 py-4">
              <MessageSquare className="size-5 text-muted-foreground/70" aria-hidden="true" />
              <h3 id="comments-heading" className="font-semibold text-foreground">Comments</h3>
              <span className="text-xs text-muted-foreground">{comments.length}</span>
            </div>
            <div className="divide-y divide-border/60">
              {comments.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted-foreground">No comments yet.</p>
              ) : comments.map((comment: RunComment): React.JSX.Element => (
                <article key={comment.id} className="px-5 py-4">
                  <div className="mb-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-2 font-medium text-foreground/85">
                      <Avatar className="size-5 rounded-full">
                        {comment.attributes["actor-avatar-url"] ? (
                          <AvatarImage src={comment.attributes["actor-avatar-url"]} alt={comment.attributes["actor-username"] ?? "User"} className="rounded-full object-cover" />
                        ) : (
                          <AvatarFallback className="rounded-full bg-muted text-[9px] text-muted-foreground">
                            {(comment.attributes["actor-username"] ?? "S").slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        )}
                      </Avatar>
                      {comment.attributes["actor-username"] ?? "System"}
                    </span>
                    <time dateTime={comment.attributes["created-at"]}>{formatDate(comment.attributes["created-at"])}</time>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-foreground/85">{comment.attributes.body}</p>
                </article>
              ))}
            </div>
            {commentForm}
          </section>
            </>
          )}
      </div>

      <Dialog
        open={explainerOpen}
        onOpenChange={(open): void => {
          if (!open) cancelExplanation();
          setExplainerOpen(open);
        }}
      >
        <DialogContent className="flex max-h-[80dvh] flex-col gap-0 overflow-hidden overscroll-contain p-0 sm:max-w-2xl">
          <DialogHeader className="border-b border-border px-5 py-4 pr-16 text-left">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-primary" aria-hidden="true" />
              {explainerKind === "apply" ? "Apply failure explanation" : "Plan explanation"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              A plain-language explanation generated from the stored {explainerKind === "apply" ? "apply failure" : "plan"} data.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4" aria-live="polite" aria-busy={explaining}>
              {explainError !== "" && (
                <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <div>
                    <p className="font-medium">Could not generate an explanation</p>
                    <p className="mt-1 break-words">{explainError}</p>
                    <p className="mt-2 text-xs text-destructive/90">Check the explainer endpoint, model, and API key, then try again.</p>
                  </div>
                </div>
              )}
              {explaining && (
                <details
                  className="group mb-3 rounded-md border border-border"
                  open={explainerThinkingOpen}
                  onToggle={(event): void => { setExplainerThinkingOpen(event.currentTarget.open); }}
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                    <span className="flex min-w-0 items-center gap-2">
                      <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
                      <span>Thinking</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 tabular-nums">
                      {explaining && <Spinner className="size-3.5" aria-label="Thinking in progress" />}
                      <span>{formatExplainElapsed(explainerElapsedSeconds)}</span>
                    </span>
                  </summary>
                  <div className="border-t border-border px-3 py-2 text-xs leading-5 text-muted-foreground">
                    <p className="break-words whitespace-pre-wrap">{explainerThinking || "Reasoning will appear here if the model provides it."}</p>
                  </div>
                </details>
              )}
              {explaining && explanation === "" && explainerThinking === "" && (
                <div className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
                  <Spinner className="size-4" />
                  Generating explanation…
                </div>
              )}
              {explanation !== "" && (
                <MarkdownContent markdown={explanation} className="break-words text-sm leading-6 text-foreground" />
              )}
          </div>
          {(explaining || explanation !== "" || explainError !== "") && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
                <p className="min-w-0 truncate text-xs text-muted-foreground">
                  {explainerModel !== "" ? `Generated by ${explainerModel}${explainerReasoningEffort !== null ? ` - ${explainerReasoningEffort}` : ""}` : ""}
                </p>
                <div className="flex items-center gap-2">
                  {explaining ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={cancelExplanation}
                      aria-label="Cancel explanation generation"
                    >
                      Cancel
                    </Button>
                  ) : (
                    explanation !== "" || explainError !== "" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={(): void => { void handleExplain(explainerKind, true); }}
                        aria-label={explanation !== "" ? "Regenerate the explanation" : "Try generating the explanation again"}
                        title={explanation !== "" ? "Regenerate" : "Try again"}
                      >
                        <RotateCcw data-icon="inline-start" className="size-4" aria-hidden="true" />
                        {explanation !== "" ? "Regenerate" : "Try again"}
                      </Button>
                    ) : null
                  )}
                </div>
              </div>
          )}
        </DialogContent>
      </Dialog>

      {fullscreenLog !== null && (
        <div
          ref={fullscreenContainerRef}
          role="dialog"
          aria-modal="true"
          aria-label={fullscreenLog === "plan" ? "Raw plan log" : "Raw apply log"}
          className="fixed inset-0 z-50 flex flex-col bg-background"
        >
          <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
            <h2 className="text-sm font-semibold text-foreground">
              {fullscreenLog === "plan" ? "Raw plan log" : "Raw apply log"}
            </h2>
            <Button
              ref={fullscreenCloseRef}
              type="button"
              variant="ghost"
              size="sm"
              onClick={(): void => { setFullscreenLog(null); }}
              aria-label="Close fullscreen log"
            >
              <X className="size-4" aria-hidden="true" />
              Close
            </Button>
          </div>
          <pre className={`flex-1 overflow-auto ${logWrap ? "whitespace-pre-wrap" : "whitespace-pre"} bg-code-background p-4 font-mono text-xs leading-5 text-code-foreground`}>
            {fullscreenLog === "plan"
              ? planLogs !== "" ? planLogs : planRawLogMessage
              : applyLogs !== "" ? applyLogs : applyRawLogMessage}
          </pre>
        </div>
      )}
    </div>
  );
}
