import { useEffect, useState } from "react";
import { fetchApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { loadOrganizationVcsConnections, type VcsConnection } from "@/components/WorkspaceVcs";
import { VcsRepoSelector } from "@/components/VcsRepoSelector";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { HelpTooltip } from "@/components/ui/help-tooltip";
import { useAgentPools } from "@/hooks/useAgentPools";
import { isString } from "../lib/type-guards";

type CreateWorkspaceModalProps = {
  orgName: string;
  defaultIacBinary?: string;
  defaultTerraformVersion?: string;
  projects?: readonly WorkspaceProject[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (ws: Readonly<{ id: string; name: string }>) => void;
}

type WorkspaceProject = Readonly<{ id: string; attributes: Readonly<{ name: string }> }>;

type VcsRepoOption = {
  identifier: string;
  name: string;
  owner?: string;
};

export function CreateWorkspaceModal(props: Readonly<CreateWorkspaceModalProps>): React.JSX.Element {
  const {
    orgName,
    defaultIacBinary,
    defaultTerraformVersion,
    projects = [],
    open,
    onOpenChange,
    onCreated,
  } = props;
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [autoApply, setAutoApply] = useState(false);
  const [iacBinary, setIacBinary] = useState(defaultIacBinary ?? "terraform");
  const [terraformVersion, setTerraformVersion] = useState(defaultTerraformVersion ?? "latest");
  const [executionMode, setExecutionMode] = useState("inherit");
  const [agentPoolId, setAgentPoolId] = useState("");
  const [availableVersions, setAvailableVersions] = useState<string[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [vcsIdentifier, setVcsIdentifier] = useState("");
  const [vcsConnections, setVcsConnections] = useState<VcsConnection[]>([]);
  const [vcsConnectionValue, setVcsConnectionValue] = useState("");
  const [vcsConnectionsLoading, setVcsConnectionsLoading] = useState(false);
  const [vcsConnectionsError, setVcsConnectionsError] = useState("");
  const [vcsRepositories, setVcsRepositories] = useState<VcsRepoOption[]>([]);
  const [vcsReposLoading, setVcsReposLoading] = useState(false);
  const [sourceType, setSourceType] = useState("tfe-api");

  // Sync default engine when defaultIacBinary prop changes or modal opens
  useEffect((): void => {
    if (open && defaultIacBinary !== undefined && defaultIacBinary !== "") {
      setIacBinary(defaultIacBinary);
    }
    if (open && defaultTerraformVersion !== undefined && defaultTerraformVersion !== "") {
      setTerraformVersion(defaultTerraformVersion);
    }
  }, [defaultIacBinary, defaultTerraformVersion, open]);

  useEffect((): void => {
    if (open) { setProjectId(""); setAgentPoolId(""); }
  }, [open, orgName]);

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    const controller = new AbortController();
    setVersionsLoading(true);
    void fetchApi<{ data?: unknown }>(`/available-versions?tool=${encodeURIComponent(iacBinary)}`, { signal: controller.signal })
      .then((response): void => {
        const versions = response.data;
        if (!controller.signal.aborted && Array.isArray(versions)) {
          setAvailableVersions(versions.filter((version): version is string => isString(version)));
        }
      })
      .catch((): void => {})
      .finally((): void => { if (!controller.signal.aborted) setVersionsLoading(false); });
    return (): void => { controller.abort(); };
  }, [iacBinary, open]);

  // Fetch registered VCS connections
  useEffect((): (() => void) | undefined => {
    if (!open || sourceType !== "vcs") return undefined;
    const controller = new AbortController();
    setVcsConnectionsLoading(true);
    setVcsConnectionsError("");
    void loadOrganizationVcsConnections(orgName, controller.signal)
      .then((connections: VcsConnection[]): void => {
        if (!controller.signal.aborted) {
          setVcsConnections(connections);
          setVcsConnectionValue((current: string): string =>
            connections.some((connection: VcsConnection): boolean => connection.value === current) ? current : "");
        }
      })
      .catch((): void => {
        if (!controller.signal.aborted) {
          setVcsConnections([]);
          setVcsConnectionValue("");
          setVcsConnectionsError("Registered VCS connections could not be loaded.");
        }
      })
      .finally((): void => {
        if (!controller.signal.aborted) setVcsConnectionsLoading(false);
      });
    return (): void => {
      controller.abort();
    };
  }, [open, orgName, sourceType]);

  // Fetch accessible repositories when a VCS connection is selected
  useEffect((): (() => void) | undefined => {
    setVcsRepositories([]);
    if (!open || sourceType !== "vcs" || vcsConnectionValue === "") return undefined;
    const controller = new AbortController();
    setVcsReposLoading(true);
    void fetchApi<{ data?: { attributes: { identifier: string; name: string; owner?: string } }[] }>(
      `/organizations/${encodeURIComponent(orgName)}/vcs-connections/${encodeURIComponent(vcsConnectionValue)}/repositories`,
      { signal: controller.signal },
    )
      .then((res): void => {
        if (controller.signal.aborted) return;
        const list = res.data;
        if (Array.isArray(list)) {
          setVcsRepositories(list.map((item) => item.attributes));
        }
      })
      .catch((): void => {})
      .finally((): void => {
        if (!controller.signal.aborted) setVcsReposLoading(false);
      });

    return (): void => {
      controller.abort();
    };
  }, [open, orgName, sourceType, vcsConnectionValue]);

  // Issue #598: when agent execution is selected, surface whether any agent
  // pool can actually pick up runs before the workspace is created.
  const agentPools = useAgentPools(orgName, open && executionMode === "agent");

  const handleSubmit = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    const workspaceName = name.trim();
    if (loading) return;
    if (workspaceName === "") {
      setSubmitError("Give your workspace a name.");
      return;
    }
    if (executionMode === "agent" && !agentPools.pools.some((pool) => pool.id === agentPoolId)) {
      setSubmitError("Choose an agent pool before creating the workspace.");
      return;
    }
    const normalizedVcsIdentifier = vcsIdentifier.trim();
    const selectedConnection = vcsConnections.find(
      (connection: VcsConnection): boolean => connection.value === vcsConnectionValue,
    );
    if (sourceType === "vcs" && (normalizedVcsIdentifier === "" || selectedConnection === undefined)) {
      toast.add({
        title: "Incomplete VCS connection",
        description: "Choose a registered VCS connection and enter a repository identifier.",
        type: "error",
      });
      return;
    }
    setSubmitError("");
    setLoading(true);
    const normalizedVersion = terraformVersion.trim() !== "" ? terraformVersion.trim() : "latest";
    try {
      const vcsRepo = sourceType === "vcs" && selectedConnection !== undefined
        ? {
            identifier: normalizedVcsIdentifier,
            ...(selectedConnection.kind === "github-app"
              ? { "github-app-installation-id": selectedConnection.id }
              : { "oauth-token-id": selectedConnection.id }),
          }
        : undefined;

// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const res = await fetchApi(`/organizations/${encodeURIComponent(orgName)}/workspaces`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            attributes: {
              name: workspaceName,
              "auto-apply": autoApply,
              ...(executionMode === "inherit" ? {} : { "execution-mode": executionMode }),
              ...(executionMode === "agent" ? { "agent-pool-id": agentPoolId } : {}),
              "iac-binary": iacBinary,
              "terraform-version": normalizedVersion,
              source: sourceType === "vcs" ? "tfe-api" : sourceType,
              "vcs-repo": vcsRepo,
            },
            type: "workspaces",
            ...(projectId === ""
              ? undefined
              : { relationships: { project: { data: { id: projectId, type: "projects" } } } }),
          },
        }),
      }) as { data: { id: string } };
      onCreated({ id: res.data.id, name: workspaceName });
      onOpenChange(false);
      setName("");
      setProjectId("");
      setAutoApply(false);
      setExecutionMode("inherit");
      setAgentPoolId("");
      setIacBinary(defaultIacBinary ?? "terraform");
      setTerraformVersion(defaultTerraformVersion ?? "latest");
      setVcsIdentifier("");
      setVcsConnectionValue("");
      setSourceType("tfe-api");
      toast.add({ title: "Workspace created", type: "success" });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Failed to create workspace";
      setSubmitError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen): void => { if (!loading) onOpenChange(nextOpen); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New Workspace</DialogTitle>
          <DialogDescription>A workspace keeps the code, state, and run history for one piece of infrastructure in {orgName}.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ws-name" className="text-sm font-medium">Workspace name</label>
            <Input
              id="ws-name"
              name="workspace-name"
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setName(event.currentTarget.value); }}
              onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setName(event.currentTarget.value); }}
              placeholder="my-infrastructure"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="iac-tool" className="text-sm font-medium">Execution engine</label>
            <Select
              id="iac-tool"
              name="iac-binary"
              value={iacBinary}
              onValueChange={setIacBinary}
            >
              <SelectItem value="tofu">OpenTofu</SelectItem>
              <SelectItem value="terraform">Terraform</SelectItem>
            </Select>
          </div>

          <div className="space-y-4">
            <div className="flex flex-col gap-1.5 mb-4">
              <label htmlFor="source-type" className="text-sm font-medium">Workspace source</label>
              <Select
                id="source-type"
                name="workspace-source"
                value={sourceType}
                onValueChange={setSourceType}
              >
                <SelectItem value="tfe-api">CLI or CI pipeline</SelectItem>
                <SelectItem value="local">Directory on the server</SelectItem>
                <SelectItem value="vcs">Git repository</SelectItem>
              </Select>
            </div>

            {sourceType === "tfe-api" && (
              <p className="text-sm text-muted-foreground">Use your existing Terraform or OpenTofu workflow. Connect your CLI after creating the workspace.</p>
            )}
            {sourceType === "vcs" && (
              <div className="grid gap-4">
                <div className="flex flex-col gap-2">
                  <label htmlFor="vcs-connection" className="text-sm font-medium leading-none">VCS connection</label>
                  <Select
                    id="vcs-connection"
                    name="vcs-connection"
                    value={vcsConnectionValue}
                    onValueChange={setVcsConnectionValue}
                    disabled={loading || vcsConnectionsLoading}
                  >
                    <SelectItem value="">
                      {vcsConnectionsLoading ? "Loading registered connections…" : "Select a registered connection"}
                    </SelectItem>
                    {vcsConnections.map((connection: VcsConnection): React.JSX.Element => (
                      <SelectItem key={connection.value} value={connection.value}>{connection.label}</SelectItem>
                    ))}
                  </Select>
                  <p
                    role={vcsConnectionsError === "" ? undefined : "alert"}
                    className={vcsConnectionsError === "" ? "text-xs text-muted-foreground" : "text-xs text-destructive"}
                  >
                    {vcsConnectionsError !== ""
                      ? vcsConnectionsError
                      : vcsConnections.length === 0 && !vcsConnectionsLoading
                        ? "No registered connections are available. Add one in organization VCS settings."
                        : "Choose a connection first, then search repositories by organization or name."}
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-1">
                    <label htmlFor="vcs-identifier" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                      Repository Identifier
                    </label>
                    <HelpTooltip content="Select from accessible repositories or type a repository path (e.g. 'org/repo-name')." />
                  </div>

                  {vcsReposLoading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                      <Spinner className="size-3.5" /> Loading accessible repositories…
                    </div>
                  ) : (
                    <VcsRepoSelector
                      id="vcs-identifier"
                      value={vcsIdentifier}
                      onValueChange={setVcsIdentifier}
                      repositories={vcsRepositories}
                      loading={vcsReposLoading}
                      disabled={loading}
                      placeholder="e.g. organization/repository"
                    />
                  )}
                </div>
              </div>
            )}

            {sourceType === "local" && (
              <p className="text-sm text-muted-foreground">
                Code will be loaded from <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">/app/backend/storage/local/{orgName}/{projectId === "" ? "default" : projectId}/{name.trim() === "" ? "{name}" : name.trim()}</code>. Make sure to bind mount this path to your Terraform code.
              </p>
            )}
          </div>
          <details className="group rounded-lg border border-border">
            <summary className="cursor-pointer rounded-lg px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Advanced settings
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                Execution, engine version, project, and automatic applies
              </span>
            </summary>
            <div className="flex flex-col gap-4 border-t border-border p-4">
          {projects.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="workspace-project" className="text-sm font-medium">Project (optional)</label>
              <Select
                id="workspace-project"
                name="project"
                value={projectId}
                onValueChange={setProjectId}
              >
                <SelectItem value="">Organization default project</SelectItem>
                {projects.map((project): React.JSX.Element => (
                  <SelectItem key={project.id} value={project.id}>{project.attributes.name}</SelectItem>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">Choose the project that will own this workspace.</p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <label htmlFor="exec-mode" className="text-sm font-medium">Execution mode</label>
              <HelpTooltip content="Remote runs execute on the built-in Terrence server worker, agent runs execute in an agent pool, and local runs execute on your CLI." />
            </div>
            <Select
              id="exec-mode"
              name="execution-mode"
              value={executionMode}
              onValueChange={setExecutionMode}
            >
              <SelectItem value="inherit">Use project default</SelectItem>
              <SelectItem value="remote">Terrence server (Remote)</SelectItem>
              <SelectItem value="agent">Agent pool</SelectItem>
              <SelectItem value="local">Your computer (Local)</SelectItem>
            </Select>
            <p className="text-xs text-muted-foreground">
              {executionMode === "inherit"
                ? "Use the execution mode and agent pool configured for the selected project."
                : executionMode === "agent"
                ? "Runs wait for an agent pool to pick them up."
                : executionMode === "local"
                  ? "Runs execute on your CLI; the server only tracks state."
                  : "Runs execute on the built-in Terrence server worker."}
            </p>
            {executionMode === "agent" && agentPools.pools.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="create-agent-pool" className="text-sm font-medium">Agent pool</label>
                <Select id="create-agent-pool" value={agentPoolId} onValueChange={setAgentPoolId}>
                  <SelectItem value="">Choose an agent pool</SelectItem>
                  {agentPools.pools.map((pool) => <SelectItem key={pool.id} value={pool.id}>{pool.attributes.name}</SelectItem>)}
                </Select>
              </div>
            )}
            {executionMode === "agent" && agentPools.loading && (
              <p className="text-xs text-muted-foreground">Checking organization agent pools…</p>
            )}
            {executionMode === "agent" && !agentPools.loading && agentPools.error !== "" && (
              <p role="alert" className="text-xs text-destructive">{agentPools.error}</p>
            )}
            {executionMode === "agent" && !agentPools.loading && agentPools.error === "" && agentPools.pools.length === 0 && (
              <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                No agent pools are available. Create a pool in organization settings, or choose server or local execution.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="tf-version" className="text-sm font-medium">Engine version</label>
            <Select
              id="tf-version"
              name="terraform-version"
              value={terraformVersion}
              onValueChange={setTerraformVersion}
            >
              <SelectItem value="latest">Latest available</SelectItem>
              {terraformVersion !== "latest" && !availableVersions.includes(terraformVersion) && (
                <SelectItem value={terraformVersion}>{terraformVersion} (organization default)</SelectItem>
              )}
              {availableVersions.map((version): React.JSX.Element => <SelectItem key={version} value={version}>{version}</SelectItem>)}
            </Select>
            <p className="text-xs text-muted-foreground">{versionsLoading ? "Loading supported versions…" : "Versions are fetched from the selected engine release catalog."}</p>
          </div>

          <div className="flex items-center gap-2 mt-1">
            <Checkbox id="auto-apply" checked={autoApply} onCheckedChange={(c: boolean): void => { setAutoApply(c); }} />
            <label htmlFor="auto-apply" className="text-sm font-medium leading-none cursor-pointer">
              Apply changes without manual approval
            </label>
          </div>

            </div>
          </details>
          <p className="text-xs text-muted-foreground" role="status">
            {executionMode === "inherit"
              ? `Execution follows your project settings. ${autoApply ? "Changes apply automatically for remote runs." : "Remote plans require your approval before applying changes."}`
              : executionMode === "local"
              ? "Runs stay on your computer; Terrence stores the state."
              : `${executionMode === "agent" ? "An agent" : "Terrence"} runs your plans. ${autoApply ? "Changes apply automatically." : "You review each plan before applying changes."}`}
          </p>
          {submitError !== "" && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" disabled={loading} onClick={(): void => { onOpenChange(false); }}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || name.trim() === ""}>
              {loading && <Spinner data-icon="inline-start" />}
              Create Workspace
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}