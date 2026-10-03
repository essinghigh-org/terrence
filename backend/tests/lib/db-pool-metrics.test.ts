import { afterEach, expect, spyOn, test } from "bun:test";
import {
  recordSlowQuery,
  resetPoolMetrics,
  slowQueryFingerprints,
  slowThresholdMs,
} from "../../src/lib/db-pool-metrics";

afterEach((): void => {
  resetPoolMetrics();
});

test("slow-query fingerprint metrics describe the bounded diagnostic window, not a lifetime counter", () => {
  const warn = spyOn(console, "warn").mockImplementation((): void => undefined);
  try {
    for (let index = 0; index < 40; index += 1) {
      recordSlowQuery("select * from durable_jobs where kind = 'background'", slowThresholdMs + 1);
    }
    for (let index = 0; index < 40; index += 1) {
      recordSlowQuery("select * from durable_jobs where kind = 'critical' and attempts = 7", slowThresholdMs + 1);
    }
  } finally {
    warn.mockRestore();
  }

  const counts = Object.values(slowQueryFingerprints()).sort((left, right): number => left - right);
  expect(counts).toEqual([24, 40]);
  expect(counts.reduce((sum, count): number => sum + count, 0)).toBe(64);
});
