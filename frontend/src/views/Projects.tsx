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

interface Project {
  id: string;
  attributes: {
    name: string;
    description: string | null;
    "workspace-count"?: number;
  };
}

export function Projects() {
  const { orgName } = useParams<{ orgName: string }>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create/Edit Dialog State
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (orgName) loadProjects();
  }, [orgName]);

  const loadProjects = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetchApi(`/organizations/${orgName}/projects`);
      setProjects(res.data || []);
    } catch (err: any) {
      setError(err.message || "Failed to load projects");
    } finally {
      setLoading(false);
    }
  };

  const openCreateDialog = () => {
    setEditingProject(null);
    setName("");
    setDescription("");
    setFormError("");
    setDialogOpen(true);
  };

  const openEditDialog = (project: Project) => {
    setEditingProject(project);
    setName(project.attributes.name || "");
    setDescription(project.attributes.description || "");
    setFormError("");
    setDialogOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgName) return;
    setSaving(true);
    setFormError("");
    try {
      if (editingProject) {
        const res = await fetchApi(`/projects/${editingProject.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            data: {
              type: "projects",
              attributes: {
                name: name.trim(),
                description: description.trim() || null,
              },
            },
          }),
        });
        setProjects((prev) => prev.map((p) => (p.id === res.data.id ? res.data : p)));
      } else {
        const res = await fetchApi(`/organizations/${orgName}/projects`, {
          method: "POST",
          body: JSON.stringify({
            data: {
              type: "projects",
              attributes: {
                name: name.trim(),
                description: description.trim() || null,
              },
            },
          }),
        });
        setProjects((prev) => [...prev, res.data]);
      }
      setDialogOpen(false);
    } catch (err: any) {
      setFormError(err.message || "Failed to save project");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (project: Project) => {
    if (!window.confirm(`Delete project "${project.attributes.name}"?`)) return;
    setError("");
    try {
      await fetchApi(`/projects/${project.id}`, {
        method: "DELETE",
      });
      setProjects((prev) => prev.filter((p) => p.id !== project.id));
    } catch (err: any) {
      setError(err.message || "Failed to delete project");
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{orgName} / Projects</h1>
          <p className="text-sm text-muted-foreground">Group workspaces into logical projects within this organization.</p>
        </div>
        <Button onClick={openCreateDialog}>
          <Plus className="mr-1.5 size-4" /> New Project
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/15 p-4 text-sm font-medium text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Workspaces</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center">
                    <Spinner className="mx-auto size-6 text-primary" />
                  </TableCell>
                </TableRow>
              ) : projects.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                    <FolderKanban className="mx-auto mb-2 size-8 text-muted-foreground/60" />
                    No projects found. Create your first project to organize workspaces.
                  </TableCell>
                </TableRow>
              ) : (
                projects.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell className="font-semibold text-foreground">
                      <div className="flex items-center gap-2">
                        <FolderKanban className="size-4 text-primary" />
                        {project.attributes.name}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {project.attributes.description || "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
                        <Layers className="size-3.5" />
                        {project.attributes["workspace-count"] ?? 0} Workspaces
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => openEditDialog(project)}>
                          <Pencil className="size-3.5 mr-1" /> Edit
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => handleDelete(project)}>
                          <Trash2 className="size-3.5 mr-1" /> Delete
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

      {/* Create / Edit Modal */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{editingProject ? "Edit Project" : "New Project"}</DialogTitle>
            <DialogDescription>
              {editingProject ? "Update project details." : "Create a new project container for your workspaces."}
            </DialogDescription>
          </DialogHeader>

          {formError && (
            <div className="rounded bg-destructive/15 p-3 text-xs font-medium text-destructive">
              {formError}
            </div>
          )}

          <form onSubmit={handleSave} noValidate className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label htmlFor="project-name" className="text-sm font-medium">Project Name</label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onInput={(e: any) => setName(e.target.value)}
                placeholder="e.g. Core Infrastructure"
                required
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="project-description" className="text-sm font-medium">Description</label>
              <Input
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onInput={(e: any) => setDescription(e.target.value)}
                placeholder="Optional description"
              />
            </div>

            <DialogFooter className="pt-4">
              <Button type="submit" disabled={saving}>
                {saving ? <Spinner className="size-4" /> : editingProject ? "Save Changes" : "Create Project"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
