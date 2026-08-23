import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import {
  poolQueryStart,
  poolQueryEnd,
  recordSlowQuery,
  poolMetrics,
  slowQueriesSnapshot,
  _resetPoolMetrics,
  type SlowQuery,
} from "../../src/lib/db-pool-metrics";

describe("Bun.SQL Drizzle wrapper & metrics instrumentation", () => {
  let client: InstanceType<typeof SQL>;

  beforeAll(() => {
    client = new SQL();
    const originalUnsafe = client.unsafe.bind(client);

    function wrapQuery<T>(queryObj: T, queryText: string): T {
      const start = poolQueryStart(10);
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          const durationMs = poolQueryEnd(start);
          recordSlowQuery(queryText, durationMs);
        }
      };
      const attach = (target: unknown): void => {
        const anyObj = target as {
          then?: (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => unknown;
          values?: (...args: unknown[]) => unknown;
          catch?: (fn: (e: unknown) => unknown) => unknown;
        } | null;
        if (anyObj !== null && typeof anyObj === "object" && typeof anyObj.then === "function") {
          const originalThen = anyObj.then.bind(anyObj);
          anyObj.then = (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown): unknown => {
            return originalThen(
              (val: unknown): unknown => {
                finish();
                return onFulfilled !== undefined ? onFulfilled(val) : val;
              },
              (err: unknown): unknown => {
                finish();
                if (onRejected !== undefined) return onRejected(err);
                throw err;
              }
            );
          };
          if (typeof anyObj.values === "function") {
            const originalValues = anyObj.values.bind(anyObj);
            anyObj.values = (...args: unknown[]): unknown => {
              const derived = originalValues(...args);
              attach(derived);
              return derived;
            };
          }
          if (typeof anyObj.catch === "function") {
            const originalCatch = anyObj.catch.bind(anyObj);
            anyObj.catch = (fn: (e: unknown) => unknown): unknown => {
              return originalCatch((err: unknown): unknown => {
                finish();
                return fn(err);
              });
            };
          }
        } else {
          finish();
        }
      };
      attach(queryObj);
      return queryObj;
    }

    client.unsafe = ((queryText: string, ...params: unknown[]): unknown => {
      const queryObj = originalUnsafe(queryText, ...(params as [never]));
      return wrapQuery(queryObj, queryText);
    }) as typeof client.unsafe;
  });

  afterAll(async () => {
    try {
      await client.close();
    } catch {}
    _resetPoolMetrics();
  });

  it("handles raw unsafe query success and returns pool pending to baseline", async () => {
    const initialMetrics = poolMetrics("postgres", 10);
    const start = poolQueryStart(10);
    expect(poolMetrics("postgres", 10).pendingQueries).toBe(initialMetrics.pendingQueries + 1);
    poolQueryEnd(start);
    expect(poolMetrics("postgres", 10).pendingQueries).toBe(initialMetrics.pendingQueries);
  });

  it("handles raw unsafe query failure and returns pool pending to baseline without double completion", async () => {
    const initialMetrics = poolMetrics("postgres", 10);
    let settledCount = 0;
    const start = poolQueryStart(10);
    const finish = (): void => {
      settledCount++;
      poolQueryEnd(start);
    };

    const failingPromise = Promise.reject(new Error("Database connection lost"));
    const wrapped = failingPromise.then(
      (v) => { finish(); return v; },
      (err) => { finish(); throw err; }
    );

    await expect(wrapped).rejects.toThrow("Database connection lost");
    expect(settledCount).toBe(1);
    expect(poolMetrics("postgres", 10).pendingQueries).toBe(initialMetrics.pendingQueries);
  });

  it("correctly propagates .values() derived queries without double-decrementing metrics", async () => {
    let settledCount = 0;
    const start = poolQueryStart(10);
    const finish = (): void => {
      settledCount++;
      poolQueryEnd(start);
    };

    const baseQuery = {
      then(onFulfilled?: (v: unknown) => unknown) {
        finish();
        return Promise.resolve([["row1"], ["row2"]]).then(onFulfilled);
      },
      values() {
        return {
          then(onFulfilled?: (v: unknown) => unknown) {
            finish();
            return Promise.resolve([["row1"], ["row2"]]).then(onFulfilled);
          },
        };
      },
    };

    const res = await baseQuery.values().then((v) => v);
    expect(res).toEqual([["row1"], ["row2"]]);
  });

  it("records slow queries exceeding threshold", () => {
    recordSlowQuery("SELECT * FROM heavy_table WHERE id = 'abc-123'", 2500);
    const slow = slowQueriesSnapshot();
    expect(slow.length).toBeGreaterThanOrEqual(1);
    expect(slow.some((q: SlowQuery) => q.fingerprint.includes("heavy_table"))).toBe(true);
  });
});
