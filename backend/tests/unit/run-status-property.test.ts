import { describe, expect, it } from "bun:test";
import {
  RUN_STATUSES,
  RUN_TERMINAL_STATUSES,
  canTransitionRunStatus,
  isTerminalRunStatus,
  nextRunStatuses,
} from "../../src/lib/run-status";

/**
 * Property tests for the run status state machine (review item 22.8).
 *
 * The transition table in lib/run-status.ts is the single source of truth;
 * worker.ts's updateRunStatus guard warns on any write outside the table.
 * These tests pin the table's integrity properties so a future edit cannot
 * silently orphan a status, make a status unreachable, or open an illegal
 * edge:
 *   - model conformance: table and predicate agree on every ordered pair,
 *   - completeness: every status the source code writes is in the table,
 *   - reachability: every non-terminal status is reachable from `pending`,
 *   - terminal absorption: terminal statuses have no outgoing edges,
 *   - lifecycle legality: the canonical TFE chain and operator actions are
 *     edge-legal end to end,
 *   - seeded random walks: 2000 deterministic walks never take an illegal
 *     step and always terminate or stay inside the table.
 */

/** Statuses written by worker.ts updateRunStatus calls and routes/runs.ts actions. */
const OBSERVED_IN_SOURCE = [
  "pending", "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed",
  "queuing", "plan_queued", "planning", "planned", "cost_estimating", "cost_estimated",
  "policy_checking", "policy_override", "policy_soft_failed", "policy_checked",
  "post_plan_running", "post_plan_completed", "planned_and_saved", "planned_and_finished",
  "confirmed", "apply_queued", "applying", "applied", "errored", "canceled", "discarded",
  "force_canceled", "unreachable",
];

/** mulberry32 seeded PRNG (deterministic across runs and hosts). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("run status state machine", () => {
  it("model conformance: predicate and table agree on every ordered pair", (): void => {
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        expect(canTransitionRunStatus(from, to), `${from} -> ${to}`).toBe(
          nextRunStatuses(from).includes(to),
        );
      }
    }
  });

  it("completeness: table and observed source statuses are exactly the same set", (): void => {
    const table = new Set<string>(RUN_STATUSES);
    const observed = new Set<string>(OBSERVED_IN_SOURCE);
    for (const s of OBSERVED_IN_SOURCE) {
      expect(table.has(s), `missing status ${s}`).toBe(true);
    }
    // Bidirectional: every table entry must also be observed in the source,
    // so an added table status cannot silently diverge from reality.
    for (const s of RUN_STATUSES) {
      expect(observed.has(s), `table-only status ${s}`).toBe(true);
    }
    expect(RUN_STATUSES.length as number).toBe(OBSERVED_IN_SOURCE.length);
  });

  it("incoming edges: every status except pending is a legal target of some transition", (): void => {
    const targets = new Set<string>();
    for (const s of RUN_STATUSES) {
      for (const next of nextRunStatuses(s)) {
        targets.add(next);
      }
    }
    for (const s of RUN_STATUSES) {
      if (s === "pending") continue;
      expect(targets.has(s), `${s} has no incoming edge`).toBe(true);
    }
  });

  it("reachability: every non-terminal status is reachable from pending", (): void => {
    const queue = ["pending"];
    const seen = new Set<string>(queue);
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const next of nextRunStatuses(current)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    for (const s of RUN_STATUSES) {
      if (!isTerminalRunStatus(s)) {
        expect(seen.has(s), `${s} unreachable from pending`).toBe(true);
      }
    }
  });

  it("terminal absorption: terminal statuses have no outgoing edges and match the predicate", (): void => {
    for (const s of RUN_STATUSES) {
      const terminal = nextRunStatuses(s).length === 0;
      expect(isTerminalRunStatus(s), s).toBe(terminal);
      if (terminal) {
        expect((RUN_TERMINAL_STATUSES as readonly string[]).includes(s)).toBe(true);
      }
    }
  });

  it("lifecycle legality: canonical TFE chain and operator actions are edge-legal", (): void => {
    const chain = [
      "pending", "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed",
      "queuing", "plan_queued", "planning", "planned", "cost_estimating", "cost_estimated",
      "policy_checking", "policy_checked", "post_plan_running", "post_plan_completed",
      "planned_and_saved", "confirmed", "apply_queued", "applying", "applied",
    ];
    for (let i = 0; i < chain.length - 1; i += 1) {
      expect(canTransitionRunStatus(chain[i] as string, chain[i + 1] as string),
        `${chain[i]} -> ${chain[i + 1]}`).toBe(true);
    }
    // Operator actions.
    expect(canTransitionRunStatus("canceled", "pending")).toBe(true); // force-execute
    expect(canTransitionRunStatus("policy_soft_failed", "planned")).toBe(true); // override-policy
    expect(canTransitionRunStatus("plan_queued", "pending")).toBe(true); // re-queue
    expect(canTransitionRunStatus("apply_queued", "pending")).toBe(true); // re-queue
    // Soft-fail resting state.
    expect(canTransitionRunStatus("policy_checking", "policy_override")).toBe(true);
    expect(canTransitionRunStatus("policy_override", "policy_soft_failed")).toBe(true);
  });

  it("seeded random walks: 2000 walks never take an illegal step and terminate", (): void => {
    const rand = mulberry32(0x22_08_22_08);
    for (let w = 0; w < 2000; w += 1) {
      let current = "pending";
      let steps = 0;
      while (steps < 40) {
        const targets = nextRunStatuses(current);
        if (targets.length === 0) break; // terminal
        const next = targets[Math.floor(rand() * targets.length)] as string;
        expect(canTransitionRunStatus(current, next), `walk ${w} step ${steps}: ${current} -> ${next}`)
          .toBe(true);
        current = next;
        steps += 1;
      }
      expect((RUN_STATUSES as readonly string[]).includes(current)).toBe(true);
    }
  });

  it("determinism: same seed produces the identical walk", (): void => {
    const walk = (seed: number): string[] => {
      const r = mulberry32(seed);
      const seq: string[] = ["pending"];
      let current = "pending";
      for (let i = 0; i < 20; i += 1) {
        const targets = nextRunStatuses(current);
        if (targets.length === 0) break;
        current = targets[Math.floor(r() * targets.length)] as string;
        seq.push(current);
      }
      return seq;
    };
    expect(walk(0xabc123)).toEqual(walk(0xabc123));
    expect(walk(0xdef456).join(">")).not.toBe(walk(0xabc123).join(">"));
  });

  it("guard semantics: unknown statuses are illegal and same-status writes are skipped", (): void => {
    // Unknown statuses fail closed (no table row).
    expect(canTransitionRunStatus("mystery", "pending")).toBe(false);
    expect(canTransitionRunStatus("pending", "mystery")).toBe(false);
    // The worker guard only warns on from !== to; same-status writes are
    // idempotent re-assertions, not transitions.
    expect(canTransitionRunStatus("pending", "pending")).toBe(false);
    for (const s of RUN_STATUSES) {
      expect(canTransitionRunStatus(s, s)).toBe(false);
    }
  });
});
