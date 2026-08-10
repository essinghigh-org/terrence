import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Bookmark, Columns3, Pencil, Plus, Rows3, Star, Tags, Trash2, X } from "lucide-react";

import { CreateWorkspaceModal } from "@/components/CreateWorkspaceModal";
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
import { cn, formatDateTime } from "@/lib/utils";

type Project = Readonly<{ id: string; attributes: Readonly<{ name: string }> }>;

/** Toggleable table columns (kanban 14.21). "workspace" is always shown. */
const WORKSPACE_TABLE_COLUMNS: Readonly<{ id: string; label: string }[]> = [
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
  if (prefs !== null) return prefs.visibleColumns;
  return WORKSPACE_TABLE_COLUMNS.map((column): string => column.id);
}
type Organization = Readonly<{
  attributes: Readonly<{
    permissions?: Readonly<{ "can-manage-workspaces"?: boolean }>;
  }>;
}>;

type Workspace = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    locked?: boolean;
    permissions?: Readonly<{ "can-update"?: boolean }>;
    "tag-names"?: readonly string[];
    "vcs-repo"?: Readonly<{ identifier: string }> | null;
  }>;
  relationships?: Readonly<{ project?: Readonly<{ data: Readonly<{ id: string }> | null }> }>;
}>;

type TagBinding = Readonly<{
  id: string;
  attributes: Readonly<{ key: string; value?: string }>;
}>;

type RunSummary = Readonly<{
  attributes: Readonly<{
    "created-at"?: string;
    message?: string | null;
    status: string;
  }>;
  relationships: Readonly<{ workspace: Readonly<{ data: Readonly<{ id: string }> }> }>;
}>;

