import { ChevronRight, Maximize2, Sparkles } from "lucide-react";
import type { TerraformDiagnostic } from "@/lib/diagnostics";
import type { ExplainKind } from "@/lib/api";
import { truncateLogForDisplay } from "@/lib/log-display";
import type { PlanCountSource } from "@/lib/run-detail-model";
import { formatPhaseState, phaseTone } from "@/lib/run-status";
import { ApplyOutput } from "../ApplyOutput";
import { DiagnosticsBanner } from "../DiagnosticsBanner";
import { RunLogOutput } from "../RunLogOutput";
import { Button } from "../ui/button";
import { PhaseIcon, PhaseMeta, ResourceCounts, RunLogDisclosure, scrollToPhaseLog } from "./phase-bits";

export type ApplySectionProps = Readonly<{
  runId: string;
  status: string;
  applyStatus: string;
  planExplainerEnabled: boolean;
  onExplain: (kind: ExplainKind, refresh: boolean) => void;
  timestamps: Readonly<Record<string, string>>;
  applyStatusTimestamps: Readonly<Record<string, string>> | null | undefined;
  applyLogReadUrl: string | null | undefined;
  applyWaitingReason: string | null;
  applyWarnings: readonly TerraformDiagnostic[];
  applyErrors: readonly TerraformDiagnostic[];
  applyCounts: PlanCountSource | undefined;
  planImportCount: number | null;
  applyLogs: string;
  applyRawLogMessage: string;
  applyLogTruncated: boolean;
  logWrap: boolean;
  onToggleWrap: () => void;
  onOpenFullscreen: () => void;
  applyIsOpen: boolean;
  applyOpenRendered: Readonly<{ current: boolean }>;
  onApplyExpandedChange: (open: boolean) => void;
}>;

function ApplyResourceCounts({ applyCounts, planImportCount, applyStatus }: Readonly<{
  applyCounts: PlanCountSource | undefined;
  planImportCount: number | null;
  applyStatus: string;
}>): React.JSX.Element | null {
  if (applyStatus === "finished") return null;
  return (
    <ResourceCounts
      additions={applyCounts?.["resource-additions"]}
      changes={applyCounts?.["resource-changes"]}
      destructions={applyCounts?.["resource-destructions"]}
      imports={applyCounts?.["resource-imports"] ?? planImportCount}
      status={applyStatus}
    />
  );
}

function ApplyDiagnosticsFallback({ applyErrors, applyWarnings, applyStatus }: Readonly<{
  applyErrors: readonly TerraformDiagnostic[];
  applyWarnings: readonly TerraformDiagnostic[];
  applyStatus: string;
}>): React.JSX.Element | null {
  if (applyErrors.length > 0) {
    return <DiagnosticsBanner severity="error" diagnostics={applyErrors} collapsible />;
  }
  if (applyWarnings.length === 0 && ["errored", "unreachable"].includes(applyStatus)) {
    return (
      <section aria-labelledby="apply-diagnostics-heading" className="border-t border-destructive/30 bg-destructive/10 px-5 py-4">
        <h4 id="apply-diagnostics-heading" className="text-sm font-semibold text-destructive">Diagnostics</h4>
        <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-destructive/30 bg-background p-4 font-mono text-xs leading-5 text-destructive">
          The apply failed before diagnostic output became available.
        </pre>
      </section>
    );
  }
  return null;
}

export function ApplySection(props: ApplySectionProps): React.JSX.Element {
  const { applyStatus } = props;
  return (
    <details
      aria-labelledby="apply-heading"
      className={`group overflow-hidden rounded-lg border bg-card ${
        phaseTone(applyStatus) === "danger" ? "border-destructive/50" : "border-border"
      }`}
      open={props.applyIsOpen}
      onToggle={(event): void => {
        if (event.currentTarget.open !== props.applyOpenRendered.current) {
          props.onApplyExpandedChange(event.currentTarget.open);
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
            {["errored", "unreachable"].includes(applyStatus) && props.planExplainerEnabled && (
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
                  props.onExplain("apply", false);
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
              timestamps={{ ...props.timestamps, ...props.applyStatusTimestamps }}
              logUrl={props.applyLogReadUrl}
            />
            <ApplyResourceCounts
              applyCounts={props.applyCounts}
              planImportCount={props.planImportCount}
              applyStatus={applyStatus}
            />
          </div>
        </div>
      </summary>

      {props.applyWaitingReason !== null && (
        <p className="border-b border-border bg-muted/50 px-5 py-3 text-sm text-muted-foreground">
          {props.applyWaitingReason}
        </p>
      )}

      {props.applyWarnings.length > 0 && (
        <DiagnosticsBanner severity="warning" diagnostics={props.applyWarnings} collapsible />
      )}

      <ApplyDiagnosticsFallback
        applyErrors={props.applyErrors}
        applyWarnings={props.applyWarnings}
        applyStatus={applyStatus}
      />
      {applyStatus !== "pending" && (
        <ApplyOutput
          runId={props.runId}
          status={props.status}
          applyStatus={applyStatus}
          applyLogs={props.applyLogs}
        />
      )}

      <div id="apply-log-viewer" className="relative">
        <RunLogDisclosure key={`apply-${props.runId}`} label="Raw apply log" status={applyStatus} autoExpand={false}>
          <RunLogOutput
            active={applyStatus === "running"}
            phase="apply"
            truncated={props.applyLogTruncated}
            wrap={props.logWrap}
            onToggleWrap={props.onToggleWrap}
            logUrl={props.applyLogReadUrl}
            onPhaseChange={scrollToPhaseLog}
            className={`max-h-[420px] overflow-auto ${props.logWrap ? "whitespace-pre-wrap" : "whitespace-pre"} border-t border-code-background bg-code-background p-4 font-mono text-xs leading-5 text-code-foreground`}
          >
            {props.applyLogs !== "" ? truncateLogForDisplay(props.applyLogs) : props.applyRawLogMessage}
          </RunLogOutput>
        </RunLogDisclosure>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="absolute right-5 top-1.5"
          onClick={props.onOpenFullscreen}
          aria-label="Open raw apply log fullscreen"
        >
          <Maximize2 className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </details>
  );
}
