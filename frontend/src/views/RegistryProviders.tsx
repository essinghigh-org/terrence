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
import { Select, SelectItem } from "../components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useOrganizationPermissions } from "../hooks/useOrganizationPermissions";
import { Boxes, Plus, Trash2 } from "lucide-react";

type RegistryProvider = {
  id: string;
  attributes: {
    name: string;
    namespace: string;
    "registry-name"?: string;
    "created-at"?: string;
  };
};

const REGISTRY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "private", label: "private" },
  { value: "public", label: "public" },
];

export function RegistryProviders(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [providers, setProviders] = useState<RegistryProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const orgPermissions = useOrganizationPermissions(orgName === "" ? undefined : orgName);
  const canManage = orgName !== "" && orgPermissions.loaded && orgPermissions.has("can-manage-providers");

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("");
  const [registryName, setRegistryName] = useState("private");
  const [providerToDelete, setProviderToDelete] = useState<RegistryProvider | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect((): void => {
    setProviders([]);
    setCreateDialogOpen(false);
    setProviderToDelete(null);
    permissionGateFired.current = false;
  }, [orgName]);

  // Central permission gate (14.6): once org permissions load, surface a clear
  // error when the operator lacks access. When access is granted, load the data
  // exactly once (the initial call early-returns while permissions are loading).
  const permissionGateFired = useRef(false);
  useEffect((): void => {
    if (!orgPermissions.loaded) return;
    if (orgPermissions.has("can-manage-providers")) {
      setError("");
      if (!permissionGateFired.current) {
        permissionGateFired.current = true;
        void loadProviders();
      }
    } else {
      setError(orgPermissions.error ?? "You do not have permission to manage registry providers for this organization.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgPermissions.loaded, orgPermissions.has]);

  const loadProviders = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    if (!canManage) {
      setLoading(false);
      return;
    }
    try {
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}/registry-providers`,
      ) as { data: RegistryProvider[] };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setProviders(response.data);
    } catch (reason) {
      if (activeOrganizationName.current === requestedOrganizationName) {
        setError(reason instanceof Error ? reason.message : "Failed to load registry providers.");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  };

  const createProvider = async (): Promise<void> => {
    if (name.trim() === "") {
      setFormError("Name is required.");
      return;
    }
    setCreating(true);
    setFormError("");
    try {
      await fetchApi(`/organizations/${encodeURIComponent(orgName)}/registry-providers`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "registry-providers",
            attributes: {
              name: name.trim(),
              namespace: namespace.trim() === "" ? orgName : namespace.trim(),
              "registry-name": registryName,
            },
          },
        }),
      });
      setCreateDialogOpen(false);
      setName("");
      setNamespace("");
      setRegistryName("private");
      await loadProviders();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Failed to create registry provider.");
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (providerToDelete === null) return;
    setDeleting(true);
    try {
      await fetchApi(`/registry-providers/${providerToDelete.id}`, { method: "DELETE" });
      setProviders((prev): RegistryProvider[] => prev.filter((p): boolean => p.id !== providerToDelete.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to delete registry provider.");
    } finally {
      setDeleting(false);
      setProviderToDelete(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Registry providers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Private registry providers available to Terraform runs in this organization.
          </p>
        </div>
        {canManage && (
          <Button onClick={(): void => { setCreateDialogOpen(true); }}>
            <Plus className="mr-2 h-4 w-4" />
            Add provider
          </Button>
        )}
      </div>

      <Card>
        <CardContent>
          {loading ? (
            <TableSkeleton rows={4} cols={4} />
          ) : error !== "" ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{error}</div>
          ) : providers.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
              <Boxes className="h-8 w-8" />
              <p className="text-sm">No registry providers.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Namespace</TableHead>
                  <TableHead>Registry</TableHead>
                  <TableHead>Created at</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((provider): React.JSX.Element => (
                  <TableRow key={provider.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Boxes className="h-4 w-4 text-muted-foreground" />
                        {provider.attributes.name}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{provider.attributes.namespace}</TableCell>
                    <TableCell>
                      <Badge variant={provider.attributes["registry-name"] === "public" ? "default" : "secondary"}>
                        {provider.attributes["registry-name"] ?? "private"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(provider.attributes["created-at"], "")}
                    </TableCell>
                    <TableCell>
                      {canManage && (
                        <Button variant="ghost" size="icon" onClick={(): void => { setProviderToDelete(provider); }} aria-label={`Delete ${provider.attributes.name}`}>
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
            <DialogTitle>Add provider</DialogTitle>
            <DialogDescription>
              Add a private registry provider for use by Terraform runs in this organization.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="registry-provider-name">Name</label>
              <Input id="registry-provider-name" value={name} onChange={(e): void => { setName(e.target.value); }} placeholder="my-provider" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="registry-provider-namespace">Namespace</label>
              <Input id="registry-provider-namespace" value={namespace} onChange={(e): void => { setNamespace(e.target.value); }} placeholder={orgName} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Registry name</label>
              <Select value={registryName} onValueChange={setRegistryName}>
                {REGISTRY_OPTIONS.map((option): React.JSX.Element => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </Select>
            </div>
            {formError !== "" && <div className="text-sm text-red-500">{formError}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={(): void => { setCreateDialogOpen(false); }}>Cancel</Button>
            <Button onClick={createProvider} disabled={creating}>
              {creating ? <Spinner /> : "Create provider"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={providerToDelete !== null}
        onOpenChange={(open): void => { if (!open) setProviderToDelete(null); }}
        title="Delete registry provider"
        description={`Are you sure you want to delete provider "${providerToDelete === null ? "" : providerToDelete.attributes.name}"? Any published providers from this registry will be removed. This cannot be undone.`}
        confirmText="Delete"
        confirmVariant="destructive"
        requireText={providerToDelete === null ? undefined : providerToDelete.attributes.name}
        loading={deleting}
        onConfirm={confirmDelete}
      />
    </div>
  );
}