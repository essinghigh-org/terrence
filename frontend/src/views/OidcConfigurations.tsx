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
import { useOrganizationPermissions } from "../hooks/useOrganizationPermissions";
import { Fingerprint, Plus, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

type OidcConfig = {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
};

const TYPE_LABELS = {
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const orgPermissions = useOrganizationPermissions(orgName === "" ? undefined : orgName);
  const canManage = orgName !== "" && orgPermissions.loaded && orgPermissions.has("can-manage-providers");

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
    setCreateDialogOpen(false);
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
        void loadConfigs();
      }
    } else {
      setError(orgPermissions.error ?? "You do not have permission to manage OIDC configurations for this organization.");
    }
  }, [orgPermissions.loaded, orgPermissions.has]);

  const loadConfigs = async (): Promise<void> => {
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

  const buildAttributes = () => {
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
    <PageShell>
      <PageHeader
        eyebrow={`${orgName} / Settings`}
        title="OIDC configurations"
        description="Identity provider configurations used by the organization&apos;s runs to authenticate with cloud providers."
        action={canManage ? (
          <Button onClick={(): void => { setCreateDialogOpen(true); }}>
            <Plus className="mr-2 h-4 w-4" />
            Add configuration
          </Button>
        ) : undefined}
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Configuration</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={3} className="h-32 text-center">
                    <div className="flex justify-center py-12">
                      <Spinner />
                    </div>
                  </TableCell>
                </TableRow>
              ) : error !== "" ? (
                <TableRow>
                  <TableCell colSpan={3} className="h-32 text-center text-sm text-muted-foreground">{error}</TableCell>
                </TableRow>
              ) : configs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="h-32 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Fingerprint className="h-8 w-8 text-muted-foreground/60" />
                      <p className="text-sm">No OIDC configurations.</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : configs.map((config): React.JSX.Element => {
                // SAFETY: unknown config types fall back to the raw type string.
                const typeLabel = TYPE_LABELS[config.type as keyof typeof TYPE_LABELS] ?? config.type;
                return (
                <TableRow key={config.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <Fingerprint className="h-4 w-4 text-muted-foreground" />
                      {typeLabel}
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
                );
              })}
            </TableBody>
          </Table>
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
              <Select id="oidc-provider-type" name="provider-type" value={configType} onValueChange={setConfigType}>
                {Object.entries(TYPE_LABELS).map(([value, label]): React.JSX.Element => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </Select>
            </div>
            {configType === "aws-oidc-configurations" && (
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="oidc-role-arn">Role ARN</label>
                <Input id="oidc-role-arn" name="role-arn" autoComplete="off" spellCheck={false} value={roleArn} onChange={(e): void => { setRoleArn(e.target.value); }} placeholder="arn:aws:iam::123456789012:role/my-role" />
              </div>
            )}
            {(configType === "azure-oidc-configurations" || configType === "gcp-oidc-configurations") && (
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="oidc-identity">
                  {configType === "azure-oidc-configurations" ? "Identity (client ID)" : "Workload identity provider ID"}
                </label>
                <Input id="oidc-identity" name="identity" autoComplete="off" spellCheck={false} value={identity} onChange={(e): void => { setIdentity(e.target.value); }} placeholder={configType === "azure-oidc-configurations" ? "client-id" : "projects/123/locations/global/workloadIdentityPools/pool/providers/provider"} />
              </div>
            )}
            {configType === "vault-oidc-configurations" && (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="oidc-address">Address</label>
                  <Input id="oidc-address" name="vault-address" autoComplete="url" value={address} onChange={(e): void => { setAddress(e.target.value); }} placeholder="https://vault.example.com" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="oidc-namespace">Namespace</label>
                  <Input id="oidc-namespace" name="vault-namespace" autoComplete="off" spellCheck={false} value={namespace} onChange={(e): void => { setNamespace(e.target.value); }} placeholder="admin" />
                </div>
              </>
            )}
            {formError !== "" && <div role="alert" className="text-sm text-destructive">{formError}</div>}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={(): void => { setCreateDialogOpen(false); }}>Cancel</Button>
            <Button type="submit" form="oidc-create-form" disabled={creating}>
              {creating && <Spinner data-icon="inline-start" />}
              {creating ? "Creating configuration…" : "Create configuration"}
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
    </PageShell>
  );
}
