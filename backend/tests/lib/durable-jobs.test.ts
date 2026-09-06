import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { durableJobs } from "../../src/db/schema";
import {
  DurableJobBudgetError,
  cancelDurableJob,
  claimDurableJob,
  enqueueDurableJob,
  heartbeatDurableJob,
} from "../../src/lib/durable-jobs";
import { RESOURCE_BUDGET_ENV } from "../../src/lib/resource-budgets";

const kind = "explorer-inventory" as const;
const previousBudget = process.env[RESOURCE_BUDGET_ENV];

afterEach(async (): Promise<void> => {
  await db.delete(durableJobs).where(eq(durableJobs.kind, kind));
  if (previousBudget === undefined) delete process.env[RESOURCE_BUDGET_ENV];
  else process.env[RESOURCE_BUDGET_ENV] = previousBudget;
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

  test("rejects a new budgeted job with a retryable, tenant-neutral error", async () => {
    const organizationId = `budget-test-org-${crypto.randomUUID()}`;
    process.env[RESOURCE_BUDGET_ENV] = JSON.stringify({ global: { queue: 1_000, concurrency: 1, reservedCriticalSlots: 0 }, organization: { queue: 1 } });
    const first = await enqueueDurableJob(
      kind,
      { workspaceId: "org-a-workspace" },
      { dedupeKey: "budget-org-a-job", budget: { organizationId, jobClass: "background" } },
    );
    expect(first.status).toBe("queued");
    let thrown: unknown;
    try {
      await enqueueDurableJob(
        kind,
        { workspaceId: "org-b-workspace" },
        { dedupeKey: "budget-org-b-job", budget: { organizationId, jobClass: "background" } },
      );
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DurableJobBudgetError);
    const budgetError = thrown as DurableJobBudgetError;
    expect(budgetError.status).toBe(429);
    expect(budgetError.admission.reason).toBe("organization-queue-limit");
    expect(budgetError.message).not.toContain(organizationId);
  });

  test("applies the same admission policy when a terminal dedupe row is requeued", async () => {
    const organizationId = `budget-requeue-org-${crypto.randomUUID()}`;
    process.env[RESOURCE_BUDGET_ENV] = JSON.stringify({
      global: { queue: 1_000, concurrency: 1, reservedCriticalSlots: 0 },
      organization: { queue: 1 },
    });
    const terminal = await enqueueDurableJob(
      kind,
      { workspaceId: "terminal-workspace" },
      { dedupeKey: "budget-terminal-job", budget: { organizationId, jobClass: "background" } },
    );
    expect(await cancelDurableJob(terminal.id)).toBe(true);
    await enqueueDurableJob(
      kind,
      { workspaceId: "occupying-workspace" },
      { dedupeKey: "budget-occupying-job", budget: { organizationId, jobClass: "background" } },
    );
    await expect(enqueueDurableJob(
      kind,
      { workspaceId: "terminal-workspace", refreshed: true },
      { dedupeKey: "budget-terminal-job", budget: { organizationId, jobClass: "background" } },
    )).rejects.toBeInstanceOf(DurableJobBudgetError);
  });
});
