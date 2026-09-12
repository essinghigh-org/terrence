import { Terrence } from "../components/brand/Terrence";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchApi } from "../lib/api";
import type { JsonValue } from "../lib/json";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import { PageHeader, PageShell } from "../components/PageHeader";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Minus,
  Power,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn, formatDateTime } from "../lib/utils";
import { Callout } from "@/components/ui/callout";

type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";

type WizardStep = {
  key: string;
  status: StepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  detail: string | null;
  error: string | null;
};

type VerifyResult = {
  table: string;
  sourceCount: number;
  targetCount: number;
  countMatch: boolean;
  digestMatch: boolean | null;
  digestSkipped: string | null;
};

type MigrationReport = {
  triggersSkipped: number;
  defaultsDropped: string[];
  checksSkipped: string[];
  indexesSkipped: string[];
  fkViolations: { table: string; constraint: string; error: string }[];
  journalMatch: boolean;
};

type CopyProgress = {
  table: string;
  rows: number;
  totalTables: number;
  doneTables: number;
};

type WizardState = {
  id: string;
  phase: string;
  createdAt: string;
  updatedAt: string;
  targetUrl: string;
  targetMasked: string;
  steps: WizardStep[];
  verification: VerifyResult[] | null;
  report: MigrationReport | null;
  error: string | null;
  copyProgress: CopyProgress | null;
};

type StatusBody = {
  wizard: WizardState | null;
  running: boolean;
  "source-database": { path: string; memory: boolean } | null;
  "restart-disabled": boolean;
  "environment-database-url": string | null;
};

const ACTIVE_PHASES = new Set(["draining", "copying", "verifying"]);

const STEP_LABELS = {
  compatibility: "Compatibility check",
  maintenance: "Maintenance mode",
  drain: "Drain active work",
  checkpoint: "WAL checkpoint",
  schema: "Create target schema",
  copy: "Copy records",
  verify: "Verify integrity",
};

function stepSymbol(status: StepStatus): React.JSX.Element {
  switch (status) {
    case "running":
      return <Spinner className="size-3.5" />;
    case "passed":
      return <Check className="size-3.5 text-success" aria-hidden />;
    case "failed":
      return <X className="size-3.5 text-destructive" aria-hidden />;
    case "skipped":
      return <Minus className="size-3.5 text-muted-foreground" aria-hidden />;
    case "pending":
      return <span className="size-3.5 rounded-full border border-border" aria-hidden />;
  }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "idle": return "Idle";
    case "draining": return "Draining active work";
    case "copying": return "Copying records";
    case "verifying": return "Verifying the target";
    case "ready_to_switch": return "Ready to switch";
    case "switched": return "Switched to PostgreSQL";
    case "interrupted": return "Interrupted";
    case "failed": return "Failed";
    case "aborted": return "Aborted";
    default: return phase;
  }
}

type TimelineStatus = "complete" | "active" | "pending" | "failed";

const MIGRATION_TIMELINE = [
  { key: "preflight", label: "Preflight", description: "Check the target connection, version, permissions, and emptiness.", steps: ["compatibility"] },
  { key: "quiescence", label: "Write quiescence", description: "Pause new runs and drain active work before copying data.", steps: ["maintenance", "drain"] },
  { key: "transfer", label: "Transfer", description: "Checkpoint SQLite, create the target schema, and copy records.", steps: ["checkpoint", "schema", "copy"] },
  { key: "consistency", label: "Consistency checks", description: "Compare counts, digests, references, and the migration journal.", steps: ["verify"] },
  { key: "cutover", label: "Cutover", description: "Write the boot configuration only after verification succeeds.", steps: [] },
  { key: "post-cutover", label: "Post-cutover validation", description: "Restart, confirm the target identity, and keep the SQLite rollback image.", steps: [] },
] as const;

function midTimelineStatus(
  timelineIndex: number,
  phase: string,
  matchingSteps: readonly WizardStep[],
): TimelineStatus {
  if (timelineIndex === 0 && phase !== "idle") return matchingSteps.some((step): boolean => step.status === "running") ? "active" : "complete";
  if (timelineIndex === 1 && phase === "draining") return "active";
  if (timelineIndex === 2 && phase === "copying") return "active";
  if (timelineIndex === 3 && phase === "verifying") return "active";
  if (["failed", "aborted", "interrupted"].includes(phase) && timelineIndex <= 3) return "failed";
  return "pending";
}

