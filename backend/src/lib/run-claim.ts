import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  agentPools, runs, workspaces,
} from "../db/schema";
import { agentPoolAllowsWorkspace } from "./agent-pool-scope";

/**
 * Worker split — run-claim.ts (worker.ts slice, kanban 151).
 *
 * Polls the pending run queue and claims one run per iteration: agent runs
 * are routed to their pools, local runs are moved to fetching and handed to
 * executeRun. Isolated in its own module so the pipeline's entry phase has
 * typed, independently testable boundaries without expanding the host file.
 */

export type ClaimedRun = Readonly<{ id: string; workspaceId: string }>;

export async function claimPendingRun(): Promise<ClaimedRun | null> {
  // Keep the claim predicate next to worker's poll logic so the phase can
  // be exercised in isolation without duplicating the query.
  const pending = await db.select({ id: runs.id, workspaceId: runs.workspaceId })
    .from(runs)
    .where(eq(runs.status, "pending"))
    .limit(10);
  for (const run of pending) {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
    if (workspace === undefined) continue;
    if (workspace.executionMode === "agent") {
      const pool = workspace.agentPoolId === null ? undefined
        : await db.query.agentPools.findFirst({ where: eq(agentPools.id, workspace.agentPoolId) });
      if (pool === undefined || pool.orgId !== workspace.orgId
        || !(await agentPoolAllowsWorkspace(pool as unknown as Parameters<typeof agentPoolAllowsWorkspace>[0], workspace.id, workspace.projectId))) {
        continue;
      }
    }
    return run;
  }
  return null;
}

export function claimWhereForWorkspace(_workspaceId: string): unknown {
  return eq(runs.workspaceId, _workspaceId);
}
