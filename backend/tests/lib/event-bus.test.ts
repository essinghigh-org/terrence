import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { inArray } from "drizzle-orm";

const { db, isPostgres, notifyPostgresChannel } = await import("../../src/db");
const previousHa = process.env["TERRENCE_HA_ENABLED"];
const previousNodeId = process.env["TERRENCE_NODE_ID"];
if (isPostgres) {
  process.env["TERRENCE_HA_ENABLED"] = "true";
  process.env["TERRENCE_NODE_ID"] = "event-replay-test-node";
}

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
});

afterAll((): void => {
  if (previousHa === undefined) Reflect.deleteProperty(process.env, "TERRENCE_HA_ENABLED");
  else process.env["TERRENCE_HA_ENABLED"] = previousHa;
  if (previousNodeId === undefined) Reflect.deleteProperty(process.env, "TERRENCE_NODE_ID");
  else process.env["TERRENCE_NODE_ID"] = previousNodeId;
});

for (const phase of ["cursor", "catch-up"] as const) {
  postgresTest(`shutdown during startup ${phase} prevents a late replay timer and permits restart`, async () => {
    let entered!: () => void;
    const blocked = new Promise<void>((resolve): void => {
      entered = resolve;
    });
    let resume!: () => void;
    const released = new Promise<void>((resolve): void => {
      resume = resolve;
    });
    const method = phase === "cursor" ? "findFirst" : "findMany";
    const pausedRead = spyOn(db.query.controlEvents, method).mockImplementationOnce((async () => {
      entered();
      await released;
      return phase === "cursor" ? undefined : [];
    }) as unknown as typeof db.query.controlEvents.findFirst & typeof db.query.controlEvents.findMany);
    const intervals = spyOn(globalThis, "setInterval");
    try {
      const starting = startDistributedEventBus();
      await blocked;
      const stopping = stopDistributedEventBus();
      resume();
      await Promise.all([starting, stopping]);
      expect(intervals.mock.calls.filter((call) => call[1] === 30_000)).toHaveLength(0);

      pausedRead.mockRestore();
      await startDistributedEventBus();
      expect(intervals.mock.calls.filter((call) => call[1] === 30_000)).toHaveLength(1);
      await stopDistributedEventBus();
    } finally {
      resume();
      pausedRead.mockRestore();
      intervals.mockRestore();
    }
  });
}

postgresTest("a notification read completing after shutdown cannot dispatch to local listeners", async () => {
  await startDistributedEventBus();
  const id = crypto.randomUUID();
  const topic = `event-shutdown-${id}`;
  testIds.push(id);
  const received: unknown[] = [];
  const unsubscribe = subscribe(topic, (payload): void => {
    received.push(payload["marker"]);
  });
  await db.insert(controlEvents).values({
    id,
    originNodeId: "remote-node",
    originInstanceId: "remote-instance",
    topic,
    payload: { marker: "late" },
    createdAt: Date.now(),
  });

  let entered!: () => void;
  const blocked = new Promise<void>((resolve): void => {
    entered = resolve;
  });
  let resume!: () => void;
  const released = new Promise<void>((resolve): void => {
    resume = resolve;
  });
  const findFirst = db.query.controlEvents.findFirst.bind(db.query.controlEvents);
  const pausedRead = spyOn(db.query.controlEvents, "findFirst").mockImplementationOnce((async (...args) => {
    const row = await findFirst(...args);
    entered();
    await released;
    return row;
  }) as typeof db.query.controlEvents.findFirst);
  try {
    await notifyPostgresChannel(channel, id);
    await blocked;
    await stopDistributedEventBus();
    resume();
    await Bun.sleep(30);
    expect(received).toEqual([]);
  } finally {
    resume();
    pausedRead.mockRestore();
    unsubscribe();
  }
});

postgresTest("live notifications cannot advance replay past an older missed durable event", async () => {
  await db.delete(controlEvents);
  await startDistributedEventBus();

  const topic = `event-replay-${crypto.randomUUID()}`;
  const received: string[] = [];
  const unsubscribe = subscribe(topic, (payload): void => {
    if (typeof payload["marker"] === "string") received.push(payload["marker"]);
  });

  const now = Date.now();
  const oldId = crypto.randomUUID();
  const newId = crypto.randomUUID();
  testIds.push(oldId, newId);

  let markLiveRead!: () => void;
  const liveReadFailed = new Promise<void>((resolve): void => {
    markLiveRead = resolve;
  });
  let markCatchUpRead!: () => void;
  const catchUpReadFailed = new Promise<void>((resolve): void => {
    markCatchUpRead = resolve;
  });
  const failLiveRead = spyOn(db.query.controlEvents, "findFirst").mockImplementationOnce((async (): Promise<never> => {
    markLiveRead();
    throw new Error("synthetic notified-row read failure");
  }) as unknown as typeof db.query.controlEvents.findFirst);
  const failCatchUp = spyOn(db.query.controlEvents, "findMany").mockImplementationOnce((async (): Promise<never> => {
    markCatchUpRead();
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
    await Promise.all([liveReadFailed, catchUpReadFailed]);
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
