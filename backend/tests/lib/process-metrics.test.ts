import { afterEach, describe, expect, test } from "bun:test";
import {
  processHistory,
  processSnapshot,
  requestFinished,
  requestStarted,
  sampleProcess,
  startProcessSampler,
  stopProcessSampler,
  workerPollerFinished,
  workerPollFinished,
  workerPollStarted,
  type ProcessSample,
} from "../../src/lib/process-metrics";

// Synthetic sample base: deterministic times/values so trend assertions do
// not depend on wall-clock timing.
const BASE: ProcessSample = {
  at: 1_000_000,
  rss: 100_000_000,
  heapTotal: 60_000_000,
  heapUsed: 50_000_000,
  external: 5_000_000,
  arrayBuffers: 1_000_000,
  requestsInFlight: 0,
  workerPolls: 0,
};

afterEach((): void => {
  stopProcessSampler();
});

describe("request counters", () => {
  test("tracks in-flight and 5xx totals as deltas", () => {
    const before = processSnapshot().requests;
    requestStarted();
    requestStarted();
    requestFinished(200);
    const mid = processSnapshot().requests;
    expect(mid.total - before.total).toBe(2);
    expect(mid.inFlight - before.inFlight).toBe(1);
    requestFinished(503);
    const after = processSnapshot().requests;
    expect(after.inFlight - before.inFlight).toBe(0);
    expect(after.errors5xx - before.errors5xx).toBe(1);
  });

  test("never lets in-flight drop below zero", () => {
    const before = processSnapshot().requests;
    for (let i = 0; i < before.inFlight + 5; i++) {
      requestFinished(404);
    }
    expect(processSnapshot().requests.inFlight).toBeGreaterThanOrEqual(0);
  });
});

describe("worker poll tracking", () => {
  test("records poller outcomes and cycle health", () => {
    workerPollStarted();
    workerPollerFinished("pollWorkerQueue", true, Date.now() - 12);
    workerPollerFinished("enqueueDueAssessments", false, Date.now() - 30);
    workerPollFinished(true, Date.now() - 50);
    const snapshot = processSnapshot();
    expect(snapshot.worker.polls).toBeGreaterThanOrEqual(1);
    expect(snapshot.worker.lastPollOk).toBe(true);
    expect(snapshot.worker.lastPollDurationMs).toBeGreaterThanOrEqual(0);
    const queuePoller = snapshot.worker.pollers["pollWorkerQueue"];
    expect(queuePoller?.runs).toBeGreaterThanOrEqual(1);
    expect(queuePoller?.lastOk).toBe(true);
    const assessmentPoller = snapshot.worker.pollers["enqueueDueAssessments"];
    expect(assessmentPoller?.errors).toBeGreaterThanOrEqual(1);
    expect(assessmentPoller?.lastOk).toBe(false);
    expect(snapshot.worker.lastPollAt).toBeGreaterThanOrEqual(0);
  });
});

describe("snapshot", () => {
  test("exposes rss, rusage-derived fields and uptime", () => {
    const snapshot = processSnapshot();
    expect(snapshot.rss).toBeGreaterThan(0);
    expect(snapshot.maxRss).toBeGreaterThan(0);
    expect(snapshot.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(snapshot.userCpuSeconds).toBeGreaterThanOrEqual(0);
    expect(snapshot.systemCpuSeconds).toBeGreaterThanOrEqual(0);
    expect(snapshot.at).toBeGreaterThan(0);
  });
});

describe("memory history", () => {
  test("ring buffer truncates to the configured max", () => {
    startProcessSampler(60_000, 2);
    sampleProcess({ ...BASE, at: 1 });
    sampleProcess({ ...BASE, at: 2 });
    sampleProcess({ ...BASE, at: 3 });
    const history = processHistory();
    expect(history.intervalMs).toBe(60_000); // custom interval is reported back
    expect(history.samples.length).toBe(2);
    expect(history.samples[0]?.at).toBe(2);
    expect(history.samples[1]?.at).toBe(3);
  });

  test("growth rate matches a known linear climb", () => {
    startProcessSampler(60_000, 8);
    // +1 MB per hour over a 2-hour window -> slope = 1_000_000 bytes/hour.
    sampleProcess({ ...BASE, at: 1_000_000, rss: 100_000_000 });
    sampleProcess({ ...BASE, at: 4_600_000, rss: 101_000_000 });
    sampleProcess({ ...BASE, at: 8_200_000, rss: 102_000_000 });
    const history = processHistory();
    expect(history.stats.rss.min).toBe(100_000_000);
    expect(history.stats.rss.max).toBe(102_000_000);
    expect(history.stats.rss.latest).toBe(102_000_000);
    expect(history.stats.rss.growthPerHour).toBeCloseTo(1_000_000, -1);
    // Identical heapUsed values across the window regress to a flat line:
    // growth is exactly 0 bytes/hour (not null — only < 2 samples is null).
    expect(history.stats.heapUsed.growthPerHour).toBe(0);
  });

  test("growth rate is null with fewer than two samples", () => {
    startProcessSampler(60_000, 8);
    sampleProcess({ ...BASE, at: 1_000_000 });
    const history = processHistory();
    expect(history.stats.rss.growthPerHour).toBeNull();
    expect(history.stats.rss.latest).toBe(100_000_000);
  });
});
