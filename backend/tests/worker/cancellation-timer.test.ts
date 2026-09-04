import { afterEach, expect, test } from "bun:test";
import {
  cancelRunExecution,
  cancellationEscalationTimerCountForTests,
  cancellationEscalationTimerForTests,
  cancellationEscalationTimerReferencedForTests,
  clearCancellationEscalationTimersForTests,
  clearTrackedRunProcessesForTests,
  terminateActiveRunExecutions,
  trackRunProcessForTests,
} from "../../src/worker";

const runId = `cancellation-timer-${crypto.randomUUID()}`;

afterEach((): void => {
  clearCancellationEscalationTimersForTests();
  clearTrackedRunProcessesForTests();
});

test("unrefs and deduplicates escalation timers, then clears them on shutdown", (): void => {
  let killCalls = 0;
  trackRunProcessForTests(runId, {
    pid: null,
    kill: (): void => {
      killCalls += 1;
    },
    exited: new Promise<number>((resolve): void => {
      void resolve;
    }),
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
    exited: new Promise<number>((resolve): void => {
      void resolve;
    }),
  });

  cancelRunExecution(runId);
  expect(cancellationEscalationTimerCountForTests(runId)).toBe(1);

  cancelRunExecution(runId, true);
  expect(cancellationEscalationTimerCountForTests(runId)).toBe(0);
  expect(killCalls).toBe(2);
});
