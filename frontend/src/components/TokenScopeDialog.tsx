import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { toast } from "../components/ui/toast";

/**
 * Permission grants offered in the fine-grained scope picker. Each maps to a
 * `permissions` key in the token scope. Write grants do NOT imply their read
 * counterpart in the picker (selectors are explicit), matching the backend's
 * grant model.
 */
const PERMISSION_GROUPS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly grants: ReadonlyArray<{ readonly key: string; readonly label: string }>;
}> = [
  {
    id: "workspaces",
    label: "Workspaces",
    grants: [
      { key: "workspaces:read", label: "Read workspace metadata and settings" },
      { key: "workspaces:write", label: "Create / edit / delete workspaces" },
      { key: "workspaces:lock", label: "Lock and unlock workspaces" },
    ],
  },
  {
    id: "runs",
    label: "Runs",
    grants: [
      { key: "runs:read", label: "Read run history, plans, and logs" },
      { key: "runs:plan", label: "Create runs and start plans" },
      { key: "runs:apply", label: "Apply plans (also allows discarding and canceling runs)" },
      { key: "runs:discard", label: "Discard pending runs" },
      { key: "runs:cancel", label: "Cancel running runs" },
      { key: "runs:policy-override", label: "Override policy checks" },
      { key: "runs:write", label: "All run actions (legacy catch-all)" },
    ],
  },
  {
    id: "run-tasks",
    label: "Run tasks",
    grants: [
      { key: "run-tasks:read", label: "Read run tasks" },
      { key: "run-tasks:write", label: "Create and edit run tasks" },
    ],
  },
  {
    id: "variables",
    label: "Variables",
    grants: [
      { key: "variables:read", label: "Read workspace variable values" },
      { key: "variables:write", label: "Create and edit workspace variables" },
    ],
  },
  {
    id: "state",
    label: "State",
    grants: [
      { key: "state:read", label: "Read state versions and outputs" },
      { key: "state:write", label: "Upload new state versions" },
    ],
  },
  {
    id: "projects",
    label: "Projects",
    grants: [
      { key: "projects:read", label: "Read projects" },
      { key: "projects:write", label: "Create and edit projects" },
    ],
  },
  {
    id: "varsets",
    label: "Variable sets",
    grants: [
      { key: "varsets:read", label: "Read variable sets" },
      { key: "varsets:write", label: "Create and edit variable sets" },
    ],
  },
  {
    id: "settings",
    label: "Organization settings",
    grants: [
      { key: "settings:read", label: "Read organization settings" },
      { key: "settings:write", label: "Modify organization settings" },
    ],
  },
  {
    id: "policies",
    label: "Policy sets",
    grants: [
      { key: "policies:read", label: "Read policy sets" },
      { key: "policies:write", label: "Create and edit policy sets" },
    ],
  },
  {
    id: "vcs",
    label: "VCS settings, SSH keys, OAuth clients",
    grants: [
      { key: "vcs:read", label: "Read VCS settings, SSH keys, and OAuth clients" },
      { key: "vcs:write", label: "Manage VCS settings, SSH keys, and OAuth clients" },
    ],
  },
  {
    id: "agent-pools",
    label: "Agent pools",
    grants: [
      { key: "agent-pools:read", label: "Read agent pools" },
      { key: "agent-pools:write", label: "Create and edit agent pools" },
    ],
  },
  {
    id: "registry",
    label: "Registry (modules and providers)",
    grants: [
      { key: "registry:read", label: "Read modules and providers" },
      { key: "registry:write", label: "Publish and manage modules and providers" },
    ],
  },
  {
    id: "teams",
    label: "Teams",
    grants: [
      { key: "teams:read", label: "Read teams and team members" },
      { key: "teams:write", label: "Create and edit teams" },
    ],
  },
  {
    id: "members",
    label: "Organization membership",
    grants: [
      { key: "members:read", label: "Read organization members" },
      { key: "members:write", label: "Manage organization membership" },
    ],
  },
  {
    id: "audit-logs",
    label: "Audit logs",
    grants: [
      { key: "audit-logs:read", label: "Read organization audit logs" },
    ],
  },
];

