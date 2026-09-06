import { integerSetting } from "./runtime-config";
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
let sqliteWriteContention = 0;

export function recordSqliteWriteContention(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(message)) sqliteWriteContention += 1;
}

export type DbQueryBudgetKind = "export" | "index";

export class DbQueryBudgetRejectedError extends Error {
  public readonly kind: DbQueryBudgetKind;
  constructor(kind: DbQueryBudgetKind) {
    super(`Database ${kind} query budget is saturated`);
    this.name = "DbQueryBudgetRejectedError";
    this.kind = kind;
  }
}

export class DbQueryBudgetCancelledError extends Error {
  public readonly kind: DbQueryBudgetKind;
  constructor(kind: DbQueryBudgetKind) {
    super(`Database ${kind} query budget wait was cancelled`);
    this.name = "DbQueryBudgetCancelledError";
    this.kind = kind;
  }
}

type MutableBudgetWaiter = {
  kind: DbQueryBudgetKind;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
  onAbort?: (() => void) | undefined;
};

type BudgetState = {
  readonly kind: DbQueryBudgetKind;
  readonly concurrency: number;
  readonly queueLimit: number;
  active: number;
  queued: MutableBudgetWaiter[];
  admitted: number;
  rejected: number;
  cancelled: number;
  completed: number;
};

const budgetStates: Record<DbQueryBudgetKind, BudgetState> = {
  export: {
    kind: "export",
    concurrency: integerSetting("TERRENCE_DB_EXPORT_QUERY_CONCURRENCY"),
    queueLimit: integerSetting("TERRENCE_DB_EXPORT_QUERY_QUEUE"),
    active: 0,
    queued: [],
    admitted: 0,
    rejected: 0,
    cancelled: 0,
    completed: 0,
  },
  index: {
    kind: "index",
    concurrency: integerSetting("TERRENCE_DB_INDEX_QUERY_CONCURRENCY"),
    queueLimit: integerSetting("TERRENCE_DB_INDEX_QUERY_QUEUE"),
    active: 0,
    queued: [],
    admitted: 0,
    rejected: 0,
    cancelled: 0,
    completed: 0,
  },
};

export type DbQueryBudgetMetrics = Readonly<{
  kind: DbQueryBudgetKind;
  active: number;
  queued: number;
  concurrency: number;
  queueLimit: number;
  admitted: number;
  rejected: number;
  cancelled: number;
  completed: number;
}>;

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- waiter owns cancellation handles whose methods are intentionally invoked here.
function clearWaiter(waiter: MutableBudgetWaiter): void {
  if (waiter.timer !== undefined) clearTimeout(waiter.timer);
  if (waiter.signal !== undefined && waiter.onAbort !== undefined) waiter.signal.removeEventListener("abort", waiter.onAbort);
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- releasing a slot mutates the shared budget counters.
function releaseBudget(state: BudgetState): () => void {
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    state.active = Math.max(0, state.active - 1);
    state.completed += 1;
    const waiter = state.queued.shift();
    if (waiter === undefined) return;
    clearWaiter(waiter);
    state.active += 1;
    state.admitted += 1;
    waiter.resolve(releaseBudget(state));
  };
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal is a platform cancellation handle.
async function acquireDbQueryBudget(kind: DbQueryBudgetKind, signal?: AbortSignal, waitMs = integerSetting("TERRENCE_DB_QUERY_BUDGET_WAIT_MS")): Promise<() => void> {
  const state = budgetStates[kind];
  if (signal?.aborted === true) {
    state.cancelled += 1;
    return Promise.reject(new DbQueryBudgetCancelledError(kind));
  }
  if (state.active < state.concurrency) {
    state.active += 1;
    state.admitted += 1;
    return Promise.resolve(releaseBudget(state));
  }
  if (state.queued.length >= state.queueLimit) {
    state.rejected += 1;
    return Promise.reject(new DbQueryBudgetRejectedError(kind));
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: MutableBudgetWaiter = { kind, resolve, reject, signal };
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Error is only forwarded to the promise rejection.
    const cancel = (error: Error): void => {
      const index = state.queued.indexOf(waiter);
      if (index < 0) return;
      state.queued.splice(index, 1);
      clearWaiter(waiter);
      state.cancelled += 1;
      reject(error);
    };
    waiter.onAbort = (): void => { cancel(new DbQueryBudgetCancelledError(kind)); };
    if (signal !== undefined) signal.addEventListener("abort", waiter.onAbort, { once: true });
    if (waitMs > 0) waiter.timer = setTimeout((): void => { cancel(new DbQueryBudgetCancelledError(kind)); }, waitMs);
    state.queued.push(waiter);
  });
}

