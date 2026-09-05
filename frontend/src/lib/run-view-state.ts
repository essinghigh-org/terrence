/**
 * Wire shapes for the run page. These live beside the state machine rather
 * than inside the view so the reducer can be tested without rendering.
 */

export type RunActions = Readonly<{
  "is-cancelable"?: boolean;
  "is-confirmable"?: boolean;
  "is-discardable"?: boolean;
  "is-force-cancelable"?: boolean;
}>;

export type RunPermissions = Readonly<{
  "can-apply"?: boolean;
  "can-cancel"?: boolean;
  "can-comment"?: boolean;
  "can-discard"?: boolean;
  "can-force-cancel"?: boolean;
  "can-override-policy-check"?: boolean;
}>;

export type RunAttributes = Readonly<{
  actions?: RunActions;
  "allow-empty-apply"?: boolean;
  "auto-apply"?: boolean;
  branch?: string | null;
  "commit-sha"?: string | null;
  "commit-url"?: string | null;
  "created-at"?: string;
  "duration-baseline"?: Readonly<{
    "duration-seconds"?: number | null;
    "median-duration-seconds"?: number | null;
    "is-slow"?: boolean;
  }> | null;
  "has-changes"?: boolean;
  "has-recovery-state"?: boolean;
  "is-destroy"?: boolean;
  message?: string | null;
  operation?: string;
  permissions?: RunPermissions;
  "plan-only"?: boolean;
  "refresh-only"?: boolean;
  "resource-additions"?: number;
  "resource-changes"?: number;
  "resource-destructions"?: number;
  "resource-imports"?: number;
  source?: string;
  status: string;
  "status-timestamps"?: Readonly<Record<string, string>> | null;
  "terraform-version"?: string | null;
  "trigger-reason"?: string;
  "triggered-by"?: string | null;
  "triggered-by-avatar-url"?: string | null;
  "workspace-locked"?: boolean;
  "workspace-locked-reason"?: string | null;
}>;

export type RunResource = Readonly<{
  id: string;
  attributes: RunAttributes;
  relationships?: Readonly<{
    "created-by"?: Readonly<{ data: Readonly<{ id: string; type: string }> | null }>;
    workspace?: Readonly<{ data: Readonly<{ id: string; type: string }> }>;
    "configuration-version"?: Readonly<{ data: Readonly<{ id: string; type: string }> | null }>;
  }>;
}>;

export type PhaseResource = Readonly<{
  attributes: Readonly<{
    "log-read-url"?: string | null;
    status: string;
    "resource-additions"?: number | null;
    "resource-changes"?: number | null;
    "resource-destructions"?: number | null;
    "resource-imports"?: number | null;
    "status-timestamps"?: Readonly<Record<string, string>> | null;
  }>;
}>;

export type RunComment = Readonly<{
  id: string;
  attributes: Readonly<{
    "actor-username"?: string | null;
    "actor-avatar-url"?: string | null;
    body: string;
    "created-at"?: string;
  }>;
}>;

export type RunEvent = Readonly<{
  id: string;
  attributes: Readonly<{
    action: string;
    "actor-username"?: string | null;
    "actor-avatar-url"?: string | null;
    "created-at"?: string;
    details?: Readonly<{
      fromStatus?: string;
      source?: string;
      toStatus?: string;
      triggerReason?: string;
    }>;
  }>;
}>;

export type CostEstimate = Readonly<{
  id: string;
  attributes: Readonly<{
    status: string;
    "prior-monthly-cost"?: string;
    "proposed-monthly-cost"?: string;
    "delta-monthly-cost"?: string;
    "resources-count"?: number;
    "matched-resources-count"?: number;
    "unmatched-resources-count"?: number;
    "error-message"?: string | null;
    "terrence:infracost-enabled"?: boolean;
  }>;
}>;

export type PolicyCheck = Readonly<{
  id: string;
  attributes: Readonly<{
    status: string;
    result?: unknown;
    "policy-name"?: string | null;
    "enforcement-level"?: string | null;
    "created-at"?: string;
  }>;
}>;

export type AssessmentCheck = Readonly<{
  id: string;
  attributes: Readonly<{
    address?: string | null;
    kind?: string | null;
    status: string;
    message?: string | null;
    detail?: unknown;
  }>;
}>;

export type IncludedUser = Readonly<{
  id: string;
  type: string;
  attributes: Readonly<{ username: string; "avatar-url"?: string }>;
}>;

/** Run sections that can be refetched independently. */
export type AuxKind = "plan" | "apply" | "cost" | "policy" | "assessments" | "events" | "comments";
export const ALL_AUX_KINDS: readonly AuxKind[] = [
  "plan", "apply", "cost", "policy", "assessments", "events", "comments",
];