/** A single key=value tag filter. */
type TagFilterNode = Readonly<{ kind: "filter"; key: string; value: string }>;
/** A group of rules combined with AND or OR. */
type TagGroupNode = Readonly<{ kind: "group"; combinator: "AND" | "OR"; rules: TagRuleNode[] }>;
type TagRuleNode = TagFilterNode | TagGroupNode;

/** Initial builder state: one empty filter row. */
function emptyGroup(): TagGroupNode {
  return { kind: "group", combinator: "OR", rules: [{ kind: "filter", key: "", value: "" }] };
}

/** Serialize the builder tree into the backend's scope `tags` shape. */
function serializeTags(root: TagGroupNode): { combinator: "AND" | "OR"; rules: unknown[] } | null {
  const convert = (node: TagRuleNode): unknown => {
    if (node.kind === "filter") return { key: node.key, value: node.value };
    return { combinator: node.combinator, rules: node.rules.map(convert) };
  };
  const rules = root.rules.filter((rule): boolean =>
    rule.kind === "group"
      ? rule.rules.length > 0 && serializeTags(rule) !== null
      : rule.key.trim() !== "");
  if (rules.length === 0) return null;
  return { combinator: root.combinator, rules: rules.map(convert) };
}

/** Render a node as a human-readable expression like "(foo=bar AND baz=bing)". */
function tagLabel(node: TagRuleNode): string {
  if (node.kind === "filter") return `${node.key}=${node.value}`;
  const inner = node.rules.map(tagLabel).join(` ${node.combinator} `);
  return `(${inner})`;
}

function rootLabel(root: TagGroupNode): string {
  if (root.rules.length === 0) return "";
  return root.rules.map(tagLabel).join(` ${root.combinator} `);
}

type OrgOption = Readonly<{ id: string; name: string }>;
type ProjectOption = Readonly<{ id: string; name: string }>;
type WorkspaceOption = Readonly<{ id: string; name: string }>;

/** Extract an `id` + `name` pair from a JSON:API resource item. */
function resourceOptions<T extends { id: string; attributes?: Record<string, unknown> }>(
  data: T[],
  nameKey = "name",
): Array<{ id: string; name: string }> {
  return data.map((item): { id: string; name: string } => {
    const attributes = (item.attributes ?? {}) as Record<string, unknown>;
    const rawName = attributes[nameKey];
    return { id: item.id, name: typeof rawName === "string" ? rawName : item.id };
  });
}

