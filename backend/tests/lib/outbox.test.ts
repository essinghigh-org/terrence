import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/db";
import {
  durableJobs,
  notificationConfigurations,
  organizations,
  outboxEvents,
  runs,
  workspaces,
} from "../../src/db/schema";
import {
  DURABLE_MAX_ATTEMPTS,
  claimDurableJob,
} from "../../src/lib/durable-jobs";
import {
  enqueueOutboxEvent,
  enqueueOutboxEventTx,
  handleOutboxDeliveryJob,
  retryDeadLetterOutboxEvent,
  RUN_NOTIFICATION_OUTBOX_TOPIC,
} from "../../src/lib/outbox";

const createdEventIds: string[] = [];
const createdOrganizationIds: string[] = [];

afterEach(async (): Promise<void> => {
  if (createdEventIds.length > 0) {
    await db.delete(durableJobs).where(and(
      eq(durableJobs.kind, "outbox-delivery"),
      inArray(durableJobs.dedupeKey, createdEventIds),
    ));
    await db.delete(outboxEvents).where(inArray(outboxEvents.id, createdEventIds));
    createdEventIds.length = 0;
  }
  for (const orgId of createdOrganizationIds.splice(0)) {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
});

function event(id: string, topic = "test.outbox", payload: Record<string, unknown> = { id }): {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
} {
  createdEventIds.push(id);
  return { id, topic, payload };
}

describe("transactional outbox", () => {
  test("commits the event and durable job with the domain transaction", async () => {
    const id = `outbox-atomic-${crypto.randomUUID()}`;
    const orgId = `outbox-org-${crypto.randomUUID()}`;
    createdEventIds.push(id);
    createdOrganizationIds.push(orgId);
    await db.transaction(async (transaction): Promise<void> => {
      const tx = transaction as unknown as typeof db;
      await tx.insert(organizations).values({ id: orgId, name: `outbox-${crypto.randomUUID()}` });
      await enqueueOutboxEventTx(tx, event(id));
    });

    expect(await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) })).toBeDefined();
    expect(await db.query.outboxEvents.findFirst({ where: eq(outboxEvents.id, id) })).toMatchObject({
      id,
      status: "pending",
    });
    expect(await db.query.durableJobs.findFirst({
      where: and(eq(durableJobs.kind, "outbox-delivery"), eq(durableJobs.dedupeKey, id)),
    })).toMatchObject({ status: "queued", attempts: 0 });

    const rolledBackId = `outbox-rollback-${crypto.randomUUID()}`;
    createdEventIds.push(rolledBackId);
    let rollbackError: unknown;
    try {
      await db.transaction(async (transaction): Promise<void> => {
        await enqueueOutboxEventTx(transaction as unknown as typeof db, event(rolledBackId));
        throw new Error("simulate domain transaction crash");
      });
    } catch (error: unknown) {
      rollbackError = error;
    }
    expect(rollbackError).toBeInstanceOf(Error);
    expect((rollbackError as Error).message).toBe("simulate domain transaction crash");
    expect(await db.query.outboxEvents.findFirst({ where: eq(outboxEvents.id, rolledBackId) })).toBeUndefined();
    expect(await db.query.durableJobs.findFirst({
      where: and(eq(durableJobs.kind, "outbox-delivery"), eq(durableJobs.dedupeKey, rolledBackId)),
    })).toBeUndefined();
  });

  test("repeated enqueue uses one stable event and one durable job", async () => {
    const input = event(`outbox-dedupe-${crypto.randomUUID()}`);
    const [first, second] = await Promise.all([
      enqueueOutboxEvent(input),
      enqueueOutboxEvent(input),
    ]);
    expect(first.id).toBe(second.id);
    expect(await db.query.outboxEvents.findMany({ where: eq(outboxEvents.id, input.id) })).toHaveLength(1);
    expect(await db.query.durableJobs.findMany({
      where: and(eq(durableJobs.kind, "outbox-delivery"), eq(durableJobs.dedupeKey, input.id)),
    })).toHaveLength(1);
  });

  test("lease expiry reclaims the same event after a worker crash", async () => {
    const input = event(`outbox-crash-${crypto.randomUUID()}`);
    await enqueueOutboxEvent(input);
    const now = Date.now();
    const first = await claimDurableJob("outbox-worker-a", ["outbox-delivery"], now);
    expect(first?.dedupeKey).toBe(input.id);
    const reclaimed = await claimDurableJob("outbox-worker-b", ["outbox-delivery"], now + 31_002);
    expect(reclaimed?.id).toBe(first?.id);
    expect(reclaimed?.dedupeKey).toBe(input.id);
    expect((await db.query.outboxEvents.findFirst({ where: eq(outboxEvents.id, input.id) }))?.status).toBe("pending");
  });

  test("permanent failure dead-letters only its event and can be re-armed", async () => {
    const failing = event(`outbox-failing-${crypto.randomUUID()}`);
    const unrelated = event(`outbox-unrelated-${crypto.randomUUID()}`);
    const base = Date.now();
    await enqueueOutboxEvent({ ...failing, createdAt: base - 10_000 });
    await enqueueOutboxEvent({ ...unrelated, createdAt: base + 60_000 });

    for (let attempt = 1; attempt <= DURABLE_MAX_ATTEMPTS; attempt += 1) {
      const job = await claimDurableJob(`outbox-failure-${attempt}`, ["outbox-delivery"]);
      expect(job?.dedupeKey).toBe(failing.id);
      let deliveryError: unknown;
      try {
        await handleOutboxDeliveryJob(job!);
      } catch (error: unknown) {
        deliveryError = error;
      }
      expect(deliveryError).toBeInstanceOf(Error);
      expect((deliveryError as Error).message).toContain("No outbox handler registered");
      if (attempt < DURABLE_MAX_ATTEMPTS) {
        await db.update(durableJobs).set({ status: "queued", runAfter: Date.now() - 1 }).where(eq(durableJobs.id, job!.id));
      } else {
        await db.update(durableJobs).set({ status: "failed" }).where(eq(durableJobs.id, job!.id));
      }
    }

    expect((await db.query.outboxEvents.findFirst({ where: eq(outboxEvents.id, failing.id) }))?.status).toBe("dead_letter");
    const unrelatedJob = await db.query.durableJobs.findFirst({
      where: and(eq(durableJobs.kind, "outbox-delivery"), eq(durableJobs.dedupeKey, unrelated.id)),
    });
    await db.update(durableJobs).set({ runAfter: Date.now() - 1 }).where(eq(durableJobs.id, unrelatedJob!.id));
    const next = await claimDurableJob("outbox-unrelated-worker", ["outbox-delivery"]);
    expect(next?.dedupeKey).toBe(unrelated.id);
    expect(await retryDeadLetterOutboxEvent(failing.id)).toBe(true);
    expect((await db.query.outboxEvents.findFirst({ where: eq(outboxEvents.id, failing.id) }))?.status).toBe("pending");
  });

  test("successful notification delivery carries the stable id and is idempotent", async () => {
    const suffix = crypto.randomUUID();
    const orgId = `outbox-notify-org-${suffix}`;
    const workspaceId = `outbox-notify-ws-${suffix}`;
    const runId = `outbox-notify-run-${suffix}`;
    const configurationId = `outbox-notify-config-${suffix}`;
    const eventId = `outbox-notify-event-${suffix}`;
    createdOrganizationIds.push(orgId);
    createdEventIds.push(eventId);
    let calls = 0;
    let received: Record<string, unknown> | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        calls += 1;
        received = await request.json() as Record<string, unknown>;
        return new Response(null, { status: 204 });
      },
    });
    try {
      process.env["TERRENCE_ALLOW_PRIVATE_URLS"] = "true";
      await db.insert(organizations).values({ id: orgId, name: `outbox-notify-${suffix}` });
      await db.insert(workspaces).values({ id: workspaceId, name: `outbox-ws-${suffix}`, orgId });
      await db.insert(runs).values({ id: runId, workspaceId, status: "errored", createdAt: Date.now() });
      await db.insert(notificationConfigurations).values({
        id: configurationId,
        workspaceId,
        name: "outbox destination",
        destinationType: "generic",
        url: server.url.toString(),
        triggers: ["run:errored"],
        enabled: true,
      });
      await enqueueOutboxEvent({
        id: eventId,
        topic: RUN_NOTIFICATION_OUTBOX_TOPIC,
        payload: { runId, trigger: "run:errored", status: "errored" },
      });
      const job = await claimDurableJob("outbox-notification-worker", ["outbox-delivery"]);
      expect(job?.dedupeKey).toBe(eventId);
      await handleOutboxDeliveryJob(job!);
      expect(calls).toBe(1);
      expect(received?.["event_id"]).toBe(eventId);
      expect((await db.query.outboxEvents.findFirst({ where: eq(outboxEvents.id, eventId) }))?.status).toBe("delivered");

      // A redelivery after the durable job itself was acknowledged is a no-op
      // because the outbox result is already terminal.
      await handleOutboxDeliveryJob(job!);
      expect(calls).toBe(1);
    } finally {
      await server.stop(true);
      await db.delete(notificationConfigurations).where(eq(notificationConfigurations.id, configurationId));
      await db.delete(runs).where(eq(runs.id, runId));
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    }
  });
});
