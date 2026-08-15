import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useOrganizationPermissions } from "../hooks/useOrganizationPermissions";
import { KeyRound, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

type Hyok = {
  id: string;
  attributes: {
    name: string;
    "kek-id": string;
    "kms-options"?: {
      "key-location"?: string;
      "key-region"?: string;
      "key-ring-id"?: string;
    } | null;
    status?: string;
    primary?: boolean;
  };
};

type OidcConfig = {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
};

type AgentPool = {
  id: string;
  attributes: { name: string };
};

type HyokForm = {
  name: string;
  kekId: string;
  oidcConfigId: string;
  agentPoolId: string;
};

const TYPE_LABELS = {
  "aws-oidc-configurations": "AWS",
  "azure-oidc-configurations": "Azure",
  "gcp-oidc-configurations": "GCP",
  "vault-oidc-configurations": "Vault",
};

function oidcLabel(config: OidcConfig): string {
  // SAFETY: unknown config types fall through to the raw type label below.
  const label = TYPE_LABELS[config.type as keyof typeof TYPE_LABELS];
  return label ?? `${config.type} (${config.id})`;
}

const emptyForm: HyokForm = {
  name: "",
  kekId: "",
  oidcConfigId: "",
  agentPoolId: "",
};

export function HyokConfigurations(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [configurations, setConfigurations] = useState<Hyok[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const orgPermissions = useOrganizationPermissions(orgName === "" ? undefined : orgName);
  const canManage = orgName !== "" && orgPermissions.loaded && orgPermissions.has("can-manage-providers");

  const [configurationToDelete, setConfigurationToDelete] = useState<Hyok | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<HyokForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [oidcConfigs, setOidcConfigs] = useState<OidcConfig[]>([]);
  const [agentPools, setAgentPools] = useState<AgentPool[]>([]);

  useEffect((): void => {
    setConfigurations([]);
    permissionGateFired.current = false;
    setDialogOpen(false);
    setOidcConfigs([]);
    setAgentPools([]);
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
        void loadConfigurations();
      }
    } else {
      setError(orgPermissions.error ?? "You do not have permission to manage HYOK configurations for this organization.");
    }
  }, [orgPermissions.loaded, orgPermissions.has]);

  const loadConfigurations = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    if (!canManage) {
      setLoading(false);
      return;
    }
    try {
      // SAFETY: both endpoints return the JSON:API list envelope per contract.
      const [configsResponse, oidcResponse] = await Promise.all([
        fetchApi(`/organizations/${encodeURIComponent(requestedOrganizationName)}/hyok-configurations`) as Promise<{ data: Hyok[] }>,
        fetchApi(`/organizations/${encodeURIComponent(requestedOrganizationName)}/oidc-configurations`) as Promise<{ data: OidcConfig[] }>,
      ]);
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setConfigurations(configsResponse.data);
      setOidcConfigs(oidcResponse.data);
      // Agent pools are optional; a lack of read access to them should not
      // prevent the HYOK list (and the required OIDC options) from loading.
      try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
        const agentPoolsResponse = await fetchApi(
          `/organizations/${encodeURIComponent(requestedOrganizationName)}/agent-pools`,
        ) as { data?: AgentPool[] };
        if (activeOrganizationName.current === requestedOrganizationName && Array.isArray(agentPoolsResponse.data)) {
          setAgentPools(agentPoolsResponse.data);
        }
      } catch {
        // Non-fatal: leave the agent pool select empty.
      }
    } catch (reason) {
      if (activeOrganizationName.current === requestedOrganizationName) {
        setError(reason instanceof Error ? reason.message : "Failed to load HYOK configurations.");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  };

  const openCreate = (): void => {
    setForm(emptyForm);
    setError("");
    setDialogOpen(true);
  };

  const set = (key: keyof HyokForm): ((e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void) =>
    (e): void => { setForm((prev): HyokForm => ({ ...prev, [key]: e.target.value })); };

  const submit = async (): Promise<void> => {
    setSaving(true);
    setError("");
    const name = form.name.trim();
    const kekId = form.kekId.trim();
    if (name === "") {
      setError("A name is required.");
      setSaving(false);
      return;
    }
    if (kekId === "") {
      setError("A KMS key id is required.");
      setSaving(false);
      return;
    }
    if (form.oidcConfigId === "") {
      setError("An OIDC configuration is required.");
      setSaving(false);
      return;
    }
    const selectedOidc = oidcConfigs.find((config): boolean => config.id === form.oidcConfigId);
    const relationships = {
      "oidc-configuration": {
        data: { id: form.oidcConfigId, type: selectedOidc === undefined ? "oidc-configurations" : selectedOidc.type },
      },
      ...(form.agentPoolId !== "" ? { "agent-pool": { data: { id: form.agentPoolId, type: "agent-pools" } } } : undefined),
    };
    try {
      await fetchApi(`/organizations/${encodeURIComponent(orgName)}/hyok-configurations`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            attributes: { name, "kek-id": kekId },
            relationships,
          },
        }),
      });
      setDialogOpen(false);
      await loadConfigurations();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to create HYOK configuration.");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (configurationToDelete === null) return;
    setDeleting(true);
    try {
      await fetchApi(`/hyok-configurations/${configurationToDelete.id}`, { method: "DELETE" });
      setConfigurations((prev): Hyok[] => prev.filter((c): boolean => c.id !== configurationToDelete.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to delete HYOK configuration.");
    } finally {
      setDeleting(false);
      setConfigurationToDelete(null);
    }
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow={`${orgName} / Settings`}
        title="HYOK configurations"
        description="Bring-your-own-key configurations let Terraform workspaces encrypt run data with customer-managed KMS keys."
        action={canManage ? (
          <Button onClick={openCreate}>
            <span className="mr-1.5 text-base leading-none">+</span> New HYOK configuration
          </Button>
        ) : undefined}
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Primary</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center">
                    <div className="flex justify-center py-12">
                      <Spinner />
                    </div>
                  </TableCell>
                </TableRow>
              ) : error !== "" ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-sm text-muted-foreground">{error}</TableCell>
                </TableRow>
              ) : configurations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <KeyRound className="h-8 w-8 text-muted-foreground/60" />
                      <p className="text-sm">{canManage ? "No HYOK configurations yet. Create one to get started." : "No HYOK configurations."}</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : configurations.map((configuration): React.JSX.Element => (
                <TableRow key={configuration.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <KeyRound className="h-4 w-4 text-muted-foreground" />
                      {configuration.attributes.name}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {configuration.attributes["kek-id"]}
                  </TableCell>
                  <TableCell>
                    <Badge variant={configuration.attributes.status === "ok" ? "default" : "secondary"}>
                      {configuration.attributes.status ?? "unknown"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {configuration.attributes.primary === true
                      ? <Badge variant="default">Primary</Badge>
                      : <span className="text-muted-foreground">&mdash;</span>}
                  </TableCell>
                  <TableCell>
                    {canManage && (
                      <Button variant="ghost" size="icon" onClick={(): void => { setConfigurationToDelete(configuration); }} aria-label={`Delete ${configuration.attributes.name}`}>
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create HYOK configuration</DialogTitle>
            <DialogDescription>
              Encrypt workspace run data with a customer-managed KMS key.
            </DialogDescription>
          </DialogHeader>
          <form id="hyok-create-form" onSubmit={(event): void => { event.preventDefault(); void submit(); }} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="hyok-name">Name</Label>
            <Input id="hyok-name" name="hyok-name" autoComplete="off" spellCheck={false} value={form.name} onChange={set("name")} placeholder="my-hyok-config" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hyok-kek-id">KMS key id</Label>
              <Input id="hyok-kek-id" name="kek-id" autoComplete="off" spellCheck={false} value={form.kekId} onChange={set("kekId")} placeholder="alias/terraform/lf4rpw…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hyok-oidc">OIDC configuration</Label>
              <select
                id="hyok-oidc"
                name="oidc-configuration"
                value={form.oidcConfigId}
                onChange={set("oidcConfigId")}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Select an OIDC configuration</option>
                {oidcConfigs.map((config): React.JSX.Element => (
                  <option key={config.id} value={config.id}>{oidcLabel(config)}</option>
                ))}
              </select>
              {oidcConfigs.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No OIDC configurations available for this organization.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hyok-agent-pool">Agent pool</Label>
              <select
                id="hyok-agent-pool"
                name="agent-pool"
                value={form.agentPoolId}
                onChange={set("agentPoolId")}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">None (optional)</option>
                {agentPools.map((pool): React.JSX.Element => (
                  <option key={pool.id} value={pool.id}>{pool.attributes.name}</option>
                ))}
              </select>
            </div>
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={(): void => { setDialogOpen(false); }}>Cancel</Button>
            <Button type="submit" form="hyok-create-form" disabled={saving}>
              {saving ? "Saving…" : "Create HYOK configuration"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={configurationToDelete !== null}
        onOpenChange={(open): void => { if (!open) setConfigurationToDelete(null); }}
        title="Delete HYOK configuration"
        description={`Are you sure you want to delete HYOK configuration "${configurationToDelete === null ? "" : configurationToDelete.attributes.name}"? Workspaces encrypted with this key will not be able to decrypt their state. This cannot be undone.`}
        confirmText="Delete"
        confirmVariant="destructive"
        requireText={configurationToDelete === null ? undefined : configurationToDelete.attributes.name}
        loading={deleting}
        onConfirm={confirmDelete}
      />
    </PageShell>
  );
}