/** Reader-facing name for a section, for messages that name what went wrong. */
const AUX_LABELS: Readonly<Record<AuxKind, string>> = {
  plan: "the plan",
  apply: "the apply",
  cost: "the cost estimate",
  policy: "policy checks",
  assessments: "health checks",
  events: "the activity timeline",
  comments: "comments",
};

export function sectionLabel(kind: AuxKind): string {
  return AUX_LABELS[kind];
}

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "applied",
  "canceled",
  "discarded",
  "errored",
  "failed",
  "force_canceled",
  "planned_and_finished",
  // A hard policy failure ends the run: nothing can override it, so there is
  // no decision left to take and nothing further will execute. Omitting it
  // here made the page poll a dead run forever and describe it as
  // "Run in progress" under a red "Policy check failed" badge.
  "policy_hard_failed",
  "unreachable",
]);

/** Statuses in which the run is still moving under its own power. */
export function isRunActive(status: string | null): boolean {
  return status !== null && status !== "" && !TERMINAL_STATUSES.has(status);
}

/**
 * A plan-only run whose plan has finished will never move again, but its
 * `planned` status is not terminal (a normal run at `planned` still awaits
 * apply). The page must treat it as settled: no log cadence and no 15s full
 * refreshes. Mirrors the `settled` branch of `resolveRunDecision`, which is
 * the user-visible statement of the same fact.
 */
const SETTLED_PLAN_STATUSES: ReadonlySet<string> = new Set([
  "planned",
  "planned_and_saved",
  "needs_confirmation",
]);

export function isSettledPlanOnly(attributes: RunAttributes | undefined): boolean {
  if (attributes === undefined) return false;
  return attributes["plan-only"] === true && SETTLED_PLAN_STATUSES.has(attributes.status);
}

/**
 * Statuses where a phase is actively producing log output. These get the fast
 * log-tail cadence; merely queued statuses get the slow one, because nothing
 * is being written yet and a 2s poll would be pure load.
 */
const STREAMING_STATUSES: ReadonlySet<string> = new Set([
  "fetching",
  "pre_plan_running",
  "planning",
  "post_plan_running",
  "applying",
  "pre_apply_running",
  "post_apply_running",
]);

export function logPollIntervalMs(status: string | null): number | null {
  if (!isRunActive(status)) return null;
  return STREAMING_STATUSES.has(status ?? "") ? 2000 : 8000;
}

/** Statuses whose arrival means the plan-side derived sections have moved. */
const PLAN_PHASE_STATUSES: ReadonlySet<string> = new Set([
  "planned",
  "planned_and_saved",
  "planned_and_finished",
  "needs_confirmation",
  "cost_estimating",
  "cost_estimated",
  "policy_checking",
  "policy_override",
  "policy_checked",
  "policy_soft_failed",
  "policy_hard_failed",
]);

const APPLY_PHASE_STATUSES: ReadonlySet<string> = new Set(["applying", "applied"]);

/**
 * Which sections a status transition invalidates. A terminal transition
 * invalidates everything (the run is final and every section should settle on
 * its last value); otherwise only the phase that moved plus the event
 * timeline, which changes on every transition.
 */
export function auxKindsForStatus(status: string): readonly AuxKind[] {
  if (status === "" || TERMINAL_STATUSES.has(status)) return ALL_AUX_KINDS;
  if (PLAN_PHASE_STATUSES.has(status)) return ["plan", "policy", "cost", "assessments", "events"];
  if (APPLY_PHASE_STATUSES.has(status)) return ["apply", "events"];
  return ["events"];
}

export type LogPhaseState = Readonly<{
  /** Everything received so far, in order. Only ever grows. */
  text: string;
  /** Byte offset to resume the tail from. */
  offset: number;
  truncated: boolean;
}>;

export const EMPTY_LOG_PHASE: LogPhaseState = { text: "", offset: 0, truncated: false };

/**
 * Fold one tail response into a phase's log state.
 *
 * The invariant is that the pane only ever grows, and only ever with bytes
 * that directly continue what it already holds. Four things can arrive:
 *
 *  - A response for an offset we have already passed. Two polls were in
 *    flight; the older must not re-append bytes the newer committed.
 *  - A response for an offset we have *not* reached. Appending it would leave
 *    a silent hole in the middle of the log, so it is dropped and the next
 *    tick asks again from the right place. (This should not happen; it is
 *    cheaper to enforce than to assume.)
 *  - A total smaller than the offset we hold: the underlying stream was
 *    replaced — a re-run writing over the same phase, or a log rotation past
 *    the retention cap — so the local copy is stale and must be discarded
 *    rather than concatenated onto. The offset has to rewind to the start of
 *    the *new* stream; keeping a position from the old one leaves the pane
 *    permanently blank, forever asking for bytes past the end.
 *  - An empty chunk at the offset we hold: the ordinary idle case while a
 *    phase is running but quiet. It must not clear anything.
 */
