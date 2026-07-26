import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { fetchApi } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { RunList } from "./RunList";
import { StateHistory } from "./StateHistory";

function getEngine(attrs: any): string {
  return attrs?.["iac-binary"] || attrs?.["execution-mode"] || "tofu";
}

export function WorkspaceDetail() {
  const { orgName, workspaceName } = useParams();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState<any>(null);
  const [variables, setVariables] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<"overview" | "variables" | "runs" | "states" | "settings">("overview");

  // Variable Form state
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [category, setCategory] = useState("terraform");
  const [sensitive, setSensitive] = useState(false);
  const [open, setOpen] = useState(false);

  // Settings state
  const [autoApply, setAutoApply] = useState(false);
  const [iacBinary, setIacBinary] = useState("tofu");
  const [terraformVersion, setTerraformVersion] = useState("latest");
  const [savingSettings, setSavingSettings] = useState(false);

  const loadWorkspaceData = async () => {
    try {
      const wsRes = await fetchApi(`/organizations/${orgName}/workspaces/${workspaceName}`);
      setWorkspace(wsRes.data);
      setAutoApply(Boolean(wsRes.data.attributes["auto-apply"]));
      setIacBinary(getEngine(wsRes.data.attributes));
      setTerraformVersion(wsRes.data.attributes["terraform-version"] || "latest");

      try {
        const varsRes = await fetchApi(`/workspaces/${wsRes.data.id}/vars`);
        setVariables(varsRes.data || []);
      } catch (varErr: any) {
        console.error("Failed to load workspace variables", varErr);
      }
    } catch (wsErr: any) {
      console.error("Failed to load workspace details", wsErr);
    }
  };

  useEffect(() => {
    loadWorkspaceData();
  }, [orgName, workspaceName]);

  const addVariable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace) return;
    try {
      const response = await fetchApi(`/workspaces/${workspace.id}/vars`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            attributes: { key, value, category, sensitive },
            type: "vars",
          },
        }),
      });
      setVariables([...variables, response.data]);
      setOpen(false);
      setKey("");
      setValue("");
      setSensitive(false);
      setCategory("terraform");
    } catch (error: any) {
      console.error(error);
      alert(error.message || "Failed to create variable");
    }
  };

  const deleteVariable = async (varId: string) => {
    if (!workspace) return;
    if (!confirm("Are you sure you want to delete this variable?")) return;
    try {
      await fetchApi(`/workspaces/${workspace.id}/vars/${varId}`, { method: "DELETE" });
      setVariables(variables.filter((v) => v.id !== varId));
    } catch (error: any) {
      alert(error.message || "Failed to delete variable");
    }
  };

  const toggleLock = async () => {
    if (!workspace) return;
    const action = workspace.attributes.locked ? "unlock" : "lock";
    try {
      const res = await fetchApi(`/workspaces/${workspace.id}/actions/${action}`, { method: "POST" });
      setWorkspace({
        ...workspace,
        attributes: { ...workspace.attributes, locked: res.data.attributes.locked },
      });
    } catch (err: any) {
      alert(err.message || `Failed to ${action} workspace`);
    }
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace) return;
    setSavingSettings(true);
    try {
      const res = await fetchApi(`/workspaces/${workspace.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            attributes: {
              "auto-apply": autoApply,
              "iac-binary": iacBinary,
              "terraform-version": terraformVersion,
            },
          },
        }),
      });
      setWorkspace(res.data);
      setAutoApply(Boolean(res.data.attributes["auto-apply"]));
      setIacBinary(getEngine(res.data.attributes));
      setTerraformVersion(res.data.attributes["terraform-version"] || "latest");
      alert("Settings saved successfully");
    } catch (err: any) {
      alert(err.message || "Failed to save settings");
    } finally {
      setSavingSettings(false);
    }
  };

  const deleteWorkspace = async () => {
    if (!workspace) return;
    if (!confirm(`Are you sure you want to delete workspace "${workspaceName}"?`)) return;
    try {
      await fetchApi(`/workspaces/${workspace.id}`, { method: "DELETE" });
      navigate(`/app/${orgName}`);
    } catch (err: any) {
      alert(err.message || "Failed to delete workspace");
    }
  };

  if (!workspace) return <div className="p-8">Loading workspace...</div>;

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center border-b pb-4">
        <div>
          <div className="text-sm text-gray-500 flex items-center gap-1.5">
            <Link to={`/app/${orgName}`} className="hover:underline">{orgName}</Link> /
            <span>{workspaceName}</span>
          </div>
          <h1 className="text-3xl font-bold mt-1">{workspaceName}</h1>
        </div>

        <div className="flex items-center gap-3">
          <Button variant={workspace.attributes.locked ? "destructive" : "outline"} onClick={toggleLock}>
            {workspace.attributes.locked ? "Unlock Workspace" : "Lock Workspace"}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b">
        {(["overview", "runs", "variables", "states", "settings"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 capitalize transition-colors ${
              activeTab === tab
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            {tab === "states" ? "State Versions" : tab}
          </button>
        ))}
      </div>

      {/* Tab Contents */}
      {activeTab === "overview" && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="border rounded-lg p-6 bg-white space-y-4">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Execution Engine</h3>
            <p className="text-2xl font-bold text-gray-900 capitalize">
              {getEngine(workspace.attributes)}
            </p>
            <p className="text-xs text-gray-500">Selected IaC CLI runner engine.</p>
          </div>
          <div className="border rounded-lg p-6 bg-white space-y-4">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Engine Version</h3>
            <p className="text-2xl font-bold text-gray-900">{workspace.attributes["terraform-version"] || "latest"}</p>
            <p className="text-xs text-gray-500">Dynamically resolved CLI version.</p>
          </div>
          <div className="border rounded-lg p-6 bg-white space-y-4">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Auto-Apply</h3>
            <p className="text-2xl font-bold text-gray-900">{workspace.attributes["auto-apply"] ? "Enabled" : "Disabled"}</p>
            <p className="text-xs text-gray-500">Automatic plan apply on success.</p>
          </div>
        </div>
      )}

      {activeTab === "runs" && (
        <RunList workspaceId={workspace.id} orgName={orgName!} workspaceName={workspaceName!} />
      )}

      {activeTab === "variables" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold">Variables</h2>

            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button type="button">Add variable</Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle>Add Variable</DialogTitle>
                  <DialogDescription>Add a new workspace variable.</DialogDescription>
                </DialogHeader>
                <form onSubmit={addVariable}>
                  <div className="grid gap-4 py-4">
                    <div className="space-y-2">
                      <label htmlFor="key" className="text-sm font-medium">Key</label>
                      <Input id="key" value={key} onChange={(e) => setKey(e.target.value)} required />
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="value" className="text-sm font-medium">Value</label>
                      <Input id="value" value={value} onChange={(e) => setValue(e.target.value)} required />
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="category" className="text-sm font-medium">Category</label>
                      <select
                        id="category"
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                      >
                        <option value="terraform">Terraform (TF_VAR)</option>
                        <option value="env">Environment Variable</option>
                      </select>
                    </div>
                    <div className="flex items-center space-x-2 mt-2">
                      <Checkbox id="sensitive" checked={sensitive} onCheckedChange={(c: boolean) => setSensitive(c)} />
                      <label htmlFor="sensitive" className="text-sm font-medium cursor-pointer">
                        Sensitive (hidden in API responses)
                      </label>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button type="submit">Save variable</Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Sensitive</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {variables.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="font-mono font-medium">{v.attributes.key}</TableCell>
                    <TableCell className="font-mono text-xs">{v.attributes.sensitive ? "••••••••" : v.attributes.value}</TableCell>
                    <TableCell className="capitalize">{v.attributes.category}</TableCell>
                    <TableCell>{v.attributes.sensitive ? "Yes" : "No"}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => deleteVariable(v.id)} className="text-rose-600 hover:text-rose-700">
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {variables.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-gray-500 py-8">
                      No variables defined.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {activeTab === "states" && (
        <StateHistory workspaceId={workspace.id} />
      )}

      {activeTab === "settings" && (
        <div className="flex flex-col gap-6 max-w-xl">
          <form onSubmit={saveSettings} className="border rounded-lg p-6 bg-white flex flex-col gap-4">
            <h3 className="text-lg font-semibold border-b pb-2">Workspace Settings</h3>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="setting-engine" className="text-sm font-medium">Execution Engine</label>
              <select
                id="setting-engine"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={iacBinary}
                onChange={(e) => setIacBinary(e.target.value)}
              >
                <option value="tofu">OpenTofu (tofu)</option>
                <option value="terraform">Terraform (terraform)</option>
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="setting-ver" className="text-sm font-medium">Terraform / OpenTofu Version</label>
              <Input id="setting-ver" value={terraformVersion} onChange={(e) => setTerraformVersion(e.target.value)} placeholder="e.g. 1.8.5, 1.9.3, latest" />
              <p className="text-xs text-gray-500">Specifying a version will dynamically fetch and cache that exact CLI version.</p>
            </div>

            <div className="flex items-center gap-2 mt-2">
              <Checkbox id="setting-autoapply" checked={autoApply} onCheckedChange={(c: boolean) => setAutoApply(c)} />
              <label htmlFor="setting-autoapply" className="text-sm font-medium cursor-pointer">
                Auto-apply plans upon successful completion
              </label>
            </div>

            <Button type="submit" disabled={savingSettings} className="w-fit mt-2">
              {savingSettings ? "Saving..." : "Save Settings"}
            </Button>
          </form>

          <div className="border border-rose-200 rounded-lg p-6 bg-rose-50/50 flex flex-col gap-3">
            <h3 className="text-lg font-semibold text-rose-800">Danger Zone</h3>
            <p className="text-xs text-rose-700">Deleting a workspace permanently removes all associated variables, runs, logs, and state versions.</p>
            <Button variant="destructive" onClick={deleteWorkspace} className="w-fit">
              Delete Workspace
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
