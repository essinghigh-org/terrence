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

type ProjectDataBundle = {
  project: Project | null;
  workspaces: Workspace[];
  runs: RunSummary[];
  varsets: VariableSet[];
};

async function fetchProjectData(orgName: string, projectId: string, signal: Readonly<AbortSignal> | undefined): Promise<ProjectDataBundle> {
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
  // SAFETY: the project endpoint returns the JSON:API project envelope.
  return {
    project: projectResponse.data ?? null,
    workspaces: workspaceResponse,
    runs: runResponse,
    varsets: varsetResponse,
  };
}

function ProjectHeader({ project, orgPath, projectPath, canUpdate, activeSection, isSettings, onEditRequest }: Readonly<{
  project: Project | null;
  orgPath: string;
  projectPath: string;
  canUpdate: boolean;
  activeSection: ProjectSection;
  isSettings: boolean;
  onEditRequest: (project: Project) => void;
}>): React.JSX.Element {
  const crumbs: readonly BreadcrumbItem[] = [
    { label: "Projects", to: `${orgPath}/projects` },
    ...(project === null
      ? [{ label: "Loading…" }]
      : isSettings
        ? [{ label: project.attributes.name, to: projectPath }, { label: "Settings" }]
        : [{ label: project.attributes.name }]),
  ];
  return (
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
            <CopyProjectId projectId={project.id} />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {project !== null && canUpdate && activeSection !== "settings" && (
          <Button
            variant="outline"
            onClick={(): void => { onEditRequest(project); }}
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
  );
}

function CopyProjectId({ projectId }: Readonly<{ projectId: string }>): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label="Copy project ID"
      onClick={(): void => {
        void copyTextToClipboard(projectId).then((didCopy): void => {
          toast.add(didCopy ? { title: "Project ID copied", type: "success" } : { title: "Could not copy project ID", type: "error" });
        });
      }}
    >
      <Copy aria-hidden="true" />
    </Button>
  );
}

