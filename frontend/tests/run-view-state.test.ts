import { expect, test } from "bun:test";
import {
  EMPTY_LOG_PHASE,
  INITIAL_RUN_VIEW_STATE,
  appendLogChunk,
  auxKindsForStatus,
  logPollIntervalMs,
  runViewReducer,
  type RunResource,
} from "../src/lib/run-view-state";

type Tail = Readonly<{
  chunk: string;
  totalBytes: number;
  totalKnown: boolean;
  nextOffset: number;
  truncated: boolean;
}>;

const tail = (
  chunk: string,
  totalBytes: number,
  nextOffset: number,
  truncated = false,
): Tail => ({ chunk, totalBytes, totalKnown: true, nextOffset, truncated });

/** A response from a server whose `X-Terrence-Log-Total-Bytes` was stripped. */
const tailWithoutTotal = (chunk: string, nextOffset: number): Tail =>
  ({ chunk, totalBytes: nextOffset, totalKnown: false, nextOffset, truncated: false });

const runAt = (status: string): RunResource => ({
  id: "run-1",
  attributes: { status, "status-timestamps": {} },
});

// ── Log tail folding ────────────────────────────────────────────────────────
// The pane must only ever grow. The old page re-read page one of a paged
// collection on a timer, so the text it showed depended on which response
// landed last.

test("the first chunk becomes the whole log", () => {
  const next = appendLogChunk(EMPTY_LOG_PHASE, tail("hello", 5, 5), 0);
  expect(next.text).toBe("hello");
  expect(next.offset).toBe(5);
});

test("a later chunk is appended, not substituted", () => {
  const first = appendLogChunk(EMPTY_LOG_PHASE, tail("hello", 5, 5), 0);
  const second = appendLogChunk(first, tail(" world", 11, 11), 5);
  expect(second.text).toBe("hello world");
  expect(second.offset).toBe(11);
});

test("an empty chunk at the current offset leaves the log alone", () => {
  const first = appendLogChunk(EMPTY_LOG_PHASE, tail("hello", 5, 5), 0);
  const idle = appendLogChunk(first, tail("", 5, 5), 5);
  expect(idle).toBe(first);
});

test("a response for an offset already passed is discarded", () => {
  // Two polls in flight at once: the older one must not be able to rewind the
  // pane by re-appending bytes the newer one already committed.
  const first = appendLogChunk(EMPTY_LOG_PHASE, tail("hello", 5, 5), 0);
  const stale = appendLogChunk(first, tail("hello", 5, 5), 0);
  expect(stale).toBe(first);
  expect(stale.text).toBe("hello");
});

test("a response for an offset not yet reached is dropped, not spliced in", () => {
  // Appending it would leave an invisible hole in the middle of the log.
  const first = appendLogChunk(EMPTY_LOG_PHASE, tail("hello", 5, 5), 0);
  const ahead = appendLogChunk(first, tail("world", 20, 20), 15);
  expect(ahead).toBe(first);
  expect(ahead.text).toBe("hello");
});

test("a stream that shrank rewinds to the start of the new one", () => {
  // A re-run writing over the same phase, or a rotation past the retention
  // cap, leaves the held offset past the end of the new stream. Splicing the
  // two together would show two runs' output as one — and keeping the old
  // offset would leave the pane blank forever, since an out-of-range read
  // returns an empty body and so never advances.
  const first = appendLogChunk(EMPTY_LOG_PHASE, tail("long previous output", 20, 20), 0);
  const replaced = appendLogChunk(first, tail("", 5, 20), 20);
  expect(replaced.text).toBe("");
  expect(replaced.offset).toBe(0);
});

test("an empty body hiding bytes we do not have rewinds instead of parking", () => {
  const first = appendLogChunk(EMPTY_LOG_PHASE, tail("hello", 5, 5), 0);
  // The server says there are 40 bytes but sent none: a stripped or truncated
  // response. Parking here would freeze the pane permanently.
  const rewound = appendLogChunk(first, tail("", 40, 5), 5);
  expect(rewound.offset).toBe(0);
});

