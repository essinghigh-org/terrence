import { mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { RunSandbox } from "./sandbox";

/**
 * Worker split — configuration-materialization.ts (worker.ts slice, 152).
 *
 * Materializes a run's configuration: workdir creation + VCS configurationVersion
 * archive extraction. Kept as a standalone phase so apply/plan don't duplicate
 * the download + extract preamble and the path semantics can be unit-tested.
 */

export type MaterializeOptions = Readonly<{ runId: string; workspaceName: string; projectId?: string | null; orgName?: string }>;
export type MaterializeResult = Readonly<{ workDir: string; executionDir: string }>;

export async function materializeConfiguration(opts: MaterializeOptions, runSandbox: RunSandbox | null): Promise<MaterializeResult> {
  void runSandbox;
  const runId = opts.runId;
  const workDir = join(tmpdir(), "terrence", "runs", runId);
  await mkdir(join(workDir, "tmp"), { recursive: true, mode: 0o700 });
  // VCS archives are extracted by the caller after this returns; this seam
  // covers the directory creation that Landlock allow-lists per run.
  const executionDir = join(workDir, "configuration");
  await mkdir(executionDir, { recursive: true, mode: 0o700 });
  return { workDir, executionDir };
}

export async function cleanupMaterialized(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
