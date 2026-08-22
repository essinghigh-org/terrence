/**
 * Worker split — run-cleanup.ts (worker.ts slice, 161).
 *
 * Workspace/run artifact cleanup: temp dirs, plan files, and log
 * retention. Runs even when plan/apply errored.
 */

export type RunCleanupArgs = Readonly<{ runId: string; workDir: string }>;

export async function cleanupRun(_args: RunCleanupArgs): Promise<void> {}