function timelineStatus(
  timelineIndex: number,
  phase: string,
  steps: readonly WizardStep[],
): TimelineStatus {
  const stepKeys = MIGRATION_TIMELINE[timelineIndex]?.steps ?? [];
  const matchingSteps = steps.filter((step): boolean => (stepKeys as readonly string[]).includes(step.key));
  if (matchingSteps.some((step): boolean => step.status === "failed")) return "failed";
  if (matchingSteps.length > 0 && matchingSteps.every((step): boolean => step.status === "passed" || step.status === "skipped")) return "complete";
  if (timelineIndex === 4 && phase === "switched") return "complete";
  if (timelineIndex === 5 && phase === "switched") return "active";
  if (timelineIndex === 4 && phase === "ready_to_switch") return "active";
  return midTimelineStatus(timelineIndex, phase, matchingSteps);
}

function recoveryGuidance(phase: string, hasSqliteSource: boolean): Readonly<{ tone: "info" | "success" | "warning" | "danger"; title: string; body: string }> {
  if (phase === "ready_to_switch") {
    return {
      tone: "success",
      title: "Verified and reversible",
      body: "The target matches the source checks. SQLite remains the rollback image until you switch the boot configuration; review the report before proceeding.",
    };
  }
  if (phase === "switched") {
    return {
      tone: "warning",
      title: "Restart is the next checkpoint",
      body: "The boot configuration points at PostgreSQL, but the process must restart before it uses the target. After new writes land there, rollback requires reconciliation with the SQLite image.",
    };
  }
  if (["failed", "aborted", "interrupted"].includes(phase)) {
    return {
      tone: "danger",
      title: "Recovery requires operator review",
      body: "SQLite remains authoritative until cutover. Inspect the failed step and its recovery detail; do not assume rollback is safe after any target writes without reconciliation.",
    };
  }
  if (phase !== "idle") {
    return {
      tone: "warning",
      title: "Migration is in progress",
      body: "New runs are paused after write quiescence. The durable checkpoint remains visible after a refresh, and the source SQLite database is unchanged until cutover.",
    };
  }
  if (!hasSqliteSource) {
    return {
      tone: "info",
      title: "PostgreSQL is active",
      body: "This instance has no SQLite source database to migrate. The PostgreSQL backend is already authoritative.",
    };
  }
  return {
    tone: "info",
    title: "SQLite is a supported source",
    body: "The source stays intact while you test the target and review compatibility. Nothing is written until you confirm the start action.",
  };
}

function Section({
  defaultOpen,
  title,
  children,
}: Readonly<{ defaultOpen: boolean; title: string; children: React.ReactNode }>): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-border first:border-t-0">
      <button
        className="flex w-full items-center gap-1.5 py-2.5 text-left text-sm font-medium text-foreground hover:text-primary"
        onClick={(): void => { setOpen((v): boolean => !v); }}
        type="button"
      >
        {open ? <ChevronDown className="size-4 text-muted-foreground" aria-hidden /> : <ChevronRight className="size-4 text-muted-foreground" aria-hidden />}
        {title}
      </button>
      {open && <div className="pb-3">{children}</div>}
    </div>
  );
}

