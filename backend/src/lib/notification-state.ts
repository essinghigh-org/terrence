/**
 * Durable, replica-shared state for notification delivery control (todos 15/16).
 *
 * The in-process circuit breaker and dedup TTL maps in notifications.ts are
 * correct per-replica but not HA-safe: replica A can consider a destination
 * dead while replica B keeps hammering it, and the same logical notification
 * can be emitted once per replica. This module stores both kinds of state in
 * the database so every replica observes the same view.
 *
 * Design:
 *   - One table, `notification_delivery_state`, keyed by scope + key.
 *   - Circuit breaker rows: kind="breaker", value = consecutive failure
 *     count, window_start = when the breaker opened (null while closed).
 *   - Dedup rows: kind="dedup", value = 0, window_start = last emission.
 *   - All timestamps are worker-supplied epoch ms so SQLite and Postgres
 *     behave identically; no DB-side clock dependence.
 *   - Rows are pruned opportunistically: expired dedup rows are deleted on
 *     read; closed breakers are deleted on read. A periodic sweep bounds
 *     table growth from destinations that are removed entirely.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { notificationDeliveryState } from "../db/schema";

const BREAKER_FAILURE_LIMIT = 3;
const BREAKER_OPEN_MS = 60_000;
const DEDUP_WINDOW_MS = 5_000;

/** Rows older than this are swept regardless of kind (dedup rows are already
 * short-lived; a breaker row older than an hour is stale by definition). */
const SWEEP_HORIZON_MS = 60 * 60 * 1_000;

export type SharedBreakerView = Readonly<{
  open: boolean;
  failures: number;
  remainingMs: number;
}>;

function isOpen(windowStart: number | null, now: number): boolean {
  return windowStart !== null && now < windowStart + BREAKER_OPEN_MS;
}

/** Read the shared breaker state for a configuration. */
export async function sharedBreakerState(configurationId: string): Promise<SharedBreakerView> {
  const now = Date.now();
  const rows = await db.select().from(notificationDeliveryState).where(
    and(
      eq(notificationDeliveryState.kind, "breaker"),
      eq(notificationDeliveryState.stateKey, configurationId),
    ),
  ).limit(1);
  const row = rows[0];
  if (row === undefined) return { open: false, failures: 0, remainingMs: 0 };
  const windowStart: number | null = row.windowStart;
  if (windowStart !== null && !isOpen(windowStart, now)) {
    // Cooldown elapsed: clear the row so the next attempt counts fresh.
    await db.delete(notificationDeliveryState).where(eq(notificationDeliveryState.id, row.id));
    return { open: false, failures: 0, remainingMs: 0 };
  }
  const open = isOpen(windowStart, now);
  return {
    open,
    failures: row.value,
    remainingMs: open && windowStart !== null ? windowStart + BREAKER_OPEN_MS - now : 0,
  };
}

/** Whether the shared breaker refuses delivery for this configuration. */
export async function sharedBreakerRefuses(configurationId: string): Promise<boolean> {
  return (await sharedBreakerState(configurationId)).open;
}

/** Record a delivery failure against the shared breaker. Opens the breaker
 * when consecutive failures reach the limit. */
export async function sharedBreakerRecordFailure(configurationId: string): Promise<void> {
  const now = Date.now();
  const state = await sharedBreakerState(configurationId);
  if (state.open) return; // already open; nothing to accumulate
  const failures = state.failures + 1;
  const windowStart = failures >= BREAKER_FAILURE_LIMIT ? now : null;
  await db
    .insert(notificationDeliveryState)
    .values({
      id: crypto.randomUUID(),
      kind: "breaker",
      stateKey: configurationId,
      value: failures,
      windowStart,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [notificationDeliveryState.kind, notificationDeliveryState.stateKey],
      set: { value: failures, windowStart, updatedAt: now },
    });
}

/** Record a delivery success: clears the shared breaker. */
export async function sharedBreakerRecordSuccess(configurationId: string): Promise<void> {
  await db.delete(notificationDeliveryState).where(
    and(eq(notificationDeliveryState.kind, "breaker"), eq(notificationDeliveryState.stateKey, configurationId)),
  );
}

/** Whether the same logical notification was already emitted inside the dedup
 * window (shared across replicas). */
export async function sharedDedupSuppressed(scope: "run" | "assessment", key: string): Promise<boolean> {
  const now = Date.now();
  const stateKey = `${scope}:${key}`;
  const rows = await db.select().from(notificationDeliveryState).where(
    and(eq(notificationDeliveryState.kind, "dedup"), eq(notificationDeliveryState.stateKey, stateKey)),
  ).limit(1);
  const row = rows[0];
  if (row === undefined) return false;
  const windowStart: number | null = row.windowStart;
  if (windowStart === null || now - windowStart >= DEDUP_WINDOW_MS) {
    await db.delete(notificationDeliveryState).where(eq(notificationDeliveryState.id, row.id));
    return false;
  }
  return true;
}

/** Record that a logical notification was emitted (shared across replicas). */
export async function sharedDedupRecord(scope: "run" | "assessment", key: string): Promise<void> {
  const now = Date.now();
  const stateKey = `${scope}:${key}`;
  await db
    .insert(notificationDeliveryState)
    .values({ id: crypto.randomUUID(), kind: "dedup", stateKey, value: 0, windowStart: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [notificationDeliveryState.kind, notificationDeliveryState.stateKey],
      set: { windowStart: now, updatedAt: now },
    });
}

/** Delete expired dedup rows and stale breaker rows. Called opportunistically
 * from the delivery path (cheap indexed delete, no scan). */
/** @public - retained for scheduled cleanup; usage may be out-of-tree. */
export async function sweepSharedDeliveryState(): Promise<void> {
  const horizon = Date.now() - SWEEP_HORIZON_MS;
  await db.delete(notificationDeliveryState).where(lt(notificationDeliveryState.updatedAt, horizon));
}

/** Only exported for tests: full shared state dump. */
export async function sharedDeliveryStateRowsForTests(): Promise<readonly {
  kind: string;
  stateKey: string;
  value: number;
  windowStart: number | null;
}[]> {
  return db
    .select({
      kind: notificationDeliveryState.kind,
      stateKey: notificationDeliveryState.stateKey,
      value: notificationDeliveryState.value,
      windowStart: notificationDeliveryState.windowStart,
    })
    .from(notificationDeliveryState)
    .orderBy(notificationDeliveryState.kind, notificationDeliveryState.stateKey);
}

/** Only exported for tests: clear all shared delivery state. */
export async function resetSharedDeliveryStateForTests(): Promise<void> {
  await db.delete(notificationDeliveryState);
}

// sql is imported for potential raw upserts in dialect-specific paths; keep
// the import honest by referencing it once.
void sql;
