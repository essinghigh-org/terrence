import { and, eq, inArray } from "drizzle-orm";
import type { db } from "../db";
import {
  policySetExclusions,
  policySetProjects,
  policySetProjectExclusions,
  policySets,
  policySetTagSelectors,
  policySetWorkspaces,
  projectTags,
  workspaceTags,
  workspaces,
} from "../db/schema";

/** One scope resolver for hosted and agent execution, including inherited tags. */
export async function resolveWorkspacePolicySetIds(
  // Drizzle query clients are stateful, including transaction-bound clients.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Readonly<typeof db>,
  workspaceId: string,
  orgId: string,
): Promise<string[]> {
  const workspace = await database.query.workspaces.findFirst({
    where: and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, orgId)),
    columns: { projectId: true },
  });
  if (workspace === undefined) return [];
  const [sets, attached, projectAttached, exclusions, tags, inheritedTags, projectExclusions] = await Promise.all([
    database.query.policySets.findMany({ where: eq(policySets.orgId, orgId) }),
    database.query.policySetWorkspaces.findMany({ where: eq(policySetWorkspaces.workspaceId, workspaceId) }),
    workspace.projectId === null
      ? Promise.resolve([])
      : database.query.policySetProjects.findMany({ where: eq(policySetProjects.projectId, workspace.projectId) }),
    database.query.policySetExclusions.findMany({ where: eq(policySetExclusions.workspaceId, workspaceId) }),
    database.query.workspaceTags.findMany({ where: eq(workspaceTags.workspaceId, workspaceId) }),
    workspace.projectId === null
      ? Promise.resolve([])
      : database.query.projectTags.findMany({ where: eq(projectTags.projectId, workspace.projectId) }),
    workspace.projectId === null
      ? Promise.resolve([])
      : database.query.policySetProjectExclusions.findMany({
          where: eq(policySetProjectExclusions.projectId, workspace.projectId),
        }),
  ]);
  if (sets.length === 0) return [];
  const selectors = await database.query.policySetTagSelectors.findMany({
    where: inArray(
      policySetTagSelectors.policySetId,
      sets.map((set) => set.id),
    ),
  });
  const effectiveTags = new Map(inheritedTags.map((tag) => [tag.key, tag.value]));
  for (const tag of tags) effectiveTags.set(tag.key, tag.value);
  const explicitIds = new Set([...attached, ...projectAttached].map((link) => link.policySetId));
  // Both exclusion types override global, explicit, and tag-based selection.
  const excludedIds = new Set([...exclusions, ...projectExclusions].map((link) => link.policySetId));
  const bySet = new Map<string, typeof selectors>();
  for (const selector of selectors) {
    const current = bySet.get(selector.policySetId) ?? [];
    current.push(selector);
    bySet.set(selector.policySetId, current);
  }
  return sets
    .filter((set) => {
      if (excludedIds.has(set.id)) return false;
      const setSelectors = bySet.get(set.id) ?? [];
      const matches = (items: readonly Readonly<(typeof selectors)[number]>[]): boolean =>
        items.length > 0 &&
        (set.tagMatchLogic === "all"
          ? items.every((tag) => effectiveTags.has(tag.key) && effectiveTags.get(tag.key) === tag.value)
          : items.some((tag) => effectiveTags.has(tag.key) && effectiveTags.get(tag.key) === tag.value));
      // Explicit null disables tag-based scoping. Key-only tags match key-only
      // bindings, not arbitrary values (the provider's documented contract).
      const tagScoped = set.tagMatchLogic !== null;
      if (tagScoped && matches(setSelectors.filter((tag) => tag.isExclude))) return false;
      return (
        set.global === true ||
        explicitIds.has(set.id) ||
        (tagScoped && matches(setSelectors.filter((tag) => !tag.isExclude)))
      );
    })
    .map((set) => set.id);
}
