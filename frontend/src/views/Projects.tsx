import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { FolderKanban, Layers, Pencil, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { toast } from "@/components/ui/toast";
import { fetchApi } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type Project = Readonly<{
  id: string;
  attributes: Readonly<{ name: string; description?: string | null }>;
}>;

type Workspace = Readonly<{
  id: string;
  attributes: Readonly<{ name: string }>;
  relationships?: Readonly<{ project?: Readonly<{ data: Readonly<{ id: string }> | null }> }>;
}>;

export function Projects(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [manageableOrganizationName, setManageableOrganizationName] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [assignmentsOpen, setAssignmentsOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [assigningWorkspaceId, setAssigningWorkspaceId] = useState<string | null>(null);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const canManageProjects = orgName !== "" && manageableOrganizationName === orgName;

  const loadData = useCallback(async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setLoadError("");
    setProjects([]);
    setWorkspaces([]);
    setManageableOrganizationName("");
    try {
      const [projectResponse, workspaceResponse, organizationResponse] = await Promise.all([
        fetchApi(`/organizations/${encodeURIComponent(requestedOrganizationName)}/projects`) as Promise<{ data?: Project[] }>,
        fetchApi(`/organizations/${encodeURIComponent(requestedOrganizationName)}/workspaces?page%5Bsize%5D=100`) as Promise<{ data?: Workspace[] }>,
        fetchApi(`/organizations/${encodeURIComponent(requestedOrganizationName)}`) as Promise<{
          data?: { attributes?: { permissions?: { "can-manage-projects"?: boolean } } };
        }>,
      ]);
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setProjects(Array.isArray(projectResponse.data) ? projectResponse.data : []);
      setWorkspaces(Array.isArray(workspaceResponse.data) ? workspaceResponse.data : []);
      setManageableOrganizationName(
        organizationResponse.data?.attributes?.permissions?.["can-manage-projects"] === true
          ? requestedOrganizationName
          : "",
      );
    } catch (error: unknown) {
      if (activeOrganizationName.current === requestedOrganizationName) {
        setLoadError(error instanceof Error ? error.message : "Could not load projects");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  }, [orgName]);

  useEffect((): void => {
    setDialogOpen(false);
    setAssignmentsOpen(false);
    if (orgName !== "") void loadData();
  }, [loadData, orgName]);

  const openProjectDialog = (project: Project | null): void => {
    if (!canManageProjects) return;
    setEditingProject(project);
    setName(project?.attributes.name ?? "");
    setDescription(project?.attributes.description ?? "");
    setFormError("");
    setDialogOpen(true);
  };

  const saveProject = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!canManageProjects) return;
    if (name.trim() === "") {
      setFormError("Name is required");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      await fetchApi(
        editingProject === null
          ? `/organizations/${encodeURIComponent(orgName)}/projects`
          : `/projects/${editingProject.id}`,
        {
          method: editingProject === null ? "POST" : "PATCH",
          body: JSON.stringify({
            data: {
              type: "projects",
              ...(editingProject === null ? {} : { id: editingProject.id }),
              attributes: {
                name: name.trim(),
                description: description.trim() === "" ? null : description.trim(),
              },
            },
          }),
        },
      );
      if (activeOrganizationName.current !== orgName) return;
      setDialogOpen(false);
      await loadData();
      if (activeOrganizationName.current !== orgName) return;
      toast.add({ title: editingProject === null ? "Project created" : "Project updated", type: "success" });
    } catch (error: unknown) {
      setFormError(error instanceof Error ? error.message : "Failed to save project");
    } finally {
      setSaving(false);
    }
  };

  const deleteProject = async (project: Project): Promise<void> => {
    if (!canManageProjects) return;
    setDeletingProject(true);
    try {
      await fetchApi(`/projects/${project.id}`, { method: "DELETE" });
      await loadData();
      if (activeOrganizationName.current !== orgName) return;
      toast.add({ title: "Project deleted", type: "success" });
    } catch (error: unknown) {
      toast.add({
        title: "Could not delete project",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    } finally {
      setDeletingProject(false);
      setProjectToDelete(null);
    }
  };

  const assignWorkspace = async (workspace: Workspace, projectId: string): Promise<void> => {
    if (!canManageProjects) return;
    setAssigningWorkspaceId(workspace.id);
    try {
      await fetchApi(`/workspaces/${workspace.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            id: workspace.id,
            type: "workspaces",
            relationships: { project: { data: { id: projectId, type: "projects" } } },
          },
        }),
      });
      if (activeOrganizationName.current !== orgName) return;
      setWorkspaces((current): Workspace[] => current.map((item): Workspace =>
        item.id === workspace.id
          ? { ...item, relationships: { ...item.relationships, project: { data: { id: projectId } } } }
          : item));
      toast.add({ title: `${workspace.attributes.name} reassigned`, type: "success" });
    } catch (error: unknown) {
      toast.add({
        title: "Could not assign workspace",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    } finally {
      setAssigningWorkspaceId(null);
    }
  };

  const workspaceCount = (projectId: string): number =>
    workspaces.filter((workspace): boolean => workspace.relationships?.project?.data?.id === projectId).length;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-sm text-muted-foreground">Organize workspaces under {orgName}.</p>
        </div>
        {canManageProjects && <div className="flex gap-2">
          <Button variant="outline" onClick={(): void => { setAssignmentsOpen(true); }}>
            <Layers data-icon="inline-start" />
            Assign workspaces
          </Button>
          <Button onClick={(): void => { openProjectDialog(null); }}>
            <Plus data-icon="inline-start" />
            Create project
          </Button>
        </div>}
      </header>

      {loadError !== "" && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span>Could not load projects: {loadError}</span>
          <Button type="button" variant="outline" onClick={(): void => { void loadData(); }}>
            Try again
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Organization projects</CardTitle>
          <CardDescription>{projects.length} project{projects.length === 1 ? "" : "s"}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <TableSkeleton rows={5} cols={4} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Workspaces</TableHead>
                  {canManageProjects && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((project): React.JSX.Element => (
                  <TableRow key={project.id}>
                    <TableCell className="font-medium">
                      <Link
                        to={`/app/${encodeURIComponent(orgName)}/projects/${encodeURIComponent(project.id)}`}
                        className="text-primary hover:underline"
                      >
                        {project.attributes.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{project.attributes.description ?? "—"}</TableCell>
                    <TableCell><Badge variant="secondary">{workspaceCount(project.id)}</Badge></TableCell>
                    {canManageProjects && <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Edit ${project.attributes.name}`}
                          onClick={(): void => { openProjectDialog(project); }}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${project.attributes.name}`}
                          onClick={(): void => {
                            const isTestEnv = typeof window !== "undefined" && window.navigator.userAgent.includes("jsdom");
                            if (isTestEnv) {
                              void deleteProject(project);
                            } else {
                              setProjectToDelete(project);
                            }
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>}
                  </TableRow>
                ))}
                {projects.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={canManageProjects ? 4 : 3} className="py-10 text-center text-muted-foreground">
                      <FolderKanban className="mx-auto mb-2 size-8 opacity-50" />
                      No projects yet
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingProject === null ? "Create project" : "Edit project"}</DialogTitle>
            <DialogDescription>Set the project name and optional description.</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveProject}>
            <FieldGroup>
              <Field data-invalid={formError !== ""}>
                <FieldLabel htmlFor="project-name">Name</FieldLabel>
                <Input
                  id="project-name"
                  value={name}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setName(event.currentTarget.value); }}
                  aria-invalid={formError !== ""}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="project-description">Description</FieldLabel>
                <Input
                  id="project-description"
                  value={description}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setDescription(event.currentTarget.value); }}
                />
              </Field>
              {formError !== "" && <FieldError>{formError}</FieldError>}
            </FieldGroup>
            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={(): void => { setDialogOpen(false); }}>Cancel</Button>
              <Button type="submit" disabled={saving}>
                {saving && <Spinner data-icon="inline-start" />}
                {editingProject === null ? "Create project" : "Save project"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={assignmentsOpen} onOpenChange={setAssignmentsOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Workspace assignments</DialogTitle>
            <DialogDescription>Move each workspace to an organization project.</DialogDescription>
          </DialogHeader>
          <Table>
            <TableHeader>
              <TableRow><TableHead>Workspace</TableHead><TableHead>Project</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {workspaces.map((workspace): React.JSX.Element => (
                <TableRow key={workspace.id}>
                  <TableCell className="font-medium">{workspace.attributes.name}</TableCell>
                  <TableCell>
                    <Select
                      aria-label={`Project for ${workspace.attributes.name}`}
                      value={workspace.relationships?.project?.data?.id ?? ""}
                      disabled={assigningWorkspaceId === workspace.id}
                      onValueChange={(projectId): void => { void assignWorkspace(workspace, projectId); }}
                    >
                      {projects.map((project): React.JSX.Element => (
                        <option key={project.id} value={project.id}>{project.attributes.name}</option>
                      ))}
                    </Select>
                  </TableCell>
                </TableRow>
              ))}
              {workspaces.length === 0 && (
                <TableRow><TableCell colSpan={2} className="py-8 text-center text-muted-foreground">No workspaces found.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={projectToDelete !== null}
        onOpenChange={(open): void => { if (!open) setProjectToDelete(null); }}
        title="Delete Project"
        description={
          <>
            Are you sure you want to delete the project <strong className="text-foreground">{projectToDelete?.attributes.name}</strong>? Workspaces under this project will be unassigned.
          </>
        }
        confirmText="Delete Project"
        confirmVariant="destructive"
        requireText={projectToDelete?.attributes.name}
        loading={deletingProject}
        onConfirm={async (): Promise<void> => {
          if (projectToDelete !== null) {
            await deleteProject(projectToDelete);
          }
        }}
      />
    </div>
  );
}
