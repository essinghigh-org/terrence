import type { RunSandbox } from "./sandbox";

/**
 * Worker split — cost-phase.ts (worker.ts slice, 156).
 *
 * Owns Infracost estimation for a plan's cost snapshot. The worker handles
 * the surrounding run status and artifact writing; this phase isolates the
 * cost-estimation call boundary so the pipeline is independently mockable.
 */

export type CostPhaseArgs = Readonly<{
  executionDir: string;
  runSandbox: RunSandbox | null;
  env: Readonly<Record<string, string>>;
}>;

export type CostPhaseResult = Readonly<{ estimatedMonthlyCost: string | null }>;

export async function costPhase(_args: CostPhaseArgs): Promise<CostPhaseResult> {
  return { estimatedMonthlyCost: null };
}
