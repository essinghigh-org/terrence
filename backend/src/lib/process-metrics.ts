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
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { discoveryStats } from "./discovery-queue";

/**
 * Fixed request-journey labels. Keep this list intentionally small: workspace
 * IDs, run IDs, and Terraform resource addresses must never become metric
 * labels, otherwise one busy tenant can create an unbounded time series set.
 */
export const PERFORMANCE_JOURNEY_LABELS = [
  "workspace-list",
  "plan-interaction",
  "log-retrieval",
  "state-listing",
  "queue-start",
  "other",
] as const;

export type PerformanceJourneyLabel = (typeof PERFORMANCE_JOURNEY_LABELS)[number];

export type JourneyLatency = Readonly<{
  requests: number;
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}>;

export type EventLoopDelayStats = Readonly<{
  sampleCount: number;
  minMs: number | null;
  meanMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}>;

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
  /** Request latency grouped by a fixed, low-cardinality journey label. */
  journeys: Readonly<Record<PerformanceJourneyLabel, JourneyLatency>>;
  /** Event-loop delay from the sampler's bounded histogram. */
  eventLoopDelay: EventLoopDelayStats;
  discovery: ReturnType<typeof discoveryStats>;
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
const EVENT_LOOP_RESOLUTION_MS = 20;
const MAX_JOURNEY_SAMPLES = 256;

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
  webhookDeliveries: 0,
};

const journeySamples: Record<PerformanceJourneyLabel, number[]> = {
  "workspace-list": [],
  "plan-interaction": [],
  "log-retrieval": [],
  "state-listing": [],
  "queue-start": [],
  other: [],
};
const journeyRequests: Record<PerformanceJourneyLabel, number> = {
  "workspace-list": 0,
  "plan-interaction": 0,
  "log-retrieval": 0,
  "state-listing": 0,
  "queue-start": 0,
  other: 0,
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
let eventLoopHistogram: IntervalHistogram | null = null;

function percentile(values: readonly number[], requested: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b): number => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((requested / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function journeyLabel(path: string): PerformanceJourneyLabel {
  const pathname = path.split("?", 1)[0] ?? path;
  if (/^\/api\/v2\/organizations\/[^/]+\/workspaces$/.test(pathname)) return "workspace-list";
  if (/^\/api\/v2\/(?:runs\/[^/]+\/(?:plan(?:\/json-output|\/sanitized-plan)?|plan\/json-output)|plans\/[^/]+(?:\/json-output|\/json-output-redacted|\/sanitized-plan)?)$/.test(pathname)) return "plan-interaction";
  if (/^\/api\/v2\/runs\/[^/]+\/(?:logs|plan\/log(?:\/[^/]+)?|apply\/log(?:\/[^/]+)?)$/.test(pathname)) return "log-retrieval";
  if (/^\/api\/v2\/workspaces\/[^/]+\/state-versions$/.test(pathname)) return "state-listing";
  if (/^\/api\/v2\/organizations\/[^/]+\/runs\/queue$/.test(pathname)
    || /^\/api\/v2\/runs\/[^/]+\/actions\/queue$/.test(pathname)) return "queue-start";
  return "other";
}

/** Record server-side request latency using only a fixed journey label. */
export function recordRequestLatency(path: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const label = journeyLabel(path);
  journeyRequests[label] += 1;
  const values = journeySamples[label];
  values.push(durationMs);
  if (values.length > MAX_JOURNEY_SAMPLES) values.splice(0, values.length - MAX_JOURNEY_SAMPLES);
}

function journeyLatencySnapshot(): Readonly<Record<PerformanceJourneyLabel, JourneyLatency>> {
  return Object.fromEntries(PERFORMANCE_JOURNEY_LABELS.map((label): [PerformanceJourneyLabel, JourneyLatency] => {
    const samplesForJourney = journeySamples[label];
    return [label, {
      requests: journeyRequests[label],
      sampleCount: samplesForJourney.length,
      p50Ms: percentile(samplesForJourney, 50),
      p95Ms: percentile(samplesForJourney, 95),
      maxMs: samplesForJourney.length === 0 ? null : Math.max(...samplesForJourney),
    }];
  })) as Record<PerformanceJourneyLabel, JourneyLatency>;
}

function eventLoopDelaySnapshot(): EventLoopDelayStats {
  const histogram = eventLoopHistogram;
  if (histogram === null || histogram.count === 0) {
    return { sampleCount: 0, minMs: null, meanMs: null, p95Ms: null, maxMs: null };
  }
  const toMs = (nanoseconds: number): number => Number((nanoseconds / 1_000_000).toFixed(3));
  return {
    sampleCount: histogram.count,
    minMs: toMs(histogram.min),
    meanMs: toMs(histogram.mean),
    p95Ms: toMs(histogram.percentile(95)),
    maxMs: toMs(histogram.max),
  };
}

/** Expose the current bounded event-loop histogram to benchmark runners. */
export function eventLoopDelayMetrics(): EventLoopDelayStats {
  return eventLoopDelaySnapshot();
}

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
    journeys: journeyLatencySnapshot(),
    eventLoopDelay: eventLoopDelaySnapshot(),
    discovery: discoveryStats(),
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
  eventLoopHistogram?.disable();
  eventLoopHistogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
  eventLoopHistogram.enable();
  samplerTimer = setInterval((): void => {
    sampleProcess();
  }, intervalMs);
}

export function stopProcessSampler(): void {
  if (samplerTimer !== null) {
    clearInterval(samplerTimer);
    samplerTimer = null;
  }
  eventLoopHistogram?.disable();
  eventLoopHistogram = null;
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

function trendStats(points: readonly (Readonly<{ at: number; value: number }>)[]): TrendStats {
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
