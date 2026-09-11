import { useState } from "react";
import { AlertCircle, CheckCircle2, Circle, Clock, XCircle } from "lucide-react";
import { cn, formatDateTime, formatRelativeTime } from "@/lib/utils";
import { isNumber } from "@/lib/type-guards";
import { resolvePhaseCompletion } from "@/lib/run-detail-model";
import { phaseTone, TONE_ACCENT } from "@/lib/run-status";
import { Spinner } from "../ui/spinner";
import { Disclosure } from "../ui/disclosure";

/**
 * Phase icons take their colour from the shared tone map so the plan and apply
 * headings, the header badge and the stage strip cannot land on three
 * different colours for one run.
 */
export function PhaseIcon({ status }: Readonly<{ status: string }>): React.JSX.Element {
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

export function ResourceCounts({
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

export function PhaseMeta({
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
  const completion = resolvePhaseCompletion({ phase, status, timestamps, logUrl });
  const { started, completed, completedLabel, hasLogUrl, phaseDurationLabel } = completion;
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

export function RunLogDisclosure({ label, status, children, autoExpand = true }: Readonly<{
  label: string;
  status: string;
  children: React.ReactNode;
  autoExpand?: boolean;
}>): React.JSX.Element {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? (autoExpand && ["running", "errored", "unreachable"].includes(status));
  return (
    <Disclosure label={label} open={open}
      onToggle={(next: boolean): void => { if (next !== open) setExpanded(next); }}
      className="rounded-none border-0" summaryClassName="pr-16" bodyClassName="border-0"
    >
      {children}
    </Disclosure>
  );
}

/** Scroll the named phase log viewer into view (used by both log outputs). */
export function scrollToPhaseLog(next: string): void {
  document.getElementById(`${next}-log-viewer`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