export type DbQueryBudgetOptions = Readonly<{ signal?: AbortSignal | undefined; waitMs?: number | undefined }>;

/** Run an index/export query under a bounded admission budget. The callback
 * starts only after a slot is admitted, so queued work cannot consume DB
 * connections while waiting. A request abort or wait deadline removes queued
 * work and records the cancellation for operators. */
export async function withDbQueryBudget<T>(
  kind: DbQueryBudgetKind,
  callback: () => T | Promise<T>,
  options: DbQueryBudgetOptions = {},
): Promise<T> {
  const release = await acquireDbQueryBudget(kind, options.signal, options.waitMs);
  try {
    return await callback();
  } finally {
    release();
  }
}

export function dbQueryBudgetMetrics(): Readonly<Record<DbQueryBudgetKind, DbQueryBudgetMetrics>> {
  return {
    export: { ...budgetStates.export, queued: budgetStates.export.queued.length },
    index: { ...budgetStates.index, queued: budgetStates.index.queued.length },
  };
}

export function isDbQueryBudgetError(error: unknown): error is DbQueryBudgetRejectedError | DbQueryBudgetCancelledError {
  return error instanceof DbQueryBudgetRejectedError || error instanceof DbQueryBudgetCancelledError;
}

/** Called on query start: increments pending and total. Returns start timestamp. */
export function poolQueryStart(maxConnections = 1): number {
  pendingQueries += 1;
  totalQueries += 1;
  if (pendingQueries > Math.max(1, maxConnections)) queriesExhausted += 1;
  return performance.now();
}

/** Called on query end: decrements pending and records latency sample. */
export function poolQueryEnd(startMs: number): number {
  pendingQueries = Math.max(0, pendingQueries - 1);
  const durationMs = performance.now() - startMs;
  pushSample({ at: Date.now(), pending: pendingQueries, durationMs, kind: "query" });
  return durationMs;
}

/** @lintignore - wired in follow-up transaction instrumentation */
export function poolTransactionStart(): number {
  pendingTransactions += 1;
  totalTransactions += 1;
  return performance.now();
}

/** @lintignore - wired in follow-up transaction instrumentation */
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
  sqliteWriteContention: number;
  queryBudgets: Readonly<Record<DbQueryBudgetKind, DbQueryBudgetMetrics>>;
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
    sqliteWriteContention,
    queryBudgets: dbQueryBudgetMetrics(),
  };
}

/** Test seam: clear all samples and counters. */
/** @lintignore */
export function _resetPoolMetrics(): void {
  pendingQueries = 0;
  pendingTransactions = 0;
  totalQueries = 0;
  totalTransactions = 0;
  queriesExhausted = 0;
  samples.length = 0;
  slowQueries.length = 0;
  sqliteWriteContention = 0;
  for (const state of Object.values(budgetStates)) {
    for (const waiter of state.queued) {
      clearWaiter(waiter);
      waiter.reject(new DbQueryBudgetCancelledError(state.kind));
    }
    state.queued.length = 0;
    state.active = 0;
    state.admitted = 0;
    state.rejected = 0;
    state.cancelled = 0;
    state.completed = 0;
  }
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
}>;

const SLOW_THRESHOLD_MS = integerSetting("TERRENCE_DB_SLOW_QUERY_MS");

const slowQueries: SlowQuery[] = [];
const MAX_SLOW = 64;

export function recordSlowQuery(sqlText: string, durationMs: number): void {
  if (durationMs < SLOW_THRESHOLD_MS) return;
  const fp = fingerprintQuery(sqlText);
  slowQueries.push({ at: Date.now(), durationMs, fingerprint: fp });
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