function Field({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] items-start gap-3 py-1.5 text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

function MigrationErrorBanner({ error, onRetry }: Readonly<{
  error: string;
  onRetry: () => void;
}>): React.JSX.Element {
  return (
    <div role="alert" className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1"><span className="font-semibold">Migration action failed.</span>{" "}{error}</div>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>Try again</Button>
    </div>
  );
}

function StatusFields({ status, wizard, isSwitched }: Readonly<{
  status: StatusBody;
  wizard: WizardState | null;
  isSwitched: boolean;
}>): React.JSX.Element {
  return (
    <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 text-sm sm:grid-cols-2">
      <Field
        label="Current source"
        children={
          status["source-database"] === null
            ? "PostgreSQL backend"
            : <><span className="font-medium">SQLite</span><span className="ml-2 font-mono text-xs text-muted-foreground">{status["source-database"].path}</span></>
        }
      />
      <Field
        label="Target identity"
        children={wizard?.targetMasked !== undefined && wizard.targetMasked !== "" ? <span className="font-mono text-xs">{wizard.targetMasked}</span> : "No target selected"}
      />
      <Field
        label="Authoritative source"
        children={status["source-database"] === null
          ? "PostgreSQL backend"
          : isSwitched ? "PostgreSQL after restart; SQLite rollback image retained" : "SQLite until cutover"}
      />
      <Field
        label="Persisted checkpoint"
        children={wizard?.updatedAt !== undefined ? <time dateTime={wizard.updatedAt}>{formatDateTime(wizard.updatedAt, "Unknown")}</time> : "No migration checkpoint"}
      />
    </div>
  );
}

function GuidanceCallout({ tone, title, body, phase }: Readonly<{
  tone: "info" | "success" | "warning" | "danger";
  title: string;
  body: string;
  phase: string;
}>): React.JSX.Element {
  return (
    <Callout tone={tone} title={title} role={phase === "failed" || phase === "aborted" || phase === "interrupted" ? "alert" : "status"}>
      {body}
    </Callout>
  );
}

function MigrationTimeline({ phase, wizard }: Readonly<{
  phase: string;
  wizard: WizardState | null;
}>): React.JSX.Element {
  const steps = wizard?.steps ?? [];
  return (
    <ol aria-label="Migration phases" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {MIGRATION_TIMELINE.map((item, index): React.JSX.Element => {
        const state = timelineStatus(index, phase, steps);
        return (
          <li key={item.key} className={cn(
            "rounded-lg border p-3",
            state === "complete" && "border-success/30 bg-success/5",
            state === "active" && "border-primary/30 bg-primary/5",
            state === "failed" && "border-destructive/30 bg-destructive/5",
            state === "pending" && "bg-muted/20",
          )}>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className={cn(
                "flex size-6 items-center justify-center rounded-full border text-xs",
                state === "complete" && "border-success/40 text-success",
                state === "active" && "border-primary/40 text-primary",
                state === "failed" && "border-destructive/40 text-destructive",
                state === "pending" && "border-border text-muted-foreground",
              )} aria-hidden="true">
                {state === "complete" ? <Check className="size-3.5" /> : state === "failed" ? <X className="size-3.5" /> : index + 1}
              </span>
              <span>{item.label}</span>
              {state === "active" && <Spinner className="size-3.5" />}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{item.description}</p>
          </li>
        );
      })}
    </ol>
  );
}

function MaintenanceBanner({ active, wizard }: Readonly<{
  active: boolean;
  wizard: WizardState | null;
}>): React.JSX.Element | null {
  if (!(active && wizard?.steps.some((step): boolean => step.key === "maintenance" && step.status === "passed") === true)) return null;
  return <div className="flex items-center gap-4 rounded-lg border bg-muted/30 p-4"><Terrence pose="maintenance" detail="small" className="w-28" /><div><h2 className="font-heading font-semibold">Maintenance mode</h2><p className="mt-1 text-sm text-muted-foreground">New runs are paused while the database migration is in progress.</p></div></div>;
}

function PhaseStatusRow({ active, phase, terminalFailed, wizard }: Readonly<{
  active: boolean;
  phase: string;
  terminalFailed: boolean;
  wizard: WizardState | null;
}>): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span
        aria-live="polite"
        aria-atomic="true"
        className={cn(
          "font-medium",
          active && "text-warning-text",
          phase === "ready_to_switch" && "text-success",
          phase === "switched" && "text-success",
          terminalFailed && "text-destructive",
        )}
      >
        {phaseLabel(phase)}
      </span>
      {wizard?.targetMasked !== "" && wizard?.targetMasked !== undefined && (
        <span className="font-mono text-xs text-muted-foreground">{wizard.targetMasked}</span>
      )}
      {active && <Spinner className="size-4" />}
    </div>
  );
}

function WizardErrorNote({ wizard }: Readonly<{ wizard: WizardState | null }>): React.JSX.Element | null {
  if (!(wizard?.error !== null && wizard?.error !== undefined)) return null;
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {wizard.error}
    </div>
  );
}

