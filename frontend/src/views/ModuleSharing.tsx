import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Spinner } from "../components/ui/spinner";
import { Plus, Share2, Trash2 } from "lucide-react";

type ConsumerResource = {
  id: string;
};

export function ModuleSharing(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";

  const [consumers, setConsumers] = useState<string[]>([]);
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
      const response = await fetchApi(
        `/admin/organizations/${encodeURIComponent(requestedOrganizationName)}/relationships/module-consumers`,
      ) as { data: ConsumerResource[] };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setConsumers(response.data.map((consumer): string => consumer.id));
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
          data: next.map((name): { type: string; id: string } => ({ type: "organizations", id: name })),
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
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to remove module consumer.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <Share2 className="mt-0.5 h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Module sharing</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Organizations that can consume this organization&apos;s private modules.
          </p>
        </div>
      </div>

      <Card>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : error !== "" && consumers.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{error}</div>
          ) : (
            <div className="space-y-4">
              {consumers.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
                  <Share2 className="h-8 w-8" />
                  <p className="text-sm">No module consumers.</p>
                </div>
              ) : (
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
                    {consumers.map((consumer): React.JSX.Element => (
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
              )}

              {canManage && (
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-2">
                    <label className="text-sm font-medium" htmlFor="module-consumer-name">
                      Organization name
                    </label>
                    <Input
                      id="module-consumer-name"
                      value={newConsumer}
                      onChange={(e): void => { setNewConsumer(e.target.value); }}
                      onKeyDown={(e): void => {
                        if (e.key === "Enter") void addConsumer();
                      }}
                      placeholder="acme-corp"
                    />
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

              {error !== "" && <div className="text-sm text-red-500">{error}</div>}
              {saved && <div className="text-sm text-green-600">Saved</div>}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
