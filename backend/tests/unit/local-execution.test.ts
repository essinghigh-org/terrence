import { describe, expect, it } from "bun:test";
import { LocalExecutionLifecycle } from "../../src/worker/local-execution";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise): void => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("local execution lifecycle ownership", () => {
  it("reserves capacity once per run and releases it after a failed claim", () => {
    const owner = new LocalExecutionLifecycle({ concurrencyLimit: (): number => 1 });

    expect(owner.reserveRun("run-a")).toBe(true);
    expect(owner.reserveRun("run-a")).toBe(true);
    expect(owner.reserveRun("run-b")).toBe(false);
    expect(owner.hasReservation("run-a")).toBe(true);

    owner.releaseReservation("run-a");
    expect(owner.hasReservation("run-a")).toBe(false);
    expect(owner.reserveRun("run-b")).toBe(true);
  });

  it("converts a reservation into one owned slot and releases it on success", async () => {
    const owner = new LocalExecutionLifecycle({ concurrencyLimit: (): number => 2 });
    owner.reserveRun("run-a");

    const result = await owner.trackRun("run-a", async (): Promise<string> => {
      expect(owner.hasReservation("run-a")).toBe(false);
      expect(owner.hasRunExecution("run-a")).toBe(true);
      expect(owner.activeRunExecutionCount()).toBe(1);
      return "completed";
    });

    expect(result).toBe("completed");
    expect(owner.hasRunExecution("run-a")).toBe(false);
    expect(owner.activeRunExecutionCount()).toBe(0);
  });

  it("wakes a run waiting for capacity when the current owner finishes", async () => {
    const owner = new LocalExecutionLifecycle({ concurrencyLimit: (): number => 1 });
    const firstGate = deferred<undefined>();
    const first = owner.trackRun("run-a", (): Promise<undefined> => firstGate.promise);
    await Promise.resolve();

    let secondStarted = false;
    const second = owner.trackRun("run-b", async (): Promise<string> => {
      secondStarted = true;
      return "second";
    });
    await Promise.resolve();
    expect(secondStarted).toBe(false);

    firstGate.resolve(undefined);
    await first;
    expect(await second).toBe("second");
    expect(owner.activeRunExecutionCount()).toBe(0);
  });

  it("lets shutdown drain resolve after rejection and time out while work remains", async () => {
    const owner = new LocalExecutionLifecycle({ concurrencyLimit: (): number => 1 });
    const failing = deferred<undefined>();
    const trackedFailure = owner.trackExecution(failing.promise);
    const drain = owner.waitForDrain(1_000);
    failing.reject(new Error("phase failed"));

    const failureMessage = await trackedFailure.then(
      (): string => "",
      (error: unknown): string => error instanceof Error ? error.message : String(error),
    );
    expect(failureMessage).toBe("phase failed");
    expect(await drain).toBe(true);

    const pending = deferred<undefined>();
    const trackedPending = owner.trackExecution(pending.promise);
    expect(await owner.waitForDrain(1)).toBe(false);
    pending.resolve(undefined);
    await trackedPending;
    expect(await owner.waitForDrain(0)).toBe(true);
  });

  it("keeps the drain flag set after shutdown starts", () => {
    const owner = new LocalExecutionLifecycle({ concurrencyLimit: (): number => 1 });
    expect(owner.isDraining()).toBe(false);
    owner.stop();
    expect(owner.isDraining()).toBe(true);
    owner.stop();
    expect(owner.isDraining()).toBe(true);
  });
});
