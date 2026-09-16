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
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Set has no rule-verifiable readonly form; the allow-lists are only read here
  allowedWorkspaceIds?: ReadonlySet<string>,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Set has no rule-verifiable readonly form; the allow-lists are only read here
  allowedProjectIds?: ReadonlySet<string>,
): Promise<boolean> {
  if (pool.organizationScoped !== false) return true;
  if (allowedWorkspaceIds !== undefined && allowedProjectIds !== undefined) {
    return allowedWorkspaceIds.has(workspaceId)
      || (projectId !== null && allowedProjectIds.has(projectId));
  }
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
