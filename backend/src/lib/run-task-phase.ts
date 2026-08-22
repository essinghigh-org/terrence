import type { RunSandbox } from "./sandbox";

/**
 * Worker split — run-task-phase.ts (worker.ts slice, 157).
 *
 * POST-plan run-task execution. The legacy worker orchestrates provider
 * callbacks and polling; this phase captures the per-task handoff contract.
 */

export type RunTaskPhaseArgs = Readonly<{
  runId: string;
  executionDir: string;
  runSandbox: RunSandbox | null;
}>;

export async function runTaskPhase(_args: RunTaskPhaseArgs): Promise<void> {}
