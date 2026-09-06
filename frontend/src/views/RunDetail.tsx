import { Terrence } from "../components/brand/Terrence";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  Copy,
  History,
  Info,
  Link2,
  Maximize2,
  Play,
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
import { DiagnosticsBanner } from "../components/DiagnosticsBanner";
import { extractDiagnostics, type TerraformDiagnostic } from "../lib/diagnostics";
import { cn, copyTextToClipboard, formatDateTime, formatRelativeTime } from "@/lib/utils";
import { safeHttpUrl } from "@/lib/safe-url";
import { truncateLogForDisplay } from "../lib/log-display";
import { ApplyOutput } from "../components/ApplyOutput";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
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
import { CAPABILITY_PLAN_EXPLAINER, useCapability } from "../lib/capabilities";
import { useUnsavedChangesWarning } from "../lib/use-unsaved-changes";
import { isBigInt, isBoolean, isNumber, isObjectLike, isString } from "../lib/type-guards";
import { formatRunSource, formatRunStatus, isVcsRunSource } from "../lib/run-labels";
import { StatusBadge } from "../components/ui/status-badge";
import { RunLogOutput } from "../components/RunLogOutput";
import { RunDecisionPanel } from "../components/RunDecisionPanel";
import { RecoveryWorkbench } from "../components/RecoveryWorkbench";
import { RunStageStrip, resolveStages } from "../components/RunStageStrip";
import { ACTION_CONFIRMATIONS, resolveRunDecision, type RunActionKind } from "../lib/run-decision";
import { useRunView } from "../lib/use-run-view";
import { sectionLabel, TERMINAL_STATUSES, type PolicyCheck, type RunComment, type RunEvent } from "../lib/run-view-state";
import { formatPhaseState, phaseTone, resolvePhaseStatus, resolveRunDisplay, TONE_ACCENT } from "../lib/run-status";
import { Disclosure } from "../components/ui/disclosure";
import { MetaList } from "../components/ui/meta-list";
import type { JsonObject } from "@/lib/json";

const RUN_EVENT_LABELS = {
  apply: "Run confirmed",
  cancel: "Run canceled",
  create: "Run created",
  discard: "Run discarded",
  "force-cancel": "Run force canceled",
  "override-policy": "Policy check overridden",
};

function formatDate(value: string | undefined): string {
  if (value === undefined || value === "") return "—";
  const date = new Date(value);
  return formatDateTime(date);
}

