import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Bookmark, Columns3, Pencil, Plus, Rows3, Star, Tags, Trash2, X } from "lucide-react";

import { useSyncedSearchParam } from "@/hooks/useSyncedSearchParam";
import { CreateWorkspaceModal } from "@/components/CreateWorkspaceModal";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { TableDensity } from "@/components/ui/table";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { toast } from "@/components/ui/toast";
import { fetchAllApiPages, fetchApi } from "@/lib/api";
import { getTablePreferences, setTablePreferences } from "@/lib/table-preferences";
import { getPinnedWorkspaces, isWorkspacePinned, setWorkspacePinned } from "@/lib/workspace-shortcuts";
import { deleteView, getSavedViews, saveView, type SavedView } from "@/lib/saved-views";
import { cn, formatDateTime, formatRelativeTime } from "@/lib/utils";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { WorkspaceRepositoryLink } from "@/components/WorkspaceRepositoryLink";
import { isNumber } from "../lib/type-guards";
import type { JsonObject } from "@/lib/json";

type Project = Readonly<{ id: string; attributes: Readonly<{ name: string }> }>;

/** Toggleable table columns (kanban 14.21). "workspace" is always shown. */
const WORKSPACE_TABLE_COLUMNS: readonly { id: string; label: string }[] = [
  { id: "repository", label: "Repository" },
  { id: "tags", label: "Tags" },
  { id: "project", label: "Project" },
  { id: "latest-change", label: "Latest change" },
  { id: "status", label: "Status" },
];

function defaultVisibleColumns(): string[] {
  const prefs = getTablePreferences("workspaces");
  // Any stored value, including an empty array (all optional columns hidden),
  // wins over the defaults; only a missing preference falls back.
  if (prefs !== null) return [...prefs.visibleColumns];
  return WORKSPACE_TABLE_COLUMNS.map((column): string => column.id);
}
type Organization = Readonly<{
  attributes: Readonly<{
    permissions?: Readonly<{ "can-manage-workspaces"?: boolean }>;
    "default-iac-binary"?: string;
    "default-terraform-version"?: string;
  }>;
}>;

type Workspace = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    locked?: boolean;
    permissions?: Readonly<{ "can-update"?: boolean }>;
    "tag-names"?: readonly string[];
    "vcs-repo"?: Readonly<{
      identifier: string;
      "github-app-installation-id"?: string | null;
    }> | null;
  }>;
  relationships?: Readonly<{
    project?: Readonly<{ data: Readonly<{ id: string }> | null }>;
    "current-run"?: Readonly<{ data: Readonly<{ id: string }> | null }>;
  }>;
}>;

type TagBinding = Readonly<{
  id: string;
  attributes: Readonly<{ key: string; value?: string }>;
}>;

type RunSummary = Readonly<{
  id: string;
  type: "runs";
  attributes: Readonly<{
    "created-at"?: string;
    message?: string | null;
    status: string;
  }>;
  relationships: Readonly<{ workspace: Readonly<{ data: Readonly<{ id: string }> }> }>;
}>;

/**
 * Page through a workspace list collecting both `data` and the `included`
 * current-run resources (10.1): the server aggregates the latest run per
 * workspace, so the view no longer bulk-fetches the org run history.
 */
async function fetchWorkspacePages(
  endpoint: string,
  signal?: Readonly<AbortSignal>,
): Promise<Readonly<{ workspaces: Workspace[]; runs: RunSummary[] }>> {
  const workspaces: Workspace[] = [];
  const runs: RunSummary[] = [];
  const visited = new Set<string>();
  let pageEndpoint: string | null = endpoint;

  while (pageEndpoint !== null && !visited.has(pageEndpoint)) {
    visited.add(pageEndpoint);
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
    const response = await fetchApi(
      pageEndpoint,
      signal === undefined ? {} : { signal },
    ) as {
      data?: Workspace[];
      included?: RunSummary[];
      meta?: { pagination?: JsonObject };
    };
    if (Array.isArray(response.data)) workspaces.push(...response.data);
    if (Array.isArray(response.included)) {
      runs.push(...response.included);
    }

    const nextPage = response.meta?.pagination?.["next-page"];
    if (!isNumber(nextPage) || !Number.isSafeInteger(nextPage) || nextPage < 1) {
      pageEndpoint = null;
      continue;
    }
    const nextUrl: URL = new globalThis.URL(pageEndpoint, "http://terrence.local");
    nextUrl.searchParams.set("page[number]", String(nextPage));
    pageEndpoint = `${nextUrl.pathname}${nextUrl.search}`;
  }

  return { workspaces, runs };
}

