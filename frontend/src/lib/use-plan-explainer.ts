import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  ApiError,
  enqueueExplanation,
  fetchExplanation,
  streamExplain,
  type ExplainKind,
  type ExplainStreamEvent,
  type ReasoningEffort,
} from "./api";
import { waitForAbortableDelay } from "./run-detail-format";

type ExplainSession = Readonly<{
  runId: string;
  kind: ExplainKind;
  signal: Readonly<AbortSignal>;
  isCurrent: () => boolean;
  setExplanation: Dispatch<SetStateAction<string>>;
  setExplainerThinking: Dispatch<SetStateAction<string>>;
  setExplainerModel: Dispatch<SetStateAction<string>>;
  setExplainerReasoningEffort: Dispatch<SetStateAction<ReasoningEffort | null>>;
  setExplainError: Dispatch<SetStateAction<string>>;
}>;

function isSignalAborted(session: ExplainSession): boolean {
  return session.signal.aborted;
}

// Durable: non-stream POST enqueues a background job (tab-close safe).
// The GET polls that job until the cached explanation appears. Abort-aware
// so cancel/unmount stops polling and prevents setState after abort.
async function pollExplanationUntilReady(session: ExplainSession, timeoutMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isSignalAborted(session)) return false;
    const row = await fetchExplanation(session.runId, session.kind).catch((): null => null);
    if (isSignalAborted(session)) return false;
    if (row !== null && row.explanation !== "") {
      session.setExplanation(row.explanation);
      session.setExplainerModel(row.model);
      session.setExplainerReasoningEffort(row.reasoningEffort);
      return true;
    }
    if (row !== null && row.status === "failed") {
      session.setExplainError("Plan explainer failed. Check the endpoint, model, and API key, then try again.");
      return false;
    }
    if (Date.now() >= deadline) return false;
    const retry = await waitForAbortableDelay(session.signal, 1500);
    if (!retry) return false;
  }
}

function applyStreamEvent(
  event: Readonly<ExplainStreamEvent>,
  session: ExplainSession,
): boolean {
  if (!session.isCurrent()) return false;
  if (event.name === "meta") {
    session.setExplainerModel(event.data.model);
    session.setExplainerReasoningEffort(event.data["reasoning-effort"]);
  } else if (event.name === "progress") {
    return true;
  } else if (event.name === "thinking") {
    session.setExplainerThinking((current): string => `${current}${event.data.text}`);
  } else if (event.name === "content") {
    session.setExplanation((current): string => `${current}${event.data.text}`);
  } else if (event.name === "content-reset") {
    session.setExplanation(event.data.text);
  }
  return false;
}

async function settleStreamSession(session: ExplainSession, sawProgress: boolean): Promise<void> {
  // Durable job enqueued: poll GET until the cached explanation lands.
  if (sawProgress && session.isCurrent()) {
    const ready = await pollExplanationUntilReady(session);
    if (!ready && session.isCurrent() && !isSignalAborted(session)) {
      await enqueueExplanation(session.runId, session.kind).catch((): null => null);
      const settled = await pollExplanationUntilReady(session);
      if (!settled && session.isCurrent() && !isSignalAborted(session)) {
        session.setExplainError("The explanation did not finish in time. Try again.");
      }
    }
  }
}

async function handleExplainError(caught: unknown, session: ExplainSession, sawProgress: boolean): Promise<void> {
  if (isSignalAborted(session)) {
    return;
  }
  const msg = caught instanceof Error ? caught.message : String(caught);
  const isProgressStream = sawProgress || /without a done event/i.test(msg);
  if (isProgressStream && !isSignalAborted(session)) {
    const ready = await pollExplanationUntilReady(session).catch((): boolean => false);
    if (ready) return;
  }
  // 202/queued path: enqueue durably and poll; closing the tab no longer aborts the LLM call.
  if (caught instanceof ApiError && (caught.status === 202 || /queued|job/i.test(caught.message))) {
    if (await enqueueAndPollExplanation(session)) return;
  }
  session.setExplainError(msg);
}

/**
 * Enqueue a durable explanation job and poll until it lands. Returns true
 * when the caller should stop (ready, aborted, or terminally failed with
 * its own message); false when the caller should fall through to the
 * generic error.
 */
async function enqueueAndPollExplanation(session: ExplainSession): Promise<boolean> {
  try {
    if (isSignalAborted(session)) return true;
    await enqueueExplanation(session.runId, session.kind);
    const ready = await pollExplanationUntilReady(session);
    return ready;
  } catch (enqueueErr) {
    if (isSignalAborted(session) || !session.isCurrent()) return true;
    console.error("Failed to enqueue explanation:", enqueueErr);
    session.setExplainError(enqueueErr instanceof Error ? enqueueErr.message : "Failed to enqueue explanation.");
    return true;
  }
}

