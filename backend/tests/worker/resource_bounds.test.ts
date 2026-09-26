import { describe, test, expect, beforeEach } from "bun:test";
import {
  warnedRunLogFailuresSizeForTests,
  clearWarnedRunLogFailuresForTests,
  addWarnedRunLogFailureForTests,
  scheduledBlockReasonsForTests,
  clearScheduledBlockReasonsForTests,
  pruneScheduledBlockReasonsForTests,
} from "../../src/worker";

describe("resource bounds #351", (): void => {
  beforeEach((): void => {
    clearWarnedRunLogFailuresForTests();
    clearScheduledBlockReasonsForTests();
  });

  test("warnedRunLogFailures is bounded to 1000 entries", (): void => {
    expect(warnedRunLogFailuresSizeForTests()).toBe(0);
    // Fill beyond the bound
    for (let i = 0; i < 1500; i++) {
      addWarnedRunLogFailureForTests(`run-${i}:plan`);
    }
    const size = warnedRunLogFailuresSizeForTests();
    // After 1500 inserts with MAX=1000, prune evicts to ~500, then grows to ~1000
    // So size should be <=1000 and >500
    expect(size).toBeGreaterThan(500);
    expect(size).toBeLessThanOrEqual(1000);
    // Adding more should keep it bounded
    for (let i = 1500; i < 2500; i++) {
      addWarnedRunLogFailureForTests(`run-${i}:apply`);
    }
    expect(warnedRunLogFailuresSizeForTests()).toBeLessThanOrEqual(1000);
    expect(warnedRunLogFailuresSizeForTests()).toBeGreaterThan(500);
  });

  test("scheduledBlockReasons prunes workspace-lock entries when run leaves due set", (): void => {
    const map = scheduledBlockReasonsForTests() as Map<string, string>;
    map.set("workspace-lock:run-1", "workspace-locked");
    map.set("scheduled:run-2", "maintenance");
    map.set("agent-pool:run-3", "pool-unreachable");
    map.set("other:run-4", "ignored");
    expect(map.size).toBe(4);
    // Prune with only run-2 still due -> workspace-lock and agent-pool should be removed, other ignored
    pruneScheduledBlockReasonsForTests(new Set(["run-2"]));
    expect(map.has("workspace-lock:run-1")).toBe(false);
    expect(map.has("scheduled:run-2")).toBe(true);
    expect(map.has("agent-pool:run-3")).toBe(false);
    expect(map.has("other:run-4")).toBe(true); // non-prefixed keys are ignored by prune
    expect(map.size).toBe(2);
  });
});
