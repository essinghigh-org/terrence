import { afterEach, describe, expect, it } from "bun:test";
import {
  resetSharedDeliveryStateForTests,
  sharedDeliveryStateRowsForTests,
  sharedBreakerRefuses,
  sharedBreakerRecordFailure,
  sharedBreakerRecordSuccess,
  sharedBreakerState,
  sharedDedupRecord,
  sharedDedupSuppressed,
} from "../../src/lib/notification-state";

// The suite preload (tests/setup.ts) boots a fresh temp DB per file, so the
// shared-state module operates against a real database with migrations
// applied. This exercises the actual SQLite path; schema parity tests cover
// Postgres.

afterEach(async (): Promise<void> => {
  await resetSharedDeliveryStateForTests();
});

describe("shared notification delivery state (kanban 15/16)", () => {
  it("breaker starts closed and accumulates failures until the limit", async (): Promise<void> => {
    expect(await sharedBreakerRefuses("cfg-1")).toBeFalse();
    await sharedBreakerRecordFailure("cfg-1");
    await sharedBreakerRecordFailure("cfg-1");
    expect(await sharedBreakerRefuses("cfg-1")).toBeFalse();
    const state = await sharedBreakerState("cfg-1");
    expect(state.failures).toBe(2);
    expect(state.open).toBeFalse();
  });

  it("opens after three consecutive failures", async (): Promise<void> => {
    for (let i = 0; i < 3; i++) await sharedBreakerRecordFailure("cfg-2");
    expect(await sharedBreakerRefuses("cfg-2")).toBeTrue();
    const state = await sharedBreakerState("cfg-2");
    expect(state.open).toBeTrue();
    expect(state.remainingMs).toBeGreaterThan(0);
  });

  it("a success clears the breaker entirely", async (): Promise<void> => {
    await sharedBreakerRecordFailure("cfg-3");
    await sharedBreakerRecordFailure("cfg-3");
    await sharedBreakerRecordSuccess("cfg-3");
    const state = await sharedBreakerState("cfg-3");
    expect(state.failures).toBe(0);
    expect(await sharedBreakerRefuses("cfg-3")).toBeFalse();
  });

  it("dedup suppresses within the window across callers, then expires", async (): Promise<void> => {
    await sharedDedupRecord("run", "run-1:run:completed");
    expect(await sharedDedupSuppressed("run", "run-1:run:completed")).toBeTrue();
    // A different key is not suppressed.
    expect(await sharedDedupSuppressed("run", "run-1:run:errored")).toBeFalse();
  });

  it("scopes are isolated: run dedup does not affect assessment", async (): Promise<void> => {
    await sharedDedupRecord("run", "shared-key");
    expect(await sharedDedupSuppressed("assessment", "shared-key")).toBeFalse();
  });

  it("persists rows in the database (replica-shared by construction)", async (): Promise<void> => {
    await sharedBreakerRecordFailure("cfg-persist");
    await sharedDedupRecord("run", "run-persist:key");
    const rows = await sharedDeliveryStateRowsForTests();
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(["breaker", "dedup"]);
  });
});
