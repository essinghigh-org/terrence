import { useState } from "react";
import { fetchApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/components/ui/toast";

type CreateWorkspaceModalProps = {
  orgName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (ws: Readonly<{ id: string }>) => void;
}

export function CreateWorkspaceModal(props: Readonly<CreateWorkspaceModalProps>): React.JSX.Element {
  const { orgName, open, onOpenChange, onCreated } = props;
  const [name, setName] = useState("");
  const [autoApply, setAutoApply] = useState(false);
  const [iacBinary, setIacBinary] = useState("tofu");
  const [terraformVersion, setTerraformVersion] = useState("latest");
  const [loading, setLoading] = useState(false);
  const [vcsIdentifier, setVcsIdentifier] = useState("");
  const [ghAppInstallationId, setGhAppInstallationId] = useState("");
  const [sourceType, setSourceType] = useState("tfe-api");


  const handleSubmit = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    const normalizedVcsIdentifier = vcsIdentifier.trim();
    const normalizedInstallationId = ghAppInstallationId.trim();
    if ((normalizedVcsIdentifier === "") !== (normalizedInstallationId === "")) {
      toast.add({
        title: "Incomplete VCS connection",
        description: "Provide both a repository identifier and GitHub App installation ID.",
        type: "error",
      });
      return;
    }
    setLoading(true);
    const normalizedVersion = terraformVersion.trim() !== "" ? terraformVersion.trim() : "latest";
    try {

      const vcsRepo = sourceType === "vcs" && normalizedVcsIdentifier !== ""
        ? { identifier: normalizedVcsIdentifier, "github-app-installation-id": normalizedInstallationId }
        : undefined;

      const res = await fetchApi(`/organizations/${orgName}/workspaces`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            attributes: {
              name: name.trim(),
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
      setIacBinary("tofu");
      setTerraformVersion("latest");
      setVcsIdentifier("");
      setGhAppInstallationId("");
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
      <DialogContent className="sm:max-w-[425px]">
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
            <h4 className="text-sm font-medium mb-3">Workspace Source</h4>
            <div className="flex flex-col gap-1.5 mb-4">
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
                  <label htmlFor="vcs-identifier" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                    Repository Identifier
                  </label>
                  <Input
                    id="vcs-identifier"
                    value={vcsIdentifier}
                    onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setVcsIdentifier(event.currentTarget.value); }}
                    placeholder="e.g. hashicorp/terraform"
                    disabled={loading}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label htmlFor="gh-app-id" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                    GitHub App Installation ID
                  </label>
                  <Input
                    id="gh-app-id"
                    value={ghAppInstallationId}
                    onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setGhAppInstallationId(event.currentTarget.value); }}
                    placeholder="e.g. ghain-xxxxxxxx"
                    disabled={loading}
                  />
                  <p className="text-xs text-gray-500">Provide both Identifier and Installation ID to connect this workspace to GitHub.</p>
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
            <Button type="submit" disabled={loading}>
              {loading ? "Creating..." : "Create Workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
