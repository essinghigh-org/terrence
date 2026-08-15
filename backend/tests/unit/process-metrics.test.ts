import { describe, expect, it } from "bun:test";
import { recordFailure, processSnapshot } from "../../src/lib/process-metrics";

describe("process metrics failure counters", () => {
  it("exposes zeroed failure counters in the snapshot", () => {
    const before = processSnapshot().failures;
    expect(before.auditWrites ?? 0).toBeGreaterThanOrEqual(0);
    expect(before.runLogWrites ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("increments the recorded kind only", () => {
    const before = processSnapshot().failures;
    const auditBefore = before.auditWrites ?? 0;
    const runLogBefore = before.runLogWrites ?? 0;

    recordFailure("auditWrites");

    const after = processSnapshot().failures;
    expect(after.auditWrites).toBe(auditBefore + 1);
    expect(after.runLogWrites).toBe(runLogBefore);
  });

  it("counts every recorded failure, including repeats", () => {
    const before = processSnapshot().failures.runLogWrites ?? 0;
    recordFailure("runLogWrites");
    recordFailure("runLogWrites");
    expect(processSnapshot().failures.runLogWrites).toBe(before + 2);
  });
});
