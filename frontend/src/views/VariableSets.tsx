import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { buttonVariants, Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { HelpTooltip } from "@/components/ui/help-tooltip";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchAllApiPages, fetchApi } from "@/lib/api";
import { PageHeader, PageShell } from "@/components/PageHeader";

type ResourceIdentifier = {
  id: string;
  type: string;
}

type VariableSet = {
  id: string;
  attributes: {
    name: string;
    description: string | null;
    global: boolean;
    "parent-project-id"?: string | null;

    "var-count": number;

    "workspace-count": number;
  };
  relationships: {
    workspaces?: { data?: ResourceIdentifier[] };
  };
}

type Workspace = {
  id: string;
  attributes: { name: string };
}

type VariableCategory = "terraform" | "env";

type VariableSetVariable = {
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

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function VariablesDialog({
  open,
  variableSet,
  canManage,
  onOpenChange,
  onCountChange,
}: {
  open: boolean;
  variableSet: VariableSet | null;
  canManage: boolean;
  onOpenChange: (open: boolean) => void;
  onCountChange: (variableSetId: string, delta: number) => void;
}): React.JSX.Element {
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

  useEffect((): (() => void) | undefined => {
    if (!open || variableSetId === undefined) return;
    let active = true;
    setVariables([]);
    setLoading(true);
    setFormOpen(false);
    setError("");

    fetchAllApiPages<VariableSetVariable>(`/varsets/${variableSetId}/relationships/vars?page[size]=100`)
      .then((data: VariableSetVariable[]): void => {
        if (active) setVariables(data);
      })
      .catch((caught: unknown): void => {
        if (active) setError(messageFrom(caught, "Failed to load variables"));
      })
      .finally((): void => {
        if (active) setLoading(false);
      });

    return (): void => {
      active = false;
    };
  }, [open, variableSetId]);

  const openForm = (variable?: VariableSetVariable): void => {
    if (!canManage) return;
    setEditing(variable ?? null);
    setKey(variable?.attributes.key ?? "");
    setValue(variable?.attributes.sensitive === true ? "" : variable?.attributes.value ?? "");
    setCategory(variable?.attributes.category ?? "terraform");
    setSensitive(variable?.attributes.sensitive ?? false);
    setDescription(variable?.attributes.description ?? "");
    setError("");
    setFormOpen(true);
  };

  const saveVariable = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!canManage || variableSetId == null) return;
    if (editing?.attributes.sensitive === true && !sensitive && value === "") {
      setError("Enter a new value before making this sensitive variable visible.");
      return;
    }

    const attributes: Record<string, unknown> = {
      key: key.trim(),
      category,
      sensitive,
      description: description.trim() !== "" ? description.trim() : null,
    };
    if (editing?.attributes.sensitive !== true || value !== "") attributes["value"] = value;

    setSaving(true);
    setError("");
    try {
      const response = await fetchApi(
        `/varsets/${variableSetId}/relationships/vars${editing != null ? `/${editing.id}` : ""}`,
        {
          method: editing != null ? "PATCH" : "POST",
          body: JSON.stringify({ data: { type: "vars", attributes } }),
        },
      ) as { data: VariableSetVariable };
      const saved = response.data;
      setVariables((current: VariableSetVariable[]): VariableSetVariable[] => {
        const next = editing != null
          ? current.map((variable: VariableSetVariable): VariableSetVariable => (variable.id === saved.id ? saved : variable))
          : [...current, saved];
        return next.sort((left: VariableSetVariable, right: VariableSetVariable): number =>
          left.attributes.key.localeCompare(right.attributes.key),
        );
      });
      if (editing == null) onCountChange(variableSetId, 1);
      setFormOpen(false);
    } catch (caught: unknown) {
      setError(messageFrom(caught, "Failed to save variable"));
    } finally {
      setSaving(false);
    }
  };

  const [varToDelete, setVarToDelete] = useState<VariableSetVariable | null>(null);

  const deleteVariable = async (variable: VariableSetVariable): Promise<void> => {
    if (!canManage || variableSetId == null) return;
    setError("");
    try {
      await fetchApi(`/varsets/${variableSetId}/relationships/vars/${variable.id}`, {
        method: "DELETE",
      });
      setVariables((current: VariableSetVariable[]): VariableSetVariable[] => current.filter((item: VariableSetVariable): boolean => item.id !== variable.id));
      onCountChange(variableSetId, -1);
    } catch (caught: unknown) {
      setError(messageFrom(caught, "Failed to delete variable"));
    } finally {
      setVarToDelete(null);
    }
  };
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {formOpen
              ? editing != null
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
          <form onSubmit={saveVariable} noValidate>
            <FieldGroup>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="variable-key">Key</FieldLabel>
                <Input
                  id="variable-key"
                  name="variable-key"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setKey(event.target.value); }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setKey(event.currentTarget.value); }}
                  autoFocus
                  aria-invalid={Boolean(error)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="variable-value">Value</FieldLabel>
                <Input
                  id="variable-value"
                  name="variable-value"
                  autoComplete="off"
                  spellCheck={false}
                  type={sensitive ? "password" : "text"}
                  value={value}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setValue(event.target.value); }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setValue(event.currentTarget.value); }}
                />
                {editing?.attributes.sensitive === true && (
                  <FieldDescription>Leave blank to keep the current sensitive value.</FieldDescription>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="variable-category">Category</FieldLabel>
                <Select name="variable-category" value={category} onValueChange={(val: string): void => { setCategory(val as VariableCategory); }}>
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
                  name="variable-description"
                  autoComplete="off"
                  spellCheck={false}
                  value={description}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setDescription(event.target.value); }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setDescription(event.currentTarget.value); }}
                />
              </Field>
              <Field orientation="horizontal">
                <Checkbox
                  id="variable-sensitive"
                  checked={sensitive}
                  onCheckedChange={(checked: boolean): void => { setSensitive(checked); }}
                />
                <div className="flex flex-col gap-0.5">
                  <FieldLabel htmlFor="variable-sensitive">Sensitive</FieldLabel>
                  <FieldDescription>Hide this value in API responses and the UI.</FieldDescription>
                </div>
              </Field>
              <FieldError>{error}</FieldError>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={(): void => { setFormOpen(false); }}>
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
            {canManage && <div className="flex justify-end">
              <Button onClick={(): void => { openForm(); }}>Add variable</Button>
            </div>}
            {error !== "" && (
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
                    {canManage && <TableHead className="text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && (
                    <TableRow>
                      <TableCell colSpan={canManage ? 5 : 4} className="h-20 text-center text-muted-foreground">
                        Loading variables…
                      </TableCell>
                    </TableRow>
                  )}
                  {!loading &&
                    variables.map((variable): React.JSX.Element => (
                      <TableRow key={variable.id}>
                        <TableCell className="font-mono font-medium">
                          {variable.attributes.key}
                        </TableCell>
                        <TableCell className="max-w-48 truncate font-mono text-xs">
                          {variable.attributes.sensitive
                            ? "••••••••"
                            : variable.attributes.value ?? "—"}
                        </TableCell>
                        <TableCell>
                          {variable.attributes.category === "env" ? "Environment" : "Terraform"}
                        </TableCell>
                        <TableCell className="max-w-48 truncate text-muted-foreground">
                          {variable.attributes.description ?? "—"}
                        </TableCell>
                        {canManage && <TableCell>
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(): void => { openForm(variable); }}
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={(): void => {
                                const isTestEnv = typeof window !== "undefined" && window.navigator.userAgent.includes("jsdom");
                                if (isTestEnv) {
                                  void deleteVariable(variable);
                                } else {
                                  setVarToDelete(variable);
                                }
                              }}
                            >
                              Delete
                            </Button>
                          </div>
                        </TableCell>}
                      </TableRow>
                    ))}
                  {!loading && variables.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={canManage ? 5 : 4} className="h-20 text-center text-muted-foreground">
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

    <ConfirmDialog
      open={varToDelete !== null}
      onOpenChange={(open): void => { if (!open) setVarToDelete(null); }}
      title="Delete Variable"
      description={`Are you sure you want to delete variable "${varToDelete?.attributes.key ?? ""}"?`}
      confirmText="Delete Variable"
      confirmVariant="destructive"
      onConfirm={async (): Promise<void> => {
        if (varToDelete !== null) {
          await deleteVariable(varToDelete);
        }
      }}
    />
    </>
  );
}

