import { afterEach, expect, spyOn, test } from "bun:test";
import { inArray } from "drizzle-orm";

const previousHa = process.env["TERRENCE_HA_ENABLED"];
const previousNodeId = process.env["TERRENCE_NODE_ID"];
process.env["TERRENCE_HA_ENABLED"] = "true";
process.env["TERRENCE_NODE_ID"] = "event-replay-test-node";

const { db, isPostgres, notifyPostgresChannel } = await import("../../src/db");
const { controlEvents } = await import("../../src/db/schema");
const { startDistributedEventBus, stopDistributedEventBus, subscribe } = await import("../../src/lib/event-bus");

const postgresTest = isPostgres ? test : test.skip;
const channel = "terrence_control_events";
const testIds: string[] = [];

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for distributed event");
    await Bun.sleep(10);
  }
}

afterEach(async (): Promise<void> => {
  await stopDistributedEventBus();
  if (testIds.length > 0) {
    await db.delete(controlEvents).where(inArray(controlEvents.id, testIds.splice(0)));
  }
  if (previousHa === undefined) Reflect.deleteProperty(process.env, "TERRENCE_HA_ENABLED");
  else process.env["TERRENCE_HA_ENABLED"] = previousHa;
  if (previousNodeId === undefined) Reflect.deleteProperty(process.env, "TERRENCE_NODE_ID");
  else process.env["TERRENCE_NODE_ID"] = previousNodeId;
});

postgresTest("live notifications cannot advance replay past an older missed durable event", async () => {
  process.env["TERRENCE_HA_ENABLED"] = "true";
  process.env["TERRENCE_NODE_ID"] = "event-replay-test-node";
  await db.delete(controlEvents);
  await startDistributedEventBus();
  await Bun.sleep(100);

  const topic = `event-replay-${crypto.randomUUID()}`;
  const received: string[] = [];
  const unsubscribe = subscribe(topic, (payload): void => {
    if (typeof payload["marker"] === "string") received.push(payload["marker"]);
  });

  const now = Date.now();
  const oldId = crypto.randomUUID();
  const newId = crypto.randomUUID();
  testIds.push(oldId, newId);

  const failLiveRead = spyOn(db.query.controlEvents, "findFirst").mockImplementationOnce((async (): Promise<never> => {
    throw new Error("synthetic notified-row read failure");
  }) as unknown as typeof db.query.controlEvents.findFirst);
  const failCatchUp = spyOn(db.query.controlEvents, "findMany").mockImplementationOnce((async (): Promise<never> => {
    throw new Error("synthetic replay page failure");
  }) as unknown as typeof db.query.controlEvents.findMany);

  try {
    await db.insert(controlEvents).values({
      id: oldId,
      originNodeId: "remote-node",
      originInstanceId: "remote-instance",
      topic,
      payload: { marker: "old" },
      createdAt: now - 120_000,
    });
    await notifyPostgresChannel(channel, oldId);
    await Bun.sleep(100);
  } finally {
    failLiveRead.mockRestore();
    failCatchUp.mockRestore();
  }

  expect(received).not.toContain("old");

  await db.insert(controlEvents).values({
    id: newId,
    originNodeId: "remote-node",
    originInstanceId: "remote-instance",
    topic,
    payload: { marker: "new" },
    createdAt: now,
  });
  await notifyPostgresChannel(channel, newId);
  await waitUntil((): boolean => received.includes("new"));

  await notifyPostgresChannel(channel, crypto.randomUUID());
  await waitUntil((): boolean => received.includes("old"));

  unsubscribe();
  expect(received.filter((marker) => marker === "old")).toHaveLength(1);
  expect(received.filter((marker) => marker === "new")).toHaveLength(1);
});
