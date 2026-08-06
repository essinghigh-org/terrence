import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Boxes, Plus, Trash2 } from "lucide-react";

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
  const [manageableOrganizationName, setManageableOrganizationName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const canManage = orgName !== "" && manageableOrganizationName === orgName;

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
    setManageableOrganizationName("");
    setCreateDialogOpen(false);
    if (orgName !== "") void loadProviderSets();
  }, [orgName]);

  const loadProviderSets = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    try {
      const organizationResponse = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}`,
      ) as {
        data?: { attributes?: { permissions?: { "can-manage-policies"?: boolean } } };
      };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      const permissions = organizationResponse.data?.attributes?.permissions;
      if (permissions?.["can-manage-policies"] !== true) {
        setError("You do not have permission to manage provider sets for this organization.");
        setLoading(false);
        return;
      }
      setManageableOrganizationName(requestedOrganizationName);
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
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Provider sets</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Provider sets let Terraform workers fetch provider binaries from a specified provider source.
          </p>
        </div>
        {canManage && (
          <Button onClick={(): void => { setCreateDialogOpen(true); }}>
            <Plus className="mr-2 h-4 w-4" />
            Add provider set
          </Button>
        )}
      </div>

      <Card>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : error !== "" ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{error}</div>
          ) : sets.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
              <Boxes className="h-8 w-8" />
              <p className="text-sm">No provider sets configured.</p>
            </div>
          ) : (
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
                {sets.map((set): React.JSX.Element => (
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
          )}
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
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="provider-set-name">Name</label>
              <Input id="provider-set-name" value={name} onChange={(e): void => { setName(e.target.value); }} placeholder="my-provider-set" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="provider-set-source">Provider source</label>
              <Input id="provider-set-source" value={providerSource} onChange={(e): void => { setProviderSource(e.target.value); }} placeholder="registry.terraform.io/hashicorp/aws" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="provider-set-description">Description</label>
              <Input id="provider-set-description" value={description} onChange={(e): void => { setDescription(e.target.value); }} placeholder="Optional" />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <label className="text-sm" htmlFor="provider-set-global">
                <div className="font-medium">Use in all runs</div>
                <div className="text-muted-foreground">When enabled, applies the provider set to every run in the organization.</div>
              </label>
              <input id="provider-set-global" type="checkbox" className="h-4 w-4" checked={global} onChange={(e): void => { setGlobal(e.target.checked); }} />
            </div>
            {formError !== "" && <div className="text-sm text-red-500">{formError}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={(): void => { setCreateDialogOpen(false); }}>Cancel</Button>
            <Button onClick={createProviderSet} disabled={creating}>
              {creating ? <Spinner /> : "Create provider set"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={setToDelete !== null}
        onOpenChange={(open): void => { if (!open) setSetToDelete(null); }}
        title="Delete provider set"
        description={`Are you sure you want to delete "${setToDelete === null ? "" : setToDelete.attributes.name}"? This cannot be undone.`}
        confirmText="Delete"
        confirmVariant="destructive"
        loading={deleting}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
