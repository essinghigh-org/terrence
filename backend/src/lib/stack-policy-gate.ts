import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  policySets,
  policySetStacks,
  policySetProjects,
  policySetProjectExclusions,
  policySetTagSelectors,
} from "../db/schema";

/** No tfpolicy evaluator exists for Stack deployments. Never silently deploy a
 * Stack whose policy is configured but cannot be evaluated. */
export async function stackPolicyExecutionError(
  stack: Readonly<{ id: string; orgId: string; projectId: string | null }>,
): Promise<string | null> {
  const sets = await db.query.policySets.findMany({
    where: and(eq(policySets.orgId, stack.orgId), eq(policySets.kind, "tfpolicy")),
  });
  for (const ps of sets) {
    const [links, projects, exclusions, tags] = await Promise.all([
      db.query.policySetStacks.findMany({ where: eq(policySetStacks.policySetId, ps.id) }),
      db.query.policySetProjects.findMany({ where: eq(policySetProjects.policySetId, ps.id) }),
      db.query.policySetProjectExclusions.findMany({ where: eq(policySetProjectExclusions.policySetId, ps.id) }),
      db.query.policySetTagSelectors.findMany({ where: eq(policySetTagSelectors.policySetId, ps.id) }),
    ]);
    const link = links.find((row) => row.stackId === stack.id);
    if (link?.isExclude === true || exclusions.some((row) => row.projectId === stack.projectId)) continue;
    // Conservatively block tag-scoped policies until Stack tag selection and
    // tfpolicy execution exist; uncertainty must not become an enforcement bypass.
    if (
      ps.global ||
      link !== undefined ||
      projects.some((row) => row.projectId === stack.projectId) ||
      (ps.tagMatchLogic !== null && tags.length > 0)
    )
      return `Stack deployment blocked: tfpolicy policy set ${ps.name} (${ps.id}) cannot be evaluated because the tfpolicy runtime is not supported`;
  }
  return null;
}
