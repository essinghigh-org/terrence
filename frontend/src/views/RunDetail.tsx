import { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { extractDiagnostics, type TerraformDiagnostic } from "../lib/diagnostics";
import { CAPABILITY_PLAN_EXPLAINER, useCapability } from "../lib/capabilities";
import { useUnsavedChangesWarning } from "../lib/use-unsaved-changes";
import { resolveRunDecision } from "../lib/run-decision";
import { useRunView } from "../lib/use-run-view";
import {
  resolveApplyModel,
  resolveCostModel,
  resolveDecisionContext,
  resolveDurationModel,
  resolveFreshnessModel,
  resolvePhaseStatuses,
  resolvePlanCounts,
  resolvePolicyModel,
  resolveRerunModel,
  resolveRunPermissions,
  resolveRunPhasePreview,
  resolveRunTimestamps,
  resolveSummaryCounts,
  resolveWorkspaceId,
} from "../lib/run-detail-model";
import { usePhaseOpen } from "../lib/use-phase-open";
import { usePlanExplainer } from "../lib/use-plan-explainer";
import { useFullscreenLog } from "../lib/use-fullscreen-log";
import { useRunActions } from "../lib/use-run-actions";
import { useRerunRun } from "../lib/use-rerun-run";
import { useProvenanceManifest, useSpeculativeRun, useTaskOutcome } from "../lib/use-run-aux-data";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { RunStageStrip, resolveStages } from "../components/RunStageStrip";
import { Button } from "../components/ui/button";
import type { PlanOutputSummary } from "../components/PlanOutput";
import { RunAlerts } from "../components/run-detail/RunAlerts";
import { RunHeader } from "../components/run-detail/RunHeader";
import { RunDetailMain } from "../components/run-detail/RunDetailMain";
import { RunDetailRail } from "../components/run-detail/RunDetailRail";
import { ExplainerDialog } from "../components/run-detail/ExplainerDialog";
import { FullscreenLogOverlay } from "../components/run-detail/FullscreenLogOverlay";

function useRunRoute(): Readonly<{
  orgName: string;
  workspaceName: string;
  runId: string;
  orgPath: string;
  workspacePath: string;
  runPermalink: string;
}> {
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
  const runPermalink = `${window.location.origin}${workspacePath}/runs/${encodeURIComponent(runId)}`;
  return { orgName, workspaceName, runId, orgPath, workspacePath, runPermalink };
}

export function RunDetail({
  showBreadcrumb = true,
}: Readonly<{ readonly showBreadcrumb?: boolean }>): React.JSX.Element {
  const route = useRunRoute();
  const { orgName, workspaceName, runId, orgPath, workspacePath } = route;
  const planExplainerEnabled = useCapability(CAPABILITY_PLAN_EXPLAINER);
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
  const explainer = usePlanExplainer(runId);
  const fullscreen = useFullscreenLog();
  const runActions = useRunActions({ runId, markActionSent, markActionSettled, refreshAll, refresh });
  const workspaceId = resolveWorkspaceId(view.run);
  const rerun = useRerunRun({ runId, workspaceId, workspacePath });
  const speculativeRun = useSpeculativeRun(runId, view.run);
  const taskOutcome = useTaskOutcome(runId);
  const { provenanceManifest, provenanceError } = useProvenanceManifest(runId);
  const [logWrap, setLogWrap] = useState<boolean>(true);
  const [planSummary, setPlanSummary] = useState<Readonly<{
    runId: string;
    summary: PlanOutputSummary;
  }> | null>(null);
  const handlePlanSummaryChange = useCallback((summary: PlanOutputSummary | null): void => {
    setPlanSummary(summary === null ? null : { runId, summary });
  }, [runId]);

  // Phase disclosure state resolves before the loading returns so the hook
  // count stays stable; with no run yet the statuses fall back to "".
  const earlyPhases = resolveRunPhasePreview(run, plan, apply);
  const phaseOpen = usePhaseOpen(runId, run?.attributes.status, earlyPhases.planStatus, earlyPhases.applyStatus);

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

  useUnsavedChangesWarning(
    runActions.commentBody.trim() !== "",
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
        <Button className="mt-3" variant="outline" onClick={(): void => { refreshAll(); }}>
          Try again
        </Button>
      </div>
    );
  }

  const attributes = run.attributes;
  const { status } = attributes;
  const { canApply, canComment } = resolveRunPermissions(attributes, fresh);

  // The run's single pending decision. Everything that used to derive its own
  // answer from the raw status — the header, the apply heading, the action
  // buttons, the bottom warning panel — now reads this.
  const decision = resolveRunDecision(attributes, {
    fresh,
    speculative: speculativeRun,
    awaitingAction,
  });

  const timestamps = resolveRunTimestamps(attributes);
  const { planStatus, applyStatus } = resolvePhaseStatuses({ status, timestamps, plan, apply });
  const { planCounts, planImportCount, planActionCount } = resolvePlanCounts({ plan, attributes, planSummary, runId });
  const { duration, durationLabel, planRawLogMessage, applyRawLogMessage } = resolveDurationModel({
    timestamps,
    planOnly: attributes["plan-only"] === true,
    planStatus,
    applyStatus,
  });
  const cost = resolveCostModel(costEstimate);
  const policy = resolvePolicyModel(policyChecks, status);
  const applyModel = resolveApplyModel({
    planOnly: attributes["plan-only"] === true,
    status,
    applyStatus,
    timestamps,
    canApply,
  });
  const rerunModel = resolveRerunModel({ workspaceId, status, attributes });
  const { savedPlanVersion, stalePlanWarning } = resolveFreshnessModel({ timestamps, plan, fresh, failedSections });
  const { summaryCounts, summaryImportCount } = resolveSummaryCounts({
    applyStatus,
    apply,
    planCounts,
    planImportCount,
  });
  const decisionContext = resolveDecisionContext({
    runId,
    savedPlanVersion,
    planCounts,
    createdAt: attributes["created-at"],
    creatorUsername,
    triggeredBy: attributes["triggered-by"],
    policySummary: policy.policySummary,
    taskOutcome,
    staleWarning: stalePlanWarning,
    attributes,
    status,
    timestamps,
  });

  const stages = resolveStages(status, timestamps, {
    planOnly: attributes["plan-only"] === true,
    hasPolicyChecks: policyChecks.length > 0,
    executionMode: attributes["execution-mode"],
    positionInQueue: attributes["position-in-queue"],
    scheduledAt: attributes["scheduled-at"],
  });

  phaseOpen.planOpenRendered.current = phaseOpen.planIsOpen;
  phaseOpen.applyOpenRendered.current = phaseOpen.applyIsOpen;

  const { fullscreenLog } = fullscreen;

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

        <RunAlerts fresh={fresh} loadError={loadError} failedSections={failedSections} onRetry={refreshAll} />

        <RunHeader
          orgName={orgName}
          orgPath={orgPath}
          workspaceName={workspaceName}
          workspacePath={workspacePath}
          runId={runId}
          runPermalink={route.runPermalink}
          attributes={attributes}
          status={status}
          speculativeRun={speculativeRun}
          canRerun={rerunModel.canRerun}
          rerunBlockedReason={rerunModel.rerunBlockedReason}
          rerunPending={rerun.rerunPending}
          pendingAction={runActions.pendingAction}
          rerunError={rerun.rerunError}
          rerunDialogOpen={rerun.rerunDialogOpen}
          setRerunDialogOpen={rerun.setRerunDialogOpen}
          onRerun={rerun.performRerun}
        />

        <RunStageStrip stages={stages} className="mb-5" />

        <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
          <RunDetailMain
            attributes={attributes}
            runId={runId}
            status={status}
            plan={plan}
            apply={apply}
            planStatus={planStatus}
            applyStatus={applyStatus}
            planExplainerEnabled={planExplainerEnabled}
            onExplain={(kind, refresh): void => { void explainer.handleExplain(kind, refresh); }}
            timestamps={timestamps}
            planWarnings={planWarnings}
            planErrors={planErrors}
            planLogs={planLogs}
            planRawLogMessage={planRawLogMessage}
            planLogTruncated={view.planLog.truncated}
            applyWarnings={applyWarnings}
            applyErrors={applyErrors}
            applyLogs={applyLogs}
            applyRawLogMessage={applyRawLogMessage}
            applyLogTruncated={view.applyLog.truncated}
            logWrap={logWrap}
            onToggleWrap={() => { setLogWrap((wrap) => !wrap); }}
            onOpenFullscreen={(phase): void => { fullscreen.setFullscreenLog(phase); }}
            onSummaryChange={handlePlanSummaryChange}
            planCounts={planCounts}
            planImportCount={planImportCount}
            applyWaitingReason={applyModel.applyWaitingReason}
            showApply={applyModel.showApply}
            cost={cost}
            policyChecks={policyChecks}
            policySummary={policy.policySummary}
            hasFailedPolicy={policy.hasFailedPolicy}
            showPolicyChecks={policy.showPolicyChecks}
            assessmentChecks={assessmentChecks}
            refreshAll={refreshAll}
            onRerunCurrent={(): void => { void rerun.performRerun("current"); }}
            phaseOpen={phaseOpen}
          />
          <RunDetailRail
            decision={decision}
            status={status}
            canComment={canComment}
            decisionContext={decisionContext}
            decisionPending={runActions.decisionPending}
            onConfirm={runActions.handleDecisionConfirm}
            runId={runId}
            provenanceManifest={provenanceManifest}
            provenanceError={provenanceError}
            attributes={attributes}
            duration={duration}
            durationLabel={durationLabel}
            summaryCounts={summaryCounts}
            summaryImportCount={summaryImportCount}
            planActionCount={planActionCount}
            planStatus={planStatus}
            applyStatus={applyStatus}
            creatorUsername={creatorUsername}
            creatorAvatarUrl={creatorAvatarUrl}
            workspaceName={workspaceName}
            workspacePath={workspacePath}
            timestamps={timestamps}
            inputStateSerial={timestamps["input-state-serial"]}
            runEvents={runEvents}
            comments={comments}
            commentBody={runActions.commentBody}
            onCommentBodyChange={runActions.setCommentBody}
            pendingAction={runActions.pendingAction}
            onCommentSubmit={runActions.handleCommentSubmit}
          />
        </div>

        <ExplainerDialog explainer={explainer} />
      </div>

      {fullscreenLog !== null && (
        <FullscreenLogOverlay
          phase={fullscreenLog}
          planStatus={planStatus}
          applyStatus={applyStatus}
          planLogTruncated={view.planLog.truncated}
          applyLogTruncated={view.applyLog.truncated}
          logWrap={logWrap}
          onToggleWrap={() => { setLogWrap((wrap) => !wrap); }}
          planLogUrl={plan?.attributes["log-read-url"]}
          applyLogUrl={apply?.attributes["log-read-url"]}
          planLogs={planLogs}
          applyLogs={applyLogs}
          planRawLogMessage={planRawLogMessage}
          applyRawLogMessage={applyRawLogMessage}
          closeRef={fullscreen.closeRef}
          containerRef={fullscreen.containerRef}
          onClose={(): void => { fullscreen.setFullscreenLog(null); }}
        />
      )}
    </>
  );
}
