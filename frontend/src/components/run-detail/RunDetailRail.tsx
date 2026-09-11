import type { RunActionKind, RunDecision } from "@/lib/run-decision";
import type { RunProvenanceManifest } from "@/lib/run-detail-format";
import type { DecisionContext, PlanCountSource } from "@/lib/run-detail-model";
import type { RunAttributes, RunComment, RunEvent } from "@/lib/run-view-state";
import { RunDecisionPanel } from "../RunDecisionPanel";
import { ActivitySection } from "./ActivitySection";
import { ProvenanceBlock } from "./ProvenanceBlock";
import { RunDetailsCard } from "./RunDetailsCard";

export type RunDetailRailProps = Readonly<{
  decision: RunDecision;
  status: string;
  canComment: boolean;
  decisionContext: DecisionContext;
  decisionPending: string;
  onConfirm: (action: RunActionKind, comment: string) => void;
  runId: string;
  provenanceManifest: RunProvenanceManifest | null;
  provenanceError: string;
  attributes: RunAttributes;
  duration: string;
  durationLabel: string;
  summaryCounts: PlanCountSource;
  summaryImportCount: number | null;
  planActionCount: number | null;
  planStatus: string;
  applyStatus: string;
  creatorUsername: string;
  creatorAvatarUrl: string;
  workspaceName: string;
  workspacePath: string;
  timestamps: Readonly<Record<string, string>>;
  inputStateSerial: string | undefined;
  runEvents: readonly RunEvent[];
  comments: readonly RunComment[];
  commentBody: string;
  onCommentBodyChange: (body: string) => void;
  pendingAction: string;
  onCommentSubmit: (event: React.SyntheticEvent<HTMLFormElement>) => void;
}>;

/** The run page's decision rail: decision panel, provenance, details, activity. */
export function RunDetailRail(props: RunDetailRailProps): React.JSX.Element {
  return (
    <aside aria-label="Run decision and context" className="order-1 min-w-0 space-y-5 xl:order-2">
      <div>
        <RunDecisionPanel
          decision={props.decision}
          status={props.status}
          canComment={props.canComment}
          rail
          context={props.decisionContext}
          pending={props.decisionPending}
          onConfirm={props.onConfirm}
        />
      </div>
      <ProvenanceBlock runId={props.runId} manifest={props.provenanceManifest} error={props.provenanceError} />
      <RunDetailsCard
        attributes={props.attributes}
        status={props.status}
        duration={props.duration}
        durationLabel={props.durationLabel}
        summaryCounts={props.summaryCounts}
        summaryImportCount={props.summaryImportCount}
        planActionCount={props.planActionCount}
        planStatus={props.planStatus}
        applyStatus={props.applyStatus}
        creatorUsername={props.creatorUsername}
        creatorAvatarUrl={props.creatorAvatarUrl}
        workspaceName={props.workspaceName}
        workspacePath={props.workspacePath}
        timestamps={props.timestamps}
        inputStateSerial={props.inputStateSerial}
      />
      <ActivitySection
        status={props.status}
        runEvents={props.runEvents}
        comments={props.comments}
        canComment={props.canComment}
        commentBody={props.commentBody}
        onCommentBodyChange={props.onCommentBodyChange}
        pendingAction={props.pendingAction}
        onCommentSubmit={props.onCommentSubmit}
      />
    </aside>
  );
}
