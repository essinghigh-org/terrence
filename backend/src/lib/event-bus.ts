import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { databaseCurrentTimeMs, db, isPostgres, listenPostgresChannel, notifyPostgresChannel } from "../db";
import { controlEvents } from "../db/schema";
import { controlPlaneInstanceId, controlPlaneNodeId, haEnabled } from "./ha-config";
import { log } from "./log";

/**
 * Local fan-out remains synchronous so existing route/worker behavior does not
 * change. HA mode additionally persists each event and wakes every PostgreSQL
 * replica with LISTEN/NOTIFY; receivers dispatch the durable row into this
 * same local bus.
 */
type Listener = (payload: Readonly<Record<string, unknown>>) => void;

const topics = new Map<string, Set<Listener>>();
const CONTROL_EVENT_CHANNEL = "terrence_control_events";
const CATCH_UP_PAGE_SIZE = 500;
const CONTROL_EVENT_REPLAY_LOOKBACK_MS = 60_000;
const CONTROL_EVENT_CATCH_UP_INTERVAL_MS = 30_000;
const RECENT_EVENT_DEDUPE_LIMIT = 100_000;
const CONTROL_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

type EventCursor = Readonly<{ createdAt: number; id: string }>;
let distributedStarted = false;
let distributedSubscription: { unlisten: () => Promise<void> } | undefined;
let distributedCatchUpTimer: ReturnType<typeof setInterval> | undefined;
let lastCursor: EventCursor = { createdAt: 0, id: "" };
let catchUpPromise: Promise<void> = Promise.resolve();
const seenEventIds = new Set<string>();
const seenEventOrder: string[] = [];

