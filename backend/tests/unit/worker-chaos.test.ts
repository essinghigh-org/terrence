import { describe, expect, it } from "bun:test";
import { canRecoverAfterCrash, crashSafe, needsCrashRecovery, postCrashTransitionAllowed, shouldRetryAfterCrash } from "../../src/worker/chaos";
import { checkpointPhase, phaseOrder } from "../../src/worker/phases";

describe("worker chaos contract (14)", () => {
  it("durable phases are crash-safe; queued is not; confirmed is durable", () => {
    expect(crashSafe("planning")).toBe(true);
    expect(crashSafe("applying")).toBe(true);
    expect(crashSafe("confirmed")).toBe(true);
    expect(crashSafe("queued")).toBe(false);
  });

  it("non-terminal runs are recoverable; terminal are not; canceled is recoverable (re-queueable)", () => {
    expect(canRecoverAfterCrash("planning")).toBe(true);
    expect(canRecoverAfterCrash("applying")).toBe(true);
    expect(canRecoverAfterCrash("applied")).toBe(false);
    expect(canRecoverAfterCrash("errored")).toBe(false);
    expect(canRecoverAfterCrash("canceled")).toBe(true); // canceled is non-terminal and durable
  });

  it("post-crash transition still obeys the state machine", () => {
    expect(postCrashTransitionAllowed("planning", "errored")).toBe(true);
    expect(postCrashTransitionAllowed("applied", "planning")).toBe(false);
  });

  it("shouldRetryAfterCrash excludes terminal + force_canceled", () => {
    expect(shouldRetryAfterCrash("planning")).toBe(true);
    expect(shouldRetryAfterCrash("applied")).toBe(false);
    expect(shouldRetryAfterCrash("force_canceled")).toBe(false);
    expect(shouldRetryAfterCrash("discarded")).toBe(false);
  });

  it("needsCrashRecovery reflects terminal vs non-terminal phases; canceled needs recovery", () => {
    expect(needsCrashRecovery("planning")).toBe(true);
    expect(needsCrashRecovery("applied")).toBe(false);
    expect(needsCrashRecovery("canceled")).toBe(true);
  });

  it("phaseOrder returns undefined for terminal/off-order phases (not -1)", () => {
    expect(phaseOrder("errored")).toBeUndefined();
    expect(phaseOrder("canceled")).toBeUndefined();
  });

  it("checkpointPhase accepts canceled/discarded; rejects unknown", () => {
    expect(checkpointPhase("canceled")).toBe("canceled");
    expect(() => checkpointPhase("nonexistent" as never)).toThrow("Unknown execution phase");
  });
});