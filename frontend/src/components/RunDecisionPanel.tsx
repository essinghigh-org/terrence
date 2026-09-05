import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
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

function ToneIcon({ decision }: Readonly<{ decision: RunDecision }>): React.JSX.Element {
  if (decision.kind === "waiting") {
    return <Loader2 className="size-5 shrink-0 animate-spin text-primary" aria-hidden="true" />;
  }
  if (decision.kind === "settled") {
    return <CheckCircle2 className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }
  return <AlertTriangle className="size-5 shrink-0 text-warning" aria-hidden="true" />;
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
      className={cn("rounded-lg border p-5 shadow-sm", surface)}
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
          disabled={busy || (needsJustification && canComment)}
          {...(needsJustification && canComment
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

export function RunDecisionPanel({
  decision,
  status,
  canComment,
  pending,
  onConfirm,
}: Readonly<{
  decision: RunDecision;
  status: string;
  canComment: boolean;
  /** The action currently being sent, or "" when idle. */
  pending: string;
  onConfirm: (action: RunActionKind, comment: string) => void;
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
  const confirming = requested !== null
    && decision.offers.some((item: RunActionOffer): boolean => item.kind === requested)
    ? requested
    : null;

  // A settled run with nothing to say and nothing to offer adds only noise;
  // the header badge and the phase sections already report the outcome.
  const silent = decision.detail === "" && decision.offers.length === 0;
  if (decision.kind === "settled" && silent) return null;
  if (decision.kind === "waiting" && silent && !decision.showProgress) return null;

  const surface = decision.kind === "decide"
    ? "border-warning/40 bg-warning/5"
    : "border-border bg-muted/30";

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
      aria-labelledby="run-decision-heading"
      className={cn("rounded-lg border p-5 shadow-sm", surface)}
    >
      <div className="flex items-start gap-3">
        <ToneIcon decision={decision} />
        <div className="min-w-0 flex-1">
          <h2 id="run-decision-heading" className="text-base font-semibold text-foreground">
            {decision.headline}
          </h2>
          {decision.detail !== "" && (
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">{decision.detail}</p>
          )}
          {decision.offers.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {decision.offers.map((item: RunActionOffer): React.JSX.Element => (
                <Button
                  key={item.kind}
                  type="button"
                  {...offerButtonProps(item.emphasis)}
                  disabled={item.blockedReason !== null || pending !== ""}
                  // The blocker rides on the button it blocks, instead of in a
                  // separate "Why are actions unavailable?" list that had to
                  // restate which action each line was about.
                  title={item.blockedReason ?? undefined}
                  onClick={(): void => { setRequested(item.kind); setComment(""); }}
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
        </div>
      </div>
    </section>
  );
}