// The "running" set mirrors the executor's active statuses (worker.ts
// blockerStatuses minus the completed-plan states, which belong to on-hold):
// pre-plan/post-plan task execution, policy phases, queued apply, etc.
const runStatusFilters = {
  attention: ["policy_soft_failed", "policy_hard_failed", "policy_override"],
  errored: ["errored"],
  running: [
    "queuing", "pending", "fetching", "fetching_completed", "plan_queued",
    "pre_plan_running", "pre_plan_completed", "planning",
    "cost_estimating", "cost_estimated", "policy_checking", "policy_checked",
    "post_plan_running", "post_plan_completed", "confirmed", "apply_queued", "applying",
  ],
  "on-hold": ["planned", "planned_and_saved"],
  completed: ["applied", "planned_and_finished", "discarded", "canceled"],
};

function statusesForFilter(filter: string): readonly string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(runStatusFilters, filter)) return undefined;
  return runStatusFilters[filter as keyof typeof runStatusFilters];
}

export function Workspaces(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // Org-wide totals are independent of the status filter; the workspace list
  // itself is server-filtered when one is active (review item 1.9).
  const [totalWorkspaceCount, setTotalWorkspaceCount] = useState(0);
  const [lockedWorkspaceCount, setLockedWorkspaceCount] = useState(0);
  const [totalsUnavailable, setTotalsUnavailable] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectDataError, setProjectDataError] = useState(false);
  const [latestRuns, setLatestRuns] = useState<ReadonlyMap<string, RunSummary>>(new Map());
  const [canManageWorkspaces, setCanManageWorkspaces] = useState(false);
  const [defaultIacBinary, setDefaultIacBinary] = useState("tofu");
  const [defaultTerraformVersion, setDefaultTerraformVersion] = useState("latest");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useSyncedSearchParam("status", "");
  const [projectFilter, setProjectFilter] = useState("");
  const [density, setDensity] = useState<TableDensity>((): TableDensity => {
    const prefs = getTablePreferences("workspaces");
    return prefs?.density ?? "comfortable";
  });
  const [pinsRevision, setPinsRevision] = useState(0);
  const [savedViews, setSavedViews] = useState<SavedView[]>((): SavedView[] => getSavedViews(orgName));
  const [visibleColumns, setVisibleColumns] = useState<string[]>(defaultVisibleColumns);
  const [activeViewName, setActiveViewName] = useState("");
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [viewName, setViewName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [tagWorkspace, setTagWorkspace] = useState<Workspace | null>(null);
  const [tagBindings, setTagBindings] = useState<TagBinding[]>([]);
  const [tagKey, setTagKey] = useState("");
  const [tagValue, setTagValue] = useState("");
  const [editingTagKey, setEditingTagKey] = useState<string | null>(null);
  const [savingTag, setSavingTag] = useState(false);

  const loadData = useCallback(async (signal?: Readonly<AbortSignal>): Promise<void> => {
    setLoading(true);
    setLoadError("");
    setCanManageWorkspaces(false);
    try {
      // SAFETY: unknown filter keys yield undefined, treated as "no filter" below.
      const statuses = statusesForFilter(statusFilter);
      const query = statuses === undefined
        ? "?page%5Bsize%5D=100&include=current_run"
        : `?page%5Bsize%5D=100&include=current_run&filter%5Bcurrent-run%5D%5Bstatus%5D=${encodeURIComponent(statuses.join(","))}`;
      const [workspaceResult, totalsResult, projectResult, organizationResult] = await Promise.all([
        fetchWorkspacePages(`/organizations/${encodeURIComponent(orgName)}/workspaces${query}`, signal),
        // KPIs must reflect the whole org, not the filtered page: fetch the
        // unfiltered list solely for counting when a status filter is active.
        statuses === undefined
          ? Promise.resolve(null)
          : fetchWorkspacePages(`/organizations/${encodeURIComponent(orgName)}/workspaces?page%5Bsize%5D=100&include=current_run`, signal)
            .catch((): null => null),
        fetchAllApiPages<Project>(`/organizations/${encodeURIComponent(orgName)}/projects?page%5Bsize%5D=100`, signal)
          .then((data): { data: Project[]; failed: false } => ({ data, failed: false }))
          .catch((): { data: Project[]; failed: true } => ({ data: [], failed: true })),
        fetchApi(
          `/organizations/${encodeURIComponent(orgName)}`,
          signal === undefined ? {} : { signal },
        )
          .then((response): Readonly<{
            canManage: boolean;
            defaultIacBinary: string;
            defaultTerraformVersion: string;
          }> => {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
            const organization = (response as { data?: Organization }).data;
            const iacBinary = organization?.attributes["default-iac-binary"];
            const version = organization?.attributes["default-terraform-version"];
            return {
              canManage: organization?.attributes.permissions?.["can-manage-workspaces"] === true,
              defaultIacBinary: iacBinary === "terraform" ? "terraform" : "tofu",
              defaultTerraformVersion: typeof version === "string" && version !== "" ? version : "latest",
            };
          })
          .catch((): false => false),
      ]);
      if (signal?.aborted === true) return;
      setWorkspaces(workspaceResult.workspaces);
      if (statuses === undefined || totalsResult !== null) {
        const totalsSource = totalsResult ?? workspaceResult;
        setTotalWorkspaceCount(totalsSource.workspaces.length);
        setLockedWorkspaceCount(totalsSource.workspaces.filter((workspace): boolean => workspace.attributes.locked === true).length);
        setTotalsUnavailable(false);
      } else {
        // Unfiltered counting failed under an active filter: keep the last
        // verified org-wide totals and surface that they are stale rather
        // than showing filtered counts as org-wide numbers.
        setTotalsUnavailable(true);
      }
      setProjects(projectResult.data);
      setProjectDataError(projectResult.failed);
      if (organizationResult !== false) {
        setCanManageWorkspaces(organizationResult.canManage);
        setDefaultIacBinary(organizationResult.defaultIacBinary);
        setDefaultTerraformVersion(organizationResult.defaultTerraformVersion);
      } else {
        setCanManageWorkspaces(false);
      }
      // The server aggregates the latest run per workspace (include=current_run,
      // review 10.1); the org-wide runs fetch is gone. Resolve each workspace
      // through its own current-run relationship so an included run without
      // a workspace relationship can never crash the mapping.
      const runsById = new Map(workspaceResult.runs.map((run): [string, RunSummary] => [run.id, run]));
      const byWorkspace = new Map<string, RunSummary>();
      for (const workspace of workspaceResult.workspaces) {
        const currentRun = workspace.relationships?.["current-run"]?.data;
        if (currentRun === null || currentRun === undefined) continue;
        const run = runsById.get(currentRun.id);
        if (run !== undefined) byWorkspace.set(workspace.id, run);
      }
      setLatestRuns(byWorkspace);
    } catch (error: unknown) {
      if (signal?.aborted === true) return;
      setLoadError(error instanceof Error ? error.message : "Could not load workspaces");
      toast.add({
        title: "Could not load workspaces",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    } finally {
      if (signal?.aborted !== true) setLoading(false);
    }
  }, [orgName, statusFilter]);

  useEffect((): (() => void) => {
    const controller = new AbortController();
    if (orgName !== "") void loadData(controller.signal);
    return (): void => {
      controller.abort();
    };
  }, [loadData, orgName]);

  // Persist table density and column visibility (kanban 14.22/14.21).
  // An empty column list is a valid choice (all optional columns hidden);
  // it must be persisted as-is, never replaced with the defaults.
  useEffect((): void => {
    setTablePreferences("workspaces", { density, visibleColumns });
  }, [density, visibleColumns]);

  // Saved views are org-scoped, so refresh them when the org changes.
  useEffect((): void => {
    setSavedViews(getSavedViews(orgName));
    setActiveViewName("");
  }, [orgName]);

  const applySavedView = (view: SavedView): void => {
    setSearch(view.search);
    setStatusFilter(view.statusFilter);
    setProjectFilter(view.projectFilter);
    setActiveViewName(view.name);
  };

  const handleSaveView = (): void => {
    const name = viewName.trim();
    if (name === "") return;
    const updated = saveView(orgName, {
      name,
      search,
      statusFilter,
      projectFilter,
    });
    setSavedViews(updated);
    setActiveViewName(name);
    setViewDialogOpen(false);
    setViewName("");
  };

  const handleDeleteView = (name: string): void => {
    const updated = deleteView(orgName, name);
    setSavedViews(updated);
    if (activeViewName === name) setActiveViewName("");
  };

  const visibleWorkspaces = useMemo((): Workspace[] => {
    const needle = search.trim().toLowerCase();
    const pinnedNames = new Set(
      getPinnedWorkspaces()
        .filter((entry): boolean => entry.orgName === orgName)
        .map((entry): string => entry.workspaceName),
    );
    const matches = workspaces.filter((workspace): boolean => {
      const projectId = workspace.relationships?.project?.data?.id ?? "";
      const tags = workspace.attributes["tag-names"] ?? [];
      const matchesSearch = needle === ""
        || workspace.attributes.name.toLowerCase().includes(needle)
        || tags.some((tag): boolean => tag.toLowerCase().includes(needle));
      const matchesProject = projectFilter === "" || projectId === projectFilter;
      const matchesLocked = statusFilter !== "locked" || workspace.attributes.locked === true;
      return matchesSearch && matchesProject && matchesLocked;
    });
    // Pinned workspaces float to the top (kanban 26.12); order is otherwise
    // stable (API order).
    return matches.sort((a, b): number => {
      const aPinned = pinnedNames.has(a.attributes.name);
      const bPinned = pinnedNames.has(b.attributes.name);
      if (aPinned === bPinned) return 0;
      return aPinned ? -1 : 1;
    });
  }, [orgName, pinsRevision, projectFilter, search, statusFilter, workspaces]);

  const activeRunsCount = useMemo((): number => {
    let count = 0;
    for (const run of latestRuns.values()) {
      if (runStatusFilters.running.includes(run.attributes.status)) {
        count++;
      }
    }
    return count;
  }, [latestRuns]);

  const attentionNeededCount = useMemo((): number => {
    let count = 0;
    for (const run of latestRuns.values()) {
      if (
        runStatusFilters.attention.includes(run.attributes.status) ||
        run.attributes.status === "errored"
      ) {
        count++;
      }
    }
    return count;
  }, [latestRuns]);



  const loadTags = async (workspace: Workspace): Promise<void> => {
    try {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const response = await fetchApi(`/workspaces/${workspace.id}/tag-bindings`) as { data?: TagBinding[] };
      setTagBindings(Array.isArray(response.data) ? response.data : []);
    } catch (error: unknown) {
      toast.add({
        title: "Could not load tags",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    }
  };

  const openTags = (workspace: Workspace): void => {
    setTagWorkspace(workspace);
    setTagKey("");
    setTagValue("");
    setEditingTagKey(null);
    setTagBindings([]);
    void loadTags(workspace);
  };

  const saveTag = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (tagWorkspace === null || tagKey.trim() === "") return;
    setSavingTag(true);
    try {
      await fetchApi(`/workspaces/${tagWorkspace.id}/tag-bindings`, {
        method: "PATCH",
        body: JSON.stringify({
          data: [{
            type: "tag-bindings",
            attributes: { key: tagKey.trim(), value: tagValue.trim() },
          }],
        }),
      });
      setTagKey("");
      setTagValue("");
      setEditingTagKey(null);
      await Promise.all([loadTags(tagWorkspace), loadData()]);
      toast.add({ title: editingTagKey === null ? "Tag added" : "Tag updated", type: "success" });
    } catch (error: unknown) {
      toast.add({
        title: "Could not save tag",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    } finally {
      setSavingTag(false);
    }
  };

  const deleteTag = async (tag: TagBinding): Promise<void> => {
    if (tagWorkspace === null) return;
    try {
      await fetchApi(`/workspaces/${tagWorkspace.id}/relationships/tags`, {
        method: "DELETE",
        body: JSON.stringify({ data: [{ id: tag.attributes.key, type: "tags" }] }),
      });
      await Promise.all([loadTags(tagWorkspace), loadData()]);
      toast.add({ title: "Tag removed", type: "success" });
    } catch (error: unknown) {
      toast.add({
        title: "Could not remove tag",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    }
  };

  const projectName = (workspace: Workspace): string => {
    const projectId = workspace.relationships?.project?.data?.id;
    return projects.find((project): boolean => project.id === projectId)?.attributes.name ?? "Unknown project";
  };

  const hasFilters = search !== "" || statusFilter !== "" || projectFilter !== "" || activeViewName !== "";
  const tableColumnCount = WORKSPACE_TABLE_COLUMNS.filter((column): boolean => visibleColumns.includes(column.id)).length + 2;

  return (
    <PageShell variant="wide">
      <PageHeader
        eyebrow={orgName}
        title="Workspaces"
        description="Review workspace health, current runs, and configuration at a glance."
        action={canManageWorkspaces ? (
          <Button onClick={(): void => { setCreateOpen(true); }}>
            <Plus data-icon="inline-start" />
            New workspace
          </Button>
        ) : undefined}
      />

      {/* Top KPI Metrics Bar */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <button
          type="button"
          onClick={(): void => {
            setSearch("");
            setStatusFilter("");
            setProjectFilter("");
            setActiveViewName("");
          }}
          className={cn(
            "text-left rounded-xl border bg-card p-4 text-card-foreground shadow-2xs transition-all hover:border-primary/40 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer",
            !hasFilters && "border-primary/50 bg-primary/5 ring-1 ring-primary/30"
          )}
        >
          <div className="text-xs font-medium text-muted-foreground">Total Workspaces</div>
          <div className="mt-1 tabular-nums text-2xl font-bold">{totalsUnavailable ? "—" : totalWorkspaceCount}</div>
        </button>
        <button
          type="button"
          onClick={(): void => { setStatusFilter(statusFilter === "running" ? "" : "running"); setActiveViewName(""); }}
          className={cn(
            "text-left rounded-xl border bg-card p-4 text-card-foreground shadow-2xs transition-all hover:border-primary/40 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer",
            statusFilter === "running" && "border-primary/50 bg-primary/5 ring-1 ring-primary/30"
          )}
        >
          <div className="text-xs font-medium text-muted-foreground">Active Runs</div>
          <div className="mt-1 tabular-nums text-2xl font-bold text-primary">{activeRunsCount}</div>
        </button>
        <button
          type="button"
          onClick={(): void => { setStatusFilter(statusFilter === "attention" ? "" : "attention"); setActiveViewName(""); }}
          className={cn(
            "text-left rounded-xl border bg-card p-4 text-card-foreground shadow-2xs transition-all hover:border-destructive/40 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer",
            statusFilter === "attention" && "border-destructive/50 bg-destructive/5 ring-1 ring-destructive/30"
          )}
        >
          <div className="text-xs font-medium text-muted-foreground">Attention Needed</div>
          <div className={cn("mt-1 tabular-nums text-2xl font-bold", attentionNeededCount > 0 ? "text-destructive" : "")}>
            {attentionNeededCount}
          </div>
        </button>
        <button
          type="button"
          onClick={(): void => {
            setStatusFilter(statusFilter === "locked" ? "" : "locked");
            setActiveViewName("");
          }}
          className={cn(
            "text-left rounded-xl border bg-card p-4 text-card-foreground shadow-2xs transition-all hover:border-warning/40 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer",
            statusFilter === "locked" && "border-warning/50 bg-warning/5 ring-1 ring-warning/30"
          )}
        >
          <div className="text-xs font-medium text-muted-foreground">Locked Workspaces</div>
          <div className="mt-1 tabular-nums text-2xl font-bold">{totalsUnavailable ? "—" : lockedWorkspaceCount}</div>
        </button>
      </div>

      {totalsUnavailable && (
        <p role="status" className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          Organization-wide workspace totals are stale: the workspace count could not be refreshed while a status filter is active.
        </p>
      )}

      <section aria-label="Workspace filters" className="flex flex-wrap items-center gap-3">
        {savedViews.length > 0 && (
          <div className="flex w-full flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Saved views:</span>
            {savedViews.map((view): React.JSX.Element => (
              <span key={view.name} className="inline-flex items-center gap-1">
                <Button
                  variant={activeViewName === view.name ? "secondary" : "outline"}
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={(): void => { applySavedView(view); }}
                  aria-pressed={activeViewName === view.name}
                >
                  {view.name}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-6 p-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete saved view ${view.name}`}
                  onClick={(): void => { handleDeleteView(view.name); }}
                >
                  <X className="size-3" aria-hidden="true" />
                </Button>
              </span>
            ))}
          </div>
        )}
        <Input
          id="workspace-search"
          name="workspace-search"
          type="search"
          autoComplete="off"
          aria-label="Search workspaces"
          placeholder="Search by workspace name or tag…"
          className="min-w-[9rem] max-w-md flex-1"
          value={search}
          onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
            setSearch(event.currentTarget.value);
            setActiveViewName("");
          }}
        />
        <div className="w-36 shrink-0">
          <Select id="workspace-status-filter" name="status" aria-label="Status filter" value={statusFilter} onValueChange={(value: string): void => {
            setStatusFilter(value);
            setActiveViewName("");
          }}>
            <option value="">All statuses</option>
            <option value="attention">Needs attention</option>
            <option value="errored">Errored</option>
            <option value="running">Running</option>
            <option value="locked">Locked</option>
            <option value="on-hold">On hold</option>
            <option value="completed">Completed</option>
          </Select>
        </div>
        <div className="w-36 shrink-0">
          <Select id="workspace-project-filter" name="project" aria-label="Project filter" value={projectFilter} onValueChange={(value: string): void => {
            setProjectFilter(value);
            setActiveViewName("");
          }}>
            <option value="">All projects</option>
            {projects.map((project): React.JSX.Element => (
              <option key={project.id} value={project.id}>{project.attributes.name}</option>
            ))}
          </Select>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={!hasFilters}
            onClick={(): void => {
              setSearch("");
              setStatusFilter("");
              setProjectFilter("");
              setActiveViewName("");
            }}
          >
            <X data-icon="inline-start" />
            Clear
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label="Save current filters as a view"
            title="Save current filters as a named view"
            onClick={(): void => { setViewDialogOpen(true); }}
          >
            <Bookmark data-icon="inline-start" />
            Save view
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Choose visible columns"
                  title="Choose which columns are visible"
                >
                  <Columns3 data-icon="inline-start" />
                  Columns
                </Button>
              )}
            />
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {WORKSPACE_TABLE_COLUMNS.map((column): React.JSX.Element => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={visibleColumns.includes(column.id)}
                    onCheckedChange={(checked: boolean): void => {
                      setVisibleColumns((current): string[] =>
                        checked
                          ? [...current, column.id]
                          : current.filter((id: string): boolean => id !== column.id));
                    }}
                  >
                    {column.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            variant="outline"
            aria-label={density === "dense" ? "Switch to comfortable table density" : "Switch to dense table density"}
            title={density === "dense" ? "Dense rows (click for comfortable)" : "Comfortable rows (click for dense)"}
            onClick={(): void => {
              setDensity((current): TableDensity => current === "dense" ? "comfortable" : "dense");
            }}
          >
            <Rows3 data-icon="inline-start" />
            {density === "dense" ? "Dense" : "Comfortable"}
          </Button>
        </div>
      </section>

      {projectDataError && (
        <p role="status" className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          Projects could not be refreshed. Workspace results are still available.
        </p>
      )}
      {loadError !== "" && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>Could not refresh workspaces. {loadError}</span>
          <Button size="sm" variant="outline" onClick={(): void => { void loadData(); }}>Try again</Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <Table className="min-w-[64rem]" density={density}>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-card">Workspace</TableHead>
              {visibleColumns.includes("repository") && <TableHead>Repository</TableHead>}
              {visibleColumns.includes("tags") && <TableHead>Tags</TableHead>}
              {visibleColumns.includes("project") && <TableHead>Project</TableHead>}
              {visibleColumns.includes("latest-change") && <TableHead>Latest change</TableHead>}
              {visibleColumns.includes("status") && <TableHead>Status</TableHead>}
              <TableHead className="text-right">Manage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={tableColumnCount} className="p-0"><TableSkeleton rows={4} cols={tableColumnCount} /></TableCell></TableRow>
            ) : loadError !== "" && workspaces.length === 0 ? (
              <TableRow>
                <TableCell colSpan={tableColumnCount} className="py-12 text-center text-muted-foreground">
                  Workspace data is unavailable. Use Try again above to retry.
                </TableCell>
              </TableRow>
            ) : visibleWorkspaces.length === 0 ? (
              <TableRow>
                <TableCell colSpan={tableColumnCount} className="py-4 text-center text-muted-foreground">
                  <EmptyState
                    compact
                    illustration={hasFilters ? undefined : "empty"}
                    title={hasFilters ? "No workspaces match the current filters" : "No workspaces yet"}
                    description={hasFilters
                      ? "Clear or adjust the filters to see more workspaces."
                      : canManageWorkspaces
                        ? "Create your first workspace to get started."
                        : "No workspaces are available in this organization."}
                    {...(!hasFilters ? { docsHref: "/app/docs/workspaces" } : {})}
                  />
                </TableCell>
              </TableRow>
            ) : visibleWorkspaces.map((workspace): React.JSX.Element => (
              <TableRow key={workspace.id}>
                <TableCell className="sticky left-0 z-10 bg-card">
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/app/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(workspace.attributes.name)}`}
                      className="font-semibold text-primary hover:underline"
                    >
                      {workspace.attributes.name}
                    </Link>
                    {workspace.attributes.locked === true && <Badge variant="outline">Locked</Badge>}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      aria-label={isWorkspacePinned(orgName, workspace.attributes.name)
                        ? `Unpin ${workspace.attributes.name}`
                        : `Pin ${workspace.attributes.name}`}
                      title={isWorkspacePinned(orgName, workspace.attributes.name)
                        ? "Unpin from sidebar shortcuts"
                        : "Pin to sidebar shortcuts"}
                      onClick={(): void => {
                        const pinned = isWorkspacePinned(orgName, workspace.attributes.name);
                        setWorkspacePinned(orgName, workspace.attributes.name, !pinned);
                        setPinsRevision((value: number): number => value + 1);
                      }}
                    >
                      <Star
                        className={cn(
                          "size-3.5",
                          isWorkspacePinned(orgName, workspace.attributes.name)
                            ? "fill-warning text-warning"
                            : "text-muted-foreground",
                        )}
                        aria-hidden="true"
                      />
                    </Button>
                  </div>
                </TableCell>
                {visibleColumns.includes("repository") && (
                  <TableCell className="max-w-64"><WorkspaceRepositoryLink repo={workspace.attributes["vcs-repo"]} /></TableCell>
                )}
                {visibleColumns.includes("tags") && (
                  <TableCell>
                    <div className="flex max-w-56 flex-wrap gap-1">
                      {(workspace.attributes["tag-names"] ?? []).map((tag): React.JSX.Element => (
                        <Badge key={tag} variant="secondary" className="max-w-48 truncate">{tag}</Badge>
                      ))}
                      {(workspace.attributes["tag-names"] ?? []).length === 0 && <span className="text-muted-foreground">None</span>}
                    </div>
                  </TableCell>
                )}
                {visibleColumns.includes("project") && (
                  <TableCell>
                    {workspace.relationships?.project?.data?.id === undefined ? (
                      projectName(workspace)
                    ) : (
                      <Link
                        to={`/app/${encodeURIComponent(orgName)}/projects/${encodeURIComponent(workspace.relationships.project.data.id)}`}
                        className="text-primary hover:underline"
                      >
                        {projectName(workspace)}
                      </Link>
                    )}
                  </TableCell>
                )}
                {visibleColumns.includes("latest-change") && (
                  <TableCell>
                    {latestRuns.get(workspace.id) === undefined ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="max-w-64">
                        <p className="truncate text-sm">{latestRuns.get(workspace.id)?.attributes.message ?? "Manual run"}</p>
                        {((): React.JSX.Element | null => {
                          const created = latestRuns.get(workspace.id)?.attributes["created-at"];
                          if (created === undefined || created === "") return null;
                          return (
                            <p className="text-xs text-muted-foreground" title={formatDateTime(created, "")}>
                              {formatRelativeTime(created)}
                            </p>
                          );
                        })()}
                      </div>
                    )}
                  </TableCell>
                )}
                {visibleColumns.includes("status") && (
                  <TableCell>
                    {latestRuns.get(workspace.id) === undefined ? (
                      <span className="text-muted-foreground">No runs</span>
                    ) : (
                      <StatusBadge status={latestRuns.get(workspace.id)?.attributes.status} />
                    )}
                  </TableCell>
                )}
                <TableCell className="text-right">
                  {workspace.attributes.permissions?.["can-update"] === true ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Manage tags for ${workspace.attributes.name}`}
                      onClick={(): void => { openTags(workspace); }}
                    >
                      <Tags data-icon="inline-start" />
                      Tags
                    </Button>
                  ) : <span className="text-muted-foreground">—</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {canManageWorkspaces && (
        <CreateWorkspaceModal
          orgName={orgName}
          defaultIacBinary={defaultIacBinary}
          defaultTerraformVersion={defaultTerraformVersion}
          projects={projects}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(): void => { void loadData(); }}
        />
      )}

      <Dialog open={tagWorkspace !== null} onOpenChange={(open: boolean): void => { if (!open) setTagWorkspace(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Tags for {tagWorkspace?.attributes.name}</DialogTitle>
            <DialogDescription>Add, update, or remove direct workspace tags.</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveTag}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="workspace-tag-key">Key</FieldLabel>
                <Input
                  id="workspace-tag-key"
                  name="tag-key"
                  autoComplete="off"
                  value={tagKey}
                  disabled={editingTagKey !== null}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setTagKey(event.currentTarget.value); }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="workspace-tag-value">Value</FieldLabel>
                <Input
                  id="workspace-tag-value"
                  name="tag-value"
                  autoComplete="off"
                  value={tagValue}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setTagValue(event.currentTarget.value); }}
                />
              </Field>
            </FieldGroup>
            <DialogFooter className="mt-4">
              {editingTagKey !== null && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={(): void => {
                    setEditingTagKey(null);
                    setTagKey("");
                    setTagValue("");
                  }}
                >
                  Cancel edit
                </Button>
              )}
              <Button type="submit" disabled={tagKey.trim() === "" || savingTag}>
                {savingTag && <Spinner data-icon="inline-start" />}
                {editingTagKey === null ? "Add tag" : "Update tag"}
              </Button>
            </DialogFooter>
          </form>
          <Table>
            <TableHeader><TableRow><TableHead>Key</TableHead><TableHead>Value</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
            <TableBody>
              {tagBindings.map((tag): React.JSX.Element => (
                <TableRow key={tag.id}>
                  <TableCell className="font-medium">{tag.attributes.key}</TableCell>
                  <TableCell>{tag.attributes.value ?? ""}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit tag ${tag.attributes.key}`}
                        onClick={(): void => {
                          setEditingTagKey(tag.attributes.key);
                          setTagKey(tag.attributes.key);
                          setTagValue(tag.attributes.value ?? "");
                        }}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete tag ${tag.attributes.key}`}
                        onClick={(): void => { void deleteTag(tag); }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {tagBindings.length === 0 && (
                <TableRow><TableCell colSpan={3} className="py-8 text-center text-muted-foreground">No direct tags.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>

      <Dialog
        open={viewDialogOpen}
        onOpenChange={(open: boolean): void => {
          setViewDialogOpen(open);
          if (!open) setViewName("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save view</DialogTitle>
            <DialogDescription>
              Save the current search, status, and project filters as a named view.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event): void => {
              event.preventDefault();
              handleSaveView();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="saved-view-name">View name</FieldLabel>
                <Input
                  id="saved-view-name"
                  name="view-name"
                  autoComplete="off"
                  value={viewName}
                  autoFocus
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setViewName(event.currentTarget.value); }}
                  placeholder="e.g. Production attention…"
                />
              </Field>
            </FieldGroup>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={(): void => { setViewDialogOpen(false); }}>Cancel</Button>
              <Button type="submit" disabled={viewName.trim() === ""}>Save view</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
