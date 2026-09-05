import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { ApiError, fetchApi, fetchRunLogTail } from "./api";
import { useTerrenceEvent } from "./event-provider";
import {
  ALL_AUX_KINDS,
  INITIAL_RUN_VIEW_STATE,
  auxKindsForStatus,
  isRunActive,
  logPollIntervalMs,
  resolveCreator,
  runViewReducer,
  type AuxKind,
  type RunResource,
  type RunViewState,
} from "./run-view-state";

/**
 * How long to wait for a burst of status transitions to settle before
 * refetching. Long enough to collapse `planning`→`planned`→`cost_estimating`
 * into one refresh, short enough to feel immediate.
 */
const TRANSITION_DEBOUNCE_MS = 300;

/** Safety net when SSE is unavailable (proxy buffering, dropped stream). */
const DEGRADED_POLL_MS = 15_000;

/** Effect cleanup for the paths that register nothing. */
const noCleanup = (): void => undefined;

const AUX_ENDPOINTS: Readonly<Record<AuxKind, (runId: string) => string>> = {
  plan: (runId: string): string => `/api/v2/runs/${runId}/plan`,
  apply: (runId: string): string => `/api/v2/applies/apply-${runId}`,
  cost: (runId: string): string => `/api/v2/runs/${runId}/cost-estimate`,
  policy: (runId: string): string => `/api/v2/runs/${runId}/policy-checks`,
  assessments: (runId: string): string => `/api/v2/runs/${runId}/check-results`,
  events: (runId: string): string => `/api/v2/runs/${runId}/run-events`,
  comments: (runId: string): string => `/api/v2/runs/${runId}/comments`,
};

export type RunView = Readonly<{
  state: RunViewState;
  /** Force a full reload of every section. */
  refreshAll: () => void;
  /** Refresh the named sections (used after local mutations like commenting). */
  refresh: (kinds: readonly AuxKind[]) => void;
  /**
   * Record that a run action was accepted, so the page can show it as in
   * flight until the run's status actually moves.
   */
  markActionSent: (action: string) => void;
  markActionSettled: () => void;
}>;

/**
 * Owns everything the run page knows and every path by which it changes.
 *
 * The page this replaces kept fourteen independent pieces of state refreshed
 * by four overlapping loops (a 30s timer, a visibility handler, an SSE
 * debounce, and a 4s log poll) that shared one boolean `refreshing` guard.
 * Three consequences, all of which the user sees as "the page is wrong":
 *
 *  1. Transitions were dropped. Any SSE event arriving while a refresh was in
 *     flight was discarded — the handler re-armed the 30s timer and returned —
 *     so a run could sit visibly in `planning` for half a minute after it had
 *     already finished. Here, a transition that arrives mid-refresh is queued
 *     into `pendingKinds` and drained when the current pass completes, so no
 *     transition is ever lost.
 *
 *  2. Responses could land out of order. Nothing sequenced the writes, so a
 *     slow `planned` response resolving after a fast `applying` one wrote the
 *     older status over the newer. Every read now carries a monotonic sequence
 *     number and a response is discarded if a later-issued read for the same
 *     section already landed.
 *
 *  3. Logs never advanced past the first page (see `fetchRunLogTail`).
 *
 * The loops are also collapsed into one: a single cadence derived from run
 * status, which stops entirely at a terminal status instead of polling a
 * finished run forever.
 */
