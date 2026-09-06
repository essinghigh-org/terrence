import { describe, expect, test } from "bun:test";
import {
  PERFORMANCE_BUDGETS,
  PERFORMANCE_FIXTURES,
  PERFORMANCE_JOURNEYS,
  assertPerformanceBudget,
  budgetViolations,
  type PerformanceMeasurement,
} from "../../../scripts/performance-budgets";

function measurement(overrides: Partial<PerformanceMeasurement> = {}): PerformanceMeasurement {
  return {
    journey: "workspace-list",
    fixture: "small",
    requests: 1,
    payloadBytes: 100,
    queryCount: 10,
    renderedItems: 25,
    ...overrides,
  };
}

describe("performance fixtures", () => {
  test("defines every user journey and three ordered fixture sizes", () => {
    expect(Object.keys(PERFORMANCE_BUDGETS).sort()).toEqual([...PERFORMANCE_JOURNEYS].sort());
    expect(PERFORMANCE_FIXTURES.small.workspaces).toBeLessThan(PERFORMANCE_FIXTURES.medium.workspaces);
    expect(PERFORMANCE_FIXTURES.medium.workspaces).toBeLessThan(PERFORMANCE_FIXTURES.large.workspaces);
    expect(PERFORMANCE_FIXTURES.small.planNodes).toBeLessThan(PERFORMANCE_FIXTURES.medium.planNodes);
    expect(PERFORMANCE_FIXTURES.medium.planNodes).toBeLessThan(PERFORMANCE_FIXTURES.large.planNodes);
  });

  test("enforces deterministic request, payload, query and render limits", () => {
    expect(budgetViolations(measurement({ requests: 2 }))).toContain("requests 2 > 1");
    expect(budgetViolations(measurement({ payloadBytes: 1_000_001 }))).toContain("payloadBytes 1000001 > 1000000");
    expect(budgetViolations(measurement({ queryCount: 251 }))).toContain("queryCount 251 > 250");
    expect(budgetViolations(measurement({ renderedItems: 51 }))).toContain("renderedItems 51 > 50");
    expect((): void => { assertPerformanceBudget(measurement({ requests: 2 })); }).toThrow(/workspace-list\/small/);
  });

  test("keeps timing checks opt-in for noisy runners", () => {
    const slow = measurement({ serverP95Ms: 5_001, networkP95Ms: 6_001, renderP95Ms: 5_001 });
    expect(budgetViolations(slow)).toEqual([]);
    expect(budgetViolations(slow, { enforceTimingBudgets: true })).toEqual([
      "serverP95Ms 5001 > 5000",
      "networkP95Ms 6001 > 6000",
      "renderP95Ms 5001 > 5000",
    ]);
  });
});