export type PlanExplainer = Readonly<{
  explainerOpen: boolean;
  setExplainerOpen: (open: boolean) => void;
  explainerKind: ExplainKind;
  explaining: boolean;
  explanation: string;
  explainerThinking: string;
  explainerThinkingOpen: boolean;
  setExplainerThinkingOpen: (open: boolean) => void;
  explainerElapsedSeconds: number;
  explainerModel: string;
  explainerReasoningEffort: ReasoningEffort | null;
  explainError: string;
  handleExplain: (kind: ExplainKind, refresh: boolean) => Promise<void>;
  cancelExplanation: () => void;
}>;

/**
 * Plain-language explanation of the stored plan JSON or a failed apply log
 * via the configured OpenAI-compatible endpoint. Read-only; never mutates
 * the run. Streaming path: the backend relays upstream deltas as SSE events
 * and replays cached generations under the same envelope, so re-opening the
 * dialog never re-burns tokens.
 */
export function usePlanExplainer(runId: string): PlanExplainer {
  const [explainerOpen, setExplainerOpen] = useState(false);
  const [explainerKind, setExplainerKind] = useState<ExplainKind>("plan");
  const [explaining, setExplaining] = useState(false);
  const [explanation, setExplanation] = useState("");
  const [explainerThinking, setExplainerThinking] = useState("");
  const [explainerThinkingOpen, setExplainerThinkingOpen] = useState(false);
  const [explainerElapsedSeconds, setExplainerElapsedSeconds] = useState(0);
  const [explainerStartedAt, setExplainerStartedAt] = useState<number | null>(null);
  const [explainerReasoningEffort, setExplainerReasoningEffort] = useState<ReasoningEffort | null>(null);
  const [explainerModel, setExplainerModel] = useState("");
  const [explainError, setExplainError] = useState("");
  const explainerAbortRef = useRef<AbortController | null>(null);

  // Abort any in-flight explanation when the view unmounts (e.g. the user
  // navigates away mid-stream).
  useEffect((): (() => void) => {
    return (): void => {
      explainerAbortRef.current?.abort();
      explainerAbortRef.current = null;
    };
  }, []);

  useEffect((): (() => void) | undefined => {
    if (explainerStartedAt === null) return undefined;
    const updateElapsed = (): void => {
      setExplainerElapsedSeconds(Math.floor((Date.now() - explainerStartedAt) / 1000));
    };
    updateElapsed();
    if (!explaining) return undefined;
    const timer = window.setInterval(updateElapsed, 1000);
    return (): void => { window.clearInterval(timer); };
  }, [explainerStartedAt, explaining]);

  async function handleExplain(kind: ExplainKind, refresh: boolean): Promise<void> {
    setExplainerOpen(true);
    setExplainerKind(kind);
    setExplaining(true);
    setExplanation("");
    setExplainerThinking("");
    setExplainerThinkingOpen(false);
    setExplainerElapsedSeconds(0);
    setExplainerStartedAt(Date.now());
    setExplainerReasoningEffort(null);
    setExplainerModel("");
    setExplainError("");
    // Only the latest stream may update the dialog state; abort any earlier
    // generation (e.g. a double-click on the button).
    explainerAbortRef.current?.abort();
    const controller = new AbortController();
    explainerAbortRef.current = controller;
    const progress = { seen: false };
    const session: ExplainSession = {
      runId,
      kind,
      signal: controller.signal,
      isCurrent: (): boolean => explainerAbortRef.current === controller,
      setExplanation,
      setExplainerThinking,
      setExplainerModel,
      setExplainerReasoningEffort,
      setExplainError,
    };
    try {
      await streamExplain(
        runId,
        kind,
        refresh,
        (event): void => { if (applyStreamEvent(event, session)) progress.seen = true; },
        controller.signal,
      );
      await settleStreamSession(session, progress.seen);
    } catch (caught: unknown) {
      await handleExplainError(caught, session, progress.seen);
    } finally {
      if (explainerAbortRef.current === controller) {
        explainerAbortRef.current = null;
        setExplaining(false);
        setExplainerThinking("");
      }
    }
  }

  function cancelExplanation(): void {
    const controller = explainerAbortRef.current;
    if (controller === null) return;
    controller.abort();
    explainerAbortRef.current = null;
    setExplaining(false);
    setExplainerThinking("");
    if (explanation === "") setExplainError("Generation canceled. Try again when ready.");
  }

  return {
    explainerOpen,
    setExplainerOpen,
    explainerKind,
    explaining,
    explanation,
    explainerThinking,
    explainerThinkingOpen,
    setExplainerThinkingOpen,
    explainerElapsedSeconds,
    explainerModel,
    explainerReasoningEffort,
    explainError,
    handleExplain,
    cancelExplanation,
  };
}
