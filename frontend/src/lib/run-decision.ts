import { TERMINAL_STATUSES, type RunAttributes } from "./run-view-state";
import { isString } from "./type-guards";

/**
 * What, if anything, the run needs from the person looking at it.
 *
 * The page this replaces answered that question in four places at once: the
 * header badge, the apply section heading ("Apply Needs Confirmation"), a
 * "Why are actions unavailable?" list beside the buttons, and a warning panel
 * at the bottom of the page reading "Please review the planned changes before
 * continuing". Each derived its own answer from the raw status, so they
 * disagreed routinely — most visibly on a still-planning run, where the
 * bottom panel asked the user to review changes that did not exist yet and
 * offered "Add comment" as the only way to act on them.
 *
 * Resolving it once, here, means the page can state the decision in one place
 * and everything else can be descriptive.
 */

export type RunActionKind = "apply" | "discard" | "cancel" | "force-cancel" | "override-policy";

export type RunActionOffer = Readonly<{
  kind: RunActionKind;
  label: string;
  /** Rendering weight. Exactly one offer per decision is `primary`. */
  emphasis: "primary" | "secondary" | "danger";
  /** Set when the action exists but cannot be taken; names the blocker. */
  blockedReason: string | null;
}>;

export type RunDecision = Readonly<{
  /**
   * `waiting`  — the run is working; nothing is asked of the user.
   * `decide`   — the run has stopped and needs a human decision.
   * `settled`  — the run reached a terminal status.
   */
  kind: "waiting" | "decide" | "settled";
  /** One sentence, in the second person, naming the situation. */
  headline: string;
  /** Optional supporting sentence. Empty string when the headline suffices. */
  detail: string;
  offers: readonly RunActionOffer[];
  /** True when the run's own progress is what the page should emphasise. */
  showProgress: boolean;
}>;

function lockedReason(attributes: RunAttributes): string | null {
  if (attributes["workspace-locked"] !== true) return null;
  const reason = attributes["workspace-locked-reason"];
  return isString(reason) && reason !== ""
    ? `The workspace is locked: ${reason}`
    : "The workspace is locked.";
}

/**
 * Why an action the run is otherwise ready for cannot be taken. Returns null
 * when it can. Ordered so the most actionable blocker wins: a permission
 * problem needs a different person, a lock needs a different step, and a stale
 * page needs a reload — telling the user all three at once helps nobody.
 */
function applyBlocker(
  attributes: RunAttributes,
  fresh: boolean,
): string | null {
  if (!fresh) return "This page could not confirm the run is current. Reload before applying.";
  if (attributes.permissions?.["can-apply"] !== true) {
    return "You do not have permission to apply in this workspace.";
  }
  const locked = lockedReason(attributes);
  if (locked !== null) return locked;
  return null;
}

function offer(
  kind: RunActionKind,
  label: string,
  emphasis: RunActionOffer["emphasis"],
  blockedReason: string | null = null,
): RunActionOffer {
  return { kind, label, emphasis, blockedReason };
}

/**
 * Permission gate with stale-data priority (CodeRabbit review): when the
 * page cannot confirm the run is current, say to reload instead of claiming
 * the user lacks permission — a permitted user would otherwise get the
 * wrong recovery action.
 */
const STALE_BLOCKER = "This page could not confirm the run is current. Reload and try again.";

function permissionBlocker(fresh: boolean, allowed: boolean, deniedReason: string): string | null {
  if (!fresh) return STALE_BLOCKER;
  return allowed ? null : deniedReason;
}

/**
 * Copy for the transient states between "planning" and "planned". These read
 * as progress, not as a request, so the page must not put a decision panel in
 * front of them.
 */
const WAITING_HEADLINES: Readonly<Record<string, string>> = {
  pending: "Waiting for a worker to pick this run up",
  queuing: "Queuing the plan",
  plan_queued: "Waiting for a worker to pick this run up",
  fetching: "Fetching the configuration",
  fetching_completed: "Configuration fetched",
  pre_plan_running: "Running pre-plan tasks",
  pre_plan_completed: "Pre-plan tasks finished",
  planning: "Planning",
  cost_estimating: "Estimating cost",
  cost_estimated: "Cost estimated",
  policy_checking: "Checking policies",
  policy_checked: "Policy checks passed",
  post_plan_running: "Running post-plan tasks",
  post_plan_completed: "Post-plan tasks finished",
  confirmed: "Apply confirmed",
  apply_queued: "Waiting for a worker to start the apply",
  applying: "Applying changes",
};

