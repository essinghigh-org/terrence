import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, LockKeyhole, Plus, Unplug } from "lucide-react";
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

type VariableRowValue = WorkspaceVariable | VariableSetVariable;

type VariableCandidate = Readonly<{
  id: string;
  sourceId: string | null;
  sourceName: string;
  scope: "Workspace" | "Variable set";
  priority: boolean;
  variable: VariableRowValue;
}>;

// One row of the effective-values endpoint: the winning source per key, with
// the winning set named on inherited rows (issue #627).
type EffectiveVariable = {
  id: string;
  attributes: {
    key: string;
    category: VariableCategory;
    "variable-set-id"?: string;
    "variable-set-name"?: string;
  };
};

// Winning source per duplicated key, compared by set ID (CodeRabbit
// review): set names are not unique per organization, so two same-named
// sets must not both appear to win. Null ID means the workspace value won.
type WinnerInfo = Readonly<{ id: string | null; name: string }>;

const messageFrom = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

type SourceResolution = Readonly<{
  label: string;
  detail: string;
  effective: boolean;
  unknown: boolean;
}>;

function validateVariableForm(key: string, wasSensitive: boolean, sensitive: boolean, value: string): string | null {
  if (key.trim() === "") return "Key is required.";
  if (wasSensitive && !sensitive && value === "") {
    return "Enter a new value before making this sensitive variable visible.";
  }
  return null;
}

function variableSubmitAttributes(
  key: string,
  category: VariableCategory,
  sensitive: boolean,
  hcl: boolean,
  description: string,
  value: string,
  wasSensitive: boolean | undefined,
): Record<string, unknown> {
  return {
    key: key.trim(),
    category,
    sensitive,
    hcl,
    description: description.trim() === "" ? null : description.trim(),
    ...(wasSensitive !== true || value !== "" ? { value } : undefined),
  };
}

async function persistWorkspaceVariable(
  workspaceId: string,
  editing: WorkspaceVariable | null,
  attributes: Readonly<Record<string, unknown>>,
): Promise<WorkspaceVariable> {
  // SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
  const response = await fetchApi(
    `/workspaces/${workspaceId}/vars${editing == null ? "" : `/${editing.id}`}`,
    {
      method: editing == null ? "POST" : "PATCH",
      body: JSON.stringify({ data: { type: "vars", attributes } }),
    },
  ) as { data: WorkspaceVariable };
  return response.data;
}

function candidateValue(candidate: VariableCandidate): string {
  return candidate.variable.attributes.sensitive
    ? "Hidden (sensitive)"
    : candidate.variable.attributes.value ?? "null";
}

function VariableSourceCell({
  resolution,
  sourceName,
  sourceHref,
  priority,
}: Readonly<{
  resolution: SourceResolution;
  sourceName: string;
  sourceHref: string | undefined;
  priority: boolean;
}>): React.JSX.Element {
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={resolution.unknown ? "outline" : resolution.effective ? "success" : "warning"}>
          {resolution.label}
        </Badge>
        {sourceHref === undefined ? (
          <span className="text-xs text-muted-foreground">{sourceName}</span>
        ) : (
          <a
            className="text-xs text-primary hover:underline"
            href={sourceHref}
            aria-label={`Open variable set ${sourceName}`}
            title={sourceName}
          >
            {sourceName}
          </a>
        )}
        {priority && <Badge variant="secondary">Priority</Badge>}
      </div>
      <p className="mt-1 text-2xs text-muted-foreground">{resolution.detail}</p>
    </>
  );
}