function dispatchLocal(topic: string, payload: Readonly<Record<string, unknown>>): void {
  const listeners = topics.get(topic);
  if (listeners === undefined || listeners.size === 0) return;
  for (const listener of [...listeners]) {
    try {
      listener(payload);
    } catch (error: unknown) {
      log.warn("Event listener failed", {
        topic,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function rememberEvent(id: string): boolean {
  if (seenEventIds.has(id)) return false;
  seenEventIds.add(id);
  seenEventOrder.push(id);
  if (seenEventOrder.length > RECENT_EVENT_DEDUPE_LIMIT) {
    const oldest = seenEventOrder.shift();
    if (oldest !== undefined) seenEventIds.delete(oldest);
  }
  return true;
}

function laterCursor(left: EventCursor, right: EventCursor): EventCursor {
  if (right.createdAt > left.createdAt) return right;
  if (right.createdAt < left.createdAt) return left;
  return right.id > left.id ? right : left;
}

function deliverPersistedEvent(row: Readonly<typeof controlEvents.$inferSelect>): void {
  if (!rememberEvent(row.id)) return;
  lastCursor = laterCursor(lastCursor, { createdAt: row.createdAt, id: row.id });
  if (row.originInstanceId === controlPlaneInstanceId) return;
  dispatchLocal(row.topic, row.payload);
}

async function newestPersistedCursor(): Promise<EventCursor> {
  const newest = await db.query.controlEvents.findFirst({
    columns: { id: true, createdAt: true },
    orderBy: [desc(controlEvents.createdAt), desc(controlEvents.id)],
  });
  return newest ?? { createdAt: 0, id: "" };
}

async function catchUpPersistedEvents(): Promise<void> {
  // Re-read a bounded recent window. PostgreSQL notifications are a wake-up
  // mechanism, not durable delivery, and two autocommit inserts can complete
  // out of timestamp/UUID order. The dedupe set makes this lookback cheap for
  // subscribers while ensuring a missed NOTIFY or commit-order tie is recovered.
  const replayStart = Math.max(0, lastCursor.createdAt - CONTROL_EVENT_REPLAY_LOOKBACK_MS - 1);
  let cursor: EventCursor = { createdAt: replayStart, id: "" };
  for (;;) {
    const rows = await db.query.controlEvents.findMany({
      where: or(
        gt(controlEvents.createdAt, cursor.createdAt),
        and(eq(controlEvents.createdAt, cursor.createdAt), gt(controlEvents.id, cursor.id)),
      ),
      orderBy: [asc(controlEvents.createdAt), asc(controlEvents.id)],
      limit: CATCH_UP_PAGE_SIZE,
    });
    if (rows.length === 0) break;
    for (const row of rows) deliverPersistedEvent(row);
    const tail = rows.at(-1);
    if (tail === undefined) break;
    cursor = { createdAt: tail.createdAt, id: tail.id };
    if (rows.length < CATCH_UP_PAGE_SIZE) break;
  }
  lastCursor = laterCursor(lastCursor, cursor);
}

function scheduleCatchUp(): void {
  catchUpPromise = catchUpPromise
    .catch((): void => undefined)
    .then(catchUpPersistedEvents)
    .catch((error: unknown): void => {
      log.error("Distributed event catch-up failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

async function receiveNotifiedEvent(id: string): Promise<void> {
  const row = await db.query.controlEvents.findFirst({ where: eq(controlEvents.id, id) });
  if (row === undefined) throw new Error("Notified control event was not readable");
  deliverPersistedEvent(row);
}

/** Start the PostgreSQL fan-out bridge after migrations have completed. */
export async function startDistributedEventBus(): Promise<void> {
  if (!haEnabled() || !isPostgres || distributedStarted) return;
  distributedStarted = true;
  try {
    // Ignore history from before this process joined the cluster. Anything
    // committed between this read and LISTEN acknowledgement is recovered by
    // the initial onListen catch-up.
    lastCursor = await newestPersistedCursor();
    distributedSubscription = await listenPostgresChannel(
      CONTROL_EVENT_CHANNEL,
      (id): void => {
        void receiveNotifiedEvent(id).catch((error: unknown): void => {
          log.warn("Unable to load notified control event; scheduling durable catch-up", {
            error: error instanceof Error ? error.message : String(error),
          });
          scheduleCatchUp();
        });
      },
      (): void => {
        scheduleCatchUp();
      },
    );
    distributedCatchUpTimer = setInterval(scheduleCatchUp, CONTROL_EVENT_CATCH_UP_INTERVAL_MS);
    distributedCatchUpTimer.unref?.();
  } catch (error: unknown) {
    distributedStarted = false;
    throw error;
  }
}

export async function stopDistributedEventBus(): Promise<void> {
  distributedStarted = false;
  if (distributedCatchUpTimer !== undefined) clearInterval(distributedCatchUpTimer);
  distributedCatchUpTimer = undefined;
  const subscription = distributedSubscription;
  distributedSubscription = undefined;
  if (subscription !== undefined) await subscription.unlisten();
  await catchUpPromise.catch((): void => undefined);
}

async function persistDistributedEvent(topic: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  const id = crypto.randomUUID();
  await db.insert(controlEvents).values({
    id,
    originNodeId: controlPlaneNodeId(),
    originInstanceId: controlPlaneInstanceId,
    topic,
    payload,
    // Use the database clock so cursor ordering is independent of replica
    // clock skew. This code path is PostgreSQL-only.
    createdAt: sql<number>`CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)`,
  });
  await notifyPostgresChannel(CONTROL_EVENT_CHANNEL, id);
}

/** Coordinator-owned retention sweep; a 24h window is ample for reconnect catch-up. */
export async function pruneControlEvents(now?: number): Promise<number> {
  if (!haEnabled() || !isPostgres) return 0;
  const currentNow = now ?? (await databaseCurrentTimeMs());
  const removed = await db
    .delete(controlEvents)
    .where(lt(controlEvents.createdAt, currentNow - CONTROL_EVENT_RETENTION_MS))
    .returning({ id: controlEvents.id });
  return removed.length;
}

export function subscribe(topic: string, listener: Listener): () => void {
  let listeners = topics.get(topic);
  if (listeners === undefined) {
    listeners = new Set();
    topics.set(topic, listeners);
  }
  listeners.add(listener);
  let disposed = false;
  return (): void => {
    if (disposed) return;
    disposed = true;
    if (topics.get(topic) !== listeners) return;
    listeners.delete(listener);
    if (listeners.size === 0) topics.delete(topic);
  };
}

export function publish(topic: string, payload: Readonly<Record<string, unknown>>): void {
  dispatchLocal(topic, payload);
  if (!haEnabled() || !isPostgres) return;
  void persistDistributedEvent(topic, payload).catch((error: unknown): void => {
    log.error("Unable to persist distributed control event", {
      topic,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
