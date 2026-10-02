import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { durableJobs } from "../../src/db/schema";
import { claimDurableJob } from "../../src/lib/durable-jobs";
import { RESOURCE_BUDGET_ENV } from "../../src/lib/resource-budgets";

const previousBudget = process.env[RESOURCE_BUDGET_ENV];

afterEach(async (): Promise<void> => {
  await db.delete(durableJobs).where(eq(durableJobs.kind, "module-test"));
  await db.delete(durableJobs).where(eq(durableJobs.kind, "vcs-webhook"));
  if (previousBudget === undefined) Reflect.deleteProperty(process.env, RESOURCE_BUDGET_ENV);
  else process.env[RESOURCE_BUDGET_ENV] = previousBudget;
});

describe("durable job budget window scanning", () => {
  test("finds a critical job hidden behind a budget-blocked ordinary prefix", async () => {
    process.env[RESOURCE_BUDGET_ENV] = JSON.stringify({
      global: { queue: 1_000, concurrency: 5, reservedCriticalSlots: 1 },
      classes: { plan: { concurrency: 2, queue: 1_000 } },
    });
    const now = Date.now();
    // Two running background jobs saturate the background class limit.
    await db.insert(durableJobs).values([
      {
        id: `running-bg-1-${now}`,
        kind: "module-test",
        status: "running",
        payload: { kind: "module-test" },
        runAfter: now,
        createdAt: now,
        leaseExpiresAt: now + 60_000,
        lockedBy: "other",
        lockToken: crypto.randomUUID(),
        updatedAt: now,
      },
      {
        id: `running-bg-2-${now}`,
        kind: "module-test",
        status: "running",
        payload: { kind: "module-test" },
        runAfter: now,
        createdAt: now,
        leaseExpiresAt: now + 60_000,
        lockedBy: "other",
        lockToken: crypto.randomUUID(),
        updatedAt: now,
      },
    ]);
    const queued: (typeof durableJobs.$inferInsert)[] = [];
    for (let i = 0; i < 256; i += 1) {
      queued.push({
        id: `blocked-bg-${i}-${now}`,
        kind: "module-test",
        status: "queued",
        payload: { organizationId: "org-x", estimatedBytes: 0 },
        runAfter: now - 10_000 - i,
        createdAt: now - 10_000 - i,
        updatedAt: now,
      });
    }
    await db.insert(durableJobs).values(queued);
    await db.insert(durableJobs).values([
      {
        id: `eligible-critical-${now}`,
        kind: "vcs-webhook",
        status: "queued",
        payload: { organizationId: "org-y", estimatedBytes: 0 },
        runAfter: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const claimed = await claimDurableJob("worker-critical", ["module-test", "vcs-webhook"], now);
    expect(claimed?.kind).toBe("vcs-webhook");
  });
});