export function useRunView(runId: string): RunView {
  const [state, dispatch] = useReducer(runViewReducer, INITIAL_RUN_VIEW_STATE);

  // Monotonic sequencing. `issued` hands out ticket numbers; `applied` records
  // the highest ticket whose response has been committed for each section, so
  // a straggler can be recognised and dropped.
  const issuedRef = useRef(0);
  const appliedRef = useRef<Map<string, number>>(new Map());
  /** Take the next ticket. Tickets are global, so ordering holds across sections. */
  const claim = useCallback((): number => {
    issuedRef.current += 1;
    return issuedRef.current;
  }, []);
  /**
   * True when `seq` is the newest response yet seen for `key`. Claims the slot
   * as a side effect, so two responses from the same tick cannot both win.
   */
  const isCurrent = useCallback((key: string, seq: number): boolean => {
    const applied = appliedRef.current.get(key) ?? 0;
    if (seq <= applied) return false;
    appliedRef.current.set(key, seq);
    return true;
  }, []);

  // Work queued while a refresh pass is running.
  const pendingKindsRef = useRef<Set<AuxKind>>(new Set());
  const pendingRunRef = useRef(false);
  /**
   * Which controller's drain loop is currently running, rather than a plain
   * boolean.
   *
   * A boolean deadlocks on navigation between two runs: the outgoing loop is
   * still parked on an `await` when the new run's effect calls `drain`, so the
   * new drain sees "already draining" and returns — while the old loop, on
   * resuming, finds its own signal aborted and exits without picking up the
   * work that was queued for the new run. The result is a run page that never
   * loads until something else happens to enqueue. Keying on the controller
   * lets a new generation start immediately, and stops a stale loop's
   * `finally` from releasing a lock it no longer holds.
   */
  const drainingForRef = useRef<AbortController | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  /**
   * The run the live controller belongs to. Callbacks are per-run closures, so
   * a timer or promise left over from a previous run must be prevented from
   * driving work against the current one — a check that costs nothing and
   * removes the whole class of cross-run contamination rather than one path
   * through it.
   */
  const controllerRunIdRef = useRef<string>("");
  const statusRef = useRef<string | null>(null);

  const loadRun = useCallback(async (signal: Readonly<AbortSignal>): Promise<void> => {
    const seq = claim();
    try {
      const response = await fetchApi<{ data: RunResource; included?: unknown }>(
        `/api/v2/runs/${runId}`,
        { signal },
      );
      if (signal.aborted || !isCurrent("run", seq)) return;
      const creator = resolveCreator(response.data, response.included);
      dispatch({
        type: "run-loaded",
        run: response.data,
        creatorUsername: creator.username,
        creatorAvatarUrl: creator.avatarUrl,
      });
    } catch (error: unknown) {
      if (signal.aborted || !isCurrent("run", seq)) return;
      if (error instanceof ApiError && error.status === 404) {
        dispatch({ type: "run-missing" });
        return;
      }
      dispatch({
        type: "run-failed",
        message: error instanceof Error ? error.message : "Could not load run",
      });
    }
  }, [runId, claim, isCurrent]);

  const loadSections = useCallback(async (
    kinds: readonly AuxKind[],
    signal: Readonly<AbortSignal>,
  ): Promise<void> => {
    if (kinds.length === 0) return;
    const tickets = kinds.map((): number => claim());
    const results = await Promise.allSettled(
      kinds.map(async (kind: AuxKind): Promise<unknown> =>
        fetchApi(AUX_ENDPOINTS[kind](runId), { signal })),
    );
    if (signal.aborted) return;
    const failed: AuxKind[] = [];
    kinds.forEach((kind: AuxKind, index: number): void => {
      const result = results[index];
      const seq = tickets[index] ?? 0;
      if (result === undefined || result.status === "rejected") {
        failed.push(kind);
        return;
      }
      if (!isCurrent(kind, seq)) return;
      dispatch({ type: "section", kind, value: result.value });
    });
    dispatch({ type: "aux-status", kinds, failed });
  }, [runId, claim, isCurrent]);

  const loadLogTail = useCallback(async (
    phase: "plan" | "apply",
    offset: number,
    signal: Readonly<AbortSignal>,
  ): Promise<void> => {
    const key = `log:${phase}`;
    const seq = claim();
    try {
      const tail = await fetchRunLogTail(runId, phase, offset, signal);
      if (signal.aborted || !isCurrent(key, seq)) return;
      dispatch({ type: "log-chunk", phase, requestedOffset: offset, tail });
    } catch {
      // A phase whose log does not exist yet 404s; that is not an error worth
      // surfacing, and the next tick retries.
    }
  }, [runId, claim, isCurrent]);

  /**
   * Run every queued unit of work, then check whether more arrived while we
   * were busy and loop if so. This is the piece that makes dropped
   * transitions impossible: `enqueue` never has to decide whether it is safe
   * to start work, it only records what needs doing.
   */
  const drain = useCallback(async (): Promise<void> => {
    const controller = controllerRef.current;
    if (controller === null || controller.signal.aborted) return;
    if (controllerRunIdRef.current !== runId) return;
    // Only one loop per controller. A loop for a *previous* controller may
    // still be unwinding; it holds no claim on this one.
    if (drainingForRef.current === controller) return;
    drainingForRef.current = controller;
    const { signal } = controller;
    try {
      for (;;) {
        if (signal.aborted) break;
        const wantRun = pendingRunRef.current;
        const kinds = [...pendingKindsRef.current];
        if (!wantRun && kinds.length === 0) break;
        pendingRunRef.current = false;
        pendingKindsRef.current = new Set();
        // The run row first: sections are interpreted relative to its status,
        // and reading it last would describe old sections with a new status.
        if (wantRun) await loadRun(signal);
        await loadSections(kinds, signal);
      }
    } finally {
      // Release only if a newer generation has not already claimed the slot.
      if (drainingForRef.current === controller) drainingForRef.current = null;
    }
  }, [runId, loadRun, loadSections]);

  const enqueue = useCallback((kinds: readonly AuxKind[], withRun: boolean): void => {
    if (withRun) pendingRunRef.current = true;
    for (const kind of kinds) pendingKindsRef.current.add(kind);
    void drain();
  }, [drain]);

  const refreshAll = useCallback((): void => { enqueue(ALL_AUX_KINDS, true); }, [enqueue]);
  const refresh = useCallback((kinds: readonly AuxKind[]): void => { enqueue(kinds, false); }, [enqueue]);

  const markActionSent = useCallback((action: string): void => {
    dispatch({ type: "action-sent", action, fromStatus: statusRef.current ?? "" });
    enqueue(ALL_AUX_KINDS, true);
  }, [enqueue]);
  const markActionSettled = useCallback((): void => { dispatch({ type: "action-settled" }); }, []);

  // Lifecycle: one controller per run id. Everything in flight is aborted and
  // all state is discarded when the id changes, so a fast navigation between
  // two runs can never show run A's logs under run B's header.
  useEffect((): (() => void) => {
    const controller = new AbortController();
    controllerRef.current = controller;
    controllerRunIdRef.current = runId;
    appliedRef.current = new Map();
    pendingKindsRef.current = new Set();
    pendingRunRef.current = false;
    dispatch({ type: "reset" });
    enqueue(ALL_AUX_KINDS, true);
    void loadLogTail("plan", 0, controller.signal);
    void loadLogTail("apply", 0, controller.signal);
    return (): void => {
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
    // `enqueue`/`loadLogTail` are stable per run id via useCallback.
  }, [runId, enqueue, loadLogTail]);

  // Status transitions arrive on the app-global SSE stream. A trailing
  // debounce lets the last transition of a burst decide what to refetch.
  const debounceRef = useRef<number | undefined>(undefined);
  const latestStatusRef = useRef<string>("");

  /**
   * Cancel a pending transition refresh when the run id changes.
   *
   * The timer's callback closes over the `enqueue` of the run that was open
   * when the event arrived. Left to fire after a navigation, it would enqueue
   * run A's work against run B's live controller — which is not aborted, so
   * every staleness check passes — and commit run A's row as run B's state.
   * The page would then render its "run id does not match" fallback, which has
   * no retry, and if run A was terminal there would be no polling cadence left
   * to recover: a permanent hang on a page that looks merely slow. The status
   * ref is reset for the same reason.
   */
  useEffect((): (() => void) => {
    latestStatusRef.current = "";
    return (): void => {
      if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    };
  }, [runId]);

  useTerrenceEvent(
    "run.status",
    (data): boolean => data["run-id"] === runId,
    (data): void => {
      const status = data["status"];
      latestStatusRef.current = typeof status === "string" ? status : "";
      if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout((): void => {
        debounceRef.current = undefined;
        enqueue(auxKindsForStatus(latestStatusRef.current), true);
      }, TRANSITION_DEBOUNCE_MS);
    },
  );
  useTerrenceEvent(
    "comment.created",
    (data): boolean => data["run-id"] === runId,
    (): void => { refresh(["comments"]); },
  );

  // One cadence for the whole page, derived from run status. `pollMs` is a
  // number, not the status string, so the timer is not torn down and rebuilt
  // on every transition within the same activity class.
  const status = state.run?.attributes.status ?? null;
  const pollMs = logPollIntervalMs(status);
  const active = isRunActive(status);
  const planOffsetRef = useRef(0);
  const applyOffsetRef = useRef(0);
  // Mirrored in an effect rather than during render: a render React discards
  // must not be able to move these ahead of the state that was committed, or
  // the next tail would be requested from an offset the pane has not reached
  // and the log would gain an invisible gap.
  useEffect((): void => {
    statusRef.current = status;
    planOffsetRef.current = state.planLog.offset;
    applyOffsetRef.current = state.applyLog.offset;
  }, [status, state.planLog.offset, state.applyLog.offset]);

  // Whether each phase has begun writing. Polling a log that cannot exist yet
  // 404s on every tick for the life of the run, and the tail's catch is silent,
  // so it costs a request every 2s to learn nothing.
  const timestamps = state.run?.attributes["status-timestamps"] ?? {};
  const planStarted = typeof timestamps["planning-at"] === "string"
    || typeof timestamps["pre-plan-running-at"] === "string";
  const applyStarted = ["confirmed-at", "apply-queued-at", "applying-at", "applied-at"]
    .some((key: string): boolean => typeof timestamps[key] === "string");

  const tailPhases = useCallback((signal: Readonly<AbortSignal>): void => {
    if (planStarted) void loadLogTail("plan", planOffsetRef.current, signal);
    if (applyStarted) void loadLogTail("apply", applyOffsetRef.current, signal);
  }, [loadLogTail, planStarted, applyStarted]);

  useEffect((): (() => void) => {
    const controller = controllerRef.current;
    // A terminal run needs no cadence at all: the old page kept a 30s timer
    // refetching finished runs for as long as the tab stayed open.
    if (pollMs === null || controller === null) return noCleanup;
    let sinceFullRefresh = 0;
    const tick = (): void => {
      if (controller.signal.aborted || document.hidden) return;
      tailPhases(controller.signal);
      sinceFullRefresh += pollMs;
      // SSE is the primary signal; this is the fallback for when it is not
      // getting through, and it also catches phase artifacts (plan counts,
      // policy results) that land without a status transition of their own.
      if (sinceFullRefresh >= DEGRADED_POLL_MS) {
        sinceFullRefresh = 0;
        enqueue(auxKindsForStatus(statusRef.current ?? ""), true);
      }
    };
    const timer = window.setInterval(tick, pollMs);
    return (): void => { window.clearInterval(timer); };
  }, [pollMs, tailPhases, enqueue]);

  /**
   * One last read after the run settles.
   *
   * Stopping the cadence at a terminal status leaves a gap: the bytes written
   * between the final poll tick and the run finishing would never be fetched,
   * so a completed run could be missing the last second or two of its own
   * output — including, on a failure, the error at the very end that the user
   * came to read.
   */
  useEffect((): void => {
    if (active) return;
    const controller = controllerRef.current;
    if (controller === null || state.run === null) return;
    tailPhases(controller.signal);
  }, [active, state.run, tailPhases]);

  // Returning to a backgrounded tab: catch up once, immediately. Polling is
  // suspended while hidden, so an active run is by definition behind.
  useEffect((): (() => void) => {
    const onVisibility = (): void => {
      if (document.hidden) return;
      const controller = controllerRef.current;
      if (controller === null) return;
      // A settled run cannot have changed while the tab was hidden, so
      // refetching all seven sections on every focus is pure load. Its own
      // final read already stands.
      if (!active) return;
      enqueue(auxKindsForStatus(statusRef.current ?? ""), true);
      tailPhases(controller.signal);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return (): void => { document.removeEventListener("visibilitychange", onVisibility); };
  }, [enqueue, tailPhases, active]);

  return useMemo((): RunView => ({
    state,
    refreshAll,
    refresh,
    markActionSent,
    markActionSettled,
  }), [state, refreshAll, refresh, markActionSent, markActionSettled]);
}
