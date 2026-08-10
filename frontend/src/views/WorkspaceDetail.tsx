import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link, useLocation, useNavigate } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button, buttonVariants } from "../components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { toast } from "../components/ui/toast";
import {
  WorkspaceHealth,
  WorkspaceRunTriggers,
  WorkspaceSshKey,
} from "../components/WorkspaceConnections";
import { WorkspaceNotifications } from "../components/WorkspaceNotifications";
import { WorkspaceSettings } from "../components/WorkspaceSettings";
import { WorkspaceTeamAccess } from "../components/WorkspaceTeamAccess";
import { WorkspaceVariables } from "../components/WorkspaceVariables";
import { WorkspacePolicySets } from "../components/WorkspacePolicySets";
import { WorkspaceResources } from "../components/WorkspaceResources";
import { WorkspaceConfigurationVersions } from "../components/WorkspaceConfigurationVersions";
import { WorkspaceVcs } from "../components/WorkspaceVcs";
import { WorkspaceRunTasks } from "../components/WorkspaceRunTasks";
import { WorkspaceRetention } from "../components/WorkspaceRetention";
import { WorkspaceDestruction } from "../components/WorkspaceDestruction";
import { RunDetail } from "./RunDetail";
import { RunList } from "./RunList";
import { StateHistory } from "./StateHistory";
import { Play, Lock, LockOpen, Info, CheckCircle2, Copy } from "lucide-react";
import { HelpTooltip } from "@/components/ui/help-tooltip";
import { cn } from "../lib/utils";
import { formatDate, formatDateTime } from "../lib/utils";

export type WorkspaceSection =
  | "overview"
  | "run-detail"
  | "runs"
  | "states"
  | "variables"
  | "team-access"
  | "notifications"
  | "webhooks"
  | "policy-sets"
  | "run-tasks"
  | "run-triggers"
  | "configuration-versions"
  | "ssh-key"
  | "vcs"
  | "health"
  | "retention"
  | "settings"
  | "locking"
  | "destruction";

type Workspace = {
  id: string;
  attributes: {
    name: string;
    locked?: boolean;
    "locked-reason"?: string | null;
    description?: string | null;
    "owned-by-type"?: "team" | "user" | "service" | null;
    "owned-by-id"?: string | null;
    "contact-email"?: string | null;
    "execution-mode"?: string;
    "iac-binary"?: string;
    "terraform-version"?: string;
    "auto-apply"?: boolean;
    "created-at"?: string;
    permissions?: {
      "can-lock"?: boolean;
      "can-force-delete"?: boolean;
      "can-manage-run-tasks"?: boolean;
      "can-queue-run"?: boolean;
      "can-read-state-versions"?: boolean;
      "can-write-state-versions"?: boolean;
      "can-read-variable"?: boolean;
      "can-unlock"?: boolean;
      "can-update"?: boolean;
      "can-update-variable"?: boolean;
    };
    [key: string]: unknown;
  };
  relationships?: {
    project?: { data: { id: string; type: string } | null };
    "ssh-key"?: { data: { id: string; type: string } | null };
    [key: string]: unknown;
  };
}

type RunSummary = {
  id?: string;
  attributes: {
    "created-at"?: string;
    message?: string | null;
    "resource-additions"?: number;
    "resource-changes"?: number;
    "resource-destructions"?: number;
    source?: string;
    status: string;
    [key: string]: unknown;
  };
}