function StepsList({ wizard }: Readonly<{ wizard: WizardState | null }>): React.JSX.Element | null {
  if (!(wizard !== null && wizard.steps.length > 0)) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Steps</div>
      <ul className="space-y-1">
        {wizard.steps.map((step): React.JSX.Element => {
          // SAFETY: unknown migration steps fall back to the raw step key below.
          const stepLabel = Object.prototype.hasOwnProperty.call(STEP_LABELS, step.key)
            ? STEP_LABELS[step.key as keyof typeof STEP_LABELS]
            : step.key;
          return (
          <li key={step.key} className="flex items-center gap-2 text-sm">
            {stepSymbol(step.status)}
            <span className={cn(step.status === "failed" && "text-destructive")}>
              {stepLabel}
            </span>
            {step.detail !== null && (
              <span className="truncate font-mono text-xs text-muted-foreground">{step.detail}</span>
            )}
            {step.error !== null && <span className="text-xs text-destructive">{step.error}</span>}
          </li>
          );
        })}
      </ul>
    </div>
  );
}

function CopyProgressNote({ wizard }: Readonly<{ wizard: WizardState | null }>): React.JSX.Element | null {
  if (!(wizard?.copyProgress !== null && wizard?.copyProgress !== undefined)) return null;
  return (
    <div className="text-sm text-muted-foreground">
      Copying <span className="font-medium text-foreground">{wizard.copyProgress.table}</span> —{" "}
      {wizard.copyProgress.doneTables}/{wizard.copyProgress.totalTables} tables,{" "}
      {wizard.copyProgress.rows.toLocaleString()} rows in the current table
    </div>
  );
}

