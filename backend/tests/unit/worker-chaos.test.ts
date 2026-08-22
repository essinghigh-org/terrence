import { describe, expect, it } from "bun:test";
import { canRecoverAfterCrash, crashSafe, postCrashTransitionAllowed } from "../../src/worker/chaos";

describe("worker chaos contract (14)", () => {
  it("every durable phase is crash-safe", () => {
    expect(crashSafe("planning")).toBe(true);
    expect(crashSafe("applying")).toBe(true);
  });

  it("non-terminal runs are recoverable; terminal are not", () => {
    expect(canRecoverAfterCrash("planning")).toBe(true);
    expect(canRecoverAfterCrash("applying")).toBe(true);
    expect(canRecoverAfterCrash("applied")).toBe(false);
    expect(canRecoverAfterCrash("errored")).toBe(false);
    expect(canRecoverAfterCrash("canceled")).toBe(true); // canceled is non-terminal (re-queueable)
  });

  it("post-crash transition still obeys the state machine", () => {
    expect(postCrashTransitionAllowed("planning", "errored")).toBe(true);
    expect(postCrashTransitionAllowed("applied", "planning")).toBe(false);
  });
});
