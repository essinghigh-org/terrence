import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { durableJobs } from "../../src/db/schema";
import {
  cancelDurableJob,
  claimDurableJob,
  enqueueDurableJob,
  heartbeatDurableJob,
} from "../../src/lib/durable-jobs";

const kind = "explorer-inventory" as const;

afterEach(async (): Promise<void> => {
  await db.delete(durableJobs).where(eq(durableJobs.kind, kind));
});

describe("durable job leases", () => {
  test("deduplicates concurrent enqueue and reuses terminal jobs", async () => {
    const dedupeKey = `workspace-${crypto.randomUUID()}`;
    const [first, second] = await Promise.all([
      enqueueDurableJob(kind, { workspaceId: dedupeKey }, { dedupeKey }),
      enqueueDurableJob(kind, { workspaceId: dedupeKey }, { dedupeKey }),
    ]);
    expect(first.id).toBe(second.id);

    expect(await cancelDurableJob(first.id)).toBe(true);
    const replacement = await enqueueDurableJob(kind, { workspaceId: dedupeKey, refreshed: true }, { dedupeKey });
    expect(replacement.id).toBe(first.id);
    expect(replacement.status).toBe("queued");
    expect(replacement.attempts).toBe(0);
  });

  test("fences stale workers after a lease expires", async () => {
    const now = Date.now();
    const queued = await enqueueDurableJob(kind, { workspaceId: "lease-test" }, { runAfter: now - 1 });
    const first = await claimDurableJob("worker-a", [kind], now);
    expect(first?.id).toBe(queued.id);
    if (first === undefined) throw new Error("expected first worker claim");

    expect(await heartbeatDurableJob(first, now + 1)).toBe(true);
    expect(await claimDurableJob("worker-b", [kind], now + 2)).toBeUndefined();

    const reclaimed = await claimDurableJob("worker-b", [kind], now + 31_002);
    expect(reclaimed?.id).toBe(first.id);
    expect(await heartbeatDurableJob(first, now + 31_003)).toBe(false);
  });
});