export function TokenScopeDialog({
  open,
  onOpenChange,
  onCreated,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (token: { id: string; attributes: Record<string, unknown> }) => void;
}>): React.JSX.Element {
  const [description, setDescription] = useState("");
  const [fineGrained, setFineGrained] = useState(false);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [orgId, setOrgId] = useState("");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [selectedWorkspaces, setSelectedWorkspaces] = useState<Set<string>>(new Set());
  const [tagTree, setTagTree] = useState<TagGroupNode>(emptyGroup);
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Load organizations when the dialog opens. The org resource exposes the
  // DB id under attributes["external-id"] and its name under attributes.name;
  // the JSON:API `id` is just the (URL-encoded) name.
  useEffect((): void => {
    if (!open) return;
    setError("");
    void fetchApi("/organizations?page[size]=100").then((response: unknown): void => {
      const data = (response as { data?: Array<{ id: string; attributes?: Record<string, unknown> }> }).data ?? [];
      const parsed = data
        .map((item): OrgOption => ({
          id: typeof item.attributes?.["external-id"] === "string" ? item.attributes["external-id"] : item.id,
          name: typeof item.attributes?.["name"] === "string" ? item.attributes["name"] : item.id,
        }))
        .sort((a, b): number => a.name.localeCompare(b.name));
      setOrgs(parsed);
      if (parsed.length > 0 && orgId === "") setOrgId(parsed[0]?.id ?? "");
    }).catch(() => { setError("Could not load organizations"); });
  }, [open]);

  // Load projects + workspaces for the selected org. The org name (not id) is
  // used in the URL path.
  useEffect((): void => {
    if (!open || orgId === "") { setProjects([]); setWorkspaces([]); return; }
    const orgName = orgs.find((o): boolean => o.id === orgId)?.name ?? orgId;
    setProjects([]);
    setWorkspaces([]);
    void fetchApi(`/organizations/${encodeURIComponent(orgName)}/projects?page[size]=100`).then((response: unknown): void => {
      const data = (response as { data?: Array<{ id: string; attributes?: Record<string, unknown> }> }).data ?? [];
      setProjects(resourceOptions(data));
    }).catch(() => { /* org may not expose projects */ });
    void fetchApi(`/organizations/${encodeURIComponent(orgName)}/workspaces?page[size]=100`).then((response: unknown): void => {
      const data = (response as { data?: Array<{ id: string; attributes?: Record<string, unknown> }> }).data ?? [];
      setWorkspaces(resourceOptions(data));
    }).catch(() => { /* workspaces may not be listable */ });
  }, [open, orgId, orgs]);

  const toggleProject = (id: string): void => {
    setSelectedProjects((prev): Set<string> => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleWorkspace = (id: string): void => {
    setSelectedWorkspaces((prev): Set<string> => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleGrant = (key: string): void => {
    setGranted((prev): Record<string, boolean> => ({ ...prev, [key]: !prev[key] }));
  };

  // --- Tag rule builder mutations (immutable tree updates) ---
  const updateRule = (path: readonly number[], mutate: (rule: TagRuleNode) => TagRuleNode): void => {
    setTagTree((root): TagGroupNode => {
      const updateAt = (rules: TagRuleNode[], rest: readonly number[]): TagRuleNode[] => {
        if (rest.length === 0) return rules.map(mutate);
        const head = rest[0] as number;
        return rules.map((rule, i): TagRuleNode => {
          if (i !== head) return rule;
          if (rest.length === 1) return mutate(rule);
          if (rule.kind !== "group") return rule;
          return { ...rule, rules: updateAt(rule.rules, rest.slice(1)) };
        });
      };
      return { ...root, rules: updateAt(root.rules, path) };
    });
  };

  const appendRule = (path: readonly number[], node: TagRuleNode): void => {
    setTagTree((root): TagGroupNode => {
      const appendAt = (rules: TagRuleNode[], rest: readonly number[]): TagRuleNode[] => {
        if (rest.length === 0) return [...rules, node];
        const head = rest[0] as number;
        return rules.map((rule, i): TagRuleNode => {
          if (i !== head || rule.kind !== "group") return rule;
          return { ...rule, rules: appendAt(rule.rules, rest.slice(1)) };
        });
      };
      return { ...root, rules: appendAt(root.rules, path) };
    });
  };

  const removeRule = (path: readonly number[]): void => {
    setTagTree((root): TagGroupNode => {
      const removeAt = (rules: TagRuleNode[], rest: readonly number[]): TagRuleNode[] => {
        if (rest.length === 0) return rules;
        const head = rest[0] as number;
        if (rest.length === 1) return rules.filter((_, i): boolean => i !== head);
        return rules.map((rule, i): TagRuleNode => {
          if (i !== head || rule.kind !== "group") return rule;
          return { ...rule, rules: removeAt(rule.rules, rest.slice(1)) };
        });
      };
      return { ...root, rules: removeAt(root.rules, path) };
    });
  };

  const setFilterValue = (path: readonly number[], key: string, value: string): void => {
    updateRule(path, (rule): TagRuleNode =>
      rule.kind === "filter" ? { kind: "filter", key, value } : rule);
  };

  const setCombinator = (path: readonly number[], combinator: "AND" | "OR"): void => {
    updateRule(path, (rule): TagRuleNode =>
      rule.kind === "group" ? { ...rule, combinator } : rule);
  };

  const wrapRule = (path: readonly number[]): void => {
    updateRule(path, (rule): TagRuleNode => ({ kind: "group", combinator: "OR", rules: [rule] }));
  };

  const addFilter = (path: readonly number[]): void => {
    appendRule(path, { kind: "filter", key: "", value: "" });
  };

  const addGroup = (path: readonly number[]): void => {
    appendRule(path, emptyGroup());
  };

  const reset = (): void => {
    setDescription("");
    setFineGrained(false);
    setOrgId("");
    setSelectedProjects(new Set());
    setSelectedWorkspaces(new Set());
    setTagTree(emptyGroup());
    setGranted({});
    setError("");
  };

  const create = async (): Promise<void> => {
    setSaving(true);
    setError("");
    try {
      const attributes: Record<string, unknown> = { description: description.trim() === "" ? "API token" : description.trim() };
      if (fineGrained) {
        if (orgId === "") throw new Error("Select an organization");
        const tags = serializeTags(tagTree);
        const scopes = {
          version: 1,
          orgs: [orgId],
          projects: selectedProjects.size > 0 ? [...selectedProjects] : null,
          workspaces: selectedWorkspaces.size > 0 ? [...selectedWorkspaces] : null,
          tags,
          permissions: Object.fromEntries(Object.entries(granted).filter(([, v]): boolean => v)),
        };
        attributes["scopes"] = scopes;
      }
      const created = await fetchApi("/tokens", {
        method: "POST",
        body: JSON.stringify({ data: { attributes } }),
      }) as { data: { id: string; attributes: Record<string, unknown> } };
      onCreated(created.data);
      onOpenChange(false);
      reset();
      toast.add({
        title: fineGrained ? "Fine-grained token created" : "Token created",
        type: "success",
      });
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to create token");
    } finally {
      setSaving(false);
    }
  };

  const rootPath: readonly number[] = [];
  const renderRuleRow = (node: TagRuleNode, path: readonly number[]): React.JSX.Element => {
    if (node.kind === "filter") {
      return (
        <div className="flex items-center gap-2">
          <Input
            aria-label="Tag key"
            placeholder="key (e.g. environment)"
            value={node.key}
            onInput={(e: React.SyntheticEvent<HTMLInputElement>): void => { setFilterValue(path, e.currentTarget.value, node.value); }}
            className="h-9"
          />
          <Input
            aria-label="Tag value"
            placeholder="value (e.g. production)"
            value={node.value}
            onInput={(e: React.SyntheticEvent<HTMLInputElement>): void => { setFilterValue(path, node.key, e.currentTarget.value); }}
            className="h-9"
          />
          <Button type="button" variant="outline" size="sm" onClick={(): void => { wrapRule(path); }} title="Wrap this condition into a group">group</Button>
          <Button type="button" variant="ghost" size="sm" onClick={(): void => { removeRule(path); }} title="Remove">✕</Button>
        </div>
      );
    }
    const isRoot = path.length === 0;
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          {!isRoot && <span className="text-muted-foreground">(</span>}
          <select
            aria-label="Combine with"
            className="h-8 rounded-md border border-gray-300 bg-white px-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            value={node.combinator}
            onChange={(e): void => { setCombinator(path, e.target.value as "AND" | "OR"); }}
          >
            <option value="AND">AND</option>
            <option value="OR">OR</option>
          </select>
          <span className="text-sm text-muted-foreground">{isRoot ? "of the conditions match" : "conditions match"}</span>
          <Button type="button" variant="outline" size="sm" onClick={(): void => { addFilter(path); }}>Add condition</Button>
          <Button type="button" variant="outline" size="sm" onClick={(): void => { addGroup(path); }}>Add group</Button>
          {!isRoot && <Button type="button" variant="ghost" size="sm" onClick={(): void => { removeRule(path); }}>✕</Button>}
        </div>
        <div className="space-y-1.5 border-l border-gray-200 pl-3">
          {node.rules.map((child, index): React.JSX.Element => (
            <div key={index} className="space-y-1.5">
              {renderRuleRow(child, [...path, index])}
            </div>
          ))}
        </div>
        {!isRoot && <span className="text-muted-foreground">)</span>}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next: boolean): void => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create API token</DialogTitle>
          <DialogDescription>
            Fine-grained tokens can be scoped to specific organizations, projects,
            workspaces, and tag-matching workspaces, with per-action permission grants.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div className="space-y-1.5">
            <label htmlFor="token-desc" className="text-sm font-medium">Description</label>
            <Input id="token-desc" value={description} onInput={(e: React.SyntheticEvent<HTMLInputElement>): void => { setDescription(e.currentTarget.value); }} placeholder="e.g. CI/CD deploy token" />
          </div>

          <label className="flex items-center gap-3 text-sm font-medium">
            <Checkbox checked={fineGrained} onCheckedChange={(v: boolean): void => { setFineGrained(v); }} />
            <span>
              Fine-grained
              <span className="block text-[13px] font-normal text-muted-foreground mt-0.5">
                Restrict this token to selected resources and permissions. Legacy tokens have full access.
              </span>
            </span>
          </label>

          {fineGrained && (
            <>
              <div className="space-y-1.5">
                <label htmlFor="token-org" className="text-sm font-medium">Organization</label>
                <select
                  id="token-org"
                  className="flex h-9 w-full rounded-md border border-gray-300 bg-white px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                  value={orgId}
                  onChange={(e): void => { setOrgId(e.target.value); setSelectedProjects(new Set()); setSelectedWorkspaces(new Set()); }}
                >
                  {orgs.map((org): React.JSX.Element => (
                    <option key={org.id} value={org.id}>{org.name}</option>
                  ))}
                </select>
              </div>

              {/* Projects */}
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Projects <span className="text-muted-foreground font-normal">(none selected = all projects)</span></p>
                {projects.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No projects in this organization.</p>
                ) : (
                  <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border p-2">
                    {projects.map((project): React.JSX.Element => (
                      <label key={project.id} className="flex items-center gap-2 text-sm">
                        <Checkbox checked={selectedProjects.has(project.id)} onCheckedChange={(): void => { toggleProject(project.id); }} />
                        {project.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Workspaces */}
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Workspaces <span className="text-muted-foreground font-normal">(none selected = all workspaces in the selected projects)</span></p>
                {workspaces.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No workspaces in this organization.</p>
                ) : (
                  <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
                    {workspaces.map((workspace): React.JSX.Element => (
                      <label key={workspace.id} className="flex items-center gap-2 text-sm">
                        <Checkbox checked={selectedWorkspaces.has(workspace.id)} onCheckedChange={(): void => { toggleWorkspace(workspace.id); }} />
                        {workspace.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Tag rule builder */}
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Workspace tag rule <span className="text-muted-foreground font-normal">(optional)</span></p>
                {renderRuleRow(tagTree, rootPath)}
                {tagLabel(tagTree) !== "" && (
                  <p className="text-xs text-muted-foreground">
                    Matches: <span className="font-mono">{rootLabel(tagTree)}</span>
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Workspaces matching this rule are included even if not selected above.
                  Use AND to require all conditions, OR to match any, and &quot;group&quot; to nest conditions.
                </p>
              </div>

              {/* Permission grants */}
              <div className="space-y-2">
                <p className="text-sm font-medium">Permissions</p>
                {PERMISSION_GROUPS.map((group): React.JSX.Element => (
                  <div key={group.id} className="rounded-md border p-2.5">
                    <p className="mb-1 text-[13px] font-semibold text-muted-foreground">{group.label}</p>
                    <div className="space-y-1">
                      {group.grants.map((grant): React.JSX.Element => (
                        <label key={grant.key} className="flex items-center gap-2 text-sm">
                          <Checkbox checked={granted[grant.key] === true} onCheckedChange={(): void => { toggleGrant(grant.key); }} />
                          {grant.label}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {error !== "" && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" disabled={saving} onClick={(): void => { onOpenChange(false); reset(); }}>Cancel</Button>
          <Button type="button" disabled={saving || (fineGrained && orgId === "")} onClick={(): Promise<void> => create()}>
            {saving ? "Creating…" : "Create token"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
