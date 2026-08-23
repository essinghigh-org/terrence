import { describe, expect, it } from "bun:test";
import { checkpointPhase, isDurablePhase, isTerminalPhase, phaseOrder } from "../../src/worker/phases";

describe("worker phases (13/14)", () => {
  it("durable phases hold persisted state", () => {
    expect(isDurablePhase("planning")).toBe(true);
    expect(isDurablePhase("planned")).toBe(true);
    expect(isDurablePhase("applying")).toBe(true);
    expect(isDurablePhase("errored")).toBe(true);
    expect(isDurablePhase("queued")).toBe(false);
  });

  it("phase order is monotonic", () => {
    expect(phaseOrder("queued")).toBeLessThan(phaseOrder("planning"));
    expect(phaseOrder("planning")).toBeLessThan(phaseOrder("applying"));
  });

  it("checkpointPhase validates and is identity", () => {
    expect(checkpointPhase("planning")).toBe("planning");
    expect(checkpointPhase("errored")).toBe("errored");
    expect(() => checkpointPhase("nonexistent" as never)).toThrow("Unknown execution phase");
  });

  it("terminal phases are correctly identified", () => {
    expect(isTerminalPhase("applied")).toBe(true);
    expect(isTerminalPhase("queued")).toBe(false);
  });
});