function timestampMilliseconds(key: string, value: string | undefined): number | undefined {
  // status-timestamps also carries plan metadata (for example
  // input-state-serial and saved-plan-sha256).  Numeric metadata is accepted
  // by Date.parse and can otherwise turn a 9-minute run into millennia.
  if (!key.endsWith("-at") || value === undefined) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function formatDurationMilliseconds(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return "Unavailable";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "Less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${remainder === 0 ? "" : ` ${remainder} min`}`;
}

function formatDuration(start: string | undefined, end: string | undefined): string {
  if (start === undefined || end === undefined) return "Unavailable";
  return formatDurationMilliseconds(Date.parse(end) - Date.parse(start));
}

const PLAN_DURATION_END_KEYS = [
  "planned-at",
  "planned-and-finished-at",
  "planned-and-saved-at",
  "errored-at",
  "unreachable-at",
  "canceled-at",
  "force-canceled-at",
] as const;
const APPLY_DURATION_END_KEYS = [
  "applied-at",
  "errored-at",
  "unreachable-at",
  "canceled-at",
  "force-canceled-at",
] as const;

type RunProvenanceManifest = Readonly<{
  schemaVersion: number;
  runId: string;
  configuration: Readonly<{ versionId: string | null; digest: string; source: string | null; commitSha: string | null; branch: string | null }>;
  engine: Readonly<{ binary: string; version: string | null; digest: string | null }>;
  workspace: Readonly<{ workingDirectory: string | null; executionMode: string }>;
  inputState: Readonly<{ id: string | null; digest: string | null }>;
  variables: readonly Readonly<{ key: string; category: string; source: string; sensitive: boolean }>[];
  sandbox: Readonly<{ required: boolean; networkPolicy: string; executor: string }>;
  rerun?: Readonly<{ mode: "original" | "current"; sourceRunId: string; changedSinceSource: readonly string[] }>;
}>;

type RunTaskStage = Readonly<{
  attributes?: Readonly<{ status?: unknown }>;
}>;

function taskOutcomeLabel(value: unknown): string {
  if (!Array.isArray(value)) return "Unavailable";
  if (value.length === 0) return "No task stages";
  const statuses = value.map((item: unknown): string => {
    const status = (item as RunTaskStage | null)?.attributes?.status;
    return isString(status) ? status : "unknown";
  });
  if (statuses.some((status: string): boolean => ["failed", "errored", "unreachable"].includes(status))) return "Failed";
  if (statuses.some((status: string): boolean => ["running"].includes(status))) return "Running";
  if (statuses.some((status: string): boolean => ["pending", "queued"].includes(status))) return "Queued";
  if (statuses.every((status: string): boolean => ["passed", "overridden"].includes(status))) return "Passed";
  return "Reported";
}

function firstTimestampMilliseconds(
  timestamps: Readonly<Record<string, string>>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = timestampMilliseconds(key, timestamps[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function runExecutionDurationMilliseconds(
  timestamps: Readonly<Record<string, string>>,
  planOnly: boolean,
  now = Date.now(),
): number | undefined {
  const planStart = timestampMilliseconds("planning-at", timestamps["planning-at"])
    ?? timestampMilliseconds("pending-at", timestamps["pending-at"])
    ?? timestampMilliseconds("planned-at", timestamps["planned-at"]);
  const planEnd = firstTimestampMilliseconds(timestamps, PLAN_DURATION_END_KEYS);
  if (planStart === undefined) return undefined;
  const planDuration = planEnd === undefined
    ? Math.max(0, now - planStart)
    : Math.max(0, planEnd - planStart);
  if (planOnly) return planDuration;

  const applyStart = timestampMilliseconds("applying-at", timestamps["applying-at"]);
  if (applyStart === undefined) {
    const legacyEnd = timestampMilliseconds("applied-at", timestamps["applied-at"]);
    if (legacyEnd !== undefined) {
      return Math.max(0, legacyEnd - planStart);
    }
    return planDuration;
  }
  const applyEnd = firstTimestampMilliseconds(timestamps, APPLY_DURATION_END_KEYS);
  return planDuration + (applyEnd === undefined
    ? Math.max(0, now - applyStart)
    : Math.max(0, applyEnd - applyStart));
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

function formatMonthlyCost(value: string | undefined, currency = "USD", timeBasis = "monthly"): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const normalizedCurrency = /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  const normalizedBasis = /^[A-Za-z0-9 _-]{1,32}$/.test(timeBasis) ? timeBasis : "period";
  return `${new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: normalizedCurrency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)} / ${normalizedBasis === "monthly" ? "month" : normalizedBasis}`;
}

function policyResultText(result: unknown): string {
  if (result === null || result === undefined) return "No detailed result";
  if (isString(result)) return result;
  if (isNumber(result) || isBoolean(result) || isBigInt(result)) return `${result}`;
  if (!isObjectLike(result)) return "No detailed result";
// SAFETY: the fixture object is read as a record; each field is typed below.
  const details = result as JsonObject;
  const summary: string[] = [];
  if (isString(details["policy"])) summary.push(details["policy"]);
  if (isString(details["error"])) summary.push(details["error"]);
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
    if (isNumber(count) && count > 0) {
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
  // SAFETY: the run result payload is read as a record; the advisory-failed
  // field is typeof-validated before the comparison.
  return result !== null
    && isObjectLike(result)
    && !Array.isArray(result)
    && isNumber((result as JsonObject)["advisory-failed"])
    && ((result as JsonObject)["advisory-failed"] as number) > 0;
}

/**
 * Phase icons take their colour from the shared tone map so the plan and apply
 * headings, the header badge and the stage strip cannot land on three
 * different colours for one run.
 */
function PhaseIcon({ status }: Readonly<{ status: string }>): React.JSX.Element {
  const accent = TONE_ACCENT[phaseTone(status)];
  if (status === "finished") return <CheckCircle2 className={cn("size-5", accent)} aria-hidden="true" />;
  if (status === "errored" || status === "unreachable") return <XCircle className={cn("size-5", accent)} aria-hidden="true" />;
  if (status === "canceled") return <AlertCircle className={cn("size-5", accent)} aria-hidden="true" />;
  if (status === "running") {
    return (
      <span className="relative flex size-5 items-center justify-center">
        <Spinner className={cn("size-5 motion-reduce:animate-none", accent)} aria-label="Phase running" />
      </span>
    );
  }
  if (status === "queued") return <Clock className={cn("size-5", accent)} aria-hidden="true" />;
  return <Circle className="size-5 text-muted-foreground/40" aria-hidden="true" />;
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
    || !isNumber(additions)
    || !isNumber(changes)
    || !isNumber(destructions)) {
    return (
      <span className="text-xs font-medium text-muted-foreground">
        {pending ? "Resources pending" : "Resources unavailable"}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium">
      {isNumber(imports) && imports > 0 && <span className="text-foreground">&amp;{imports} to import</span>}
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
}: Readonly<{
  phase: "plan" | "apply";
  status: string;
  timestamps: Readonly<Record<string, string>>;
  logUrl: string | null | undefined;
}>): React.JSX.Element {
  const started = timestamps[phase === "plan" ? "planning-at" : "applying-at"];
  const completed = status === "running" ? undefined : (phase === "plan"
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
  const hasLogUrl = !["pending", "queued"].includes(status) && safeHttpUrl(logUrl) !== null;
  const phaseDurationLabel = started !== undefined && completed !== undefined
    ? formatDuration(started, completed)
    : null;
  if (started === undefined && completed === undefined && !hasLogUrl) return <></>;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {started !== undefined && (
        <span>Started <time dateTime={started} title={formatDateTime(started)}>{formatRelativeTime(started)}</time></span>
      )}
      {completed !== undefined && (
        <span>{completedLabel} <time dateTime={completed} title={formatDateTime(completed)}>{formatRelativeTime(completed)}</time>{phaseDurationLabel !== null && phaseDurationLabel !== "Unavailable" && (<span title="Phase duration"> · {phaseDurationLabel}</span>)}</span>
      )}
      {hasLogUrl && <span>Raw log available</span>}
    </div>
  );
}

function RunLogDisclosure({ label, status, children }: Readonly<{
  label: string;
  status: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? ["running", "errored", "unreachable"].includes(status);
  return (
    <Disclosure label={label} open={open}
      onToggle={(next): void => { if (next !== open) setExpanded(next); }}
      className="rounded-none border-0" summaryClassName="pr-16" bodyClassName="border-0"
    >
      {children}
    </Disclosure>
  );
}

export async function waitForAbortableDelay(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise<boolean>((resolve): void => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => { finish(false); };
    const timer = window.setTimeout((): void => { finish(true); }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) finish(false);
  });
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
  // One hook owns the run and every section derived from it. See useRunView
  // for why the page used to disagree with itself.
  const { state: view, refreshAll, refresh, markActionSent, markActionSettled } = useRunView(runId);
  const {
    run,
    plan,
    apply,
    cost: costEstimate,
    policyChecks,
    assessments: assessmentChecks,
    events: runEvents,
    comments,
    loading,
    loadError,
    fresh,
    failedSections,
    creatorUsername,
    creatorAvatarUrl,
    awaitingAction,
  } = view;
  const planLogs = view.planLog.text;
  const applyLogs = view.applyLog.text;
  const [rerunPending, setRerunPending] = useState(false);
  const [rerunError, setRerunError] = useState("");
  const [rerunDialogOpen, setRerunDialogOpen] = useState(false);
  const [fullscreenLog, setFullscreenLog] = useState<"plan" | "apply" | null>(null);
  // Focus management for the fullscreen log dialog: remember
  // whichever control opened it so focus can return there after close.
  const fullscreenTriggerRef = useRef<HTMLElement | null>(null);
  const fullscreenCloseRef = useRef<HTMLButtonElement | null>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement | null>(null);
  const [planExpanded, setPlanExpanded] = useState<boolean | null>(null);
  const [applyExpanded, setApplyExpanded] = useState<boolean | null>(null);
  const planOpenRendered = useRef<boolean>(false);
  const applyOpenRendered = useRef<boolean>(false);
  const [commentBody, setCommentBody] = useState("");
  const [speculativeRun, setSpeculativeRun] = useState(false);
  const cvId = run?.relationships?.["configuration-version"]?.data?.id ?? null;
  const planOnlyRun = run?.attributes["plan-only"] === true;

  // Speculative plans never apply (issue #603): the run row only carries
  // plan-only, so resolve the speculative flag from its configuration
  // version. Best effort; a failed lookup simply shows no badge.
  useEffect((): (() => void) => {
    setSpeculativeRun(false);
    if (!planOnlyRun || cvId === null) return () => {};
    const controller = new AbortController();
    fetchApi(`/api/v2/configuration-versions/${cvId}`, { signal: controller.signal })
      .then((data: unknown): void => {
        if (controller.signal.aborted) return;
// SAFETY: the configuration-version endpoint returns the JSON:API envelope; speculative is read as unknown below.
        const attrs = (data as { data?: { attributes?: { speculative?: unknown } } })?.data?.attributes;
        setSpeculativeRun(attrs?.speculative === true);
      })
      .catch((): void => {});
    return (): void => { controller.abort(); };
  }, [runId, planOnlyRun, cvId]);
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
  const [provenanceManifest, setProvenanceManifest] = useState<RunProvenanceManifest | null>(null);
  const [provenanceError, setProvenanceError] = useState("");
  const [taskOutcome, setTaskOutcome] = useState("No task result");
  useEffect((): (() => void) => {
    const controller = new AbortController();
    setTaskOutcome("Loading…");
    fetchApi(`/api/v2/runs/${encodeURIComponent(runId)}/task-stages`, { signal: controller.signal })
      .then((payload: unknown): void => {
        if (controller.signal.aborted) return;
        setTaskOutcome(taskOutcomeLabel((payload as { data?: unknown }).data));
      })
      .catch((): void => {
        if (!controller.signal.aborted) setTaskOutcome("Unavailable");
      });
    return (): void => { controller.abort(); };
  }, [runId]);
  useEffect((): (() => void) => {
    const controller = new AbortController();
    setProvenanceManifest(null);
    setProvenanceError("");
    fetchApi(`/api/v2/runs/${encodeURIComponent(runId)}/provenance`, { signal: controller.signal })
      .then((payload: unknown): void => {
        if (controller.signal.aborted) return;
        const data = (payload as { data?: { attributes?: { manifest?: unknown } } }).data?.attributes?.manifest;
        if (data !== null && typeof data === "object" && !Array.isArray(data)) setProvenanceManifest(data as RunProvenanceManifest);
      })
      .catch((error: unknown): void => {
        if (!controller.signal.aborted) setProvenanceError(error instanceof Error ? error.message : String(error));
      });
    return (): void => { controller.abort(); };
  }, [runId]);
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
  const [pendingAction, setPendingAction] = useState("");
  const [copiedPermalink, setCopiedPermalink] = useState(false);
  const copiedPermalinkResetTimerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  const [logWrap, setLogWrap] = useState<boolean>(true);
  const [planSummary, setPlanSummary] = useState<Readonly<{
    runId: string;
    summary: PlanOutputSummary;
  }> | null>(null);
  const handlePlanSummaryChange = useCallback((summary: PlanOutputSummary | null): void => {
    setPlanSummary(summary === null ? null : { runId, summary });
  }, [runId]);

  const runPermalink = `${window.location.origin}${orgPath}/workspaces/${encodeURIComponent(workspaceName)}/runs/${encodeURIComponent(runId)}`;

  useEffect((): (() => void) => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      if (copiedPermalinkResetTimerRef.current !== undefined) window.clearTimeout(copiedPermalinkResetTimerRef.current);
    };
  }, []);

  async function copyRunPermalink(): Promise<void> {
    const didCopy = await copyTextToClipboard(runPermalink);
    if (!mountedRef.current) return;
    if (didCopy) {
      setCopiedPermalink(true);
      toast.add({ title: "Run permalink copied", type: "success" });
      if (copiedPermalinkResetTimerRef.current !== undefined) window.clearTimeout(copiedPermalinkResetTimerRef.current);
      copiedPermalinkResetTimerRef.current = window.setTimeout((): void => {
        copiedPermalinkResetTimerRef.current = undefined;
        setCopiedPermalink(false);
      }, 2000);
      return;
    }
    toast.add({ title: "Could not copy link", type: "error" });
  }

  // The bare run ID (not the permalink) is what people paste into tickets and
  // the CLI. It used to live in the workspace header that wrapped this page;
  // now that a run is its own page, the affordance belongs here.
  async function copyRunId(): Promise<void> {
    const didCopy = await copyTextToClipboard(runId);
    if (!mountedRef.current) return;
    if (didCopy) {
      toast.add({ title: "Run ID copied", type: "success" });
      return;
    }
    toast.add({ title: "Could not copy run ID", type: "error" });
  }

  useEffect((): (() => void) => {
    if (fullscreenLog === null) return () => {};
    // The overlay renders after this effect commits, so the close button ref
    // is already populated; move focus into the dialog. Remember the trigger
    // so cleanup can hand focus back when the dialog goes away.
// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
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


  /**
   * Send a run action.
   *
   * `markActionSent` records that the run was asked to move, so the decision
   * panel reports the action as in flight until the run's status actually
   * changes. Without it, the refresh that follows the POST usually lands
   * before the worker has picked the job up, so the page re-rendered the same
   * "Apply changes" button it had just accepted a click on — which reads as
   * the click having failed.
   */
  const performRunAction = useCallback(async (
    action: RunActionKind,
    successTitle: string,
    comment = "",
  ): Promise<boolean> => {
    setPendingAction(action);
    try {
      const trimmedComment = comment.trim();
      const actionBody = {
        method: "POST",
        ...(trimmedComment !== "" ? {
          body: JSON.stringify({
            data: {
              type: "runs",
              attributes: { comment: trimmedComment },
            },
          }),
        } : undefined),
      };
      await fetchApi(`/api/v2/runs/${runId}/actions/${action}`, actionBody);
      toast.add({ title: successTitle, type: "success" });
      markActionSent(action);
      return true;
    } catch (error: unknown) {
      toast.add({
        title: error instanceof Error ? error.message : `Failed to ${action.replace("-", " ")} run`,
        type: "error",
      });
      // The action never took, so the page must go back to offering it.
      markActionSettled();
      refreshAll();
      return false;
    } finally {
      setPendingAction("");
    }
  }, [runId, markActionSent, markActionSettled, refreshAll]);

  const handleDecisionConfirm = useCallback((action: RunActionKind, comment: string): void => {
    void performRunAction(action, ACTION_CONFIRMATIONS[action].successTitle, comment);
  }, [performRunAction]);

  // Durable: non-stream POST enqueues a background job (tab-close safe).
  // The GET polls that job until the cached explanation appears. Abort-aware
  // so cancel/unmount stops polling and prevents setState after abort.
  async function pollExplanationUntilReady(kind: ExplainKind, signal: AbortSignal, timeoutMs = 180_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal.aborted) return false;
      const { fetchExplanation } = await import("../lib/api");
      const row = await fetchExplanation(runId, kind).catch((): null => null);
      if (signal.aborted) return false;
      if (row !== null && row.explanation !== "") {
        setExplanation(row.explanation);
        setExplainerModel(row.model);
        setExplainerReasoningEffort(row.reasoningEffort);
        return true;
      }
      if (row !== null && row.status === "failed") {
        setExplainError("Plan explainer failed. Check the endpoint, model, and API key, then try again.");
        return false;
      }
      if (Date.now() >= deadline) return false;
      const retry = await waitForAbortableDelay(signal, 1500);
      if (!retry) return false;
    }
  }

  // Plain-language explanation of the stored plan JSON or a
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
    let sawProgress = false;
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
          } else if (event.name === "progress") {
            sawProgress = true;
          } else if (event.name === "thinking") {
            setExplainerThinking((current): string => `${current}${event.data.text}`);
          } else if (event.name === "content") {
            setExplanation((current): string => `${current}${event.data.text}`);
          } else if (event.name === "content-reset") {
            setExplanation(event.data.text);
          }
        },
        controller.signal,
      );
      // Durable job enqueued: poll GET until the cached explanation lands.
      if (sawProgress && explainerAbortRef.current === controller) {
        const ready = await pollExplanationUntilReady(kind, controller.signal);
        if (!ready && explainerAbortRef.current === controller && !controller.signal.aborted) {
          const { enqueueExplanation } = await import("../lib/api");
          await enqueueExplanation(runId, kind).catch((): null => null);
          await pollExplanationUntilReady(kind, controller.signal);
        }
      }
    } catch (caught: unknown) {
      if (controller.signal.aborted) {
        return;
      }
      const msg = caught instanceof Error ? caught.message : String(caught);
      const isProgressStream = sawProgress || /without a done event/i.test(msg);
      if (isProgressStream && !controller.signal.aborted) {
        const ready = await pollExplanationUntilReady(kind, controller.signal).catch((): boolean => false);
        if (ready) return;
      }
      // 202/queued path: enqueue durably and poll; closing the tab no longer aborts the LLM call.
      if (caught instanceof ApiError && (caught.status === 202 || /queued|job/i.test(caught.message))) {
        try {
          if (controller.signal.aborted) return;
          const { enqueueExplanation } = await import("../lib/api");
          await enqueueExplanation(runId, kind);
          const ready = await pollExplanationUntilReady(kind, controller.signal);
          if (ready) return;
        } catch (enqueueErr) {
          if (controller.signal.aborted || explainerAbortRef.current !== controller) return;
          console.error("Failed to enqueue explanation:", enqueueErr);
          setExplainError(enqueueErr instanceof Error ? enqueueErr.message : "Failed to enqueue explanation.");
          return;
        }
      }
      setExplainError(msg);
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
      // Only the comment list changed; reloading the whole run to see it was
      // eight redundant requests per comment.
      refresh(["comments"]);
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

  // Terraform warnings and errors embedded in the phase logs surface as
  // colored bubbles; they do not affect run or phase status. Declared before
  // the early returns so the hook count stays stable across loading states.
  const planDiagnostics = useMemo(
    (): TerraformDiagnostic[] => extractDiagnostics(planLogs),
    [planLogs],
  );
  const planWarnings = useMemo(
    (): TerraformDiagnostic[] => planDiagnostics.filter((diag) => diag.severity === "warning"),
    [planDiagnostics],
  );
  const planErrors = useMemo(
    (): TerraformDiagnostic[] => planDiagnostics.filter((diag) => diag.severity === "error"),
    [planDiagnostics],
  );
  const applyDiagnostics = useMemo(
    (): TerraformDiagnostic[] => extractDiagnostics(applyLogs),
    [applyLogs],
  );
  const applyWarnings = useMemo(
    (): TerraformDiagnostic[] => applyDiagnostics.filter((diag) => diag.severity === "warning"),
    [applyDiagnostics],
  );
  const applyErrors = useMemo(
    (): TerraformDiagnostic[] => applyDiagnostics.filter((diag) => diag.severity === "error"),
    [applyDiagnostics],
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
        <Button className="mt-3" variant="outline" onClick={(): void => { refreshAll(); }}>
          Try again
        </Button>
      </div>
    );
  }

  const attributes = run.attributes;
  const { actions, status } = attributes;
  const permissions = attributes.permissions;
  const canApply = fresh
    && actions?.["is-confirmable"] === true
    && permissions?.["can-apply"] === true;
  const canComment = fresh && permissions?.["can-comment"] === true;

  // The run's single pending decision. Everything that used to derive its own
  // answer from the raw status — the header, the apply heading, the action
  // buttons, the bottom warning panel — now reads this.
  const decision = resolveRunDecision(attributes, {
    fresh,
    speculative: speculativeRun,
    awaitingAction,
  });

  // Statuses where a run is actively heading toward apply; re-running another
  // run from this page while one is in flight would queue a duplicate.
  const runInFlight = [
    "pending", "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed",
    "queuing", "plan_queued", "planning", "cost_estimating", "cost_estimated",
    "policy_checking", "policy_override", "policy_checked", "post_plan_running",
    "post_plan_completed", "confirmed", "apply_queued", "applying",
  ].includes(status);

