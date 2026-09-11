import type { ExplainKind } from "@/lib/api";
import type { TerraformDiagnostic } from "@/lib/diagnostics";
import type { CostModel, PlanCountSource } from "@/lib/run-detail-model";
import type { PhaseOpen } from "@/lib/use-phase-open";
import type {
  AssessmentCheck,
  PhaseResource,
  PolicyCheck,
  RunAttributes,
} from "@/lib/run-view-state";
import type { PlanOutputSummary } from "../PlanOutput";
import { RecoveryWorkbench } from "../RecoveryWorkbench";
import { ApplySection } from "./ApplySection";
import { AssessmentSection } from "./AssessmentSection";
import { CostSection } from "./CostSection";
import { PlanSection } from "./PlanSection";
import { PolicySection } from "./PolicySection";

export type RunDetailMainProps = Readonly<{
  attributes: RunAttributes;
  runId: string;
  status: string;
  plan: PhaseResource | null;
  apply: PhaseResource | null;
  planStatus: string;
  applyStatus: string;
  planExplainerEnabled: boolean;
  onExplain: (kind: ExplainKind, refresh: boolean) => void;
  timestamps: Readonly<Record<string, string>>;
  planWarnings: readonly TerraformDiagnostic[];
  planErrors: readonly TerraformDiagnostic[];
  planLogs: string;
  planRawLogMessage: string;
  planLogTruncated: boolean;
  applyWarnings: readonly TerraformDiagnostic[];
  applyErrors: readonly TerraformDiagnostic[];
  applyLogs: string;
  applyRawLogMessage: string;
  applyLogTruncated: boolean;
  logWrap: boolean;
  onToggleWrap: () => void;
  onOpenFullscreen: (phase: "plan" | "apply") => void;
  onSummaryChange: (summary: PlanOutputSummary | null) => void;
  planCounts: PlanCountSource;
  planImportCount: number | null;
  applyWaitingReason: string | null;
  showApply: boolean;
  cost: CostModel;
  policyChecks: readonly PolicyCheck[];
  policySummary: string;
  hasFailedPolicy: boolean;
  showPolicyChecks: boolean;
  assessmentChecks: readonly AssessmentCheck[];
  refreshAll: () => void;
  onRerunCurrent: () => void;
  phaseOpen: PhaseOpen;
}>;

/** The run page's main column: recovery, plan, cost, policy, health, apply. */
export function RunDetailMain(props: RunDetailMainProps): React.JSX.Element {
  const { attributes, runId, status, plan, apply, planStatus, applyStatus } = props;
  const { phaseOpen } = props;
  return (
    <>
      {attributes["has-recovery-state"] === true && (
        <RecoveryWorkbench
          runId={runId}
          formatSupported={attributes["recovery-state-format-supported"] !== false}
          onRecoveryComplete={props.refreshAll}
          onFreshPlan={props.onRerunCurrent}
        />
      )}

      <div className="order-2 min-w-0 space-y-5 xl:order-1">
          <PlanSection
            runId={runId}
            status={status}
            planStatus={planStatus}
            applyStatus={applyStatus}
            planExplainerEnabled={props.planExplainerEnabled}
            onExplain={props.onExplain}
            timestamps={props.timestamps}
            planStatusTimestamps={plan?.attributes["status-timestamps"]}
            planLogReadUrl={plan?.attributes["log-read-url"]}
            planWarnings={props.planWarnings}
            planErrors={props.planErrors}
            planLogs={props.planLogs}
            planRawLogMessage={props.planRawLogMessage}
            planLogTruncated={props.planLogTruncated}
            logWrap={props.logWrap}
            onToggleWrap={props.onToggleWrap}
            onOpenFullscreen={(): void => { props.onOpenFullscreen("plan"); }}
            onSummaryChange={props.onSummaryChange}
            planCounts={props.planCounts}
            planImportCount={props.planImportCount}
            planIsOpen={phaseOpen.planIsOpen}
            planOpenRendered={phaseOpen.planOpenRendered}
            onPlanExpandedChange={phaseOpen.setPlanExpanded}
          />

          {props.cost.showCostEstimate && (
            <CostSection cost={props.cost} />
          )}

          {props.showPolicyChecks && (
            <PolicySection
              policyChecks={props.policyChecks}
              policySummary={props.policySummary}
              hasFailedPolicy={props.hasFailedPolicy}
            />
          )}

          {props.assessmentChecks.length > 0 && (
            <AssessmentSection assessmentChecks={props.assessmentChecks} />
          )}

          {props.showApply && (
            <ApplySection
              runId={runId}
              status={status}
              applyStatus={applyStatus}
              planExplainerEnabled={props.planExplainerEnabled}
              onExplain={props.onExplain}
              timestamps={props.timestamps}
              applyStatusTimestamps={apply?.attributes["status-timestamps"]}
              applyLogReadUrl={apply?.attributes["log-read-url"]}
              applyWaitingReason={props.applyWaitingReason}
              applyWarnings={props.applyWarnings}
              applyErrors={props.applyErrors}
              applyCounts={apply?.attributes}
              planImportCount={props.planImportCount}
              applyLogs={props.applyLogs}
              applyRawLogMessage={props.applyRawLogMessage}
              applyLogTruncated={props.applyLogTruncated}
              logWrap={props.logWrap}
              onToggleWrap={props.onToggleWrap}
              onOpenFullscreen={(): void => { props.onOpenFullscreen("apply"); }}
              applyIsOpen={phaseOpen.applyIsOpen}
              applyOpenRendered={phaseOpen.applyOpenRendered}
              onApplyExpandedChange={phaseOpen.setApplyExpanded}
            />
          )}
      </div>
    </>
  );
}
