import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { durableJobs } from "../../src/db/schema";
import { enqueueDurableJob, startDurableJobWorker, stopDurableJobWorker } from "../../src/lib/durable-jobs";

const previousDisableWorker = process.env["TERRENCE_DISABLE_WORKER"];

afterEach(async (): Promise<void> => {
  stopDurableJobWorker();
  if (previousDisableWorker === undefined) Reflect.deleteProperty(process.env, "TERRENCE_DISABLE_WORKER");
  else process.env["TERRENCE_DISABLE_WORKER"] = previousDisableWorker;
  await db.delete(durableJobs).where(eq(durableJobs.kind, "module-test"));
  await db.delete(durableJobs).where(eq(durableJobs.kind, "vcs-webhook"));
});

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
};

describe("durable job concurrent lanes", () => {
  test("a pending ordinary handler does not hold the reserved critical capacity", async () => {
    process.env["TERRENCE_DISABLE_WORKER"] = "0";
    let releaseOrdinary: () => void = (): void => undefined;
    const ordinaryPending = new Promise<void>((resolve): void => {
      releaseOrdinary = resolve;
    });
    let criticalStarted = false;
    let ordinaryStarted = false;

    await enqueueDurableJob("module-test", { organizationId: "org-lane", runId: "run-1" });

    startDurableJobWorker({
      "module-test": async (): Promise<void> => {
        ordinaryStarted = true;
        await ordinaryPending;
      },
      "vcs-webhook": async (): Promise<void> => {
        criticalStarted = true;
      },
    });
    await waitFor(() => ordinaryStarted, "the ordinary handler to start");

    await enqueueDurableJob("vcs-webhook", {
      organizationId: "org-lane",
      provider: "github",
      eventName: "push",
      payload: {},
      deliveryId: null,
    });

    // The critical job must start while the ordinary handler is still pending:
    // its reserved capacity is not consumed by the long-running handler.
    await waitFor(() => criticalStarted, "the critical handler to start");
    expect(criticalStarted).toBeTrue();
    expect(ordinaryStarted).toBeTrue();
    releaseOrdinary();
  });
});
