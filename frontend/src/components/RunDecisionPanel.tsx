import { useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { cn } from "@/lib/utils";
import {
  ACTION_CONFIRMATIONS,
  cancelRiskNote,
  type RunActionKind,
  type RunActionOffer,
  type RunDecision,
} from "@/lib/run-decision";
import { TONE_ACCENT, TONE_SURFACE, type RunTone } from "@/lib/run-status";

/**
 * The one place on the run page where actions live.
 *
 * The panel it replaces was gated on "any action is available", which meant it
 * appeared during planning — headed "Please review the planned changes before
 * continuing", above the words "Resources pending", offering only "Add
 * comment". It now renders whatever the run's single resolved decision is, and
 * a run that is merely working gets a progress line rather than a request.
 *
 * Confirmation happens in place. The previous flow needed two clicks through
 * the same panel ("Review & apply" → "Confirm & apply") with the panel's
 * heading changing under the cursor; here the first click swaps the panel body
 * for the consequence and the confirm button, which is the same number of
 * clicks without the impression that something was submitted already.
 */

function decisionTone(decision: RunDecision): RunTone {
  if (decision.kind === "waiting") return "active";
  if (decision.kind === "settled") return "neutral";
  return "attention";
}

function ToneIcon({ decision }: Readonly<{ decision: RunDecision }>): React.JSX.Element {
  const tone = decisionTone(decision);
  if (decision.kind === "settled") {
    return <CheckCircle2 className={`size-5 shrink-0 ${TONE_ACCENT[tone]}`} aria-hidden="true" />;
  }
  return <AlertTriangle className={`size-5 shrink-0 ${TONE_ACCENT[tone]}`} aria-hidden="true" />;
}

function offerButtonProps(emphasis: RunActionOffer["emphasis"]): Readonly<{
  variant: "default" | "outline" | "destructive";
}> {
  if (emphasis === "primary") return { variant: "default" };
  if (emphasis === "danger") return { variant: "destructive" };
  return { variant: "outline" };
}

/**
 * The second half of a two-step action: what it will do, and the button that
 * does it. Split from the panel so each half reads as one screen of markup.
 */
function ConfirmStep({
  action,
  status,
  canComment,
  comment,
  pending,
  surface,
  onCommentChange,
  onConfirm,
  onBack,
}: Readonly<{
  action: RunActionKind;
  status: string;
  canComment: boolean;
  comment: string;
  pending: string;
  surface: string;
  onCommentChange: (value: string) => void;
  onConfirm: () => void;
  onBack: () => void;
}>): React.JSX.Element {
  const copy = ACTION_CONFIRMATIONS[action];
  const risk = action === "cancel" ? cancelRiskNote(status) : null;
  const busy = pending !== "";
  // An override is an audited exception to a rule someone deliberately set.
  // The label said "not optional" but nothing enforced it, so overrides could
  // be recorded with no stated reason — which makes the audit trail useless
  // at exactly the moment it matters.
  const needsJustification = action === "override-policy" && comment.trim() === "";
  return (
    <section
      aria-labelledby="run-decision-heading"
      className={cn("rounded-lg border p-4 sm:p-5", surface)}
    >
      <h2 id="run-decision-heading" className="text-base font-semibold text-foreground">
        {copy.title}
      </h2>
      <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">{copy.body}</p>
      {risk !== null && (
        <p className="mt-2 max-w-prose text-sm font-medium text-warning">{risk}</p>
      )}
      {canComment && (
        <div className="mt-4">
          <label htmlFor="run-action-comment" className="mb-1.5 block text-sm font-medium text-foreground">
            Comment{" "}
            <span className="font-normal text-muted-foreground">
              {action === "override-policy" ? "(required)" : "(optional)"}
            </span>
          </label>
          <Textarea
            id="run-action-comment"
            name="run-action-comment"
            autoComplete="off"
            spellCheck={false}
            rows={2}
            autoFocus
            value={comment}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>): void => {
              onCommentChange(event.target.value);
            }}
            // Mirror onChange as onInput: synthetic test events reach only
            // onInput in this renderer (see CreateWorkspaceModal); real
            // browsers fire both, and the duplicate setState is a no-op.
            onInput={(event: React.SyntheticEvent<HTMLTextAreaElement>): void => {
              onCommentChange(event.currentTarget.value);
            }}
            placeholder={action === "override-policy"
              ? "Why is this finding acceptable?"
              : "Add context for this decision"}
          />
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={action === "apply" ? "default" : "destructive"}
          disabled={busy || needsJustification}
          {...(needsJustification
            ? { title: "Say why this finding is acceptable before overriding it." }
            : {})}
          onClick={onConfirm}
        >
          {busy ? "Sending…" : copy.confirmLabel}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>
          Never mind
        </Button>
      </div>
    </section>
  );
}

/** Stable run facts shown beside a long plan so the decision stays anchored. */
type DecisionContext = Readonly<{
  planId?: string;
  planVersion?: string | null;
  additions?: number | null | undefined;
  changes?: number | null | undefined;
  destructions?: number | null | undefined;
  age?: string | null;
  actor?: string | null;
  policyOutcome?: string | null;
  taskOutcome?: string | null;
  waitingReason?: string | null;
  responsible?: string | null;
  staleWarning?: string | null | undefined;
}>;

function isSilentDecision(decision: RunDecision): boolean {
  return decision.detail === "" && decision.offers.length === 0;
}

function resolveConfirming(
  requested: RunActionKind | null,
  offers: readonly RunActionOffer[],
): RunActionKind | null {
  return requested !== null
    && offers.some((item: RunActionOffer): boolean => item.kind === requested)
    ? requested
    : null;
}

function DecisionHeading({ decision, rail }: Readonly<{
  decision: RunDecision;
  rail: boolean;
}>): React.JSX.Element {
  return (
    <>
      {rail && <p className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground col-span-full">Decision</p>}
      <h2 id="run-decision-heading" className={decision.kind === "waiting" && !rail ? "sr-only" : "text-sm font-semibold text-foreground"}>
        {decision.headline}
      </h2>
      {decision.detail !== "" && (
        <p className="mt-1 max-w-prose text-sm text-muted-foreground sm:col-start-1">{decision.detail}</p>
      )}
    </>
  );
}

function DecisionOffers({ decision, pending, rail, onRequest }: Readonly<{
  decision: RunDecision;
  pending: string;
  rail: boolean;
  onRequest: (kind: RunActionKind) => void;
}>): React.JSX.Element {
  return (
    <>
      {decision.offers.length > 0 && (
        <div className={cn("mt-3 flex flex-wrap items-center gap-2", !rail && "sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:mt-0")}>
          {decision.offers.map((item: RunActionOffer): React.JSX.Element => (
            <Button
              key={item.kind}
              type="button"
              {...offerButtonProps(item.emphasis)}
              size={decision.kind === "waiting" ? "sm" : "default"}
              disabled={item.blockedReason !== null || pending !== ""}
              // The blocker rides on the button it blocks; the list below
              // repeats it as text so the reason stays reachable by
              // keyboard and screen readers (title alone is not).
              title={item.blockedReason ?? undefined}
              onClick={(): void => { onRequest(item.kind); }}
            >
              {item.label}
            </Button>
          ))}
        </div>
      )}
      {decision.offers.some((item: RunActionOffer): boolean => item.blockedReason !== null) && (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {decision.offers
            .filter((item: RunActionOffer): boolean => item.blockedReason !== null)
            .map((item: RunActionOffer): React.JSX.Element => (
              <li key={item.kind}>{item.blockedReason}</li>
            ))}
        </ul>
      )}
    </>
  );
}

function StaleWarningNote({ rail, context }: Readonly<{
  rail: boolean;
  context: DecisionContext | undefined;
}>): React.JSX.Element | null {
  if (!(rail && context?.staleWarning !== undefined && context.staleWarning !== null && context.staleWarning !== "")) return null;
  return (
    <p role="status" className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning col-span-full">
      {context.staleWarning}
    </p>
  );
}

function PlannedChangesRow({ additions, changes, destructions }: Readonly<{
  additions?: number | null | undefined;
  changes?: number | null | undefined;
  destructions?: number | null | undefined;
}>): React.JSX.Element | null {
  if (additions === undefined && changes === undefined && destructions === undefined) return null;
  return (
    <div className="col-span-2">
      <dt className="text-muted-foreground">Planned changes</dt>
      <dd className="mt-0.5 flex flex-wrap gap-x-3 font-medium">
        <span className="text-success">+{additions ?? 0}</span>
        <span className="text-primary">~{changes ?? 0}</span>
        <span className="text-destructive">−{destructions ?? 0}</span>
      </dd>
    </div>
  );
}

function ContextTextRow({ label, value, wide, mono, truncate, title, prefix, allowEmpty }: Readonly<{
  label: string;
  value: string | null | undefined;
  wide?: boolean;
  mono?: boolean;
  truncate?: boolean;
  title?: string | null | undefined;
  prefix?: string | undefined;
  allowEmpty?: boolean;
}>): React.JSX.Element | null {
  if (value === undefined || value === null || (value === "" && allowEmpty !== true)) return null;
  return (
    <div className={wide === true ? "col-span-2 min-w-0" : undefined}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono === true ? "mt-0.5 truncate font-mono text-foreground" : truncate === true ? "mt-0.5 truncate text-foreground" : "mt-0.5 text-foreground"} title={title ?? undefined}>
        {prefix}{value}
      </dd>
    </div>
  );
}

function DecisionContextList({ rail, context }: Readonly<{
  rail: boolean;
  context: DecisionContext | undefined;
}>): React.JSX.Element | null {
  if (!rail || context === undefined) return null;
  return (
    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-current/10 pt-4 text-xs col-span-full">
      <ContextTextRow label="Plan" value={context.planId} wide mono title={context.planId} allowEmpty />
      <ContextTextRow label="Plan version" value={context.planVersion} wide mono title={context.planVersion} />
      <PlannedChangesRow additions={context.additions} changes={context.changes} destructions={context.destructions} />
      <ContextTextRow label="Run age" value={context.age} prefix="Created " allowEmpty />
      <ContextTextRow label="Actor" value={context.actor} truncate title={context.actor} />
      <ContextTextRow label="Policy" value={context.policyOutcome} />
      <ContextTextRow label="Tasks" value={context.taskOutcome} />
      <ContextTextRow label="Waiting for" value={context.waitingReason} wide />
      <ContextTextRow label="Next actor" value={context.responsible} wide />
    </dl>
  );
}

export function RunDecisionPanel({
  decision,
  status,
  canComment,
  pending,
  onConfirm,
  context,
  rail = false,
}: Readonly<{
  decision: RunDecision;
  status: string;
  canComment: boolean;
  /** The action currently being sent, or "" when idle. */
  pending: string;
  onConfirm: (action: RunActionKind, comment: string) => void;
  /** Stable run facts shown beside a long plan so the decision stays anchored. */
  context?: DecisionContext;
  /** Use the decision rail layout on the run page. */
  rail?: boolean;
}>): React.JSX.Element | null {
  const [requested, setRequested] = useState<RunActionKind | null>(null);
  const [comment, setComment] = useState("");

  /**
   * Show the confirmation step only while the decision still actually offers
   * that action.
   *
   * Deriving this rather than trusting the state variable is what keeps the
   * step honest. `requested` is set by a click and cleared by "Never mind",
   * but the accepted action itself does not clear it — and once the POST
   * succeeds the decision becomes "Apply confirmed — waiting…" with no offers.
   * A confirmation step rendered from raw state would sit there with a live
   * "Yes, apply changes" button behind a success toast, and a second click
   * would apply the run twice. It also closes itself if the offer vanishes for
   * any other reason, such as someone applying the run in another tab.
   */
  const confirming = resolveConfirming(requested, decision.offers);

  // A settled run with nothing to say and nothing to offer adds only noise;
  // the header badge and the phase sections already report the outcome.
  const silent = isSilentDecision(decision);
  if (!rail && decision.kind === "settled" && silent) return null;
  if (!rail && decision.kind === "waiting" && silent) return null;

  const surface = TONE_SURFACE[decisionTone(decision)];

  if (confirming !== null) {
    return (
      <ConfirmStep
        action={confirming}
        status={status}
        canComment={canComment}
        comment={comment}
        pending={pending}
        surface={surface}
        onCommentChange={setComment}
        onConfirm={(): void => { onConfirm(confirming, comment); }}
        onBack={(): void => { setRequested(null); setComment(""); }}
      />
    );
  }

  return (
    <section
      data-decision-rail={rail ? "true" : undefined}
      aria-labelledby="run-decision-heading"
      className={decision.kind === "waiting" && !rail ? "flex justify-end" : cn("rounded-lg border p-4 sm:p-5", surface)}
    >
      <div className="flex items-start gap-3">
        {decision.kind !== "waiting" && <ToneIcon decision={decision} />}
        <div className={cn("grid min-w-0 flex-1 items-center gap-x-6", !rail && "sm:grid-cols-[minmax(0,1fr)_auto]")}>
          <DecisionHeading decision={decision} rail={rail} />
          <DecisionOffers decision={decision} pending={pending} rail={rail} onRequest={(kind: RunActionKind): void => { setRequested(kind); setComment(""); }} />
          <StaleWarningNote rail={rail} context={context} />
          <DecisionContextList rail={rail} context={context} />
        </div>
      </div>
    </section>
  );
}
