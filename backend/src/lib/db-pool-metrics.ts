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
export function poolQueryEnd(startMs: number): number {
  pendingQueries = Math.max(0, pendingQueries - 1);
  const durationMs = performance.now() - startMs;
  pushSample({ at: Date.now(), pending: pendingQueries, durationMs, kind: "query" });
  return durationMs;
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
  slowQueries.length = 0;
}

// ---------------------------------------------------------------------------
// Slow queries (todo 292) + fingerprints (todo 293)
// The metrics wrapper captures `queryText` alongside duration; this buffer
// keeps the N slowest recent statements without storing raw values in the
// exported snapshot beyond a normalized fingerprint (literals → ?).
// ---------------------------------------------------------------------------

function fingerprintQuery(sql: string): string {
  // Normalize literals so `WHERE id = 'abc'` and `WHERE id = 'xyz'` hash the
  // same bucket. Ordering matters: string literals first so their contents
  // (which may look like numbers) are not re-matched by the numeric passes.
  let fp = sql;
  // String literals (single-quoted, ''-escaped)
  fp = fp.replace(/'(?:''|[^'])*'/g, "?");
  // Dollar-quoted placeholder alternative Postgres sometimes emits
  fp = fp.replace(/\$\d+/g, "?");
  // Hex / UUID-looking tokens
  fp = fp.replace(/0x[0-9a-fA-F]+/g, "?");
  // Numeric literals (int / float / scientific) not already replaced
  fp = fp.replace(/\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, "?");
  // Collapse whitespace and IN-list repetitions: (?, ?, ?) → (?)
  fp = fp.replace(/\s+/g, " ").trim();
  fp = fp.replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?)");
  return fp;
}

export type SlowQuery = Readonly<{
  at: number;
  durationMs: number;
  fingerprint: string;
  rawPreview: string;
}>;

const SLOW_THRESHOLD_MS = (() => {
  const raw = process.env.TERRENCE_DB_SLOW_QUERY_MS;
  if (raw === undefined || raw.trim() === "") return 1000;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : 1000;
})();

let slowQueries: SlowQuery[] = [];
const MAX_SLOW = 64;

export function recordSlowQuery(sqlText: string, durationMs: number): void {
  if (durationMs < SLOW_THRESHOLD_MS) return;
  const fp = fingerprintQuery(sqlText);
  // Keep raw preview truncated so values cannot leak in full: first 120 chars
  // of the original statement (already threshold-gated) is enough to locate
  // the call site; fingerprints are the primary grouping key.
  const preview = sqlText.slice(0, 120);
  slowQueries.push({ at: Date.now(), durationMs, fingerprint: fp, rawPreview: preview });
  if (slowQueries.length > MAX_SLOW) slowQueries.splice(0, slowQueries.length - MAX_SLOW);
  // Also emit to stderr at debug so an operator tailing logs sees the hit
  // without scraping /metrics; bounded to one line.
  console.warn(`[terrence] slow query ${durationMs.toFixed(0)}ms fingerprint=${JSON.stringify(fp)}`);
}

export function slowQueryFingerprints(): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const sq of slowQueries) counts[sq.fingerprint] = (counts[sq.fingerprint] ?? 0) + 1;
  return counts;
}

export function slowQueriesSnapshot(): readonly SlowQuery[] {
  return [...slowQueries].sort((a, b): number => b.durationMs - a.durationMs);
}

export { fingerprintQuery };

/** @public keep fingerprint import honest for knip when not otherwise referenced */
export const _slowThresholdMs = SLOW_THRESHOLD_MS;

