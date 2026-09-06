import { EmptyState } from "../components/EmptyState";
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
import { useAgentPools } from "../hooks/useAgentPools";
import { AlertTriangle, CheckCircle2, CircleX, Fingerprint, Plus, Stethoscope, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";
import { isString } from "../lib/type-guards";
import type { JsonObject } from "@/lib/json";

type OidcConfig = {
  id: string;
  type: string;
  attributes: JsonObject;
};

type DoctorCheck = Readonly<{
  name: string;
  status: "passed" | "warning" | "failed" | "skipped";
  code: string;
  guidance: string;
  details?: Readonly<Record<string, unknown>>;
}>;

type DoctorResult = Readonly<{
  id: string;
  type: string;
  attributes: Readonly<{
    provider: string;
    status: "passed" | "warning" | "failed";
    "execution-context": Readonly<{ kind: string; node: string; "agent-pool-id": string | null; "agent-id": string | null }>;
    claims: Readonly<Record<string, unknown>>;
    checks: readonly DoctorCheck[];
    identity: Readonly<Record<string, unknown>> | null;
    caveat: string;
    "started-at": string;
    "completed-at": string;
  }>;
}>;

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
    if (isString(value)) return value;
  }
  return config.id;
}

function safeDisplayValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "unknown";
}