// The "running" set mirrors the executor's active statuses (worker.ts
// blockerStatuses minus the completed-plan states, which belong to on-hold):
// pre-plan/post-plan task execution, policy phases, queued apply, etc.
const runStatusFilters: Readonly<Record<string, readonly string[]>> = {
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
  const [runStatusError, setRunStatusError] = useState(false);
  const [canManageWorkspaces, setCanManageWorkspaces] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [density, setDensity] = useState<TableDensity>(() => {
    const prefs = getTablePreferences("workspaces");
    return prefs?.density ?? "comfortable";
  });
  const [pinsRevision, setPinsRevision] = useState(0);
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => getSavedViews(orgName));
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
      const statuses = runStatusFilters[statusFilter];
      const query = statuses === undefined
        ? "?page%5Bsize%5D=100"
        : `?page%5Bsize%5D=100&filter%5Bcurrent-run%5D%5Bstatus%5D=${encodeURIComponent(statuses.join(","))}`;
      const [workspaceData, totalsData, projectResult, runResult, canManage] = await Promise.all([
        fetchAllApiPages<Workspace>(`/organizations/${encodeURIComponent(orgName)}/workspaces${query}`, signal),
        // KPIs must reflect the whole org, not the filtered page: fetch the
        // unfiltered list solely for counting when a status filter is active.
        statuses === undefined
          ? Promise.resolve(null)
          : fetchAllApiPages<Workspace>(`/organizations/${encodeURIComponent(orgName)}/workspaces?page%5Bsize%5D=100`, signal)
            .catch((): null => null),
        fetchAllApiPages<Project>(`/organizations/${encodeURIComponent(orgName)}/projects?page%5Bsize%5D=100`, signal)
          .then((data): Readonly<{ data: Project[]; failed: false }> => ({ data, failed: false }))
          .catch((): Readonly<{ data: Project[]; failed: true }> => ({ data: [], failed: true })),
        fetchAllApiPages<RunSummary>(`/organizations/${encodeURIComponent(orgName)}/runs?page%5Bsize%5D=100`, signal)
          .then((data): Readonly<{ data: RunSummary[]; failed: false }> => ({ data, failed: false }))
          .catch((): Readonly<{ data: RunSummary[]; failed: true }> => ({ data: [], failed: true })),
        fetchApi(
          `/organizations/${encodeURIComponent(orgName)}`,
          signal === undefined ? {} : { signal },
        )
          .then((response): boolean =>
            (response as { data?: Organization }).data?.attributes.permissions?.["can-manage-workspaces"] === true)
          .catch((): false => false),
      ]);
      if (signal?.aborted === true) return;
      setWorkspaces(workspaceData);
      if (statuses === undefined || totalsData !== null) {
        const totalsSource = totalsData ?? workspaceData;
        setTotalWorkspaceCount(totalsSource.length);
        setLockedWorkspaceCount(totalsSource.filter((workspace): boolean => workspace.attributes.locked === true).length);
        setTotalsUnavailable(false);
      } else {
        // Unfiltered counting failed under an active filter: keep the last
        // verified org-wide totals and surface that they are stale rather
        // than showing filtered counts as org-wide numbers.
        setTotalsUnavailable(true);
      }
      setProjects(projectResult.data);
      setProjectDataError(projectResult.failed);
      setCanManageWorkspaces(canManage);
      const byWorkspace = new Map<string, RunSummary>();
      for (const run of runResult.data) {
        const workspaceId = run.relationships.workspace.data.id;
        if (!byWorkspace.has(workspaceId)) byWorkspace.set(workspaceId, run);
      }
      setLatestRuns(byWorkspace);
      setRunStatusError(runResult.failed);
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
      return matchesSearch && (projectFilter === "" || projectId === projectFilter);
    });
    // Pinned workspaces float to the top (kanban 26.12); order is otherwise
    // stable (API order).
    return matches.sort((a, b): number => {
      const aPinned = pinnedNames.has(a.attributes.name);
      const bPinned = pinnedNames.has(b.attributes.name);
      if (aPinned === bPinned) return 0;
      return aPinned ? -1 : 1;
    });
  }, [orgName, pinsRevision, projectFilter, search, workspaces]);

  const activeRunsCount = useMemo((): number => {
    let count = 0;
    const runningStatuses = runStatusFilters["running"];
    if (runningStatuses !== undefined) {
      for (const run of latestRuns.values()) {
        if (runningStatuses.includes(run.attributes.status)) {
          count++;
        }
      }
    }
    return count;
  }, [latestRuns]);

  const attentionNeededCount = useMemo((): number => {
    let count = 0;
    const attentionStatuses = runStatusFilters["attention"];
    if (attentionStatuses !== undefined) {
      for (const run of latestRuns.values()) {
        if (
          attentionStatuses.includes(run.attributes.status) ||
          run.attributes.status === "errored"
        ) {
          count++;
        }
      }
    }
    return count;
  }, [latestRuns]);



  const loadTags = async (workspace: Workspace): Promise<void> => {
    try {
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

  const hasFilters = search !== "" || statusFilter !== "" || projectFilter !== "";

  const runDate = (run: RunSummary | undefined): string => {
    const value = run?.attributes["created-at"];
    if (value === undefined) return "";
    const date = new Date(value);
    return formatDateTime(date, "");
  };

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">{orgName} / Workspaces</p>
          <h1 className="text-3xl font-bold tracking-tight">Workspaces</h1>
        </div>
        {canManageWorkspaces && (
          <Button onClick={(): void => { setCreateOpen(true); }}>
            <Plus data-icon="inline-start" />
            New workspace
          </Button>
        )}
      </header>

      {/* Top KPI Metrics Bar */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
          <div className="text-xs font-medium text-muted-foreground">Total Workspaces</div>
          <div className="mt-1 text-2xl font-bold">{totalsUnavailable ? "—" : totalWorkspaceCount}</div>
        </div>
        <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
          <div className="text-xs font-medium text-muted-foreground">Active Runs</div>
          <div className="mt-1 text-2xl font-bold text-primary">{activeRunsCount}</div>
        </div>
        <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
          <div className="text-xs font-medium text-muted-foreground">Attention Needed</div>
          <div className={cn("mt-1 text-2xl font-bold", attentionNeededCount > 0 ? "text-destructive" : "")}>
            {attentionNeededCount}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
          <div className="text-xs font-medium text-muted-foreground">Locked Workspaces</div>
          <div className="mt-1 text-2xl font-bold">{totalsUnavailable ? "—" : lockedWorkspaceCount}</div>
        </div>
      </div>

      {totalsUnavailable && (
        <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50">
          Organization-wide workspace totals are stale: the workspace count could not be refreshed while a status filter is active.
        </p>
      )}

      <section aria-label="Workspace filters" className="grid gap-3 md:grid-cols-[minmax(15rem,1fr)_12rem_14rem_auto_auto]">
        {savedViews.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 md:col-span-5">
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
          aria-label="Search workspaces"
          placeholder="Search by workspace name or tag"
          value={search}
          onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
            setSearch(event.currentTarget.value);
            setActiveViewName("");
          }}
        />
        <Select aria-label="Status filter" value={statusFilter} onValueChange={(value: string): void => {
          setStatusFilter(value);
          setActiveViewName("");
        }}>
          <option value="">All statuses</option>
          <option value="attention">Needs attention</option>
          <option value="errored">Errored</option>
          <option value="running">Running</option>
          <option value="on-hold">On hold</option>
          <option value="completed">Completed</option>
        </Select>
        <Select aria-label="Project filter" value={projectFilter} onValueChange={(value: string): void => {
          setProjectFilter(value);
          setActiveViewName("");
        }}>
          <option value="">All projects</option>
          {projects.map((project): React.JSX.Element => (
            <option key={project.id} value={project.id}>{project.attributes.name}</option>
          ))}
        </Select>
        <Button
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
      </section>

      {runStatusError && (
        <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50">
          Run statuses could not be refreshed. Workspace results and filters are still available.
        </p>
      )}
      {projectDataError && (
        <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50">
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
              <TableHead>Workspace</TableHead>
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
              <TableRow><TableCell colSpan={7} className="p-0"><TableSkeleton rows={4} cols={7} /></TableCell></TableRow>
            ) : loadError !== "" && workspaces.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                  Workspace data is unavailable. Use Try again above to retry.
                </TableCell>
              </TableRow>
            ) : visibleWorkspaces.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                  <p className="font-medium text-foreground">
                    {hasFilters ? "No workspaces match the current filters" : "No workspaces yet"}
                  </p>
                  <p>
                    {hasFilters
                      ? "Clear or adjust the filters to see more workspaces."
                      : canManageWorkspaces
                        ? "Create your first workspace to get started."
                        : "No workspaces are available in this organization."}
                  </p>
                </TableCell>
              </TableRow>
            ) : visibleWorkspaces.map((workspace): React.JSX.Element => (
              <TableRow key={workspace.id}>
                <TableCell>
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
                            ? "fill-amber-400 text-amber-500"
                            : "text-muted-foreground",
                        )}
                        aria-hidden="true"
                      />
                    </Button>
                  </div>
                </TableCell>
                {visibleColumns.includes("repository") && (
                  <TableCell className="max-w-64 truncate">{workspace.attributes["vcs-repo"]?.identifier ?? "None"}</TableCell>
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
                        {runDate(latestRuns.get(workspace.id)) !== "" && (
                          <p className="text-xs text-muted-foreground">{runDate(latestRuns.get(workspace.id))}</p>
                        )}
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
                  value={tagKey}
                  disabled={editingTagKey !== null}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setTagKey(event.currentTarget.value); }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="workspace-tag-value">Value</FieldLabel>
                <Input
                  id="workspace-tag-value"
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
                  value={viewName}
                  autoFocus
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setViewName(event.currentTarget.value); }}
                  placeholder="e.g. Production attention"
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
    </div>
  );
}
