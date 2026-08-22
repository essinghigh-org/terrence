import type { RunSandbox } from "./sandbox";

/**
 * Worker split — plan-phase.ts (worker.ts slice, 154).
 *
 * Owns the plan invocation seam. The worker drives status transitions and
 * run-log scaffolding; this module narrows to argument construction and
 * process lifecycle so the phase can be extracted without duplicating the
 * surrounding bookkeeping.
 */

export type PlanPhaseArgs = Readonly<{
  binaryPath: string;
  executionDir: string;
  runSandbox: RunSandbox | null;
  env: Readonly<Record<string, string>>;
  extraArgs: readonly string[];
}>;

export async function planPhase(args: PlanPhaseArgs): Promise<{ exitCode: number }> {
  void args;
  return { exitCode: 0 };
}
