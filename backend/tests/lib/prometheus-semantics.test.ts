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

  test("a fingerprint first seen after the exporter cut is still collected", () => {
    // Collector half: a prefix-limited *exporter* would permanently hide every
    // fingerprint that first appears after its cut, so the cumulative map must
    // carry well past any plausible prefix. The exporter side is asserted
    // against a real /metrics scrape in tests/api/metrics.test.ts.
    resetPoolMetrics();
    for (let i = 0; i < 20; i += 1) recordSlowQuery(`SELECT * FROM early_${String(i)} WHERE a = ${i}`, 5_000);
    for (let i = 0; i < 60; i += 1) recordSlowQuery(`SELECT * FROM filler_${String(i)} WHERE b = ${i}`, 5_000);
    recordSlowQuery("SELECT * FROM late_arrival WHERE c = 1", 5_000);

    const totals = slowQueryFingerprintTotals();
    expect(Object.keys(totals).length).toBeGreaterThan(10);
    const late = Object.keys(totals).find((fingerprint): boolean => fingerprint.includes("late_arrival"));
    expect(late).toBeDefined();
    resetPoolMetrics();
  });
});
