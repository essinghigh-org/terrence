import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Bookmark, Columns3, Pencil, Plus, Rows3, Star, Tags, Trash2, X } from "lucide-react";

import { useSyncedSearchParam } from "@/hooks/useSyncedSearchParam";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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

type Project = Readonly<{ id: string; attributes: Readonly<{ name: string }> }>;

/** Toggleable table columns. "workspace" is always shown. */
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

const WORKSPACE_PAGE_SIZE = 50;
type WorkspacePage = Readonly<{
  data: Workspace[];
  included?: RunSummary[];
  meta?: Readonly<{
    pagination?: Readonly<{ "total-count"?: number; "total-pages"?: number }>;
    "workspace-summary"?: Readonly<{ total: number; locked: number; "run-statuses": Readonly<Record<string, number>> }>;
  }>;
}>;

// The "running" set mirrors the executor's active statuses (worker.ts
// blockerStatuses minus the completed-plan states, which belong to on-hold):
// pre-plan/post-plan task execution, policy phases, queued apply, etc.
// The attention set includes errored runs so the tile count and its
// click-through filter agree (issue #612).
const runStatusFilters = {
  attention: ["policy_soft_failed", "policy_hard_failed", "policy_override", "errored"],
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

// Resolve each workspace through its own current-run relationship so an
// included run without a workspace relationship can never crash the mapping.
function runsByWorkspace(
  source: Readonly<{ workspaces: Workspace[]; runs: RunSummary[] }>,
): ReadonlyMap<string, RunSummary> {
  const runsById = new Map(source.runs.map((run): [string, RunSummary] => [run.id, run]));
  const byWorkspace = new Map<string, RunSummary>();
  for (const workspace of source.workspaces) {
    const currentRun = workspace.relationships?.["current-run"]?.data;
    if (currentRun === null || currentRun === undefined) continue;
    const run = runsById.get(currentRun.id);
    if (run !== undefined) byWorkspace.set(workspace.id, run);
  }
  return byWorkspace;
}

type ResolvedWorkspacePage = Readonly<
  | { kind: "redirect"; page: number }
  | {
    kind: "ready";
    workspaces: Workspace[];
    latestRuns: ReadonlyMap<string, RunSummary>;
    matchingCount: number;
    pageCount: number;
    totalsUnavailable: boolean;
    totalWorkspaceCount: number;
    lockedWorkspaceCount: number;
    runStatusCounts: Readonly<Record<string, number>>;
  }
>;

function readyWorkspacePage(result: WorkspacePage, pages: number): Extract<ResolvedWorkspacePage, { kind: "ready" }> {
  const summary = result.meta?.["workspace-summary"];
  return {
    kind: "ready",
    workspaces: result.data,
    latestRuns: runsByWorkspace({ workspaces: result.data, runs: result.included ?? [] }),
    matchingCount: result.meta?.pagination?.["total-count"] ?? result.data.length,
    pageCount: pages,
    totalsUnavailable: summary === undefined,
    totalWorkspaceCount: summary?.total ?? 0,
    lockedWorkspaceCount: summary?.locked ?? 0,
    runStatusCounts: summary?.["run-statuses"] ?? {},
  };
}

function resolveWorkspacePage(result: WorkspacePage, page: number): ResolvedWorkspacePage {
  const pages = result.meta?.pagination?.["total-pages"] ?? 1;
  if (page > pages && pages > 0) return { kind: "redirect", page: pages };
  if (!Array.isArray(result.data)) throw new Error("The server returned an invalid workspace page.");
  return readyWorkspacePage(result, pages);
}

function WorkspaceNameCell({ workspace, orgName, pinned, onTogglePin }: Readonly<{
  workspace: Workspace;
  orgName: string;
  pinned: boolean;
  onTogglePin: () => void;
}>): React.JSX.Element {
  return (
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
          aria-label={pinned
            ? `Unpin ${workspace.attributes.name}`
            : `Pin ${workspace.attributes.name}`}
          title={pinned
            ? "Unpin from sidebar shortcuts"
            : "Pin to sidebar shortcuts"}
          onClick={onTogglePin}
        >
          <Star
            className={cn(
              "size-3.5",
              pinned
                ? "fill-warning text-warning"
                : "text-muted-foreground",
            )}
            aria-hidden="true"
          />
        </Button>
      </div>
    </TableCell>
  );
}

function WorkspaceTagsCell({ tags }: Readonly<{ tags: readonly string[] }>): React.JSX.Element {
  return (
    <TableCell>
      <div className="flex max-w-56 flex-wrap gap-1">
        {tags.map((tag): React.JSX.Element => (
          <Badge key={tag} variant="secondary" className="max-w-48 truncate">{tag}</Badge>
        ))}
        {tags.length === 0 && <span className="text-muted-foreground">None</span>}
      </div>
    </TableCell>
  );
}

function WorkspaceProjectCell({ projectId, projectName, orgName }: Readonly<{
  projectId: string | undefined;
  projectName: string;
  orgName: string;
}>): React.JSX.Element {
  return (
    <TableCell>
      {projectId === undefined ? (
        projectName
      ) : (
        <Link
          to={`/app/${encodeURIComponent(orgName)}/projects/${encodeURIComponent(projectId)}`}
          className="text-primary hover:underline"
        >
          {projectName}
        </Link>
      )}
    </TableCell>
  );
}

function RunCreatedAt({ created }: Readonly<{ created: string | undefined }>): React.JSX.Element | null {
  if (created === undefined || created === "") return null;
  return (
    <p className="text-xs text-muted-foreground" title={formatDateTime(created, "")}>
      {formatRelativeTime(created)}
    </p>
  );
}

function WorkspaceLatestChangeCell({ run }: Readonly<{ run: RunSummary | undefined }>): React.JSX.Element {
  if (run === undefined) {
    return (
      <TableCell>
        <span className="text-muted-foreground">—</span>
      </TableCell>
    );
  }
  return (
    <TableCell>
      <div className="max-w-64">
        <p className="truncate text-sm">{run.attributes.message ?? "Manual run"}</p>
        <RunCreatedAt created={run.attributes["created-at"]} />
      </div>
    </TableCell>
  );
}

function WorkspaceStatusCell({ run }: Readonly<{ run: RunSummary | undefined }>): React.JSX.Element {
  if (run === undefined) {
    return (
      <TableCell>
        <span className="text-muted-foreground">No runs</span>
      </TableCell>
    );
  }
  return (
    <TableCell>
      <StatusBadge status={run.attributes.status} />
    </TableCell>
  );
}

function WorkspaceManageCell({ workspaceName, canTag, onTags }: Readonly<{
  workspaceName: string;
  canTag: boolean;
  onTags: () => void;
}>): React.JSX.Element {
  return (
    <TableCell className="text-right">
      {canTag ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Manage tags for ${workspaceName}`}
          onClick={onTags}
        >
          <Tags data-icon="inline-start" />
          Tags
        </Button>
      ) : <span className="text-muted-foreground">—</span>}
    </TableCell>
  );
}

function WorkspaceTotalsBar({
  hasFilters,
  totalsUnavailable,
  totalWorkspaceCount,
  activeRunsCount,
  attentionNeededCount,
  lockedWorkspaceCount,
  statusFilter,
  onClearFilters,
  onToggleStatus,
}: Readonly<{
  hasFilters: boolean;
  totalsUnavailable: boolean;
  totalWorkspaceCount: number;
  activeRunsCount: number;
  attentionNeededCount: number;
  lockedWorkspaceCount: number;
  statusFilter: string;
  onClearFilters: () => void;
  onToggleStatus: (status: string) => void;
}>): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <button
        type="button"
        aria-pressed={!hasFilters}
        onClick={onClearFilters}
        className={cn(
          "text-left rounded-xl border bg-card p-4 text-card-foreground shadow-2xs transition-colors hover:border-primary/40 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer",
          !hasFilters && "border-primary/50 bg-primary/5 ring-1 ring-primary/30"
        )}
      >
        <div className="text-xs font-medium text-muted-foreground">Total Workspaces</div>
        <div className="mt-1 tabular-nums text-2xl font-bold">{totalsUnavailable ? "—" : totalWorkspaceCount}</div>
      </button>
      <button
        type="button"
        aria-pressed={statusFilter === "running"}
        onClick={(): void => { onToggleStatus("running"); }}
        className={cn(
          "text-left rounded-xl border bg-card p-4 text-card-foreground shadow-2xs transition-colors hover:border-primary/40 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer",
          statusFilter === "running" && "border-primary/50 bg-primary/5 ring-1 ring-primary/30"
        )}
      >
        <div className="text-xs font-medium text-muted-foreground">Active Runs</div>
        <div className="mt-1 tabular-nums text-2xl font-bold text-primary">{totalsUnavailable ? "—" : activeRunsCount}</div>
      </button>
      <button
        type="button"
        aria-pressed={statusFilter === "attention"}
        onClick={(): void => { onToggleStatus("attention"); }}
        className={cn(
          "text-left rounded-xl border bg-card p-4 text-card-foreground shadow-2xs transition-colors hover:border-destructive/40 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer",
          statusFilter === "attention" && "border-destructive/50 bg-destructive/5 ring-1 ring-destructive/30"
        )}
      >
        <div className="text-xs font-medium text-muted-foreground">Attention Needed</div>
        <div className={cn("mt-1 tabular-nums text-2xl font-bold", !totalsUnavailable && attentionNeededCount > 0 ? "text-destructive" : "")}>
          {totalsUnavailable ? "—" : attentionNeededCount}
        </div>
      </button>
      <button
        type="button"
        aria-pressed={statusFilter === "locked"}
        onClick={(): void => { onToggleStatus("locked"); }}
        className={cn(
          "text-left rounded-xl border bg-card p-4 text-card-foreground shadow-2xs transition-colors hover:border-warning/40 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer",
          statusFilter === "locked" && "border-warning/50 bg-warning/5 ring-1 ring-warning/30"
        )}
      >
        <div className="text-xs font-medium text-muted-foreground">Locked Workspaces</div>
        <div className="mt-1 tabular-nums text-2xl font-bold">{totalsUnavailable ? "—" : lockedWorkspaceCount}</div>
      </button>
    </div>
  );
}

function WorkspaceFilterBar({
  savedViews,
  activeViewName,
  onApplySavedView,
  onDeleteSavedView,
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  projectFilter,
  onProjectFilterChange,
  projects,
  sort,
  onSortChange,
  exportProgress,
  onExport,
  onCancelExport,
  hasFilters,
  onClearFilters,
  onOpenSaveView,
  density,
  onToggleDensity,
  visibleColumns,
  onToggleColumn,
}: Readonly<{
  savedViews: SavedView[];
  activeViewName: string;
  onApplySavedView: (view: SavedView) => void;
  onDeleteSavedView: (name: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  statusFilter: string;
  onStatusFilterChange: (value: string) => void;
  projectFilter: string;
  onProjectFilterChange: (value: string) => void;
  projects: Project[];
  sort: string;
  onSortChange: (value: string) => void;
  exportProgress: number | null;
  onExport: () => void;
  onCancelExport: () => void;
  hasFilters: boolean;
  onClearFilters: () => void;
  onOpenSaveView: () => void;
  density: TableDensity;
  onToggleDensity: () => void;
  visibleColumns: readonly string[];
  onToggleColumn: (columnId: string, checked: boolean) => void;
}>): React.JSX.Element {
  return (
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
                onClick={(): void => { onApplySavedView(view); }}
                aria-pressed={activeViewName === view.name}
              >
                {view.name}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-6 p-0 text-muted-foreground hover:text-destructive"
                aria-label={`Delete saved view ${view.name}`}
                onClick={(): void => { onDeleteSavedView(view.name); }}
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
          onSearchChange(event.currentTarget.value);
        }}
      />
      <div className="w-36 shrink-0">
        <Select id="workspace-status-filter" name="status" aria-label="Status filter" value={statusFilter} onValueChange={(value: string): void => {
          onStatusFilterChange(value);
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
          onProjectFilterChange(value);
        }}>
          <option value="">All projects</option>
          {projects.map((project): React.JSX.Element => (
            <option key={project.id} value={project.id}>{project.attributes.name}</option>
          ))}
        </Select>
      </div>
      <Select aria-label="Workspace sort order" value={sort} onValueChange={onSortChange} className="w-36">
        <option value="name">Name A–Z</option>
        <option value="-name">Name Z–A</option>
      </Select>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="outline" disabled={exportProgress !== null} onClick={onExport}>Export matching workspaces</Button>
        {exportProgress !== null && <>
          <span role="status" className="text-xs">Exported {exportProgress} workspaces…</span>
          <Button size="sm" variant="ghost" onClick={onCancelExport}>Cancel export</Button>
        </>}
        <Button
          size="sm"
          variant="ghost"
          disabled={!hasFilters}
          onClick={onClearFilters}
        >
          <X data-icon="inline-start" />
          Clear
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-label="Save current filters as a view"
          title="Save current filters as a named view"
          onClick={onOpenSaveView}
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
                    onToggleColumn(column.id, checked);
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
          onClick={onToggleDensity}
        >
          <Rows3 data-icon="inline-start" />
          {density === "dense" ? "Dense" : "Comfortable"}
        </Button>
      </div>
    </section>
  );
}

function WorkspaceTableEmptyState({
  tableColumnCount,
  hasFilters,
  canManageWorkspaces,
  onClearFilters,
  onCreate,
}: Readonly<{
  tableColumnCount: number;
  hasFilters: boolean;
  canManageWorkspaces: boolean;
  onClearFilters: () => void;
  onCreate: () => void;
}>): React.JSX.Element {
  return (
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
          {...(hasFilters
            ? { actionLabel: "Clear filters", onAction: onClearFilters }
            : canManageWorkspaces
              // The CTA was missing in exactly the case that needed
              // it most: an organization with no workspaces at all.
              ? {
                  actionLabel: "New workspace",
                  onAction: onCreate,
                  docsHref: "/app/docs/workspaces",
                }
              : { docsHref: "/app/docs/workspaces" })}
        />
      </TableCell>
    </TableRow>
  );
}

function WorkspaceTable({
  visibleColumns,
  tableColumnCount,
  loading,
  loadError,
  hasFilters,
  canManageWorkspaces,
  visibleWorkspaces,
  renderRow,
  matchingCount,
  totalOnPage,
  page,
  pageCount,
  onPrevPage,
  onNextPage,
  pageBusy,
  onRetry,
  density,
  onClearFilters,
  onCreate,
}: Readonly<{
  visibleColumns: readonly string[];
  tableColumnCount: number;
  loading: boolean;
  loadError: string;
  hasFilters: boolean;
  canManageWorkspaces: boolean;
  visibleWorkspaces: readonly Workspace[];
  renderRow: (workspace: Workspace) => React.JSX.Element;
  matchingCount: number;
  totalOnPage: number;
  page: number;
  pageCount: number;
  onPrevPage: () => void;
  onNextPage: () => void;
  pageBusy: boolean;
  onRetry: () => void;
  density: TableDensity;
  onClearFilters: () => void;
  onCreate: () => void;
}>): React.JSX.Element {
  return (
    <>
      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <Table className="w-full" density={density}>
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
            ) : loadError !== "" && visibleWorkspaces.length === 0 ? (
              <TableRow>
                <TableCell colSpan={tableColumnCount}>
                  {/* Pointed at a "Try again" control further up the page that
                      the user may have scrolled past; offer one here. */}
                  <EmptyState
                    compact
                    illustration="interrupted"
                    headingLevel="h3"
                    title="Workspace data is unavailable"
                    description="The list could not be loaded because the connection was interrupted. Try again when the service is reachable."
                    actionLabel="Try again"
                    onAction={onRetry}
                  />
                </TableCell>
              </TableRow>
            ) : visibleWorkspaces.length === 0 ? (
              <WorkspaceTableEmptyState
                tableColumnCount={tableColumnCount}
                hasFilters={hasFilters}
                canManageWorkspaces={canManageWorkspaces}
                onClearFilters={onClearFilters}
                onCreate={onCreate}
              />
            ) : visibleWorkspaces.map(renderRow)}
          </TableBody>
        </Table>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
          <span>{matchingCount} matching workspaces · {totalOnPage} on this page</span>
          <nav aria-label="Workspace pagination" className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={pageBusy || page <= 1} onClick={onPrevPage}>Previous</Button>
            <span aria-current="page">Page {page} of {pageCount}</span>
            <Button variant="ghost" size="sm" disabled={pageBusy || page >= pageCount} onClick={onNextPage}>Next</Button>
          </nav>
        </div>
      </div>
    </>
  );
}

function TagManagerDialog({
  tagWorkspace,
  tagKey,
  onTagKeyChange,
  tagValue,
  onTagValueChange,
  editingTagKey,
  tagBindings,
  savingTag,
  onSubmit,
  onCancelEdit,
  onEditTag,
  onDeleteTag,
  onClose,
}: Readonly<{
  tagWorkspace: Workspace | null;
  tagKey: string;
  onTagKeyChange: (value: string) => void;
  tagValue: string;
  onTagValueChange: (value: string) => void;
  editingTagKey: string | null;
  tagBindings: readonly TagBinding[];
  savingTag: boolean;
  onSubmit: (event: React.SyntheticEvent) => void;
  onCancelEdit: () => void;
  onEditTag: (tag: TagBinding) => void;
  onDeleteTag: (tag: TagBinding) => void;
  onClose: () => void;
}>): React.JSX.Element {
  return (
    <Dialog open={tagWorkspace !== null} onOpenChange={(open: boolean): void => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tags for {tagWorkspace?.attributes.name}</DialogTitle>
          <DialogDescription>Add, update, or remove direct workspace tags.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="workspace-tag-key">Key</FieldLabel>
              <Input
                id="workspace-tag-key"
                name="tag-key"
                autoComplete="off"
                value={tagKey}
                disabled={editingTagKey !== null}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onTagKeyChange(event.currentTarget.value); }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="workspace-tag-value">Value</FieldLabel>
              <Input
                id="workspace-tag-value"
                name="tag-value"
                autoComplete="off"
                value={tagValue}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onTagValueChange(event.currentTarget.value); }}
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            {editingTagKey !== null && (
              <Button
                type="button"
                variant="ghost"
                onClick={onCancelEdit}
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
                      onClick={(): void => { onEditTag(tag); }}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete tag ${tag.attributes.key}`}
                      onClick={(): void => { onDeleteTag(tag); }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {tagBindings.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="py-6 text-center text-sm text-muted-foreground">
                  {/* "No direct tags" assumed the reader knew that tags can
                      also be inherited from a project. Say it instead. */}
                  No tags set on this workspace itself. Tags from its project, if any, still apply.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </DialogContent>
    </Dialog>
  );
}

function SaveViewDialog({
  viewDialogOpen,
  onViewDialogOpenChange,
  viewName,
  onViewNameChange,
  onSubmit,
  onCancel,
}: Readonly<{
  viewDialogOpen: boolean;
  onViewDialogOpenChange: (open: boolean) => void;
  viewName: string;
  onViewNameChange: (value: string) => void;
  onSubmit: (event: React.SyntheticEvent) => void;
  onCancel: () => void;
}>): React.JSX.Element {
  return (
    <Dialog
      open={viewDialogOpen}
      onOpenChange={onViewDialogOpenChange}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save view</DialogTitle>
          <DialogDescription>
            Save the current search, status, and project filters as a named view.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
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
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onViewNameChange(event.currentTarget.value); }}
                placeholder="e.g. Production attention…"
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={viewName.trim() === ""}>Save view</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteTagDialog({
  pendingTagDelete,
  onOpenChange,
  onConfirm,
}: Readonly<{
  pendingTagDelete: TagBinding | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}>): React.JSX.Element {
  return (
    <ConfirmDialog
      open={pendingTagDelete !== null}
      onOpenChange={onOpenChange}
      title="Remove tag?"
      description={pendingTagDelete === null ? undefined : (
        <>
          Tag <strong className="font-mono">{pendingTagDelete.attributes.key}</strong> will be removed
          from this workspace. Runs that filter on this tag will stop matching it.
        </>
      )}
      confirmText="Remove tag"
      confirmVariant="destructive"
      onConfirm={onConfirm}
    />
  );
}

function FirstWorkspaceSection({ canManageWorkspaces, onCreate }: Readonly<{
  canManageWorkspaces: boolean;
  onCreate: () => void;
}>): React.JSX.Element {
  return (
    <section className="rounded-xl border bg-card">
      <EmptyState
        illustration="guide"
        title={canManageWorkspaces ? "Create your first workspace" : "No workspaces yet"}
        description={canManageWorkspaces
          ? "A workspace holds the code, state, and history for one part of your infrastructure. Start with your network, a server, or an application. You can organize workspaces into projects later."
          : "Ask an organization owner to create a workspace or give you access to one."}
        {...(canManageWorkspaces ? { actionLabel: "New workspace", onAction: onCreate } : {})}
        docsHref="/app/docs/workspaces"
      />
      <p className="border-t px-6 py-4 text-center text-sm text-muted-foreground">Bring a Git repository or use your existing Terraform or OpenTofu CLI. Plans require your approval by default.</p>
    </section>
  );
}

function hasActiveFilters(search: string, statusFilter: string, projectFilter: string, activeViewName: string): boolean {
  return search !== "" || statusFilter !== "" || projectFilter !== "" || activeViewName !== "";
}

export function Workspaces(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // Org-wide totals are independent of the status filter; the workspace list
  // itself is server-filtered when one is active (review item 1.9).
  const [totalWorkspaceCount, setTotalWorkspaceCount] = useState(0);
  const [lockedWorkspaceCount, setLockedWorkspaceCount] = useState(0);
  const [totalsUnavailable, setTotalsUnavailable] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectDataError, setProjectDataError] = useState(false);
  const [latestRuns, setLatestRuns] = useState<ReadonlyMap<string, RunSummary>>(new Map());
  const [runStatusCounts, setRunStatusCounts] = useState<Readonly<Record<string, number>>>({});
  const [canManageWorkspaces, setCanManageWorkspaces] = useState(false);
  const [defaultIacBinary, setDefaultIacBinary] = useState("terraform");
  const [defaultTerraformVersion, setDefaultTerraformVersion] = useState("latest");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useSyncedSearchParam("status", "");
  const [projectFilter, setProjectFilter] = useState("");
  const [sort, setSort] = useState("name");
  const filterKey = JSON.stringify([orgName, search, statusFilter, projectFilter, sort]);
  const [pageState, setPageState] = useState({ key: "", number: 1 });
  if (pageState.key !== filterKey) setPageState({ key: filterKey, number: 1 });
  const page = pageState.key === filterKey ? pageState.number : 1;
  const [pageCount, setPageCount] = useState(1);
  const [matchingCount, setMatchingCount] = useState(0);
  const loadController = useRef<AbortController | null>(null);
  const exportController = useRef<AbortController | null>(null);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
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
  // Pending tag removal, confirmed through a dialog (issue #588).
  const [pendingTagDelete, setPendingTagDelete] = useState<TagBinding | null>(null);

  const workspaceQuery = useMemo((): string => {
    const query = new URLSearchParams({ "page[size]": String(WORKSPACE_PAGE_SIZE), sort });
    if (search.trim() !== "") query.set("search[query]", search.trim());
    if (projectFilter !== "") query.set("filter[project][id]", projectFilter);
    if (statusFilter === "locked") query.set("filter[locked]", "true");
    const statuses = statusesForFilter(statusFilter);
    if (statuses !== undefined) query.set("filter[current-run][status]", statuses.join(","));
    return `/organizations/${encodeURIComponent(orgName)}/workspaces?${query}`;
  }, [orgName, projectFilter, search, sort, statusFilter]);

  const loadData = useCallback(async (quiet = false): Promise<void> => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    if (!quiet) { setLoading(true); setWorkspaces([]); }
    setLoadError("");
    try {
      const result = await fetchApi<WorkspacePage>(
        `${workspaceQuery}&page[number]=${page}&include=current_run,workspace_summary`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      const resolved = resolveWorkspacePage(result, page);
      if (resolved.kind === "redirect") {
        setPageState({ key: filterKey, number: resolved.page });
        return;
      }
      setWorkspaces(resolved.workspaces);
      setLatestRuns(resolved.latestRuns);
      setMatchingCount(resolved.matchingCount);
      setPageCount(resolved.pageCount);
      setTotalsUnavailable(resolved.totalsUnavailable);
      setTotalWorkspaceCount(resolved.totalWorkspaceCount);
      setLockedWorkspaceCount(resolved.lockedWorkspaceCount);
      setRunStatusCounts(resolved.runStatusCounts);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setLoadError(error instanceof Error ? error.message : "Could not load workspaces");
      setTotalsUnavailable(true);
    } finally {
      if (!controller.signal.aborted && !quiet) setLoading(false);
    }
  }, [filterKey, page, workspaceQuery]);

  useEffect((): (() => void) => {
    if (orgName !== "") void loadData();
    return (): void => { loadController.current?.abort(); };
  }, [loadData, orgName]);

  // Auxiliary metadata must not hold up the first useful workspace page.
  useEffect((): (() => void) => {
    const controller = new AbortController();
    setProjects([]);
    setCanManageWorkspaces(false);
    setProjectDataError(false);
    void fetchAllApiPages<Project>(`/organizations/${encodeURIComponent(orgName)}/projects?page%5Bsize%5D=100`, controller.signal)
      .then((data): void => { if (!controller.signal.aborted) setProjects(data); })
      .catch((): void => { if (!controller.signal.aborted) setProjectDataError(true); });
    void fetchApi<{ data?: Organization }>(`/organizations/${encodeURIComponent(orgName)}`, { signal: controller.signal })
      .then((response): void => {
        if (controller.signal.aborted) return;
        const attributes = response.data?.attributes;
        setCanManageWorkspaces(attributes?.permissions?.["can-manage-workspaces"] === true);
        setDefaultIacBinary(attributes?.["default-iac-binary"] === "terraform" ? "terraform" : "tofu");
        const version = attributes?.["default-terraform-version"];
        setDefaultTerraformVersion(typeof version === "string" && version !== "" ? version : "latest");
      }).catch((): void => { /* Creation remains unavailable when authorization cannot load. */ });
    return (): void => { controller.abort(); };
  }, [orgName]);

  useEffect((): (() => void) => (): void => { exportController.current?.abort(); }, [orgName]);

  const exportWorkspaces = async (): Promise<void> => {
    exportController.current?.abort();
    const controller = new AbortController();
    exportController.current = controller;
    setExportProgress(0);
    try {
      const query = new URL(workspaceQuery, "http://terrence.local");
      query.searchParams.set("page[size]", "100");
      const result = await fetchAllApiPages<Workspace>(`${query.pathname}${query.search}`, controller.signal, {
        onProgress: (records): void => { if (!controller.signal.aborted) setExportProgress(records); },
      });
      controller.signal.throwIfAborted();
      const blob = new Blob([JSON.stringify({
        organization: orgName,
        exportedAt: new Date().toISOString(),
        workspaces: result.map((workspace): Record<string, unknown> => ({
          id: workspace.id, name: workspace.attributes.name,
          locked: workspace.attributes.locked === true,
          projectId: workspace.relationships?.project?.data?.id ?? null,
          tags: workspace.attributes["tag-names"] ?? [],
        })),
      }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${orgName.replace(/[^a-zA-Z0-9._-]/g, "_")}-workspaces.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error: unknown) {
      if (!controller.signal.aborted) toast.add({ title: "Workspace export failed", description: error instanceof Error ? error.message : "Could not export workspaces", type: "error" });
    } finally {
      if (exportController.current === controller) setExportProgress(null);
    }
  };

  // Persist table density and column visibility.
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
    const pinnedNames = new Set(
      getPinnedWorkspaces().filter((entry): boolean => entry.orgName === orgName).map((entry): string => entry.workspaceName),
    );
    const matches = [...workspaces];
    // Pinned shortcuts float to the top of this page; all other rows retain API order.
    return matches.sort((a, b): number => {
      const aPinned = pinnedNames.has(a.attributes.name);
      const bPinned = pinnedNames.has(b.attributes.name);
      if (aPinned === bPinned) return 0;
      return aPinned ? -1 : 1;
    });
  }, [orgName, pinsRevision, workspaces]);

  const activeRunsCount = runStatusFilters.running.reduce((total, status): number => total + (runStatusCounts[status] ?? 0), 0);
  const attentionNeededCount = runStatusFilters.attention.reduce((total, status): number => total + (runStatusCounts[status] ?? 0), 0);

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

  const startEditTag = (tag: TagBinding): void => {
    setEditingTagKey(tag.attributes.key);
    setTagKey(tag.attributes.key);
    setTagValue(tag.attributes.value ?? "");
  };

  const cancelEditTag = (): void => {
    setEditingTagKey(null);
    setTagKey("");
    setTagValue("");
  };

  const handleTagDeleteOpenChange = (open: boolean): void => {
    if (!open) setPendingTagDelete(null);
  };

  const handleConfirmTagDelete = (): void => {
    if (pendingTagDelete !== null) void deleteTag(pendingTagDelete);
  };

  const handleViewDialogOpenChange = (open: boolean): void => {
    setViewDialogOpen(open);
    if (!open) setViewName("");
  };

  const handleSaveViewSubmit = (event: React.SyntheticEvent): void => {
    event.preventDefault();
    handleSaveView();
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
      await Promise.all([loadTags(tagWorkspace), loadData(true)]);
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
      await Promise.all([loadTags(tagWorkspace), loadData(true)]);
      toast.add({ title: "Tag removed", type: "success" });
    } catch (error: unknown) {
      toast.add({
        title: "Could not remove tag",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    } finally {
      setPendingTagDelete(null);
    }
  };

  const projectName = (workspace: Workspace): string => {
    const projectId = workspace.relationships?.project?.data?.id;
    return projects.find((project): boolean => project.id === projectId)?.attributes.name ?? "Unknown project";
  };

  const hasFilters = hasActiveFilters(search, statusFilter, projectFilter, activeViewName);
  const firstWorkspace = !loading && loadError === "" && workspaces.length === 0 && !hasFilters;
  const clearFilters = (): void => {
    setSearch("");
    setStatusFilter("");
    setProjectFilter("");
    setActiveViewName("");
  };
  const tableColumnCount = WORKSPACE_TABLE_COLUMNS.filter((column): boolean => visibleColumns.includes(column.id)).length + 2;

  const toggleStatusFilter = (status: string): void => {
    setStatusFilter(statusFilter === status ? "" : status);
    setActiveViewName("");
  };

  const toggleColumn = (columnId: string, checked: boolean): void => {
    setVisibleColumns((current): string[] =>
      checked ? [...current, columnId] : current.filter((id: string): boolean => id !== columnId));
  };

  const toggleDensity = (): void => {
    setDensity((current): TableDensity => current === "dense" ? "comfortable" : "dense");
  };

  const renderWorkspaceRow = (workspace: Workspace): React.JSX.Element => (
    <TableRow key={workspace.id}>
      <WorkspaceNameCell
        workspace={workspace}
        orgName={orgName}
        pinned={isWorkspacePinned(orgName, workspace.attributes.name)}
        onTogglePin={(): void => {
          const pinned = isWorkspacePinned(orgName, workspace.attributes.name);
          setWorkspacePinned(orgName, workspace.attributes.name, !pinned);
          setPinsRevision((value: number): number => value + 1);
        }}
      />
      {visibleColumns.includes("repository") && (
        <TableCell className="max-w-64"><WorkspaceRepositoryLink repo={workspace.attributes["vcs-repo"]} /></TableCell>
      )}
      {visibleColumns.includes("tags") && (
        <WorkspaceTagsCell tags={workspace.attributes["tag-names"] ?? []} />
      )}
      {visibleColumns.includes("project") && (
        <WorkspaceProjectCell
          projectId={workspace.relationships?.project?.data?.id}
          projectName={projectName(workspace)}
          orgName={orgName}
        />
      )}
      {visibleColumns.includes("latest-change") && (
        <WorkspaceLatestChangeCell run={latestRuns.get(workspace.id)} />
      )}
      {visibleColumns.includes("status") && (
        <WorkspaceStatusCell run={latestRuns.get(workspace.id)} />
      )}
      <WorkspaceManageCell
        workspaceName={workspace.attributes.name}
        canTag={workspace.attributes.permissions?.["can-update"] === true}
        onTags={(): void => { openTags(workspace); }}
      />
    </TableRow>
  );

  return (
    <PageShell variant="wide">
      <PageHeader
        eyebrow={orgName}
        title="Workspaces"
        description="Review workspace health, current runs, and configuration at a glance."
        action={canManageWorkspaces && !firstWorkspace ? (
          <Button onClick={(): void => { setCreateOpen(true); }}>
            <Plus data-icon="inline-start" />
            New workspace
          </Button>
        ) : undefined}
      />

      {firstWorkspace ? (
        <FirstWorkspaceSection canManageWorkspaces={canManageWorkspaces} onCreate={(): void => { setCreateOpen(true); }} />
      ) : (
      <>
      {/* Organization totals remain visible while filtering. */}
      <WorkspaceTotalsBar
        hasFilters={hasFilters}
        totalsUnavailable={totalsUnavailable}
        totalWorkspaceCount={totalWorkspaceCount}
        activeRunsCount={activeRunsCount}
        attentionNeededCount={attentionNeededCount}
        lockedWorkspaceCount={lockedWorkspaceCount}
        statusFilter={statusFilter}
        onClearFilters={clearFilters}
        onToggleStatus={toggleStatusFilter}
      />

      {totalsUnavailable && (
        <p role="status" className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          Organization-wide workspace totals are unavailable. Try refreshing the list.
        </p>
      )}

      <WorkspaceFilterBar
        savedViews={savedViews}
        activeViewName={activeViewName}
        onApplySavedView={applySavedView}
        onDeleteSavedView={handleDeleteView}
        search={search}
        onSearchChange={(value: string): void => { setSearch(value); setActiveViewName(""); }}
        statusFilter={statusFilter}
        onStatusFilterChange={(value: string): void => { setStatusFilter(value); setActiveViewName(""); }}
        projectFilter={projectFilter}
        onProjectFilterChange={(value: string): void => { setProjectFilter(value); setActiveViewName(""); }}
        projects={projects}
        sort={sort}
        onSortChange={setSort}
        exportProgress={exportProgress}
        onExport={exportWorkspaces}
        onCancelExport={(): void => { exportController.current?.abort(); setExportProgress(null); }}
        hasFilters={hasFilters}
        onClearFilters={clearFilters}
        onOpenSaveView={(): void => { setViewDialogOpen(true); }}
        density={density}
        onToggleDensity={toggleDensity}
        visibleColumns={visibleColumns}
        onToggleColumn={toggleColumn}
      />

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

      <WorkspaceTable
        visibleColumns={visibleColumns}
        tableColumnCount={tableColumnCount}
        loading={loading}
        loadError={loadError}
        hasFilters={hasFilters}
        canManageWorkspaces={canManageWorkspaces}
        visibleWorkspaces={visibleWorkspaces}
        renderRow={renderWorkspaceRow}
        matchingCount={matchingCount}
        totalOnPage={workspaces.length}
        page={page}
        pageCount={pageCount}
        onPrevPage={(): void => { setPageState({ key: filterKey, number: page - 1 }); }}
        onNextPage={(): void => { setPageState({ key: filterKey, number: page + 1 }); }}
        pageBusy={loading}
        onRetry={(): void => { void loadData(); }}
        density={density}
        onClearFilters={clearFilters}
        onCreate={(): void => { setCreateOpen(true); }}
      />

      </>
      )}

      {canManageWorkspaces && (
        <CreateWorkspaceModal
          orgName={orgName}
          defaultIacBinary={defaultIacBinary}
          defaultTerraformVersion={defaultTerraformVersion}
          projects={projects}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(created): void => {
            void loadData();
            void navigate(`/app/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(created.name)}`);
          }}
        />
      )}

      <TagManagerDialog
        tagWorkspace={tagWorkspace}
        tagKey={tagKey}
        onTagKeyChange={setTagKey}
        tagValue={tagValue}
        onTagValueChange={setTagValue}
        editingTagKey={editingTagKey}
        tagBindings={tagBindings}
        savingTag={savingTag}
        onSubmit={saveTag}
        onCancelEdit={cancelEditTag}
        onEditTag={startEditTag}
        onDeleteTag={setPendingTagDelete}
        onClose={(): void => { setTagWorkspace(null); }}
      />

      <SaveViewDialog
        viewDialogOpen={viewDialogOpen}
        onViewDialogOpenChange={handleViewDialogOpenChange}
        viewName={viewName}
        onViewNameChange={setViewName}
        onSubmit={handleSaveViewSubmit}
        onCancel={(): void => { setViewDialogOpen(false); }}
      />
      <DeleteTagDialog
        pendingTagDelete={pendingTagDelete}
        onOpenChange={handleTagDeleteOpenChange}
        onConfirm={handleConfirmTagDelete}
      />
    </PageShell>
  );
}
