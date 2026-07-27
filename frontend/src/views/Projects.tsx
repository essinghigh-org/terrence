import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Spinner } from "../components/ui/spinner";
import { FolderKanban, Plus, Pencil, Trash2, Layers } from "lucide-react";

export function Projects(): React.JSX.Element {
  const { orgName } = useParams<{ orgName: string }>();
  const [projects, setProjects] = useState<{ id: string; attributes: Record<string, unknown> }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create/Edit Dialog State
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<{ id: string; attributes: Record<string, unknown> } | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (orgName != null) {
      void loadProjects();
    }
  }, [orgName]);

  const loadProjects = async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const res = await fetchApi(`/organizations/${orgName}/projects`) as { data: { id: string; attributes: Record<string, unknown> }[] };
      setProjects(res.data ?? []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load projects";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const openCreateDialog = (): void => {
    setEditingProject(null);
    setName("");
    setDescription("");
    setFormError("");
    setDialogOpen(true);
  };

  const openEditDialog = (project: { id: string; attributes: Record<string, unknown> }): void => {
    setEditingProject(project);
    setName(project.attributes["name"] as string);
    setDescription((project.attributes["description"] as string | null) ?? "");
    setFormError("");
    setDialogOpen(true);
  };

  const handleSave = async (): Promise<void> => {
    if (name.trim() === "") {
      setFormError("Name is required");
      return;
    }

    setSaving(true);
    setFormError("");
    try {
      if (editingProject != null) {
        await fetchApi(`/organizations/${orgName}/projects/${editingProject.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            data: { attributes: { name: name.trim(), description: description.trim() !== "" ? description.trim() : null } },
          }),
        });
      } else {
        await fetchApi(`/organizations/${orgName}/projects`, {
          method: "POST",
          body: JSON.stringify({
            data: { type: "projects", attributes: { name: name.trim(), description: description.trim() !== "" ? description.trim() : null } },
          }),
        });
      }
      setDialogOpen(false);
      await loadProjects();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to save project";
      setFormError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (projectId: string): Promise<void> => {
    try {
      await fetchApi(`/organizations/${orgName}/projects/${projectId}`, { method: "DELETE" });
      await loadProjects();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to delete project";
      setError(message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Organize workspaces into projects under <span className="font-medium">{orgName}</span>.
          </p>
        </div>
        <Button onClick={openCreateDialog}>
          <Plus className="w-4 h-4 mr-2" />
          Create Project
        </Button>
      </div>

      {error !== "" && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-md text-sm">{error}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner className="w-6 h-6" />
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Workspaces</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                      <FolderKanban className="w-8 h-8 mx-auto mb-2 opacity-40" />
                      No projects yet
                    </TableCell>
                  </TableRow>
                ) : (
                  projects.map((project): React.JSX.Element => (
                    <TableRow key={project.id}>
                      <TableCell className="font-medium">{project.attributes["name"] as string}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {(project.attributes["description"] as string | null) ?? "—"}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1 text-sm">
                          <Layers className="w-3 h-3" />
                          {(project.attributes["workspace-count"] as number | undefined) ?? 0}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(): void => openEditDialog(project)}
                          >
                            <Pencil className="w-3 h-3" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(): void => { void handleDelete(project.id); }}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingProject != null ? "Edit Project" : "Create Project"}</DialogTitle>
            <DialogDescription>
              {editingProject != null ? "Update the project details." : "Add a new project to organize workspaces."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {formError !== "" && (
              <div className="bg-red-50 border border-red-200 text-red-800 px-3 py-2 rounded text-sm">{formError}</div>
            )}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Name</label>
              <Input value={name} onChange={(event: React.ChangeEvent<HTMLInputElement>): void => setName(event.target.value)} placeholder="My Project" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Description</label>
              <Input value={description} onChange={(event: React.ChangeEvent<HTMLInputElement>): void => setDescription(event.target.value)} placeholder="Optional description" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={(): void => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : editingProject != null ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
