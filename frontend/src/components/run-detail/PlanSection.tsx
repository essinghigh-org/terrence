import { ChevronRight, Maximize2, Sparkles } from "lucide-react";
import type { TerraformDiagnostic } from "@/lib/diagnostics";
import type { ExplainKind } from "@/lib/api";
import { truncateLogForDisplay } from "@/lib/log-display";
import type { PlanCountSource } from "@/lib/run-detail-model";
import { formatPhaseState } from "@/lib/run-status";
import type { PlanOutputSummary } from "../PlanOutput";
import { PlanOutput } from "../PlanOutput";
import { Terrence } from "../brand/Terrence";
import { DiagnosticsBanner } from "../DiagnosticsBanner";
import { RunLogOutput } from "../RunLogOutput";
import { Button } from "../ui/button";
import { PhaseIcon, PhaseMeta, ResourceCounts, RunLogDisclosure, scrollToPhaseLog } from "./phase-bits";

export type PlanSectionProps = Readonly<{
  runId: string;
  status: string;
  planStatus: string;
  applyStatus: string;
  planExplainerEnabled: boolean;
  onExplain: (kind: ExplainKind, refresh: boolean) => void;
  timestamps: Readonly<Record<string, string>>;
  planStatusTimestamps: Readonly<Record<string, string>> | null | undefined;
  planLogReadUrl: string | null | undefined;
  planWarnings: readonly TerraformDiagnostic[];
  planErrors: readonly TerraformDiagnostic[];
  planLogs: string;
  planRawLogMessage: string;
  planLogTruncated: boolean;
  logWrap: boolean;
  onToggleWrap: () => void;
  onOpenFullscreen: () => void;
  onSummaryChange: (summary: PlanOutputSummary | null) => void;
  planCounts: PlanCountSource;
  planImportCount: number | null;
  planIsOpen: boolean;
  planOpenRendered: Readonly<{ current: boolean }>;
  onPlanExpandedChange: (open: boolean) => void;
}>;

export function PlanSection(props: PlanSectionProps): React.JSX.Element {
  const { planStatus, applyStatus } = props;
  return (
    <details
      aria-labelledby="plan-heading"
      className="group overflow-hidden rounded-lg border border-border bg-card"
      open={props.planIsOpen}
      onToggle={(event): void => {
        if (event.currentTarget.open !== props.planOpenRendered.current) {
          props.onPlanExpandedChange(event.currentTarget.open);
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
            {["finished", "planned_and_saved"].includes(planStatus) && props.planExplainerEnabled && (
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
                  props.onExplain("plan", false);
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
              timestamps={{ ...props.timestamps, ...props.planStatusTimestamps }}
              logUrl={props.planLogReadUrl}
            />
            {applyStatus === "finished" && (
              <ResourceCounts
                additions={props.planCounts["resource-additions"]}
                changes={props.planCounts["resource-changes"]}
                destructions={props.planCounts["resource-destructions"]}
                imports={props.planImportCount}
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
      {props.planWarnings.length > 0 && (
        <DiagnosticsBanner severity="warning" diagnostics={props.planWarnings} collapsible />
      )}

      {props.planErrors.length > 0 && (
        <DiagnosticsBanner severity="error" diagnostics={props.planErrors} collapsible />
      )}

      <PlanOutput
        runId={props.runId}
        status={props.status}
        planStatus={planStatus}
        onSummaryChange={props.onSummaryChange}
      />

      <div id="plan-log-viewer" className="relative border-t border-border">
        <RunLogDisclosure key={`plan-${props.runId}`} label="Raw plan log" status={planStatus}>
          <RunLogOutput
            active={planStatus === "running"}
            phase="plan"
            truncated={props.planLogTruncated}
            wrap={props.logWrap}
            onToggleWrap={props.onToggleWrap}
            logUrl={props.planLogReadUrl}
            onPhaseChange={scrollToPhaseLog}
            className={`max-h-[420px] overflow-auto ${props.logWrap ? "whitespace-pre-wrap" : "whitespace-pre"} border-t border-code-background bg-code-background p-4 font-mono text-xs leading-5 text-code-foreground`}
          >
            {props.planLogs !== "" ? truncateLogForDisplay(props.planLogs) : props.planRawLogMessage}
          </RunLogOutput>
        </RunLogDisclosure>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="absolute right-5 top-1.5"
          onClick={props.onOpenFullscreen}
          aria-label="Open raw plan log fullscreen"
        >
          <Maximize2 className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </details>
  );
}