const SETTLED_HEADLINES: Readonly<Record<string, string>> = {
  applied: "Changes applied",
  planned_and_finished: "Plan finished — nothing to apply",
  canceled: "Run canceled",
  force_canceled: "Run force canceled",
  discarded: "Plan discarded",
  errored: "Run failed",
  failed: "Run failed",
  policy_hard_failed: "A policy check failed — this run cannot be applied",
  unreachable: "Run could not be reached",
};

/** A discard offer, when the run is in a state that permits one. */
function discardOffer(
  attributes: RunAttributes,
  fresh: boolean,
  label: string,
): readonly RunActionOffer[] {
  if (attributes.actions?.["is-discardable"] !== true) return [];
  return [offer(
    "discard",
    label,
    "secondary",
    permissionBlocker(fresh, attributes.permissions?.["can-discard"] === true, "You do not have permission to discard runs in this workspace."),
  )];
}

/** The stop-it-now offers, available while a run is still working. */
function stopOffers(attributes: RunAttributes, fresh: boolean): readonly RunActionOffer[] {
  const { actions, permissions } = attributes;
  return [
    ...(actions?.["is-cancelable"] === true
      ? [offer(
          "cancel",
          "Cancel run",
          "secondary",
          permissionBlocker(fresh, permissions?.["can-cancel"] === true, "You do not have permission to cancel runs in this workspace."),
        )]
      : []),
    ...(actions?.["is-force-cancelable"] === true
      ? [offer(
          "force-cancel",
          "Force cancel",
          "danger",
          permissionBlocker(fresh, permissions?.["can-force-cancel"] === true, "Force cancel requires workspace admin permission."),
        )]
      : []),
  ];
}

/** Copy for an action that has been sent but has not taken effect yet. */
function inFlightHeadline(action: string): string {
  if (action === "apply") return "Apply confirmed — waiting for the run to start";
  const name = action.replace(/-/g, " ").replace(/^./, (c: string): string => c.toUpperCase());
  return `${name} sent — waiting for the run to update`;
}

/**
 * Resolve the run's single pending decision.
 *
 * Order matters and is deliberate:
 *
 *  1. An action already sent wins over everything — the page must not re-offer
 *     a button whose click it has accepted.
 *  2. A terminal status is final; nothing is asked.
 *  3. A soft-failed policy outranks apply, because no apply can proceed until
 *     somebody accepts the finding.
 *  4. A confirmable plan is the page's main event.
 *  5. Speculative and plan-only runs never apply, so they settle rather than
 *     asking for a confirmation that cannot be given.
 *  6. Anything else is the run working, where the only offer is to stop it.
 */
