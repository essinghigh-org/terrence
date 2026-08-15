import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Spinner } from "../components/ui/spinner";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { useOrganizationPermissions } from "../hooks/useOrganizationPermissions";
import { Layers, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";
import { isString } from "../lib/type-guards";

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const orgPermissions = useOrganizationPermissions(orgName === "" ? undefined : orgName);
  const canManage = orgName !== "" && orgPermissions.loaded && orgPermissions.has("can-manage-projects");

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
    setStackToDelete(null);
    permissionGateFired.current = false;
  }, [orgName]);

  // Central permission gate (14.6): once org permissions load, surface a clear
  // error when the operator lacks access. When access is granted, load the data
  // exactly once (the initial call early-returns while permissions are loading).
  const permissionGateFired = useRef(false);
  useEffect((): void => {
    if (!orgPermissions.loaded) return;
    if (orgPermissions.has("can-manage-projects")) {
      setError("");
      if (!permissionGateFired.current) {
        permissionGateFired.current = true;
        void loadStacks();
      }
    } else {
      setError(orgPermissions.error ?? "You do not have permission to manage stacks for this organization.");
    }
  }, [orgPermissions.loaded, orgPermissions.has]);

  const loadStacks = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    if (!canManage) {
      setLoading(false);
      return;
    }
    try {
      // SAFETY: both endpoints return the JSON:API list envelope per contract.
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
    const originalVcsIdentifier = (editingStack?.attributes["vcs-repo"]?.identifier ?? "").trim();
    const attributes = {
      name,
      description: form.description,
      "working-directory": form.workingDirectory === "" ? (editingStack === null ? undefined : form.workingDirectory) : form.workingDirectory,
      "speculative-enabled": form.speculative,
      ...(vcsIdentifier !== ""
        ? { "vcs-repo": { identifier: vcsIdentifier, ...(vcsBranch === "" ? undefined : { branch: vcsBranch }) } }
        : editingStack !== null && originalVcsIdentifier !== ""
          // Editing a stack that currently has a VCS repo but the identifier was
          // cleared: explicitly clear the stored VCS config.
          ? { "vcs-repo": null }
          : undefined),
    };
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
    <PageShell>
      <PageHeader
        eyebrow={`${orgName} / Settings`}
        title="Stacks"
        description="Stacks let you manage collections of workspaces and the infrastructure they deploy."
        action={canManage ? (
          <Button onClick={openCreate}>
            <span className="mr-1.5 text-base leading-none">+</span> New stack
          </Button>
        ) : undefined}
      />

      {error !== "" && !loading && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      <Card>
        <CardContent className="p-0">
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
              {loading ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center">
                    <div className="flex justify-center py-12">
                      <Spinner />
                    </div>
                  </TableCell>
                </TableRow>
              ) : stacks.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Layers className="h-8 w-8 text-muted-foreground/60" />
                      <p className="text-sm">{canManage ? "No stacks yet. Create one to get started." : "No stacks."}</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : stacks.map((stack): React.JSX.Element => (
                <TableRow key={stack.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <Layers className="h-4 w-4 text-muted-foreground" />
                      {stack.attributes.name}
                    </div>
                    {isString(stack.attributes.description) && stack.attributes.description !== "" && (
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
              <Input id="stack-name" name="name" autoComplete="off" spellCheck={false} value={form.name} onChange={set("name")} placeholder="my-stack…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stack-project">Project</Label>
              <select
                id="stack-project"
                name="project"
                value={form.projectId}
                onChange={set("projectId")}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
              <Input id="stack-vcs" name="vcs-repository" autoComplete="off" spellCheck={false} value={form.vcsIdentifier} onChange={set("vcsIdentifier")} placeholder="owner/repository…" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="stack-branch">Branch</Label>
                <Input id="stack-branch" name="branch" autoComplete="off" value={form.vcsBranch} onChange={set("vcsBranch")} placeholder="main (optional)…" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="stack-working-dir">Working directory</Label>
                <Input id="stack-working-dir" name="working-directory" autoComplete="off" value={form.workingDirectory} onChange={set("workingDirectory")} placeholder="terraform (optional)…" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stack-description">Description</Label>
              <Input id="stack-description" name="description" autoComplete="off" value={form.description} onChange={set("description")} placeholder="Optional…" />
            </div>
            <label htmlFor="stack-speculative" className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                id="stack-speculative"
                checked={form.speculative}
                onCheckedChange={(checked: boolean | "indeterminate"): void => { setForm((prev): StackForm => ({ ...prev, speculative: checked === true })); }}
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
        description="Deleting a stack removes it and its deployments. This cannot be undone."
        confirmText="Delete"
        confirmVariant="destructive"
        requireText={stackToDelete?.attributes.name}
        loading={deleting}
        onConfirm={confirmDelete}
      />
    </PageShell>
  );
}