export function WorkspaceDetail({
  section,
}: Readonly<{ readonly section?: WorkspaceSection }>): React.JSX.Element {
  const { orgName, runId, workspaceName } = useParams<{
    orgName: string;
    runId: string;
    workspaceName: string;
  }>();
  const location = useLocation();
  const navigate = useNavigate();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [latestRun, setLatestRun] = useState<RunSummary | null>(null);
  const [latestRunLoading, setLatestRunLoading] = useState(true);
  const [latestRunError, setLatestRunError] = useState(false);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [togglingLock, setTogglingLock] = useState(false);
  const [lockDialogOpen, setLockDialogOpen] = useState(false);
  const [unlockDialogOpen, setUnlockDialogOpen] = useState(false);
  const [lockReason, setLockReason] = useState("");
  const [embeddedSection, setEmbeddedSection] = useState<WorkspaceSection>("overview");
  const activeSection = section ?? embeddedSection;
  const activeWorkspaceId = useRef<string | null>(null);
  const workspaceRequest = useRef<AbortController | null>(null);
  const latestRunRequest = useRef<AbortController | null>(null);
  const projectId = workspace?.relationships?.project?.data?.id;

  const loadLatestRun = useCallback(async (
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    try {
      const runs = await fetchApi(
        `/api/v2/workspaces/${workspaceId}/runs?page[size]=1`,
        { signal },
      ) as { data: unknown };
      if (signal.aborted || activeWorkspaceId.current !== workspaceId) return;
      setLatestRun(Array.isArray(runs.data) ? (runs.data[0] as RunSummary | undefined) ?? null : null);
      setLatestRunLoading(false);
      setLatestRunError(false);
    } catch {
      if (!signal.aborted && activeWorkspaceId.current === workspaceId) {
        setLatestRunLoading(false);
        setLatestRunError(true);
      }
    }
  }, []);

  const loadWorkspace = useCallback(async (): Promise<void> => {
    workspaceRequest.current?.abort();
    latestRunRequest.current?.abort();
    const controller = new AbortController();
    workspaceRequest.current = controller;
    setLoading(true);
    setLoadError("");
    try {
      const data = await fetchApi(
        `/organizations/${encodeURIComponent(orgName ?? "")}/workspaces/${encodeURIComponent(workspaceName ?? "")}`,
        { signal: controller.signal },
      ) as { data: Workspace };
      if (controller.signal.aborted || workspaceRequest.current !== controller) return;
      if (activeWorkspaceId.current !== data.data.id) {
        activeWorkspaceId.current = data.data.id;
        setLatestRun(null);
        setLatestRunLoading(true);
        setLatestRunError(false);
      }
      setWorkspace(data.data);
    } catch (error: unknown) {
      if (controller.signal.aborted || workspaceRequest.current !== controller) return;
      activeWorkspaceId.current = null;
      setWorkspace(null);
      setLoadError(error instanceof Error ? error.message : "Could not load workspace");
    } finally {
      if (!controller.signal.aborted && workspaceRequest.current === controller) {
        setLoading(false);
      }
    }
  }, [orgName, workspaceName]);

  useEffect((): (() => void) => {
    void loadWorkspace();
    return (): void => {
      workspaceRequest.current?.abort();
      latestRunRequest.current?.abort();
    };
  }, [loadWorkspace]);

  useEffect((): (() => void) | undefined => {
    if (workspace === null || activeSection !== "overview") return undefined;
    let timer: number | undefined;
    const controller = new AbortController();
    latestRunRequest.current?.abort();
    latestRunRequest.current = controller;
    const refresh = async (): Promise<void> => {
      await loadLatestRun(workspace.id, controller.signal);
      if (!controller.signal.aborted) {
        timer = window.setTimeout((): void => { void refresh(); }, 5000);
      }
    };
    void refresh();
    return (): void => {
      controller.abort();
      if (latestRunRequest.current === controller) latestRunRequest.current = null;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeSection, loadLatestRun, workspace]);

  useEffect((): (() => void) | undefined => {
    setProjectName(null);
    if (projectId === undefined || activeSection !== "overview") return undefined;
    const controller = new AbortController();
    void fetchApi(`/projects/${encodeURIComponent(projectId)}`, { signal: controller.signal })
      .then((response: unknown): void => {
        if (controller.signal.aborted) return;
        const name = (response as { data?: { attributes?: { name?: unknown } } }).data
          ?.attributes?.name;
        setProjectName(typeof name === "string" && name !== "" ? name : "");
      })
      .catch((): void => {
        if (!controller.signal.aborted) setProjectName("");
      });
    return (): void => { controller.abort(); };
  }, [activeSection, projectId]);

  function handleLock(): void {
    if (workspace == null || togglingLock) return;
    const canToggle = workspace.attributes.locked === true
      ? workspace.attributes.permissions?.["can-unlock"] === true
      : workspace.attributes.permissions?.["can-lock"] === true;
    if (!canToggle) return;
    if (workspace.attributes.locked === true) {
      setUnlockDialogOpen(true);
    } else {
      setLockReason("");
      setLockDialogOpen(true);
    }
  }

  async function submitLock(): Promise<void> {
    if (workspace == null || togglingLock || workspace.attributes.locked === true) return;
    setTogglingLock(true);
    try {
      await fetchApi(`/workspaces/${workspace.id}/actions/lock`, {
        method: "POST",
        body: JSON.stringify({ reason: lockReason.trim() }),
      });
      setLockDialogOpen(false);
      setLockReason("");
      void loadWorkspace();
      toast.add({ title: "Workspace locked", type: "success" });
    } catch {
      toast.add({ title: "Failed to lock workspace", type: "error" });
    } finally {
      setTogglingLock(false);
    }
  }

  async function submitUnlock(): Promise<void> {
    if (workspace == null || togglingLock || workspace.attributes.locked !== true) return;
    setTogglingLock(true);
    try {
      await fetchApi(`/workspaces/${workspace.id}/actions/unlock`, { method: "POST" });
      setUnlockDialogOpen(false);
      void loadWorkspace();
      toast.add({ title: "Workspace unlocked", type: "success" });
    } catch {
      toast.add({ title: "Failed to unlock workspace", type: "error" });
    } finally {
      setTogglingLock(false);
    }
  }

  async function handleCopyWorkspaceId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(workspace?.id ?? "");
      toast.add({ title: "Workspace ID copied", type: "success" });
    } catch {
      toast.add({ title: "Could not copy workspace ID", type: "error" });
    }
  }

  if (loading) return (
    <div role="status" aria-label="Loading workspace" className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="h-3 w-32 animate-pulse rounded bg-muted" />
        <div className="h-9 w-64 animate-pulse rounded bg-muted" />
        <div className="h-4 w-96 max-w-full animate-pulse rounded bg-muted" />
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="h-48 animate-pulse rounded-md border bg-muted/50 xl:col-span-2" />
        <div className="h-48 animate-pulse rounded-md border bg-muted/50" />
      </div>
    </div>
  );
  if (workspace == null) {
    return (
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-5 text-sm text-red-800">
        <p className="font-medium">Could not load workspace</p>
        <p className="mt-1">{loadError !== "" ? loadError : "Workspace not found"}</p>
        <Button className="mt-3" variant="outline" onClick={(): void => { void loadWorkspace(); }}>
          Try again
        </Button>
      </div>
    );
  }

  const createdAt = workspace.attributes["created-at"];
  const latestRunStatus = latestRun?.attributes.status.replace(/_/g, " ");
  const latestRunSucceeded = latestRunStatus === "applied" || latestRunStatus === "planned and finished";
  const latestRunCreatedAt = latestRun?.attributes["created-at"];
  const latestRunCounts = latestRun?.attributes;
  const orgPath = `/app/${encodeURIComponent(orgName ?? "")}`;
  const workspacePath = `${orgPath}/workspaces/${encodeURIComponent(workspaceName ?? "")}`;
  const latestRunPath = latestRun?.id === undefined
    ? null
    : `${workspacePath}/runs/${encodeURIComponent(latestRun.id)}`;
  const canQueueRun = workspace.attributes.permissions?.["can-queue-run"] === true;
  const canUpdate = workspace.attributes.permissions?.["can-update"] === true;
  const canReadStateVersions =
    workspace.attributes.permissions?.["can-read-state-versions"] === true;
  const canWriteStateVersions =
    workspace.attributes.permissions?.["can-write-state-versions"] === true;
  const canReadVariable = workspace.attributes.permissions?.["can-read-variable"] === true;
  const inaccessibleDataSection =
    (activeSection === "states" && !canReadStateVersions)
    || (activeSection === "variables" && !canReadVariable);
  const updateOnlySection = [
    "notifications",
    "run-triggers",
    "configuration-versions",
    "ssh-key",
    "team-access",
  ].includes(activeSection);
  const canToggleLock = workspace.attributes.locked === true
    ? workspace.attributes.permissions?.["can-unlock"] === true
    : workspace.attributes.permissions?.["can-lock"] === true;
  const executionMode = workspace.attributes["execution-mode"] ?? "remote";
  const iacBinary = workspace.attributes["iac-binary"] ?? "tofu";
  const engineVersion = workspace.attributes["terraform-version"] ?? "latest";
  const isSettingsSection = [
    "health",
    "retention",
    "locking",
    "notifications",
    "webhooks",
    "policy-sets",
    "run-tasks",
    "run-triggers",
    "configuration-versions",
    "settings",
    "ssh-key",
    "team-access",
    "vcs",
    "destruction",
  ].includes(activeSection);
  const isRunDetail = activeSection === "run-detail";
  const tabs = ([
    { id: "overview", label: "Overview" },
    { id: "runs", label: "Runs" },
    { id: "states", label: "States" },
    { id: "variables", label: "Variables" },
    { id: "team-access", label: "Team access" },
    { id: "notifications", label: "Notifications" },
    { id: "webhooks", label: "Webhooks" },
    { id: "policy-sets", label: "Policy sets" },
    { id: "run-tasks", label: "Run tasks" },
    { id: "run-triggers", label: "Run triggers" },
    { id: "configuration-versions", label: "Configuration versions" },
    { id: "ssh-key", label: "SSH key" },
    { id: "vcs", label: "VCS" },
    { id: "health", label: "Health" },
    { id: "retention", label: "Retention" },
    { id: "settings", label: "Settings" },
    { id: "destruction", label: "Destruction" },
  ] satisfies readonly { readonly id: WorkspaceSection; readonly label: string }[])
    .filter((tab): boolean =>
      (tab.id !== "states" || canReadStateVersions)
      && (tab.id !== "variables" || canReadVariable));

  return (
    <div className="w-full max-w-full">
      {/* Breadcrumbs */}
      <nav
        aria-label="Breadcrumb"
        className="mb-2 flex flex-wrap items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <Link to={`${orgPath}/workspaces`} className="min-w-0 break-words hover:underline">
          Workspaces
        </Link>
        <span aria-hidden="true">/</span>
        {isSettingsSection ? (
          <>
            <Link to={workspacePath} className="min-w-0 break-words hover:underline">{workspace.attributes.name}</Link>
            <span aria-hidden="true">/</span>
            <span className="text-foreground">Settings</span>
          </>
        ) : isRunDetail ? (
          <>
            <Link to={workspacePath} className="min-w-0 break-words hover:underline">{workspace.attributes.name}</Link>
            <span aria-hidden="true">/</span>
            <Link to={`${workspacePath}/runs`} className="hover:underline">Runs</Link>
            <span aria-hidden="true">/</span>
            <span className="min-w-0 break-all font-mono text-foreground">{runId}</span>
          </>
        ) : (
          <span className="text-foreground">{workspace.attributes.name}</span>
        )}
      </nav>

      {/* Header */}
      <div className="mb-8 flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-3">
            <h1 className="truncate text-3xl font-bold tracking-tight text-foreground">
              {workspace.attributes.name}
            </h1>
            {workspace.attributes.locked === true && (
              <span className="flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                <Lock aria-hidden="true" className="size-3" /> Locked
              </span>
            )}
          </div>
          <p className="text-[15px] text-muted-foreground">
            {workspace.attributes.description ?? "No description provided."}
          </p>
          <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <span>ID:</span>
            <code className="select-all font-mono">{workspace.id}</code>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Copy workspace ID"
              onClick={(): void => { void handleCopyWorkspaceId(); }}
            >
              <Copy aria-hidden="true" />
            </Button>
          </div>
          {(() => {
            const ownedByType = workspace.attributes["owned-by-type"];
            const ownedById = workspace.attributes["owned-by-id"];
            const contactEmail = workspace.attributes["contact-email"];
            if (ownedByType === null && ownedById === null && contactEmail === null) return null;
            const ownerParts: string[] = [];
            if (ownedByType !== null && ownedByType !== undefined) {
              ownerParts.push(`${ownedByType} ${ownedById ?? ""}`.trim());
            }
            if (contactEmail !== null && contactEmail !== undefined) ownerParts.push(contactEmail);
            if (ownerParts.length === 0) return null;
            return (
              <div className="mt-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Owner:</span> {ownerParts.join(" · ")}
              </div>
            );
          })()}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-3">
          {canToggleLock && (
            <Button variant="outline" disabled={togglingLock} onClick={handleLock}>
              {workspace.attributes.locked === true ? (
                <><LockOpen data-icon="inline-start" /> {togglingLock ? "Unlocking..." : "Unlock"}</>
              ) : (
                <><Lock data-icon="inline-start" /> {togglingLock ? "Locking..." : "Lock"}</>
              )}
            </Button>
          )}
          {activeSection !== "runs" && (
            <Link
              to={canQueueRun && (activeSection === "overview" || isRunDetail)
                ? `${workspacePath}/runs?new-run=true`
                : `${workspacePath}/runs`}
              className={buttonVariants()}
            >
              <Play data-icon="inline-start" />
              {canQueueRun && (activeSection === "overview" || isRunDetail) ? "New run" : "View runs"}
            </Link>
          )}
        </div>
      </div>

      <Dialog
        open={lockDialogOpen}
        onOpenChange={(open: boolean): void => {
          if (!open && !togglingLock) {
            setLockDialogOpen(false);
            setLockReason("");
          }
        }}
      >
        <DialogContent className="sm:max-w-[720px]">
          <form onSubmit={(event): void => { event.preventDefault(); void submitLock(); }}>
            <DialogHeader>
              <DialogTitle>Lock workspace</DialogTitle>
              <DialogDescription>
                Lock this workspace to prevent new plans and applies while you perform maintenance.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-2">
              <label htmlFor="workspace-lock-reason" className="text-sm font-medium text-foreground">
                Reason <span className="font-normal text-muted-foreground">(Optional)</span>
              </label>
              <textarea
                id="workspace-lock-reason"
                rows={4}
                maxLength={300}
                autoFocus
                value={lockReason}
                onInput={(event): void => { setLockReason(event.currentTarget.value); }}
                placeholder="Why is this being locked?"
                className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <p className="text-sm text-muted-foreground">300 characters allowed</p>
            </div>
            <DialogFooter className="mt-6 gap-2">
              <Button type="submit" disabled={togglingLock}>
                {togglingLock ? "Locking..." : "Lock workspace"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={togglingLock}
                onClick={(): void => { setLockDialogOpen(false); setLockReason(""); }}
              >
                Cancel
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={unlockDialogOpen}
        onOpenChange={(open: boolean): void => {
          if (!open && !togglingLock) setUnlockDialogOpen(false);
        }}
        title={`Unlock workspace ${workspace.attributes.name}`}
        description={(
          <>
            <span className="block">
              Unlocking this workspace will allow other users to run Terraform. Be careful: if a remote Terraform run is still using the lock, this may lead to inconsistent state.
            </span>
            <span className="mt-4 block">
              This operation <strong className="font-semibold text-foreground">cannot be undone</strong>. Are you sure?
            </span>
          </>
        )}
        confirmText="Yes, unlock workspace"
        cancelText="Cancel"
        confirmVariant="destructive"
        onConfirm={submitUnlock}
        loading={togglingLock}
      />

      {section === undefined && (
        <div className="mb-6 border-b">
          <nav aria-label="Workspace sections" className="flex flex-wrap gap-x-6 gap-y-2">
            {tabs.map((tab): React.JSX.Element => (
              <button
                type="button"
                key={tab.id}
                onClick={(): void => { setEmbeddedSection(tab.id); }}
                aria-label={tab.label.toLowerCase()}
                aria-current={activeSection === tab.id ? "page" : undefined}
                className={cn(
                  "border-b-2 pb-3 text-sm font-medium transition-colors",
                  activeSection === tab.id
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

      {/* Section content */}
      <div className="mt-6">
        {activeSection === "overview" && (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <div className="flex flex-col gap-6 xl:col-span-2">
              <section aria-labelledby="latest-run-heading" className="overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm">
                <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-5 py-3">
                  <div className="flex items-center gap-2">
                    {latestRunSucceeded
                      ? <CheckCircle2 className="size-5 text-emerald-600" aria-hidden="true" />
                      : <Info className="size-5 text-blue-600" aria-hidden="true" />}
                    <h3 id="latest-run-heading" className="text-sm font-semibold text-gray-950">Latest run</h3>
                  </div>
                  <Link to={`${workspacePath}/runs`} className="text-xs font-medium text-blue-700 hover:underline">
                    View all runs
                  </Link>
                </div>
                <div className="px-5 py-4">
                  {latestRunLoading ? (
                    <p className="text-sm text-gray-500">Loading run history…</p>
                  ) : latestRun === null ? (
                    <div className="py-4">
                      {latestRunError ? (
                        <>
                          <p className="font-medium text-gray-950">Run history unavailable</p>
                          <p className="mt-1 text-sm text-gray-500">
                            Could not refresh this workspace’s run history. It will retry automatically.
                          </p>
                        </>
                      ) : (
                        <EmptyState
                          compact
                          title="No runs yet"
                          description="Start a run to plan your infrastructure changes."
                          docsHref="https://developer.hashicorp.com/terraform/cloud-docs/run"
                        />
                      )}
                    </div>
                  ) : (
                    <>
                      {latestRunPath === null ? (
                        <p className="font-semibold text-gray-950">
                          Latest run: {latestRunStatus ?? "unknown"}
                        </p>
                      ) : (
                        <Link to={latestRunPath} className="font-semibold text-blue-700 hover:underline">
                          Latest run: {latestRunStatus ?? "unknown"}
                        </Link>
                      )}
                      <p className="mt-1 text-sm text-gray-700">
                        {latestRun.attributes.message ?? "Manual run"}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-500">
                        {typeof latestRunCreatedAt === "string" && latestRunCreatedAt !== "" && (
                          <time dateTime={latestRunCreatedAt}>
                            {formatDateTime(latestRunCreatedAt)}
                          </time>
                        )}
                        {latestRun.attributes.source !== undefined && (
                          <span>{latestRun.attributes.source}</span>
                        )}
                        {typeof latestRunCounts?.["resource-additions"] === "number"
                          && typeof latestRunCounts["resource-changes"] === "number"
                          && typeof latestRunCounts["resource-destructions"] === "number" && (
                          <span className="flex items-center gap-3 font-medium">
                            <span className="text-emerald-700">+{latestRunCounts["resource-additions"]}</span>
                            <span className="text-blue-700">~{latestRunCounts["resource-changes"]}</span>
                            <span className="text-red-700">−{latestRunCounts["resource-destructions"]}</span>
                          </span>
                        )}
                        <code className="font-mono">{latestRun.id}</code>
                      </div>
                      {latestRunError && (
                        <p role="status" className="mt-2 text-xs text-amber-700">Run status may be out of date.</p>
                      )}
                    </>
                  )}
                </div>
              </section>

              {canReadStateVersions && <WorkspaceResources workspaceId={workspace.id} />}
            </div>

            <div className="flex flex-col gap-6 xl:col-span-1">
              {/* Details Card */}
              <div className="bg-white border border-gray-200 rounded-md shadow-sm">
                <div className="px-4 py-3 border-b border-gray-200">
                  <h3 className="text-sm font-semibold text-gray-900">Workspace details</h3>
                </div>
                <div className="p-4 space-y-4">
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Project</div>
                    <div className="text-[13px] text-gray-900 font-medium">
                      {projectId === undefined
                        ? "No project"
                        : projectName === null
                          ? "Loading project…"
                          : projectName === ""
                            ? "Project unavailable"
                            : (
                              <Link to={`${orgPath}/projects/${encodeURIComponent(projectId)}`} className="text-primary hover:underline">
                                {projectName}
                              </Link>
                            )}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                      Execution mode
                      <HelpTooltip icon="info" content="Execution mode determines whether Terraform or OpenTofu runs execute remotely in Terrence agent pools or locally on your CLI." />
                    </div>
                    <div className="text-[13px] text-gray-900 flex items-center gap-1.5">
                       <span className="capitalize">{executionMode}</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                      Execution engine
                      <HelpTooltip icon="info" content="The Infrastructure-as-Code tool (Terraform or OpenTofu) and version constraint configured for this workspace." />
                    </div>
                    <div className="text-[13px] text-gray-900 flex items-center gap-1.5">
                       <span className="capitalize">{iacBinary}</span> {engineVersion}
                       {engineVersion === "latest" && (
                         <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded border border-gray-200">Latest</span>
                       )}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Auto-apply</div>
                    <div className="text-[13px] text-gray-900">
                       {workspace.attributes["auto-apply"] === true ? "Enabled" : "Disabled"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Created</div>
                    <div className="text-[13px] text-gray-900">
                       {formatDate(createdAt)}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeSection === "runs" && (
          <RunList key={workspace.id} workspaceId={workspace.id} canStartRun={canQueueRun} />
        )}
        {isRunDetail && <RunDetail showBreadcrumb={false} />}
        {inaccessibleDataSection && (
          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle>Workspace data access required</CardTitle>
              <CardDescription>
                You do not have permission to view this workspace data.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
        {activeSection === "states" && canReadStateVersions && (
          <StateHistory
            workspaceId={workspace.id}
            orgName={orgName ?? ""}
            workspaceName={workspace.attributes.name}
            canUpload={canWriteStateVersions}
          />
        )}
        {activeSection === "variables" && canReadVariable && (
          <WorkspaceVariables
            workspaceId={workspace.id}
            canUpdate={workspace.attributes.permissions?.["can-update-variable"] === true}
          />
        )}
        {updateOnlySection && !canUpdate && (
          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle>Workspace administrator access required</CardTitle>
              <CardDescription>
                You do not have permission to manage this workspace setting.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
        {activeSection === "team-access" && canUpdate && (
          <WorkspaceTeamAccess orgName={orgName ?? ""} workspaceId={workspace.id} />
        )}
        {activeSection === "notifications" && canUpdate && (
          <WorkspaceNotifications workspaceId={workspace.id} />
        )}
        {activeSection === "webhooks" && canUpdate && (
          <WorkspaceNotifications mode="webhooks" workspaceId={workspace.id} />
        )}
        {activeSection === "policy-sets" && <WorkspacePolicySets workspaceId={workspace.id} />}
        {activeSection === "run-tasks" && (
          <WorkspaceRunTasks
            orgName={orgName ?? ""}
            workspaceId={workspace.id}
            canManage={workspace.attributes.permissions?.["can-manage-run-tasks"] === true}
          />
        )}
        {activeSection === "run-triggers" && canUpdate && (
          <WorkspaceRunTriggers orgName={orgName ?? ""} workspaceId={workspace.id} />
        )}
        {activeSection === "configuration-versions" && canUpdate && (
          <WorkspaceConfigurationVersions workspaceId={workspace.id} />
        )}
        {activeSection === "ssh-key" && canUpdate && (
          <WorkspaceSshKey
            key={workspace.id}
            orgName={orgName ?? ""}
            workspaceId={workspace.id}
            initialSshKeyId={workspace.relationships?.["ssh-key"]?.data?.id ?? null}
          />
        )}
        {activeSection === "health" && (
          <WorkspaceHealth
            key={workspace.id}
            workspace={workspace}
            onSaved={(saved: Workspace): void => { setWorkspace(saved); }}
          />
        )}
        {activeSection === "retention" && canUpdate && <WorkspaceRetention workspaceId={workspace.id} />}
        {activeSection === "vcs" && (
          <WorkspaceVcs
            key={workspace.id}
            workspace={workspace}
            onSaved={(saved): void => { setWorkspace(saved); }}
          />
        )}
        {activeSection === "settings" && (
          <WorkspaceSettings
            key={workspace.id}
            orgName={orgName ?? ""}
            workspace={workspace}
            onSaved={(saved: Workspace): void => {
              setWorkspace(saved);
              if (saved.attributes.name === workspace.attributes.name) return;
              const renamedWorkspacePath =
                `${orgPath}/workspaces/${encodeURIComponent(saved.attributes.name)}`;
              const pathname =
                location.pathname === workspacePath || location.pathname.startsWith(`${workspacePath}/`)
                  ? `${renamedWorkspacePath}${location.pathname.slice(workspacePath.length)}`
                  : renamedWorkspacePath;
              void navigate(
                { pathname, search: location.search, hash: location.hash },
                { replace: true },
              );
            }}
          />
        )}
        {activeSection === "locking" && (
          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle>Workspace locking</CardTitle>
              <CardDescription>
                Lock this workspace to prevent new plans and applies while you perform maintenance.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                This workspace is currently {workspace.attributes.locked === true ? "locked" : "unlocked"}.
              </p>
              {workspace.attributes.locked === true && typeof workspace.attributes["locked-reason"] === "string" && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Reason: {workspace.attributes["locked-reason"]}
                </p>
              )}
            </CardContent>
            {canToggleLock && (
              <CardFooter className="justify-end">
                <Button variant="outline" disabled={togglingLock} onClick={handleLock}>
                  {workspace.attributes.locked === true ? (
                    <><LockOpen data-icon="inline-start" /> {togglingLock ? "Unlocking..." : "Unlock workspace"}</>
                  ) : (
                    <><Lock data-icon="inline-start" /> {togglingLock ? "Locking..." : "Lock workspace"}</>
                  )}
                </Button>
              </CardFooter>
            )}
          </Card>
        )}
        {activeSection === "destruction" && (
          <WorkspaceDestruction
            workspace={workspace}
            onDeleted={(): void => {
              void navigate(`${orgPath}/workspaces`, { replace: true });
            }}
          />
        )}

      </div>
    </div>
  );
}
