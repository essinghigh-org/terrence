import { describe, expect, test } from "bun:test";
import { conservativeLeaseRemainingMs } from "../../src/lib/lease-deadline";

describe("conservativeLeaseRemainingMs", () => {
  test("subtracts database response latency from local lease authority", () => {
    expect(conservativeLeaseRemainingMs(31_000, 1_000, 100, 350)).toBe(29_750);
  });

  test("never resurrects a lease whose response arrives after its conservative deadline", () => {
    expect(conservativeLeaseRemainingMs(1_100, 1_000, 100, 250)).toBe(0);
  });

  test("ignores a backwards monotonic observation instead of extending authority", () => {
    expect(conservativeLeaseRemainingMs(2_000, 1_000, 200, 150)).toBe(1_000);
  });
});
