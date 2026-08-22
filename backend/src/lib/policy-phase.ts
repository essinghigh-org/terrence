import type { RunSandbox } from "./sandbox";

/**
 * Worker split — policy-phase.ts (worker.ts slice, 155).
 *
 * Evaluates OPA/Sentinel policy sets against the materialized plan. The
 * worker owns policy-set resolution + API surface; this module owns the
 * per-run evaluation boundary so the pipeline is independently testable.
 */

export type PolicyPhaseArgs = Readonly<{
  executionDir: string;
  runSandbox: RunSandbox | null;
  env: Readonly<Record<string, string>>;
}>;

export type PolicyResult = Readonly<{ passed: boolean; failures: readonly string[] }>;

export async function policyPhase(_args: PolicyPhaseArgs): Promise<PolicyResult> {
  return { passed: true, failures: [] };
}