function PrecedenceDetailsRow({
  rowId,
  columnCount,
  candidates,
  winner,
  isDuplicated,
}: Readonly<{
  rowId: string;
  columnCount: number;
  candidates: readonly VariableCandidate[];
  winner: WinnerInfo | undefined;
  isDuplicated: boolean;
}>): React.JSX.Element {
  return (
    <TableRow key={`${rowId}-details`}>
      <TableCell id={`${rowId}-precedence`} colSpan={columnCount} className="bg-muted/30 px-4 py-3">
        <div className="space-y-3 text-xs">
          <div>
            <p className="font-semibold text-foreground">Why is this value being used?</p>
            <p className="mt-1 text-muted-foreground">Candidates are ordered from lower to higher precedence: non-priority sets, workspace values, then priority sets. Sensitivity only controls visibility; it never changes the winner.</p>
          </div>
          {candidates.length === 0 ? (
            <p className="text-muted-foreground">No accessible candidates were returned. The effective source is unknown.</p>
          ) : (
            <ol className="space-y-1.5">
              {candidates.map((candidate, index): React.JSX.Element => {
                const knownWinner = winner !== undefined;
                const candidateEffective = knownWinner
                  ? winner.id === candidate.sourceId
                  : !isDuplicated && candidate.id === rowId;
                return (
                  <li key={candidate.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-border/70 bg-background px-2.5 py-2">
                    <span className="w-5 text-muted-foreground">{index + 1}.</span>
                    <span className="font-medium text-foreground">{candidate.sourceName}</span>
                    <span className="text-muted-foreground">{candidate.scope}{candidate.priority ? " · priority" : ""}</span>
                    {candidateEffective && <Badge variant="success">Effective</Badge>}
                    {!knownWinner && isDuplicated && <Badge variant="outline">Unable to verify</Badge>}
                    <span className="ml-auto font-mono text-muted-foreground">{candidateValue(candidate)}</span>
                  </li>
                );
              })}
            </ol>
          )}
          <p className="text-muted-foreground">The server resolver supplies the effective input used by the next run. Attachment or priority changes recalculate this table after the save completes.</p>
        </div>
      </TableCell>
    </TableRow>
  );
}

function VariableEditorDialog({
  editorOpen,
  onEditorOpenChange,
  editing,
  variableKey,
  onKeyChange,
  variableValue,
  onValueChange,
  category,
  onCategoryChange,
  description,
  onDescriptionChange,
  sensitive,
  onSensitiveChange,
  hcl,
  onHclChange,
  editorError,
  saving,
  onSubmit,
  onCancel,
}: Readonly<{
  editorOpen: boolean;
  onEditorOpenChange: (open: boolean) => void;
  editing: WorkspaceVariable | null;
  variableKey: string;
  onKeyChange: (value: string) => void;
  variableValue: string;
  onValueChange: (value: string) => void;
  category: VariableCategory;
  onCategoryChange: (value: VariableCategory) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  sensitive: boolean;
  onSensitiveChange: (checked: boolean) => void;
  hcl: boolean;
  onHclChange: (checked: boolean) => void;
  editorError: string;
  saving: boolean;
  onSubmit: (event: React.SyntheticEvent) => void;
  onCancel: () => void;
}>): React.JSX.Element {
  return (
    <Dialog open={editorOpen} onOpenChange={onEditorOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing == null ? "Add variable" : "Edit variable"}</DialogTitle>
          <DialogDescription>
            Configure a Terraform input or environment variable for this workspace.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={editorError !== "" && variableKey.trim() === ""}>
              <FieldLabel htmlFor="workspace-variable-key">Key</FieldLabel>
              <Input
                id="workspace-variable-key"
                name="variable-key"
                autoComplete="off"
                spellCheck={false}
                value={variableKey}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { onKeyChange(event.target.value); }}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onKeyChange(event.currentTarget.value); }}
                aria-invalid={editorError !== "" && variableKey.trim() === ""}
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
                value={variableValue}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { onValueChange(event.target.value); }}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onValueChange(event.currentTarget.value); }}
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

                  onCategoryChange(next as VariableCategory);

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
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { onDescriptionChange(event.target.value); }}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { onDescriptionChange(event.currentTarget.value); }}
              />
            </Field>
            <FieldSet>
              <FieldLegend variant="label">Options</FieldLegend>
              <FieldGroup className="gap-3">
                <Field orientation="horizontal">
                  <Checkbox
                    id="workspace-variable-sensitive"
                    checked={sensitive}
                    onCheckedChange={(checked: boolean): void => { onSensitiveChange(checked); }}
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
                    onCheckedChange={(checked: boolean): void => { onHclChange(checked); }}
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
              <Button type="button" variant="outline" onClick={onCancel}>
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
  );
}

