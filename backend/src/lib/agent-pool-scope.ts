import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  agentPoolAllowedProjects,
  agentPoolAllowedWorkspaces,
} from "../db/schema";
import type { agentPools } from "../db/schema";

type AgentPool = Readonly<typeof agentPools.$inferSelect>;

export async function agentPoolAllowsProject(
  pool: AgentPool,
  projectId: string,
): Promise<boolean> {
  if (pool.organizationScoped !== false) return true;
  return (await db.query.agentPoolAllowedProjects.findFirst({
    where: and(
      eq(agentPoolAllowedProjects.agentPoolId, pool.id),
      eq(agentPoolAllowedProjects.projectId, projectId),
    ),
  })) !== undefined;
}

export async function agentPoolAllowsWorkspace(
  pool: AgentPool,
  workspaceId: string,
  projectId: string | null,
): Promise<boolean> {
  if (pool.organizationScoped !== false) return true;
  const [workspaceGrant, projectGrant] = await Promise.all([
    db.query.agentPoolAllowedWorkspaces.findFirst({
      where: and(
        eq(agentPoolAllowedWorkspaces.agentPoolId, pool.id),
        eq(agentPoolAllowedWorkspaces.workspaceId, workspaceId),
      ),
    }),
    projectId === null
      ? Promise.resolve(undefined)
      : db.query.agentPoolAllowedProjects.findFirst({
          where: and(
            eq(agentPoolAllowedProjects.agentPoolId, pool.id),
            eq(agentPoolAllowedProjects.projectId, projectId),
          ),
        }),
  ]);
  return workspaceGrant !== undefined || projectGrant !== undefined;
}