export function OidcConfigurations(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const orgPath = `/app/${encodeURIComponent(orgName)}`;
  const [configs, setConfigs] = useState<OidcConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const orgPermissions = useOrganizationPermissions(orgName === "" ? undefined : orgName);
  const canManage = orgName !== "" && orgPermissions.loaded && orgPermissions.has("can-manage-providers");
  const agentPoolsState = useAgentPools(orgName, canManage);

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
  const [doctorConfig, setDoctorConfig] = useState<OidcConfig | null>(null);
  const [doctorTarget, setDoctorTarget] = useState("worker");
  const [doctorResult, setDoctorResult] = useState<DoctorResult | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [doctorError, setDoctorError] = useState("");

  useEffect((): void => {
    setConfigs([]);
    setCreateDialogOpen(false);
    setDoctorConfig(null);
    setDoctorResult(null);
    setDoctorError("");
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

  const buildAttributes = (): Readonly<Record<string, string>> => {
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

  const runDoctor = async (): Promise<void> => {
    if (doctorConfig === null) return;
    setDoctorRunning(true);
    setDoctorError("");
    setDoctorResult(null);
    try {
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(orgName)}/oidc-configurations/${encodeURIComponent(doctorConfig.id)}/credential-doctor`,
        {
          method: "POST",
          body: JSON.stringify({
            data: {
              type: "credential-doctor-runs",
              attributes: { "agent-pool-id": doctorTarget === "worker" ? null : doctorTarget },
            },
          }),
        },
      ) as { data: DoctorResult };
      setDoctorResult(response.data);
    } catch (reason) {
      setDoctorError(reason instanceof Error ? reason.message : "Credential doctor failed to run.");
    } finally {
      setDoctorRunning(false);
    }
  };

  const doctorIcon = (status: DoctorCheck["status"]): React.JSX.Element => {
    if (status === "passed") return <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />;
    if (status === "warning") return <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />;
    if (status === "failed") return <CircleX className="h-4 w-4 text-destructive" aria-hidden="true" />;
    return <AlertTriangle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
  };

  return (
    <PageShell>
      <PageHeader
        breadcrumbs={[
          { label: orgName, to: `${orgPath}/workspaces` },
          { label: "Settings", to: `${orgPath}/settings` },
          { label: "OIDC configurations" },
        ]}
        title="OIDC configurations"
        description="Let a run prove who it is to AWS, Azure or GCP without storing long-lived keys as variables. The cloud provider trusts a short-lived token signed by this instance instead."
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
                <TableHead className="w-56" />
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
                    <EmptyState compact title="No OIDC configurations." description="Configure short-lived cloud credentials for your runs." docsHref="/app/docs/oidc-runs" />
                  </TableCell>
                </TableRow>
              ) : configs.map((config): React.JSX.Element => {
                // SAFETY: unknown config types fall back to the raw type string.
                const typeLabel = Object.prototype.hasOwnProperty.call(TYPE_LABELS, config.type)
                  ? TYPE_LABELS[config.type as keyof typeof TYPE_LABELS]
                  : config.type;
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
                      <div className="flex justify-end gap-1">
                        <Button variant="outline" size="sm" onClick={(): void => { setDoctorConfig(config); setDoctorResult(null); setDoctorError(""); setDoctorTarget("worker"); }}>
                          <Stethoscope className="mr-2 h-4 w-4" aria-hidden="true" />
                          Check access
                        </Button>
                        <Button variant="ghost" size="icon" onClick={(): void => { setConfigToDelete(config); }} aria-label="Delete configuration">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={doctorConfig !== null} onOpenChange={(open): void => { if (!open && !doctorRunning) { setDoctorConfig(null); setDoctorResult(null); setDoctorError(""); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Credential doctor</DialogTitle>
            <DialogDescription>
              Issue a short-lived workload token, check its trust claims, test provider reachability, and make one harmless identity/read call from the selected execution context.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="credential-doctor-target">Run from</label>
              <Select id="credential-doctor-target" name="credential-doctor-target" value={doctorTarget} onValueChange={setDoctorTarget} disabled={doctorRunning}>
                <SelectItem value="worker">Terrence worker ({typeof window === "undefined" ? "local" : "control plane"})</SelectItem>
                {agentPoolsState.pools.map((pool): React.JSX.Element => <SelectItem key={pool.id} value={pool.id}>{pool.attributes.name} (agent pool)</SelectItem>)}
              </Select>
              {agentPoolsState.error !== "" && <p className="text-xs text-muted-foreground">{agentPoolsState.error}</p>}
            </div>
            {doctorError !== "" && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{doctorError}</div>}
            {doctorResult !== null && (
              <div className="space-y-4 rounded-md border p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{doctorResult.attributes.provider.toUpperCase()} credential check</p>
                    <p className="text-xs text-muted-foreground">{doctorResult.attributes["execution-context"].kind === "agent_pool" ? `Agent ${doctorResult.attributes["execution-context"]["agent-id"] ?? "pool"}` : "Terrence worker"} · {new Date(doctorResult.attributes["completed-at"]).toLocaleString()}</p>
                  </div>
                  <span className={doctorResult.attributes.status === "failed" ? "text-sm font-medium text-destructive" : doctorResult.attributes.status === "warning" ? "text-sm font-medium text-amber-700" : "text-sm font-medium text-emerald-700"}>
                    {doctorResult.attributes.status}
                  </span>
                </div>
                <ul className="space-y-2" aria-label="Credential doctor checks">
                  {doctorResult.attributes.checks.map((check): React.JSX.Element => (
                    <li key={check.name} className="flex items-start gap-2 text-sm">
                      <span className="mt-0.5">{doctorIcon(check.status)}</span>
                      <span className="min-w-0"><span className="font-medium">{check.name.split("_").join(" ")}</span><span className="ml-2 text-xs text-muted-foreground">{check.code}</span><span className="block text-xs text-muted-foreground">{check.guidance}</span></span>
                    </li>
                  ))}
                </ul>
                <div className="rounded-md bg-muted/60 p-3 text-xs">
                  <p className="font-medium">Safe token claims</p>
                  <p className="mt-1 break-all text-muted-foreground">aud: {safeDisplayValue(doctorResult.attributes.claims["aud"])} · sub: {safeDisplayValue(doctorResult.attributes.claims["sub"])}</p>
                  <p className="mt-1 text-muted-foreground">A successful identity/read probe does not prove authorization for every later resource operation.</p>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={(): void => { setDoctorConfig(null); setDoctorResult(null); setDoctorError(""); }} disabled={doctorRunning}>Close</Button>
            <Button type="button" onClick={(): void => { void runDoctor(); }} disabled={doctorRunning || doctorConfig === null}>
              {doctorRunning && <Spinner data-icon="inline-start" />}
              {doctorRunning ? "Checking…" : doctorResult === null ? "Run credential doctor" : "Run again"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
