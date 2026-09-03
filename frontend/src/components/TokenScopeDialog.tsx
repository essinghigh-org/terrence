import { useEffect, useMemo, useState } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { Badge } from "../components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { toast } from "../components/ui/toast";
import { isString } from "../lib/type-guards";
import type { JsonObject } from "@/lib/json";
import {
  Boxes,
  Building2,
  Folder,
  FolderPlus,
  Layers,
  Plus,
  Search,
  Shield,
  Tag,
} from "lucide-react";

/**
 * Permission grants offered in the fine-grained scope picker. Each maps to a
 * `permissions` key in the token scope. Write grants do NOT imply their read
 * counterpart in the picker (selectors are explicit), matching the backend's
 * grant model.
 */
const PERMISSION_GROUPS: readonly {
  readonly id: string;
  readonly label: string;
  readonly grants: readonly { readonly key: string; readonly label: string }[];
}[] = [
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
      { key: "runs:apply", label: "Apply plans to planned runs" },
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
type TagFilterNode = Readonly<{ kind: "filter"; id: string; key: string; value: string }>;
/** A group of rules combined with AND or OR. */
type TagGroupNode = Readonly<{ kind: "group"; id: string; combinator: "AND" | "OR"; rules: TagRuleNode[] }>;
type TagRuleNode = TagFilterNode | TagGroupNode;

/** Initial builder state: one empty filter row. */
function emptyGroup(): TagGroupNode {
  return { kind: "group", id: crypto.randomUUID(), combinator: "OR", rules: [{ kind: "filter", id: crypto.randomUUID(), key: "", value: "" }] };
}

/**
 * Serialize the builder tree into the backend's scope `tags` shape. Empty
 * filters (blank key) and groups that end up empty are pruned at every level,
 * so a partially-filled builder never emits rows the backend would reject
 * (`isTagFilter` requires a non-empty key). Returns null when nothing is
 * filled in, which the caller maps to `tags: null`.
 */
type SerializedTagRule =
  | Readonly<{ key: string; value: string }>
  | Readonly<{ combinator: "AND" | "OR"; rules: SerializedTagRule[] }>
  | null;

function serializeTags(root: TagGroupNode): Readonly<{ combinator: "AND" | "OR"; rules: SerializedTagRule[] }> | null {
  const convert = (node: TagRuleNode): SerializedTagRule => {
    if (node.kind === "filter") {
      const key = node.key.trim();
      if (key === "") return null;
      return { key, value: node.value.trim() };
    }
    const rules = node.rules
      .map(convert)
      .filter((rule): rule is Exclude<SerializedTagRule, null> => rule !== null);
    if (rules.length === 0) return null;
    return { combinator: node.combinator, rules };
  };
  // SAFETY: the builder root is always a group (emptyGroup returns kind: "group"),
  // so convert() can only yield a group or null at this level.
  return convert(root) as Readonly<{ combinator: "AND" | "OR"; rules: SerializedTagRule[] }> | null;
}

/** Render a node as a human-readable expression, or null when it holds no filled-in conditions. */
function tagLabel(node: TagRuleNode): string | null {
  if (node.kind === "filter") {
    const key = node.key.trim();
    if (key === "") return null;
    return `${key}=${node.value.trim()}`;
  }
  const inner = node.rules
    .map(tagLabel)
    .filter((part): part is string => part !== null);
  if (inner.length === 0) return null;
  return `(${inner.join(` ${node.combinator} `)})`;
}

function rootLabel(root: TagGroupNode): string | null {
  const parts = root.rules
    .map(tagLabel)
    .filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return parts.join(` ${root.combinator} `);
}

type OrgOption = Readonly<{ id: string; name: string }>;
type ProjectOption = Readonly<{ id: string; name: string }>;
type WorkspaceOption = Readonly<{ id: string; name: string }>;

/** Extract an `id` + `name` pair from a JSON:API resource item. */
function resourceOptions(
  data: { id: string; attributes?: JsonObject }[],
  nameKey = "name",
): { id: string; name: string }[] {
  return data.map((item): { id: string; name: string } => {
    const attributes = (item.attributes ?? {});
    const rawName = attributes[nameKey];
    return { id: item.id, name: isString(rawName) ? rawName : item.id };
  });
}

export function TokenScopeDialog({
  open,
  onOpenChange,
  onCreated,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (token: { id: string; type: string; attributes: JsonObject }) => void;
}>): React.JSX.Element {
  const [description, setDescription] = useState("");
  const [fineGrained, setFineGrained] = useState(false);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [orgId, setOrgId] = useState("");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [selectedWorkspaces, setSelectedWorkspaces] = useState<Set<string>>(new Set());
  const [projectSearch, setProjectSearch] = useState("");
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [permissionSearch, setPermissionSearch] = useState("");
  const [tagTree, setTagTree] = useState<TagGroupNode>(emptyGroup);
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Load organizations when the dialog opens.
  useEffect((): void => {
    if (!open) return;
    setError("");
    void fetchApi<{ data?: { id: string; attributes?: JsonObject }[] }>("/organizations?page[size]=100").then((response): void => {
      const data = response.data ?? [];
      const parsed = data
        .map((item): OrgOption => {
          const externalId = item.attributes?.["external-id"];
          const displayName = item.attributes?.["name"];
          return {
            id: isString(externalId) ? externalId : item.id,
            name: isString(displayName) ? displayName : item.id,
          };
        })
        .sort((a, b): number => a.name.localeCompare(b.name));
      setOrgs(parsed);
      if (parsed.length > 0) {
        setOrgId((current): string => (current === "" ? (parsed[0]?.id ?? "") : current));
      }
    }).catch((): void => { setError("Could not load organizations"); });
  }, [open]);

  // Load projects + workspaces for the selected org.
  useEffect((): (() => void) | undefined => {
    if (!open || orgId === "") { setProjects([]); setWorkspaces([]); return; }
    const orgName = orgs.find((o): boolean => o.id === orgId)?.name ?? orgId;
    let cancelled = false;
    setProjects([]);
    setWorkspaces([]);
    void fetchApi<{ data?: { id: string; attributes?: JsonObject }[] }>(`/organizations/${encodeURIComponent(orgName)}/projects?page[size]=100`).then((response): void => {
      if (cancelled) return;
      const data = response.data ?? [];
      setProjects(resourceOptions(data));
    }).catch((): void => { /* org may not expose projects */ });
    void fetchApi<{ data?: { id: string; attributes?: JsonObject }[] }>(`/organizations/${encodeURIComponent(orgName)}/workspaces?page[size]=100`).then((response): void => {
      if (cancelled) return;
      const data = response.data ?? [];
      setWorkspaces(resourceOptions(data));
    }).catch((): void => { /* workspaces may not be listable */ });
    return (): void => { cancelled = true; };
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
    setGranted((prev): Record<string, boolean> => {
      const next = { ...prev };
      next[key] = !(prev[key] ?? false);
      return next;
    });
  };

  const grantAll = (): void => {
    const next: Record<string, boolean> = {};
    for (const group of PERMISSION_GROUPS) {
      for (const grant of group.grants) {
        next[grant.key] = true;
      }
    }
    setGranted(next);
  };

  const grantReadOnly = (): void => {
    const next: Record<string, boolean> = {};
    for (const group of PERMISSION_GROUPS) {
      for (const grant of group.grants) {
        if (grant.key.endsWith(":read")) {
          next[grant.key] = true;
        }
      }
    }
    setGranted(next);
  };

  const clearGrants = (): void => {
    setGranted({});
  };

  const toggleGroupGrants = (groupGrants: readonly { readonly key: string }[]): void => {
    const allActive = groupGrants.every((g): boolean => granted[g.key] === true);
    setGranted((prev): Record<string, boolean> => {
      const next = { ...prev };
      for (const grant of groupGrants) {
        next[grant.key] = !allActive;
      }
      return next;
    });
  };

  // --- Tag rule builder mutations (immutable tree updates) ---
  const updateRule = (path: readonly number[], mutate: (rule: TagRuleNode) => TagRuleNode): void => {
    setTagTree((root): TagGroupNode => {
      if (path.length === 0) {
        const updated = mutate(root);
        return updated.kind === "group" ? updated : root;
      }
      const updateAt = (rules: TagRuleNode[], rest: readonly number[]): TagRuleNode[] => {
        if (rest.length === 0) return rules;
        const head = rest[0];
        if (head === undefined) return rules;
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
        const head = rest[0];
        if (head === undefined) return rules;
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
        const head = rest[0];
        if (head === undefined) return rules;
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
      rule.kind === "filter" ? { ...rule, key, value } : rule);
  };

  const setCombinator = (path: readonly number[], combinator: "AND" | "OR"): void => {
    updateRule(path, (rule): TagRuleNode =>
      rule.kind === "group" ? { ...rule, combinator } : rule);
  };

  const wrapRule = (path: readonly number[]): void => {
    updateRule(path, (rule): TagRuleNode => ({ kind: "group", id: crypto.randomUUID(), combinator: "OR", rules: [rule] }));
  };

  const addFilter = (path: readonly number[]): void => {
    appendRule(path, { kind: "filter", id: crypto.randomUUID(), key: "", value: "" });
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
    setProjectSearch("");
    setWorkspaceSearch("");
    setPermissionSearch("");
    setTagTree(emptyGroup());
    setGranted({});
    setError("");
  };

  const create = async (): Promise<void> => {
    setSaving(true);
    setError("");
    try {
      if (fineGrained && orgId === "") throw new Error("Select an organization");
      const tags = fineGrained ? serializeTags(tagTree) : null;
      const attributes = {
        description: description.trim() === "" ? "API token" : description.trim(),
        ...(fineGrained
          ? {
              scopes: {
                version: 1,
                orgs: [orgId],
                projects: selectedProjects.size > 0 ? [...selectedProjects] : null,
                workspaces: selectedWorkspaces.size > 0 ? [...selectedWorkspaces] : null,
                tags,
                permissions: Object.fromEntries(Object.entries(granted).filter(([, v]): boolean => v)),
              },
            }
          : undefined),
      };
      const created = await fetchApi("/tokens", {
        method: "POST",
        body: JSON.stringify({ data: { attributes } }),
      }) as { data: { id: string; type: string; attributes: JsonObject } };
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

  const filteredProjects = useMemo((): ProjectOption[] => {
    const q = projectSearch.trim().toLowerCase();
    if (q === "") return projects;
    return projects.filter((p): boolean => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  }, [projects, projectSearch]);

  const filteredWorkspaces = useMemo((): WorkspaceOption[] => {
    const q = workspaceSearch.trim().toLowerCase();
    if (q === "") return workspaces;
    return workspaces.filter((w): boolean => w.name.toLowerCase().includes(q) || w.id.toLowerCase().includes(q));
  }, [workspaces, workspaceSearch]);

  const filteredPermissionGroups = useMemo((): readonly (typeof PERMISSION_GROUPS)[number][] => {
    const q = permissionSearch.trim().toLowerCase();
    if (q === "") return PERMISSION_GROUPS;
    return PERMISSION_GROUPS.map((group): (typeof PERMISSION_GROUPS)[number] | null => {
      const matchingGrants = group.grants.filter(
        (g): boolean => g.label.toLowerCase().includes(q) || g.key.toLowerCase().includes(q),
      );
      if (matchingGrants.length > 0 || group.label.toLowerCase().includes(q)) {
        return {
          ...group,
          grants: matchingGrants.length > 0 ? matchingGrants : group.grants,
        };
      }
      return null;
    }).filter((g): g is (typeof PERMISSION_GROUPS)[number] => g !== null);
  }, [permissionSearch]);

  const totalGrantedCount = useMemo(
    (): number => Object.values(granted).filter(Boolean).length,
    [granted],
  );

  const rootPath: readonly number[] = [];
  const renderRuleRow = (node: TagRuleNode, path: readonly number[]): React.JSX.Element => {
    if (node.kind === "filter") {
      return (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/80 bg-background/90 p-2 shadow-xs transition-colors hover:border-primary/40 sm:flex-nowrap">
          <div className="relative min-w-[140px] flex-1">
            <Input
              name={`tag-key-${path.join("-")}`}
              aria-label="Tag key"
              autoComplete="off"
              spellCheck={false}
              placeholder="Tag key (e.g. env)"
              value={node.key}
              onInput={(e: React.SyntheticEvent<HTMLInputElement>): void => { setFilterValue(path, e.currentTarget.value, node.value); }}
              className="h-8 font-mono text-xs"
            />
          </div>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-bold text-muted-foreground">
            =
          </span>
          <div className="relative min-w-[140px] flex-1">
            <Input
              name={`tag-value-${path.join("-")}`}
              aria-label="Tag value"
              autoComplete="off"
              spellCheck={false}
              placeholder="Tag value (e.g. prod)"
              value={node.value}
              onInput={(e: React.SyntheticEvent<HTMLInputElement>): void => { setFilterValue(path, node.key, e.currentTarget.value); }}
              className="h-8 font-mono text-xs"
            />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(): void => { wrapRule(path); }}
              title="Wrap this condition into a group"
              className="h-8 text-xs font-medium"
            >
              <Layers className="mr-1 size-3" />
              group
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={(): void => { removeRule(path); }}
              aria-label="Remove condition"
              className="h-8 px-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="Remove condition"
            >
              ✕
            </Button>
          </div>
        </div>
      );
    }

    const isRoot = path.length === 0;
    return (
      <div
        className={`space-y-2.5 rounded-lg border ${
          isRoot
            ? "border-border bg-muted/20 p-3"
            : "border-primary/30 border-l-4 border-l-primary bg-primary/5 p-2.5"
        }`}
        data-testid="tag-group"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2">
          <div className="flex items-center gap-2">
            {!isRoot && <span aria-hidden="true" className="text-sm font-semibold text-primary">(</span>}
            <select
              aria-label="Combine with"
              className="h-7 rounded-md border border-input bg-background px-2 font-mono text-xs font-semibold text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              value={node.combinator}
              onChange={(e): void => {
                setCombinator(path, e.target.value as "AND" | "OR");
              }}
            >
              <option value="AND">AND (match all)</option>
              <option value="OR">OR (match any)</option>
            </select>
            <span className="text-xs text-muted-foreground">
              {isRoot ? "of the conditions match" : "conditions match"}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(): void => { addFilter(path); }}
              className="h-7 text-xs font-medium"
            >
              <Plus className="mr-1 size-3" />
              Add condition
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(): void => { addGroup(path); }}
              className="h-7 text-xs font-medium"
            >
              <FolderPlus className="mr-1 size-3" />
              Add group
            </Button>
            {!isRoot && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={(): void => { removeRule(path); }}
                aria-label="Remove group"
                className="h-7 px-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                title="Remove group"
              >
                ✕
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-2">
          {node.rules.map((child, index): React.JSX.Element => (
            <div key={child.id}>
              {renderRuleRow(child, [...path, index])}
            </div>
          ))}
        </div>
        {!isRoot && <span aria-hidden="true" className="text-sm font-semibold text-primary">)</span>}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next: boolean): void => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="size-5 text-primary" />
            Create API token
          </DialogTitle>
          <DialogDescription>
            Fine-grained tokens restrict access to specific organizations, projects,
            workspaces, and tag rules, with customizable per-action permission grants.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Token description */}
          <div className="space-y-1.5">
            <label htmlFor="token-desc" className="text-xs font-semibold text-foreground">
              Token description
            </label>
            <Input
              id="token-desc"
              name="token-description"
              autoComplete="off"
              value={description}
              onInput={(e: React.SyntheticEvent<HTMLInputElement>): void => { setDescription(e.currentTarget.value); }}
              placeholder="e.g. CI/CD deploy token (GitHub Actions)"
            />
          </div>

          {/* Token type switch */}
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3 shadow-xs hover:border-primary/50 transition-colors">
            <Checkbox
              checked={fineGrained}
              onCheckedChange={(v: boolean): void => { setFineGrained(v); }}
              className="mt-0.5"
            />
            <div>
              <span className="font-semibold text-foreground text-sm">Fine-grained</span>
              <span className="block text-xs font-normal text-muted-foreground mt-0.5">
                Restrict this token to specific resources, tag rules, and action permissions. Legacy tokens have unrestricted access to all resources.
              </span>
            </div>
          </label>

          {fineGrained && (
            <div className="space-y-5 rounded-lg border border-border/80 bg-background/50 p-4">
              {/* Organization */}
              <div className="space-y-1.5">
                <label htmlFor="token-org" className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <Building2 className="size-3.5 text-muted-foreground" />
                  Organization
                </label>
                <select
                  id="token-org"
                  name="token-organization"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  value={orgId}
                  onChange={(e): void => {
                    setOrgId(e.target.value);
                    setSelectedProjects(new Set());
                    setSelectedWorkspaces(new Set());
                  }}
                >
                  {orgs.map((org): React.JSX.Element => (
                    <option key={org.id} value={org.id}>{org.name}</option>
                  ))}
                </select>
              </div>

              {/* Projects & Workspaces Grid */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {/* Projects */}
                <div className="space-y-2 rounded-md border border-border bg-card p-3">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <Folder className="size-3.5 text-muted-foreground" />
                      Projects
                      <Badge variant="secondary" className="px-1.5 py-0 text-2xs">
                        {selectedProjects.size === 0 ? "All" : `${selectedProjects.size}/${projects.length}`}
                      </Badge>
                    </span>
                    {projects.length > 0 && (
                      <div className="flex items-center gap-1 text-2xs">
                        <button
                          type="button"
                          aria-label="Select all projects"
                          onClick={(): void => { setSelectedProjects(new Set(projects.map((p): string => p.id))); }}
                          className="text-primary hover:underline"
                        >
                          All
                        </button>
                        <span className="text-muted-foreground">·</span>
                        <button
                          type="button"
                          aria-label="Clear selected projects"
                          onClick={(): void => { setSelectedProjects(new Set()); }}
                          className="text-muted-foreground hover:underline"
                        >
                          Clear
                        </button>
                      </div>
                    )}
                  </div>

                  {projects.length > 5 && (
                    <div className="relative">
                      <Search className="absolute left-2 top-2 size-3 text-muted-foreground" />
                      <Input
                        placeholder="Filter projects…"
                        value={projectSearch}
                        onChange={(e): void => { setProjectSearch(e.target.value); }}
                        onInput={(e: React.SyntheticEvent<HTMLInputElement>): void => { setProjectSearch(e.currentTarget.value); }}
                        className="h-7 pl-7 text-xs"
                      />
                    </div>
                  )}

                  {projects.length === 0 ? (
                    <p className="py-3 text-center text-xs text-muted-foreground">No projects in this organization.</p>
                  ) : filteredProjects.length === 0 ? (
                    <p className="py-3 text-center text-xs text-muted-foreground">No matching projects.</p>
                  ) : (
                    <div className="max-h-36 space-y-1 overflow-y-auto rounded border border-border/50 bg-background/50 p-1.5">
                      {filteredProjects.map((project): React.JSX.Element => (
                        <label
                          key={project.id}
                          className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted select-none"
                        >
                          <Checkbox
                            checked={selectedProjects.has(project.id)}
                            onCheckedChange={(): void => { toggleProject(project.id); }}
                          />
                          <span className="truncate">{project.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <p className="text-2xs text-muted-foreground">
                    {selectedProjects.size === 0 ? "No project selected: all projects in org are included." : "Scoped to selected projects."}
                  </p>
                </div>

                {/* Workspaces */}
                <div className="space-y-2 rounded-md border border-border bg-card p-3">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <Boxes className="size-3.5 text-muted-foreground" />
                      Workspaces
                      <Badge variant="secondary" className="px-1.5 py-0 text-2xs">
                        {selectedWorkspaces.size === 0 ? "All" : `${selectedWorkspaces.size}/${workspaces.length}`}
                      </Badge>
                    </span>
                    {workspaces.length > 0 && (
                      <div className="flex items-center gap-1 text-2xs">
                        <button
                          type="button"
                          aria-label="Select all workspaces"
                          onClick={(): void => { setSelectedWorkspaces(new Set(workspaces.map((w): string => w.id))); }}
                          className="text-primary hover:underline"
                        >
                          All
                        </button>
                        <span className="text-muted-foreground">·</span>
                        <button
                          type="button"
                          aria-label="Clear selected workspaces"
                          onClick={(): void => { setSelectedWorkspaces(new Set()); }}
                          className="text-muted-foreground hover:underline"
                        >
                          Clear
                        </button>
                      </div>
                    )}
                  </div>

                  {workspaces.length > 5 && (
                    <div className="relative">
                      <Search className="absolute left-2 top-2 size-3 text-muted-foreground" />
                      <Input
                        placeholder="Filter workspaces…"
                        value={workspaceSearch}
                        onChange={(e): void => { setWorkspaceSearch(e.target.value); }}
                        onInput={(e: React.SyntheticEvent<HTMLInputElement>): void => { setWorkspaceSearch(e.currentTarget.value); }}
                        className="h-7 pl-7 text-xs"
                      />
                    </div>
                  )}

                  {workspaces.length === 0 ? (
                    <p className="py-3 text-center text-xs text-muted-foreground">No workspaces in this organization.</p>
                  ) : filteredWorkspaces.length === 0 ? (
                    <p className="py-3 text-center text-xs text-muted-foreground">No matching workspaces.</p>
                  ) : (
                    <div className="max-h-36 space-y-1 overflow-y-auto rounded border border-border/50 bg-background/50 p-1.5">
                      {filteredWorkspaces.map((workspace): React.JSX.Element => (
                        <label
                          key={workspace.id}
                          className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted select-none"
                        >
                          <Checkbox
                            checked={selectedWorkspaces.has(workspace.id)}
                            onCheckedChange={(): void => { toggleWorkspace(workspace.id); }}
                          />
                          <span className="truncate">{workspace.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <p className="text-2xs text-muted-foreground">
                    {selectedWorkspaces.size === 0 ? "No workspace selected: all workspaces in projects are included." : "Scoped to selected workspaces."}
                  </p>
                </div>
              </div>

              {/* Tag Rule Policy Builder */}
              <div className="space-y-2 rounded-md border border-border bg-card p-3">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <Tag className="size-3.5 text-muted-foreground" />
                    Workspace tag rule
                    <span className="font-normal text-muted-foreground">(optional dynamic scoping)</span>
                  </span>
                </div>

                {renderRuleRow(tagTree, rootPath)}

                {rootLabel(tagTree) !== null && (
                  <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs">
                    <span className="font-semibold text-primary">Matches:</span>
                    <span className="font-mono font-medium text-foreground">{rootLabel(tagTree)}</span>
                  </div>
                )}

                <p className="text-2xs text-muted-foreground">
                  Workspaces matching this rule are included even if not selected above. Use AND to require all conditions, OR to match any, and &quot;group&quot; to nest conditions.
                </p>
              </div>

              {/* Permission Grants Matrix */}
              <div className="space-y-2.5 rounded-md border border-border bg-card p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-foreground">Permissions</span>
                    <Badge variant={totalGrantedCount > 0 ? "default" : "secondary"} className="px-1.5 py-0 text-2xs">
                      {totalGrantedCount} granted
                    </Badge>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label="Select read-only permissions"
                      onClick={grantReadOnly}
                      className="h-6 text-2xs font-medium"
                    >
                      Read-only
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label="Select all permissions"
                      onClick={grantAll}
                      className="h-6 text-2xs font-medium"
                    >
                      All
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="Clear all permissions"
                      onClick={clearGrants}
                      className="h-6 text-2xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      Clear
                    </Button>
                  </div>
                </div>

                <div className="relative">
                  <Search className="absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Search permissions by action or resource…"
                    value={permissionSearch}
                    onChange={(e): void => { setPermissionSearch(e.target.value); }}
                    onInput={(e: React.SyntheticEvent<HTMLInputElement>): void => { setPermissionSearch(e.currentTarget.value); }}
                    className="h-8 pl-8 text-xs"
                  />
                </div>

                <div className="grid max-h-72 grid-cols-1 gap-2.5 overflow-y-auto pr-1 md:grid-cols-2">
                  {filteredPermissionGroups.map((group): React.JSX.Element => {
                    const activeInGroup = group.grants.filter((g): boolean => granted[g.key] === true).length;
                    return (
                      <div key={group.id} className="rounded-md border border-border/70 bg-background p-2.5 shadow-xs">
                        <div className="mb-1.5 flex items-center justify-between">
                          <span className="text-xs font-semibold text-foreground">{group.label}</span>
                          <div className="flex items-center gap-1">
                            <Badge variant="outline" className="px-1 py-0 text-2xs text-muted-foreground font-mono">
                              {activeInGroup}/{group.grants.length}
                            </Badge>
                            <button
                              type="button"
                              onClick={(): void => { toggleGroupGrants(group.grants); }}
                              className="text-2xs text-primary hover:underline ml-1"
                            >
                              {activeInGroup === group.grants.length ? "none" : "all"}
                            </button>
                          </div>
                        </div>
                        <div className="space-y-1">
                          {group.grants.map((grant): React.JSX.Element => (
                            <label
                              key={grant.key}
                              className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-xs select-none hover:bg-muted"
                            >
                              <Checkbox
                                checked={granted[grant.key] === true}
                                onCheckedChange={(): void => { toggleGrant(grant.key); }}
                                className="mt-0.5"
                              />
                              <span className="flex-1 leading-4 text-foreground/90">{grant.label}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {error !== "" && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="mt-4">
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={(): void => { onOpenChange(false); reset(); }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={saving || (fineGrained && orgId === "")}
            onClick={async (): Promise<void> => create()}
          >
            {saving ? "Creating…" : "Create token"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
