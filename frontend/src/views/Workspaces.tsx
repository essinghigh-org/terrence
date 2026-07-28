import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Pencil, Plus, Tags, Trash2, X } from "lucide-react";

import { CreateWorkspaceModal } from "@/components/CreateWorkspaceModal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { fetchApi } from "@/lib/api";

type Project = Readonly<{ id: string; attributes: Readonly<{ name: string }> }>;

type Workspace = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    locked?: boolean;
    "tag-names"?: readonly string[];
    "vcs-repo"?: Readonly<{ identifier: string }> | null;
  }>;
  relationships?: Readonly<{ project?: Readonly<{ data: Readonly<{ id: string }> | null }> }>;
}>;

type TagBinding = Readonly<{
  id: string;
  attributes: Readonly<{ key: string; value?: string }>;
}>;

const runStatusFilters: Readonly<Record<string, readonly string[]>> = {
  attention: ["policy_soft_failed", "policy_hard_failed", "policy_override"],
  errored: ["errored"],
  running: ["pending", "fetching", "planning", "cost_estimating", "policy_checking", "applying"],
  "on-hold": ["planned", "planned_and_saved"],
  completed: ["applied", "discarded", "canceled"],
};

export function Workspaces(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [tagWorkspace, setTagWorkspace] = useState<Workspace | null>(null);
  const [tagBindings, setTagBindings] = useState<TagBinding[]>([]);
  const [tagKey, setTagKey] = useState("");
  const [tagValue, setTagValue] = useState("");
  const [editingTagKey, setEditingTagKey] = useState<string | null>(null);
  const [savingTag, setSavingTag] = useState(false);

  const loadData = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const statuses = runStatusFilters[statusFilter];
      const query = statuses === undefined
        ? "?page%5Bsize%5D=100"
        : `?page%5Bsize%5D=100&filter%5Bcurrent-run%5D%5Bstatus%5D=${encodeURIComponent(statuses.join(","))}`;
      const [workspaceResponse, projectResponse] = await Promise.all([
        fetchApi(`/organizations/${encodeURIComponent(orgName)}/workspaces${query}`) as Promise<{ data?: Workspace[] }>,
        fetchApi(`/organizations/${encodeURIComponent(orgName)}/projects`) as Promise<{ data?: Project[] }>,
      ]);
      setWorkspaces(Array.isArray(workspaceResponse.data) ? workspaceResponse.data : []);
      setProjects(Array.isArray(projectResponse.data) ? projectResponse.data : []);
    } catch (error: unknown) {
      toast.add({
        title: "Could not load workspaces",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    } finally {
      setLoading(false);
    }
  }, [orgName, statusFilter]);

  useEffect((): void => {
    if (orgName !== "") void loadData();
  }, [loadData, orgName]);

  const visibleWorkspaces = useMemo((): Workspace[] => {
    const needle = search.trim().toLowerCase();
    return workspaces.filter((workspace): boolean => {
      const projectId = workspace.relationships?.project?.data?.id ?? "";
      const tags = workspace.attributes["tag-names"] ?? [];
      const matchesSearch = needle === ""
        || workspace.attributes.name.toLowerCase().includes(needle)
        || tags.some((tag): boolean => tag.toLowerCase().includes(needle));
      return matchesSearch && (projectFilter === "" || projectId === projectFilter);
    });
  }, [projectFilter, search, workspaces]);

  const loadTags = async (workspace: Workspace): Promise<void> => {
    try {
      const response = await fetchApi(`/workspaces/${workspace.id}/tag-bindings`) as { data?: TagBinding[] };
      setTagBindings(Array.isArray(response.data) ? response.data : []);
    } catch (error: unknown) {
      toast.add({
        title: "Could not load tags",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    }
  };

  const openTags = (workspace: Workspace): void => {
    setTagWorkspace(workspace);
    setTagKey("");
    setTagValue("");
    setEditingTagKey(null);
    setTagBindings([]);
    void loadTags(workspace);
  };

  const saveTag = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (tagWorkspace === null || tagKey.trim() === "") return;
    setSavingTag(true);
    try {
      await fetchApi(`/workspaces/${tagWorkspace.id}/tag-bindings`, {
        method: "PATCH",
        body: JSON.stringify({
          data: [{
            type: "tag-bindings",
            attributes: { key: tagKey.trim(), value: tagValue.trim() },
          }],
        }),
      });
      setTagKey("");
      setTagValue("");
      setEditingTagKey(null);
      await Promise.all([loadTags(tagWorkspace), loadData()]);
      toast.add({ title: editingTagKey === null ? "Tag added" : "Tag updated", type: "success" });
    } catch (error: unknown) {
      toast.add({
        title: "Could not save tag",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    } finally {
      setSavingTag(false);
    }
  };

  const deleteTag = async (tag: TagBinding): Promise<void> => {
    if (tagWorkspace === null) return;
    try {
      await fetchApi(`/workspaces/${tagWorkspace.id}/relationships/tags`, {
        method: "DELETE",
        body: JSON.stringify({ data: [{ id: tag.attributes.key, type: "tags" }] }),
      });
      await Promise.all([loadTags(tagWorkspace), loadData()]);
      toast.add({ title: "Tag removed", type: "success" });
    } catch (error: unknown) {
      toast.add({
        title: "Could not remove tag",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    }
  };

  const projectName = (workspace: Workspace): string => {
    const projectId = workspace.relationships?.project?.data?.id;
    return projects.find((project): boolean => project.id === projectId)?.attributes.name ?? "Unknown project";
  };

  const hasFilters = search !== "" || statusFilter !== "" || projectFilter !== "";

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">{orgName} / Workspaces</p>
          <h1 className="text-3xl font-bold tracking-tight">Workspaces</h1>
        </div>
        <Button onClick={(): void => { setCreateOpen(true); }}>
          <Plus data-icon="inline-start" />
          New workspace
        </Button>
      </header>

      <section aria-label="Workspace filters" className="grid gap-3 md:grid-cols-[minmax(15rem,1fr)_12rem_14rem_auto]">
        <Input
          aria-label="Search workspaces"
          placeholder="Search by workspace name or tag"
          value={search}
          onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setSearch(event.target.value); }}
        />
        <Select aria-label="Status filter" value={statusFilter} onValueChange={setStatusFilter}>
          <option value="">All statuses</option>
          <option value="attention">Needs attention</option>
          <option value="errored">Errored</option>
          <option value="running">Running</option>
          <option value="on-hold">On hold</option>
          <option value="completed">Completed</option>
        </Select>
        <Select aria-label="Project filter" value={projectFilter} onValueChange={setProjectFilter}>
          <option value="">All projects</option>
          {projects.map((project): React.JSX.Element => (
            <option key={project.id} value={project.id}>{project.attributes.name}</option>
          ))}
        </Select>
        <Button
          variant="ghost"
          disabled={!hasFilters}
          onClick={(): void => {
            setSearch("");
            setStatusFilter("");
            setProjectFilter("");
          }}
        >
          <X data-icon="inline-start" />
          Clear
        </Button>
      </section>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workspace</TableHead>
              <TableHead>Repository</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Manage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={6} className="py-12 text-center"><Spinner /></TableCell></TableRow>
            ) : visibleWorkspaces.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-12 text-center text-muted-foreground">
                  <p className="font-medium text-foreground">No workspaces found</p>
                  <p>Try adjusting the filters.</p>
                </TableCell>
              </TableRow>
            ) : visibleWorkspaces.map((workspace): React.JSX.Element => (
              <TableRow key={workspace.id}>
                <TableCell>
                  <button
                    className="font-medium hover:underline"
                    onClick={(): void => {
                      void navigate(`/app/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(workspace.attributes.name)}`);
                    }}
                  >
                    {workspace.attributes.name}
                  </button>
                </TableCell>
                <TableCell>{workspace.attributes["vcs-repo"]?.identifier ?? "None"}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {(workspace.attributes["tag-names"] ?? []).map((tag): React.JSX.Element => (
                      <Badge key={tag} variant="secondary">{tag}</Badge>
                    ))}
                    {(workspace.attributes["tag-names"] ?? []).length === 0 && <span className="text-muted-foreground">None</span>}
                  </div>
                </TableCell>
                <TableCell>{projectName(workspace)}</TableCell>
                <TableCell>
                  <Badge variant={workspace.attributes.locked === true ? "outline" : "secondary"}>
                    {workspace.attributes.locked === true ? "Locked" : "Available"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Manage tags for ${workspace.attributes.name}`}
                    onClick={(): void => { openTags(workspace); }}
                  >
                    <Tags data-icon="inline-start" />
                    Tags
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <CreateWorkspaceModal
        orgName={orgName}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(): void => { void loadData(); }}
      />

      <Dialog open={tagWorkspace !== null} onOpenChange={(open: boolean): void => { if (!open) setTagWorkspace(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Tags for {tagWorkspace?.attributes.name}</DialogTitle>
            <DialogDescription>Add, update, or remove direct workspace tags.</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveTag}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="workspace-tag-key">Key</FieldLabel>
                <Input
                  id="workspace-tag-key"
                  value={tagKey}
                  disabled={editingTagKey !== null}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setTagKey(event.currentTarget.value); }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="workspace-tag-value">Value</FieldLabel>
                <Input
                  id="workspace-tag-value"
                  value={tagValue}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setTagValue(event.currentTarget.value); }}
                />
              </Field>
            </FieldGroup>
            <DialogFooter className="mt-4">
              {editingTagKey !== null && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={(): void => {
                    setEditingTagKey(null);
                    setTagKey("");
                    setTagValue("");
                  }}
                >
                  Cancel edit
                </Button>
              )}
              <Button type="submit" disabled={tagKey.trim() === "" || savingTag}>
                {savingTag && <Spinner data-icon="inline-start" />}
                {editingTagKey === null ? "Add tag" : "Update tag"}
              </Button>
            </DialogFooter>
          </form>
          <Table>
            <TableHeader><TableRow><TableHead>Key</TableHead><TableHead>Value</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
            <TableBody>
              {tagBindings.map((tag): React.JSX.Element => (
                <TableRow key={tag.id}>
                  <TableCell className="font-medium">{tag.attributes.key}</TableCell>
                  <TableCell>{tag.attributes.value ?? ""}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit tag ${tag.attributes.key}`}
                        onClick={(): void => {
                          setEditingTagKey(tag.attributes.key);
                          setTagKey(tag.attributes.key);
                          setTagValue(tag.attributes.value ?? "");
                        }}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete tag ${tag.attributes.key}`}
                        onClick={(): void => { void deleteTag(tag); }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {tagBindings.length === 0 && (
                <TableRow><TableCell colSpan={3} className="py-8 text-center text-muted-foreground">No direct tags.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>
    </div>
  );
}
