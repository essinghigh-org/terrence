/**
 * Transactional outbox for side effects which must survive a process restart.
 *
 * The outbox row and its matching durable job are inserted by the caller's
 * transaction. The durable job supplies the lease/fencing/retry lifecycle;
 * the outbox row supplies the stable event identity and an operator-facing
 * delivered/dead-letter result. A handler may therefore run more than once,
 * but every run carries the same event id to the destination.
 */
import { and, asc, count, eq, inArray, min } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { db } from "../db";
import { durableJobs, outboxEvents } from "../db/schema";
import { newResourceId } from "./resource-id";
import {
  DURABLE_MAX_ATTEMPTS,
  type DurableJob,
  type DurableJobContext,
} from "./durable-jobs";
import { PERSISTED_JOB_PAYLOAD_SCHEMA_VERSION, parsePersistedJobPayload } from "./validation";
import type { DeepReadonly } from "./utils";

export const OUTBOX_DELIVERY_KIND = "outbox-delivery" as const;
export const RUN_NOTIFICATION_OUTBOX_TOPIC = "notification.run" as const;

export type OutboxEvent = DeepReadonly<typeof outboxEvents.$inferSelect>;
export type OutboxEventInput = DeepReadonly<{
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  createdAt?: number;
}>;

// Drizzle's database client is stateful by contract, but the helper only uses
// its query and mutation methods and never mutates the client object itself.
type Database = DeepReadonly<typeof db>;

function durablePayload(eventId: string): Record<string, unknown> {
  return { eventId };
}

