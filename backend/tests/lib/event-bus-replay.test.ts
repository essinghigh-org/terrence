import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { db } from "../../src/db";
import { controlEvents } from "../../src/db/schema";
import { controlPlaneInstanceId } from "../../src/lib/ha-config";
import {
  catchUpControlEventsForTests,
  receiveNotifiedControlEventForTests,
  resetControlEventReplayForTests,
  subscribe,
} from "../../src/lib/event-bus";

const TOPIC = "test.replay";
const suffix = crypto.randomUUID();
const ids: string[] = [];

const insertEvent = async (createdAt: number, label: string, originInstanceId = "instance-other"): Promise<string> => {
  const id = `evt-${label}-${suffix}`;
  ids.push(id);
  await db.insert(controlEvents).values({
    id,
    originNodeId: "node-test",
    originInstanceId,
    topic: TOPIC,
    payload: { label },
    createdAt,
  });
  return id;
};

const delivered: string[] = [];
let unsubscribe: (() => void) | undefined;

beforeEach(async (): Promise<void> => {
  delivered.length = 0;
  unsubscribe?.();
  unsubscribe = subscribe(TOPIC, (payload): void => {
    const label = payload["label"];
    delivered.push(typeof label === "string" ? label : "");
  });
  // Isolate scenarios: no rows and no dedupe entries survive a test.
  await db.delete(controlEvents).where(inArray(controlEvents.id, ids));
  ids.length = 0;
  resetControlEventReplayForTests();
});

afterAll(async (): Promise<void> => {
  unsubscribe?.();
  if (ids.length > 0) await db.delete(controlEvents).where(inArray(controlEvents.id, ids));
});

describe("durable control-event replay", () => {
  test("a newer live delivery does not hide an event missed beyond the lookback", async () => {
    // The receiver joined the cluster ten minutes ago; its replay lookback
    // reaches one minute before that point.
    const joinedAt = Date.now() - 10 * 60_000;
    resetControlEventReplayForTests(joinedAt);

    // An event this receiver missed entirely.
    const missedId = await insertEvent(joinedAt + 60_000, "missed");
    // Its notification read and replay attempts fail (nothing was scanned).
    // Later a newer event arrives over the live notification path.
    const liveId = await insertEvent(Date.now() - 1_000, "live");
    await receiveNotifiedControlEventForTests(liveId);
    expect(delivered).toEqual(["live"]);

    // The next successful catch-up must still deliver the missed event: live
    // delivery advanced only the dispatched high-water mark.
    await catchUpControlEventsForTests();
    expect(delivered).toContain("missed");
    expect(missedId).not.toBe(liveId);
  });

  test("locally originated rows are not echoed back to this process", async () => {
    const now = Date.now();
    resetControlEventReplayForTests(now - 1_000);
    const localId = await insertEvent(now, "local", controlPlaneInstanceId);
    await receiveNotifiedControlEventForTests(localId);
    await catchUpControlEventsForTests();
    expect(delivered).toEqual([]);
  });

  test("a reconnect replays every durable row exactly once", async () => {
    const base = Date.now() - 30_000;
    resetControlEventReplayForTests(base - 60_000);
    for (let i = 0; i < 3; i += 1) await insertEvent(base + i, `row${i}`);
    await catchUpControlEventsForTests();
    expect([...delivered].sort()).toEqual(["row0", "row1", "row2"]);

    // A second catch-up pass is idempotent: dedupe suppresses re-delivery.
    delivered.length = 0;
    await catchUpControlEventsForTests();
    expect(delivered).toEqual([]);
  });
});
