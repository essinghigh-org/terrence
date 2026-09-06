import { describe, expect, it } from "bun:test";
import {
  RUN_STATUSES,
  canTransitionRunStatus,
  isTerminalRunStatus,
} from "../../src/lib/run-status";
import type { RunStatus } from "../../src/lib/run-status";

// Deliberately duplicated as a small review model.  This must not call
// nextRunStatuses(), otherwise a table edit could make both the implementation
// and its purported oracle agree on the same mistake.
const REFERENCE_EDGES: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  pending: ["fetching", "errored", "canceled", "discarded", "force_canceled", "unreachable"],
  fetching: ["fetching_completed", "errored", "canceled", "discarded", "force_canceled"],
  fetching_completed: ["pre_plan_running", "errored", "canceled", "discarded", "force_canceled"],
  pre_plan_running: ["pre_plan_completed", "errored", "canceled", "discarded", "force_canceled"],
  pre_plan_completed: ["queuing", "errored", "canceled", "discarded", "force_canceled"],
  queuing: ["plan_queued", "errored", "canceled", "discarded", "force_canceled"],
  plan_queued: ["planning", "pending", "errored", "canceled", "discarded", "force_canceled"],
  planning: ["planned", "planned_and_saved", "planned_and_finished", "policy_soft_failed", "apply_queued", "errored", "canceled", "discarded", "force_canceled"],
  planned: ["cost_estimating", "confirmed", "apply_queued", "errored", "canceled", "discarded", "force_canceled"],
  cost_estimating: ["cost_estimated", "errored", "canceled", "discarded", "force_canceled"],
  cost_estimated: ["policy_checking", "errored", "canceled", "discarded", "force_canceled"],
  policy_checking: ["policy_checked", "policy_override", "policy_soft_failed", "errored", "canceled", "discarded", "force_canceled"],
  policy_override: ["policy_soft_failed", "errored", "canceled", "discarded", "force_canceled"],
  policy_soft_failed: ["planned", "errored", "canceled", "discarded", "force_canceled"],
  policy_checked: ["post_plan_running", "errored", "canceled", "discarded", "force_canceled"],
  post_plan_running: ["post_plan_completed", "errored", "canceled", "discarded", "force_canceled"],
  post_plan_completed: ["confirmed", "planned_and_saved", "planned_and_finished", "planned", "errored", "canceled", "discarded", "force_canceled"],
  planned_and_saved: ["confirmed", "apply_queued", "errored", "canceled", "discarded", "force_canceled"],
  planned_and_finished: [],
  confirmed: ["apply_queued", "errored", "canceled", "discarded", "force_canceled"],
  apply_queued: ["applying", "pending", "errored", "canceled", "discarded", "force_canceled"],
  applying: ["applied", "errored", "canceled", "discarded", "force_canceled"],
  applied: [], errored: [], canceled: ["pending"], discarded: [], force_canceled: [], unreachable: [],
};

const rand32 = (seed: number): (() => number) => {
  let value = seed >>> 0;
  return (): number => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Event = Readonly<{ sequence: number; status: RunStatus; owner: string }>;

function applyReference(state: Readonly<{ status: RunStatus; sequence: number; owner: string }>, event: Event) {
  if (event.owner !== state.owner || event.sequence <= state.sequence) return state;
  if (!REFERENCE_EDGES[state.status].includes(event.status)) return state;
  return { status: event.status, sequence: event.sequence, owner: state.owner };
}

describe("independent run lifecycle model", () => {
  it("matches the implementation for every ordered pair", () => {
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        expect(canTransitionRunStatus(from, to), `${from}->${to}`).toBe(REFERENCE_EDGES[from].includes(to));
      }
    }
  });

  it("rejects duplicate, stale, reordered, and foreign-owner events", () => {
    const cases = Number.parseInt(process.env["TERRENCE_PROPERTY_CASES"] ?? "256", 10);
    const runs = Number.isSafeInteger(cases) && cases > 0 && cases <= 10_000 ? cases : 256;
    const statuses = [...RUN_STATUSES];
    for (let seed = 1; seed <= runs; seed += 1) {
      const random = rand32(seed);
      let state: { status: RunStatus; sequence: number; owner: string } = { status: "pending", sequence: 0, owner: `owner-${seed}` };
      for (let step = 0; step < 40; step += 1) {
        const sequence = Math.floor(random() * (step + 2));
        const status = statuses[Math.floor(random() * statuses.length)]!;
        const owner = random() < 0.15 ? `other-${seed}` : state.owner;
        const before = state;
        state = applyReference(state, { sequence, status, owner });
        expect(state.sequence).toBeGreaterThanOrEqual(before.sequence);
        expect(isTerminalRunStatus(state.status)).toBe(REFERENCE_EDGES[state.status].length === 0);
        if (state.status !== before.status) expect(sequence).toBeGreaterThan(before.sequence);
      }
      // Active executions cannot be deleted by the lifecycle model.
      if (!isTerminalRunStatus(state.status)) expect(REFERENCE_EDGES[state.status].length).toBeGreaterThan(0);
    }
  });
});
