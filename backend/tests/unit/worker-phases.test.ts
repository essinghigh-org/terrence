import { describe, expect, it } from "bun:test";
import { checkpointPhase, isDurablePhase, phaseOrder } from "../../src/worker/phases";

describe("worker phases (13/14)", () => {
  it("every named phase is durable", () => {
    for (const p of ["queued","planning","planned","applying","applied","errored"] as const) {
      expect(isDurablePhase(p)).toBe(true);
    }
  });

  it("phase order is monotonic", () => {
    expect(phaseOrder("queued")).toBeLessThan(phaseOrder("planning"));
    expect(phaseOrder("planning")).toBeLessThan(phaseOrder("applying"));
  });

  it("checkpointPhase is identity (durable marker)", () => {
    expect(checkpointPhase("planning")).toBe("planning");
  });
});
