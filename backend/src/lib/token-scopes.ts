/**
 * Fine-grained token scopes.
 *
 * A token with a `scopes` value is fine-grained: it can only access the
 * resources listed in its scope. A token with `scopes === null` is a legacy
 * full-permission token (TFE-compatible) — it keeps its current behavior.
 *
 * Scope model (GitHub fine-grained PAT inspired):
 *
 *   orgs:        which organizations the token can touch
 *   projects:    which projects within those orgs (null = all projects)
 *   workspaces:  which workspaces within those projects (null = all)
 *   tags:        optional workspace-tag filters (key/value), matched against
 *                workspaceTags; a workspace matches if it has ANY listed tag
 *   permissions: fine-grained action grants:
 *                - "workspaces:read"   list/read workspace metadata
 *                - "workspaces:write"  create/edit/delete workspaces
 *                - "runs:read"         list/read run metadata
 *                - "runs:write"        plan/apply/queue/discard runs
 *                - "state:read"        read state versions (incl. outputs)
 *                - "state:write"       upload new state versions
 *                - "variables:read"    read workspace variable values
 *                - "variables:write"   create/edit workspace variables
 *                - "settings:read"     read organization settings
 *                - "settings:write"    modify organization settings
 *
 * Semantics:
 *  - A fine-grained token is still bound to its user (auth resolves to the
 *    user for identity), but every permission check is intersected with the
 *    scope.  The user's own organization membership must ALSO pass, so a
 *    fine-grained token can never exceed the user's underlying access.
 *  - `orgs` is REQUIRED and non-empty for a fine-grained token (a token that
 *    can touch nothing is useless).  `projects` and `workspaces` default to
 *    "all within the orgs" when omitted.
 *  - Tag filters are additive selectors, not restrictions: if the token has
 *    workspace IDs AND tag filters, the effective workspace set is the union
 *    (workspaces ∪ tag-matched workspaces) — matching GitHub's "selected
 *    repositories" semantics where selectors combine.
 */

export type WorkspacePermissionGrant =
  | "workspaces:read"
  | "workspaces:write"
  | "runs:read"
  | "runs:write"
  | "state:read"
  | "state:write"
  | "variables:read"
  | "variables:write"
  | "settings:read"
  | "settings:write";

export const ALL_PERMISSION_GRANTS: readonly WorkspacePermissionGrant[] = [
  "workspaces:read",
  "workspaces:write",
  "runs:read",
  "runs:write",
  "state:read",
  "state:write",
  "variables:read",
  "variables:write",
  "settings:read",
  "settings:write",
];

export type TokenScopeTagFilter = Readonly<{
  key: string;
  value: string;
}>;

export type TokenScopes = Readonly<{
  version: 1;
  /** Organization IDs the token may access (required, non-empty). */
  orgs: readonly string[];
  /** Project IDs within the orgs. null/omitted = all projects. */
  projects: readonly string[] | null;
  /** Workspace IDs within the projects. null/omitted = all workspaces. */
  workspaces: readonly string[] | null;
  /** Tag filters: workspace matches if it has ANY of these tags. */
  tags: readonly TokenScopeTagFilter[] | null;
  /** Action grants. Omitted = denied. */
  permissions: Readonly<Partial<Record<WorkspacePermissionGrant, boolean>>>;
}>;

const PERMISSION_KEYS = new Set<string>(ALL_PERMISSION_GRANTS);

/**
 * Parse and validate a raw scopes value (JSON string or already-parsed
 * object). Returns null when the value is absent/empty (legacy token), or
 * throws a descriptive error when the value is present but invalid.
 */
export function parseTokenScopes(raw: unknown): TokenScopes | null {
  if (raw === null || raw === undefined || raw === "") return null;

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("scopes must be valid JSON");
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("scopes must be an object");
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.version !== 1) throw new Error("scopes.version must be 1");

  const orgs = obj.orgs;
  if (!Array.isArray(orgs) || orgs.length === 0 || orgs.some((o): boolean => typeof o !== "string" || o === "")) {
    throw new Error("scopes.orgs must be a non-empty array of organization IDs");
  }

  const projects = obj.projects;
  if (projects !== null && projects !== undefined && !(Array.isArray(projects) && projects.every((p): boolean => typeof p === "string" && p !== ""))) {
    throw new Error("scopes.projects must be an array of project IDs or null");
  }

  const workspaces = obj.workspaces;
  if (workspaces !== null && workspaces !== undefined && !(Array.isArray(workspaces) && workspaces.every((w): boolean => typeof w === "string" && w !== ""))) {
    throw new Error("scopes.workspaces must be an array of workspace IDs or null");
  }

  const tags = obj.tags;
  if (tags !== null && tags !== undefined) {
    if (!Array.isArray(tags) || !tags.every((t): boolean =>
      typeof t === "object" && t !== null
      && typeof (t as Record<string, unknown>).key === "string" && (t as Record<string, unknown>).key !== ""
      && typeof (t as Record<string, unknown>).value === "string")) {
      throw new Error("scopes.tags must be an array of { key, value } objects");
    }
  }

  const permissions = obj.permissions;
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    throw new Error("scopes.permissions must be an object");
  }
  for (const [key, value] of Object.entries(permissions as Record<string, unknown>)) {
    if (!PERMISSION_KEYS.has(key)) {
      throw new Error(`scopes.permissions contains unknown permission: ${key}`);
    }
    if (typeof value !== "boolean") {
      throw new Error(`scopes.permissions.${key} must be a boolean`);
    }
  }

  const scope: TokenScopes = {
    version: 1,
    orgs: orgs as string[],
    projects: (projects as string[] | null | undefined) ?? null,
    workspaces: (workspaces as string[] | null | undefined) ?? null,
    tags: (tags as TokenScopeTagFilter[] | null | undefined) ?? null,
    permissions: permissions as Partial<Record<WorkspacePermissionGrant, boolean>>,
  };
  return scope;
}

/** Serialize a scope object for storage. */
export function serializeTokenScopes(scope: TokenScopes): string {
  return JSON.stringify(scope);
}

/** True if the scope grants the given permission. */
export function scopeGrants(scope: TokenScopes, permission: WorkspacePermissionGrant): boolean {
  return scope.permissions[permission] === true;
}

/** True if the scope covers the given organization. */
export function scopeCoversOrg(scope: TokenScopes, orgId: string): boolean {
  return scope.orgs.includes(orgId);
}

/** True if the scope covers the given project (null projects = all). */
export function scopeCoversProject(scope: TokenScopes, projectId: string | null): boolean {
  if (projectId === null) return scope.orgs.length > 0;
  if (scope.projects === null) return true;
  return scope.projects.includes(projectId);
}