function ProjectTabs({ tabs, activeSection, isSettings, onSelect }: Readonly<{
  tabs: readonly { readonly id: ProjectSection; readonly label: string }[];
  activeSection: ProjectSection;
  isSettings: boolean;
  onSelect: (tabId: ProjectSection) => void;
}>): React.JSX.Element {
  return (
    <div className="border-b">
      <nav aria-label="Project sections" className="flex flex-wrap gap-x-6 gap-y-2">
        {tabs.map((tab): React.JSX.Element => (
          <button
            type="button"
            key={tab.id}
            onClick={(): void => { onSelect(tab.id); }}
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
  );
}

function WorkspaceTable({ orgPath, workspaces, latestRuns }: Readonly<{
  orgPath: string;
  workspaces: readonly Workspace[];
  latestRuns: ReadonlyMap<string, RunSummary>;
}>): React.JSX.Element {
  return (
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
  );
}

function ProjectOverview({ project, orgPath, projectPath, workspaces, latestRuns }: Readonly<{
  project: Project | null;
  orgPath: string;
  projectPath: string;
  workspaces: readonly Workspace[];
  latestRuns: ReadonlyMap<string, RunSummary>;
}>): React.JSX.Element {
  return (
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
              headingLevel="h3"
              title="No workspaces in this project yet"
              description="A workspace holds the code, state and run history for one piece of infrastructure."
              actionLabel="Add a workspace"
              actionHref={`${orgPath}/workspaces`}
              docsHref="/app/docs/workspaces"
            />
          ) : (
            <WorkspaceTable orgPath={orgPath} workspaces={workspaces.slice(0, 10)} latestRuns={latestRuns} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ProjectWorkspacesTab({ orgPath, workspaces, latestRuns }: Readonly<{
  orgPath: string;
  workspaces: readonly Workspace[];
  latestRuns: ReadonlyMap<string, RunSummary>;
}>): React.JSX.Element {
  return (
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
            headingLevel="h3"
            title="No workspaces in this project yet"
            description="A workspace holds the code, state and run history for one piece of infrastructure."
            actionLabel="Add a workspace"
            actionHref={`${orgPath}/workspaces`}
            docsHref="/app/docs/workspaces"
          />
        ) : (
          <WorkspaceTable orgPath={orgPath} workspaces={workspaces} latestRuns={latestRuns} />
        )}
      </CardContent>
    </Card>
  );
}

function ProjectVariableSets({ orgPath, projectId, variableSets, onNew }: Readonly<{
  orgPath: string;
  projectId: string | undefined;
  variableSets: readonly VariableSet[];
  onNew: () => void;
}>): React.JSX.Element {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>Variable sets</CardTitle>
          <CardDescription>
            Reusable bundles of variables, shared by every workspace in this project.
          </CardDescription>
        </div>
        <Button type="button" onClick={onNew}>
          <Plus data-icon="inline-start" />
          New variable set
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {variableSets.length === 0 ? (
          <EmptyState
            compact
            headingLevel="h3"
            title="No variable sets yet"
            description="A variable set is a reusable bundle of Terraform variables and environment variables that several workspaces can share, so credentials and common settings live in one place."
            actionLabel="New variable set"
            onAction={onNew}
            docsHref={`${orgPath}/variable-sets`}
          />
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
  );
}

function ProjectSettingsForm({ name, onNameChange, description, onDescriptionChange, executionModeOverridden, onExecutionModeOverriddenChange, defaultExecutionMode, onDefaultExecutionModeChange, defaultAgentPoolId, onDefaultAgentPoolIdChange, agentPools, agentPoolsLoading, agentPoolsError, formError, saving, canUpdate, canDestroy, onSubmit, onDeleteRequest }: Readonly<{
  name: string;
  onNameChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  executionModeOverridden: boolean;
  onExecutionModeOverriddenChange: (overridden: boolean) => void;
  defaultExecutionMode: ExecutionMode;
  onDefaultExecutionModeChange: (mode: ExecutionMode) => void;
  defaultAgentPoolId: string;
  onDefaultAgentPoolIdChange: (value: string) => void;
  agentPools: readonly AgentPoolResource[];
  agentPoolsLoading: boolean;
  agentPoolsError: string;
  formError: string;
  saving: boolean;
  canUpdate: boolean;
  canDestroy: boolean;
  onSubmit: (event: React.SyntheticEvent) => Promise<void>;
  onDeleteRequest: () => void;
}>): React.JSX.Element {
  const agentPoolOptions: AgentPoolResource[] = defaultAgentPoolId !== ""
    && !agentPools.some((pool): boolean => pool.id === defaultAgentPoolId)
    ? [
        {
          id: defaultAgentPoolId,
          attributes: { name: `Configured pool (${defaultAgentPoolId})` },
        },
        ...agentPools,
      ]
    : [...agentPools];
  return (
    <Card>
      <CardHeader>
        <CardTitle>General settings</CardTitle>
        <CardDescription>
          Set the default execution mode and agent pool for workspaces in this project. Workspaces can override these defaults.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-edit-name">Project name</FieldLabel>
              <Input
                id="project-edit-name"
                name="project-name"
                autoComplete="off"
                spellCheck={false}
                value={name}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onNameChange(event.currentTarget.value); }}
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
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onDescriptionChange(event.currentTarget.value); }}
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
                    onExecutionModeOverriddenChange(false);
                    onDefaultAgentPoolIdChange("");
                    return;
                  }
                  const mode = parseExecutionMode(value);
                  onExecutionModeOverriddenChange(true);
                  onDefaultExecutionModeChange(mode);
                  if (mode !== "agent") onDefaultAgentPoolIdChange("");
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
                  onValueChange={onDefaultAgentPoolIdChange}
                  disabled={!canUpdate || agentPoolsLoading}
                >
                  <SelectItem value="">Select an agent pool</SelectItem>
                  {agentPoolOptions.map((pool): React.JSX.Element => (
                    <SelectItem key={pool.id} value={pool.id}>{pool.attributes.name}</SelectItem>
                  ))}
                </Select>
                <FieldDescription>
                  Agent-mode workspaces use an available agent from this pool unless they override the pool.
                </FieldDescription>
                {agentPoolsLoading && <span className="text-xs text-muted-foreground">Loading agent pools…</span>}
                {agentPoolsError !== "" && <FieldError>{agentPoolsError}</FieldError>}
              </Field>
            )}
          </FieldGroup>
          {formError !== "" && <FieldError>{formError}</FieldError>}
          <div className="flex gap-2">
            <Button type="submit" disabled={saving || !canUpdate}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
            {canDestroy && (
              <Button type="button" variant="destructive" onClick={onDeleteRequest}>
                <Trash2 data-icon="inline-start" />
                Delete project
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ProjectEditDialog({ open, onOpenChange, name, onNameChange, description, onDescriptionChange, formError, saving, onSubmit, onCancel }: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onNameChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  formError: string;
  saving: boolean;
  onSubmit: (event: React.SyntheticEvent) => Promise<void>;
  onCancel: () => void;
}>): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit project</DialogTitle>
          <DialogDescription>Update the project name or description.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-edit-dialog-name">Name</FieldLabel>
              <Input
                id="project-edit-dialog-name"
                name="project-name"
                autoComplete="off"
                spellCheck={false}
                value={name}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onNameChange(event.currentTarget.value); }}
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
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onDescriptionChange(event.currentTarget.value); }}
              />
            </Field>
          </FieldGroup>
          {formError !== "" && <FieldError>{formError}</FieldError>}
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectDeleteConfirm({ open, onOpenChange, projectName, deleting, onConfirm }: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string | undefined;
  deleting: boolean;
  onConfirm: () => Promise<void>;
}>): React.JSX.Element {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete project"
      description={`Permanently delete "${projectName ?? "this project"}"? Only empty projects can be deleted.`}
      confirmText={deleting ? "Deleting…" : "Delete project"}
      onConfirm={onConfirm}
    />
  );
}

