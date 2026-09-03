import type { Context as RateLimitContext } from "elysia-rate-limit";
import { sql } from "drizzle-orm";
import { isPostgres } from "../db/driver";

/**
 * Distributed fixed-window store for HA (todo 20). On Postgres, counts live
 * in a shared `rate_limit_buckets` table so every replica sees the same
 * window. On SQLite (single instance) callers never use this — they keep
 * the process-local Map (fixedWindowContext in app.ts).
 *
 * The table is created via generated migrations (drizzle/0029_numerous_lady_mastermind.sql
 * and drizzle/pg/0026_volatile_menace.sql).
 *
 * Window math: `floor(now / duration) * duration` is the window start; all
 * replicas that compute the same window share the bucket. Expiry is handled
 * by the read path (stale window = count 1), so no background sweeper.
 */
export function distributedFixedWindowContext(bucketPrefix: string): RateLimitContext {
  let duration = 60_000;
  let lastPrunedWindowStart: number | null = null;

  return {
    init(options): void {
      if (typeof options.duration === "number" && Number.isFinite(options.duration) && options.duration > 0) {
        duration = options.duration;
      }
    },
    async increment(key: string, requestDuration?: number, requestTime?: number): Promise<{ count: number; nextReset: Date; start: number }> {
      const effectiveDuration = requestDuration ?? duration;
      const now = requestTime ?? Date.now();
      const bucket = `${bucketPrefix}:${key}`;
      const windowStart = now - (now % effectiveDuration);
      const nextReset = new Date(windowStart + effectiveDuration);

      // SQLite has no cross-replica concern; this path is never called there,
      // but if it is, degrade to a single count rather than failing the request.
      if (!isPostgres) return { count: 1, nextReset, start: windowStart };

      try {
        // Single upsert: bump count within the current window, or start a new
        // window if the stored one is stale. Uses the same ON CONFLICT pattern
        // as `locks` / `durable_jobs`.
        const { db } = await import("../db");
        const rows = await (db as unknown as { execute: (q: unknown) => Promise<readonly { count: number }[]> }).execute(sql`
          INSERT INTO rate_limit_buckets (bucket, window_start, count)
          VALUES (${bucket}, ${windowStart}, 1)
          ON CONFLICT (bucket) DO UPDATE SET
            count = CASE WHEN rate_limit_buckets.window_start = ${windowStart}
              THEN rate_limit_buckets.count + 1 ELSE 1 END,
            window_start = CASE WHEN rate_limit_buckets.window_start = ${windowStart}
              THEN rate_limit_buckets.window_start ELSE ${windowStart} END
          RETURNING count
        `);
        const count = Number(rows[0]?.count ?? 1);
        return { count, nextReset, start: windowStart };
      } catch {
        // DB unavailable: fail open (allow the request) rather than hard-failing
        // the API. Rate limiting is a defense, not a gate.
        return { count: 1, nextReset, start: windowStart };
      } finally {
        // Opportunistic expiry, rate-limited to one prune per window per
        // bucketPrefix so every limited request does not pay for a table scan.
        if (lastPrunedWindowStart !== windowStart) {
          lastPrunedWindowStart = windowStart;
          const staleBefore = windowStart - effectiveDuration * 10;
          try {
            const { db: db2 } = await import("../db");
            await (db2 as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
              sql`DELETE FROM rate_limit_buckets WHERE window_start < ${staleBefore}`
            );
          } catch {}
        }
      }
    },
    async decrement(_key: string): Promise<void> {},
    async reset(key?: string): Promise<void> {
      if (!isPostgres) return;
      try {
        const { db } = await import("../db");
        const exec = (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute.bind(db);
        if (key === undefined) {
          await exec(sql`DELETE FROM rate_limit_buckets WHERE bucket LIKE ${bucketPrefix + ":%"}`);
        } else {
          await exec(sql`DELETE FROM rate_limit_buckets WHERE bucket = ${`${bucketPrefix}:${key}`}`);
        }
      } catch {}
    },
    async kill(): Promise<void> {
      if (!isPostgres) return;
      try {
        const { db } = await import("../db");
        await (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(sql`DELETE FROM rate_limit_buckets WHERE bucket LIKE ${bucketPrefix + ":%"}`);
      } catch {}
    },
  };
}
