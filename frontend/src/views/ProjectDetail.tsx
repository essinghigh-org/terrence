import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Breadcrumbs, type BreadcrumbItem } from "@/components/Breadcrumbs";
import { EmptyState } from "@/components/EmptyState";
import { PageShell } from "@/components/PageHeader";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { fetchApi, fetchAllApiPages } from "@/lib/api";
import { cn, copyTextToClipboard, formatDate, formatDateTime, formatRelativeTime } from "@/lib/utils";
import { useAgentPools } from "@/hooks/useAgentPools";
import type { AgentPoolResource } from "@/hooks/useAgentPools";
import { WorkspaceNotifications } from "@/components/WorkspaceNotifications";
import { WorkspaceRepositoryLink } from "@/components/WorkspaceRepositoryLink";
import { isString } from "@/lib/type-guards";

/** Read the data array from a JSON:API list envelope, or [] when absent. */
function dataArray<T>(response: unknown): T[] {
  // SAFETY: JSON:API list endpoints return { data: [...] }; Array.isArray
  // guards the shape and non-array payloads degrade to [].
  const data = (response as { data?: unknown }).data;
  // SAFETY: guarded by Array.isArray above; elements are consumed through
  // the typed caller contract.
  return Array.isArray(data) ? data as T[] : [];
}

export type ProjectSection = "overview" | "workspaces" | "settings" | "variable-sets" | "notifications";

type Project = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    description?: string | null;
    "workspace-count"?: number;
    "team-count"?: number;
    "default-execution-mode"?: string;
    "setting-overwrites"?: Readonly<Record<string, boolean>>;
    "created-at"?: string;
    permissions?: Readonly<{ "can-update"?: boolean; "can-destroy"?: boolean }>;
  }>;
  relationships?: Readonly<{
    "default-agent-pool"?: Readonly<{ data?: Readonly<{ id: string }> | null }>;
  }>;
}>;

type ExecutionMode = "agent" | "local" | "remote";

function parseExecutionMode(value: string | undefined): ExecutionMode {
  return value === "agent" || value === "local" ? value : "remote";
}

function projectAgentPoolId(project: Project | null): string {
  return project?.relationships?.["default-agent-pool"]?.data?.id ?? "";
}

type Workspace = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    locked?: boolean;
    "vcs-repo"?: Readonly<{
      identifier: string;
      "github-app-installation-id"?: string | null;
    }> | null;
    "tag-names"?: readonly string[];
  }>;
}>;

type RunSummary = Readonly<{
  id?: string;
  attributes: Readonly<{ "created-at"?: string; message?: string | null; status: string }>;
  relationships: Readonly<{ workspace: Readonly<{ data: Readonly<{ id: string }> }> }>;
}>;

type VariableSet = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    description?: string | null;
    "var-count"?: number;
    "workspace-count"?: number;
    "project-count"?: number;
    global?: boolean;
    "parent-project-id"?: string | null;
  }>;
}>;

const runStatusFilters = {
  attention: ["policy_soft_failed", "policy_hard_failed", "policy_override"],
  errored: ["errored"],
  running: ["pending", "fetching", "planning", "cost_estimating", "policy_checking", "applying"],
  "on-hold": ["planned", "planned_and_saved"],
  completed: ["applied", "planned_and_finished", "discarded", "canceled"],
};

function LatestChange({ run }: Readonly<{ run: RunSummary | undefined }>): React.JSX.Element {
  if (run === undefined) return <span className="text-muted-foreground">—</span>;
  const createdAt = run.attributes["created-at"];
  return (
    <div className="max-w-56">
      <p className="truncate text-sm">{run.attributes.message ?? "Manual run"}</p>
      {createdAt !== undefined && createdAt !== "" && (
        <p className="text-xs text-muted-foreground" title={formatDateTime(createdAt, "")}>
          {formatRelativeTime(createdAt)}
        </p>
      )}
    </div>
  );
}