function ProjectCreateVsDialog({ open, onOpenChange, projectName, vsName, onVsNameChange, vsDescription, onVsDescriptionChange, vsError, savingVs, onSubmit, onCancel }: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string | undefined;
  vsName: string;
  onVsNameChange: (value: string) => void;
  vsDescription: string;
  onVsDescriptionChange: (value: string) => void;
  vsError: string;
  savingVs: boolean;
  onSubmit: (event: React.SyntheticEvent) => Promise<void>;
  onCancel: () => void;
}>): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new project variable set</DialogTitle>
          <DialogDescription>
            This variable set is owned by {projectName ?? "this project"} and applies to
            its workspaces.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-vs-name">Name</FieldLabel>
              <Input
                id="project-vs-name"
                name="variable-set-name"
                autoComplete="off"
                spellCheck={false}
                value={vsName}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onVsNameChange(event.currentTarget.value); }}
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
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onVsDescriptionChange(event.currentTarget.value); }}
                placeholder="What is this variable set for?"
              />
            </Field>
          </FieldGroup>
          {vsError !== "" && <FieldError>{vsError}</FieldError>}
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={savingVs || vsName.trim() === ""}>
              {savingVs ? "Creating…" : "Create variable set"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function resolveActiveSection(sectionProp: ProjectSection | undefined, embeddedSection: ProjectSection): ProjectSection {
  return sectionProp ?? embeddedSection;
}

function projectPermissions(project: Project | null): Readonly<{ canUpdate: boolean; canDestroy: boolean }> {
  const permissions = project?.attributes.permissions;
  return {
    canUpdate: permissions?.["can-update"] === true,
    canDestroy: permissions?.["can-destroy"] === true,
  };
}

function shouldQueryAgentPools(canUpdate: boolean, overridden: boolean, mode: ExecutionMode): boolean {
  return canUpdate && overridden && mode === "agent";
}

function ProjectSectionBody({ activeSection, projectId, project, orgPath, projectPath, workspaces, latestRuns, variableSets, name, onNameChange, description, onDescriptionChange, executionModeOverridden, onExecutionModeOverriddenChange, defaultExecutionMode, onDefaultExecutionModeChange, defaultAgentPoolId, onDefaultAgentPoolIdChange, agentPools, agentPoolsLoading, agentPoolsError, formError, saving, canUpdate, canDestroy, onSubmitSettings, onDeleteRequest, onNewVariableSet }: Readonly<{
  activeSection: ProjectSection;
  projectId: string | undefined;
  project: Project | null;
  orgPath: string;
  projectPath: string;
  workspaces: readonly Workspace[];
  latestRuns: ReadonlyMap<string, RunSummary>;
  variableSets: readonly VariableSet[];
  name: string;
  onNameChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  executionModeOverridden: boolean;
  onExecutionModeOverriddenChange: (overridden: boolean) => void;
  defaultExecutionMode: ExecutionMode;
  onDefaultExecutionModeChange: (mode: ExecutionMode) => void;
  defaultAgentPoolId: string;
  onDefaultAgentPoolIdChange: (value: string) => void;
  agentPools: readonly AgentPoolResource[];
  agentPoolsLoading: boolean;
  agentPoolsError: string;
  formError: string;
  saving: boolean;
  canUpdate: boolean;
  canDestroy: boolean;
  onSubmitSettings: (event: React.SyntheticEvent) => Promise<void>;
  onDeleteRequest: () => void;
  onNewVariableSet: () => void;
}>): React.JSX.Element {
  if (activeSection === "overview") {
    return (
      <ProjectOverview
        project={project}
        orgPath={orgPath}
        projectPath={projectPath}
        workspaces={workspaces}
        latestRuns={latestRuns}
      />
    );
  }
  if (activeSection === "workspaces") {
    return (
      <ProjectWorkspacesTab
        orgPath={orgPath}
        workspaces={workspaces}
        latestRuns={latestRuns}
      />
    );
  }
  if (activeSection === "notifications" && projectId !== undefined) {
    return <WorkspaceNotifications projectId={projectId} projectWorkspaces={workspaces} />;
  }
  if (activeSection === "variable-sets") {
    return (
      <ProjectVariableSets
        orgPath={orgPath}
        projectId={projectId}
        variableSets={variableSets}
        onNew={onNewVariableSet}
      />
    );
  }
  return (
    <ProjectSettingsForm
      name={name}
      onNameChange={onNameChange}
      description={description}
      onDescriptionChange={onDescriptionChange}
      executionModeOverridden={executionModeOverridden}
      onExecutionModeOverriddenChange={onExecutionModeOverriddenChange}
      defaultExecutionMode={defaultExecutionMode}
      onDefaultExecutionModeChange={onDefaultExecutionModeChange}
      defaultAgentPoolId={defaultAgentPoolId}
      onDefaultAgentPoolIdChange={onDefaultAgentPoolIdChange}
      agentPools={agentPools}
      agentPoolsLoading={agentPoolsLoading}
      agentPoolsError={agentPoolsError}
      formError={formError}
      saving={saving}
      canUpdate={canUpdate}
      canDestroy={canDestroy}
      onSubmit={onSubmitSettings}
      onDeleteRequest={onDeleteRequest}
    />
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
  const activeSection = resolveActiveSection(sectionProp, embeddedSection);

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
      const bundle = await fetchProjectData(orgName, projectId, signal);
      if (signal?.aborted === true) return;
      const loadedProject = bundle.project;
      setProject(loadedProject);
      if (loadedProject !== null) {
        setName(loadedProject.attributes.name);
        setDescription(loadedProject.attributes.description ?? "");
        setDefaultExecutionMode(parseExecutionMode(loadedProject.attributes["default-execution-mode"]));
        setExecutionModeOverridden(loadedProject.attributes["setting-overwrites"]?.["execution-mode"] === true);
        setDefaultAgentPoolId(projectAgentPoolId(loadedProject));
      }
      setWorkspaces(bundle.workspaces);
      setVariableSets(bundle.varsets);
      const byWorkspace = new Map<string, RunSummary>();
      for (const run of bundle.runs) {
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

  const { canUpdate, canDestroy } = projectPermissions(project);
  const projectName = project?.attributes.name;
  const agentPoolsState = useAgentPools(
    orgName,
    shouldQueryAgentPools(canUpdate, executionModeOverridden, defaultExecutionMode),
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

  const handleSelectTab = (tabId: ProjectSection): void => {
    setEmbeddedSection(tabId);
    const target = tabId === "overview"
      ? projectPath
      : tabId === "workspaces"
        ? `${projectPath}/workspaces`
        : projectSettingsPath;
    void navigate(target);
  };

  const handleEditRequest = (editingProject: Project): void => {
    setName(editingProject.attributes.name);
    setDescription(editingProject.attributes.description ?? "");
    setFormError("");
    setEditOpen(true);
  };

  const handleNewVariableSet = (): void => {
    setVsName("");
    setVsDescription("");
    setVsError("");
    setCreateVsOpen(true);
  };

  const tabs: readonly { readonly id: ProjectSection; readonly label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "workspaces", label: "Workspaces" },
    { id: "settings", label: "Settings" },
  ];
  const isSettings = activeSection === "settings" || activeSection === "variable-sets" || activeSection === "notifications";

  // Settings sections are forms, so they take the narrower form measure —
  // the same rule WorkspaceDetail follows, so the two detail pages don't
  // disagree about how wide a settings form should be.
  return (
    <PageShell variant={isSettings ? "form" : "wide"}>
      <ProjectHeader
        project={project}
        orgPath={orgPath}
        projectPath={projectPath}
        canUpdate={canUpdate}
        activeSection={activeSection}
        isSettings={isSettings}
        onEditRequest={handleEditRequest}
      />

      {sectionProp === undefined && (
        <ProjectTabs
          tabs={tabs}
          activeSection={activeSection}
          isSettings={isSettings}
          onSelect={handleSelectTab}
        />
      )}

      <div>
        {loading ? (
          <Spinner className="mx-auto my-12" />
        ) : loadError !== "" && project === null ? (
          <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Could not load project: {loadError}
            <Button size="sm" variant="outline" className="ml-3" onClick={(): void => { void loadData(); }}>Try again</Button>
          </div>
        ) : (
          <ProjectSectionBody
            activeSection={activeSection}
            projectId={projectId}
            project={project}
            orgPath={orgPath}
            projectPath={projectPath}
            workspaces={workspaces}
            latestRuns={latestRuns}
            variableSets={variableSets}
            name={name}
            onNameChange={setName}
            description={description}
            onDescriptionChange={setDescription}
            executionModeOverridden={executionModeOverridden}
            onExecutionModeOverriddenChange={setExecutionModeOverridden}
            defaultExecutionMode={defaultExecutionMode}
            onDefaultExecutionModeChange={setDefaultExecutionMode}
            defaultAgentPoolId={defaultAgentPoolId}
            onDefaultAgentPoolIdChange={setDefaultAgentPoolId}
            agentPools={agentPoolsState.pools}
            agentPoolsLoading={agentPoolsState.loading}
            agentPoolsError={agentPoolsState.error}
            formError={formError}
            saving={saving}
            canUpdate={canUpdate}
            canDestroy={canDestroy}
            onSubmitSettings={saveProject}
            onDeleteRequest={(): void => { setDeleteOpen(true); }}
            onNewVariableSet={handleNewVariableSet}
          />
        )}
      </div>

      <ProjectEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        name={name}
        onNameChange={setName}
        description={description}
        onDescriptionChange={setDescription}
        formError={formError}
        saving={saving}
        onSubmit={saveProject}
        onCancel={(): void => { setEditOpen(false); }}
      />

      <ProjectDeleteConfirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        projectName={projectName}
        deleting={deleting}
        onConfirm={deleteProject}
      />

      <ProjectCreateVsDialog
        open={createVsOpen}
        onOpenChange={setCreateVsOpen}
        projectName={projectName}
        vsName={vsName}
        onVsNameChange={setVsName}
        vsDescription={vsDescription}
        onVsDescriptionChange={setVsDescription}
        vsError={vsError}
        savingVs={savingVs}
        onSubmit={createVariableSet}
        onCancel={(): void => { setCreateVsOpen(false); }}
      />
    </PageShell>
  );
}

/** @public Compatibility export retained for route and test consumers. */
export const projectRunStatusFilters = runStatusFilters;
