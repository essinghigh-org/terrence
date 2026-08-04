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
 *   tags:        optional workspace-tag expression, matched against
 *                workspaceTags; e.g. { combinator: "OR", rules: [
 *                  { combinator: "AND", rules: [{key:"foo",value:"bar"},
 *                                               {key:"baz",value:"bing"}] },
 *                  { key: "xyz", value: "abc" },
 *                ] } matches ((foo=bar AND baz=bing) OR xyz=abc)
 *   permissions: fine-grained action grants (see ALL_PERMISSION_GRANTS).
 *                Grants are hierarchical: some grants imply others (e.g.
 *                `settings:write` implies `policies:write`), so tokens
 *                created before a grant was split keep their access.
 *
 * Semantics:
 *  - A fine-grained token is still bound to its user (auth resolves to the
 *    user for identity), but every permission check is intersected with the
 *    scope.  The user's own organization membership must ALSO pass, so a
 *    fine-grained token can never exceed the user's underlying access.
 *  - `orgs` is REQUIRED and non-empty for a fine-grained token (a token that
 *    can touch nothing is useless).  `projects` and `workspaces` default to
 *    "all within the orgs" when omitted.
 *  - Selectors are additive, not restrictive: if the token has workspace IDs
 *    AND a tag expression, the effective workspace set is the union
 *    (workspaces ∪ tag-matched workspaces) — matching GitHub's "selected
 *    repositories" semantics where selectors combine.
 */

export type WorkspacePermissionGrant =
  // Workspaces
  | "workspaces:read"
  | "workspaces:write"
  | "workspaces:lock"
  // Runs
  | "runs:read"
  | "runs:write" // legacy catch-all: implies plan/apply/discard/cancel
  | "runs:plan"
  | "runs:apply"
  | "runs:discard"
  | "runs:cancel"
  | "runs:policy-override"
  // Run tasks
  | "run-tasks:read"
  | "run-tasks:write"
  // Variables
  | "variables:read"
  | "variables:write"
  // State
  | "state:read"
  | "state:write"
  // Organization settings (legacy catch-alls)
  | "settings:read"
  | "settings:write"
  // Policies
  | "policies:read"
  | "policies:write"
  // VCS settings (incl. SSH keys and OAuth clients)
  | "vcs:read"
  | "vcs:write"
  // Agent pools
  | "agent-pools:read"
  | "agent-pools:write"
  // Registry (modules + providers)
  | "registry:read"
  | "registry:write"
  // Projects
  | "projects:read"
  | "projects:write"
  // Teams
  | "teams:read"
  | "teams:write"
  // Organization membership
  | "members:read"
  | "members:write"
  // Variable sets
  | "varsets:read"
  | "varsets:write"
  // Audit logs
  | "audit-logs:read";

/**
 * Grants that imply other grants. Kept deliberately small: legacy catch-all
 * grants (settings:read/write, runs:write, workspaces:write) imply the
 * fine-grained grants they were split into, so tokens created before the
 * split keep exactly the access they had. Write grants imply their read
 * counterparts.
 */
const GRANT_IMPLICATIONS: Readonly<Record<WorkspacePermissionGrant, readonly WorkspacePermissionGrant[]>> = {
  "workspaces:read": [],
  "workspaces:write": ["workspaces:read", "workspaces:lock"],
  "workspaces:lock": [],
  "runs:read": [],
  "runs:write": ["runs:read", "runs:plan", "runs:apply", "runs:discard", "runs:cancel"],
  "runs:plan": ["runs:read"],
  // Deliberately narrow: apply lets a token finish a run it planned, but
  // terminating runs it did not start (discard/cancel) is a separate decision
  // and requires its own explicit grant.
  "runs:apply": ["runs:read"],
  "runs:discard": [],
  "runs:cancel": [],
  "runs:policy-override": [],
  "run-tasks:read": [],
  "run-tasks:write": ["run-tasks:read"],
  "variables:read": [],
  "variables:write": ["variables:read"],
  "state:read": [],
  "state:write": ["state:read"],
  "settings:read": [
    "policies:read",
    "vcs:read",
    "agent-pools:read",
    "registry:read",
    "projects:read",
    "teams:read",
    "members:read",
    "varsets:read",
    "audit-logs:read",
    "run-tasks:read",
  ],
  "settings:write": [
    "settings:read",
    "policies:write",
    "vcs:write",
    "agent-pools:write",
    "registry:write",
    "projects:write",
    "teams:write",
    "members:write",
    "varsets:write",
    "run-tasks:write",
    "runs:policy-override",
  ],
  "policies:read": [],
  "policies:write": ["policies:read"],
  "vcs:read": [],
  "vcs:write": ["vcs:read"],
  "agent-pools:read": [],
  "agent-pools:write": ["agent-pools:read"],
  "registry:read": [],
  "registry:write": ["registry:read"],
  "projects:read": [],
  "projects:write": ["projects:read"],
  "teams:read": [],
  "teams:write": ["teams:read", "members:read"],
  "members:read": [],
  "members:write": ["members:read"],
  "varsets:read": [],
  "varsets:write": ["varsets:read"],
  "audit-logs:read": [],
};

