import { describe, expect, it } from "bun:test";
import { runExecutionDurationMilliseconds } from "../../src/lib/run-duration";

describe("run execution duration", () => {
  it("sums plan and apply execution while excluding the approval gap", () => {
    expect(runExecutionDurationMilliseconds({
      "planning-at": "2026-08-24T20:40:00.000Z",
      "planned-at": "2026-08-24T20:46:26.000Z",
      "input-state-serial": "1346",
      "confirmed-at": "2026-08-24T20:54:00.000Z",
      "applying-at": "2026-08-24T20:54:30.000Z",
      "applied-at": "2026-08-24T20:55:32.000Z",
    })).toBe(6 * 60_000 + 26_000 + 62_000);
  });

  it("does not parse input state serial metadata as a date", () => {
    expect(runExecutionDurationMilliseconds({
      "planning-at": "2026-08-24T20:46:00.000Z",
      "planned-at": "2026-08-24T20:46:26.000Z",
      "input-state-serial": "1346",
      "applied-at": "2026-08-24T20:55:32.000Z",
    })).toBe(9 * 60_000 + 32_000);
  });

  it("retains a useful duration for legacy rows without phase markers", () => {
    expect(runExecutionDurationMilliseconds({
      "planned-at": "2026-08-24T20:46:26.000Z",
      "applied-at": "2026-08-24T20:55:32.000Z",
    })).toBe(9 * 60_000 + 6_000);
  });

  it("uses the applied marker for legacy rows that still have a planning marker", () => {
    expect(runExecutionDurationMilliseconds({
      "planning-at": "2026-08-24T20:40:00.000Z",
      "planned-at": "2026-08-24T20:46:26.000Z",
      "applied-at": "2026-08-24T20:55:32.000Z",
    })).toBe(15 * 60_000 + 32_000);
  });
});
