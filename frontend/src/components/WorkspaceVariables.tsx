import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LockKeyhole, Plus, Unplug } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
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
import { fetchAllApiPages, fetchApi } from "@/lib/api";

type VariableCategory = "terraform" | "env";

type WorkspaceVariable = {
  id: string;
  attributes: {
    key: string;
    value: string | null;
    category: VariableCategory;
    sensitive: boolean;
    hcl: boolean;
    description: string | null;
  };
};

type VariableSet = {
  id: string;
  attributes: {
    name: string;
    description: string | null;
    global: boolean;
    priority: boolean;
    "parent-project-id": string | null;
    "var-count": number;
    "workspace-count": number;
    "project-count": number;
    "stack-count": number;
  };
};

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
};

// One row of the effective-values endpoint: the winning source per key, with
// the winning set named on inherited rows (issue #627).
type EffectiveVariable = {
  id: string;
  attributes: {
    key: string;
    category: VariableCategory;
    "variable-set-name"?: string;
  };
};

const messageFrom = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export function WorkspaceVariables({
  workspaceId,
  orgName,
  canUpdate,
}: Readonly<{
  workspaceId: string;
  orgName: string;
  canUpdate: boolean;
}>): React.JSX.Element {
  const [variables, setVariables] = useState<WorkspaceVariable[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<WorkspaceVariable | null>(null);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [category, setCategory] = useState<VariableCategory>("terraform");
  const [description, setDescription] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [hcl, setHcl] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  // Pending variable deletion, confirmed through a dialog (issue #588).
  // Sensitive values are write-only, so deleting one asks for the key.
  const [pendingDelete, setPendingDelete] = useState<WorkspaceVariable | null>(null);

  // Attached variable sets: inherited variables stay on their set and are
  // rendered read-only below the workspace-owned variables.
  const [sets, setSets] = useState<VariableSet[]>([]);
  const [setsVars, setSetsVars] = useState<Record<string, VariableSetVariable[]>>({});
  const [setsLoading, setSetsLoading] = useState(true);
  const [setsError, setSetsError] = useState("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [allSets, setAllSets] = useState<VariableSet[]>([]);
  const [attachSetsLoading, setAttachSetsLoading] = useState(false);
  const [attachError, setAttachError] = useState("");
  const [busySetId, setBusySetId] = useState<string | null>(null);
  // Effective winners for duplicated keys (issue #627): the all-vars
  // endpoint resolves precedence server-side and names the winning set.
  // Advisory only: a failed load leaves rows unannotated rather than
  // blocking the lists, so tests and offline reads still render.
  const [winners, setWinners] = useState<ReadonlyMap<string, string>>(new Map());

  // Keys defined by more than one source: only these get won-by titles.
  const duplicatedKeys = useMemo((): ReadonlySet<string> => {
    const counts = new Map<string, number>();
    const note = (category: string, key: string): void => {
      const mapKey = category + ':' + key;
      counts.set(mapKey, (counts.get(mapKey) ?? 0) + 1);
    };
    for (const variable of variables) note(variable.attributes.category, variable.attributes.key);
    for (const vars of Object.values(setsVars)) {
      for (const variable of vars) note(variable.attributes.category, variable.attributes.key);
    }
    return new Set([...counts].filter(([, count]): boolean => count > 1).map(([mapKey]): string => mapKey));
  }, [variables, setsVars]);

  // Title naming the winning source for a duplicated key, or undefined
  // when the winner is unknown or this row is the only source.
  const winnerTitle = (category: string, key: string, ownLabel: string): string | undefined => {
    if (!duplicatedKeys.has(category + ':' + key)) return undefined;
    const winner = winners.get(category + ':' + key);
    if (winner === undefined) return undefined;
    if (winner === ownLabel) return "Effective value for " + key + " (wins for this workspace)";
    const winnerLabel = winner === "Workspace" ? "the workspace value" : "variable set " + JSON.stringify(winner);
    return "Overridden by " + winnerLabel + " for this workspace";
  };

  // Generation guard: invalidated on unmount, workspaceId change, or a newer
  // attach/detach refresh so stale variable-set responses cannot update this view.
  const attachedLoadGeneration = useRef(0);

  const loadAttachedSets = useCallback((): void => {
    const generation = attachedLoadGeneration.current + 1;
    attachedLoadGeneration.current = generation;
    const isCurrent = (): boolean => attachedLoadGeneration.current === generation;
    setSetsLoading(true);
    setSetsError("");
    fetchAllApiPages<VariableSet>(`/workspaces/${workspaceId}/varsets?page[size]=100`)
      .then(async (attached: VariableSet[]): Promise<void> => {
        if (!isCurrent()) return;
        const varsBySet = await Promise.all(attached.map(async (set: VariableSet): Promise<[string, VariableSetVariable[]]> => {
          const vars = await fetchAllApiPages<VariableSetVariable>(`/varsets/${set.id}/relationships/vars?page[size]=100`);
          return [set.id, vars];
        }));
        if (!isCurrent()) return;
        setSets(attached);
        setSetsVars(Object.fromEntries(varsBySet));
      })
      .catch((error: unknown): void => {
        if (isCurrent()) setSetsError(messageFrom(error, "Failed to load variable sets"));
      })
      .finally((): void => {
        if (isCurrent()) setSetsLoading(false);
      });
  }, [workspaceId]);

  useEffect((): (() => void) => {
    // Abort the previous workspace's in-flight request on change/unmount.
    // A shared boolean would be re-armed by the next effect, letting a slow
    // stale response overwrite the current workspace's variables.
    const controller = new AbortController();
    const signal = controller.signal;
    setLoading(true);
    setPageError("");

    fetchAllApiPages<WorkspaceVariable>(`/workspaces/${workspaceId}/vars?page[size]=100`, signal)
      .then((data: WorkspaceVariable[]): void => {
        if (signal.aborted) return;
        setVariables(data);
      })
      .catch((error: unknown): void => {
        if (signal.aborted) return;
        setPageError(messageFrom(error, "Failed to load workspace variables"));
      })
      .finally((): void => {
        if (!signal.aborted) setLoading(false);
      });

    fetchAllApiPages<EffectiveVariable>(`/workspaces/${workspaceId}/all-vars?page[size]=100`, signal)
      .then((data: EffectiveVariable[]): void => {
        if (signal.aborted) return;
        const map = new Map<string, string>();
        for (const row of data) {
          map.set(row.attributes.category + ':' + row.attributes.key, row.attributes["variable-set-name"] ?? "Workspace");
        }
        setWinners(map);
      })
      .catch((): void => {
        if (!signal.aborted) setWinners(new Map());
      });

    loadAttachedSets();

    return (): void => {
      controller.abort();
      attachedLoadGeneration.current += 1;
    };
  }, [workspaceId, loadAttachedSets]);

  const openAttach = (): void => {
    if (!canUpdate) return;
    setAttachError("");
    setAttachSetsLoading(true);
    setAllSets([]);
    setAttachOpen(true);
    fetchAllApiPages<VariableSet>(`/organizations/${encodeURIComponent(orgName)}/varsets?page[size]=100`)
      .then((orgSets: VariableSet[]): void => { setAllSets(orgSets); })
      .catch((error: unknown): void => {
        setAttachError(messageFrom(error, "Failed to load organization variable sets"));
      })
      .finally((): void => {
        setAttachSetsLoading(false);
      });
  };

  const attachSet = async (set: VariableSet): Promise<void> => {
    if (!canUpdate) return;
    setBusySetId(set.id);
    setAttachError("");
    try {
      await fetchApi(`/varsets/${set.id}/relationships/workspaces`, {
        method: "POST",
        body: JSON.stringify({ data: [{ type: "workspaces", id: workspaceId }] }),
      });
      loadAttachedSets();
      setAttachOpen(false);
    } catch (error: unknown) {
      setAttachError(messageFrom(error, "Failed to attach variable set"));
    } finally {
      setBusySetId(null);
    }
  };

  const detachSet = async (set: VariableSet): Promise<void> => {
    if (!canUpdate) return;
    setBusySetId(set.id);
    setSetsError("");
    try {
      await fetchApi(`/varsets/${set.id}/relationships/workspaces`, {
        method: "DELETE",
        body: JSON.stringify({ data: [{ type: "workspaces", id: workspaceId }] }),
      });
      loadAttachedSets();
    } catch (error: unknown) {
      setSetsError(messageFrom(error, "Failed to detach variable set"));
    } finally {
      setBusySetId(null);
    }
  };

  const openEditor = (variable?: WorkspaceVariable): void => {
    if (!canUpdate) return;
    setEditing(variable ?? null);
    setKey(variable?.attributes.key ?? "");
    setValue(variable?.attributes.sensitive === true ? "" : variable?.attributes.value ?? "");
    setCategory(variable?.attributes.category ?? "terraform");
    setDescription(variable?.attributes.description ?? "");
    setSensitive(variable?.attributes.sensitive ?? false);
    setHcl(variable?.attributes.hcl ?? false);
    setEditorError("");
    setEditorOpen(true);
  };

  const saveVariable = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!canUpdate) return;
    if (key.trim() === "") {
      setEditorError("Key is required.");
      return;
    }
    if (editing?.attributes.sensitive === true && !sensitive && value === "") {
      setEditorError("Enter a new value before making this sensitive variable visible.");
      return;
    }

    const attributes = {
      key: key.trim(),
      category,
      sensitive,
      hcl,
      description: description.trim() === "" ? null : description.trim(),
      ...(editing?.attributes.sensitive !== true || value !== "" ? { value } : undefined),
    };

    setSaving(true);
    setEditorError("");
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi(
        `/workspaces/${workspaceId}/vars${editing == null ? "" : `/${editing.id}`}`,
        {
          method: editing == null ? "POST" : "PATCH",
          body: JSON.stringify({ data: { type: "vars", attributes } }),
        },
      ) as { data: WorkspaceVariable };
      const saved = response.data;
      setVariables((current: WorkspaceVariable[]): WorkspaceVariable[] => {
        const next = editing == null
          ? [...current, saved]
          : current.map((variable: WorkspaceVariable): WorkspaceVariable =>
              variable.id === saved.id ? saved : variable,
            );
        return next.sort((left: WorkspaceVariable, right: WorkspaceVariable): number =>
          left.attributes.key.localeCompare(right.attributes.key),
        );
      });
      setEditorOpen(false);
    } catch (error: unknown) {
      setEditorError(messageFrom(error, "Failed to save variable"));
    } finally {
      setSaving(false);
    }
  };

  const deleteVariable = async (variable: WorkspaceVariable): Promise<void> => {
    if (!canUpdate) return;
    setPageError("");
    try {
      await fetchApi(`/workspaces/${workspaceId}/vars/${variable.id}`, { method: "DELETE" });
      setVariables((current: WorkspaceVariable[]): WorkspaceVariable[] =>
        current.filter((item: WorkspaceVariable): boolean => item.id !== variable.id),
      );
    } catch (error: unknown) {
      setPageError(messageFrom(error, "Failed to delete variable"));
    } finally {
      setPendingDelete(null);
    }
  };

  const unattachedSets = allSets.filter(
    (set: VariableSet): boolean => !sets.some((attached: VariableSet): boolean => attached.id === set.id),
  );

  return (
    <>
      <div className="flex flex-col gap-6">
        <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Workspace variables
            <Badge variant="secondary">{variables.length}</Badge>
          </CardTitle>
          <CardDescription>
            Variables owned by this workspace. They override matching values from non-priority sets; priority sets override them instead. Hover a duplicated key to see which source wins.
          </CardDescription>
          {canUpdate && <CardAction>
            <Button onClick={(): void => { openEditor(); }}>
              <Plus data-icon="inline-start" />
              Add variable
            </Button>
          </CardAction>}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!canUpdate && (
            <p className="text-sm text-muted-foreground">
              You can view variables, but you do not have permission to change them.
            </p>
          )}
          {pageError !== "" && (
            <p role="alert" className="text-sm text-destructive">
              {pageError}
            </p>
          )}
          <div className="rounded-md border">
            <Table density="dense">
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Description</TableHead>
                  {canUpdate && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && (
                  <TableRow>
                    <TableCell colSpan={canUpdate ? 5 : 4} className="h-20 text-center text-muted-foreground">
                      Loading variables…
                    </TableCell>
                  </TableRow>
                )}
                {!loading && variables.map((variable: WorkspaceVariable): React.JSX.Element => (
                  <TableRow key={variable.id}>
                    <TableCell className="font-mono font-medium" title={winnerTitle(variable.attributes.category, variable.attributes.key, "Workspace") ?? undefined}>
                      <div className="flex items-center gap-2">
                        {variable.attributes.key}
                        {variable.attributes.sensitive && (
                          <span className="inline-flex items-center text-muted-foreground" title="Sensitive — value hidden after save">
                            <LockKeyhole className="size-3.5" aria-hidden="true" />
                            <span className="sr-only">Sensitive</span>
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-48 truncate font-mono text-xs">
                      {variable.attributes.sensitive ? <span className="text-muted-foreground">Write only</span> : variable.attributes.value ?? "—"}
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {variable.attributes.category === "env" ? "Environment" : "Terraform"}{variable.attributes.hcl ? " · HCL" : ""}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-muted-foreground">
                      {variable.attributes.description ?? "—"}
                    </TableCell>
                    {canUpdate && <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={(): void => { openEditor(variable); }}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={(): void => { setPendingDelete(variable); }}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>}
                  </TableRow>
                ))}
                {!loading && variables.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={canUpdate ? 5 : 4} className="h-20 text-center text-muted-foreground">
                      No workspace variables have been added.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Variable sets
            <Badge variant="secondary">{sets.length}</Badge>
          </CardTitle>
          <CardDescription>
            Variable sets attached to this workspace. Inherited variables are read-only here and managed on the variable set itself; sensitive values remain hidden. Precedence: non-priority sets, then workspace values, then priority sets; same-rank ties go to the alphabetically-first set name. Hover a duplicated key to see which source wins.
          </CardDescription>
          {canUpdate && <CardAction>
            <Button onClick={openAttach}>
              <Plus data-icon="inline-start" />
              Attach variable set
            </Button>
          </CardAction>}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {setsError !== "" && (
            <p role="alert" className="text-sm text-destructive">
              {setsError}
            </p>
          )}
          {setsLoading && (
            <p className="text-sm text-muted-foreground">Loading variable sets…</p>
          )}
          {!setsLoading && sets.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No variable sets are attached to this workspace.
            </p>
          )}
          {!setsLoading && sets.map((set: VariableSet): React.JSX.Element => {
            const inherited = setsVars[set.id] ?? [];
            return (
              <div key={set.id} className="rounded-md border">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{set.attributes.name}</span>
                    {set.attributes.global && <Badge variant="secondary">Global</Badge>}
                    {set.attributes.priority && <Badge variant="secondary">Priority</Badge>}
                    {!set.attributes.global && set.attributes["parent-project-id"] != null && (
                      <Badge variant="outline">Project-owned</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {set.attributes["workspace-count"]} workspace{set.attributes["workspace-count"] === 1 ? "" : "s"}
                      {set.attributes["project-count"] > 0 && (
                        <> · {set.attributes["project-count"]} project{set.attributes["project-count"] === 1 ? "" : "s"}</>
                      )}
                    </span>
                    {canUpdate && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busySetId === set.id}
                        onClick={(): void => { void detachSet(set); }}
                      >
                        {busySetId === set.id
                          ? <Spinner data-icon="inline-start" />
                          : <Unplug data-icon="inline-start" />}
                        Detach
                      </Button>
                    )}
                  </div>
                </div>
                {set.attributes.description !== null && set.attributes.description !== "" && (
                  <p className="px-4 pt-3 text-sm text-muted-foreground">{set.attributes.description}</p>
                )}
                <div className="overflow-x-auto">
                  <Table density="dense">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Key</TableHead>
                        <TableHead>Value</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Description</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {inherited.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4} className="h-12 text-center text-muted-foreground">
                            This variable set has no variables.
                          </TableCell>
                        </TableRow>
                      )}
                      {inherited.map((variable: VariableSetVariable): React.JSX.Element => (
                        <TableRow key={variable.id}>
                          <TableCell className="font-mono font-medium" title={winnerTitle(variable.attributes.category, variable.attributes.key, set.attributes.name) ?? undefined}>
                            <div className="flex items-center gap-2">
                              {variable.attributes.key}
                              {variable.attributes.sensitive && (
                                <span className="inline-flex items-center text-muted-foreground" title="Sensitive — value hidden after save">
                                  <LockKeyhole className="size-3.5" aria-hidden="true" />
                                  <span className="sr-only">Sensitive</span>
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="max-w-48 truncate font-mono text-xs">
                            {variable.attributes.sensitive ? <span className="text-muted-foreground">Write only</span> : variable.attributes.value ?? "—"}
                          </TableCell>
                          <TableCell>
                            <span className="text-sm text-muted-foreground">
                              {variable.attributes.category === "env" ? "Environment" : "Terraform"}{variable.attributes.hcl ? " · HCL" : ""}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-48 truncate text-muted-foreground">
                            {variable.attributes.description ?? "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
      </div>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing == null ? "Add variable" : "Edit variable"}</DialogTitle>
            <DialogDescription>
              Configure a Terraform input or environment variable for this workspace.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveVariable} noValidate>
            <FieldGroup>
              <Field data-invalid={editorError !== "" && key.trim() === ""}>
                <FieldLabel htmlFor="workspace-variable-key">Key</FieldLabel>
                <Input
                  id="workspace-variable-key"
                  name="variable-key"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setKey(event.target.value); }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setKey(event.currentTarget.value); }}
                  aria-invalid={editorError !== "" && key.trim() === ""}
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="workspace-variable-value">Value</FieldLabel>
                <Input
                  id="workspace-variable-value"
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
                <FieldLabel htmlFor="workspace-variable-category">Category</FieldLabel>
                <Select
                  id="workspace-variable-category"
                  name="variable-category"
                  value={category}
// SAFETY: the select options are generated from the same union; the change event carries one of them.
                  onValueChange={(next: string): void => {

                    // SAFETY: the change event carries one of the union values the UI renders from the same options.

                    setCategory(next as VariableCategory);

                  }}
                >
                  <SelectItem value="terraform">Terraform</SelectItem>
                  <SelectItem value="env">Environment</SelectItem>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="workspace-variable-description">Description</FieldLabel>
                <Input
                  id="workspace-variable-description"
                  name="variable-description"
                  autoComplete="off"
                  spellCheck={false}
                  value={description}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setDescription(event.target.value); }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setDescription(event.currentTarget.value); }}
                />
              </Field>
              <FieldSet>
                <FieldLegend variant="label">Options</FieldLegend>
                <FieldGroup className="gap-3">
                  <Field orientation="horizontal">
                    <Checkbox
                      id="workspace-variable-sensitive"
                      checked={sensitive}
                      onCheckedChange={(checked: boolean): void => { setSensitive(checked); }}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor="workspace-variable-sensitive">Sensitive</FieldLabel>
                      <FieldDescription>Hide this value in API responses and the UI.</FieldDescription>
                    </FieldContent>
                  </Field>
                  <Field orientation="horizontal">
                    <Checkbox
                      id="workspace-variable-hcl"
                      checked={hcl}
                      onCheckedChange={(checked: boolean): void => { setHcl(checked); }}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor="workspace-variable-hcl">Parse as HCL</FieldLabel>
                      <FieldDescription>Use an HCL expression instead of a literal string.</FieldDescription>
                    </FieldContent>
                  </Field>
                </FieldGroup>
              </FieldSet>
              <FieldError>{editorError}</FieldError>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={(): void => { setEditorOpen(false); }}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving && <Spinner data-icon="inline-start" />}
                  {saving ? "Saving" : "Save variable"}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={attachOpen} onOpenChange={setAttachOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Attach variable set</DialogTitle>
            <DialogDescription>
              Attach a variable set from {orgName}. Its variables are inherited by this workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {attachError !== "" && (
              <p role="alert" className="text-sm text-destructive">{attachError}</p>
            )}
            {attachSetsLoading && (
              <p className="text-sm text-muted-foreground">Loading organization variable sets…</p>
            )}
            {!attachSetsLoading && allSets.length === 0 && attachError === "" && (
              <p className="text-sm text-muted-foreground">
                No variable sets exist in this organization.
              </p>
            )}
            {allSets.length > 0 && unattachedSets.length === 0 && (
              <p className="text-sm text-muted-foreground">
                All variable sets in this organization are already attached.
              </p>
            )}
            {unattachedSets.map((set: VariableSet): React.JSX.Element => (
              <div key={set.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{set.attributes.name}</span>
                    {set.attributes.global && <Badge variant="secondary">Global</Badge>}
                  </div>
                  {set.attributes.description !== null && set.attributes.description !== "" && (
                    <p className="truncate text-xs text-muted-foreground">{set.attributes.description}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {set.attributes["var-count"]} variable{set.attributes["var-count"] === 1 ? "" : "s"}
                    {set.attributes["workspace-count"] > 0 && (
                      <> · {set.attributes["workspace-count"]} workspace{set.attributes["workspace-count"] === 1 ? "" : "s"} attached</>
                    )}
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={busySetId === set.id}
                  onClick={(): void => { void attachSet(set); }}
                >
                  {busySetId === set.id && <Spinner data-icon="inline-start" />}
                  Attach
                </Button>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={(): void => { setAttachOpen(false); }}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open): void => { if (!open) setPendingDelete(null); }}
        title="Delete variable?"
        description={pendingDelete === null ? undefined : (
          <>
            Variable <strong className="font-mono">{pendingDelete.attributes.key}</strong> will stop
            reaching runs in this workspace.
            {pendingDelete.attributes.sensitive
              ? " Its value is write-only and cannot be recovered — re-enter it if anything still needs it."
              : ""}
          </>
        )}
        confirmText="Delete variable"
        confirmVariant="destructive"
        requireText={pendingDelete !== null && pendingDelete.attributes.sensitive ? pendingDelete.attributes.key : undefined}
        requireTextLabel={pendingDelete !== null && pendingDelete.attributes.sensitive ? `Type ${pendingDelete.attributes.key} to delete this sensitive variable` : undefined}
        onConfirm={(): void => { if (pendingDelete !== null) void deleteVariable(pendingDelete); }}
      />
    </>
  );
}
