import { useCallback, useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import { formatDate } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { toast } from "../components/ui/toast";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Pencil, Plus, Trash2 } from "lucide-react";

type ReservedTagKey = Readonly<{
  id: string;
  attributes: Readonly<{
    key: string;
    "disable-overrides": boolean;
    "created-at": string;
  }>;
}>;

export function OrganizationTags({ orgName }: Readonly<{ orgName: string }>): React.JSX.Element {
  const [tags, setTags] = useState<ReservedTagKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ReservedTagKey | null>(null);
  const [key, setKey] = useState("");
  const [disableOverrides, setDisableOverrides] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [toDelete, setToDelete] = useState<ReservedTagKey | null>(null);
  const [deleting, setDeleting] = useState(false);

  const path = `/organizations/${encodeURIComponent(orgName)}/reserved-tag-keys`;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const response = await fetchApi(path) as { data?: ReservedTagKey[] };
      setTags(Array.isArray(response.data) ? response.data : []);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not load reserved tag keys");
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect((): void => {
    void load();
  }, [load]);

  const openCreate = (): void => {
    setEditing(null);
    setKey("");
    setDisableOverrides(false);
    setFormError("");
    setDialogOpen(true);
  };

  const openEdit = (tag: ReservedTagKey): void => {
    setEditing(tag);
    setKey(tag.attributes.key);
    setDisableOverrides(tag.attributes["disable-overrides"]);
    setFormError("");
    setDialogOpen(true);
  };

  const save = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (key.trim() === "") return;
    setSaving(true);
    setFormError("");
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi(
        editing !== null ? `/reserved-tags/${editing.id}` : path,
        {
          method: editing !== null ? "PATCH" : "POST",
          body: JSON.stringify({
            data: {
              type: "reserved-tag-keys",
              attributes: { key: key.trim(), "disable-overrides": disableOverrides },
            },
          }),
        },
      ) as { data?: ReservedTagKey };
      if (response.data !== undefined) {
        const saved = response.data;
        setTags((current: ReservedTagKey[]): ReservedTagKey[] =>
          editing !== null
            ? current.map((tag): ReservedTagKey => (tag.id === saved.id ? saved : tag))
            : [...current, saved].sort((a, b): number => a.attributes.key.localeCompare(b.attributes.key)),
        );
      }
      setDialogOpen(false);
      toast.add({ title: editing !== null ? "Reserved tag key updated" : "Reserved tag key created", type: "success" });
    } catch (caught: unknown) {
      setFormError(caught instanceof Error ? caught.message : "Failed to save reserved tag key");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (toDelete === null) return;
    setDeleting(true);
    try {
      await fetchApi(`/reserved-tags/${toDelete.id}`, { method: "DELETE" });
      setTags((current: ReservedTagKey[]): ReservedTagKey[] =>
        current.filter((tag): boolean => tag.id !== toDelete.id));
      setToDelete(null);
      toast.add({ title: "Reserved tag key deleted", type: "success" });
    } catch (caught: unknown) {
      toast.add({
        title: "Could not delete reserved tag key",
        description: caught instanceof Error ? caught.message : "Unknown error",
        type: "error",
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card>
      <CardHeader variant="section" className="flex flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>Tag management</CardTitle>
          <CardDescription>
            Manage reserved keys to standardize common tag key–value pairs across your projects and
            workspaces, and optionally prevent workspaces from overriding inherited tags.
          </CardDescription>
        </div>
        <Button type="button" onClick={openCreate}>
          <Plus data-icon="inline-start" />
          Create reserved tag key
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">Loading reserved tag keys…</p>
        ) : error !== "" ? (
          <div role="alert" className="px-5 py-8 text-center text-sm text-destructive">
            Could not load reserved tag keys: {error}
            <Button size="sm" variant="outline" className="ml-3" onClick={(): void => { void load(); }}>Try again</Button>
          </div>
        ) : tags.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            No reserved keys in this organization.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Overridable?</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tags.map((tag): React.JSX.Element => (
                <TableRow key={tag.id}>
                  <TableCell className="font-medium">{tag.attributes.key}</TableCell>
                  <TableCell>{tag.attributes["disable-overrides"] ? "No" : "Yes"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(tag.attributes["created-at"])}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${tag.attributes.key}`} onClick={(): void => { openEdit(tag); }}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${tag.attributes.key}`} onClick={(): void => { setToDelete(tag); }}>
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing !== null ? "Edit reserved tag key" : "Create reserved tag key"}</DialogTitle>
            <DialogDescription>
              Must be unique and between 1-128 characters, and made up only of letters, numbers, spaces,
              and the following special characters: .=+-@:_-
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={save}>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="rtk-key" className="text-sm font-medium">Key</label>
                <Input id="rtk-key" name="reserved-tag-key" autoComplete="off" spellCheck={false} value={key} onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setKey(event.currentTarget.value); }} placeholder="environment" />
              </div>
              <label className="flex items-start gap-3 text-sm font-medium">
                <Checkbox checked={disableOverrides} onCheckedChange={(checked: boolean): void => { setDisableOverrides(checked); }} />
                <span>
                  Disable overrides
                  <span className="block text-[13px] font-normal text-muted-foreground mt-0.5">Disables tag overrides for any tag matching this key.</span>
                </span>
              </label>
              {formError !== "" && <p role="alert" className="text-sm text-destructive">{formError}</p>}
            </div>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={(): void => { setDialogOpen(false); }}>Cancel</Button>
              <Button type="submit" disabled={saving || key.trim() === ""}>{saving ? "Saving…" : "Save"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open: boolean): void => { if (!open) setToDelete(null); }}
        title="Delete reserved tag key"
        description={`Delete the reserved key "${toDelete?.attributes.key ?? ""}"?`}
        confirmText={deleting ? "Deleting…" : "Delete key"}
        onConfirm={async (): Promise<void> => remove()}
      />
    </Card>
  );
}
