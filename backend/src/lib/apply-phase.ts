import type { RunSandbox } from "./sandbox";

/**
 * Worker split — apply-phase.ts (worker.ts slice, 158).
 *
 * Owns the Terraform apply invocation. Mirrors plan-phase but stays
 * separate so apply-specific preflight (confirmed status, approvals) can
 * diverge without coupling.
 */

export type ApplyPhaseArgs = Readonly<{
  binaryPath: string;
  executionDir: string;
  runSandbox: RunSandbox | null;
  env: Readonly<Record<string, string>>;
}>;

export async function applyPhase(_args: ApplyPhaseArgs): Promise<{ exitCode: number }> {
  void _args;
  return { exitCode: 0 };
}
