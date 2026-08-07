import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Spinner } from "../components/ui/spinner";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Layers, Pencil, RefreshCw, Trash2 } from "lucide-react";

type VcsRepo = { identifier?: string; branch?: string | null } | null;

type Stack = {
  id: string;
  attributes: {
    name: string;
    description?: string;
    "vcs-repo"?: VcsRepo;
    "working-directory"?: string | null;
    "speculative-enabled"?: boolean;
    "created-at"?: string;
  };
};

type Project = { id: string; attributes: { name: string } };

type StackForm = {
  name: string;
  projectId: string;
  description: string;
  workingDirectory: string;
  vcsIdentifier: string;
  vcsBranch: string;
  speculative: boolean;
};

const emptyForm: StackForm = {
  name: "",
  projectId: "",
  description: "",
  workingDirectory: "",
  vcsIdentifier: "",
  vcsBranch: "",
  speculative: false,
};

export function StackSettings(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [manageableOrganizationName, setManageableOrganizationName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const canManage = orgName !== "" && manageableOrganizationName === orgName;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingStack, setEditingStack] = useState<Stack | null>(null);
  const [form, setForm] = useState<StackForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  const [stackToDelete, setStackToDelete] = useState<Stack | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [fetchingStackId, setFetchingStackId] = useState<string | null>(null);

  useEffect((): void => {
    setStacks([]);
    setProjects([]);
    setManageableOrganizationName("");
    setStackToDelete(null);
    if (orgName !== "") void loadStacks();
  }, [orgName]);

  const loadStacks = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    try {
      const organizationResponse = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}`,
      ) as {
        data?: { attributes?: { permissions?: { "can-manage-projects"?: boolean } } };
      };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      const permissions = organizationResponse.data?.attributes?.permissions;
      if (permissions?.["can-manage-projects"] !== true) {
        setError("You do not have permission to manage stacks for this organization.");
        setLoading(false);
        return;
      }
      setManageableOrganizationName(requestedOrganizationName);
      const [stacksResponse, projectsResponse] = await Promise.all([
        fetchApi(`/organizations/${encodeURIComponent(requestedOrganizationName)}/stacks`) as Promise<{ data: Stack[] }>,
        fetchApi(`/organizations/${encodeURIComponent(requestedOrganizationName)}/projects`) as Promise<{ data: Project[] }>,
      ]);
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setStacks(stacksResponse.data);
      setProjects(projectsResponse.data);
    } catch (reason) {
      if (activeOrganizationName.current === requestedOrganizationName) {
        setError(reason instanceof Error ? reason.message : "Failed to load stacks.");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  };

  const openCreate = (): void => {
    setEditingStack(null);
    const singleProject = projects.length === 1 ? projects[0] : undefined;
    setForm(singleProject === undefined ? emptyForm : { ...emptyForm, projectId: singleProject.id });
    setDialogOpen(true);
  };

  const openEdit = (stack: Stack): void => {
    const vcs = stack.attributes["vcs-repo"] ?? null;
    setEditingStack(stack);
    setForm({
      name: stack.attributes.name,
      projectId: "",
      description: stack.attributes.description ?? "",
      workingDirectory: stack.attributes["working-directory"] ?? "",
      vcsIdentifier: vcs?.identifier ?? "",
      vcsBranch: vcs?.branch ?? "",
      speculative: stack.attributes["speculative-enabled"] === true,
    });
    setDialogOpen(true);
  };

  const set = (key: keyof StackForm): ((e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void) =>
    (e): void => { setForm((prev): StackForm => ({ ...prev, [key]: e.target.value })); };

  const submit = async (): Promise<void> => {
    setSaving(true);
    setError("");
    const safe = (value: string): string => value.trim();
    const name = safe(form.name);
    if (name === "") {
      setError("A stack name is required.");
      setSaving(false);
      return;
    }
    if (form.projectId === "") {
      setError("A project is required.");
      setSaving(false);
      return;
    }
    // Only send vcs-repo when an identifier is supplied, otherwise omit it
    // (an empty object would otherwise clear/override the stored VCS values).
    const vcsIdentifier = safe(form.vcsIdentifier);
    const vcsBranch = form.vcsBranch.trim();
    const attributes: Record<string, unknown> = {
      name,
      description: form.description,
      "working-directory": form.workingDirectory === "" ? (editingStack === null ? undefined : form.workingDirectory) : form.workingDirectory,
      "speculative-enabled": form.speculative,
    };
    const originalVcsIdentifier = (editingStack?.attributes["vcs-repo"]?.identifier ?? "").trim();
    if (vcsIdentifier !== "") {
      attributes["vcs-repo"] = { identifier: vcsIdentifier, ...(vcsBranch === "" ? {} : { branch: vcsBranch }) };
    } else if (editingStack !== null && originalVcsIdentifier !== "") {
      // Editing a stack that currently has a VCS repo but the identifier was
      // cleared: explicitly clear the stored VCS config.
      attributes["vcs-repo"] = null;
    }
    try {
      if (editingStack === null) {
        await fetchApi("/stacks", {
          method: "POST",
          body: JSON.stringify({
            data: {
              attributes,
              relationships: { project: { data: { id: form.projectId, type: "projects" } } },
            },
          }),
        });
      } else {
        await fetchApi(`/stacks/${editingStack.id}`, {
          method: "PATCH",
          body: JSON.stringify({ data: { attributes } }),
        });
      }
      setDialogOpen(false);
      await loadStacks();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to save stack.");
    } finally {
      setSaving(false);
    }
  };

  const fetchLatest = async (stack: Stack): Promise<void> => {
    setFetchingStackId(stack.id);
    setError("");
    try {
      await fetchApi(`/stacks/${stack.id}/fetch-latest-from-vcs`, { method: "POST" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to fetch latest from VCS.");
    } finally {
      setFetchingStackId(null);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (stackToDelete === null) return;
    setDeleting(true);
    setError("");
    try {
      await fetchApi(`/stacks/${stackToDelete.id}`, { method: "DELETE" });
      setStacks((prev): Stack[] => prev.filter((s): boolean => s.id !== stackToDelete.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to delete stack.");
    } finally {
      setDeleting(false);
      setStackToDelete(null);
    }
  };

  const vcsRepo = (stack: Stack): VcsRepo => stack.attributes["vcs-repo"] ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Stacks</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Stacks let you manage collections of workspaces and the infrastructure they deploy.
          </p>
        </div>
        {canManage && (
          <Button onClick={openCreate}>
            <span className="mr-1.5 text-base leading-none">+</span> New stack
          </Button>
        )}
      </div>

      {error !== "" && !loading && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      <Card>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : stacks.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
              <Layers className="h-8 w-8" />
              <p className="text-sm">{canManage ? "No stacks yet. Create one to get started." : "No stacks."}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>VCS repo</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Working directory</TableHead>
                  <TableHead>Speculative</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {stacks.map((stack): React.JSX.Element => (
                  <TableRow key={stack.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Layers className="h-4 w-4 text-muted-foreground" />
                        {stack.attributes.name}
                      </div>
                      {typeof stack.attributes.description === "string" && stack.attributes.description !== "" && (
                        <div className="text-xs text-muted-foreground">{stack.attributes.description}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {vcsRepo(stack)?.identifier ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {vcsRepo(stack)?.branch ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {stack.attributes["working-directory"] ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {stack.attributes["speculative-enabled"] === true ? "Enabled" : "Disabled"}
                    </TableCell>
                    <TableCell>
                      {canManage && (
                        <div className="flex items-center justify-end gap-1">
                          {((vcsRepo(stack)?.identifier ?? "").trim()) !== "" && (
                            <Button variant="ghost" size="icon" onClick={(): void => { void fetchLatest(stack); }} aria-label={`Fetch latest for ${stack.attributes.name}`} disabled={fetchingStackId === stack.id}>
                              <RefreshCw className={`h-4 w-4 ${fetchingStackId === stack.id ? "animate-spin" : ""}`} />
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" onClick={(): void => { openEdit(stack); }} aria-label={`Edit ${stack.attributes.name}`}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={(): void => { setStackToDelete(stack); }} aria-label={`Delete ${stack.attributes.name}`}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingStack === null ? "Create stack" : `Edit ${editingStack.attributes.name}`}</DialogTitle>
            <DialogDescription>
              {editingStack === null
                ? "Create a new stack. The project is required."
                : "Update this stack's configuration."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="stack-name">Name</Label>
              <Input id="stack-name" value={form.name} onChange={set("name")} placeholder="my-stack" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stack-project">Project</Label>
              <select
                id="stack-project"
                value={form.projectId}
                onChange={set("projectId")}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                disabled={editingStack !== null}
              >
                <option value="">Select a project</option>
                {projects.map((project): React.JSX.Element => (
                  <option key={project.id} value={project.id}>{project.attributes.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stack-vcs">VCS repository identifier</Label>
              <Input id="stack-vcs" value={form.vcsIdentifier} onChange={set("vcsIdentifier")} placeholder="registry-example/hashicorp-aws (owner/repo)" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="stack-branch">Branch</Label>
                <Input id="stack-branch" value={form.vcsBranch} onChange={set("vcsBranch")} placeholder="main (optional)" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="stack-working-dir">Working directory</Label>
                <Input id="stack-working-dir" value={form.workingDirectory} onChange={set("workingDirectory")} placeholder="terraform (optional)" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stack-description">Description</Label>
              <Input id="stack-description" value={form.description} onChange={set("description")} placeholder="Optional" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.speculative}
                onChange={(e): void => { setForm((prev): StackForm => ({ ...prev, speculative: e.target.checked })); }}
              />
              Speculative planner enabled
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={(): void => { setDialogOpen(false); }}>Cancel</Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? "Saving…" : editingStack === null ? "Create stack" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={stackToDelete !== null}
        onOpenChange={(open): void => { if (!open) setStackToDelete(null); }}
        title="Delete stack"
        description="Deleting a stack removes it and its deployments."
        confirmText="Delete"
        confirmVariant="destructive"
        loading={deleting}
        onConfirm={confirmDelete}
      />
    </div>
  );
}