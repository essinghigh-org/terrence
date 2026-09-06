/**
 * Shared user-journey fixture sizes and performance budgets.
 *
 * The resource limits are deliberately deterministic: a list that starts
 * fetching every workspace or rendering every plan node must fail regardless
 * of the runner it happens to use. Latency and memory values are reported by
 * the real-browser benchmark and can be enforced for scheduled runs with
 * `enforceTimingBudgets: true`; they are not used as a noisy pull-request
 * gate.
 */

export const WORKSPACE_PAGE_SIZE = 50;

export const PERFORMANCE_FIXTURES = {
  small: {
    workspaces: 25,
    runs: 50,
    stateVersions: 25,
    planNodes: 100,
    logLines: 500,
  },
  medium: {
    workspaces: 250,
    runs: 500,
    stateVersions: 250,
    planNodes: 1_000,
    logLines: 5_000,
  },
  large: {
    workspaces: 10_000,
    runs: 20_000,
    stateVersions: 1_000,
    planNodes: 10_000,
    logLines: 20_000,
  },
} as const;

export type PerformanceFixture = keyof typeof PERFORMANCE_FIXTURES;

export const PERFORMANCE_JOURNEYS = [
  "workspace-list",
  "plan-interaction",
  "log-retrieval",
  "state-listing",
  "queue-start",
] as const;

export type PerformanceJourney = (typeof PERFORMANCE_JOURNEYS)[number];

export type PerformanceBudget = Readonly<{
  /** Deterministic budget: number of API requests for the measured action. */
  maxRequests: number | null;
  /** Deterministic budget: serialized response bytes for the measured action. */
  maxPayloadBytes: number;
  /** Deterministic budget: SQL statements for the measured action. */
  maxQueries: number;
  /** Deterministic budget: rows/nodes mounted for the measured action. */
  maxRenderedItems: number | null;
  /** Advisory timing budget, enforced only by scheduled measurements. */
  maxServerP95Ms: number;
  /** Advisory end-to-end request budget, including loopback/network time. */
  maxNetworkP95Ms: number;
  /** Advisory browser render budget after the API response is available. */
  maxRenderP95Ms: number;
  /** Advisory timing budget, enforced only by scheduled measurements. */
  maxEventLoopP95Ms: number;
  /** Advisory browser heap budget, enforced only by scheduled measurements. */
  maxBrowserMemoryBytes: number;
  /** Advisory interaction budget, enforced only by scheduled measurements. */
  maxInteractionMs: number;
}>;

const MIB = 1024 * 1024;

export const PERFORMANCE_BUDGETS: Readonly<Record<PerformanceJourney, PerformanceBudget>> = {
  "workspace-list": {
    maxRequests: 1,
    maxPayloadBytes: 1_000_000,
    maxQueries: 250,
    maxRenderedItems: WORKSPACE_PAGE_SIZE,
    maxServerP95Ms: 5_000,
    maxNetworkP95Ms: 6_000,
    maxRenderP95Ms: 5_000,
    maxEventLoopP95Ms: 1_000,
    maxBrowserMemoryBytes: 256 * MIB,
    maxInteractionMs: 10_000,
  },
  "plan-interaction": {
    maxRequests: 3,
    maxPayloadBytes: 8_000_000,
    maxQueries: 250,
    maxRenderedItems: 2_000,
    maxServerP95Ms: 10_000,
    maxNetworkP95Ms: 12_000,
    maxRenderP95Ms: 10_000,
    maxEventLoopP95Ms: 1_000,
    maxBrowserMemoryBytes: 256 * MIB,
    maxInteractionMs: 10_000,
  },
  "log-retrieval": {
    maxRequests: 3,
    maxPayloadBytes: 4_000_000,
    maxQueries: 250,
    maxRenderedItems: 10_000,
    maxServerP95Ms: 10_000,
    maxNetworkP95Ms: 12_000,
    maxRenderP95Ms: 10_000,
    maxEventLoopP95Ms: 1_000,
    maxBrowserMemoryBytes: 256 * MIB,
    maxInteractionMs: 10_000,
  },
  "state-listing": {
    maxRequests: 3,
    maxPayloadBytes: 4_000_000,
    maxQueries: 250,
    maxRenderedItems: 1_000,
    maxServerP95Ms: 5_000,
    maxNetworkP95Ms: 6_000,
    maxRenderP95Ms: 5_000,
    maxEventLoopP95Ms: 1_000,
    maxBrowserMemoryBytes: 256 * MIB,
    maxInteractionMs: 10_000,
  },
  "queue-start": {
    maxRequests: 3,
    maxPayloadBytes: 1_000_000,
    maxQueries: 250,
    maxRenderedItems: null,
    maxServerP95Ms: 5_000,
    maxNetworkP95Ms: 6_000,
    maxRenderP95Ms: 5_000,
    maxEventLoopP95Ms: 1_000,
    maxBrowserMemoryBytes: 256 * MIB,
    maxInteractionMs: 10_000,
  },
};

