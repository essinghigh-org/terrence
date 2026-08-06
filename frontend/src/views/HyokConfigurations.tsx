import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { KeyRound, Trash2 } from "lucide-react";

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

export function HyokConfigurations(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [configurations, setConfigurations] = useState<Hyok[]>([]);
  const [manageableOrganizationName, setManageableOrganizationName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const canManage = orgName !== "" && manageableOrganizationName === orgName;

  const [configurationToDelete, setConfigurationToDelete] = useState<Hyok | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect((): void => {
    setConfigurations([]);
    setManageableOrganizationName("");
    if (orgName !== "") void loadConfigurations();
  }, [orgName]);

  const loadConfigurations = async (): Promise<void> => {
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
        setError("You do not have permission to manage HYOK configurations for this organization.");
        setLoading(false);
        return;
      }
      setManageableOrganizationName(requestedOrganizationName);
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}/hyok-configurations`,
      ) as { data: Hyok[] };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setConfigurations(response.data);
    } catch (reason) {
      if (activeOrganizationName.current === requestedOrganizationName) {
        setError(reason instanceof Error ? reason.message : "Failed to load HYOK configurations.");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">HYOK configurations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Bring-your-own-key configurations let Terraform workspaces encrypt run data with customer-managed KMS keys.
        </p>
      </div>

      <Card>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : error !== "" ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{error}</div>
          ) : configurations.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
              <KeyRound className="h-8 w-8" />
              <p className="text-sm">No HYOK configurations.</p>
            </div>
          ) : (
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
                {configurations.map((configuration): React.JSX.Element => (
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
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={configurationToDelete !== null}
        onOpenChange={(open): void => { if (!open) setConfigurationToDelete(null); }}
        title="Delete HYOK configuration"
        description={`Are you sure you want to delete "${configurationToDelete === null ? "" : configurationToDelete.attributes.name}"? Workspaces encrypted with this key will not be able to decrypt their state.`}
        confirmText="Delete"
        confirmVariant="destructive"
        loading={deleting}
        onConfirm={confirmDelete}
      />
    </div>
  );
}