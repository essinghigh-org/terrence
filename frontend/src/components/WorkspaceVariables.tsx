import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchApi } from "@/lib/api";

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

const messageFrom = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export function WorkspaceVariables({
  workspaceId,
  canUpdate,
}: Readonly<{
  workspaceId: string;
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

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setPageError("");

    fetchApi(`/workspaces/${workspaceId}/vars?page[size]=100`)
      .then((response: unknown): void => {
        if (!active) return;
        const data = (response as { data?: WorkspaceVariable[] }).data;
        setVariables(Array.isArray(data) ? data : []);
      })
      .catch((error: unknown): void => {
        if (active) setPageError(messageFrom(error, "Failed to load workspace variables"));
      })
      .finally((): void => {
        if (active) setLoading(false);
      });

    return (): void => {
      active = false;
    };
  }, [workspaceId]);

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

    const attributes: Record<string, unknown> = {
      key: key.trim(),
      category,
      sensitive,
      hcl,
      description: description.trim() === "" ? null : description.trim(),
    };
    if (editing?.attributes.sensitive !== true || value !== "") attributes["value"] = value;

    setSaving(true);
    setEditorError("");
    try {
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
    if (!window.confirm(`Delete variable "${variable.attributes.key}"?`)) return;
    setPageError("");
    try {
      await fetchApi(`/workspaces/${workspaceId}/vars/${variable.id}`, { method: "DELETE" });
      setVariables((current: WorkspaceVariable[]): WorkspaceVariable[] =>
        current.filter((item: WorkspaceVariable): boolean => item.id !== variable.id),
      );
    } catch (error: unknown) {
      setPageError(messageFrom(error, "Failed to delete variable"));
    }
  };

  return (
    <>
      <Card className="max-w-5xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Workspace variables
            <Badge variant="secondary">{variables.length}</Badge>
          </CardTitle>
          <CardDescription>
            Terraform and environment variables defined here override matching values from variable sets.
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
            <Table>
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
                    <TableCell className="font-mono font-medium">
                      <div className="flex items-center gap-2">
                        {variable.attributes.key}
                        {variable.attributes.sensitive && <Badge variant="secondary">Sensitive</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-48 truncate font-mono text-xs">
                      {variable.attributes.sensitive ? "Sensitive — write only" : variable.attributes.value ?? "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">
                          {variable.attributes.category === "env" ? "Environment" : "Terraform"}
                        </Badge>
                        {variable.attributes.hcl && <Badge variant="secondary">HCL</Badge>}
                      </div>
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
                          onClick={(): void => { void deleteVariable(variable); }}
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
                  value={category}
                  onValueChange={(next: string): void => { setCategory(next as VariableCategory); }}
                >
                  <SelectItem value="terraform">Terraform</SelectItem>
                  <SelectItem value="env">Environment</SelectItem>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="workspace-variable-description">Description</FieldLabel>
                <Input
                  id="workspace-variable-description"
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
    </>
  );
}
