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
import { isString } from "../lib/type-guards";

type CreateWorkspaceModalProps = {
  orgName: string;
  defaultIacBinary?: string;
  defaultTerraformVersion?: string;
  projects?: readonly WorkspaceProject[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (ws: Readonly<{ id: string }>) => void;
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
  const [iacBinary, setIacBinary] = useState(defaultIacBinary ?? "tofu");
  const [terraformVersion, setTerraformVersion] = useState(defaultTerraformVersion ?? "latest");
  const [availableVersions, setAvailableVersions] = useState<string[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
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
    if (open) setProjectId("");
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

  const handleSubmit = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    const workspaceName = name.trim();
    if (workspaceName === "") return;
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
      onCreated(res.data);
      onOpenChange(false);
      setName("");
      setProjectId("");
      setAutoApply(false);
      setIacBinary(defaultIacBinary ?? "tofu");
      setTerraformVersion(defaultTerraformVersion ?? "latest");
      setVcsIdentifier("");
      setVcsConnectionValue("");
      setSourceType("tfe-api");
      toast.add({ title: "Workspace created", type: "success" });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Failed to create workspace";
      toast.add({ title: "Could not create workspace", description: errorMessage, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>New Workspace</DialogTitle>
          <DialogDescription>Create a new workspace under {orgName}.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ws-name" className="text-sm font-medium">Workspace Name</label>
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
            <label htmlFor="iac-tool" className="text-sm font-medium">Execution Engine</label>
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

          <div className="flex flex-col gap-1.5">
            <label htmlFor="tf-version" className="text-sm font-medium">Engine Version</label>
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
              Auto-apply plans upon completion
            </label>
          </div>

          <div className="pt-4 border-t border-border mt-2">
            <div className="flex flex-col gap-1.5 mb-4">
              <label htmlFor="source-type" className="text-sm font-medium">Workspace Source</label>
              <Select
                id="source-type"
                name="workspace-source"
                value={sourceType}
                onValueChange={setSourceType}
              >
                <SelectItem value="tfe-api">API-driven (CLI or pipeline)</SelectItem>
                <SelectItem value="local">Local path directory</SelectItem>
                <SelectItem value="vcs">Version control (VCS)</SelectItem>
              </Select>
            </div>

            {sourceType === "vcs" && (
              <div className="grid gap-4">
                <div className="flex flex-col gap-2">
                  <label htmlFor="vcs-connection" className="text-sm font-medium leading-none">VCS Connection</label>
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
                Code will be loaded from `/app/backend/storage/local/{orgName}/{"{project_name}"}/{name}`. Make sure to bind mount this path to your Terraform code.
              </p>
            )}
          </div>
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