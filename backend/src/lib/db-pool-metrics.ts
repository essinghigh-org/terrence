/**
 * Lightweight DB pool observation (todos 289, 290, 291).
 *
 * postgres.js does not expose pool internals (pending queue depth, idle
 * count) in its public API. We instrument at the application boundary:
 * wrapping the query path to track in-flight queries, total queries, p50/p95
 * sample, and transaction wall time. SQLite uses a single connection so pool
 * metrics are trivial (max 1, pending 0 when idle).
 *
 * Zero cost when not queried: the wrapper only increments counters and
 * records `performance.now()` deltas; the caller decides when to snapshot.
 * The snapshot shape is stable so /metrics and /readyz can consume it
 * without coupling to the driver.
 */

export type DbPoolSample = Readonly<{
  at: number;
  pending: number;
  durationMs: number;
  kind: "query" | "transaction";
}>;

const MAX_SAMPLES = 256;
const samples: DbPoolSample[] = [];

let pendingQueries = 0;
let pendingTransactions = 0;
let totalQueries = 0;
let totalTransactions = 0;
let queriesExhausted = 0;

export function poolPendingQueries(): number {
  return pendingQueries;
}

export function poolPendingTransactions(): number {
  return pendingTransactions;
}

/** Called on query start: increments pending and total. Returns start timestamp. */
export function poolQueryStart(): number {
  pendingQueries += 1;
  totalQueries += 1;
  if (pendingQueries > 1) queriesExhausted += 1;
  return performance.now();
}

/** Called on query end: decrements pending and records latency sample. */
export function poolQueryEnd(startMs: number): void {
  pendingQueries = Math.max(0, pendingQueries - 1);
  const durationMs = performance.now() - startMs;
  pushSample({ at: Date.now(), pending: pendingQueries, durationMs, kind: "query" });
}

export function poolTransactionStart(): number {
  pendingTransactions += 1;
  totalTransactions += 1;
  return performance.now();
}

export function poolTransactionEnd(startMs: number): void {
  pendingTransactions = Math.max(0, pendingTransactions - 1);
  const durationMs = performance.now() - startMs;
  pushSample({ at: Date.now(), pending: pendingTransactions, durationMs, kind: "transaction" });
}

function pushSample(sample: DbPoolSample): void {
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b): number => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))] ?? null;
}

export type DbPoolMetrics = Readonly<{
  driver: "sqlite" | "postgres";
  maxConnections: number;
  pendingQueries: number;
  pendingTransactions: number;
  totalQueries: number;
  totalTransactions: number;
  queriesExhausted: number;
  /** Latency over recent samples (ms); null when no samples yet. */
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  sampleCount: number;
}>;

export function poolMetrics(driver: "sqlite" | "postgres", maxConnections: number): DbPoolMetrics {
  const querySamples = samples.filter((s): boolean => s.kind === "query").map((s): number => s.durationMs);
  const txSamples = samples.filter((s): boolean => s.kind === "transaction").map((s): number => s.durationMs);
  const all = [...querySamples, ...txSamples];
  return {
    driver,
    maxConnections,
    pendingQueries,
    pendingTransactions,
    totalQueries,
    totalTransactions,
    queriesExhausted,
    p50Ms: percentile(all, 50),
    p95Ms: percentile(all, 95),
    maxMs: all.length > 0 ? Math.max(...all) : null,
    sampleCount: samples.length,
  };
}

/** Test seam: clear all samples and counters. */
export function _resetPoolMetrics(): void {
  pendingQueries = 0;
  pendingTransactions = 0;
  totalQueries = 0;
  totalTransactions = 0;
  queriesExhausted = 0;
  samples.length = 0;
}
