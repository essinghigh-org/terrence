import { afterEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db";
import { durableJobs } from "../../src/db/schema";
import {
  DurableJobBudgetError,
  activeDurableJobCount,
  cancelDurableJob,
  claimDurableJob,
  enqueueDurableJob,
  heartbeatDurableJob,
  runDurableJobForTests,
  startDurableJobWorker,
  stopDurableJobWorker,
} from "../../src/lib/durable-jobs";
import { RESOURCE_BUDGET_ENV } from "../../src/lib/resource-budgets";

const kind = "explorer-inventory" as const;
const criticalKind = "vcs-webhook" as const;
const previousBudget = process.env[RESOURCE_BUDGET_ENV];
const previousDisableWorker = process.env["TERRENCE_DISABLE_WORKER"];

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for durable worker condition");
    await Bun.sleep(10);
  }
}

afterEach(async (): Promise<void> => {
  stopDurableJobWorker();
  await waitUntil((): boolean => activeDurableJobCount() === 0).catch((): void => undefined);
  await db.delete(durableJobs).where(inArray(durableJobs.kind, [kind, criticalKind]));
  if (previousBudget === undefined) Reflect.deleteProperty(process.env, RESOURCE_BUDGET_ENV);
  else process.env[RESOURCE_BUDGET_ENV] = previousBudget;
  if (previousDisableWorker === undefined) Reflect.deleteProperty(process.env, "TERRENCE_DISABLE_WORKER");
  else process.env["TERRENCE_DISABLE_WORKER"] = previousDisableWorker;
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
    expect(await cancelDurableJob(first.id)).toBe(false);
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

  test("aborts work when the last confirmed lease deadline passes without renewal", async () => {
    const queued = await enqueueDurableJob(kind, { workspaceId: "lease-watchdog" });
    const claimed = await claimDurableJob("worker-watchdog", [kind]);
    expect(claimed?.id).toBe(queued.id);
    if (claimed === undefined) throw new Error("expected watchdog worker claim");

    let aborted = false;
    const shortDeadlineJob = { ...claimed, leaseExpiresAt: Date.now() + 40 };
    await runDurableJobForTests(shortDeadlineJob, async (_job, context): Promise<void> => {
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          aborted = context.signal.aborted;
          resolve();
        };
        if (context.signal.aborted) stop();
        else context.signal.addEventListener("abort", stop, { once: true });
      });
    });

    expect(aborted).toBe(true);
    const row = await db.query.durableJobs.findFirst({ where: eq(durableJobs.id, claimed.id) });
    expect(row?.status).toBe("queued");
    expect(row?.lastError).toContain("lease expired");
  });

  test("rejects a new budgeted job with a retryable, tenant-neutral error", async () => {
    const organizationId = `budget-test-org-${crypto.randomUUID()}`;
    process.env[RESOURCE_BUDGET_ENV] = JSON.stringify({
      global: { queue: 1_000, concurrency: 1, reservedCriticalSlots: 0 },
      organization: { queue: 1 },
    });
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
    expect(
      enqueueDurableJob(
        kind,
        { workspaceId: "terminal-workspace", refreshed: true },
        { dedupeKey: "budget-terminal-job", budget: { organizationId, jobClass: "background" } },
      ),
    ).rejects.toBeInstanceOf(DurableJobBudgetError);
  });

  test("scans past 256 budget-blocked jobs to claim later protected work", async () => {
    const now = Date.now();
    process.env[RESOURCE_BUDGET_ENV] = JSON.stringify({
      global: { queue: 1_000, concurrency: 3, reservedCriticalSlots: 1 },
      classes: { background: { concurrency: 2 }, critical: { concurrency: 3 } },
    });
    const suffix = crypto.randomUUID();
    await db.insert(durableJobs).values([
      ...[0, 1].map((index) => ({
        id: `job-running-${suffix}-${index}`,
        kind,
        payload: { jobClass: "background" },
        status: "running",
        attempts: 1,
        runAfter: now - 2_000,
        lockedBy: "other-worker",
        lockToken: `lock-${index}`,
        leaseExpiresAt: now + 60_000,
        heartbeatAt: now,
        createdAt: now - 2_000 + index,
        updatedAt: now,
      })),
      ...Array.from({ length: 256 }, (_, index) => ({
        id: `job-blocked-${suffix}-${String(index).padStart(3, "0")}`,
        kind,
        payload: { jobClass: "background" },
        status: "queued",
        attempts: 0,
        runAfter: now - 1_000,
        lockedBy: null,
        lockToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        createdAt: now - 1_000 + index,
        updatedAt: now,
      })),
      {
        id: `job-critical-${suffix}`,
        kind: criticalKind,
        payload: { jobClass: "critical" },
        status: "queued",
        attempts: 0,
        runAfter: now - 500,
        lockedBy: null,
        lockToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const claimed = await claimDurableJob("worker-protected", [kind, criticalKind], now);
    expect(claimed?.kind).toBe(criticalKind);
    expect(claimed?.id).toBe(`job-critical-${suffix}`);
  });

  test("dispatches protected work while a long ordinary durable handler is still running", async () => {
    Reflect.deleteProperty(process.env, "TERRENCE_DISABLE_WORKER");
    process.env[RESOURCE_BUDGET_ENV] = JSON.stringify({
      global: { queue: 100, concurrency: 2, reservedCriticalSlots: 1 },
      classes: { background: { concurrency: 1 }, critical: { concurrency: 2 } },
    });

    let releaseLong!: () => void;
    const holdLong = new Promise<void>((resolve): void => {
      releaseLong = resolve;
    });
    let markLongStarted!: () => void;
    const longStarted = new Promise<void>((resolve): void => {
      markLongStarted = resolve;
    });
    let markCriticalFinished!: () => void;
    const criticalFinished = new Promise<void>((resolve): void => {
      markCriticalFinished = resolve;
    });

    await enqueueDurableJob(kind, { workspaceId: "long-running" }, { budget: { jobClass: "background" } });
    startDurableJobWorker({
      [kind]: async (): Promise<void> => {
        markLongStarted();
        await holdLong;
      },
      [criticalKind]: async (): Promise<void> => {
        markCriticalFinished();
      },
    });

    try {
      await longStarted;
      const criticalId = `job-concurrent-critical-${crypto.randomUUID()}`;
      const now = Date.now();
      await db.insert(durableJobs).values({
        id: criticalId,
        kind: criticalKind,
        payload: { jobClass: "critical" },
        status: "queued",
        attempts: 0,
        runAfter: now,
        createdAt: now,
        updatedAt: now,
      });
      await Promise.race([
        criticalFinished,
        Bun.sleep(1_500).then(async (): Promise<never> => {
          const row = await db.query.durableJobs.findFirst({ where: eq(durableJobs.id, criticalId) });
          throw new Error(
            `critical durable job was blocked behind long ordinary work: status=${row?.status ?? "missing"} active=${activeDurableJobCount()}`,
          );
        }),
      ]);
      await waitUntil(async (): Promise<boolean> => {
        const row = await db.query.durableJobs.findFirst({ where: eq(durableJobs.id, criticalId) });
        return row?.status === "succeeded";
      });
    } finally {
      releaseLong();
    }
  });
});