export function ProjectDetail({
  section: sectionProp,
}: Readonly<{ section?: ProjectSection }>): React.JSX.Element {
  const { orgName: rawOrgName, projectId } = useParams<{ orgName: string; projectId: string }>();
  const orgName = rawOrgName ?? "";
  const navigate = useNavigate();
  const orgPath = `/app/${encodeURIComponent(orgName)}`;
  const projectPath = `${orgPath}/projects/${encodeURIComponent(projectId ?? "")}`;
  const projectSettingsPath = `${projectPath}/settings`;

  const [project, setProject] = useState<Project | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [latestRuns, setLatestRuns] = useState<ReadonlyMap<string, RunSummary>>(new Map());
  const [variableSets, setVariableSets] = useState<VariableSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [embeddedSection, setEmbeddedSection] = useState<ProjectSection>("overview");
  const activeSection = sectionProp ?? embeddedSection;

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultExecutionMode, setDefaultExecutionMode] = useState<ExecutionMode>("remote");
  const [executionModeOverridden, setExecutionModeOverridden] = useState(false);
  const [defaultAgentPoolId, setDefaultAgentPoolId] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Create project variable set state
  const [createVsOpen, setCreateVsOpen] = useState(false);
  const [vsName, setVsName] = useState("");
  const [vsDescription, setVsDescription] = useState("");
  const [vsError, setVsError] = useState("");
  const [savingVs, setSavingVs] = useState(false);

  const loadData = useCallback(async (signal?: Readonly<AbortSignal>): Promise<void> => {
    if (projectId === undefined) return;
    setLoading(true);
    setLoadError("");
    try {
      const [projectResponse, workspaceResponse, runResponse, varsetResponse] = await Promise.all([
        fetchApi<{ data?: Project }>(`/projects/${encodeURIComponent(projectId)}`, signal === undefined ? {} : { signal }),
        // Load EVERY workspace in the project: a project with more than one
        // page of workspaces must still expose all of them for the exclusion
        // editor (the notification section renders before/after this load).
        fetchAllApiPages<Workspace>(
          `/organizations/${encodeURIComponent(orgName)}/workspaces?page%5Bsize%5D=100&filter%5Bproject%5D%5Bid%5D=${encodeURIComponent(projectId)}`,
          signal,
        ),
        fetchApi(`/organizations/${encodeURIComponent(orgName)}/runs?page%5Bsize%5D=100`, signal === undefined ? {} : { signal })
          .then((response): RunSummary[] => dataArray<RunSummary>(response))
          .catch((): RunSummary[] => []),
        fetchApi(
          `/organizations/${encodeURIComponent(orgName)}/varsets?filter%5Bproject%5D%5Bid%5D=${encodeURIComponent(projectId)}`,
          signal === undefined ? {} : { signal },
        )
          .then((response): VariableSet[] => dataArray<VariableSet>(response))
          .catch((): VariableSet[] => []),
      ]);
      if (signal?.aborted === true) return;
      // SAFETY: the project endpoint returns the JSON:API project envelope.
      const loadedProject = projectResponse.data ?? null;
      setProject(loadedProject);
      if (loadedProject !== null) {
        setName(loadedProject.attributes.name);
        setDescription(loadedProject.attributes.description ?? "");
        setDefaultExecutionMode(parseExecutionMode(loadedProject.attributes["default-execution-mode"]));
        setExecutionModeOverridden(loadedProject.attributes["setting-overwrites"]?.["execution-mode"] === true);
        setDefaultAgentPoolId(projectAgentPoolId(loadedProject));
      }
      setWorkspaces(workspaceResponse);
      setVariableSets(varsetResponse);
      const byWorkspace = new Map<string, RunSummary>();
      for (const run of runResponse) {
        const wsId = run.relationships.workspace.data.id;
        if (!byWorkspace.has(wsId)) byWorkspace.set(wsId, run);
      }
      setLatestRuns(byWorkspace);
    } catch (error: unknown) {
      if (signal?.aborted === true) return;
      setLoadError(error instanceof Error ? error.message : "Could not load project");
    } finally {
      if (signal?.aborted !== true) setLoading(false);
    }
  }, [orgName, projectId]);

  useEffect((): (() => void) => {
    const controller = new AbortController();
    if (projectId !== undefined) void loadData(controller.signal);
    return (): void => { controller.abort(); };
  }, [loadData, projectId]);

  useEffect((): void => {
    setEditOpen(false);
    setDeleteOpen(false);
  }, [projectId]);

  const canUpdate = project?.attributes.permissions?.["can-update"] === true;
  const canDestroy = project?.attributes.permissions?.["can-destroy"] === true;
  const agentPoolsState = useAgentPools(
    orgName,
    canUpdate && executionModeOverridden && defaultExecutionMode === "agent",
  );

  const saveProject = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (project === null || !canUpdate || !isString(projectId)) return;
    if (name.trim() === "") {
      setFormError("Name is required");
      return;
    }
    if (executionModeOverridden && defaultExecutionMode === "agent" && defaultAgentPoolId === "") {
      setFormError("Select an agent pool for agent execution mode");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      // SAFETY: the endpoint contract returns { data: Project } on success.
      const response = await fetchApi(`/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            id: projectId,
            type: "projects",
            attributes: {
              name: name.trim(),
              description: description.trim() === "" ? null : description.trim(),
              "default-execution-mode": defaultExecutionMode,
              "setting-overwrites": { "execution-mode": executionModeOverridden },
            },
            relationships: executionModeOverridden
              ? {
                  "default-agent-pool": {
                    data: defaultExecutionMode === "agent"
                      ? { id: defaultAgentPoolId, type: "agent-pools" }
                      : null,
                  },
                }
              : {},
          },
        }),
      }) as { data?: Project };
      const savedProject = response.data ?? project;
      setProject(savedProject);
      setDefaultExecutionMode(parseExecutionMode(savedProject.attributes["default-execution-mode"]));
      setExecutionModeOverridden(savedProject.attributes["setting-overwrites"]?.["execution-mode"] === true);
      setDefaultAgentPoolId(projectAgentPoolId(savedProject));
      setEditOpen(false);
      toast.add({ title: "Project updated", type: "success" });
    } catch (error: unknown) {
      setFormError(error instanceof Error ? error.message : "Failed to save project");
    } finally {
      setSaving(false);
    }
  };

  const deleteProject = async (): Promise<void> => {
    if (projectId === undefined) return;
    setDeleting(true);
    try {
      await fetchApi(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
      toast.add({ title: "Project deleted", type: "success" });
      void navigate(`${orgPath}/projects`);
    } catch (error: unknown) {
      toast.add({
        title: "Could not delete project",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
      setDeleteOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  const createVariableSet = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (projectId === undefined || vsName.trim() === "") return;
    setSavingVs(true);
    setVsError("");
    try {
      // SAFETY: the endpoint contract returns { data: VariableSet } on success.
      const response = await fetchApi(`/organizations/${encodeURIComponent(orgName)}/varsets`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "varsets",
            attributes: {
              name: vsName.trim(),
              description: vsDescription.trim() !== "" ? vsDescription.trim() : null,
              "parent-project-id": projectId,
            },
          },
        }),
      }) as { data?: VariableSet };
      const created = response.data;
      if (created !== undefined) {
        setVariableSets((current: VariableSet[]): VariableSet[] =>
          [...current, created].sort((a, b): number =>
            a.attributes.name.localeCompare(b.attributes.name)));
      }
      setCreateVsOpen(false);
      setVsName("");
      setVsDescription("");
      toast.add({ title: "Project variable set created", type: "success" });
    } catch (error: unknown) {
      setVsError(error instanceof Error ? error.message : "Failed to create variable set");
    } finally {
      setSavingVs(false);
    }
  };

  const copyProjectId = async (): Promise<void> => {
    if (project === null) return;
    if (await copyTextToClipboard(project.id)) {
      toast.add({ title: "Project ID copied", type: "success" });
      return;
    }
    toast.add({ title: "Could not copy project ID", type: "error" });
  };

  const tabs: readonly { readonly id: ProjectSection; readonly label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "workspaces", label: "Workspaces" },
    { id: "settings", label: "Settings" },
  ];
  const isSettings = activeSection === "settings" || activeSection === "variable-sets" || activeSection === "notifications";
  const crumbs: readonly BreadcrumbItem[] = [
    { label: "Projects", to: `${orgPath}/projects` },
    ...(project === null
      ? [{ label: "Loading…" }]
      : isSettings
        ? [{ label: project.attributes.name, to: projectPath }, { label: "Settings" }]
        : [{ label: project.attributes.name }]),
  ];
  const agentPoolOptions: AgentPoolResource[] = defaultAgentPoolId !== ""
    && !agentPoolsState.pools.some((pool): boolean => pool.id === defaultAgentPoolId)
    ? [
        {
          id: defaultAgentPoolId,
          attributes: { name: `Configured pool (${defaultAgentPoolId})` },
        },
        ...agentPoolsState.pools,
      ]
    : agentPoolsState.pools;

  // Settings sections are forms, so they take the narrower form measure —
  // the same rule WorkspaceDetail follows, so the two detail pages don't
  // disagree about how wide a settings form should be.
  return (
    <PageShell variant={isSettings ? "form" : "wide"}>
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
        <div className="min-w-0">
          <Breadcrumbs items={crumbs} />
          <div className="flex items-center gap-3">
            <h1 className="truncate text-3xl font-bold tracking-tight text-foreground">
              {project === null ? "Project" : project.attributes.name}
            </h1>
            {project?.attributes["workspace-count"] !== undefined && (
              <Badge variant="secondary">{project.attributes["workspace-count"]} workspace{project.attributes["workspace-count"] === 1 ? "" : "s"}</Badge>
            )}
          </div>
          <p className="mt-1 max-w-3xl text-pretty text-sm text-muted-foreground">
            {project?.attributes.description ?? "No description provided."}
          </p>
          {project !== null && (
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <span>ID:</span>
              <code className="select-all font-mono">{project.id}</code>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Copy project ID"
                onClick={(): void => { void copyProjectId(); }}
              >
                <Copy aria-hidden="true" />
              </Button>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canUpdate && activeSection !== "settings" && (
            <Button
              variant="outline"
              onClick={(): void => {
                setName(project.attributes.name);
                setDescription(project.attributes.description ?? "");
                setFormError("");
                setEditOpen(true);
              }}
            >
              <Pencil data-icon="inline-start" />
              Edit project
            </Button>
          )}
          <Link to={`${projectPath}/workspaces`} className={buttonVariants()}>
            <Plus data-icon="inline-start" />
            View workspaces
          </Link>
        </div>
      </header>

      {sectionProp === undefined && (
        <div className="border-b">
          <nav aria-label="Project sections" className="flex flex-wrap gap-x-6 gap-y-2">
            {tabs.map((tab): React.JSX.Element => (
              <button
                type="button"
                key={tab.id}
                onClick={(): void => {
                  setEmbeddedSection(tab.id);
                  const target = tab.id === "overview"
                    ? projectPath
                    : tab.id === "workspaces"
                      ? `${projectPath}/workspaces`
                      : projectSettingsPath;
                  void navigate(target);
                }}
                aria-label={tab.label.toLowerCase()}
                aria-current={isSettings && tab.id === "settings" ? "page" : activeSection === tab.id ? "page" : undefined}
                className={cn(
                  "rounded-sm border-b-2 pb-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  (isSettings && tab.id === "settings") || activeSection === tab.id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      )}

      <div>
        {loading ? (
          <Spinner className="mx-auto my-12" />
        ) : loadError !== "" && project === null ? (
          <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Could not load project: {loadError}
            <Button size="sm" variant="outline" className="ml-3" onClick={(): void => { void loadData(); }}>Try again</Button>
          </div>
        ) : activeSection === "overview" ? (
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Project details</CardTitle>
                <CardDescription>Organize workspaces under this project.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-3">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Workspaces</p>
                  <p className="mt-1 text-2xl font-bold">{project?.attributes["workspace-count"] ?? 0}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Teams</p>
                  <p className="mt-1 text-2xl font-bold">{project?.attributes["team-count"] ?? 0}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Created</p>
                  <p className="mt-1 text-sm">{formatDate(project?.attributes["created-at"])}</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Workspaces recently updated</CardTitle>
                <CardDescription>
                  <Link to={`${projectPath}/workspaces`} className="text-primary hover:underline">View all workspaces</Link>
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {workspaces.length === 0 ? (
                  <EmptyState
                    compact
                    illustration="empty"
                  title="No workspaces in this project yet"
                    description="Create a workspace in this project to manage its infrastructure."
                    docsHref="/app/docs/workspaces"
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Workspace name</TableHead>
                        <TableHead>Repository</TableHead>
                        <TableHead>Latest change</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {workspaces.slice(0, 10).map((workspace): React.JSX.Element => (
                        <TableRow key={workspace.id}>
                          <TableCell>
                            <Link
                              to={`${orgPath}/workspaces/${encodeURIComponent(workspace.attributes.name)}`}
                              className="font-semibold text-primary hover:underline"
                            >
                              {workspace.attributes.name}
                            </Link>
                            {workspace.attributes.locked === true && <Badge variant="outline" className="ml-2">Locked</Badge>}
                          </TableCell>
                          <TableCell><WorkspaceRepositoryLink repo={workspace.attributes["vcs-repo"]} /></TableCell>
                          <TableCell><LatestChange run={latestRuns.get(workspace.id)} /></TableCell>
                          <TableCell>
                            {latestRuns.get(workspace.id) === undefined
                              ? <span className="text-muted-foreground">No runs</span>
                              : <StatusBadge status={latestRuns.get(workspace.id)?.attributes.status} />}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        ) : activeSection === "workspaces" ? (
          <Card>
            <CardHeader>
              <CardTitle>Workspaces</CardTitle>
              <CardDescription>{workspaces.length} workspace{workspaces.length === 1 ? "" : "s"} in this project.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {workspaces.length === 0 ? (
                <EmptyState
                  compact
                  illustration="empty"
                  title="No workspaces in this project yet"
                  description="Create a workspace in this project to manage its infrastructure."
                  docsHref="/app/docs/workspaces"
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Workspace name</TableHead>
                      <TableHead>Repository</TableHead>
                      <TableHead>Latest change</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {workspaces.map((workspace): React.JSX.Element => (
                      <TableRow key={workspace.id}>
                        <TableCell>
                          <Link
                            to={`${orgPath}/workspaces/${encodeURIComponent(workspace.attributes.name)}`}
                            className="font-semibold text-primary hover:underline"
                          >
                            {workspace.attributes.name}
                          </Link>
                          {workspace.attributes.locked === true && <Badge variant="outline" className="ml-2">Locked</Badge>}
                        </TableCell>
                        <TableCell><WorkspaceRepositoryLink repo={workspace.attributes["vcs-repo"]} /></TableCell>
                        <TableCell><LatestChange run={latestRuns.get(workspace.id)} /></TableCell>
                        <TableCell>
                          {latestRuns.get(workspace.id) === undefined
                            ? <span className="text-muted-foreground">No runs</span>
                            : <StatusBadge status={latestRuns.get(workspace.id)?.attributes.status} />}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        ) : activeSection === "notifications" && projectId !== undefined ? (
          <WorkspaceNotifications projectId={projectId} projectWorkspaces={workspaces} />
        ) : activeSection === "variable-sets" ? (
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <CardTitle>Variable sets</CardTitle>
                <CardDescription>
                  Project-owned variable sets and organization variable sets applied to this project.
                </CardDescription>
              </div>
              <Button
                type="button"
                onClick={(): void => {
                  setVsName("");
                  setVsDescription("");
                  setVsError("");
                  setCreateVsOpen(true);
                }}
              >
                <Plus data-icon="inline-start" />
                New variable set
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {variableSets.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-muted-foreground">
                  No variable sets are applied to this project. Create a project variable set, or apply
                  one from the{" "}
                  <Link to={`${orgPath}/variable-sets`} className="text-primary hover:underline">organization Variable sets page</Link>.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Scope</TableHead>
                      <TableHead>Variables</TableHead>
                      <TableHead>Workspaces</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {variableSets.map((vs): React.JSX.Element => (
                      <TableRow key={vs.id}>
                        <TableCell className="font-medium">
                          <Link to={`${orgPath}/variable-sets`} className="text-primary hover:underline">
                            {vs.attributes.name}
                          </Link>
                        </TableCell>
                        <TableCell>
                          {vs.attributes["parent-project-id"] === projectId
                            ? <Badge variant="secondary">This project</Badge>
                            : vs.attributes.global === true
                              ? <Badge variant="outline">Global</Badge>
                              : <Badge variant="outline">Applied</Badge>}
                        </TableCell>
                        <TableCell><Badge variant="secondary">{vs.attributes["var-count"] ?? 0}</Badge></TableCell>
                        <TableCell><Badge variant="secondary">{vs.attributes["workspace-count"] ?? 0}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>General settings</CardTitle>
              <CardDescription>
                Set the default execution mode and agent pool for workspaces in this project. Workspaces can override these defaults.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={saveProject} className="flex flex-col gap-4">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="project-edit-name">Project name</FieldLabel>
                    <Input
                      id="project-edit-name"
                      name="project-name"
                      autoComplete="off"
                      spellCheck={false}
                      value={name}
                      onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setName(event.currentTarget.value); }}
                      placeholder="my-project"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="project-edit-description">Project description (Optional)</FieldLabel>
                    <Input
                      id="project-edit-description"
                      name="project-description"
                      autoComplete="off"
                      spellCheck={false}
                      value={description}
                      onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setDescription(event.currentTarget.value); }}
                      placeholder="What is this project for?"
                    />
                  </Field>
                  <Field data-disabled={!canUpdate}>
                    <FieldLabel htmlFor="project-default-execution-mode">Default execution mode</FieldLabel>
                    <Select
                      id="project-default-execution-mode"
                      name="default-execution-mode"
                      value={executionModeOverridden ? defaultExecutionMode : "inherit"}
                      onValueChange={(value: string): void => {
                        if (value === "inherit") {
                          setExecutionModeOverridden(false);
                          setDefaultAgentPoolId("");
                          return;
                        }
                        const mode = parseExecutionMode(value);
                        setExecutionModeOverridden(true);
                        setDefaultExecutionMode(mode);
                        if (mode !== "agent") setDefaultAgentPoolId("");
                      }}
                      disabled={!canUpdate}
                    >
                      <SelectItem value="inherit">Use organization default</SelectItem>
                      <SelectItem value="remote">Remote</SelectItem>
                      <SelectItem value="local">Local</SelectItem>
                      <SelectItem value="agent">Agent</SelectItem>
                    </Select>
                    <FieldDescription>
                      Use the organization default, or override execution for workspaces in this project.
                    </FieldDescription>
                  </Field>
                  {executionModeOverridden && defaultExecutionMode === "agent" && (
                    <Field data-disabled={!canUpdate} data-invalid={formError !== "" && defaultAgentPoolId === ""}>
                      <FieldLabel htmlFor="project-default-agent-pool">Default agent pool</FieldLabel>
                      <Select
                        id="project-default-agent-pool"
                        name="default-agent-pool"
                        value={defaultAgentPoolId}
                        onValueChange={setDefaultAgentPoolId}
                        disabled={!canUpdate || agentPoolsState.loading}
                      >
                        <SelectItem value="">Select an agent pool</SelectItem>
                        {agentPoolOptions.map((pool): React.JSX.Element => (
                          <SelectItem key={pool.id} value={pool.id}>{pool.attributes.name}</SelectItem>
                        ))}
                      </Select>
                      <FieldDescription>
                        Agent-mode workspaces use an available agent from this pool unless they override the pool.
                      </FieldDescription>
                      {agentPoolsState.loading && <span className="text-xs text-muted-foreground">Loading agent pools…</span>}
                      {agentPoolsState.error !== "" && <FieldError>{agentPoolsState.error}</FieldError>}
                    </Field>
                  )}
                </FieldGroup>
                {formError !== "" && <FieldError>{formError}</FieldError>}
                <div className="flex gap-2">
                  <Button type="submit" disabled={saving || !canUpdate}>
                    {saving ? "Saving…" : "Save changes"}
                  </Button>
                  {canDestroy && (
                    <Button type="button" variant="destructive" onClick={(): void => { setDeleteOpen(true); }}>
                      <Trash2 data-icon="inline-start" />
                      Delete project
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit project</DialogTitle>
            <DialogDescription>Update the project name or description.</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveProject}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="project-edit-dialog-name">Name</FieldLabel>
                <Input
                  id="project-edit-dialog-name"
                  name="project-name"
                  autoComplete="off"
                  spellCheck={false}
                  value={name}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setName(event.currentTarget.value); }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="project-edit-dialog-description">Description</FieldLabel>
                <Input
                  id="project-edit-dialog-description"
                  name="project-description"
                  autoComplete="off"
                  spellCheck={false}
                  value={description}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setDescription(event.currentTarget.value); }}
                />
              </Field>
            </FieldGroup>
            {formError !== "" && <FieldError>{formError}</FieldError>}
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={(): void => { setEditOpen(false); }}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete project"
        description={`Permanently delete "${project?.attributes.name ?? "this project"}"? Only empty projects can be deleted.`}
        confirmText={deleting ? "Deleting…" : "Delete project"}
        onConfirm={async (): Promise<void> => deleteProject()}
      />

      {/* Create project variable set dialog */}
      <Dialog open={createVsOpen} onOpenChange={setCreateVsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a new project variable set</DialogTitle>
            <DialogDescription>
              This variable set is owned by {project?.attributes.name ?? "this project"} and applies to
              its workspaces.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={createVariableSet}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="project-vs-name">Name</FieldLabel>
                <Input
                  id="project-vs-name"
                  name="variable-set-name"
                  autoComplete="off"
                  spellCheck={false}
                  value={vsName}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setVsName(event.currentTarget.value); }}
                  placeholder="Shared project variables"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="project-vs-description">Description (Optional)</FieldLabel>
                <Input
                  id="project-vs-description"
                  name="variable-set-description"
                  autoComplete="off"
                  spellCheck={false}
                  value={vsDescription}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setVsDescription(event.currentTarget.value); }}
                  placeholder="What is this variable set for?"
                />
              </Field>
            </FieldGroup>
            {vsError !== "" && <FieldError>{vsError}</FieldError>}
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={(): void => { setCreateVsOpen(false); }}>Cancel</Button>
              <Button type="submit" disabled={savingVs || vsName.trim() === ""}>
                {savingVs ? "Creating…" : "Create variable set"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

/** @public Compatibility export retained for route and test consumers. */
export const projectRunStatusFilters = runStatusFilters;
