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

type CreateWorkspaceModalProps = {
  orgName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (ws: { id: string }) => void;
}

export function CreateWorkspaceModal({ orgName, open, onOpenChange, onCreated }: CreateWorkspaceModalProps): React.JSX.Element {
  const [name, setName] = useState("");
  const [autoApply, setAutoApply] = useState(false);
  const [iacBinary, setIacBinary] = useState("tofu");
  const [terraformVersion, setTerraformVersion] = useState("latest");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    setLoading(true);
    const normalizedVersion = terraformVersion.trim() !== "" ? terraformVersion.trim() : "latest";
    try {
      const res = await fetchApi(`/organizations/${orgName}/workspaces`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            attributes: {
              name: name.trim(),
              "auto-apply": autoApply,
              "iac-binary": iacBinary,
              "terraform-version": normalizedVersion,
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
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Failed to create workspace";
      alert(errorMessage);
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
              onChange={(e): void => { setName(e.currentTarget.value); }}
              onInput={(e): void => { setName(e.currentTarget.value); }}
              placeholder="my-infrastructure"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="iac-tool" className="text-sm font-medium">Execution Engine</label>
            <select
              id="iac-tool"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              value={iacBinary}
              onChange={(e): void => { setIacBinary(e.target.value); }}
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
              onChange={(e): void => { setTerraformVersion(e.currentTarget.value); }}
              onInput={(e): void => { setTerraformVersion(e.currentTarget.value); }}
              placeholder="latest"
            />
          </div>

          <div className="flex items-center gap-2 mt-1">
            <Checkbox id="auto-apply" checked={autoApply} onCheckedChange={(c: boolean): void => { setAutoApply(c); }} />
            <label htmlFor="auto-apply" className="text-sm font-medium leading-none cursor-pointer">
              Auto-apply plans upon completion
            </label>
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
