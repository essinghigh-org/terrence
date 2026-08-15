import { useCallback, useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { toast } from "../components/ui/toast";
import { Plus, Trash2 } from "lucide-react";

type SshKey = Readonly<{
  id: string;
  type: "ssh-keys";
  attributes: Readonly<{ name: string }>;
}>;

export function OrganizationSshKeys({ orgName }: Readonly<{ orgName: string }>): React.JSX.Element {
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [toDelete, setToDelete] = useState<SshKey | null>(null);
  const [deleting, setDeleting] = useState(false);

  const path = `/organizations/${encodeURIComponent(orgName)}/ssh-keys`;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const response = await fetchApi(path) as { data?: SshKey[] };
      setKeys(Array.isArray(response.data) ? response.data : []);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not load SSH keys");
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect((): void => {
    void load();
  }, [load]);

  const openCreate = (): void => {
    setNewName("");
    setNewValue("");
    setFormError("");
    setDialogOpen(true);
  };

  const create = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (newName.trim() === "" || newValue.trim() === "") return;
    setSaving(true);
    setFormError("");
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi(path, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "ssh-keys",
            attributes: { name: newName.trim(), value: newValue.trim() },
          },
        }),
      }) as { data: SshKey };
      setKeys((current: SshKey[]): SshKey[] => [...current, response.data].sort((a, b): number => a.attributes.name.localeCompare(b.attributes.name)));
      setDialogOpen(false);
      toast.add({ title: "SSH key created", type: "success" });
    } catch (caught: unknown) {
      setFormError(caught instanceof Error ? caught.message : "Failed to create SSH key");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (toDelete === null) return;
    setDeleting(true);
    try {
      await fetchApi(`/ssh-keys/${toDelete.id}`, { method: "DELETE" });
      setKeys((current: SshKey[]): SshKey[] => current.filter((k): boolean => k.id !== toDelete.id));
      setToDelete(null);
      toast.add({ title: "SSH key deleted", type: "success" });
    } catch (caught: unknown) {
      toast.add({
        title: "Could not delete SSH key",
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
          <CardTitle>SSH Keys</CardTitle>
          <CardDescription>
            HCP Terraform uses these private SSH keys for downloading private Terraform modules
            with Git-based sources during a Terraform run. SSH keys for downloading modules are
            assigned per-workspace. Separately, SSH Keys for VCS Providers are added directly to
            each connection.
          </CardDescription>
        </div>
        <Button type="button" onClick={openCreate}>
          <Plus data-icon="inline-start" />
          Add a Private SSH key
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">Loading SSH keys…</p>
        ) : error !== "" ? (
          <div role="alert" className="px-5 py-8 text-center text-sm text-destructive">
            Could not load SSH keys: {error}
            <Button size="sm" variant="outline" className="ml-3" onClick={(): void => { void load(); }}>Try again</Button>
          </div>
        ) : keys.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">No SSH keys created yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key): React.JSX.Element => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.attributes.name}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${key.attributes.name}`}
                      onClick={(): void => { setToDelete(key); }}
                    >
                      <Trash2 />
                    </Button>
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
            <DialogTitle>Add a Private SSH key</DialogTitle>
            <DialogDescription>
              Generate a new key with <code className="text-xs bg-muted px-1 rounded">ssh-keygen -t rsa -m PEM</code>, and paste the private key.
              The contents should begin with <code className="text-xs bg-muted px-1 rounded">-----BEGIN RSA PRIVATE KEY-----</code>.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={create}>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="ssh-name" className="text-sm font-medium">Name</label>
                <Input id="ssh-name" name="ssh-key-name" autoComplete="off" spellCheck={false} value={newName} onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setNewName(event.currentTarget.value); }} placeholder="Example Key" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="ssh-value" className="text-sm font-medium">Private SSH Key</label>
                <textarea
                  id="ssh-value"
                  name="private-ssh-key"
                  autoComplete="off"
                  spellCheck={false}
                  value={newValue}
                  onInput={(event: React.SyntheticEvent<HTMLTextAreaElement>): void => { setNewValue(event.currentTarget.value); }}
                  placeholder={"-----BEGIN RSA PRIVATE KEY-----\n…"}
                  rows={6}
                  className="flex min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:border-primary disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                />
              </div>
              {formError !== "" && <p role="alert" className="text-sm text-destructive">{formError}</p>}
            </div>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={(): void => { setDialogOpen(false); }}>Cancel</Button>
              <Button type="submit" disabled={saving || newName.trim() === "" || newValue.trim() === ""}>
                {saving ? "Adding…" : "Add SSH key"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open: boolean): void => { if (!open) setToDelete(null); }}
        title={`Deleting SSH key ${toDelete?.attributes.name ?? ""}`}
        description="Any workspaces configured with this SSH key will no longer use it to download Terraform modules. This operation cannot be undone. Are you sure?"
        confirmText={deleting ? "Deleting…" : "Delete SSH key"}
        onConfirm={async (): Promise<void> => remove()}
      />
    </Card>
  );
}