function AttachSetDialog({
  attachOpen,
  onAttachOpenChange,
  orgName,
  attachError,
  attachSetsLoading,
  allSetsCount,
  unattachedSets,
  busySetId,
  onAttach,
  onClose,
}: Readonly<{
  attachOpen: boolean;
  onAttachOpenChange: (open: boolean) => void;
  orgName: string;
  attachError: string;
  attachSetsLoading: boolean;
  allSetsCount: number;
  unattachedSets: readonly VariableSet[];
  busySetId: string | null;
  onAttach: (set: VariableSet) => void;
  onClose: () => void;
}>): React.JSX.Element {
  return (
    <Dialog open={attachOpen} onOpenChange={onAttachOpenChange}>
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
          {!attachSetsLoading && unattachedSets.length === 0 && attachError === "" && (
            <p className="text-sm text-muted-foreground">
              No variable sets exist in this organization.
            </p>
          )}
          {allSetsCount > 0 && unattachedSets.length === 0 && (
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
                onClick={(): void => { onAttach(set); }}
              >
                {busySetId === set.id && <Spinner data-icon="inline-start" />}
                Attach
              </Button>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteVariableDialog({
  pendingDelete,
  onOpenChange,
  onConfirm,
}: Readonly<{
  pendingDelete: WorkspaceVariable | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}>): React.JSX.Element {
  return (
    <ConfirmDialog
      open={pendingDelete !== null}
      onOpenChange={onOpenChange}
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
      requireText={pendingDelete?.attributes.sensitive === true ? pendingDelete.attributes.key : undefined}
      requireTextLabel={pendingDelete?.attributes.sensitive === true ? `Type ${pendingDelete.attributes.key} to delete this sensitive variable` : undefined}
      onConfirm={onConfirm}
    />
  );
}

type RenderVariableRow = (
  variable: VariableRowValue,
  sourceId: string | null,
  sourceName: string,
  scope: "Workspace" | "Variable set",
  priority: boolean,
) => React.JSX.Element[];

function variableEditorValue(variable: WorkspaceVariable | undefined): string {
  if (variable?.attributes.sensitive === true) return "";
  return variable?.attributes.value ?? "";
}

function variableEditorScalars(variable: WorkspaceVariable | undefined): Readonly<{
  key: string;
  category: VariableCategory;
  description: string;
  sensitive: boolean;
  hcl: boolean;
}> {
  return {
    key: variable?.attributes.key ?? "",
    category: variable?.attributes.category ?? "terraform",
    description: variable?.attributes.description ?? "",
    sensitive: variable?.attributes.sensitive ?? false,
    hcl: variable?.attributes.hcl ?? false,
  };
}

function VariableRowActions({
  expanded,
  rowId,
  variableKey,
  canUpdate,
  scope,
  onToggle,
  onEdit,
  onDelete,
}: Readonly<{
  expanded: boolean;
  rowId: string;
  variableKey: string;
  canUpdate: boolean;
  scope: "Workspace" | "Variable set";
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}>): React.JSX.Element {
  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-expanded={expanded}
        aria-controls={`${rowId}-precedence`}
        aria-label={`${expanded ? "Hide" : "Show"} precedence for ${variableKey}`}
        title="Explain precedence"
        onClick={onToggle}
      >
        <ChevronDown className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
        <span className="sr-only">{expanded ? "Hide" : "Show"} source details</span>
      </Button>
      {canUpdate && scope === "Workspace" && (
        <>
          <Button size="sm" variant="outline" onClick={onEdit}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={onDelete}
          >
            Delete
          </Button>
        </>
      )}
    </div>
  );
}

function WorkspaceVariablesCard({
  variables,
  loading,
  canUpdate,
  pageError,
  renderRow,
  onAdd,
}: Readonly<{
  variables: readonly WorkspaceVariable[];
  loading: boolean;
  canUpdate: boolean;
  pageError: string;
  renderRow: RenderVariableRow;
  onAdd: () => void;
}>): React.JSX.Element {
  return (
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
          <Button onClick={onAdd}>
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
                <TableHead>Effective source</TableHead>
                <TableHead>Description</TableHead>
                {canUpdate && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={canUpdate ? 6 : 5} className="h-20 text-center text-muted-foreground">
                    Loading variables…
                  </TableCell>
                </TableRow>
              )}
              {!loading && variables.flatMap((variable): React.JSX.Element[] => renderRow(variable, null, "Workspace", "Workspace", false))}
              {!loading && variables.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canUpdate ? 6 : 5} className="h-20 text-center text-muted-foreground">
                    No workspace variables have been added.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function VariableSetsCard({
  sets,
  setsVars,
  setsLoading,
  setsError,
  canUpdate,
  busySetId,
  onDetach,
  onOpenAttach,
  renderRow,
}: Readonly<{
  sets: readonly VariableSet[];
  setsVars: Readonly<Record<string, VariableSetVariable[]>>;
  setsLoading: boolean;
  setsError: string;
  canUpdate: boolean;
  busySetId: string | null;
  onDetach: (set: VariableSet) => void;
  onOpenAttach: () => void;
  renderRow: RenderVariableRow;
}>): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Variable sets
          <Badge variant="secondary">{sets.length}</Badge>
        </CardTitle>
        <CardDescription>
          Variable sets attached to this workspace. Inherited variables are read-only here and managed on the variable set itself; sensitive values remain hidden. Precedence is visible per row: non-priority sets, then workspace values, then priority sets; same-rank ties go to the alphabetically-first set name.
        </CardDescription>
        {canUpdate && <CardAction>
          <Button onClick={onOpenAttach}>
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
                      onClick={(): void => { onDetach(set); }}
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
                      <TableHead>Effective source</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inherited.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="h-12 text-center text-muted-foreground">
                          This variable set has no variables.
                        </TableCell>
                      </TableRow>
                    )}
                    {inherited.flatMap((variable): React.JSX.Element[] => renderRow(variable, set.id, set.attributes.name, "Variable set", set.attributes.priority))}
                  </TableBody>
                </Table>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

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
  const [winners, setWinners] = useState<ReadonlyMap<string, WinnerInfo>>(new Map());
  const [expandedVariable, setExpandedVariable] = useState<string | null>(null);

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
  // when the winner is unknown or this row is the only source. Identity is
  // by set ID (null for the workspace row); the name is display-only.
  const winnerTitle = (category: string, key: string, ownId: string | null): string | undefined => {
    if (!duplicatedKeys.has(category + ':' + key)) return undefined;
    const winner = winners.get(category + ':' + key);
    if (winner === undefined) return undefined;
    if (winner.id === ownId) return "Effective value for " + key + " (wins for this workspace)";
    const winnerLabel = winner.id === null ? "the workspace value" : "variable set " + JSON.stringify(winner.name);
    return "Overridden by " + winnerLabel + " for this workspace";
  };

  const candidateSources = (category: VariableCategory, variableKey: string): readonly VariableCandidate[] => {
    const candidates: VariableCandidate[] = [];
    for (const variable of variables) {
      if (variable.attributes.category === category && variable.attributes.key === variableKey) {
        candidates.push({
          id: `workspace:${variable.id}`,
          sourceId: null,
          sourceName: "Workspace",
          scope: "Workspace",
          priority: false,
          variable,
        });
      }
    }
    for (const set of sets) {
      for (const variable of setsVars[set.id] ?? []) {
        if (variable.attributes.category !== category || variable.attributes.key !== variableKey) continue;
        candidates.push({
          id: `set:${set.id}:${variable.id}`,
          sourceId: set.id,
          sourceName: set.attributes.name,
          scope: "Variable set",
          priority: set.attributes.priority,
          variable,
        });
      }
    }
    return candidates.sort((left, right): number => {
      const rank = (candidate: VariableCandidate): number => candidate.scope === "Workspace" ? 1 : candidate.priority ? 2 : 0;
      const rankDifference = rank(left) - rank(right);
      if (rankDifference !== 0) return rankDifference;
      const nameDifference = left.sourceName.localeCompare(right.sourceName);
      if (nameDifference !== 0) return nameDifference;
      return left.id.localeCompare(right.id);
    });
  };

  const sourceResolution = (category: VariableCategory, variableKey: string, sourceId: string | null): SourceResolution => {
    const mapKey = category + ':' + variableKey;
    const winner = winners.get(mapKey);
    const duplicate = duplicatedKeys.has(mapKey);
    if (winner === undefined && duplicate) {
      return { label: "Unable to verify", detail: "The effective source could not be verified for this duplicated key.", effective: false, unknown: true };
    }
    const effective = winner === undefined || winner.id === sourceId;
    return {
      label: effective ? "Effective" : "Overridden",
      detail: effective
        ? "This source supplies the value sent to the next run."
        : `The effective value comes from ${winner.id === null ? "the workspace" : `variable set ${JSON.stringify(winner.name)}`}.`,
      effective,
      unknown: false,
    };
  };

  // Generation guard: invalidated on unmount, workspaceId change, or a newer
  // attach/detach refresh so stale variable-set responses cannot update this view.
  const attachedLoadGeneration = useRef(0);

  // Winner metadata must refresh after every mutation that can change
  // precedence (CodeRabbit review): attach, detach, save, and delete all
  // re-resolve here so a stale map never marks a new winner as overridden.
  const reloadWinners = useCallback(async (signal?: Readonly<AbortSignal>): Promise<void> => {
    try {
      const data = await fetchAllApiPages<EffectiveVariable>(`/workspaces/${workspaceId}/all-vars?page[size]=100`, signal);
      if (signal?.aborted === true) return;
      const map = new Map<string, WinnerInfo>();
      for (const row of data) {
        const setId = row.attributes["variable-set-id"];
        map.set(row.attributes.category + ':' + row.attributes.key, {
          id: setId ?? null,
          name: row.attributes["variable-set-name"] ?? "Workspace",
        });
      }
      setWinners(map);
    } catch {
      if (signal?.aborted !== true) setWinners(new Map());
    }
  }, [workspaceId]);

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
    setWinners(new Map());
    setExpandedVariable(null);

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

    void reloadWinners(signal);

    loadAttachedSets();

    return (): void => {
      controller.abort();
      attachedLoadGeneration.current += 1;
    };
  }, [workspaceId, loadAttachedSets, reloadWinners]);

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
      void reloadWinners();
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
      void reloadWinners();
    } catch (error: unknown) {
      setSetsError(messageFrom(error, "Failed to detach variable set"));
    } finally {
      setBusySetId(null);
    }
  };

  const openEditor = (variable?: WorkspaceVariable): void => {
    if (!canUpdate) return;
    const scalars = variableEditorScalars(variable);
    setEditing(variable ?? null);
    setKey(scalars.key);
    setValue(variableEditorValue(variable));
    setCategory(scalars.category);
    setDescription(scalars.description);
    setSensitive(scalars.sensitive);
    setHcl(scalars.hcl);
    setEditorError("");
    setEditorOpen(true);
  };

  const saveVariable = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!canUpdate) return;
    const validationError = validateVariableForm(key, editing?.attributes.sensitive === true, sensitive, value);
    if (validationError !== null) {
      setEditorError(validationError);
      return;
    }
    const attributes = variableSubmitAttributes(key, category, sensitive, hcl, description, value, editing?.attributes.sensitive);

    setSaving(true);
    setEditorError("");
    try {
      const saved = await persistWorkspaceVariable(workspaceId, editing, attributes);
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
      void reloadWinners();
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
      void reloadWinners();
    } catch (error: unknown) {
      setPageError(messageFrom(error, "Failed to delete variable"));
    } finally {
      setPendingDelete(null);
    }
  };

  const handleDeleteOpenChange = (open: boolean): void => {
    if (!open) setPendingDelete(null);
  };

  const handleConfirmDeleteVariable = (): void => {
    if (pendingDelete !== null) void deleteVariable(pendingDelete);
  };

  const unattachedSets = allSets.filter(
    (set: VariableSet): boolean => !sets.some((attached: VariableSet): boolean => attached.id === set.id),
  );

  const renderVariableRow = (
    variable: VariableRowValue,
    sourceId: string | null,
    sourceName: string,
    scope: "Workspace" | "Variable set",
    priority: boolean,
  ): React.JSX.Element[] => {
    const category = variable.attributes.category;
    const variableKey = category + ":" + variable.attributes.key;
    const rowId = `${sourceId ?? "workspace"}:${variable.id}`;
    const resolution = sourceResolution(category, variable.attributes.key, sourceId);
    const candidates = candidateSources(category, variable.attributes.key);
    const expanded = expandedVariable === rowId;
    const columnCount = canUpdate ? 6 : 5;
    const sourceHref = scope === "Variable set" && sourceId !== null
      ? `/app/${encodeURIComponent(orgName)}/variable-sets`
      : undefined;
    const winner = winners.get(variableKey);
    const isDuplicated = duplicatedKeys.has(variableKey);
    return [
      <TableRow key={rowId} aria-selected={expanded}>
        <TableCell className="font-mono font-medium">
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
            {category === "env" ? "Environment" : "Terraform"}{variable.attributes.hcl ? " · HCL" : ""}
          </span>
        </TableCell>
        <TableCell className="min-w-40" title={winnerTitle(category, variable.attributes.key, sourceId)}>
          <VariableSourceCell resolution={resolution} sourceName={sourceName} sourceHref={sourceHref} priority={priority} />
        </TableCell>
        <TableCell className="max-w-48 truncate text-muted-foreground">
          {variable.attributes.description ?? "—"}
        </TableCell>
        <TableCell>
          <VariableRowActions
            expanded={expanded}
            rowId={rowId}
            variableKey={variable.attributes.key}
            canUpdate={canUpdate}
            scope={scope}
            onToggle={(): void => { setExpandedVariable(expanded ? null : rowId); }}
            onEdit={(): void => { openEditor(variable as WorkspaceVariable); }}
            onDelete={(): void => { setPendingDelete(variable as WorkspaceVariable); }}
          />
        </TableCell>
      </TableRow>,
      ...(expanded
        ? [<PrecedenceDetailsRow
            key={`${rowId}-details`}
            rowId={rowId}
            columnCount={columnCount}
            candidates={candidates}
            winner={winner}
            isDuplicated={isDuplicated}
          />]
        : []),
    ];
  };

  return (
    <>
      <div className="flex flex-col gap-6">
        <WorkspaceVariablesCard
          variables={variables}
          loading={loading}
          canUpdate={canUpdate}
          pageError={pageError}
          renderRow={renderVariableRow}
          onAdd={(): void => { openEditor(); }}
        />

        <VariableSetsCard
          sets={sets}
          setsVars={setsVars}
          setsLoading={setsLoading}
          setsError={setsError}
          canUpdate={canUpdate}
          busySetId={busySetId}
          onDetach={detachSet}
          onOpenAttach={openAttach}
          renderRow={renderVariableRow}
        />
      </div>

      <VariableEditorDialog
        editorOpen={editorOpen}
        onEditorOpenChange={setEditorOpen}
        editing={editing}
        variableKey={key}
        onKeyChange={setKey}
        variableValue={value}
        onValueChange={setValue}
        category={category}
        onCategoryChange={setCategory}
        description={description}
        onDescriptionChange={setDescription}
        sensitive={sensitive}
        onSensitiveChange={setSensitive}
        hcl={hcl}
        onHclChange={setHcl}
        editorError={editorError}
        saving={saving}
        onSubmit={saveVariable}
        onCancel={(): void => { setEditorOpen(false); }}
      />

      <AttachSetDialog
        attachOpen={attachOpen}
        onAttachOpenChange={setAttachOpen}
        orgName={orgName}
        attachError={attachError}
        attachSetsLoading={attachSetsLoading}
        allSetsCount={allSets.length}
        unattachedSets={unattachedSets}
        busySetId={busySetId}
        onAttach={attachSet}
        onClose={(): void => { setAttachOpen(false); }}
      />
      <DeleteVariableDialog
        pendingDelete={pendingDelete}
        onOpenChange={handleDeleteOpenChange}
        onConfirm={handleConfirmDeleteVariable}
      />
    </>
  );
}
