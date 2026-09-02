import { asc, eq, inArray } from "drizzle-orm";

import { db } from "../db";
import {
  variableSets,
  variableSetProjects,
  variableSetVariables,
  variableSetWorkspaces,
  workspaceVariables,
} from "../db/schema";

export type EffectiveVariable =
  | { readonly source: "workspace"; readonly variable: typeof workspaceVariables.$inferSelect }
  | { readonly source: "varset"; readonly variable: typeof variableSetVariables.$inferSelect };

/** Effective variable list for a workspace: workspace rows plus inherited
 * variable-set rows, deduplicated by category:key with the same precedence
 * the worker uses at execution time (non-priority sets, then workspace rows,
 * then priority sets). Stored rows are returned as-is — serializers null
 * sensitive values, so no decryption happens on the API path. */
export async function effectiveWorkspaceVariables(
  workspaceId: string,
  orgId: string,
  projectId: string | null,
): Promise<EffectiveVariable[]> {
  const [workspaceVars, workspaceLinks, projectLinks, orgVariableSets] = await Promise.all([
    db.query.workspaceVariables.findMany({ where: eq(workspaceVariables.workspaceId, workspaceId) }),
    db.query.variableSetWorkspaces.findMany({ where: eq(variableSetWorkspaces.workspaceId, workspaceId) }),
    projectId === null
      ? Promise.resolve([])
      : db.query.variableSetProjects.findMany({ where: eq(variableSetProjects.projectId, projectId) }),
    db.query.variableSets.findMany({
      where: eq(variableSets.orgId, orgId),
      orderBy: [asc(variableSets.name), asc(variableSets.id)],
    }),
  ]);
  const attached = new Set([
    ...workspaceLinks.map((link): string => link.variableSetId),
    ...projectLinks.map((link): string => link.variableSetId),
  ]);
  const workspaceSetIds = new Set(workspaceLinks.map((link): string => link.variableSetId));
  const projectSetIds = new Set(projectLinks.map((link): string => link.variableSetId));
  const ownedProjectSetIds = new Set(
    orgVariableSets
      .filter((set): boolean => projectId !== null && set.parentProjectId === projectId)
      .map((set): string => set.id),
  );
  const activeSets = orgVariableSets
    .filter((vs): boolean => vs.global === true || attached.has(vs.id) || ownedProjectSetIds.has(vs.id))
    .sort((left, right): number => {
      const rank = (set: { readonly id: string; readonly priority: boolean | null }): number =>
        (set.priority === true ? 10 : 0) + (workspaceSetIds.has(set.id) ? 2 : projectSetIds.has(set.id) ? 1 : 0);
      return rank(left) - rank(right)
        || right.name.localeCompare(left.name)
        || right.id.localeCompare(left.id);
    });
  const activeSetIds = activeSets.map((vs): string => vs.id);
  const prioritySetIds = new Set(
    activeSets.filter((vs): boolean => vs.priority === true).map((vs): string => vs.id),
  );
  const setVars = activeSetIds.length === 0
    ? []
    : await db.query.variableSetVariables.findMany({
      where: inArray(variableSetVariables.variableSetId, activeSetIds),
      orderBy: [asc(variableSetVariables.id)],
    });
  const setOrder = new Map(activeSets.map((set, index): [string, number] => [set.id, index]));
  const orderedSetVars = [...setVars].sort((left, right): number =>
    (setOrder.get(left.variableSetId) ?? Number.MAX_SAFE_INTEGER) - (setOrder.get(right.variableSetId) ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id));
  const effective = new Map<string, EffectiveVariable>();
  const dedupeKey = (category: string | null, key: string): string => `${category ?? ""}:${key}`;
  for (const variable of orderedSetVars) {
    if (!prioritySetIds.has(variable.variableSetId)) {
      effective.set(dedupeKey(variable.category, variable.key), { source: "varset", variable });
    }
  }
  for (const variable of workspaceVars) {
    effective.set(dedupeKey(variable.category, variable.key), { source: "workspace", variable });
  }
  for (const variable of orderedSetVars) {
    if (prioritySetIds.has(variable.variableSetId)) {
      effective.set(dedupeKey(variable.category, variable.key), { source: "varset", variable });
    }
  }
  return [...effective.values()].sort((left, right): number =>
    left.variable.key.localeCompare(right.variable.key) || left.variable.id.localeCompare(right.variable.id));
}