export type PerformanceMeasurement = Readonly<{
  journey: PerformanceJourney;
  fixture: PerformanceFixture;
  requests: number;
  payloadBytes: number;
  queryCount: number;
  renderedItems?: number | null;
  serverP95Ms?: number | null;
  networkP95Ms?: number | null;
  renderP95Ms?: number | null;
  eventLoopP95Ms?: number | null;
  browserMemoryBytes?: number | null;
  interactionMs?: number | null;
}>;

export type BudgetCheckOptions = Readonly<{
  /** Enable runner-sensitive latency and memory checks for scheduled runs. */
  enforceTimingBudgets?: boolean;
}>;

function finiteNonNegative(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0;
}

/** Return every violated budget so CI can print one actionable report. */
export function budgetViolations(
  measurement: PerformanceMeasurement,
  options: BudgetCheckOptions = {},
): string[] {
  const budget = PERFORMANCE_BUDGETS[measurement.journey];
  const violations: string[] = [];
  if (measurement.requests < 0 || !Number.isSafeInteger(measurement.requests)) {
    violations.push(`requests=${measurement.requests} is invalid`);
  } else if (budget.maxRequests !== null && measurement.requests > budget.maxRequests) {
    violations.push(`requests ${measurement.requests} > ${budget.maxRequests}`);
  }
  if (measurement.payloadBytes < 0 || !Number.isSafeInteger(measurement.payloadBytes)) {
    violations.push(`payloadBytes=${measurement.payloadBytes} is invalid`);
  } else if (measurement.payloadBytes > budget.maxPayloadBytes) {
    violations.push(`payloadBytes ${measurement.payloadBytes} > ${budget.maxPayloadBytes}`);
  }
  if (measurement.queryCount < 0 || !Number.isSafeInteger(measurement.queryCount)) {
    violations.push(`queryCount=${measurement.queryCount} is invalid`);
  } else if (measurement.queryCount > budget.maxQueries) {
    violations.push(`queryCount ${measurement.queryCount} > ${budget.maxQueries}`);
  }
  if (budget.maxRenderedItems !== null && finiteNonNegative(measurement.renderedItems)
    && measurement.renderedItems > budget.maxRenderedItems) {
    violations.push(`renderedItems ${measurement.renderedItems} > ${budget.maxRenderedItems}`);
  }
  if (options.enforceTimingBudgets !== true) return violations;
  if (finiteNonNegative(measurement.serverP95Ms) && measurement.serverP95Ms > budget.maxServerP95Ms) {
    violations.push(`serverP95Ms ${measurement.serverP95Ms} > ${budget.maxServerP95Ms}`);
  }
  if (finiteNonNegative(measurement.networkP95Ms) && measurement.networkP95Ms > budget.maxNetworkP95Ms) {
    violations.push(`networkP95Ms ${measurement.networkP95Ms} > ${budget.maxNetworkP95Ms}`);
  }
  if (finiteNonNegative(measurement.renderP95Ms) && measurement.renderP95Ms > budget.maxRenderP95Ms) {
    violations.push(`renderP95Ms ${measurement.renderP95Ms} > ${budget.maxRenderP95Ms}`);
  }
  if (finiteNonNegative(measurement.eventLoopP95Ms) && measurement.eventLoopP95Ms > budget.maxEventLoopP95Ms) {
    violations.push(`eventLoopP95Ms ${measurement.eventLoopP95Ms} > ${budget.maxEventLoopP95Ms}`);
  }
  if (finiteNonNegative(measurement.browserMemoryBytes) && measurement.browserMemoryBytes > budget.maxBrowserMemoryBytes) {
    violations.push(`browserMemoryBytes ${measurement.browserMemoryBytes} > ${budget.maxBrowserMemoryBytes}`);
  }
  if (finiteNonNegative(measurement.interactionMs) && measurement.interactionMs > budget.maxInteractionMs) {
    violations.push(`interactionMs ${measurement.interactionMs} > ${budget.maxInteractionMs}`);
  }
  return violations;
}

export function assertPerformanceBudget(
  measurement: PerformanceMeasurement,
  options: BudgetCheckOptions = {},
): void {
  const violations = budgetViolations(measurement, options);
  if (violations.length > 0) {
    throw new Error(
      `${measurement.journey}/${measurement.fixture} exceeded its performance budget: ${violations.join(", ")}. `
      + "If intentional, update the budget and explain the measurement.",
    );
  }
}

export function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b): number => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}
