import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Spinner } from "../components/ui/spinner";
import { Select, SelectItem } from "../components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Fingerprint, Plus, Trash2 } from "lucide-react";

type OidcConfig = {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
};

const TYPE_LABELS: Readonly<Record<string, string>> = {
  "aws-oidc-configurations": "AWS",
  "azure-oidc-configurations": "Azure",
  "gcp-oidc-configurations": "GCP",
  "vault-oidc-configurations": "Vault",
};

function displayValue(config: OidcConfig): string {
  const attrs = config.attributes;
  const candidates = ["role-arn", "workload-identity-provider-id", "identity", "address"];
  for (const key of candidates) {
    const value = attrs[key];
    if (typeof value === "string") return value;
  }
  return config.id;
}

export function OidcConfigurations(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [configs, setConfigs] = useState<OidcConfig[]>([]);
  const [manageableOrganizationName, setManageableOrganizationName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const canManage = orgName !== "" && manageableOrganizationName === orgName;

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");
  const [configType, setConfigType] = useState("aws-oidc-configurations");
  const [roleArn, setRoleArn] = useState("");
  const [identity, setIdentity] = useState("");
  const [address, setAddress] = useState("");
  const [namespace, setNamespace] = useState("");
  const [configToDelete, setConfigToDelete] = useState<OidcConfig | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect((): void => {
    setConfigs([]);
    setManageableOrganizationName("");
    setCreateDialogOpen(false);
    if (orgName !== "") void loadConfigs();
  }, [orgName]);

  const loadConfigs = async (): Promise<void> => {
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
        setError("You do not have permission to manage OIDC configurations for this organization.");
        setLoading(false);
        return;
      }
      setManageableOrganizationName(requestedOrganizationName);
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}/oidc-configurations`,
      ) as { data: OidcConfig[] };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setConfigs(response.data);
    } catch (reason) {
      if (activeOrganizationName.current === requestedOrganizationName) {
        setError(reason instanceof Error ? reason.message : "Failed to load OIDC configurations.");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  };

  const buildAttributes = (): Record<string, string> => {
    switch (configType) {
      case "aws-oidc-configurations":
        return { "role-arn": roleArn.trim() };
      case "azure-oidc-configurations":
        return { identity: identity.trim() };
      case "gcp-oidc-configurations":
        return { "workload-identity-provider-id": identity.trim() };
      case "vault-oidc-configurations":
        return { address: address.trim(), namespace: namespace.trim() === "" ? "admin" : namespace.trim() };
      default:
        return {};
    }
  };

  const createConfig = async (): Promise<void> => {
    const attributes = buildAttributes();
    if (Object.values(attributes).some((v): boolean => v === "")) {
      setFormError("All fields for the selected provider type are required.");
      return;
    }
    setCreating(true);
    setFormError("");
    try {
      await fetchApi(`/organizations/${encodeURIComponent(orgName)}/oidc-configurations`, {
        method: "POST",
        body: JSON.stringify({ data: { type: configType, attributes } }),
      });
      setCreateDialogOpen(false);
      setRoleArn("");
      setIdentity("");
      setAddress("");
      setNamespace("");
      await loadConfigs();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Failed to create OIDC configuration.");
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (configToDelete === null) return;
    setDeleting(true);
    try {
      await fetchApi(`/oidc-configurations/${configToDelete.id}`, { method: "DELETE" });
      setConfigs((prev): OidcConfig[] => prev.filter((c): boolean => c.id !== configToDelete.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to delete OIDC configuration.");
    } finally {
      setDeleting(false);
      setConfigToDelete(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">OIDC configurations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Identity provider configurations used by the organization&apos;s runs to authenticate with cloud providers.
          </p>
        </div>
        {canManage && (
          <Button onClick={(): void => { setCreateDialogOpen(true); }}>
            <Plus className="mr-2 h-4 w-4" />
            Add configuration
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
          ) : configs.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
              <Fingerprint className="h-8 w-8" />
              <p className="text-sm">No OIDC configurations.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Configuration</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {configs.map((config): React.JSX.Element => (
                  <TableRow key={config.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Fingerprint className="h-4 w-4 text-muted-foreground" />
                        {TYPE_LABELS[config.type] ?? config.type}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{displayValue(config)}</TableCell>
                    <TableCell>
                      {canManage && (
                        <Button variant="ghost" size="icon" onClick={(): void => { setConfigToDelete(config); }} aria-label="Delete configuration">
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
            <DialogTitle>Add OIDC configuration</DialogTitle>
            <DialogDescription>
              Configure the identity provider credentials for this organization.
            </DialogDescription>
          </DialogHeader>
          <form id="oidc-create-form" onSubmit={(event): void => { event.preventDefault(); void createConfig(); }} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="oidc-provider-type">Provider</label>
              <Select id="oidc-provider-type" value={configType} onValueChange={setConfigType}>
                {Object.entries(TYPE_LABELS).map(([value, label]): React.JSX.Element => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </Select>
            </div>
            {configType === "aws-oidc-configurations" && (
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="oidc-role-arn">Role ARN</label>
                <Input id="oidc-role-arn" value={roleArn} onChange={(e): void => { setRoleArn(e.target.value); }} placeholder="arn:aws:iam::123456789012:role/my-role" />
              </div>
            )}
            {(configType === "azure-oidc-configurations" || configType === "gcp-oidc-configurations") && (
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="oidc-identity">
                  {configType === "azure-oidc-configurations" ? "Identity (client ID)" : "Workload identity provider ID"}
                </label>
                <Input id="oidc-identity" value={identity} onChange={(e): void => { setIdentity(e.target.value); }} placeholder={configType === "azure-oidc-configurations" ? "client-id" : "projects/123/locations/global/workloadIdentityPools/pool/providers/provider"} />
              </div>
            )}
            {configType === "vault-oidc-configurations" && (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="oidc-address">Address</label>
                  <Input id="oidc-address" value={address} onChange={(e): void => { setAddress(e.target.value); }} placeholder="https://vault.example.com" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="oidc-namespace">Namespace</label>
                  <Input id="oidc-namespace" value={namespace} onChange={(e): void => { setNamespace(e.target.value); }} placeholder="admin" />
                </div>
              </>
            )}
            {formError !== "" && <div className="text-sm text-red-500">{formError}</div>}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={(): void => { setCreateDialogOpen(false); }}>Cancel</Button>
            <Button type="submit" form="oidc-create-form" disabled={creating}>
              {creating ? <Spinner /> : "Create configuration"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={configToDelete !== null}
        onOpenChange={(open): void => { if (!open) setConfigToDelete(null); }}
        title="Delete OIDC configuration"
        description="Are you sure you want to delete this OIDC configuration? Runs that depend on it may fail."
        confirmText="Delete"
        confirmVariant="destructive"
        loading={deleting}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