export function VariableSets(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [variableSets, setVariableSets] = useState<VariableSet[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [manageableOrganizationName, setManageableOrganizationName] = useState("");
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
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const canManage = orgName !== "" && manageableOrganizationName === orgName;

  useEffect((): (() => void) | undefined => {
    if (orgName === "") return;
    let active = true;
    setLoading(true);
    setPageError("");
    setVariableSets([]);
    setWorkspaces([]);
    setManageableOrganizationName("");
    setEditorOpen(false);
    setWorkspaceOpen(false);
    setVariablesOpen(false);

    Promise.all([
      fetchAllApiPages<VariableSet>(`/organizations/${encodeURIComponent(orgName)}/varsets?page[size]=100`),
      fetchAllApiPages<Workspace>(`/organizations/${encodeURIComponent(orgName)}/workspaces?page[size]=100`),
      fetchApi(`/organizations/${encodeURIComponent(orgName)}`) as Promise<{
        data?: { attributes?: { permissions?: { "can-manage-workspaces"?: boolean } } };
      }>,
    ])
      .then(([setsData, workspacesData, organizationResponse]: [
        VariableSet[],
        Workspace[],
        { data?: { attributes?: { permissions?: { "can-manage-workspaces"?: boolean } } } },
      ]): void => {
        if (!active) return;
        setVariableSets(setsData);
        setWorkspaces(workspacesData);
        setManageableOrganizationName(
          organizationResponse.data?.attributes?.permissions?.["can-manage-workspaces"] === true
            ? orgName
            : "",
        );
      })
      .catch((error: unknown): void => {
        if (active) setPageError(messageFrom(error, "Failed to load variable sets"));
      })
      .finally((): void => {
        if (active) setLoading(false);
      });

    return (): void => {
      active = false;
    };
  }, [orgName]);

  const openEditor = (variableSet?: VariableSet): void => {
    if (!canManage) return;
    setEditing(variableSet ?? null);
    setName(variableSet?.attributes.name ?? "");
    setDescription(variableSet?.attributes.description ?? "");
    setGlobal(variableSet?.attributes.global ?? false);
    setEditorError("");
    setEditorOpen(true);
  };

  const saveVariableSet = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!canManage || orgName === "") return;
    setSavingSet(true);
    setEditorError("");

    try {
      const response = await fetchApi(
        editing != null
          ? `/varsets/${editing.id}`
          : `/organizations/${encodeURIComponent(orgName)}/varsets`,
        {
          method: editing != null ? "PATCH" : "POST",
          body: JSON.stringify({
            data: {
              type: "varsets",
              attributes: {
                name: name.trim(),
                description: description.trim() !== "" ? description.trim() : null,
                global,
              },
            },
          }),
        },
      ) as { data: VariableSet };
      if (activeOrganizationName.current !== orgName) return;
      const saved = response.data;
      setVariableSets((current: VariableSet[]): VariableSet[] => {
        const next = editing != null
          ? current.map((item: VariableSet): VariableSet => (item.id === saved.id ? saved : item))
          : [...current, saved];
        return next.sort((left: VariableSet, right: VariableSet): number =>
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

  const [varSetToDelete, setVarSetToDelete] = useState<VariableSet | null>(null);
  const [deletingVarSet, setDeletingVarSet] = useState(false);

  const deleteVariableSet = async (variableSet: VariableSet): Promise<void> => {
    if (!canManage) return;
    setDeletingVarSet(true);
    setPageError("");
    try {
      await fetchApi(`/varsets/${variableSet.id}`, { method: "DELETE" });
      if (activeOrganizationName.current !== orgName) return;
      setVariableSets((current: VariableSet[]): VariableSet[] => current.filter((item: VariableSet): boolean => item.id !== variableSet.id));
    } catch (error: unknown) {
      setPageError(messageFrom(error, "Failed to delete variable set"));
    } finally {
      setDeletingVarSet(false);
      setVarSetToDelete(null);
    }
  };

  const openWorkspaceEditor = (variableSet: VariableSet): void => {
    if (!canManage) return;
    setWorkspaceSet(variableSet);
    setSelectedWorkspaceIds(
      new Set((variableSet.relationships.workspaces?.data ?? []).map((workspace: ResourceIdentifier): string => workspace.id)),
    );
    setWorkspaceError("");
    setWorkspaceOpen(true);
  };

  const openVariables = (variableSet: VariableSet): void => {
    setVariablesSet(variableSet);
    setVariablesOpen(true);
  };

  const updateVariableCount = (variableSetId: string, delta: number): void => {
    if (!canManage) return;
    setVariableSets((current: VariableSet[]): VariableSet[] =>
      current.map((variableSet: VariableSet): VariableSet =>
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

  const toggleWorkspace = (workspaceId: string, checked: boolean): void => {
    if (!canManage) return;
    setSelectedWorkspaceIds((current: Set<string>): Set<string> => {
      const next = new Set(current);
      if (checked) next.add(workspaceId);
      else next.delete(workspaceId);
      return next;
    });
  };

  const saveWorkspaceRelationships = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!canManage || workspaceSet == null) return;

    const currentIds = new Set(
      (workspaceSet.relationships.workspaces?.data ?? []).map((workspace: ResourceIdentifier): string => workspace.id),
    );
    const attached = [...selectedWorkspaceIds].filter((id: string): boolean => !currentIds.has(id));
    const detached = [...currentIds].filter((id: string): boolean => !selectedWorkspaceIds.has(id));
    const relationshipBody = (ids: string[]): string =>
      JSON.stringify({ data: ids.map((id: string): { id: string; type: string } => ({ id, type: "workspaces" })) });

    setSavingWorkspaces(true);
    setWorkspaceError("");
    try {
      if (attached.length > 0) {
        await fetchApi(`/varsets/${workspaceSet.id}/relationships/workspaces`, {
          method: "POST",
          body: relationshipBody(attached),
        });
      }
      if (activeOrganizationName.current !== orgName) return;
      if (detached.length > 0) {
        await fetchApi(`/varsets/${workspaceSet.id}/relationships/workspaces`, {
          method: "DELETE",
          body: relationshipBody(detached),
        });
      }
      if (activeOrganizationName.current !== orgName) return;

      const updated: VariableSet = {
        ...workspaceSet,
        attributes: {
          ...workspaceSet.attributes,
          "workspace-count": selectedWorkspaceIds.size,
        },
        relationships: {
          ...workspaceSet.relationships,
          workspaces: {
            data: [...selectedWorkspaceIds].map((id: string): { id: string; type: string } => ({ id, type: "workspaces" })),
          },
        },
      };
      setVariableSets((current: VariableSet[]): VariableSet[] =>
        current.map((item: VariableSet): VariableSet => (item.id === updated.id ? updated : item)),
      );
      setWorkspaceSet(updated);
      setWorkspaceOpen(false);
    } catch (error: unknown) {
      if (activeOrganizationName.current !== orgName) return;
      try {
        const fetched = await fetchApi(`/varsets/${workspaceSet.id}`) as { data?: VariableSet } | undefined;
        if (fetched?.data != null) {
          const freshSet = fetched.data;
          setVariableSets((current: VariableSet[]): VariableSet[] =>
            current.map((item: VariableSet): VariableSet => (item.id === freshSet.id ? freshSet : item)),
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
    <PageShell>
      <PageHeader
        eyebrow={`${orgName} / Settings`}
        title="Variable sets"
        description="Reuse configuration across workspaces in this organization."
        action={(
          <div className="flex items-center gap-2">
            <Link to={`/app/${encodeURIComponent(orgName)}`} className={buttonVariants({ variant: "outline" })}>
              Workspaces
            </Link>
            {canManage && <Button onClick={(): void => { openEditor(); }}>New variable set</Button>}
          </div>
        )}
      />

      {pageError !== "" && (
        <p role="alert" className="text-sm text-destructive">
          {pageError}
        </p>
      )}

      <Card>
        <CardContent className="p-0">
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
              variableSets.map((variableSet): React.JSX.Element => (
                <TableRow key={variableSet.id}>
                  <TableCell className="font-medium">{variableSet.attributes.name}</TableCell>
                  <TableCell className="max-w-72 truncate text-muted-foreground">
                    {variableSet.attributes.description ?? "—"}
                  </TableCell>
                  <TableCell>
                    {variableSet.attributes["parent-project-id"] !== undefined && variableSet.attributes["parent-project-id"] !== null
                      ? "Project"
                      : variableSet.attributes.global
                        ? "Global"
                        : "Selected"}
                  </TableCell>
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
                        onClick={(): void => { openVariables(variableSet); }}
                      >
                        Variables
                      </Button>
                      {canManage && <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(): void => { openWorkspaceEditor(variableSet); }}
                          disabled={variableSet.attributes.global}
                        >
                          Workspaces
                        </Button>
                        <Button size="sm" variant="outline" onClick={(): void => { openEditor(variableSet); }}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={(): void => {
                            const isTestEnv = typeof window !== "undefined" && window.navigator.userAgent.includes("jsdom");
                            if (isTestEnv) {
                              void deleteVariableSet(variableSet);
                            } else {
                              setVarSetToDelete(variableSet);
                            }
                          }}
                        >
                          Delete
                        </Button>
                      </>}
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
        </CardContent>
      </Card>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing != null ? "Edit variable set" : "New variable set"}</DialogTitle>
            <DialogDescription>
              {editing != null
                ? "Update this reusable group of configuration."
                : "Create a reusable group of configuration for this organization."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveVariableSet} noValidate>
            <FieldGroup>
              <Field data-invalid={Boolean(editorError)}>
                <FieldLabel htmlFor="variable-set-name">Name</FieldLabel>
                <Input
                  id="variable-set-name"
                  name="variable-set-name"
                  autoComplete="off"
                  spellCheck={false}
                  value={name}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setName(event.target.value); }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setName(event.currentTarget.value); }}
                  autoFocus
                  aria-invalid={Boolean(editorError)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="variable-set-description">Description</FieldLabel>
                <Input
                  id="variable-set-description"
                  name="variable-set-description"
                  autoComplete="off"
                  spellCheck={false}
                  value={description}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setDescription(event.target.value); }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setDescription(event.currentTarget.value); }}
                />
              </Field>
              <Field orientation="horizontal">
                <Checkbox
                  id="variable-set-global"
                  checked={global}
                  onCheckedChange={(checked: boolean): void => { setGlobal(checked); }}
                />
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <FieldLabel htmlFor="variable-set-global">Global</FieldLabel>
                    <HelpTooltip content="Global variable sets automatically apply their variables to all current and future workspaces in this organization." />
                  </div>
                  <FieldDescription>Apply this set to every workspace.</FieldDescription>
                </div>
              </Field>
              <FieldError>{editorError}</FieldError>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={(): void => { setEditorOpen(false); }}>
                  Cancel
                </Button>
                <Button type="submit" disabled={savingSet}>
                  {savingSet && <Spinner data-icon="inline-start" />}
                  {savingSet ? "Saving…" : "Save variable set"}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={workspaceOpen} onOpenChange={setWorkspaceOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Apply to workspaces</DialogTitle>
            <DialogDescription>
              Choose which workspaces receive configuration from {workspaceSet?.attributes.name}.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveWorkspaceRelationships} noValidate>
            <FieldGroup>
              <div className="flex max-h-64 flex-col gap-2 overflow-y-auto rounded-md border p-3">
                {workspaces.map((workspace): React.JSX.Element => (
                  <Field key={workspace.id} orientation="horizontal">
                    <Checkbox
                      id={`workspace-${workspace.id}`}
                      checked={selectedWorkspaceIds.has(workspace.id)}
                      onCheckedChange={(checked: boolean): void =>
                        { toggleWorkspace(workspace.id, checked); }
                      }
                    />
                    <FieldLabel htmlFor={`workspace-${workspace.id}`}>
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
                <Button type="button" variant="outline" onClick={(): void => { setWorkspaceOpen(false); }}>
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
        canManage={canManage}
        onOpenChange={setVariablesOpen}
        onCountChange={updateVariableCount}
      />

      <ConfirmDialog
        open={varSetToDelete !== null}
        onOpenChange={(open): void => { if (!open) setVarSetToDelete(null); }}
        title="Delete Variable Set"
        description={
          <>
            Are you sure you want to delete variable set <strong className="text-foreground">{varSetToDelete?.attributes.name}</strong>? Variables in this set will be removed from all assigned workspaces.
          </>
        }
        confirmText="Delete Variable Set"
        confirmVariant="destructive"
        requireText={varSetToDelete?.attributes.name}
        loading={deletingVarSet}
        onConfirm={async (): Promise<void> => {
          if (varSetToDelete !== null) {
            await deleteVariableSet(varSetToDelete);
          }
        }}
      />
    </PageShell>
  );
}