export function resolveRunDecision(
  attributes: RunAttributes,
  options: Readonly<{
    fresh: boolean;
    speculative: boolean;
    /** The action currently in flight, if the page sent one. */
    awaitingAction: string | null;
  }>,
): RunDecision {
  const { status, actions, permissions } = attributes;
  const { fresh, speculative, awaitingAction } = options;

  if (awaitingAction !== null) {
    // Keep the stop-it-now offers available. A cancel the worker never
    // acknowledges would otherwise park the panel on "Cancel sent — waiting
    // for the run to update" with force cancel hidden, which is precisely the
    // situation force cancel exists for. The action just sent is excluded so
    // it cannot be re-sent.
    const escapes = stopOffers(attributes, fresh)
      .filter((item: RunActionOffer): boolean => item.kind !== awaitingAction);
    return {
      kind: "waiting",
      headline: inFlightHeadline(awaitingAction),
      detail: escapes.length > 0 && awaitingAction === "cancel"
        ? "If it stays here, the process is not responding and can be force canceled."
        : "",
      offers: escapes,
      showProgress: true,
    };
  }

  if (TERMINAL_STATUSES.has(status)) {
    return {
      kind: "settled",
      headline: SETTLED_HEADLINES[status] ?? "Run finished",
      detail: "",
      offers: [],
      showProgress: false,
    };
  }

  // Speculative and plan-only runs stop at a finished plan by design. This is
  // checked before the confirmable branch, because such a run reaches
  // `planned` whether or not the API marks it confirmable, and either way the
  // honest thing to say is that it never applies.
  // `needs_confirmation` belongs here too: it is the status whose whole name
  // says a human is being waited on, and it reached the generic
  // "Run in progress" branch whenever the API omitted `actions`.
  const planFinished = ["planned", "planned_and_saved", "needs_confirmation"].includes(status);
  if ((speculative || attributes["plan-only"] === true) && planFinished) {
    return {
      kind: "settled",
      headline: speculative
        ? "Speculative plan — this run never applies"
        : "Plan-only run — this run never applies",
      detail: "It exists to show what would change. Start a normal run to apply.",
      offers: [],
      showProgress: false,
    };
  }

  if (status === "policy_soft_failed" || status === "policy_override") {
    const canOverride = fresh && permissions?.["can-override-policy-check"] === true;
    // Overrides require a recorded justification comment (enforced by the
    // API): without comment permission the offer must stay blocked, or the
    // panel would invite an action that can never carry its justification.
    const canJustify = fresh && permissions?.["can-comment"] === true;
    return {
      kind: "decide",
      headline: "A policy check needs an override before this run can apply",
      detail: canOverride
        ? (canJustify
          ? "Overrides are recorded with your comment. Explain why the finding is acceptable."
          : "Overrides are recorded with a justification comment, which needs comment permission on this run.")
        : "Someone with override permission has to accept the finding, or the run can be discarded.",
      offers: [
        offer(
          "override-policy",
          "Override policy check",
          "primary",
          !canOverride
            ? permissionBlocker(fresh, false, "You do not have permission to override policy checks.")
            : (!canJustify ? "Overriding requires a written justification, and you cannot comment on this run." : null),
        ),
        ...discardOffer(attributes, fresh, "Discard run"),
      ],
      showProgress: false,
    };
  }

  if (actions?.["is-confirmable"] === true) {
    return {
      kind: "decide",
      headline: "This run is waiting for you to apply it",
      detail: "Review the planned changes below, then apply them or discard the plan.",
      offers: [
        offer("apply", "Apply changes", "primary", applyBlocker(attributes, fresh)),
        ...discardOffer(attributes, fresh, "Discard plan"),
      ],
      showProgress: false,
    };
  }

  // Planned, but the API says it cannot be confirmed — usually because a newer
  // run has superseded it. Nothing is asked, so say the plan is done and stop;
  // the phase sections below report the outcome.
  if (planFinished) {
    return {
      kind: "settled",
      headline: "Plan finished",
      detail: "",
      offers: discardOffer(attributes, fresh, "Discard plan"),
      showProgress: false,
    };
  }

  return {
    kind: "waiting",
    headline: WAITING_HEADLINES[status] ?? "Run in progress",
    detail: "",
    offers: stopOffers(attributes, fresh),
    showProgress: true,
  };
}

/**
 * Confirmation copy for an action, shown before it is sent.
 *
 * `confirmLabel` deliberately does not repeat the offer's label. When the two
 * matched, the page had two differently-consequential buttons with the same
 * accessible name a click apart, and neither the user nor a screen reader
 * could tell from the label alone which step they were on.
 */
export const ACTION_CONFIRMATIONS: Readonly<Record<RunActionKind, Readonly<{
  title: string;
  body: string;
  confirmLabel: string;
  successTitle: string;
}>>> = {
  apply: {
    title: "Apply these changes?",
    body: "Terraform will make the planned changes to your real infrastructure. This cannot be undone automatically.",
    confirmLabel: "Yes, apply changes",
    successTitle: "Run queued for apply",
  },
  discard: {
    title: "Discard this plan?",
    body: "The plan is thrown away and nothing changes. You can start a new run whenever you like.",
    confirmLabel: "Yes, discard the plan",
    successTitle: "Run discarded",
  },
  cancel: {
    title: "Cancel this run?",
    body: "The run stops where it is. Steps that already completed are kept; nothing further executes.",
    confirmLabel: "Yes, cancel the run",
    successTitle: "Run canceled",
  },
  "force-cancel": {
    title: "Force cancel this run?",
    body: "This releases the workspace lock without waiting for the process to exit. Use it only when a canceled run is stuck — a process that is still running may leave partial state behind.",
    confirmLabel: "Yes, force cancel",
    successTitle: "Run force canceled",
  },
  "override-policy": {
    title: "Override the policy check?",
    body: "This records an override with your comment and unblocks the apply. Overrides are audited.",
    confirmLabel: "Yes, override the check",
    successTitle: "Policy check overridden",
  },
};

/**
 * Extra warning for canceling mid-apply, where the risk is materially
 * different from canceling a plan.
 */
export function cancelRiskNote(status: string): string | null {
  return status === "applying"
    ? "Terraform is part-way through applying. It may have already written partial state: run a refresh-only plan afterwards and check for tainted resources before applying again."
    : null;
}
