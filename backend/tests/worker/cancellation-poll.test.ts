import { describe, expect, it } from "bun:test";
import {
  classifyCancellationPoll,
  MISSING_RUN_POLLS_BEFORE_CANCEL,
} from "../../src/worker";

// Issue #693: a deleted run record must stop its tracked process
// cooperatively (SIGINT, never SIGKILL) so the engine halts at a state
// boundary with recovery captured. A single missed poll is tolerated as a
// transient read anomaly; only a streak cancels.
describe("classifyCancellationPoll", () => {
  it("keeps running on ordinary statuses", () => {
    for (const status of ["pending", "planning", "applying", "planned", "confirmed"]) {
      expect(classifyCancellationPoll(status, 0)).toBe("none");
    }
  });

  it("cancels and force-cancels on explicit statuses regardless of streak", () => {
    expect(classifyCancellationPoll("canceled", 0)).toBe("cancel");
    expect(classifyCancellationPoll("force_canceled", 0)).toBe("force-cancel");
    expect(classifyCancellationPoll("canceled", 99)).toBe("cancel");
  });

  it("tolerates isolated misses and cancels only on a streak", () => {
    expect(classifyCancellationPoll(undefined, 0)).toBe("none");
    expect(classifyCancellationPoll(undefined, MISSING_RUN_POLLS_BEFORE_CANCEL - 1)).toBe("none");
    expect(classifyCancellationPoll(undefined, MISSING_RUN_POLLS_BEFORE_CANCEL)).toBe("cancel");
    expect(classifyCancellationPoll(undefined, MISSING_RUN_POLLS_BEFORE_CANCEL + 10)).toBe("cancel");
  });

  it("never hard-kills a deleted record", () => {
    for (let streak = 0; streak <= MISSING_RUN_POLLS_BEFORE_CANCEL + 10; streak += 1) {
      expect(classifyCancellationPoll(undefined, streak)).not.toBe("force-cancel");
    }
  });
});
