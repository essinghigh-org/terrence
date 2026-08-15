import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Select } from "../components/ui/select";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Spinner } from "../components/ui/spinner";
import { Plus, Share2, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

type ConsumerResource = {
  id: string;
};

type OrgResource = {
  id: string;
  attributes?: { name?: string };
};

export function ModuleSharing(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";

  const [consumers, setConsumers] = useState<string[]>([]);
  const [availableOrgs, setAvailableOrgs] = useState<string[]>([]);
  const [newConsumer, setNewConsumer] = useState("");
  const [manageableOrganizationName, setManageableOrganizationName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const canManage = orgName !== "" && manageableOrganizationName === orgName;

  useEffect((): void => {
    setConsumers([]);
    setAvailableOrgs([]);
    setManageableOrganizationName("");
    setError("");
    setSaved(false);
    if (orgName !== "") void loadModuleConsumers();
  }, [orgName]);

  const loadModuleConsumers = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    try {
      // The endpoint is site-admin authority (admin/organizations/...), so gate
      // on the caller's account flag — org-level can-manage-policies is not
      // sufficient and would misrepresent who may use this view.
      const accountResponse = await fetchApi("/api/v2/account/details") as {
        data?: { attributes?: { "is-site-admin"?: boolean } };
      };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      if (accountResponse.data?.attributes?.["is-site-admin"] !== true) {
        setError("Module sharing can only be managed by a site administrator.");
        setLoading(false);
        return;
      }
      setManageableOrganizationName(requestedOrganizationName);
      const [consumersResponse, orgsResponse] = await Promise.all([
        fetchApi(
          `/admin/organizations/${encodeURIComponent(requestedOrganizationName)}/relationships/module-consumers`,
        ) as Promise<{ data: ConsumerResource[] }>,
        fetchApi("/admin/organizations") as Promise<{ data: OrgResource[] }>,
      ]);
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      const consumerNames = consumersResponse.data.map((consumer): string => consumer.id);
      setConsumers(consumerNames);
      // Offer every organization that is not already a consumer as a pickable
      // option — the user picks from the list instead of typing a name.
      const consumerSet = new Set(consumerNames);
      const orgNames = Array.isArray(orgsResponse.data)
        ? orgsResponse.data
          .map((org): string => org.id)
          .filter((name): boolean => name !== "" && name !== requestedOrganizationName && !consumerSet.has(name))
          .sort()
        : [];
      setAvailableOrgs(orgNames);
    } catch (reason) {
      if (activeOrganizationName.current === requestedOrganizationName) {
        setError(reason instanceof Error ? reason.message : "Failed to load module consumers.");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  };

  // Re-read the current list before applying a change so a concurrent edit
  // elsewhere isn't silently clobbered by the full-list PATCH.
  const patchConsumers = async (mutate: (current: string[]) => string[]): Promise<string[]> => {
    const fresh = await fetchApi(
      `/admin/organizations/${encodeURIComponent(orgName)}/relationships/module-consumers`,
    ) as { data: ConsumerResource[] };
    const current = fresh.data.map((consumer): string => consumer.id);
    const next = mutate(current);
    await fetchApi(
      `/admin/organizations/${encodeURIComponent(orgName)}/relationships/module-consumers`,
      {
        method: "PATCH",
        body: JSON.stringify({
          data: next.map((name) => ({ type: "organizations", id: name })),
        }),
      },
    );
    return next;
  };

  const addConsumer = async (): Promise<void> => {
    const name = newConsumer.trim();
    if (name === "") return;
    if (consumers.includes(name)) {
      setError("That organization is already a module consumer.");
      return;
    }
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const next = await patchConsumers((current): string[] => (current.includes(name) ? current : [...current, name]));
      // Drop a stale response if the user navigated to another org mid-request.
      if (activeOrganizationName.current !== orgName) return;
      setConsumers(next);
      setAvailableOrgs((current): string[] => current.filter((candidate): boolean => candidate !== name));
      setNewConsumer("");
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to add module consumer.");
    } finally {
      setSaving(false);
    }
  };

  const removeConsumer = async (id: string): Promise<void> => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const next = await patchConsumers((current): string[] => current.filter((consumer): boolean => consumer !== id));
      if (activeOrganizationName.current !== orgName) return;
      setConsumers(next);
      setAvailableOrgs((current): string[] => [...current, id].sort());
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to remove module consumer.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow={`${orgName} / Settings`}
        title="Module sharing"
        description="Organizations that can consume this organization&apos;s private modules."
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="flex items-center gap-2">
                    <Share2 className="h-4 w-4" />
                    Consumer organization
                  </span>
                </TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={2} className="h-32 text-center">
                    <div className="flex justify-center py-12">
                      <Spinner />
                    </div>
                  </TableCell>
                </TableRow>
              ) : error !== "" && consumers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={2} className="h-32 text-center text-sm text-muted-foreground">{error}</TableCell>
                </TableRow>
              ) : consumers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={2} className="h-32 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Share2 className="h-8 w-8 text-muted-foreground/60" />
                      <p className="text-sm">No module consumers.</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : consumers.map((consumer): React.JSX.Element => (
                <TableRow key={consumer}>
                  <TableCell className="font-medium">{consumer}</TableCell>
                  <TableCell>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(): void => { void removeConsumer(consumer); }}
                        disabled={saving}
                        aria-label={`Remove ${consumer}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
        {canManage && (
          <div className="flex items-end gap-2 px-4">
            <div className="flex-1 space-y-2">
              <label className="text-sm font-medium" htmlFor="module-consumer-name">
                Organization
              </label>
              <Select
                id="module-consumer-name"
                name="module-consumer"
                value={newConsumer}
                onValueChange={(value: string): void => { setNewConsumer(value); }}
                aria-label="Organization to share modules with"
              >
                <option value="">Select an organization…</option>
                {availableOrgs.map((name): React.JSX.Element => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </Select>
              {availableOrgs.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Every other organization is already a module consumer.
                </p>
              )}
            </div>
            <Button
              onClick={(): void => { void addConsumer(); }}
              disabled={saving || newConsumer.trim() === ""}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add
            </Button>
          </div>
        )}
        {(error !== "" || saved) && (
          <div className="px-4">
            {error !== "" && <div className="text-sm text-destructive">{error}</div>}
            {saved && <div className="text-sm text-success">Saved</div>}
          </div>
        )}
      </Card>
    </PageShell>
  );
}
