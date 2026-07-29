import { useEffect, useState } from "react";
import { fetchApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loadOrganizationVcsConnections, type VcsConnection } from "@/components/WorkspaceVcs";
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

type CreateWorkspaceModalProps = {
  orgName: string;
  defaultIacBinary?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (ws: Readonly<{ id: string }>) => void;
}

type VcsRepoOption = {
  identifier: string;
  name: string;
};

export function CreateWorkspaceModal(props: Readonly<CreateWorkspaceModalProps>): React.JSX.Element {
  const { orgName, defaultIacBinary, open, onOpenChange, onCreated } = props;
  const [name, setName] = useState("");
  const [autoApply, setAutoApply] = useState(false);
  const [iacBinary, setIacBinary] = useState(defaultIacBinary ?? "tofu");
  const [terraformVersion, setTerraformVersion] = useState("latest");
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
  }, [defaultIacBinary, open]);

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
    void fetchApi(
      `/organizations/${encodeURIComponent(orgName)}/vcs-connections/${encodeURIComponent(vcsConnectionValue)}/repositories`,
      { signal: controller.signal },
    )
      .then((res: unknown): void => {
        if (controller.signal.aborted) return;
        const list = (res as { data?: Array<{ attributes: { identifier: string; name: string } }> }).data;
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
          },
        }),
      }) as { data: { id: string } };
      onCreated(res.data);
      onOpenChange(false);
      setName("");
      setAutoApply(false);
      setIacBinary(defaultIacBinary ?? "tofu");
      setTerraformVersion("latest");
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
              value={name}
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setName(event.currentTarget.value); }}
              onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setName(event.currentTarget.value); }}
              placeholder="my-infrastructure"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="iac-tool" className="text-sm font-medium">Execution Engine</label>
            <select
              id="iac-tool"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              value={iacBinary}
              onChange={(event: React.ChangeEvent<HTMLSelectElement>): void => { setIacBinary(event.target.value); }}
            >
              <option value="tofu">OpenTofu (tofu)</option>
              <option value="terraform">Terraform (terraform)</option>
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="tf-version" className="text-xs font-medium font-mono text-gray-600">Engine Version (e.g. 1.8.5, 1.9.3, latest)</label>
            <Input
              id="tf-version"
              value={terraformVersion}
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setTerraformVersion(event.currentTarget.value); }}
              onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setTerraformVersion(event.currentTarget.value); }}
              placeholder="latest"
            />
          </div>

          <div className="flex items-center gap-2 mt-1">
            <Checkbox id="auto-apply" checked={autoApply} onCheckedChange={(c: boolean): void => { setAutoApply(c); }} />
            <label htmlFor="auto-apply" className="text-sm font-medium leading-none cursor-pointer">
              Auto-apply plans upon completion
            </label>
          </div>

          <div className="pt-4 border-t border-gray-200 mt-2">
            <div className="flex flex-col gap-1.5 mb-4">
              <label htmlFor="source-type" className="text-sm font-medium">Workspace Source</label>
              <select
                id="source-type"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={sourceType}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>): void => { setSourceType(event.target.value); }}
              >
                <option value="tfe-api">API Driven (tfe-api)</option>
                <option value="local">Local Path Directory</option>
                <option value="vcs">Version Control (VCS)</option>
              </select>
            </div>

            {sourceType === "vcs" && (
              <div className="grid gap-4">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-1">
                    <label htmlFor="vcs-identifier" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                      Repository Identifier
                    </label>
                    <HelpTooltip content="Select from accessible repositories or type a repository path (e.g. 'org/repo-name')." />
                  </div>

                  {vcsRepositories.length > 0 && (
                    <select
                      id="vcs-repo-select"
                      aria-label="Accessible repositories dropdown"
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                      value={vcsIdentifier}
                      onChange={(e): void => { setVcsIdentifier(e.target.value); }}
                      disabled={loading}
                    >
                      <option value="">-- Choose an accessible repository --</option>
                      {vcsRepositories.map((repo): React.JSX.Element => (
                        <option key={repo.identifier} value={repo.identifier}>
                          {repo.identifier}
                        </option>
                      ))}
                    </select>
                  )}

                  <Input
                    id="vcs-identifier"
                    value={vcsIdentifier}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setVcsIdentifier(event.currentTarget.value); }}
                    onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setVcsIdentifier(event.currentTarget.value); }}
                    placeholder={vcsReposLoading ? "Fetching accessible repositories…" : "e.g. hashicorp/terraform"}
                    disabled={loading || vcsReposLoading}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <label htmlFor="vcs-connection" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                    VCS Connection
                  </label>
                  <select
                    id="vcs-connection"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                    value={vcsConnectionValue}
                    onChange={(event: React.ChangeEvent<HTMLSelectElement>): void => {
                      setVcsConnectionValue(event.target.value);
                    }}
                    disabled={loading || vcsConnectionsLoading}
                  >
                    <option value="">
                      {vcsConnectionsLoading ? "Loading registered connections…" : "Select a registered connection"}
                    </option>
                    {vcsConnections.map((connection: VcsConnection): React.JSX.Element => (
                      <option key={connection.value} value={connection.value}>{connection.label}</option>
                    ))}
                  </select>
                  <p
                    role={vcsConnectionsError === "" ? undefined : "alert"}
                    className={vcsConnectionsError === "" ? "text-xs text-gray-500" : "text-xs text-destructive"}
                  >
                    {vcsConnectionsError !== ""
                      ? vcsConnectionsError
                      : vcsConnections.length === 0 && !vcsConnectionsLoading
                        ? "No registered connections are available. Add one in organization VCS settings."
                        : "Choose a registered GitHub App or OAuth connection."}
                  </p>
                </div>
              </div>
            )}

            {sourceType === "local" && (
              <p className="text-sm text-gray-600">
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
