import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link, useLocation, useNavigate } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button, buttonVariants } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { EmptyState } from "../components/EmptyState";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import {
  Card,
  CardDescription,
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
import { Breadcrumbs, type BreadcrumbItem } from "../components/Breadcrumbs";
import { PageShell, SettingsSection, type PageShellVariant } from "../components/PageHeader";
import { RunDetail } from "./RunDetail";
import { RunList } from "./RunList";
import { StateHistory } from "./StateHistory";
import { Play, Lock, LockOpen, Info, CheckCircle2, Copy } from "lucide-react";
import { HelpTooltip } from "@/components/ui/help-tooltip";
import { copyTextToClipboard } from "../lib/utils";
import { formatDate, formatDateTime, formatRelativeTime } from "../lib/utils";
import { formatRunSource, formatRunStatus } from "../lib/run-labels";
import { WorkspaceRepositoryLink } from "../components/WorkspaceRepositoryLink";
import { isNumber, isString } from "../lib/type-guards";
import type { JsonValue } from "@/lib/json";

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

/**
 * Every settings section names itself. Previously all fourteen shared the
 * breadcrumb "… / Settings" and the workspace name as their heading, so the
 * page never told you which setting you had opened — only the sidebar did.
 *
 * `layout` is per-section rather than "settings means narrow": half of these
 * destinations are forms and want the form measure, and half are collections
 * of rows that want room for their columns.
 */
type SettingsSectionMeta = Readonly<{
  description: string;
  layout: PageShellVariant;
  title: string;
}>;

const SETTINGS_SECTIONS: Partial<Record<WorkspaceSection, SettingsSectionMeta>> = {
  settings: {
    title: "General",
    description: "Name, description, execution mode and remote state sharing for this workspace.",
    layout: "form",
  },
  locking: {
    title: "Locking",
    description: "Lock the workspace to stop new plans and applies while you work on it.",
    layout: "form",
  },
  retention: {
    title: "Data retention",
    description: "How long state versions and configuration versions are kept before deletion.",
    layout: "form",
  },
  destruction: {
    title: "Destruction and deletion",
    description: "Queue a destroy run, or remove the workspace and its history entirely.",
    layout: "form",
  },
  vcs: {
    title: "Version control",
    description: "Connect a repository so commits queue runs automatically.",
    layout: "form",
  },
  "ssh-key": {
    title: "SSH key",
    description: "Private key used to clone Git-based module sources during a run.",
    layout: "form",
  },
  "configuration-versions": {
    title: "Configuration versions",
    description: "Configuration bundles uploaded or pulled for this workspace.",
    layout: "standard",
  },
  "run-triggers": {
    title: "Run triggers",
    description: "Queue a run here whenever another workspace finishes an apply.",
    layout: "standard",
  },
  "run-tasks": {
    title: "Run tasks",
    description: "Call external services at set points during a run.",
    layout: "standard",
  },
  "policy-sets": {
    title: "Policies",
    description: "Policy sets evaluated against every plan in this workspace.",
    layout: "standard",
  },
  health: {
    title: "Health assessments",
    description: "Scheduled drift detection and continuous validation checks.",
    layout: "standard",
  },
  "team-access": {
    title: "Team access",
    description: "Which teams can read, plan, apply or administer this workspace.",
    layout: "standard",
  },
  notifications: {
    title: "Notifications",
    description: "Where this workspace announces run events.",
    layout: "standard",
  },
  webhooks: {
    title: "Webhooks",
    description: "Generic HTTP endpoints called when run events fire.",
    layout: "standard",
  },
};

const TERMINAL_RUN_STATUSES = new Set([
  "applied",
  "canceled",
  "discarded",
  "errored",
  "failed",
  "force_canceled",
  "planned_and_finished",
  "unreachable",
]);

type Workspace = {
  id: string;
  attributes: {
    name: string;
    "vcs-repo"?: {
      identifier?: string | null;
      "github-app-installation-id"?: string | null;
    } | null;
    "working-directory"?: string | null;
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
    [key: string]: JsonValue;
  };
  relationships?: {
    project?: { data: { id: string; type: string } | null };
    "ssh-key"?: { data: { id: string; type: string } | null };
    [key: string]: JsonValue;
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
    "trigger-reason"?: string;
    status: string;
    [key: string]: JsonValue;
  };
}

export function WorkspaceDetail({
  section,
}: Readonly<{ readonly section?: WorkspaceSection }>): React.JSX.Element {
  const { orgName, workspaceName } = useParams<{
    orgName: string;
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
  const activeSection = section ?? "overview";
  const isRunDetail = activeSection === "run-detail";
  const activeWorkspaceId = useRef<string | null>(null);
  const workspaceRequest = useRef<AbortController | null>(null);
  const latestRunRequest = useRef<AbortController | null>(null);
  const projectId = workspace?.relationships?.project?.data?.id;

  const loadLatestRun = useCallback(async (
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<RunSummary | null> => {
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const runs = await fetchApi(
        `/api/v2/workspaces/${workspaceId}/runs?page[size]=1`,
        { signal },
      ) as { data: JsonValue };
      if (signal.aborted || activeWorkspaceId.current !== workspaceId) return null;
// SAFETY: the runs list carries RunSummary resources per the endpoint contract.
      const latest = Array.isArray(runs.data) ? (runs.data[0] as RunSummary | undefined) ?? null : null;
      setLatestRun(latest);
      setLatestRunLoading(false);
      setLatestRunError(false);
      return latest;
    } catch {
      if (!signal.aborted && activeWorkspaceId.current === workspaceId) {
        setLatestRunLoading(false);
        setLatestRunError(true);
      }
      return null;
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
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
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

  useEffect((): (() => void) | undefined => {
    if (isRunDetail) return undefined;
    void loadWorkspace();
    return (): void => {
      workspaceRequest.current?.abort();
      latestRunRequest.current?.abort();
    };
  }, [isRunDetail, loadWorkspace]);

  const latestRunTerminal = latestRun !== null && TERMINAL_RUN_STATUSES.has(latestRun.attributes.status);

  useEffect((): (() => void) | undefined => {
    if (workspace === null || activeSection !== "overview" || latestRunTerminal) return undefined;
    let timer: number | undefined;
    let stopped = false;
    const controller = new AbortController();
    latestRunRequest.current?.abort();
    latestRunRequest.current = controller;
    const clearTimer = (): void => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };
    const shouldStop = (): boolean => stopped || controller.signal.aborted || document.hidden;
    const refresh = async (): Promise<void> => {
      if (shouldStop()) return;
      const latest = await loadLatestRun(workspace.id, controller.signal);
      if (latest !== null && TERMINAL_RUN_STATUSES.has(latest.attributes.status)) return;
      if (shouldStop()) return;
      timer = window.setTimeout((): void => { void refresh(); }, 5000);
    };
    const onVisibilityChange = (): void => {
      if (document.hidden) {
        clearTimer();
      } else if (!stopped) {
        clearTimer();
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (!document.hidden) void refresh();
    return (): void => {
      stopped = true;
      controller.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (latestRunRequest.current === controller) latestRunRequest.current = null;
      clearTimer();
    };
  }, [activeSection, latestRunTerminal, loadLatestRun, workspace]);

  useEffect((): (() => void) | undefined => {
    setProjectName(null);
    if (projectId === undefined || activeSection !== "overview") return undefined;
    const controller = new AbortController();
    void fetchApi<{ data?: { attributes?: { name?: unknown } } }>(`/projects/${encodeURIComponent(projectId)}`, { signal: controller.signal })
      .then((response): void => {
        if (controller.signal.aborted) return;
        const name = response.data
          ?.attributes?.name;
        setProjectName(isString(name) && name !== "" ? name : "");
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

  async function handleCopyWorkspaceId(identifier: string): Promise<void> {
    const didCopy = await copyTextToClipboard(identifier);
    if (didCopy) {
      toast.add({ title: "Workspace ID copied", type: "success" });
      return;
    }
    toast.add({ title: "Could not copy workspace ID", type: "error" });
  }

  // A run page is a page in its own right: RunDetail already renders its own
  // breadcrumb, heading and actions, so wrapping it in the workspace header
  // just stacked two headers on top of each other. It also loads its own run
  // data, so it must not wait for an unrelated workspace request.
  if (isRunDetail) {
    return (
      <PageShell variant="wide">
        <RunDetail />
      </PageShell>
    );
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
      <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
        <p className="font-medium">Could not load workspace</p>
        <p className="mt-1">{loadError !== "" ? loadError : "Workspace not found"}</p>
        <Button className="mt-3" variant="outline" onClick={(): void => { void loadWorkspace(); }}>
          Try again
        </Button>
      </div>
    );
  }

  const createdAt = workspace.attributes["created-at"];
  const latestRunStatusValue = latestRun?.attributes.status;
  const latestRunStatus = latestRunStatusValue === undefined
    ? undefined
    : formatRunStatus(latestRunStatusValue);
  const latestRunSucceeded = latestRunStatusValue === "applied" || latestRunStatusValue === "planned_and_finished";
  const latestRunCreatedAt = latestRun?.attributes["created-at"];
  const latestRunCounts = latestRun?.attributes;
  const latestRunSource = latestRun?.attributes.source;
  const latestRunTriggerReason = latestRun?.attributes["trigger-reason"];
  const workingDirectory = workspace.attributes["working-directory"];
  const displayedWorkingDirectory = isString(workingDirectory) && workingDirectory.trim() !== ""
    ? workingDirectory.trim()
    : "Repository root";
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
  const iacBinaryLabel = iacBinary === "tofu" ? "OpenTofu" : iacBinary;
  const engineVersion = workspace.attributes["terraform-version"] ?? "latest";
  const settingsSection = SETTINGS_SECTIONS[activeSection];
  const isSettingsSection = settingsSection !== undefined;

  // Settings is a real level of the IA, not a label to collapse: the
  // organization pages spell out "… / Settings / Agent pools" and the
  // workspace trail reads the same way.
  const sectionCrumbs: readonly BreadcrumbItem[] = [
    { label: "Workspaces", to: `${orgPath}/workspaces` },
    ...(isSettingsSection
      ? [
          { label: workspace.attributes.name, to: workspacePath },
          { label: "Settings", to: `${workspacePath}/settings` },
          { label: settingsSection.title },
        ]
      : [{ label: workspace.attributes.name }]),
  ];

  return (
    <PageShell variant={settingsSection?.layout ?? "wide"}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
        <div className="min-w-0">
          <Breadcrumbs items={sectionCrumbs} />
          <div className="flex items-center gap-3">
            <h1 className="truncate text-3xl font-bold tracking-tight text-foreground">
              {isSettingsSection ? settingsSection.title : workspace.attributes.name}
            </h1>
            {workspace.attributes.locked === true && (
              <span className="flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                <Lock aria-hidden="true" className="size-3" /> Locked
              </span>
            )}
          </div>
          <p className="mt-1 max-w-3xl text-pretty text-sm text-muted-foreground">
            {isSettingsSection
              ? settingsSection.description
              : workspace.attributes.description ?? "No description provided."}
          </p>
          {!isSettingsSection && (
            <>
              <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                <span>Workspace ID:</span>
                <code className="select-all font-mono">{workspace.id}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Copy workspace ID"
                  onClick={(): void => {
                    void handleCopyWorkspaceId(workspace.id);
                  }}
                >
                  <Copy aria-hidden="true" />
                </Button>
              </div>
              {((): React.JSX.Element | null => {
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
            </>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canToggleLock && (
            <Button variant="outline" disabled={togglingLock} onClick={handleLock}>
              {workspace.attributes.locked === true ? (
                <><LockOpen data-icon="inline-start" /> {togglingLock ? "Unlocking…" : "Unlock"}</>
              ) : (
                <><Lock data-icon="inline-start" /> {togglingLock ? "Locking…" : "Lock"}</>
              )}
            </Button>
          )}
          {activeSection !== "runs" && (
            <Link
              to={canQueueRun && activeSection === "overview"
                ? `${workspacePath}/runs?new-run=true`
                : `${workspacePath}/runs`}
              className={buttonVariants({
                variant: isSettingsSection ? "outline" : "default",
              })}
            >
              <Play data-icon="inline-start" />
              {canQueueRun && activeSection === "overview" ? "New run" : "View runs"}
            </Link>
          )}
        </div>
      </header>

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
              <Textarea
                id="workspace-lock-reason"
                name="lock-reason"
                autoComplete="off"
                spellCheck={false}
                rows={4}
                maxLength={300}
                autoFocus
                value={lockReason}
                onInput={(event): void => { setLockReason(event.currentTarget.value); }}
                placeholder="Maintenance reason…"
              />
              <p className="text-sm text-muted-foreground">300 characters allowed</p>
            </div>
            <DialogFooter className="mt-6 gap-2">
              <Button type="submit" disabled={togglingLock}>
                {togglingLock ? "Locking…" : "Lock workspace"}
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

      {/* Section content */}
      <div>
        {activeSection === "overview" && (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <div className="flex flex-col gap-6 xl:col-span-2">
              <section aria-labelledby="latest-run-heading" className="overflow-hidden rounded-md border border-border bg-card shadow-sm">
                <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
                  <div className="flex items-center gap-2">
                    {latestRunSucceeded
                      ? <CheckCircle2 className="size-5 text-success" aria-hidden="true" />
                      : <Info className="size-5 text-primary" aria-hidden="true" />}
                    <h2 id="latest-run-heading" className="text-sm font-semibold text-foreground">Latest run</h2>
                  </div>
                  <Link to={`${workspacePath}/runs`} className="text-xs font-medium text-primary hover:underline">
                    View all runs
                  </Link>
                </div>
                <div className="px-5 py-4">
                  {latestRunLoading ? (
                    <p className="text-sm text-muted-foreground">Loading run history…</p>
                  ) : latestRun === null ? (
                    <div className="py-4">
                      {latestRunError ? (
                        <>
                          <p className="font-medium text-foreground">Run history unavailable</p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            Could not refresh this workspace’s run history. It will retry automatically.
                          </p>
                        </>
                      ) : (
                        <EmptyState
                          compact
                          headingLevel="h3"
                          title="No runs yet"
                          description="Start a run to plan your infrastructure changes."
                          docsHref="/app/docs/runs"
                        />
                      )}
                    </div>
                  ) : (
                    <>
                      <div aria-live="polite" aria-atomic="true">
                        {latestRunPath === null ? (
                          <p className="font-semibold text-foreground">
                            Latest run: {latestRunStatus ?? "unknown"}
                          </p>
                        ) : (
                          <Link to={latestRunPath} className="font-semibold text-primary hover:underline">
                            Latest run: {latestRunStatus ?? "unknown"}
                          </Link>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-foreground">
                        {latestRun.attributes.message ?? "Manual run"}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                        {isString(latestRunCreatedAt) && latestRunCreatedAt !== "" && (
                          <time dateTime={latestRunCreatedAt} title={formatDateTime(latestRunCreatedAt)}>
                            {formatRelativeTime(latestRunCreatedAt)}
                          </time>
                        )}
                        {latestRunSource !== undefined && (
                          <span>via {formatRunSource(latestRunSource, latestRunTriggerReason)}</span>
                        )}
                        {isNumber(latestRunCounts?.["resource-additions"])
                          && isNumber(latestRunCounts["resource-changes"])
                          && isNumber(latestRunCounts["resource-destructions"]) && (
                          <span className="flex items-center gap-3 font-medium">
                            <span className="text-success">+{latestRunCounts["resource-additions"]}</span>
                            <span className="text-primary">~{latestRunCounts["resource-changes"]}</span>
                            <span className="text-destructive">−{latestRunCounts["resource-destructions"]}</span>
                          </span>
                        )}
                        <code className="font-mono">{latestRun.id}</code>
                      </div>
                      {latestRunError && (
                        <p role="status" className="mt-2 text-xs text-warning">Run status may be out of date.</p>
                      )}
                    </>
                  )}
                </div>
              </section>

              {canReadStateVersions && <WorkspaceResources workspaceId={workspace.id} />}
            </div>

            <div className="flex flex-col gap-6 xl:col-span-1">
              {/* Details Card */}
              <div className="bg-card border border-border rounded-md shadow-sm">
                <div className="px-4 py-3 border-b border-border">
                  <h2 className="text-sm font-semibold text-foreground">Workspace details</h2>
                </div>
                <div className="p-4 space-y-4">
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Project</div>
                    <div className="text-sm text-foreground font-medium">
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
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Repository</div>
                    <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
                      <WorkspaceRepositoryLink repo={workspace.attributes["vcs-repo"]} />
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Working directory</div>
                    <div className="break-all font-mono text-sm text-foreground">{displayedWorkingDirectory}</div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
                      Execution mode
                      <HelpTooltip icon="info" content="Execution mode determines whether Terraform or OpenTofu runs execute remotely in Terrence agent pools or locally on your CLI." />
                    </div>
                    <div className="text-sm text-foreground flex items-center gap-1.5">
                       <span className="capitalize">{executionMode}</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
                      Execution engine
                      <HelpTooltip icon="info" content="The Infrastructure-as-Code tool (Terraform or OpenTofu) and version constraint configured for this workspace." />
                    </div>
                    <div className="text-sm text-foreground flex items-center gap-1.5">
                       <span>{iacBinaryLabel}</span> {engineVersion}
                       {engineVersion === "latest" && (
                         <span className="text-xs bg-muted text-foreground px-1.5 py-0.5 rounded border border-border">Latest</span>
                       )}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Auto-apply</div>
                    <div className="text-sm text-foreground">
                       {workspace.attributes["auto-apply"] === true ? "Enabled" : "Disabled"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Created</div>
                    <div className="text-sm text-foreground">
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
        {inaccessibleDataSection && (
          <Card>
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
            orgName={orgName ?? ""}
            canUpdate={workspace.attributes.permissions?.["can-update-variable"] === true}
          />
        )}
        {updateOnlySection && !canUpdate && (
          <Card>
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
          <SettingsSection
            title="Workspace lock"
            description="While locked, no plan or apply can start. Existing runs finish normally."
            footer={canToggleLock && (
              <Button variant="outline" disabled={togglingLock} onClick={handleLock}>
                {workspace.attributes.locked === true ? (
                  <><LockOpen data-icon="inline-start" /> {togglingLock ? "Unlocking…" : "Unlock workspace"}</>
                ) : (
                  <><Lock data-icon="inline-start" /> {togglingLock ? "Locking…" : "Lock workspace"}</>
                )}
              </Button>
            )}
          >
            <p className="text-sm text-foreground">
              This workspace is currently {workspace.attributes.locked === true ? "locked" : "unlocked"}.
            </p>
            {workspace.attributes.locked === true && isString(workspace.attributes["locked-reason"]) && (
              <p className="mt-2 text-sm text-muted-foreground">
                Reason: {workspace.attributes["locked-reason"]}
              </p>
            )}
          </SettingsSection>
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
    </PageShell>
  );
}
