import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { wrapPgQuery } from "../../src/db";
import {
  recordSlowQuery,
  poolMetrics,
  slowQueriesSnapshot,
  _resetPoolMetrics,
  type SlowQuery,
} from "../../src/lib/db-pool-metrics";

function thenable<T>(promise: Promise<T>): Pick<Promise<T>, "then" | "catch"> {
  return {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
  };
}

describe("Bun.SQL Drizzle wrapper & metrics instrumentation", () => {
  beforeEach((): void => {
    _resetPoolMetrics();
  });

  afterEach((): void => {
    _resetPoolMetrics();
  });

  it("handles raw unsafe query success and returns pool pending to baseline", async () => {
    const initialMetrics = poolMetrics("postgres", 10);
    const query = wrapPgQuery(thenable(Promise.resolve([{ id: "row-1" }])), "SELECT id FROM rows");
    expect(poolMetrics("postgres", 10).pendingQueries).toBe(initialMetrics.pendingQueries + 1);
    expect(await query).toEqual([{ id: "row-1" }]);
    expect(poolMetrics("postgres", 10).pendingQueries).toBe(initialMetrics.pendingQueries);
    expect(poolMetrics("postgres", 10).totalQueries).toBe(initialMetrics.totalQueries + 1);
    expect(poolMetrics("postgres", 10).sampleCount).toBe(initialMetrics.sampleCount + 1);
  });

  it("handles raw unsafe query failure and returns pool pending to baseline without double completion", async () => {
    const initialMetrics = poolMetrics("postgres", 10);
    const wrapped = wrapPgQuery(thenable(Promise.reject(new Error("Database connection lost"))), "SELECT broken");

    let caught: unknown;
    try {
      await wrapped;
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Database connection lost");
    expect(poolMetrics("postgres", 10).pendingQueries).toBe(initialMetrics.pendingQueries);
    expect(poolMetrics("postgres", 10).totalQueries).toBe(initialMetrics.totalQueries + 1);
    expect(poolMetrics("postgres", 10).sampleCount).toBe(initialMetrics.sampleCount + 1);
  });

  it("tracks execute/raw/simple/values derived queries through one lifecycle", async () => {
    for (const method of ["execute", "raw", "simple", "values"] as const) {
      _resetPoolMetrics();
      const baseline = poolMetrics("postgres", 10);
      const rows = [["row1"], ["row2"]];
      const derived = thenable(Promise.resolve(rows));
      const base = Object.assign(thenable(Promise.resolve(rows)), {
        execute: (): PromiseLike<string[][]> => derived,
        raw: (): PromiseLike<string[][]> => derived,
        simple: (): PromiseLike<string[][]> => derived,
        values: (): PromiseLike<string[][]> => derived,
      });
      const query = wrapPgQuery(base, `SELECT via ${method}`);

      expect(await query[method]()).toEqual(rows);
      expect(poolMetrics("postgres", 10).pendingQueries).toBe(baseline.pendingQueries);
      expect(poolMetrics("postgres", 10).totalQueries).toBe(baseline.totalQueries + 1);
      expect(poolMetrics("postgres", 10).sampleCount).toBe(baseline.sampleCount + 1);
    }
  });

  it("records slow queries exceeding threshold", () => {
    recordSlowQuery("SELECT * FROM heavy_table WHERE id = 'abc-123'", 2500);
    const slow = slowQueriesSnapshot();
    expect(slow.length).toBeGreaterThanOrEqual(1);
    expect(slow.some((q: SlowQuery) => q.fingerprint.includes("heavy_table"))).toBe(true);
  });
});