const ALL_PERMISSION_GRANTS: readonly WorkspacePermissionGrant[] = Object.keys(
  GRANT_IMPLICATIONS,
) as WorkspacePermissionGrant[];

type TokenScopeTagFilter = Readonly<{
  key: string;
  value: string;
}>;

/**
 * A tag rule: either a single key=value filter or a group of rules combined
 * with AND or OR. Groups may nest arbitrarily, so rules like
 * `(foo=bar AND baz=bing) OR xyz=abc` are directly representable.
 */
type TokenScopeTagRule =
  | TokenScopeTagFilter
  | Readonly<{ combinator: "AND" | "OR"; rules: readonly TokenScopeTagRule[] }>;

/** A tag expression: a tree of rules with an explicit root combinator. */
export type TokenScopeTags = Readonly<{
  combinator: "AND" | "OR";
  rules: readonly TokenScopeTagRule[];
}>;

export type TokenScopes = Readonly<{
  version: 1;
  /** Organization IDs the token may access (required, non-empty). */
  orgs: readonly string[];
  /** Project IDs within the orgs. null/omitted = all projects. */
  projects: readonly string[] | null;
  /** Workspace IDs within the projects. null/omitted = all workspaces. */
  workspaces: readonly string[] | null;
  /**
   * Tag expression: a workspace matches when the expression evaluates to
   * true against its tags. null/omitted = no tag restriction.
   */
  tags: TokenScopeTags | null;
  /** Action grants. Omitted = denied. */
  permissions: Readonly<Partial<Record<WorkspacePermissionGrant, boolean>>>;
}>;

const PERMISSION_KEYS = new Set<string>(ALL_PERMISSION_GRANTS);

function isTagFilter(value: unknown): value is TokenScopeTagFilter {
  return typeof value === "object" && value !== null
    && typeof (value as Record<string, unknown>).key === "string" && (value as Record<string, unknown>).key !== ""
    && typeof (value as Record<string, unknown>).value === "string";
}

function isCombinator(value: unknown): value is "AND" | "OR" {
  return value === "AND" || value === "OR";
}

/** Maximum nesting depth of a tag rule tree (attacker-controlled input). */
export const MAX_TAG_RULE_DEPTH = 16;

/**
 * Normalize a single tag rule (leaf or group) with validation. `depth` caps
 * nesting so a crafted scopes payload cannot blow the stack during parse or
 * on every later auth check that recurses the stored tree.
 */