// SAFETY: the fixture matches the JSON:API envelope the component consumes.
  const workspaceId = (run.relationships as { workspace?: { data?: { id?: string } } } | undefined)
    ?.workspace?.data?.id ?? "";
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

  const performRerun = async (mode: "original" | "current"): Promise<void> => {
    if (workspaceId === "" || rerunPending) return;
    setRerunPending(true);
    setRerunError("");
    try {
      const body = await fetchApi(`/api/v2/runs/${encodeURIComponent(runId)}/actions/rerun`, {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const newRunId = (body as { data?: { id?: string } }).data?.id;
      if (isString(newRunId) && newRunId !== "") {
        navigate(`${workspacePath}/runs/${encodeURIComponent(newRunId)}`);
      } else {
        setRerunError("The run was created but the response did not include a run id.");
      }
    } catch (err: unknown) {
      setRerunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunPending(false);
      setRerunDialogOpen(false);
    }
  };

  const timestamps = attributes["status-timestamps"] ?? {};
  const planStatus = resolvePhaseStatus(status, "plan", timestamps, plan?.attributes.status);
  const applyStatus = resolvePhaseStatus(status, "apply", timestamps, apply?.attributes.status);
  // Surface the apply output once it starts, preserving explicit disclosure choices.
  const autoApplyOpen = ["running", "finished", "errored", "unreachable"].includes(applyStatus);
  const autoPlanOpen = !autoApplyOpen && ["running", "finished", "errored", "unreachable"].includes(planStatus);
  const planIsOpen = planExpanded ?? autoPlanOpen;
  planOpenRendered.current = planIsOpen;
  const applyIsOpen = applyExpanded ?? autoApplyOpen;
  applyOpenRendered.current = applyIsOpen;
  const planActionCount = planSummary?.runId === runId ? planSummary.summary.actionCount : null;
  const artifactImportCount = planSummary?.runId === runId ? planSummary.summary.importCount : null;
  const planCounts = plan?.attributes ?? {
    "resource-additions": attributes["resource-additions"],
    "resource-changes": attributes["resource-changes"],
    "resource-destructions": attributes["resource-destructions"],
    "resource-imports": attributes["resource-imports"],
  };
  const backendPlanImportCount = planCounts["resource-imports"];
  const planImportCount = isNumber(backendPlanImportCount)
    ? isNumber(artifactImportCount)
      ? Math.max(backendPlanImportCount, artifactImportCount)
      : backendPlanImportCount
    : artifactImportCount;
  const applyCounts = apply?.attributes;
  const timestampEntries = Object.entries(timestamps)
    .filter(([key, value]): boolean => timestampMilliseconds(key, value) !== undefined);
  const inputStateSerial = timestamps["input-state-serial"];
  const durationMilliseconds = runExecutionDurationMilliseconds(
    timestamps,
    attributes["plan-only"] === true,
  );
  const duration = durationMilliseconds === undefined
    ? planStatus === "finished" ? "Unavailable" : "In progress"
    : formatDurationMilliseconds(durationMilliseconds);
  const durationLabel = attributes["plan-only"] === true ? "Plan duration" : "Plan & apply duration";
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
  // Issue #605: an "unavailable" artifact means estimation is not installed
  // in this image (permanent, not a transient failure). Show the section
  // with a one-line explanation instead of hiding it like a missing estimate.
  const costUnavailable = costStatus === "unavailable";
  const showCostEstimate = costEstimate !== null
    && costAttributes !== undefined
    && costAttributes["terrence:infracost-enabled"] !== false
    && !["skipped", "skipped_due_to_targeting", "disabled"].includes(costStatus);
  const costProvenance = costAttributes?.provenance;
  const costComparison = costAttributes?.comparison;
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
    .some((key: string): boolean => isString(timestamps[key]));
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

  // Why the apply has not started, said once, in the apply section. The
  // reasons the *user* can act on live in the decision panel; this is the
  // descriptive counterpart for the phase that has not begun.
  const applyWaitingReason = showApply
    && !canApply
    && applyStatus === "pending"
    && !applyStarted
    && !TERMINAL_STATUSES.has(status)
    && ["policy_checking", "policy_checked", "post_plan_running", "post_plan_completed", "queuing", "plan_queued", "planning", "pending", "fetching", "pre_plan_running"].includes(status)
    ? "The plan and its checks have to finish before anything can be applied."
    : null;

  const stages = resolveStages(status, timestamps, {
    planOnly: attributes["plan-only"] === true,
    hasPolicyChecks: policyChecks.length > 0,
    executionMode: attributes["execution-mode"],
    positionInQueue: attributes["position-in-queue"],
    scheduledAt: attributes["scheduled-at"],
  });
  const runDisplay = resolveRunDisplay({
    ...attributes,
    status,
    "status-timestamps": timestamps,
  });
  const savedPlanVersion = isString(timestamps["saved-plan-sha256"]) ? timestamps["saved-plan-sha256"] : null;
  const artifactPlanVersion = isString(plan?.attributes["status-timestamps"]?.["saved-plan-sha256"])
    ? plan.attributes["status-timestamps"]["saved-plan-sha256"]
    : null;
  const stalePlanWarning = savedPlanVersion !== null && artifactPlanVersion !== null && savedPlanVersion !== artifactPlanVersion
    ? "The run metadata and plan artifact use different versions. Refresh before making a decision."
    : !fresh
      ? "Run data may be out of date. Refresh before making a decision."
      : failedSections.includes("plan")
        ? "The plan could not be refreshed. Refresh before making a decision."
        : null;
  const decisionContext = {
    planId: `plan-${runId}`,
    planVersion: savedPlanVersion,
    additions: planCounts["resource-additions"],
    changes: planCounts["resource-changes"],
    destructions: planCounts["resource-destructions"],
    age: formatRelativeTime(attributes["created-at"]),
    actor: creatorUsername !== "" ? creatorUsername : attributes["triggered-by"] ?? "System",
    // The badge and policy section already show the raw summary. Prefixing it
    // in the rail keeps the compact context useful without creating a second
    // indistinguishable status announcement for screen readers or tests.
    policyOutcome: policySummary === "not required" ? "Not required" : `Result: ${policySummary}`,
    taskOutcome,
    waitingReason: runDisplay.waitingLabel,
    responsible: runDisplay.responsible,
    staleWarning: stalePlanWarning,
  };

  const baseline = attributes["duration-baseline"];
  const medianSeconds = baseline?.["median-duration-seconds"];
  const slowRunNote = baseline?.["is-slow"] === true && isNumber(medianSeconds)
    ? (
      <span className="font-medium text-warning-text">
        Slower than typical (median {formatDurationSeconds(medianSeconds)})
      </span>
    )
    : null;

  const showCombinedEmptyActivity = TERMINAL_STATUSES.has(status)
    && runEvents.length === 0
    && comments.length === 0;

  const commentForm = canComment ? (
    <form onSubmit={(event): void => { void handleCommentSubmit(event); }} className="border-t border-border p-5">
      <label htmlFor="run-comment" className="mb-2 block text-sm font-medium text-foreground">Add a comment</label>
      <Textarea
        id="run-comment"
        name="run-comment"
        autoComplete="off"
        spellCheck={false}
        rows={3}
        value={commentBody}
        onChange={(event): void => { setCommentBody(event.target.value); }}
        placeholder="Share context about this run"
      />
      <div className="mt-2 flex justify-end">
        <Button type="submit" disabled={commentBody.trim() === "" || pendingAction !== ""}>Add comment</Button>
      </div>
    </form>
  ) : null;

  return (
    <>
      {/* The background page goes inert while the fullscreen log overlay is
          open so assistive tech cannot walk out of the modal (issue #625). */}
      <div className="mx-auto w-full max-w-[1600px]" inert={fullscreenLog !== null}>
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
          onAction={(): void => { refreshAll(); }}
        />
      )}
      {fresh && failedSections.length > 0 && (
        <DegradedBanner
          // Naming the sections beats "some run details": the reader can tell
          // whether the part they came for is the stale one.
          title={`Could not refresh ${failedSections.map(sectionLabel).join(", ")}. The rest of this page is current.`}
          actionLabel="Try again"
          onAction={(): void => { refreshAll(); }}
        />
      )}

      <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {/* One badge, one status vocabulary (lib/run-status). The page used
                to hand-roll this mapping here and in six other places. */}
            <StatusBadge status={status} className="rounded" />
            <span aria-live="polite" className="sr-only">Run status: {formatRunStatus(status)}</span>
            {attributes["plan-only"] === true && <Badge variant="outline" className="rounded">Plan only</Badge>}
            {speculativeRun && <Badge variant="outline" className="rounded" title="This speculative plan never applies">Speculative</Badge>}
            {attributes["is-destroy"] === true && <Badge variant="destructive" className="rounded">Destroy</Badge>}
            {attributes["refresh-only"] === true && <Badge variant="outline" className="rounded text-primary border-primary/30 bg-primary/10">Refresh only</Badge>}
            {attributes["allow-empty-apply"] === true && <Badge variant="outline" className="rounded text-primary border-primary/30 bg-primary/10">Allow empty apply</Badge>}
          </div>
          {/* A run page is now its own page rather than a panel nested under the
              workspace header, so its title is the document's h1. */}
          <h1 className="break-words text-2xl font-semibold tracking-tight sm:text-3xl text-foreground">
            {attributes.message ?? "Manual run"}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <p>
            {formatRunSource(attributes.source, attributes["trigger-reason"])} · Created {formatDate(attributes["created-at"])}
          </p>
          <div className="flex items-center gap-1">
            <span>Run ID:</span>
            <code className="select-all font-mono">{runId}</code>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Copy run ID"
              onClick={(): void => { void copyRunId(); }}
            >
              <Copy aria-hidden="true" />
            </Button>
          </div>
          {isVcsRunSource(attributes.source, attributes["trigger-reason"]) && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{isString(attributes.branch) ? attributes.branch : "Default branch"}</span>
              {attributes["commit-sha"] !== undefined && attributes["commit-sha"] !== null && attributes["commit-sha"] !== "" && (
                isString(attributes["commit-url"]) && safeHttpUrl(attributes["commit-url"]) !== null ? (
                  <a
                    href={safeHttpUrl(attributes["commit-url"]) ?? undefined}
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
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 lg:max-w-sm lg:justify-end">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            aria-label="Copy run permalink"
            onClick={(): void => { void copyRunPermalink(); }}
          >
            <Link2 className="size-3.5" aria-hidden="true" />
            {copiedPermalink ? "Copied" : "Copy link"}
          </Button>
          {/* Starting a fresh run used to come from the workspace header that
              wrapped this page. Re-run is permission-gated, so keep an
              unconditional route to the new-run form. */}
          <Link
            to={`${workspacePath}/runs?new-run=true`}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
          >
            <Play className="size-3.5" aria-hidden="true" />
            New run
          </Link>
          {(canRerun || rerunBlockedReason !== null) && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={!canRerun || rerunPending || pendingAction !== ""}
              title={rerunBlockedReason ?? undefined}
              onClick={(): void => { setRerunDialogOpen(true); }}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {rerunPending ? "Queuing…" : "Re-run"}
            </Button>
          )}
          {rerunBlockedReason !== null && (
            <span className="w-full text-xs text-muted-foreground lg:text-right">{rerunBlockedReason}</span>
          )}
          {rerunError !== "" && (
            <p role="alert" className="w-full text-xs text-destructive">{rerunError}</p>
          )}
          {/* Cancel, force cancel, apply, discard and override all live in the
              decision panel below. They used to be split between here and a
              panel at the foot of the page, with a third block explaining why
              the ones here were missing. */}
          </div>
      </header>

      <Dialog open={rerunDialogOpen} onOpenChange={setRerunDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Choose rerun inputs</DialogTitle>
            <DialogDescription>
              A rerun creates a new run. Choose the immutable inputs captured for this run, or the workspace settings currently configured.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" disabled={rerunPending} onClick={(): void => { void performRerun("original"); }}>
              Original inputs
            </Button>
            <Button type="button" disabled={rerunPending} onClick={(): void => { void performRerun("current"); }}>
              Current settings
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <RunStageStrip stages={stages} className="mb-5" />

      {attributes["has-recovery-state"] === true && (
        <RecoveryWorkbench
          runId={runId}
          formatSupported={attributes["recovery-state-format-supported"] !== false}
          onRecoveryComplete={refreshAll}
          onFreshPlan={(): void => { void performRerun("current"); }}
        />
      )}

      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
      <div className="order-2 min-w-0 space-y-5 xl:order-1">
          <details
            aria-labelledby="plan-heading"
            className="group overflow-hidden rounded-lg border border-border bg-card"
            open={planIsOpen}
            onToggle={(event): void => {
              if (event.currentTarget.open !== planOpenRendered.current) {
                setPlanExpanded(event.currentTarget.open);
              }
            }}
          >
            <summary className="cursor-pointer list-none px-5 py-4 group-open:border-b group-open:border-border hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <ChevronRight className="size-4 text-muted-foreground/70 transition-transform group-open:rotate-90" aria-hidden="true" />
                  <PhaseIcon status={planStatus} />
                  <h3 id="plan-heading" className="font-semibold text-foreground">
                    Plan{" "}
                    <span className="ml-2 font-normal text-muted-foreground">{formatPhaseState(planStatus)}</span>
                  </h3>
                  {["finished", "planned_and_saved"].includes(planStatus) && planExplainerEnabled && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
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
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <PhaseMeta
                    phase="plan"
                    status={planStatus}
                    timestamps={{ ...timestamps, ...plan?.attributes["status-timestamps"] }}
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

            {["errored", "failed", "unreachable"].includes(planStatus) && (
              <div className="flex items-center gap-4 border-b border-destructive/20 bg-destructive/5 px-5 py-3">
                <Terrence pose="failed" detail="small" className="w-24 shrink-0" />
                <div><p className="font-medium text-destructive">Plan failed</p><p className="mt-1 text-sm text-muted-foreground">Review the diagnostics and logs below before starting another run.</p></div>
              </div>
            )}
            {planWarnings.length > 0 && (
              <DiagnosticsBanner severity="warning" diagnostics={planWarnings} collapsible />
            )}

            {planErrors.length > 0 && (
              <DiagnosticsBanner severity="error" diagnostics={planErrors} collapsible />
            )}

            <PlanOutput
              runId={runId}
              status={status}
              planStatus={planStatus}
              onSummaryChange={handlePlanSummaryChange}
            />

            <div id="plan-log-viewer" className="relative border-t border-border">
              <RunLogDisclosure key={`plan-${runId}`} label="Raw plan log" status={planStatus}>
              <RunLogOutput
                active={planStatus === "running"}
                phase="plan"
                truncated={view.planLog.truncated}
                wrap={logWrap}
                onToggleWrap={() => { setLogWrap((wrap) => !wrap); }}
                logUrl={plan?.attributes["log-read-url"]}
                onPhaseChange={(next): void => {
                  document.getElementById(`${next}-log-viewer`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className={`max-h-[420px] overflow-auto ${logWrap ? "whitespace-pre-wrap" : "whitespace-pre"} border-t border-code-background bg-code-background p-4 font-mono text-xs leading-5 text-code-foreground`}
              >
                {planLogs !== "" ? truncateLogForDisplay(planLogs) : planRawLogMessage}
              </RunLogOutput>
              </RunLogDisclosure>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-5 top-1.5"
                onClick={(): void => { setFullscreenLog("plan"); }}
                aria-label="Open raw plan log fullscreen"
              >
                <Maximize2 className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </details>

          {showCostEstimate && (
          <section aria-labelledby="cost-heading" className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="flex items-center gap-3">
                {costPending ? (
                  <Clock className="size-5 text-primary" aria-hidden="true" />
                ) : costFailed ? (
                  <XCircle className="size-5 text-destructive" aria-hidden="true" />
                ) : costUnavailable ? (
                  <Info className="size-5 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="size-5 text-muted-foreground/70" aria-hidden="true" />
                )}
                <h3 id="cost-heading" className="font-semibold text-foreground">Cost estimation</h3>
              </div>
              <Badge variant={costFailed ? "destructive" : "secondary"} className="rounded capitalize">{costStatus}</Badge>
            </div>
            {costAttributes !== undefined && (
              <dl aria-label="Cost estimate details" className="grid grid-cols-2 gap-4 border-t border-border px-5 py-4 text-sm md:grid-cols-4">
                {!costUnavailable && (
                  <>
                <div>
                  <dt className="text-xs text-muted-foreground">{costBaselineComparable ? `Prior ${costTimeBasis}` : "Baseline"}</dt>
                  <dd className="mt-1 font-medium">{costBaselineComparable ? formatMonthlyCost(costAttributes["prior-monthly-cost"], costCurrency, costTimeBasis) : "Not comparable"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Proposed {costTimeBasis}</dt>
                  <dd className="mt-1 font-medium">{formatMonthlyCost(costAttributes["proposed-monthly-cost"], costCurrency, costTimeBasis)}</dd>
                </div>
                {costBaselineComparable && (
                  <div>
                    <dt className="text-xs text-muted-foreground">{costTimeBasis} delta</dt>
                    <dd className="mt-1 font-medium">{formatMonthlyCost(costAttributes["delta-monthly-cost"], costCurrency, costTimeBasis)}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs text-muted-foreground">Priced resources</dt>
                  <dd className="mt-1 font-medium">
                    {costAttributes["matched-resources-count"] ?? 0} of {costAttributes["resources-count"] ?? 0}
                  </dd>
                </div>
                  </>
                )}
                {((costAttributes["error-message"] !== null && costAttributes["error-message"] !== undefined) || costUnavailable) && (
                  <div className={costUnavailable ? "col-span-full text-muted-foreground" : "col-span-full text-destructive"}>{costAttributes["error-message"] ?? "Cost estimation is not installed in this image."}</div>
                )}
              </dl>
            )}
            {costProvenance !== undefined && (
              <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
                Pricing provenance: {costProvenance.tool ?? "estimator"}{costProvenance.version === null || costProvenance.version === undefined ? "" : ` ${costProvenance.version}`}
                {costProvenance.currency === null || costProvenance.currency === undefined ? "" : ` · ${costProvenance.currency}`}
                {costProvenance["time-basis"] === null || costProvenance["time-basis"] === undefined ? "" : ` · ${costProvenance["time-basis"]}`}
                {costProvenance["pricing-date"] === null || costProvenance["pricing-date"] === undefined ? "" : ` · pricing ${costProvenance["pricing-date"]}`}
              </p>
            )}
            {costWarnings.length > 0 && (
              <div role="note" className="border-t border-warning/30 bg-warning/5 px-5 py-3 text-xs text-warning-text">
                <p className="font-medium">Estimate caveats</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">{costWarnings.map((warning): React.JSX.Element => <li key={warning}>{warning}</li>)}</ul>
              </div>
            )}
            {costComparison?.baseline?.comparable === false && costComparison.baseline.reason !== null && costComparison.baseline.reason !== undefined && (
              <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">Baseline comparison is unavailable: {costComparison.baseline.reason}</p>
            )}
            {largestCostIncreases.length > 0 && (
              <details className="border-t border-border px-5 py-3 text-xs">
                <summary className="cursor-pointer font-medium text-foreground">Largest planned cost increases</summary>
                <ul className="mt-2 space-y-1 text-muted-foreground">
                  {largestCostIncreases.map((change): React.JSX.Element => (
                    <li key={`${change.module ?? "default"}:${change.address}`}>
                      <a href="#plan-heading" className="font-mono text-primary underline-offset-2 hover:underline">{change.module ?? "default"}:{change.address ?? "unknown resource"}</a>
                      <span className="ml-2">+{formatMonthlyCost(change["delta-monthly-cost"] ?? undefined, costCurrency, costTimeBasis)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
          )}

          {showPolicyChecks && (
          <section aria-labelledby="policy-heading" className="overflow-hidden rounded-lg border border-border bg-card">
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
                            <code className="text-2xs text-muted-foreground">{check.id}</code>
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
            <details className="group overflow-hidden rounded-lg border border-border bg-card">
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
                        <TableCell className="whitespace-normal">{check.attributes.message ?? (isString(check.attributes.detail) ? check.attributes.detail : "—")}</TableCell>
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
            className={`group overflow-hidden rounded-lg border bg-card ${
              phaseTone(applyStatus) === "danger" ? "border-destructive/50" : "border-border"
            }`}
            open={applyIsOpen}
            onToggle={(event): void => {
              if (event.currentTarget.open !== applyOpenRendered.current) {
                setApplyExpanded(event.currentTarget.open);
              }
            }}
          >
            <summary className="cursor-pointer list-none px-5 py-4 group-open:border-b group-open:border-border hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <ChevronRight className="size-4 text-muted-foreground/70 transition-transform group-open:rotate-90" aria-hidden="true" />
                  <PhaseIcon status={applyStatus} />
                  <h3 id="apply-heading" className="font-semibold text-foreground">
                    Apply{" "}
                    {/* The heading describes the phase; whether the run wants
                        something from you is the decision panel's job to say,
                        once. It used to be claimed here as well, and the two
                        could disagree by a refresh. */}
                    <span className="ml-2 font-normal text-muted-foreground">{formatPhaseState(applyStatus)}</span>
                  </h3>
                  {["errored", "unreachable"].includes(applyStatus) && planExplainerEnabled && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
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
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <PhaseMeta
                    phase="apply"
                    status={applyStatus}
                    timestamps={{ ...timestamps, ...apply?.attributes["status-timestamps"] }}
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

            {applyWaitingReason !== null && (
              <p className="border-b border-border bg-muted/50 px-5 py-3 text-sm text-muted-foreground">
                {applyWaitingReason}
              </p>
            )}

            {applyWarnings.length > 0 && (
              <DiagnosticsBanner severity="warning" diagnostics={applyWarnings} collapsible />
            )}

            {applyErrors.length > 0 ? (
              <DiagnosticsBanner severity="error" diagnostics={applyErrors} collapsible />
            ) : (
              applyWarnings.length === 0 && ["errored", "unreachable"].includes(applyStatus) && (
                <section aria-labelledby="apply-diagnostics-heading" className="border-t border-destructive/30 bg-destructive/10 px-5 py-4">
                  <h4 id="apply-diagnostics-heading" className="text-sm font-semibold text-destructive">Diagnostics</h4>
                  <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-destructive/30 bg-background p-4 font-mono text-xs leading-5 text-destructive">
                    The apply failed before diagnostic output became available.
                  </pre>
                </section>
              )
            )}
            {applyStatus !== "pending" && (
              <ApplyOutput
                runId={runId}
                status={status}
                applyStatus={applyStatus}
                applyLogs={applyLogs}
              />
            )}

            <div id="apply-log-viewer" className="relative">
                <RunLogDisclosure key={`apply-${runId}`} label="Raw apply log" status={applyStatus}>
                <RunLogOutput
                  active={applyStatus === "running"}
                  phase="apply"
                  truncated={view.applyLog.truncated}
                  wrap={logWrap}
                  onToggleWrap={() => { setLogWrap((wrap) => !wrap); }}
                  logUrl={apply?.attributes["log-read-url"]}
                  onPhaseChange={(next): void => {
                    document.getElementById(`${next}-log-viewer`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  className={`max-h-[420px] overflow-auto ${logWrap ? "whitespace-pre-wrap" : "whitespace-pre"} border-t border-code-background bg-code-background p-4 font-mono text-xs leading-5 text-code-foreground`}
                >
                  {applyLogs !== "" ? truncateLogForDisplay(applyLogs) : applyRawLogMessage}
                </RunLogOutput>
                </RunLogDisclosure>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-5 top-1.5"
                  onClick={(): void => { setFullscreenLog("apply"); }}
                  aria-label="Open raw apply log fullscreen"
                >
                  <Maximize2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
          </details>
          )}


      </div>
      <aside aria-label="Run decision and context" className="order-1 min-w-0 space-y-5 xl:order-2">
      <div className="xl:sticky xl:top-4">
        <RunDecisionPanel
          decision={decision}
          status={status}
          canComment={canComment}
          rail
          context={decisionContext}
          // The comment form shares pendingAction ("comment" while posting):
          // the panel must not report that as run-action work.
          pending={pendingAction === "comment" ? "" : pendingAction}
          onConfirm={handleDecisionConfirm}
        />
      </div>
      {provenanceManifest !== null && (
        <section aria-labelledby="run-provenance-heading" className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <h2 id="run-provenance-heading" className="text-sm font-semibold">Executed with</h2>
            <a
              className="text-xs text-primary underline underline-offset-2 hover:no-underline"
              href={`/api/v2/runs/${encodeURIComponent(runId)}/provenance/download`}
              download
            >
              Download manifest
            </a>
          </div>
          <dl className="grid gap-3 px-5 py-4 text-xs">
            <div><dt className="text-muted-foreground">Engine</dt><dd className="mt-0.5 font-medium">{provenanceManifest.engine.binary}{provenanceManifest.engine.version === null ? "" : ` ${provenanceManifest.engine.version}`}</dd></div>
            <div><dt className="text-muted-foreground">Configuration</dt><dd className="mt-0.5 break-all font-mono">{provenanceManifest.configuration.digest.slice(0, 16)}…</dd></div>
            <div><dt className="text-muted-foreground">Input state</dt><dd className="mt-0.5">{provenanceManifest.inputState.id ?? "None recorded"}</dd></div>
            <div><dt className="text-muted-foreground">Variables</dt><dd className="mt-0.5">{provenanceManifest.variables.length} sources captured; sensitive values redacted</dd></div>
            <div><dt className="text-muted-foreground">Sandbox</dt><dd className="mt-0.5">{provenanceManifest.sandbox.required ? "Required" : "Disabled"} · {provenanceManifest.sandbox.networkPolicy} network</dd></div>
            {provenanceManifest.rerun !== undefined && (
              <div>
                <dt className="text-muted-foreground">Rerun inputs</dt>
                <dd className="mt-0.5">
                  {provenanceManifest.rerun.mode === "original" ? "Original captured inputs" : "Current workspace settings"}
                  {provenanceManifest.rerun.changedSinceSource.length === 0
                    ? " · no recorded differences"
                    : ` · changed: ${provenanceManifest.rerun.changedSinceSource.join(", ")}`}
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}
      {provenanceError !== "" && (
        <p role="status" className="rounded-lg border border-border bg-card px-5 py-3 text-xs text-muted-foreground">Executed-with details unavailable: {provenanceError}</p>
      )}
      <section aria-labelledby="run-details-heading" className="overflow-hidden rounded-lg border border-border bg-card">
        <h2 id="run-details-heading" className="border-b border-border px-5 py-4 text-sm font-semibold">Run details</h2>
        <MetaList
          columns={2}
          className="grid-cols-1 px-5 py-4 sm:grid-cols-1"
          items={[
            {
              label: durationLabel,
              value: duration,
              ...(slowRunNote === null ? {} : { note: slowRunNote }),
            },
            {
              label: "Resources changed",
              value: (
                <ResourceCounts
                  additions={summaryCounts?.["resource-additions"]}
                  changes={summaryCounts?.["resource-changes"]}
                  destructions={summaryCounts?.["resource-destructions"]}
                  imports={summaryImportCount}
                  status={applyStatus === "finished" ? applyStatus : planStatus}
                />
              ),
            },
            {
              label: "Actions",
              value: planActionCount === null
                ? "Unavailable"
                : `${planActionCount} ${applyStatus === "finished" ? "invoked" : "to invoke"}`,
            },
            { label: "Status", value: formatRunStatus(status) },
            ...(creatorUsername === "" ? [] : [{
              label: "Created by",
              value: (
                <span className="flex items-center gap-2">
                  <Avatar className="size-6 rounded-full">
                    {creatorAvatarUrl !== "" ? (
                      <AvatarImage src={creatorAvatarUrl} alt={creatorUsername} className="rounded-full object-cover" />
                    ) : (
                      <AvatarFallback className="rounded-full bg-muted text-2xs text-muted-foreground">
                        {creatorUsername.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    )}
                  </Avatar>
                  {creatorUsername}
                </span>
              ),
            }]),
            {
              label: "Workspace",
              value: (
                <Link to={workspacePath} className="break-all text-primary hover:underline">
                  {workspaceName}
                </Link>
              ),
            },
            { label: "Operation", value: formatRunStatus(attributes.operation ?? "plan_and_apply") },
            { label: "Auto apply", value: attributes["auto-apply"] === true ? "Enabled" : "Disabled" },
            { label: "Engine version", value: attributes["terraform-version"] ?? "Workspace default" },
          ]}
        />
        {(timestampEntries.length > 0 || inputStateSerial !== undefined) && (
          <Disclosure label="Run timeline" className="rounded-none border-0 border-t" bodyClassName="px-5 py-4">
            <dl className="grid gap-3 text-xs">
              {timestampEntries.map(([key, value]): React.JSX.Element => (
                <div key={key}>
                  <dt className="capitalize text-muted-foreground">{key.replace(/-at$/, "").replace(/-/g, " ")}</dt>
                  <dd className="mt-0.5 text-foreground">{formatDate(value)}</dd>
                </div>
              ))}
              {inputStateSerial !== undefined && /^\d+$/.test(inputStateSerial) && (
                <div>
                  <dt className="text-muted-foreground">Input state serial</dt>
                  <dd className="mt-0.5 text-foreground" title="The workspace state snapshot used as this run's plan input.">
                    #{inputStateSerial}
                  </dd>
                </div>
              )}
            </dl>
          </Disclosure>
        )}
      </section>

          {showCombinedEmptyActivity ? (
            <section aria-labelledby="activity-heading" className="rounded-lg border border-border bg-card">
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
          <section aria-labelledby="activity-heading" className="rounded-lg border border-border bg-card">
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
                  // SAFETY: unknown event actions fall through to the status label fallback.
                  const eventLabel = RUN_EVENT_LABELS[event.attributes.action as keyof typeof RUN_EVENT_LABELS] ?? formatRunStatus(event.attributes.action);
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
                            {eventLabel}
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
                            {formatRunStatus(fromStatus)} → {formatRunStatus(toStatus)}
                          </p>
                        )}
                        {event.attributes.action === "create" && eventSource !== undefined && (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {formatRunStatus(triggerReason ?? "manual")} from {formatRunSource(eventSource, triggerReason)}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section aria-labelledby="comments-heading" className="rounded-lg border border-border bg-card">
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
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
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
      </aside>
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

      </div>

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
          <RunLogOutput
            key={fullscreenLog}
            active={(fullscreenLog === "plan" ? planStatus : applyStatus) === "running"}
            phase={fullscreenLog}
            truncated={fullscreenLog === "plan" ? view.planLog.truncated : view.applyLog.truncated}
            wrap={logWrap}
            onToggleWrap={() => { setLogWrap((wrap) => !wrap); }}
            logUrl={fullscreenLog === "plan" ? plan?.attributes["log-read-url"] : apply?.attributes["log-read-url"]}
            className={`flex-1 overflow-auto ${logWrap ? "whitespace-pre-wrap" : "whitespace-pre"} bg-code-background p-4 font-mono text-xs leading-5 text-code-foreground`}
          >
            {fullscreenLog === "plan"
              ? planLogs !== "" ? truncateLogForDisplay(planLogs) : planRawLogMessage
              : applyLogs !== "" ? truncateLogForDisplay(applyLogs) : applyRawLogMessage}
          </RunLogOutput>
        </div>
      )}
    </>
  );
}