export function appendLogChunk(
  current: LogPhaseState,
  tail: Readonly<{ chunk: string; totalBytes: number; totalKnown: boolean; nextOffset: number; truncated: boolean }>,
  requestedOffset: number,
): LogPhaseState {
  if (requestedOffset !== current.offset) return current;

  if (tail.totalKnown && tail.totalBytes < requestedOffset) {
    // Restart from the beginning of the replaced stream. `nextOffset` cannot
    // be trusted here: an out-of-range read returns an empty body, which
    // would park the offset where it already is.
    return { text: "", offset: 0, truncated: tail.truncated };
  }

  if (tail.chunk === "") {
    // Bytes exist that we do not have, yet the body was empty — a stripped or
    // truncated response. Rewind so the next read fetches them, rather than
    // parking here forever.
    if (tail.totalKnown && tail.totalBytes > requestedOffset) {
      return { text: "", offset: 0, truncated: tail.truncated };
    }
    return current.truncated === tail.truncated
      ? current
      : { ...current, truncated: tail.truncated };
  }

  return {
    text: requestedOffset === 0 ? tail.chunk : `${current.text}${tail.chunk}`,
    offset: tail.nextOffset,
    truncated: tail.truncated,
  };
}

export type RunViewState = Readonly<{
  run: RunResource | null;
  plan: PhaseResource | null;
  apply: PhaseResource | null;
  planLog: LogPhaseState;
  applyLog: LogPhaseState;
  cost: CostEstimate | null;
  policyChecks: readonly PolicyCheck[];
  assessments: readonly AssessmentCheck[];
  events: readonly RunEvent[];
  comments: readonly RunComment[];
  creatorUsername: string;
  creatorAvatarUrl: string;
  loading: boolean;
  loadError: string;
  /** True when the run row itself was read successfully and is current. */
  fresh: boolean;
  /**
   * Sections whose most recent refresh failed, in `ALL_AUX_KINDS` order.
   * Empty when all is well.
   */
  failedSections: readonly AuxKind[];
  /**
   * Set after a successful action POST to the status the run was in when the
   * action was sent. While the server still reports that status, the page
   * shows the action as in flight instead of re-offering it — which is what
   * made buttons flicker back to "Confirm & apply" for a beat after clicking.
   */
  awaitingTransitionFrom: string | null;
  /** The action that produced `awaitingTransitionFrom`, for busy copy. */
  awaitingAction: string | null;
}>;

export const INITIAL_RUN_VIEW_STATE: RunViewState = {
  run: null,
  plan: null,
  apply: null,
  planLog: EMPTY_LOG_PHASE,
  applyLog: EMPTY_LOG_PHASE,
  cost: null,
  policyChecks: [],
  assessments: [],
  events: [],
  comments: [],
  creatorUsername: "",
  creatorAvatarUrl: "",
  loading: true,
  loadError: "",
  fresh: false,
  failedSections: [],
  awaitingTransitionFrom: null,
  awaitingAction: null,
};

export type RunViewAction =
  | { type: "reset" }
  | { type: "run-loaded"; run: RunResource; creatorUsername: string; creatorAvatarUrl: string }
  | { type: "run-failed"; message: string }
  | { type: "run-missing" }
  | { type: "section"; kind: AuxKind; value: unknown }
  | { type: "aux-status"; kinds: readonly AuxKind[]; failed: readonly AuxKind[] }
  | {
      type: "log-chunk";
      phase: "plan" | "apply";
      requestedOffset: number;
      tail: Readonly<{ chunk: string; totalBytes: number; totalKnown: boolean; nextOffset: number; truncated: boolean }>;
    }
  | { type: "action-sent"; action: string; fromStatus: string }
  | { type: "action-settled" };

/** Unwrap a JSON:API collection envelope. */
function envelopeArray(value: unknown): readonly unknown[] {
  const data = (value as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as readonly unknown[]) : [];
}

/** Unwrap a JSON:API single-resource envelope. */
function envelopeResource(value: unknown): unknown {
  const data = (value as { data?: unknown } | null)?.data;
  return data ?? null;
}

/**
 * Commit one section's response. Split out of the reducer so the reducer reads
 * as a list of state transitions rather than a list of endpoint shapes.
 *
 * SAFETY: each endpoint's envelope shape is fixed by its route; the individual
 * fields are guarded where the view reads them.
 */
