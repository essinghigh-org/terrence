import { db } from "./db";
import { runs, configurationVersions, workspaces, workspaceVariables } from "./db/schema";
import { eq } from "drizzle-orm";
import { spawn } from "bun";
import { join } from "path";
import { tmpdir } from "os";
import { mkdir, rm, writeFile } from "fs/promises";

// Mock worker for MVP execution pipeline
export async function executeRun(runId: string) {
  const run = await db.query.runs.findFirst({
    where: eq(runs.id, runId)
  });

  if (!run) return;

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, run.workspaceId)
  });

  if (!workspace) return;

  // 1. Move from pending to planning
  await db.update(runs).set({ status: "planning" }).where(eq(runs.id, runId));

  try {
    // We mock execution in MVP. A real worker would extract the CV, inject env, and spawn tofu.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Update to planned
    await db.update(runs).set({ status: "planned" }).where(eq(runs.id, runId));

    if (workspace.autoApply) {
      // Move from planned to applying
      await db.update(runs).set({ status: "applying" }).where(eq(runs.id, runId));
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Update to applied
      await db.update(runs).set({ status: "applied" }).where(eq(runs.id, runId));
    }
  } catch (error) {
    console.error(`Run ${runId} failed`, error);
    await db.update(runs).set({ status: "errored" }).where(eq(runs.id, runId));
  }
}