function jobForEvent(event: OutboxEvent, now: number): typeof durableJobs.$inferInsert {
  return {
    id: newResourceId("job"),
    kind: OUTBOX_DELIVERY_KIND,
    dedupeKey: event.id,
    status: "queued",
    payload: durablePayload(event.id),
    payloadSchemaVersion: PERSISTED_JOB_PAYLOAD_SCHEMA_VERSION,
    attempts: 0,
    runAfter: now,
    lockedBy: null,
    lockToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Ensure an outbox event has one matching durable delivery job. */
async function ensureDeliveryJob(database: Database, event: OutboxEvent, now = Date.now()): Promise<void> {
  if (event.status === "delivered" || event.status === "dead_letter") return;
  const existing = await database.query.durableJobs.findFirst({
    where: and(
      eq(durableJobs.kind, OUTBOX_DELIVERY_KIND),
      eq(durableJobs.dedupeKey, event.id),
    ),
  });
  if (existing !== undefined) return;
  await database.insert(durableJobs)
    .values(jobForEvent(event, now))
    .onConflictDoNothing({ target: [durableJobs.kind, durableJobs.dedupeKey] });
}

function samePayload(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): boolean {
  // PostgreSQL jsonb does not preserve object key order.
  return isDeepStrictEqual(left, right);
}

/**
 * Insert an outbox event and its durable job using the caller's transaction.
 * Repeating the same id is idempotent; a reused id with different contents is
 * rejected so an event identity can never silently change meaning.
 */
export async function enqueueOutboxEventTx(
  database: Database,
  input: OutboxEventInput,
): Promise<OutboxEvent> {
  if (input.id.trim() === "") throw new Error("Outbox event id must be non-empty");
  if (input.topic.trim() === "") throw new Error("Outbox event topic must be non-empty");
  const now = input.createdAt ?? Date.now();
  const row: typeof outboxEvents.$inferInsert = {
    id: input.id,
    topic: input.topic,
    payload: input.payload,
    status: "pending",
    attempts: 0,
    lastError: null,
    deliveredAt: null,
    createdAt: now,
    updatedAt: now,
  };
  parsePersistedJobPayload(OUTBOX_DELIVERY_KIND, durablePayload(input.id), PERSISTED_JOB_PAYLOAD_SCHEMA_VERSION, input.id);
  const inserted = await database.insert(outboxEvents)
    .values(row)
    .onConflictDoNothing()
    .returning();
  const event = inserted[0] ?? await database.query.outboxEvents.findFirst({ where: eq(outboxEvents.id, input.id) });
  if (event === undefined) throw new Error(`Outbox event ${input.id} could not be read after insert`);
  if (event.topic !== input.topic || !samePayload(event.payload, input.payload)) {
    throw new Error(`Outbox event id ${input.id} is already bound to a different payload`);
  }
  await ensureDeliveryJob(database, event, now);
  return event;
}

/** Insert an outbox event in its own transaction. */
export async function enqueueOutboxEvent(input: OutboxEventInput): Promise<OutboxEvent> {
  return db.transaction(async (transaction): Promise<OutboxEvent> =>
    enqueueOutboxEventTx(transaction as unknown as Database, input));
}

function runNotificationPayload(event: OutboxEvent): Readonly<{
  runId: string;
  trigger: string;
  status: string | undefined;
}> {
  const runId = event.payload["runId"];
  const trigger = event.payload["trigger"];
  const status = event.payload["status"];
  if (typeof runId !== "string" || runId === "") throw new Error(`Outbox event ${event.id} has an invalid runId`);
  if (typeof trigger !== "string" || trigger === "") throw new Error(`Outbox event ${event.id} has an invalid trigger`);
  if (status !== undefined && status !== null && typeof status !== "string") {
    throw new Error(`Outbox event ${event.id} has an invalid status`);
  }
  return { runId, trigger, status: typeof status === "string" ? status : undefined };
}

async function dispatchOutboxEvent(event: OutboxEvent): Promise<void> {
  if (event.topic !== RUN_NOTIFICATION_OUTBOX_TOPIC) {
    throw new Error(`No outbox handler registered for ${event.topic}`);
  }
  // Dynamic import keeps the generic outbox independent from the notification
  // module, which itself owns the enqueue helper used by route/worker code.
  const { deliverRunNotifications } = await import("./notifications");
  const payload = runNotificationPayload(event);
  const deliveries = await deliverRunNotifications(
    payload.runId,
    payload.trigger,
    payload.status,
    { eventId: event.id, skipDedup: true },
  );
  const failures = deliveries.filter((delivery): boolean => !delivery.successful);
  if (failures.length > 0) {
    const codes = [...new Set(failures.map((delivery): string => delivery.code))].sort().join(",");
    throw new Error(`Notification delivery failed for outbox event ${event.id} (HTTP codes: ${codes || "unknown"})`);
  }
}

/** Durable-job handler for one outbox event. */
export async function handleOutboxDeliveryJob(
  job: DeepReadonly<DurableJob>,
  _context?: DeepReadonly<DurableJobContext>,
): Promise<void> {
  const body = parsePersistedJobPayload(
    OUTBOX_DELIVERY_KIND,
    job.payload,
    job.payloadSchemaVersion,
    job.id,
  );
  const eventId = body["eventId"];
  if (typeof eventId !== "string" || eventId === "") throw new Error(`Outbox job ${job.id} is missing eventId`);
  const event = await db.query.outboxEvents.findFirst({ where: eq(outboxEvents.id, eventId) });
  // A manually removed event must not poison the durable queue forever.
  if (event === undefined || event.status === "delivered" || event.status === "dead_letter") return;

  const now = Date.now();
  await db.update(outboxEvents).set({
    status: "processing",
    attempts: job.attempts,
    lastError: null,
    updatedAt: now,
  }).where(and(
    eq(outboxEvents.id, event.id),
    inArray(outboxEvents.status, ["pending", "processing"]),
  ));

  try {
    await dispatchOutboxEvent(event);
    await db.update(outboxEvents).set({
      status: "delivered",
      attempts: job.attempts,
      lastError: null,
      deliveredAt: Date.now(),
      updatedAt: Date.now(),
    }).where(and(
      eq(outboxEvents.id, event.id),
      inArray(outboxEvents.status, ["pending", "processing"]),
    ));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(outboxEvents).set({
      status: job.attempts >= DURABLE_MAX_ATTEMPTS ? "dead_letter" : "pending",
      attempts: job.attempts,
      lastError: message.slice(0, 1_024),
      updatedAt: Date.now(),
    }).where(eq(outboxEvents.id, event.id));
    throw error;
  }
}

export type OutboxMetrics = Readonly<{
  pending: number;
  processing: number;
  delivered: number;
  deadLetter: number;
  oldestPendingSeconds: number;
}>;

/** Queue/dead-letter gauges for operator visibility. */
export async function collectOutboxMetrics(now = Date.now()): Promise<OutboxMetrics> {
  const [byStatus, oldestRows] = await Promise.all([
    db.select({ status: outboxEvents.status, value: count() })
      .from(outboxEvents)
      .groupBy(outboxEvents.status),
    db.select({ oldest: min(outboxEvents.createdAt) })
      .from(outboxEvents)
      .where(inArray(outboxEvents.status, ["pending", "processing"])),
  ]);
  const counts = new Map(byStatus.map((row): [string, number] => [row.status, row.value]));
  const oldest = oldestRows[0]?.oldest ?? null;
  return {
    pending: counts.get("pending") ?? 0,
    processing: counts.get("processing") ?? 0,
    delivered: counts.get("delivered") ?? 0,
    deadLetter: counts.get("dead_letter") ?? 0,
    oldestPendingSeconds: oldest === null ? 0 : Math.max(0, Math.round((now - oldest) / 1_000)),
  };
}

/** Re-arm a dead-lettered event while preserving its stable id. */
export async function retryDeadLetterOutboxEvent(eventId: string): Promise<boolean> {
  return db.transaction(async (transaction): Promise<boolean> => {
    const database = transaction as unknown as Database;
    const event = await database.query.outboxEvents.findFirst({ where: eq(outboxEvents.id, eventId) });
    if (event === undefined || event.status !== "dead_letter") return false;
    const job = await database.query.durableJobs.findFirst({
      where: and(eq(durableJobs.kind, OUTBOX_DELIVERY_KIND), eq(durableJobs.dedupeKey, eventId)),
    });
    if (job === undefined) return false;
    const now = Date.now();
    await database.update(outboxEvents).set({
      status: "pending",
      attempts: 0,
      lastError: null,
      deliveredAt: null,
      updatedAt: now,
    }).where(eq(outboxEvents.id, eventId));
    await database.update(durableJobs).set({
      status: "queued",
      attempts: 0,
      runAfter: now,
      lockedBy: null,
      lockToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      lastError: null,
      updatedAt: now,
    }).where(and(
      eq(durableJobs.id, job.id),
      inArray(durableJobs.status, ["failed", "canceled"]),
    ));
    return true;
  });
}

/** Repair an event/job pair if a legacy install or operator action removed one. */
export async function repairOutboxJobs(limit = 256): Promise<number> {
  const events = await db.query.outboxEvents.findMany({
    where: inArray(outboxEvents.status, ["pending", "processing"]),
    orderBy: [asc(outboxEvents.createdAt)],
    limit,
  });
  for (const event of events) await ensureDeliveryJob(db, event);
  return events.length;
}
