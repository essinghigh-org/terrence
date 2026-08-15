/**
 * process-metrics.ts — runtime observability for the /metrics endpoint.
 *
 * Bun 1.3 (oven/bun:1) does not expose Bun.memoryUsage(); process.memoryUsage()
 * rss is the load-bearing figure — heapTotal/heapUsed are informational only
 * in jsc and do not track the real allocation arena. Peak RSS comes from
 * process.resourceUsage() (KiB on Linux; converted to bytes here).
 *
 * A ring buffer of periodic samples gives trend data: the growth-rate stat
 * (linear regression over the window) turns a slow leak into a visible
 * bytes/hour number instead of a steady-state reading that looks identical
 * at 100 MB and 500 MB.
 */
export type ProcessSample = Readonly<{
  /** Epoch ms at sampling time. */
  at: number;
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  requestsInFlight: number;
  workerPolls: number;
}>;

export type PollerStats = Readonly<{
  runs: number;
  errors: number;
  lastDurationMs: number | null;
  lastOk: boolean | null;
}>;

export type ProcessSnapshot = ProcessSample & Readonly<{
  /** Peak RSS seen by the OS scheduler (rusage maxrss, KiB -> bytes). */
  maxRss: number;
  uptimeSeconds: number;
  userCpuSeconds: number;
  systemCpuSeconds: number;
  requests: Readonly<{ total: number; inFlight: number; errors5xx: number }>;
  failures: Readonly<Record<string, number>>;
  worker: Readonly<{
    polls: number;
    lastPollAt: number | null;
    lastPollDurationMs: number | null;
    lastPollOk: boolean | null;
    pollers: Readonly<Record<string, PollerStats>>;
  }>;
}>;

export type TrendStats = Readonly<{
  min: number;
  max: number;
  latest: number | null;
  /** Linear-regression slope over the window in bytes/hour; null with < 2 samples. */
  growthPerHour: number | null;
}>;

export type SampleWindow = Readonly<{
  intervalMs: number;
  maxSamples: number;
  samples: readonly ProcessSample[];
  stats: Readonly<{ rss: TrendStats; heapUsed: TrendStats }>;
}>;

const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;
const DEFAULT_MAX_SAMPLES = 720; // 2 hours at 10s

const counters = {
  requestsTotal: 0,
  requestsInFlight: 0,
  errors5xx: 0,
  workerPolls: 0,
  workerLastPollAt: null as number | null,
  workerLastPollDurationMs: null as number | null,
  workerLastPollOk: null as boolean | null,
  pollers: new Map<string, PollerStats>(),
};

/**
 * Best-effort subsystem failures that used to be invisible (kanban 12.7/12.8).
 * Each kind is a monotonically increasing counter so /metrics can show that
 * something is silently degrading even when the failure path has no surface.
 */
const failures = {
  auditWrites: 0,
  runLogWrites: 0,
};

export type FailureKind = keyof typeof failures;

/** Record one failed best-effort write; visible via processSnapshot().failures. */
export function recordFailure(kind: FailureKind): void {
  failures[kind] += 1;
}

let samples: ProcessSample[] = [];
let maxSamples = DEFAULT_MAX_SAMPLES;
let sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS;
let samplerTimer: ReturnType<typeof setInterval> | null = null;

export function requestStarted(): void {
  counters.requestsTotal += 1;
  counters.requestsInFlight += 1;
}

/** Record a finished request; only status >= 500 counts as an error. */
export function requestFinished(status: number): void {
  if (counters.requestsInFlight > 0) counters.requestsInFlight -= 1;
  if (status >= 500) counters.errors5xx += 1;
}

export function workerPollStarted(): void {
  counters.workerPolls += 1;
  counters.workerLastPollAt = Date.now();
}

export function workerPollerFinished(name: string, ok: boolean, startedAt: number): void {
  const previous = counters.pollers.get(name);
  const entry: PollerStats = {
    runs: (previous?.runs ?? 0) + 1,
    errors: (previous?.errors ?? 0) + (ok ? 0 : 1),
    lastDurationMs: Date.now() - startedAt,
    lastOk: ok,
  };
  counters.pollers.set(name, entry);
}