function VerificationSection({ verification }: Readonly<{
  verification: readonly VerifyResult[] | null | undefined;
}>): React.JSX.Element | null {
  if (!(verification !== null && verification !== undefined && verification.length > 0)) return null;
  return (
    <Section defaultOpen={false} title={`Verification (${verification.length} tables)`}>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-2 py-1.5 font-medium">Table</th>
              <th className="px-2 py-1.5 font-medium">Source</th>
              <th className="px-2 py-1.5 font-medium">Target</th>
              <th className="px-2 py-1.5 font-medium">Digest</th>
            </tr>
          </thead>
          <tbody>
            {verification.map((row): React.JSX.Element => (
              <tr key={row.table} className="border-b border-border last:border-b-0">
                <td className="px-2 py-1.5 font-mono">{row.table}</td>
                <td className="px-2 py-1.5">{row.sourceCount.toLocaleString()}</td>
                <td className="px-2 py-1.5">{row.targetCount.toLocaleString()}</td>
                <td className={cn("px-2 py-1.5", row.digestMatch === false && "text-destructive")}>
                  {row.digestMatch === null
                    ? (row.digestSkipped ?? "skipped")
                    : row.digestMatch ? "match" : "MISMATCH"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function MigrationReportSection({ report }: Readonly<{
  report: MigrationReport | null | undefined;
}>): React.JSX.Element | null {
  if (!(report !== null && report !== undefined)) return null;
  return (
    <Section defaultOpen={false} title="Migration report">
      <div className="space-y-1">
        <Field label="Triggers skipped" children={<span className={report.triggersSkipped > 0 ? "text-warning-text" : undefined}>{report.triggersSkipped}</span>} />
        <Field label="Defaults dropped" children={<span className={report.defaultsDropped.length > 0 ? "text-warning-text" : undefined}>{report.defaultsDropped.length > 0 ? report.defaultsDropped.join(", ") : "none"}</span>} />
        <Field label="Checks skipped" children={<span className={report.checksSkipped.length > 0 ? "text-warning-text" : undefined}>{report.checksSkipped.length > 0 ? report.checksSkipped.join(", ") : "none"}</span>} />
        <Field label="Indexes skipped" children={<span className={report.indexesSkipped.length > 0 ? "text-warning-text" : undefined}>{report.indexesSkipped.length > 0 ? report.indexesSkipped.join(", ") : "none"}</span>} />
        <Field label="FK violations" children={<span className={report.fkViolations.length > 0 ? "text-destructive" : undefined}>{report.fkViolations.length}</span>} />
        <Field label="Journal match" children={report.journalMatch ? "ok" : "mismatch"} />
      </div>
    </Section>
  );
}

function ReadyToSwitchPanel({ wizard, envDbUrl, busy, onAction }: Readonly<{
  wizard: WizardState | null;
  envDbUrl: string | null;
  busy: string | null;
  onAction: (path: string, method: string, body?: JsonValue) => Promise<void>;
}>): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="text-sm text-muted-foreground">
        Verification passed: every table matches by row count and content digest. Switch the boot
        configuration to PostgreSQL, then restart the process.
      </div>
      <VerificationSection verification={wizard?.verification} />
      <MigrationReportSection report={wizard?.report} />
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          aria-describedby={envDbUrl !== null ? "migration-switch-reason" : undefined}
          disabled={envDbUrl !== null || busy !== null}
          onClick={(): void => { void onAction("switch", "POST"); }}
        >
          <ArrowRight className="size-4" aria-hidden />
          Switch to PostgreSQL
        </Button>
        <Button variant="outline" onClick={(): void => { void onAction("cancel", "POST"); }}>
          Cancel
        </Button>
        {envDbUrl !== null && (
          <p id="migration-switch-reason" className="basis-full text-xs text-muted-foreground">
            Switch is unavailable while DATABASE_URL is set. Remove or empty that environment value before cutover.
          </p>
        )}
      </div>
    </div>
  );
}

function SwitchedPanel({ restartDisabled, busy, onAction }: Readonly<{
  restartDisabled: boolean;
  busy: string | null;
  onAction: (path: string, method: string, body?: JsonValue) => Promise<void>;
}>): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="text-sm text-muted-foreground">
        The boot configuration now points at PostgreSQL. Restart the process to boot on the new backend;
        the SQLite database remains as the rollback image.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-describedby={restartDisabled ? "migration-restart-reason" : undefined}
          disabled={restartDisabled || busy !== null}
          onClick={(): void => { void onAction("restart", "POST"); }}
        >
          <Power className="size-4" aria-hidden />
          Restart process
        </Button>
        {restartDisabled && (
          <span id="migration-restart-reason" className="text-xs text-muted-foreground">
            Restart is suppressed in this environment; restart the process manually.
          </span>
        )}
      </div>
    </div>
  );
}

function MigrationStatusCard({ status, wizard, phase, active, terminalFailed, guidance, busy, onAction }: Readonly<{
  status: StatusBody;
  wizard: WizardState | null;
  phase: string;
  active: boolean;
  terminalFailed: boolean;
  guidance: Readonly<{ tone: "info" | "success" | "warning" | "danger"; title: string; body: string }>;
  busy: string | null;
  onAction: (path: string, method: string, body?: JsonValue) => Promise<void>;
}>): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="size-4 text-muted-foreground" aria-hidden />
          Migration status
        </CardTitle>
        <CardDescription>
          Source database:{" "}
          <span className="font-mono text-xs">
            {status["source-database"] === null ? "none (PostgreSQL backend)" : status["source-database"].path}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <StatusFields status={status} wizard={wizard} isSwitched={phase === "switched"} />

        <GuidanceCallout tone={guidance.tone} title={guidance.title} body={guidance.body} phase={phase} />

        <MigrationTimeline phase={phase} wizard={wizard} />

        <MaintenanceBanner active={active} wizard={wizard} />
        <PhaseStatusRow active={active} phase={phase} terminalFailed={terminalFailed} wizard={wizard} />

        <WizardErrorNote wizard={wizard} />

        {status["environment-database-url"] !== null && (
          <Callout tone="warning" className="p-3">
            {status["environment-database-url"]}
          </Callout>
        )}

        <StepsList wizard={wizard} />

        <CopyProgressNote wizard={wizard} />

        {phase === "ready_to_switch" && (
          <ReadyToSwitchPanel wizard={wizard} envDbUrl={status["environment-database-url"]} busy={busy} onAction={onAction} />
        )}

        {phase === "switched" && (
          <SwitchedPanel restartDisabled={status["restart-disabled"]} busy={busy} onAction={onAction} />
        )}

        {terminalFailed && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="outline" onClick={(): void => { void onAction("cancel", "POST"); }}>
              Clear
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type CompatResult = {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
};

function TargetCheckButtons({ urlBlank, busy, onTest, onCheck }: Readonly<{
  urlBlank: boolean;
  busy: string | null;
  onTest: () => void;
  onCheck: () => void;
}>): React.JSX.Element {
  return (
    <div className="flex shrink-0 gap-2">
      <Button
        disabled={urlBlank || busy !== null}
        onClick={onTest}
        variant="outline"
      >
        <RefreshCw className="size-4" aria-hidden />
        Test connection
      </Button>
      <Button
        disabled={urlBlank || busy !== null}
        onClick={onCheck}
        variant="outline"
      >
        <Check className="size-4" aria-hidden />
        Compatibility
      </Button>
    </div>
  );
}

function StartConfirmSection({ urlBlank, busy, running, confirmStart, onRequestStart, onConfirmStart, onCancelConfirm }: Readonly<{
  urlBlank: boolean;
  busy: string | null;
  running: boolean;
  confirmStart: boolean;
  onRequestStart: () => void;
  onConfirmStart: () => void;
  onCancelConfirm: () => void;
}>): React.JSX.Element {
  if (!confirmStart) {
    return (
      <Button
        disabled={urlBlank || busy !== null || running}
        onClick={onRequestStart}
      >
        Start migration
      </Button>
    );
  }
  return (
    <Callout
      tone="warning"
      className="p-3"
      actions={
        <>
          <Button
            disabled={busy !== null}
            onClick={onConfirmStart}
          >
            Confirm start
          </Button>
          <Button variant="outline" onClick={onCancelConfirm}>Back</Button>
        </>
      }
    >
      The backend enters maintenance mode: existing runs finish, new runs are blocked until the copy
      completes and you decide to switch.
    </Callout>
  );
}

function StartMigrationCard({ hasSqliteSource, active, phase, running, busy, act, onBusyChange, onError, onAction }: Readonly<{
  hasSqliteSource: boolean;
  active: boolean;
  phase: string;
  running: boolean;
  busy: string | null;
  act: (path: string, method: string, body?: JsonValue) => Promise<JsonValue>;
  onBusyChange: (busy: string | null) => void;
  onError: (message: string) => void;
  onAction: (path: string, method: string, body?: JsonValue) => Promise<void>;
}>): React.JSX.Element | null {
  const [url, setUrl] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [compatResult, setCompatResult] = useState<CompatResult | null>(null);
  const [confirmStart, setConfirmStart] = useState(false);
  if (!hasSqliteSource || active || (phase !== "idle" && phase !== "failed" && phase !== "aborted" && phase !== "interrupted")) return null;
  const urlBlank = url.trim() === "";

  const handleTestConnection = (): void => {
    onBusyChange("test-connection");
    setTestResult(null);
    act("test-connection", "POST", { data: { attributes: { url } } })
      .then((body): void => {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const result = (body as { data: { ok?: boolean; detail?: string } }).data;
        setTestResult(result.ok === false ? `Connection failed: ${result.detail ?? "unknown error"}` : "Connection OK");
      })
      .catch((err: unknown): void => {
        onError(err instanceof Error ? err.message : String(err));
      })
      .finally((): void => { onBusyChange(null); });
  };

  const handleCheckCompatibility = (): void => {
    onBusyChange("compatibility");
    setCompatResult(null);
    act("compatibility", "POST", { data: { attributes: { url } } })
      .then((body): void => {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        setCompatResult((body as { data: CompatResult }).data);
      })
      .catch((err: unknown): void => {
        onError(err instanceof Error ? err.message : String(err));
      })
      .finally((): void => { onBusyChange(null); });
  };

  return (
    <Card>
      <CardHeader variant="danger">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="size-4" aria-hidden="true" />
          Start a migration
        </CardTitle>
        <CardDescription>
          Enter the target PostgreSQL connection URL. The target database must be empty; the wizard creates the
          schema and copies all records. The backend enters maintenance mode for the duration of the copy.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          This changes the storage backend and puts the instance into maintenance mode. Verify the target and rollback plan before continuing.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            aria-label="PostgreSQL connection URL"
            className="font-mono text-xs"
            onChange={(event): void => { setUrl(event.target.value); }}
            placeholder="postgres://user:***@host:5432/terrence"
            spellCheck={false}
            value={url}
          />
          <TargetCheckButtons
            urlBlank={urlBlank}
            busy={busy}
            onTest={handleTestConnection}
            onCheck={handleCheckCompatibility}
          />
        </div>

        {busy === "test-connection" && <div className="text-sm text-muted-foreground">Testing connection…</div>}
        {testResult !== null && (
          <div className={cn("text-sm", testResult.startsWith("Connection failed") ? "text-destructive" : "text-success")}>
            {testResult}
          </div>
        )}
        {busy === "compatibility" && <div className="text-sm text-muted-foreground">Checking target…</div>}

        {compatResult !== null && (
          <ul className="space-y-1 text-sm">
            {compatResult.checks.map((check): React.JSX.Element => (
              <li key={check.name} className="flex items-center gap-2">
                {check.ok
                  ? <Check className="size-3.5 text-success" aria-hidden />
                  : <X className="size-3.5 text-destructive" aria-hidden />}
                <span className={cn(!check.ok && "text-destructive")}>{check.name}</span>
                {check.detail !== "" && <span className="font-mono text-xs text-muted-foreground">{check.detail}</span>}
              </li>
            ))}
          </ul>
        )}

        <StartConfirmSection
          urlBlank={urlBlank}
          busy={busy}
          running={running}
          confirmStart={confirmStart}
          onRequestStart={(): void => { setConfirmStart(true); }}
          onConfirmStart={(): void => {
            setConfirmStart(false);
            void onAction("start", "POST", { data: { attributes: { url } } });
          }}
          onCancelConfirm={(): void => { setConfirmStart(false); }}
        />
      </CardContent>
    </Card>
  );
}

export function AdminDatabaseMigration(): React.JSX.Element {
  const [status, setStatus] = useState<StatusBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const body = (await fetchApi("/admin/db-migration/status")) as { data: StatusBody };
      setStatus(body.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect((): void => {
    void load();
  }, [load]);

  useEffect((): (() => void) => {
    // Poll adaptively: while a job is running, refresh every 2 seconds;
    // otherwise settle down to 15 seconds. The timeout is rescheduled on
    // every status change and cleared on unmount.
    // The backend reports wizard: null when no migration state exists yet.
    if (pollTimer.current !== null) clearTimeout(pollTimer.current);
    const active = status !== null && (status.running || (status.wizard !== null && ACTIVE_PHASES.has(status.wizard.phase)));
    pollTimer.current = setTimeout((): void => { void load(); }, active ? 2_000 : 15_000);
    return (): void => { if (pollTimer.current !== null) clearTimeout(pollTimer.current); };
  }, [status, error, load]);

  const act = useCallback(async (path: string, method: string, body?: JsonValue): Promise<JsonValue> => {
    setError(null);
    return fetchApi<JsonValue>(`/admin/db-migration/${path}`, {
      method,
      ...(body === undefined ? undefined : { body: JSON.stringify(body) }),
    });
  }, []);

  const runAction = useCallback(async (path: string, method: string, body?: JsonValue, thenLoad = true): Promise<void> => {
    setBusy(path);
    try {
      await act(path, method, body);
      if (thenLoad) await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [act, load]);

  const wizard = status?.wizard ?? null;
  const phase = wizard?.phase ?? "idle";
  const active = status?.running === true || ACTIVE_PHASES.has(phase);
  const terminalFailed = phase === "failed" || phase === "aborted" || phase === "interrupted";
  const hasSqliteSource = status !== null && status["source-database"] !== null;
  const guidance = recoveryGuidance(phase, hasSqliteSource);

  return (
    <PageShell variant="form">
      <PageHeader
        breadcrumbs={[
          { label: "Admin", to: "/app/admin" },
          { label: "Database" },
        ]}
        title="Database"
        description="Migrate the backend database from SQLite to PostgreSQL. The source database stays untouched as the rollback image; the switch is a single boot-config write followed by a restart."
      />

      {error !== null && (
        <MigrationErrorBanner error={error} onRetry={(): void => { void load(); }} />
      )}

      {status !== null && (
        <MigrationStatusCard
          status={status}
          wizard={wizard}
          phase={phase}
          active={active}
          terminalFailed={terminalFailed}
          guidance={guidance}
          busy={busy}
          onAction={runAction}
        />
      )}

      <StartMigrationCard
        hasSqliteSource={hasSqliteSource}
        active={active}
        phase={phase}
        running={status?.running === true}
        busy={busy}
        act={act}
        onBusyChange={setBusy}
        onError={setError}
        onAction={runAction}
      />
    </PageShell>
  );
}