test("an unknown total never triggers the shrink path", () => {
  // A proxy that drops X-* headers leaves the total unknowable. Guessing
  // "the stream shrank" from a missing header would wipe the pane on every
  // poll behind such a proxy.
  const first = appendLogChunk(EMPTY_LOG_PHASE, tailWithoutTotal("hello", 5), 0);
  expect(first.text).toBe("hello");
  const second = appendLogChunk(first, tailWithoutTotal(" world", 11), 5);
  expect(second.text).toBe("hello world");
});

test("truncation is reported even when no new bytes arrived", () => {
  const first = appendLogChunk(EMPTY_LOG_PHASE, tail("hello", 5, 5), 0);
  const flagged = appendLogChunk(first, tail("", 5, 5, true), 5);
  expect(flagged.truncated).toBe(true);
  expect(flagged.text).toBe("hello");
});

// ── Polling cadence ─────────────────────────────────────────────────────────

test("a finished run has no polling cadence", () => {
  expect(logPollIntervalMs("applied")).toBeNull();
  expect(logPollIntervalMs("errored")).toBeNull();
  expect(logPollIntervalMs("discarded")).toBeNull();
  expect(logPollIntervalMs(null)).toBeNull();
});

test("a hard policy failure is terminal, not a run still in progress", () => {
  // It was absent from every status table at once, so the page polled a dead
  // run forever and described it as "Run in progress" beneath a red
  // "Policy check failed" badge.
  expect(logPollIntervalMs("policy_hard_failed")).toBeNull();
  expect(auxKindsForStatus("policy_hard_failed")).toContain("policy");
});

test("a phase that is writing output polls faster than one that is queued", () => {
  const streaming = logPollIntervalMs("applying");
  const queued = logPollIntervalMs("apply_queued");
  if (streaming === null || queued === null) throw new Error("Active runs must have a cadence");
  expect(streaming).toBeLessThan(queued);
});

// ── Transition fan-out ──────────────────────────────────────────────────────

test("a transition refetches the phase that moved, plus the timeline", () => {
  expect(auxKindsForStatus("applying")).toEqual(["apply", "events"]);
  expect(auxKindsForStatus("planned")).toContain("plan");
  expect(auxKindsForStatus("planned")).toContain("policy");
});

test("a terminal transition refetches everything so every section settles", () => {
  const kinds = auxKindsForStatus("applied");
  const expected = ["plan", "apply", "cost", "policy", "assessments", "events", "comments"] as const;
  for (const kind of expected) {
    expect(kinds).toContain(kind);
  }
});

// ── In-flight actions ───────────────────────────────────────────────────────
// The click-flicker fix: an accepted action stays "in flight" until the run
// actually leaves the status it was sent from, rather than for a fixed delay.

test("an accepted action is held until the run's status actually changes", () => {
  let state = runViewReducer(INITIAL_RUN_VIEW_STATE, {
    type: "run-loaded",
    run: runAt("planned"),
    creatorUsername: "",
    creatorAvatarUrl: "",
  });
  state = runViewReducer(state, { type: "action-sent", action: "apply", fromStatus: "planned" });
  expect(state.awaitingAction).toBe("apply");

  // The refresh that immediately follows the POST usually still reports the
  // pre-action status, because no worker has picked the job up yet.
  state = runViewReducer(state, {
    type: "run-loaded",
    run: runAt("planned"),
    creatorUsername: "",
    creatorAvatarUrl: "",
  });
  expect(state.awaitingAction).toBe("apply");

  state = runViewReducer(state, {
    type: "run-loaded",
    run: runAt("apply_queued"),
    creatorUsername: "",
    creatorAvatarUrl: "",
  });
  expect(state.awaitingAction).toBeNull();
});

test("a failed action is released so the page offers it again", () => {
  let state = runViewReducer(INITIAL_RUN_VIEW_STATE, {
    type: "action-sent", action: "apply", fromStatus: "planned",
  });
  state = runViewReducer(state, { type: "action-settled" });
  expect(state.awaitingAction).toBeNull();
});

test("switching runs discards everything the page believed", () => {
  let state = runViewReducer(INITIAL_RUN_VIEW_STATE, {
    type: "log-chunk",
    phase: "plan",
    requestedOffset: 0,
    tail: tail("run A output", 12, 12),
  });
  expect(state.planLog.text).toBe("run A output");
  state = runViewReducer(state, { type: "reset" });
  expect(state.planLog.text).toBe("");
  expect(state.run).toBeNull();
});
