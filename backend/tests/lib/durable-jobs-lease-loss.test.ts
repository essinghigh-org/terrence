import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

// Short lease windows make the fencing path deterministic: the watchdog must
// fire inside a test rather than after the 30s production TTL. These are read
// when the durable-job module is imported below.
process.env["TERRENCE_DURABLE_LEASE_MS"] = "600";
process.env["TERRENCE_DURABLE_RENEW_MS"] = "150";

const { db } = await import("../../src/db");
const { durableJobs } = await import("../../src/db/schema");
const { enqueueDurableJob, readDurableJobLeaseWindowsForTests, startDurableJobWorker, stopDurableJobWorker } =
  await import("../../src/lib/durable-jobs");

const previousDisableWorker = process.env["TERRENCE_DISABLE_WORKER"];
const suiteLease = process.env["TERRENCE_DURABLE_LEASE_MS"];
const suiteRenew = process.env["TERRENCE_DURABLE_RENEW_MS"];

// leaseMs()/renewMs() read the environment per use, so these short windows
// would otherwise apply to every later file in the same Bun process.
afterAll((): void => {
  if (suiteLease === undefined) Reflect.deleteProperty(process.env, "TERRENCE_DURABLE_LEASE_MS");
  else process.env["TERRENCE_DURABLE_LEASE_MS"] = suiteLease;
  if (suiteRenew === undefined) Reflect.deleteProperty(process.env, "TERRENCE_DURABLE_RENEW_MS");
  else process.env["TERRENCE_DURABLE_RENEW_MS"] = suiteRenew;
});

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
};

afterEach(async (): Promise<void> => {
  stopDurableJobWorker();
  if (previousDisableWorker === undefined) Reflect.deleteProperty(process.env, "TERRENCE_DISABLE_WORKER");
  else process.env["TERRENCE_DISABLE_WORKER"] = previousDisableWorker;
  await db.delete(durableJobs).where(eq(durableJobs.kind, "module-test"));
});

describe("durable job lease-loss fencing", () => {
  test("a handler whose lease is reclaimed elsewhere receives lease-loss cancellation", async () => {
    process.env["TERRENCE_DISABLE_WORKER"] = "0";
    let fenced = false;
    let returnedAfterFence = false;
    let release: () => void = (): void => undefined;
    let markStarted: () => void = (): void => undefined;
    const started = new Promise<void>((resolve): void => {
      markStarted = resolve;
    });
    const pending = new Promise<void>((resolve): void => {
      release = resolve;
    });

    const job = await enqueueDurableJob("module-test", { runId: "run-lease-loss" });
    startDurableJobWorker({
      "module-test": async (_job, context): Promise<void> => {
        markStarted();
        // A signal-aware handler blocked on external work.
        await new Promise<void>((resolve): void => {
          if (context.signal.aborted) {
            resolve();
            return;
          }
          context.signal.addEventListener("abort", (): void => {
            resolve();
          });
        });
        fenced = true;
        // A legacy handler that ignores the signal and returns afterwards.
        await pending;
        returnedAfterFence = true;
      },
    });
    await started;

    // Another worker reclaims the expired lease with a new lock token. Its
    // runAfter is pushed out so no local lane re-claims the row while the
    // fenced handler unwinds.
    await db
      .update(durableJobs)
      .set({
        status: "queued",
        lockedBy: "other-worker",
        lockToken: "newer-token",
        leaseExpiresAt: null,
        runAfter: Date.now() + 60_000,
      })
      .where(eq(durableJobs.id, job.id));

    await waitFor(() => fenced, "lease-loss cancellation");
    release();
    await waitFor(() => returnedAfterFence, "the fenced handler to return");

    // The fenced handler must not publish a result for the newer owner.
    const row = await db.query.durableJobs.findFirst({ where: eq(durableJobs.id, job.id) });
    expect(row?.lockToken).toBe("newer-token");
    expect(row?.status).toBe("queued");
  }, 20_000);
});

describe("durable lease window invariants", () => {
  test("the renewal cadence always precedes the lease-loss watchdog", async () => {
    const previousLease = process.env["TERRENCE_DURABLE_LEASE_MS"];
    const previousRenew = process.env["TERRENCE_DURABLE_RENEW_MS"];
    try {
      // Smallest accepted lease through the production default: a cadence at
      // or above the TTL would let the watchdog fire before the first renewal.
      for (const lease of [300, 301, 400, 599, 600, 1_000, 30_000]) {
        for (const renew of [100, 150, 10_000]) {
          process.env["TERRENCE_DURABLE_LEASE_MS"] = String(lease);
          process.env["TERRENCE_DURABLE_RENEW_MS"] = String(renew);
          const windows = readDurableJobLeaseWindowsForTests();
          expect(windows.renewMs).toBeGreaterThan(0);
          expect(windows.renewMs).toBeLessThan(windows.leaseMs);
        }
      }
    } finally {
      if (previousLease === undefined) Reflect.deleteProperty(process.env, "TERRENCE_DURABLE_LEASE_MS");
      else process.env["TERRENCE_DURABLE_LEASE_MS"] = previousLease;
      if (previousRenew === undefined) Reflect.deleteProperty(process.env, "TERRENCE_DURABLE_RENEW_MS");
      else process.env["TERRENCE_DURABLE_RENEW_MS"] = previousRenew;
    }
  });
});
