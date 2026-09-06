type VariableSet = Readonly<{
  id: string;
  name: string;
  priority: boolean | null;
  global: boolean | null;
  parentProjectId: string | null;
}>;

// Low to high; callers overlay later entries. HCP's priority order reverses
// scope AND ownership. https://developer.hashicorp.com/terraform/cloud-docs/variables#precedence
const scopeRank = { global: 0, organizationProject: 1, organizationWorkspace: 2, projectProject: 3, projectWorkspace: 4 };

export function compareVariableSets(
  left: VariableSet,
  right: VariableSet,
  workspaceSetIds: ReadonlySet<string>,
  projectSetIds: ReadonlySet<string>,
): number {
  const rank = (set: VariableSet): number => {
    const projectScope = !workspaceSetIds.has(set.id) || (set.priority === true && projectSetIds.has(set.id));
    const scope = set.global === true ? "global"
      : set.parentProjectId === null ? (projectScope ? "organizationProject" : "organizationWorkspace")
      : (projectScope ? "projectProject" : "projectWorkspace");
    const ordinary = scopeRank[scope];
    return set.priority === true ? 10 - ordinary : ordinary;
  };
  // UTF-8 byte ordering matches Unicode code-point ordering, unlike localeCompare
  // or UTF-16 string comparison for supplementary characters.
  return rank(left) - rank(right)
    || compareCodePoints(right.name, left.name)
    || compareCodePoints(right.id, left.id);
}

/**
 * Deterministic code-point string comparison (issue #704). UTF-8 byte
 * ordering matches Unicode code-point ordering on every host, unlike
 * localeCompare, whose result depends on the runtime locale. Use this for
 * every precedence tie-break so workers, the agent payload and the UI
 * agree regardless of host locale.
 */
export function compareCodePoints(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
