import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { formatDate } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PackageOpen, Plus, Trash2 } from "lucide-react";

type RegistryModule = {
  id: string;
  attributes: {
    name: string;
    provider?: string;
    namespace?: string;
    "registry-name"?: string;
    status?: string;
    "created-at"?: string;
  };
};

export function RegistryModules(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [modules, setModules] = useState<RegistryModule[]>([]);
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
  const [provider, setProvider] = useState("");
  const [namespace, setNamespace] = useState("");
  const [moduleToDelete, setModuleToDelete] = useState<RegistryModule | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect((): void => {
    setModules([]);
    setManageableOrganizationName("");
    setCreateDialogOpen(false);
    setModuleToDelete(null);
    if (orgName !== "") void loadModules();
  }, [orgName]);

  const loadModules = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    try {
      const organizationResponse = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}`,
      ) as {
        data?: { attributes?: { permissions?: { "can-manage-providers"?: boolean } } };
      };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      const permissions = organizationResponse.data?.attributes?.permissions;
      if (permissions?.["can-manage-providers"] !== true) {
        setError("You do not have permission to manage registry modules for this organization.");
        setLoading(false);
        return;
      }
      setManageableOrganizationName(requestedOrganizationName);
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}/registry-modules`,
      ) as { data: RegistryModule[] };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setModules(response.data);
    } catch (reason) {
      if (activeOrganizationName.current === requestedOrganizationName) {
        setError(reason instanceof Error ? reason.message : "Failed to load registry modules.");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  };

  const createModule = async (): Promise<void> => {
    if (name.trim() === "") {
      setFormError("Name is required.");
      return;
    }
    if (provider.trim() === "") {
      setFormError("Provider is required.");
      return;
    }
    setCreating(true);
    setFormError("");
    try {
      await fetchApi(`/organizations/${encodeURIComponent(orgName)}/registry-modules`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "registry-modules",
            attributes: {
              name: name.trim(),
              provider: provider.trim(),
              namespace: namespace.trim() === "" ? orgName : namespace.trim(),
            },
            relationships: {},
          },
        }),
      });
      setCreateDialogOpen(false);
      setName("");
      setProvider("");
      setNamespace("");
      await loadModules();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Failed to create registry module.");
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (moduleToDelete === null) return;
    setDeleting(true);
    try {
      await fetchApi(`/registry-modules/${moduleToDelete.id}`, { method: "DELETE" });
      setModules((prev): RegistryModule[] => prev.filter((m): boolean => m.id !== moduleToDelete.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to delete registry module.");
    } finally {
      setDeleting(false);
      setModuleToDelete(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Registry modules</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Private registry modules available to Terraform runs in this organization.
          </p>
        </div>
        {canManage && (
          <Button onClick={(): void => { setCreateDialogOpen(true); }}>
            <Plus className="mr-2 h-4 w-4" />
            New module
          </Button>
        )}
      </div>

      <Card>
        <CardContent>
          {loading ? (
            <TableSkeleton rows={4} cols={4} />
          ) : error !== "" ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{error}</div>
          ) : modules.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
              <PackageOpen className="h-8 w-8" />
              <p className="text-sm">No registry modules.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Module</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Namespace</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created at</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {modules.map((m): React.JSX.Element => (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <PackageOpen className="h-4 w-4 text-muted-foreground" />
                        {m.attributes.name}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{m.attributes.provider}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{m.attributes.namespace}</TableCell>
                    <TableCell>
                      <Badge variant={m.attributes.status === "available" ? "default" : "secondary"}>
                        {m.attributes.status ?? "available"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(m.attributes["created-at"], "")}
                    </TableCell>
                    <TableCell>
                      {canManage && (
                        <Button variant="ghost" size="icon" onClick={(): void => { setModuleToDelete(m); }} aria-label={`Delete ${m.attributes.name}`}>
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
            <DialogTitle>Add module</DialogTitle>
            <DialogDescription>
              Add a private registry module for use by Terraform runs in this organization.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="registry-module-name">Name</label>
              <Input id="registry-module-name" value={name} onChange={(e): void => { setName(e.target.value); }} placeholder="my-module" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="registry-module-provider">Provider</label>
              <Input id="registry-module-provider" value={provider} onChange={(e): void => { setProvider(e.target.value); }} placeholder="aws / azurerm / google" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="registry-module-namespace">Namespace</label>
              <Input id="registry-module-namespace" value={namespace} onChange={(e): void => { setNamespace(e.target.value); }} placeholder={orgName} />
            </div>
            {formError !== "" && <div className="text-sm text-red-500">{formError}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={(): void => { setCreateDialogOpen(false); }}>Cancel</Button>
            <Button onClick={createModule} disabled={creating}>
              {creating ? <Spinner /> : "Create module"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={moduleToDelete !== null}
        onOpenChange={(open): void => { if (!open) setModuleToDelete(null); }}
        title="Delete registry module"
        description={`Are you sure you want to delete module "${moduleToDelete === null ? "" : moduleToDelete.attributes.name}"? This cannot be undone.`}
        confirmText="Delete"
        confirmVariant="destructive"
        requireText={moduleToDelete === null ? undefined : moduleToDelete.attributes.name}
        loading={deleting}
        onConfirm={confirmDelete}
      />
    </div>
  );
}