function parseTagRule(raw: unknown, path: string, depth = 0): TokenScopeTagRule {
  if (depth > MAX_TAG_RULE_DEPTH) throw new Error(`${path} exceeds maximum nesting depth`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path} must be a tag filter or a rule group`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.combinator !== undefined) {
    if (!isCombinator(obj.combinator)) throw new Error(`${path}.combinator must be "AND" or "OR"`);
    if (!Array.isArray(obj.rules)) throw new Error(`${path}.rules must be an array`);
    if (obj.rules.length === 0) throw new Error(`${path}.rules must contain at least one rule`);
    return {
      combinator: obj.combinator,
      rules: obj.rules.map((rule: unknown, index: number): TokenScopeTagRule => parseTagRule(rule, `${path}.rules[${index}]`, depth + 1)),
    };
  }
  if (!isTagFilter(obj)) {
    throw new Error(`${path} must be { key, value } or { combinator, rules }`);
  }
  return { key: obj.key, value: obj.value };
}

/**
 * Normalize a raw `tags` value (old array shape or new expression shape).
 * The legacy array form maps an empty list to null (no tag restriction):
 * stored `tags: []` meant "any workspace", and an empty OR group would
 * otherwise silently match no workspaces at all. An explicit expression
 * object with no rules is rejected instead of failing open: `null` means
 * "unrestricted", so accepting it would silently widen the token to every
 * workspace in scope.
 */
function parseTagExpression(raw: unknown): TokenScopeTags | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    // Backward-compatible: `[{ key, value }]` = OR of the listed tags.
    if (raw.length === 0) return null;
    return {
      combinator: "OR",
      rules: raw.map((rule: unknown, index: number): TokenScopeTagRule => parseTagRule(rule, `scopes.tags[${index}]`)),
    };
  }
  if (typeof raw !== "object") throw new Error("scopes.tags must be an object or an array");
  const obj = raw as Record<string, unknown>;
  if (!isCombinator(obj.combinator)) throw new Error('scopes.tags.combinator must be "AND" or "OR"');
  if (!Array.isArray(obj.rules)) throw new Error("scopes.tags.rules must be an array");
  if (obj.rules.length === 0) throw new Error("scopes.tags.rules must contain at least one rule");
  return {
    combinator: obj.combinator,
    rules: obj.rules.map((rule: unknown, index: number): TokenScopeTagRule => parseTagRule(rule, `scopes.tags.rules[${index}]`)),
  };
}

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

  const tags = parseTagExpression(obj.tags);

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
    tags,
    permissions: permissions,
  };
  return scope;
}

/**
 * True if the scope grants the given permission. Honors grant implications:
 * a granted catch-all grant (e.g. `settings:write`) counts for the
 * fine-grained grants it was split into (e.g. `policies:write`), so tokens
 * created before a split keep their access.
 */
export function scopeGrants(scope: TokenScopes, permission: WorkspacePermissionGrant): boolean {
  for (const granted of Object.keys(scope.permissions) as WorkspacePermissionGrant[]) {
    if (scope.permissions[granted] !== true) continue;
    if (granted === permission) return true;
    if (grantImplies(granted, permission)) return true;
  }
  return false;
}

/** True if `grant` (directly or transitively) implies `candidate`. */
function grantImplies(grant: WorkspacePermissionGrant, candidate: WorkspacePermissionGrant): boolean {
  const queue = [...(GRANT_IMPLICATIONS[grant] ?? [])];
  const seen = new Set<WorkspacePermissionGrant>([grant]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (current === candidate) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(GRANT_IMPLICATIONS[current] ?? []));
  }
  return false;
}

/** True if the scope covers the given organization. */
export function scopeCoversOrg(scope: TokenScopes, orgId: string): boolean {
  return scope.orgs.includes(orgId);
}

/**
 * Evaluate a tag rule against a workspace's tags (as "key=value" strings).
 * A leaf matches when the tag is present; a group matches when its rules
 * combine to true under its combinator (AND = all, OR = any).
 */
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- recursive readonly alias is flagged; the type is already immutable.
function evaluateTagRule(rule: TokenScopeTagRule, tags: ReadonlySet<string>): boolean {
  if ("combinator" in rule) {
    return rule.combinator === "AND"
      ? rule.rules.every((child): boolean => evaluateTagRule(child, tags))
      : rule.rules.some((child): boolean => evaluateTagRule(child, tags));
  }
  return tags.has(`${rule.key}=${rule.value}`);
}

/** Evaluate a tag expression against a workspace's tags. */
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- recursive readonly alias is flagged; the type is already immutable.
export function evaluateTagExpression(expression: TokenScopeTags, tags: ReadonlySet<string>): boolean {
  return expression.combinator === "AND"
    ? expression.rules.every((rule): boolean => evaluateTagRule(rule, tags))
    : expression.rules.some((rule): boolean => evaluateTagRule(rule, tags));
}
