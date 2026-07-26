import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { buttonVariants, Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchApi } from "@/lib/api";

async function fetchAllPages(path: string): Promise<any[]> {
  let results: any[] = [];
  let url: string | null = path;
  while (url) {
    const res = await fetchApi(url);
    if (res?.data && Array.isArray(res.data)) {
      results = results.concat(res.data);
    }
    const nextUrl = res?.links?.next || null;
    const metaNext = res?.meta?.pagination?.["next-page"];
    if (nextUrl) {
      url = nextUrl;
    } else if (metaNext && url) {
      const currentUrl: string = url;
      const parsed: URL = new URL(currentUrl, "http://localhost");
      parsed.searchParams.set("page[number]", String(metaNext));
      url = `${parsed.pathname}${parsed.search}`;
    } else {
      url = null;
    }
  }
  return results;
}

interface ResourceIdentifier {
  id: string;
  type: string;
}

interface VariableSet {
  id: string;
  attributes: {
    name: string;
    description: string | null;
    global: boolean;
    "var-count": number;
    "workspace-count": number;
  };
  relationships: {
    workspaces: { data: ResourceIdentifier[] };
  };
}

interface Workspace {
  id: string;
  attributes: { name: string };
}

type VariableCategory = "terraform" | "env";

interface VariableSetVariable {
  id: string;
  attributes: {
    key: string;
    value: string | null;
    category: VariableCategory;
    sensitive: boolean;
    hcl: boolean;
    description: string | null;
  };
}

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function VariablesDialog({
  open,
  variableSet,
  onOpenChange,
  onCountChange,
}: {
  open: boolean;
  variableSet: VariableSet | null;
  onOpenChange: (open: boolean) => void;
  onCountChange: (variableSetId: string, delta: number) => void;
}) {
  const [variables, setVariables] = useState<VariableSetVariable[]>([]);
  const [loading, setLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<VariableSetVariable | null>(null);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [category, setCategory] = useState<VariableCategory>("terraform");
  const [sensitive, setSensitive] = useState(false);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const variableSetId = variableSet?.id;

  useEffect(() => {
    if (!open || !variableSetId) return;
    let active = true;
    setVariables([]);
    setLoading(true);
    setFormOpen(false);
    setError("");

    fetchAllPages(`/varsets/${variableSetId}/relationships/vars?page[size]=100`)
      .then((data) => {
        if (active) setVariables(data ?? []);
      })
      .catch((caught: unknown) => {
        if (active) setError(messageFrom(caught, "Failed to load variables"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [open, variableSetId]);

  const openForm = (variable?: VariableSetVariable) => {
    setEditing(variable ?? null);
    setKey(variable?.attributes.key ?? "");
    setValue(variable?.attributes.sensitive ? "" : variable?.attributes.value ?? "");
    setCategory(variable?.attributes.category ?? "terraform");
    setSensitive(variable?.attributes.sensitive ?? false);
    setDescription(variable?.attributes.description ?? "");
    setError("");
    setFormOpen(true);
  };

  const saveVariable = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!variableSetId) return;
    if (editing?.attributes.sensitive && !sensitive && !value) {
      setError("Enter a new value before making this sensitive variable visible.");
      return;
    }

    const attributes: {
      key: string;
      value?: string;
      category: VariableCategory;
      sensitive: boolean;
      description: string | null;
    } = {
      key: key.trim(),
      category,
      sensitive,
      description: description.trim() || null,
    };
    if (!editing?.attributes.sensitive || value) attributes.value = value;

    setSaving(true);
    setError("");
    try {
      const response = await fetchApi(
        `/varsets/${variableSetId}/relationships/vars${editing ? `/${editing.id}` : ""}`,
        {
          method: editing ? "PATCH" : "POST",
          body: JSON.stringify({ data: { type: "vars", attributes } }),
        },
      );
      const saved = response.data as VariableSetVariable;
      setVariables((current) => {
        const next = editing
          ? current.map((variable) => (variable.id === saved.id ? saved : variable))
          : [...current, saved];
        return next.sort((left, right) =>
          left.attributes.key.localeCompare(right.attributes.key),
        );
      });
      if (!editing) onCountChange(variableSetId, 1);
      setFormOpen(false);
    } catch (caught: unknown) {
      setError(messageFrom(caught, "Failed to save variable"));
    } finally {
      setSaving(false);
    }
  };

  const deleteVariable = async (variable: VariableSetVariable) => {
    if (!variableSetId || !window.confirm(`Delete variable "${variable.attributes.key}"?`)) return;
    setError("");
    try {
      await fetchApi(`/varsets/${variableSetId}/relationships/vars/${variable.id}`, {
        method: "DELETE",
      });
      setVariables((current) => current.filter((item) => item.id !== variable.id));
      onCountChange(variableSetId, -1);
    } catch (caught: unknown) {
      setError(messageFrom(caught, "Failed to delete variable"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {formOpen
              ? editing
                ? "Edit variable"
                : "Add variable"
              : `Variables in ${variableSet?.attributes.name ?? "variable set"}`}
          </DialogTitle>
          <DialogDescription>
            {formOpen
              ? "Configure a Terraform input or environment variable."
              : "Variables in this set are available to its assigned workspaces."}
          </DialogDescription>
        </DialogHeader>

        {formOpen ? (
          <form onSubmit={saveVariable}>
            <FieldGroup>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="variable-key">Key</FieldLabel>
                <Input
                  id="variable-key"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  required
                  autoFocus
                  aria-invalid={Boolean(error)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="variable-value">Value</FieldLabel>
                <Input
                  id="variable-value"
                  type={sensitive ? "password" : "text"}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
                {editing?.attributes.sensitive && (
                  <FieldDescription>Leave blank to keep the current sensitive value.</FieldDescription>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="variable-category">Category</FieldLabel>
                <Select value={category} onValueChange={(val) => setCategory(val as VariableCategory)}>
                  <SelectTrigger id="variable-category" className="w-full">
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="terraform">Terraform</SelectItem>
                    <SelectItem value="env">Environment</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="variable-description">Description</FieldLabel>
                <Input
                  id="variable-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
              <Field orientation="horizontal">
                <Checkbox
                  id="variable-sensitive"
                  checked={sensitive}
                  onCheckedChange={(checked) => setSensitive(checked === true)}
                />
                <div className="flex flex-col gap-0.5">
                  <FieldLabel htmlFor="variable-sensitive">Sensitive</FieldLabel>
                  <FieldDescription>Hide this value in API responses and the UI.</FieldDescription>
                </div>
              </Field>
              <FieldError>{error}</FieldError>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                  Back
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving && <Spinner data-icon="inline-start" />}
                  {saving ? "Saving" : "Save variable"}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex justify-end">
              <Button onClick={() => openForm()}>Add variable</Button>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && (
                    <TableRow>
                      <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                        Loading variables…
                      </TableCell>
                    </TableRow>
                  )}
                  {!loading &&
                    variables.map((variable) => (
                      <TableRow key={variable.id}>
                        <TableCell className="font-mono font-medium">
                          {variable.attributes.key}
                        </TableCell>
                        <TableCell className="max-w-48 truncate font-mono text-xs">
                          {variable.attributes.sensitive
                            ? "••••••••"
                            : variable.attributes.value || "—"}
                        </TableCell>
                        <TableCell>
                          {variable.attributes.category === "env" ? "Environment" : "Terraform"}
                        </TableCell>
                        <TableCell className="max-w-48 truncate text-muted-foreground">
                          {variable.attributes.description || "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openForm(variable)}
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => deleteVariable(variable)}
                            >
                              Delete
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  {!loading && variables.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                        No variables in this set.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function VariableSets() {
  const { orgName } = useParams();
  const [variableSets, setVariableSets] = useState<VariableSet[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<VariableSet | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [global, setGlobal] = useState(false);
  const [savingSet, setSavingSet] = useState(false);
  const [editorError, setEditorError] = useState("");

  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceSet, setWorkspaceSet] = useState<VariableSet | null>(null);
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<Set<string>>(new Set());
  const [savingWorkspaces, setSavingWorkspaces] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [variablesSet, setVariablesSet] = useState<VariableSet | null>(null);

  useEffect(() => {
    if (!orgName) return;
    let active = true;
    setLoading(true);
    setPageError("");

    Promise.all([
      fetchAllPages(`/organizations/${encodeURIComponent(orgName)}/varsets?page[size]=100`),
      fetchAllPages(`/organizations/${encodeURIComponent(orgName)}/workspaces?page[size]=100`),
    ])
      .then(([setsData, workspacesData]) => {
        if (!active) return;
        setVariableSets(setsData ?? []);
        setWorkspaces(workspacesData ?? []);
      })
      .catch((error: unknown) => {
        if (active) setPageError(messageFrom(error, "Failed to load variable sets"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [orgName]);

  const openEditor = (variableSet?: VariableSet) => {
    setEditing(variableSet ?? null);
    setName(variableSet?.attributes.name ?? "");
    setDescription(variableSet?.attributes.description ?? "");
    setGlobal(variableSet?.attributes.global ?? false);
    setEditorError("");
    setEditorOpen(true);
  };

  const saveVariableSet = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!orgName) return;
    setSavingSet(true);
    setEditorError("");

    try {
      const response = await fetchApi(
        editing
          ? `/varsets/${editing.id}`
          : `/organizations/${encodeURIComponent(orgName)}/varsets`,
        {
          method: editing ? "PATCH" : "POST",
          body: JSON.stringify({
            data: {
              type: "varsets",
              attributes: {
                name: name.trim(),
                description: description.trim() || null,
                global,
              },
            },
          }),
        },
      );
      const saved = response.data as VariableSet;
      setVariableSets((current) => {
        const next = editing
          ? current.map((item) => (item.id === saved.id ? saved : item))
          : [...current, saved];
        return next.sort((left, right) =>
          left.attributes.name.localeCompare(right.attributes.name),
        );
      });
      setEditorOpen(false);
    } catch (error: unknown) {
      setEditorError(messageFrom(error, "Failed to save variable set"));
    } finally {
      setSavingSet(false);
    }
  };

  const deleteVariableSet = async (variableSet: VariableSet) => {
    if (!window.confirm(`Delete variable set "${variableSet.attributes.name}"?`)) return;
    setPageError("");
    try {
      await fetchApi(`/varsets/${variableSet.id}`, { method: "DELETE" });
      setVariableSets((current) => current.filter((item) => item.id !== variableSet.id));
    } catch (error: unknown) {
      setPageError(messageFrom(error, "Failed to delete variable set"));
    }
  };

  const openWorkspaceEditor = (variableSet: VariableSet) => {
    setWorkspaceSet(variableSet);
    setSelectedWorkspaceIds(
      new Set(variableSet.relationships.workspaces.data.map((workspace) => workspace.id)),
    );
    setWorkspaceError("");
    setWorkspaceOpen(true);
  };

  const openVariables = (variableSet: VariableSet) => {
    setVariablesSet(variableSet);
    setVariablesOpen(true);
  };

  const updateVariableCount = (variableSetId: string, delta: number) => {
    setVariableSets((current) =>
      current.map((variableSet) =>
        variableSet.id === variableSetId
          ? {
              ...variableSet,
              attributes: {
                ...variableSet.attributes,
                "var-count": variableSet.attributes["var-count"] + delta,
              },
            }
          : variableSet,
      ),
    );
  };

  const toggleWorkspace = (workspaceId: string, checked: boolean) => {
    setSelectedWorkspaceIds((current) => {
      const next = new Set(current);
      if (checked) next.add(workspaceId);
      else next.delete(workspaceId);
      return next;
    });
  };

  const saveWorkspaceRelationships = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!workspaceSet) return;

    const currentIds = new Set(
      workspaceSet.relationships.workspaces.data.map((workspace) => workspace.id),
    );
    const attached = [...selectedWorkspaceIds].filter((id) => !currentIds.has(id));
    const detached = [...currentIds].filter((id) => !selectedWorkspaceIds.has(id));
    const relationshipBody = (ids: string[]) =>
      JSON.stringify({ data: ids.map((id) => ({ id, type: "workspaces" })) });

    setSavingWorkspaces(true);
    setWorkspaceError("");
    try {
      if (attached.length) {
        await fetchApi(`/varsets/${workspaceSet.id}/relationships/workspaces`, {
          method: "POST",
          body: relationshipBody(attached),
        });
      }
      if (detached.length) {
        await fetchApi(`/varsets/${workspaceSet.id}/relationships/workspaces`, {
          method: "DELETE",
          body: relationshipBody(detached),
        });
      }

      const updated: VariableSet = {
        ...workspaceSet,
        attributes: {
          ...workspaceSet.attributes,
          "workspace-count": selectedWorkspaceIds.size,
        },
        relationships: {
          ...workspaceSet.relationships,
          workspaces: {
            data: [...selectedWorkspaceIds].map((id) => ({ id, type: "workspaces" })),
          },
        },
      };
      setVariableSets((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setWorkspaceSet(updated);
      setWorkspaceOpen(false);
    } catch (error: unknown) {
      try {
        const fetched = await fetchApi(`/varsets/${workspaceSet.id}`);
        if (fetched?.data) {
          const freshSet = fetched.data;
          setVariableSets((current) =>
            current.map((item) => (item.id === freshSet.id ? freshSet : item)),
          );
          setWorkspaceSet(freshSet);
        }
      } catch {}
      setWorkspaceError(messageFrom(error, "Failed to update workspace access"));
    } finally {
      setSavingWorkspaces(false);
    }
  };

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold">{orgName} / Variable sets</h1>
          <p className="text-sm text-muted-foreground">
            Reuse configuration across workspaces in this organization.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/app/${orgName}`} className={buttonVariants({ variant: "outline" })}>
            Workspaces
          </Link>
          <Button onClick={() => openEditor()}>New variable set</Button>
        </div>
      </header>

      {pageError && (
        <p role="alert" className="text-sm text-destructive">
          {pageError}
        </p>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Variables</TableHead>
              <TableHead>Workspaces</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  Loading variable sets…
                </TableCell>
              </TableRow>
            )}
            {!loading &&
              variableSets.map((variableSet) => (
                <TableRow key={variableSet.id}>
                  <TableCell className="font-medium">{variableSet.attributes.name}</TableCell>
                  <TableCell className="max-w-72 truncate text-muted-foreground">
                    {variableSet.attributes.description || "—"}
                  </TableCell>
                  <TableCell>{variableSet.attributes.global ? "Global" : "Selected"}</TableCell>
                  <TableCell>{variableSet.attributes["var-count"]}</TableCell>
                  <TableCell>
                    {variableSet.attributes.global
                      ? "All"
                      : variableSet.attributes["workspace-count"]}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openVariables(variableSet)}
                      >
                        Variables
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openWorkspaceEditor(variableSet)}
                        disabled={variableSet.attributes.global}
                      >
                        Workspaces
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => openEditor(variableSet)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => deleteVariableSet(variableSet)}
                      >
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            {!loading && variableSets.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No variable sets yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit variable set" : "New variable set"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Update this reusable group of configuration."
                : "Create a reusable group of configuration for this organization."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveVariableSet}>
            <FieldGroup>
              <Field data-invalid={Boolean(editorError)}>
                <FieldLabel htmlFor="variable-set-name">Name</FieldLabel>
                <Input
                  id="variable-set-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  autoFocus
                  aria-invalid={Boolean(editorError)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="variable-set-description">Description</FieldLabel>
                <Input
                  id="variable-set-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
              <Field orientation="horizontal">
                <Checkbox
                  id="variable-set-global"
                  checked={global}
                  onCheckedChange={(checked) => setGlobal(checked === true)}
                />
                <div className="flex flex-col gap-0.5">
                  <FieldLabel htmlFor="variable-set-global">Global</FieldLabel>
                  <FieldDescription>Apply this set to every workspace.</FieldDescription>
                </div>
              </Field>
              <FieldError>{editorError}</FieldError>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditorOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={savingSet}>
                  {savingSet && <Spinner data-icon="inline-start" />}
                  {savingSet ? "Saving" : "Save variable set"}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={workspaceOpen} onOpenChange={setWorkspaceOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Manage workspaces</DialogTitle>
            <DialogDescription>
              Choose which workspaces use {workspaceSet?.attributes.name}.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveWorkspaceRelationships}>
            <FieldGroup>
              <div className="flex max-h-72 flex-col gap-3 overflow-y-auto">
                {workspaces.map((workspace) => (
                  <Field key={workspace.id} orientation="horizontal">
                    <Checkbox
                      id={`variable-set-workspace-${workspace.id}`}
                      checked={selectedWorkspaceIds.has(workspace.id)}
                      onCheckedChange={(checked) =>
                        toggleWorkspace(workspace.id, checked === true)
                      }
                    />
                    <FieldLabel htmlFor={`variable-set-workspace-${workspace.id}`}>
                      {workspace.attributes.name}
                    </FieldLabel>
                  </Field>
                ))}
                {workspaces.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    This organization has no workspaces.
                  </p>
                )}
              </div>
              <FieldError>{workspaceError}</FieldError>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setWorkspaceOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={savingWorkspaces}>
                  {savingWorkspaces && <Spinner data-icon="inline-start" />}
                  {savingWorkspaces ? "Saving" : "Save workspaces"}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>

      <VariablesDialog
        open={variablesOpen}
        variableSet={variablesSet}
        onOpenChange={setVariablesOpen}
        onCountChange={updateVariableCount}
      />
    </main>
  );
}
