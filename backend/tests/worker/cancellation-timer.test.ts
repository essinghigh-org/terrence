import { afterEach, expect, spyOn, test } from "bun:test";
import {
  cancelRunExecution,
  cancellationEscalationTimerCountForTests,
  cancellationEscalationTimerForTests,
  cancellationEscalationTimerReferencedForTests,
  clearCancellationEscalationTimersForTests,
  clearRunWorkDirCleanupTimersForTests,
  clearTrackedRunProcessesForTests,
  runWorkDirCleanupTimerCountForTests,
  scheduleRunWorkDirCleanup,
  terminateActiveRunExecutions,
  trackRunProcessForTests,
} from "../../src/worker";

const runId = `cancellation-timer-${crypto.randomUUID()}`;

afterEach((): void => {
  clearCancellationEscalationTimersForTests();
  clearRunWorkDirCleanupTimersForTests();
  clearTrackedRunProcessesForTests();
});

test("unrefs and deduplicates escalation timers, then clears them on shutdown", (): void => {
  let killCalls = 0;
  trackRunProcessForTests(runId, {
    pid: null,
    kill: (): void => {
      killCalls += 1;
    },
    exited: new Promise<number>(() => undefined),
  });

  cancelRunExecution(runId);
  const firstTimer = cancellationEscalationTimerForTests(runId);
  expect(firstTimer).toBeDefined();
  expect(cancellationEscalationTimerCountForTests(runId)).toBe(1);
  expect(cancellationEscalationTimerReferencedForTests(runId)).toBe(false);

  cancelRunExecution(runId);
  expect(cancellationEscalationTimerCountForTests(runId)).toBe(1);
  expect(cancellationEscalationTimerForTests(runId)).toBe(firstTimer);

  terminateActiveRunExecutions();
  expect(cancellationEscalationTimerCountForTests(runId)).toBe(0);
  expect(killCalls).toBe(3);
});

test("force cancellation clears the escalation timer", (): void => {
  let killCalls = 0;
  trackRunProcessForTests(runId, {
    pid: null,
    kill: (): void => {
      killCalls += 1;
    },
    exited: new Promise<number>(() => undefined),
  });

  cancelRunExecution(runId);
  expect(cancellationEscalationTimerCountForTests(runId)).toBe(1);

  cancelRunExecution(runId, true);
  expect(cancellationEscalationTimerCountForTests(runId)).toBe(0);
  expect(killCalls).toBe(2);
});

test("deduplicates delayed workdir cleanup retries", (): void => {
  const cleanupRunId = `${runId}-workdir`;
  scheduleRunWorkDirCleanup(cleanupRunId, 60_000);
  scheduleRunWorkDirCleanup(cleanupRunId, 60_000);
  expect(runWorkDirCleanupTimerCountForTests(cleanupRunId)).toBe(1);
});

test("force cancellation and shutdown retain termination of pending groups after leader exit", async (): Promise<void> => {
  const signals: unknown[][] = [];
  const signalSpy = spyOn(process, "kill").mockImplementation((...args): true => {
    signals.push(args);
    return true;
  });
  try {
    for (const shutdown of [false, true]) {
      let finish!: (code: number) => void;
      const exited = new Promise<number>((resolve) => {
        finish = resolve;
      });
      let leaderSignals = 0;
      trackRunProcessForTests(runId, {
        pid: 123456,
        kill: (): void => {
          leaderSignals += 1;
        },
        exited,
      });
      cancelRunExecution(runId);
      finish(0);
      await exited;
      await Promise.resolve();
      signals.length = 0;
      if (shutdown) terminateActiveRunExecutions();
      else cancelRunExecution(runId, true);
      expect(signals).toEqual([[-123456, "SIGKILL"]]);
      expect(leaderSignals).toBe(1);
      expect(cancellationEscalationTimerCountForTests(runId)).toBe(0);
    }
  } finally {
    signalSpy.mockRestore();
  }
});
