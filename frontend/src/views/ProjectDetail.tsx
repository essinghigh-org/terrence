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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { fetchApi } from "@/lib/api";
import { cn } from "@/lib/utils";

export type ProjectSection = "overview" | "workspaces" | "settings" | "variable-sets";

type Project = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    description?: string | null;
    "workspace-count"?: number;
    "team-count"?: number;
    "created-at"?: string;
    permissions?: Readonly<{ "can-update"?: boolean; "can-destroy"?: boolean }>;
  }>;
}>;

type Workspace = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    locked?: boolean;
    "vcs-repo"?: Readonly<{ identifier: string }> | null;
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

const runStatusFilters: Readonly<Record<string, readonly string[]>> = {
  attention: ["policy_soft_failed", "policy_hard_failed", "policy_override"],
  errored: ["errored"],
  running: ["pending", "fetching", "planning", "cost_estimating", "policy_checking", "applying"],
  "on-hold": ["planned", "planned_and_saved"],
  completed: ["applied", "planned_and_finished", "discarded", "canceled"],
};

function runDate(value: string | undefined): string {
  const date = new Date(value ?? "");
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString();
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
        fetchApi(`/projects/${encodeURIComponent(projectId)}`, signal === undefined ? {} : { signal }),
        fetchApi(
          `/organizations/${encodeURIComponent(orgName)}/workspaces?page%5Bsize%5D=100&filter%5Bproject%5D%5Bid%5D=${encodeURIComponent(projectId)}`,
          signal === undefined ? {} : { signal },
        ),
        fetchApi(`/organizations/${encodeURIComponent(orgName)}/runs?page%5Bsize%5D=100`, signal === undefined ? {} : { signal })
          .then((response): RunSummary[] => {
            const data = (response as { data?: unknown }).data;
            return Array.isArray(data) ? data as RunSummary[] : [];
          })
          .catch((): RunSummary[] => []),
        fetchApi(
          `/organizations/${encodeURIComponent(orgName)}/varsets?filter%5Bproject%5D%5Bid%5D=${encodeURIComponent(projectId)}`,
          signal === undefined ? {} : { signal },
        )
          .then((response): VariableSet[] => {
            const data = (response as { data?: unknown }).data;
            return Array.isArray(data) ? data as VariableSet[] : [];
          })
          .catch((): VariableSet[] => []),
      ]);
      if (signal?.aborted === true) return;
      setProject((projectResponse as { data?: Project }).data ?? null);
      const wsData = (workspaceResponse as { data?: unknown }).data;
      setWorkspaces(Array.isArray(wsData) ? wsData as Workspace[] : []);
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

  const saveProject = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (project === null || projectId === undefined) return;
    if (name.trim() === "") {
      setFormError("Name is required");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const response = await fetchApi(`/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            id: projectId,
            type: "projects",
            attributes: {
              name: name.trim(),
              description: description.trim() === "" ? null : description.trim(),
            },
          },
        }),
      }) as { data?: Project };
      setProject(response.data ?? project);
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
    try {
      await navigator.clipboard.writeText(project.id);
      toast.add({ title: "Project ID copied", type: "success" });
    } catch {
      toast.add({ title: "Could not copy project ID", type: "error" });
    }
  };

  const tabs: readonly { readonly id: ProjectSection; readonly label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "workspaces", label: "Workspaces" },
    { id: "settings", label: "Settings" },
  ];
  const isSettings = activeSection === "settings" || activeSection === "variable-sets";

  return (
    <div className="w-full max-w-full">
      {/* Breadcrumbs */}
      <nav
        aria-label="Breadcrumb"
        className="mb-2 flex flex-wrap items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <Link to={`${orgPath}/projects`} className="min-w-0 break-words hover:underline">
          Projects
        </Link>
        <span aria-hidden="true">/</span>
        {project === null ? (
          <span className="text-foreground">Loading…</span>
        ) : isSettings ? (
          <>
            <Link to={projectPath} className="min-w-0 break-words hover:underline">{project.attributes.name}</Link>
            <span aria-hidden="true">/</span>
            <span className="text-foreground">Settings</span>
          </>
        ) : (
          <span className="min-w-0 break-words text-foreground">{project.attributes.name}</span>
        )}
      </nav>

      {/* Header */}
      <div className="mb-8 flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-3">
            <h1 className="truncate text-3xl font-bold tracking-tight text-foreground">
              {project === null ? "Project" : project.attributes.name}
            </h1>
            {project?.attributes["workspace-count"] !== undefined && (
              <Badge variant="secondary">{project.attributes["workspace-count"]} workspace{project.attributes["workspace-count"] === 1 ? "" : "s"}</Badge>
            )}
          </div>
          <p className="text-[15px] text-muted-foreground">
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
        <div className="flex shrink-0 flex-wrap items-center gap-3">
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
      </div>

      {sectionProp === undefined && (
        <div className="mb-6 border-b">
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
                  "border-b-2 pb-3 text-sm font-medium transition-colors",
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

      <div className="mt-6">
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
                  <p className="mt-1 text-sm">{project?.attributes["created-at"] !== undefined ? new Date(project.attributes["created-at"]).toLocaleDateString() : "—"}</p>
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
                  <p className="px-5 py-8 text-center text-sm text-muted-foreground">No workspaces in this project yet.</p>
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
                          <TableCell className="text-muted-foreground">{workspace.attributes["vcs-repo"]?.identifier ?? "None"}</TableCell>
                          <TableCell>
                            {latestRuns.get(workspace.id) === undefined ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <div className="max-w-56">
                                <p className="truncate text-sm">{latestRuns.get(workspace.id)?.attributes.message ?? "Manual run"}</p>
                                {runDate(latestRuns.get(workspace.id)?.attributes["created-at"]) !== "" && (
                                  <p className="text-xs text-muted-foreground">{runDate(latestRuns.get(workspace.id)?.attributes["created-at"])}</p>
                                )}
                              </div>
                            )}
                          </TableCell>
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
                <p className="px-5 py-8 text-center text-sm text-muted-foreground">No workspaces in this project yet.</p>
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
                        <TableCell className="text-muted-foreground">{workspace.attributes["vcs-repo"]?.identifier ?? "None"}</TableCell>
                        <TableCell>
                          {latestRuns.get(workspace.id) === undefined ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <div className="max-w-56">
                              <p className="truncate text-sm">{latestRuns.get(workspace.id)?.attributes.message ?? "Manual run"}</p>
                              {runDate(latestRuns.get(workspace.id)?.attributes["created-at"]) !== "" && (
                                <p className="text-xs text-muted-foreground">{runDate(latestRuns.get(workspace.id)?.attributes["created-at"])}</p>
                              )}
                            </div>
                          )}
                        </TableCell>
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
              <CardDescription>Edit project name and description.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={saveProject} className="flex flex-col gap-4">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="project-edit-name">Project name</FieldLabel>
                    <Input
                      id="project-edit-name"
                      value={name}
                      onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setName(event.currentTarget.value); }}
                      placeholder="my-project"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="project-edit-description">Project description (Optional)</FieldLabel>
                    <Input
                      id="project-edit-description"
                      value={description}
                      onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setDescription(event.currentTarget.value); }}
                      placeholder="What is this project for?"
                    />
                  </Field>
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
                  value={name}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setName(event.currentTarget.value); }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="project-edit-dialog-description">Description</FieldLabel>
                <Input
                  id="project-edit-dialog-description"
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
                  value={vsName}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setVsName(event.currentTarget.value); }}
                  placeholder="Shared project variables"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="project-vs-description">Description (Optional)</FieldLabel>
                <Input
                  id="project-vs-description"
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
    </div>
  );
}

// Re-export for route usage: keep the runStatusFilters import from being tree-shaken in tests.
export const projectRunStatusFilters = runStatusFilters;
