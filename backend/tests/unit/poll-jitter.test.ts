import { describe, expect, test } from "bun:test";
import { jitteredPollDelay, POLL_JITTER_FRACTION } from "../../src/lib/poll-jitter";

describe("poll delay jitter", () => {
  test("uses symmetric jitter around the base delay", (): void => {
    const baseMs = 1_000;
    expect(jitteredPollDelay(baseMs, (): number => 0)).toBe(800);
    expect(jitteredPollDelay(baseMs, (): number => 0.5)).toBe(1_000);
    expect(jitteredPollDelay(baseMs, (): number => 1)).toBe(1_200);
  });

  test("always returns a positive delay within the configured bounds", (): void => {
    const baseMs = 503;
    const minimum = Math.round(baseMs * (1 - POLL_JITTER_FRACTION));
    const maximum = Math.round(baseMs * (1 + POLL_JITTER_FRACTION));
    for (const sample of [0, 0.25, 0.5, 0.75, 1, -1, 2, Number.NaN]) {
      const delay = jitteredPollDelay(baseMs, (): number => sample);
      expect(delay).toBeGreaterThanOrEqual(Math.max(1, minimum));
      expect(delay).toBeLessThanOrEqual(maximum);
    }
    expect(jitteredPollDelay(0, (): number => 0.5)).toBe(1);
    expect(jitteredPollDelay(-10, (): number => 0.5)).toBe(1);
  });
});
