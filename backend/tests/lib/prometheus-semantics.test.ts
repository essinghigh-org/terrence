import { describe, expect, test } from "bun:test";
import { processSnapshot, recordRequestLatency, resetJourneyMetricsForTests } from "../../src/lib/process-metrics";
import {
  recordSlowQuery,
  resetPoolMetrics,
  slowQueriesSnapshot,
  slowQueryFingerprintTotals,
} from "../../src/lib/db-pool-metrics";

/**
 * Prometheus semantics are a production contract: rate() on a counter that
 * stops increasing (or decreases) silently misreports traffic. These tests pin
 * the cumulative/rolling distinction at the collector the exporter reads.
 */
describe("cumulative metric semantics", () => {
  test("journey request counts keep rising after the bounded sample window fills", () => {
    resetJourneyMetricsForTests();
    for (let i = 0; i < 300; i += 1) recordRequestLatency("/api/v2/organizations/acme/workspaces", 10);

    // Observations are cumulative; retained latency samples stay bounded.
    const journey = processSnapshot().journeys["workspace-list"];
    expect(journey.requests).toBe(300);
    expect(journey.sampleCount).toBe(256);
    resetJourneyMetricsForTests();
  });

  test("slow-query fingerprint totals survive buffer eviction", () => {
    resetPoolMetrics();
    for (let i = 0; i < 40; i += 1) recordSlowQuery(`SELECT * FROM t WHERE id = ${i}`, 5_000);
    for (let i = 0; i < 40; i += 1) recordSlowQuery(`SELECT * FROM u WHERE id = ${i}`, 5_000);

    // The rolling buffer holds only the most recent 64 samples...
    expect(slowQueriesSnapshot().length).toBe(64);
    // ...but cumulative fingerprint totals keep every observation, so an
    // evicted fingerprint can neither disappear nor decrease.
    const totals = slowQueryFingerprintTotals();
    const first = Object.entries(totals).find(([fingerprint]): boolean => fingerprint.includes("FROM t"));
    expect(first?.[1]).toBe(40);
    const second = Object.entries(totals).find(([fingerprint]): boolean => fingerprint.includes("FROM u"));
    expect(second?.[1]).toBe(40);
    resetPoolMetrics();
  });
});
