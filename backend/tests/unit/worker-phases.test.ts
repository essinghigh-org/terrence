import { describe, expect, it } from "bun:test";
import { checkpointPhase, isDurablePhase, isTerminalPhase, phaseOrder } from "../../src/worker/phases";

describe("worker phases (13/14)", () => {
  it("durable phases hold persisted state; confirmed is durable; queued is not", () => {
    expect(isDurablePhase("planning")).toBe(true);
    expect(isDurablePhase("confirmed")).toBe(true);
    expect(isDurablePhase("planned")).toBe(true);
    expect(isDurablePhase("applying")).toBe(true);
    expect(isDurablePhase("errored")).toBe(true);
    expect(isDurablePhase("queued")).toBe(false);
  });

  it("phase order is monotonic for linear phases; undefined for terminal", () => {
    expect(phaseOrder("queued")).toBeLessThan(phaseOrder("planning")!);
    expect(phaseOrder("planning")).toBeLessThan(phaseOrder("applying")!);
    expect(phaseOrder("errored")).toBeUndefined();
    expect(phaseOrder("canceled")).toBeUndefined();
  });

  it("checkpointPhase validates and is identity", () => {
    expect(checkpointPhase("planning")).toBe("planning");
    expect(checkpointPhase("canceled")).toBe("canceled");
    expect(checkpointPhase("errored")).toBe("errored");
    expect(() => checkpointPhase("nonexistent" as never)).toThrow("Unknown execution phase");
  });

  it("terminal phases are correctly identified; canceled is non-terminal", () => {
    expect(isTerminalPhase("applied")).toBe(true);
    expect(isTerminalPhase("errored")).toBe(true);
    expect(isTerminalPhase("queued")).toBe(false);
    expect(isTerminalPhase("canceled")).toBe(false);
  });
});
