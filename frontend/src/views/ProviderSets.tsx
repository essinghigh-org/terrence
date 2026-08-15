import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useOrganizationPermissions } from "../hooks/useOrganizationPermissions";
import { Boxes, Plus, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

type ProviderSet = {
  id: string;
  attributes: {
    name: string;
    description?: string | null;
    "provider-source": string;
    global?: boolean;
    "configuration-hcl"?: string | null;
  };
};

export function ProviderSets(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [sets, setSets] = useState<ProviderSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const orgPermissions = useOrganizationPermissions(orgName === "" ? undefined : orgName);
  const canManage = orgName !== "" && orgPermissions.loaded && orgPermissions.has("can-manage-policies");

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [providerSource, setProviderSource] = useState("registry.terraform.io/hashicorp/aws");
  const [global, setGlobal] = useState(true);
  const [setToDelete, setSetToDelete] = useState<ProviderSet | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect((): void => {
    setSets([]);
    setCreateDialogOpen(false);
    permissionGateFired.current = false;
  }, [orgName]);

  // Central permission gate (14.6): once org permissions load, surface a clear
  // error when the operator lacks access. When access is granted, load the data
  // exactly once (the initial call early-returns while permissions are loading).
  const permissionGateFired = useRef(false);
  useEffect((): void => {
    if (!orgPermissions.loaded) return;
    if (orgPermissions.has("can-manage-policies")) {
      setError("");
      if (!permissionGateFired.current) {
        permissionGateFired.current = true;
        void loadProviderSets();
      }
    } else {
      setError(orgPermissions.error ?? "You do not have permission to manage provider sets for this organization.");
    }
  }, [orgPermissions.loaded, orgPermissions.has]);

  const loadProviderSets = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    if (!canManage) {
      setLoading(false);
      return;
    }
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}/provider-sets`,
      ) as { data: ProviderSet[] };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setSets(response.data);
    } catch (reason) {
      if (activeOrganizationName.current === requestedOrganizationName) {
        setError(reason instanceof Error ? reason.message : "Failed to load provider sets.");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  };

  const createProviderSet = async (): Promise<void> => {
    if (name.trim() === "" || providerSource.trim() === "") {
      setFormError("Name and provider source are required.");
      return;
    }
    setCreating(true);
    setFormError("");
    try {
      await fetchApi(`/organizations/${encodeURIComponent(orgName)}/provider-sets`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "provider-sets",
            attributes: {
              name: name.trim(),
              description: description.trim() === "" ? null : description.trim(),
              "provider-source": providerSource.trim(),
              global,
              "configuration-hcl": "",
            },
          },
        }),
      });
      setCreateDialogOpen(false);
      setName("");
      setDescription("");
      await loadProviderSets();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Failed to create provider set.");
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (setToDelete === null) return;
    setDeleting(true);
    try {
      await fetchApi(`/provider-sets/${setToDelete.id}`, { method: "DELETE" });
      setSets((prev): ProviderSet[] => prev.filter((s): boolean => s.id !== setToDelete.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to delete provider set.");
    } finally {
      setDeleting(false);
      setSetToDelete(null);
    }
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow={`${orgName} / Settings`}
        title="Provider sets"
        description="Provider sets let Terraform workers fetch provider binaries from a specified provider source."
        action={canManage ? (
          <Button onClick={(): void => { setCreateDialogOpen(true); }}>
            <Plus className="mr-2 h-4 w-4" />
            Add provider set
          </Button>
        ) : undefined}
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Provider source</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-32 text-center">
                    <TableSkeleton rows={4} cols={4} />
                  </TableCell>
                </TableRow>
              ) : error !== "" ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-32 text-center text-sm text-muted-foreground">{error}</TableCell>
                </TableRow>
              ) : sets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Boxes className="h-8 w-8 text-muted-foreground/60" />
                      <p className="text-sm">No provider sets configured.</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : sets.map((set): React.JSX.Element => (
                <TableRow key={set.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <Boxes className="h-4 w-4 text-muted-foreground" />
                      {set.attributes.name}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{set.attributes["provider-source"]}</TableCell>
                  <TableCell>
                    <Badge variant={set.attributes.global === true ? "default" : "secondary"}>
                      {set.attributes.global === true ? "Global" : "Selective"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {canManage && (
                      <Button variant="ghost" size="icon" onClick={(): void => { setSetToDelete(set); }} aria-label={`Delete ${set.attributes.name}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add provider set</DialogTitle>
            <DialogDescription>
              Provider sets let Terraform workers fetch provider binaries from the specified source.
            </DialogDescription>
          </DialogHeader>
          <form id="provider-set-create-form" onSubmit={(event): void => { event.preventDefault(); void createProviderSet(); }} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="provider-set-name">Name</label>
              <Input id="provider-set-name" name="provider-set-name" autoComplete="off" spellCheck={false} value={name} onChange={(e): void => { setName(e.target.value); }} placeholder="my-provider-set" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="provider-set-source">Provider source</label>
              <Input id="provider-set-source" name="provider-source" autoComplete="off" spellCheck={false} value={providerSource} onChange={(e): void => { setProviderSource(e.target.value); }} placeholder="registry.terraform.io/hashicorp/aws" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="provider-set-description">Description</label>
              <Input id="provider-set-description" name="provider-set-description" autoComplete="off" value={description} onChange={(e): void => { setDescription(e.target.value); }} placeholder="Optional description…" />
            </div>
            <label className="flex cursor-pointer items-center justify-between rounded-md border p-3 text-sm transition-colors hover:bg-muted/40" htmlFor="provider-set-global">
              <span>
                <div className="font-medium">Use in all runs</div>
                <div className="text-muted-foreground">When enabled, applies the provider set to every run in the organization.</div>
              </span>
              <Checkbox id="provider-set-global" checked={global} onCheckedChange={(checked: boolean | "indeterminate"): void => { setGlobal(checked === true); }} aria-label="Use provider set in all runs" />
            </label>
            {formError !== "" && <div role="alert" className="text-sm text-destructive">{formError}</div>}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={(): void => { setCreateDialogOpen(false); }}>Cancel</Button>
            <Button type="submit" form="provider-set-create-form" disabled={creating}>
              {creating && <Spinner data-icon="inline-start" />}
              {creating ? "Creating provider set…" : "Create provider set"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={setToDelete !== null}
        onOpenChange={(open): void => { if (!open) setSetToDelete(null); }}
        title="Delete provider set"
        description={`Are you sure you want to delete provider set "${setToDelete === null ? "" : setToDelete.attributes.name}"? Workspaces referencing it will no longer resolve its providers. This cannot be undone.`}
        confirmText="Delete"
        confirmVariant="destructive"
        requireText={setToDelete === null ? undefined : setToDelete.attributes.name}
        loading={deleting}
        onConfirm={confirmDelete}
      />
    </PageShell>
  );
}