export function workerPollFinished(ok: boolean, startedAt: number): void {
  counters.workerLastPollDurationMs = Date.now() - startedAt;
  counters.workerLastPollOk = ok;
}

/** Fresh live reading of process state + counters. */
export function processSnapshot(): ProcessSnapshot {
  const mem = process.memoryUsage();
  const usage = process.resourceUsage();
  return {
    at: Date.now(),
    rss: mem.rss,
    heapTotal: mem.heapTotal,
    heapUsed: mem.heapUsed,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    requestsInFlight: counters.requestsInFlight,
    workerPolls: counters.workerPolls,
    maxRss: usage.maxRSS * 1024, // rusage reports KiB on Linux
    uptimeSeconds: Math.round(process.uptime()),
    userCpuSeconds: usage.userCPUTime / 1e6,
    systemCpuSeconds: usage.systemCPUTime / 1e6,
    requests: {
      total: counters.requestsTotal,
      inFlight: counters.requestsInFlight,
      errors5xx: counters.errors5xx,
    },
    failures: { ...failures },
    worker: {
      polls: counters.workerPolls,
      lastPollAt: counters.workerLastPollAt,
      lastPollDurationMs: counters.workerLastPollDurationMs,
      lastPollOk: counters.workerLastPollOk,
      pollers: Object.fromEntries(counters.pollers),
    },
  };
}

/**
 * Sample the process and append to the ring buffer. `override` is for tests:
 * production callers sample the live process and leave it undefined.
 */
export function sampleProcess(override?: Partial<ProcessSample>): ProcessSample {
  const sample: ProcessSample = { ...processSnapshot(), ...override };
  samples.push(sample);
  if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
  return sample;
}

/** Start the periodic sampler. Idempotent. Prod wiring: app.ts boot path. */
export function startProcessSampler(
  intervalMs: number = DEFAULT_SAMPLE_INTERVAL_MS,
  ringMax: number = DEFAULT_MAX_SAMPLES,
): void {
  if (samplerTimer !== null) return;
  maxSamples = ringMax;
  sampleIntervalMs = intervalMs;
  samples = [];
  samplerTimer = setInterval((): void => {
    sampleProcess();
  }, intervalMs);
}

export function stopProcessSampler(): void {
  if (samplerTimer !== null) {
    clearInterval(samplerTimer);
    samplerTimer = null;
  }
}

export function processHistory(): SampleWindow {
  return {
    intervalMs: sampleIntervalMs,
    maxSamples,
    samples,
    stats: {
      rss: trendStats(samples.map((sample): { at: number; value: number } => ({ at: sample.at, value: sample.rss }))),
      heapUsed: trendStats(samples.map((sample): { at: number; value: number } => ({ at: sample.at, value: sample.heapUsed }))),
    },
  };
}

function trendStats(points: readonly { at: number; value: number }[]): TrendStats {
  const values = points.map((point): number => point.value);
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;
  const latest = values.length > 0 ? (values[values.length - 1] ?? null) : null;
  let growthPerHour: number | null = null;
  if (points.length >= 2) {
    const n = points.length;
    const sumX = points.reduce((acc, point): number => acc + point.at, 0);
    const sumY = points.reduce((acc, point): number => acc + point.value, 0);
    const sumXY = points.reduce((acc, point): number => acc + point.at * point.value, 0);
    const sumX2 = points.reduce((acc, point): number => acc + point.at * point.at, 0);
    const denominator = n * sumX2 - sumX * sumX;
    if (denominator !== 0) {
      // Slope in bytes per ms; scale to bytes per hour for readability.
      const slopePerMs = (n * sumXY - sumX * sumY) / denominator;
      growthPerHour = Math.round(slopePerMs * 3_600_000);
    }
  }
  return { min, max, latest, growthPerHour };
}