function applySection(state: RunViewState, kind: AuxKind, value: unknown): RunViewState {
  switch (kind) {
    case "plan":
      return { ...state, plan: envelopeResource(value) as PhaseResource | null };
    case "apply":
      return { ...state, apply: envelopeResource(value) as PhaseResource | null };
    case "cost":
      return { ...state, cost: envelopeResource(value) as CostEstimate | null };
    case "policy":
      return { ...state, policyChecks: envelopeArray(value) as readonly PolicyCheck[] };
    case "assessments":
      return { ...state, assessments: envelopeArray(value) as readonly AssessmentCheck[] };
    case "events":
      return { ...state, events: envelopeArray(value) as readonly RunEvent[] };
    case "comments":
      return { ...state, comments: envelopeArray(value) as readonly RunComment[] };
    default:
      return state;
  }
}

/**
 * The whole run page reduces through here. Every path that used to call one of
 * a dozen `setX` setters now goes through one transition, so there is exactly
 * one place where "what the page believes about this run" changes — and it is
 * impossible for a status to be updated without the sections that depend on it
 * being reconciled in the same commit.
 */
export function runViewReducer(
  state: RunViewState,
  action: Readonly<RunViewAction>,
): RunViewState {
  switch (action.type) {
    case "reset":
      return INITIAL_RUN_VIEW_STATE;
    case "run-loaded": {
      const status = action.run.attributes.status;
      // Clear the in-flight action as soon as the run actually leaves the
      // status it was sent from. This is what makes the busy state truthful
      // rather than a fixed timeout.
      const stillAwaiting = state.awaitingTransitionFrom !== null
        && state.awaitingTransitionFrom === status;
      return {
        ...state,
        run: action.run,
        creatorUsername: action.creatorUsername,
        creatorAvatarUrl: action.creatorAvatarUrl,
        loading: false,
        loadError: "",
        fresh: true,
        awaitingTransitionFrom: stillAwaiting ? state.awaitingTransitionFrom : null,
        awaitingAction: stillAwaiting ? state.awaitingAction : null,
      };
    }
    case "run-failed":
      return { ...state, loading: false, fresh: false, loadError: action.message };
    case "run-missing":
      // The run is gone; any action reported as in flight against it never
      // has a transition to wait for.
      return { ...state, loading: false, fresh: false, run: null, awaitingTransitionFrom: null, awaitingAction: null };
    case "section":
      return applySection(state, action.kind, action.value);
    case "aux-status": {
      // Track *which* sections are failing, not just whether the last pass
      // had a failure. A refresh that touches only the event timeline must
      // not clear a failure reported by the cost estimate, and must not
      // re-assert one it did not look at — which is what made the
      // "Some run details could not be refreshed" banner flap between
      // passes that happened to fetch different subsets.
      const touched = new Set(action.kinds);
      const nowFailing = new Set(action.failed);
      const next = ALL_AUX_KINDS.filter((kind: AuxKind): boolean =>
        nowFailing.has(kind)
        || (!touched.has(kind) && state.failedSections.includes(kind)));
      const unchanged = next.length === state.failedSections.length
        && next.every((kind: AuxKind, index: number): boolean => state.failedSections[index] === kind);
      return unchanged ? state : { ...state, failedSections: next };
    }
    case "log-chunk": {
      const key = action.phase === "plan" ? "planLog" : "applyLog";
      const next = appendLogChunk(state[key], action.tail, action.requestedOffset);
      return next === state[key] ? state : { ...state, [key]: next };
    }
    case "action-sent":
      return { ...state, awaitingTransitionFrom: action.fromStatus, awaitingAction: action.action };
    case "action-settled":
      return { ...state, awaitingTransitionFrom: null, awaitingAction: null };
    default:
      return state;
  }
}

/** Read the creator identity out of a run envelope's `included` users. */
export function resolveCreator(
  run: Readonly<RunResource>,
  included: unknown,
): Readonly<{ username: string; avatarUrl: string }> {
  const creatorId = run.relationships?.["created-by"]?.data?.id;
  if (creatorId !== undefined && Array.isArray(included)) {
    const creator = (included as readonly IncludedUser[]).find(
      (user: IncludedUser): boolean => user.id === creatorId && user.type === "users",
    );
    if (creator !== undefined) {
      return {
        username: creator.attributes.username,
        avatarUrl: creator.attributes["avatar-url"] ?? "",
      };
    }
  }
  return {
    username: run.attributes["triggered-by"] ?? "",
    avatarUrl: run.attributes["triggered-by-avatar-url"] ?? "",
  };
}
