import { spawn as bunSpawn } from "bun";
import { exists } from "fs/promises";
import { RunSandbox } from "./sandbox";

/**
 * Worker split — terraform-init.ts (worker.ts slice, 153).
 *
 * Runs `tofu/terraform init` inside the execution directory. The binary
 * path is resolved by the worker before this phase; this module only
 * owns the invocation + retry semantics so plan/apply don't duplicate
 * the preamble.
 */

export type InitResult = Readonly<{ exitCode: number; durationMs: number }>;

export async function terraformInit(
  binaryPath: string,
  executionDir: string,
  runSandbox: RunSandbox | null,
  env: Readonly<Record<string, string>>,
): Promise<InitResult> {
  const startedAt = Date.now();
  if (!(await exists(executionDir))) {
    return { exitCode: 1, durationMs: Date.now() - startedAt };
  }
  const args = [binaryPath, "init", "-no-color", "-input=false"];
  const proc = runSandbox !== null
    ? runSandbox.spawn(args, { cwd: executionDir, env })
    : bunSpawn(args, { cwd: executionDir, env, stdout: "pipe", stderr: "pipe", detached: true });
  const exitCode = await (proc.exited as Promise<number>);
  return { exitCode, durationMs: Date.now() - startedAt };
}
