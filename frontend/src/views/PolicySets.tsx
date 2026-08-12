import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { HelpTooltip } from "@/components/ui/help-tooltip";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectItem } from "../components/ui/select";
import { ShieldCheck, Plus, Trash2, FolderKanban } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

type PolicySet = {
  id: string;
  attributes: {
    name: string;
    description?: string | null;
    kind?: string;
    global?: boolean;
    overridable?: boolean;
  };
  relationships?: {
    policies?: { data?: { id: string; type: string }[] };
    workspaces?: { data?: { id: string; type: string }[] };
    projects?: { data?: { id: string; type: string }[] };
  };
};

export function PolicySets(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const orgPath = `/app/${encodeURIComponent(orgName)}`;
  const [policySets, setPolicySets] = useState<PolicySet[]>([]);
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
  const [kind, setKind] = useState("sentinel");
  const [global, setGlobal] = useState(false);
  const [overridable, setOverridable] = useState(true);

  const [setToDelete, setSetToDelete] = useState<PolicySet | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect((): void => {
    setPolicySets([]);
    setManageableOrganizationName("");
    setCreateDialogOpen(false);
    if (orgName !== "") void loadPolicySets();
  }, [orgName]);

  const loadPolicySets = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    try {
      const organizationResponse = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}`,
      ) as {
        data?: { attributes?: { permissions?: { "can-manage-policies"?: boolean; "can-read-policies"?: boolean } } };
      };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      const permissions = organizationResponse.data?.attributes?.permissions;
      if (permissions?.["can-manage-policies"] === true) {
        setManageableOrganizationName(requestedOrganizationName);
      } else if (permissions?.["can-read-policies"] !== true) {
        setError("You do not have permission to view policy sets for this organization.");
        return;
      }
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}/policy-sets`,
      ) as { data?: PolicySet[] };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setPolicySets(Array.isArray(response.data) ? response.data : []);
    } catch (err: unknown) {
      if (activeOrganizationName.current === requestedOrganizationName) {
        setError(err instanceof Error ? err.message : "Failed to load policy sets");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  };

  const handleCreate = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (!canManage) return;
    setCreating(true);
    setFormError("");
    try {
      const response = await fetchApi(`/organizations/${encodeURIComponent(orgName)}/policy-sets`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "policy-sets",
            attributes: {
              name: name.trim(),
              description: description.trim() === "" ? null : description.trim(),
              kind,
              global,
              overridable,
            },
          },
        }),
      }) as { data: PolicySet };
      if (activeOrganizationName.current !== orgName) return;
      setPolicySets((prev: PolicySet[]): PolicySet[] => [...prev, response.data]);
      setCreateDialogOpen(false);
      setName("");
      setDescription("");
      setGlobal(false);
      setOverridable(true);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : "Failed to create policy set");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (policySet: PolicySet): Promise<void> => {
    if (!canManage) return;
    setDeleting(true);
    setError("");
    try {
      await fetchApi(`/policy-sets/${encodeURIComponent(policySet.id)}`, { method: "DELETE" });
      if (activeOrganizationName.current !== orgName) return;
      setPolicySets((prev: PolicySet[]): PolicySet[] => prev.filter((p: PolicySet): boolean => p.id !== policySet.id));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete policy set");
    } finally {
      setDeleting(false);
      setSetToDelete(null);
    }
  };

  const detailPath = (id: string): string => `${orgPath}/settings/policy-sets/${encodeURIComponent(id)}`;
  const policyCount = (policySet: PolicySet): number => policySet.relationships?.policies?.data?.length ?? 0;
  const workspaceCount = (policySet: PolicySet): number => policySet.relationships?.workspaces?.data?.length ?? 0;
  const projectCount = (policySet: PolicySet): number => policySet.relationships?.projects?.data?.length ?? 0;

  return (
    <PageShell>
      <PageHeader
        eyebrow={`${orgName} / Settings`}
        title={
          <span className="flex items-center gap-2">
            Policy sets
            <HelpTooltip content="Policy sets group Sentinel policies that are run against workspace plans and applies." />
          </span>
        }
        description="Manage Sentinel policy sets for this organization, attach them to projects and workspaces, and configure enforcement."
        action={canManage ? (
          <Button onClick={(): void => { setCreateDialogOpen(true); }}>
            <Plus className="mr-1.5 size-4" /> Create policy set
          </Button>
        ) : undefined}
      />

      {error !== "" && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-destructive/15 p-4 text-sm font-medium text-destructive">
          <span>{error}</span>
          <Button type="button" size="sm" variant="outline" onClick={(): void => { void loadPolicySets(); }}>
            Try again
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Framework</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Policies</TableHead>
                <TableHead>Targets</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={6} className="p-0">
                    <TableSkeleton rows={3} cols={6} />
                  </TableCell>
                </TableRow>
              ) : policySets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-2">
                      <FolderKanban className="size-8 text-muted-foreground/60" />
                      No policy sets found. Create a policy set to attach Sentinel policies to your workspaces.
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                policySets.map((policySet): React.JSX.Element => (
                  <TableRow key={policySet.id}>
                    <TableCell>
                      <Link to={detailPath(policySet.id)} className="font-semibold hover:underline">
                        <div className="flex items-center gap-2">
                          <ShieldCheck className="size-4 text-primary" />
                          {policySet.attributes.name}
                        </div>
                      </Link>
                      {policySet.attributes.description != null && policySet.attributes.description !== "" && (
                        <div className="mt-0.5 max-w-md truncate text-xs text-muted-foreground">
                          {policySet.attributes.description}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{(policySet.attributes.kind ?? "sentinel").toUpperCase()}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={policySet.attributes.global === true ? "default" : "secondary"}>
                        {policySet.attributes.global === true ? "Global" : "Policy set"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{policyCount(policySet)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {projectCount(policySet) > 0 ? `${projectCount(policySet)} project${projectCount(policySet) === 1 ? "" : "s"}` : ""}
                      {projectCount(policySet) > 0 && workspaceCount(policySet) > 0 ? " · " : ""}
                      {workspaceCount(policySet) > 0 ? `${workspaceCount(policySet)} workspace${workspaceCount(policySet) === 1 ? "" : "s"}` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={(): void => { setSetToDelete(policySet); }}
                        >
                          <Trash2 className="size-3.5 mr-1" /> Delete
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <form onSubmit={handleCreate} noValidate>
            <DialogHeader>
              <DialogTitle>Create policy set</DialogTitle>
              <DialogDescription>Create a Sentinel policy set you can attach to projects and workspaces.</DialogDescription>
            </DialogHeader>
            {formError !== "" && (
              <div role="alert" className="rounded bg-destructive/15 p-3 text-xs font-medium text-destructive">
                {formError}
              </div>
            )}
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <label htmlFor="policy-set-name" className="text-sm font-medium">Name</label>
                <Input
                  id="policy-set-name"
                  name="policy-set-name"
                  autoComplete="off"
                  spellCheck={false}
                  value={name}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setName(event.currentTarget.value); }}
                  placeholder="e.g. security-baseline"
                  required
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="policy-set-description" className="text-sm font-medium">Description <span className="font-normal text-muted-foreground">(Optional)</span></label>
                <textarea
                  id="policy-set-description"
                  name="policy-set-description"
                  autoComplete="off"
                  spellCheck={false}
                  rows={3}
                  value={description}
                  onInput={(event: React.SyntheticEvent<HTMLTextAreaElement>): void => { setDescription(event.currentTarget.value); }}
                  placeholder="What does this set enforce?"
                  className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="policy-set-kind" className="text-sm font-medium">Framework</label>
                <Select id="policy-set-kind" name="policy-set-kind" value={kind} onValueChange={setKind}>
                  <SelectItem value="sentinel">Sentinel</SelectItem>
                </Select>
              </div>
              <div className="flex flex-col gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={global} onCheckedChange={(checked: boolean | "indeterminate"): void => { setGlobal(checked === true); }} />
                  <span>Apply to all workspaces <span className="text-xs text-muted-foreground">(Global policy set)</span></span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={overridable} onCheckedChange={(checked: boolean | "indeterminate"): void => { setOverridable(checked === true); }} />
                  <span>Allow policy overrides <span className="text-xs text-muted-foreground">(recommended)</span></span>
                </label>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={(): void => { setCreateDialogOpen(false); }}>Cancel</Button>
              <Button type="submit" disabled={creating || name.trim() === ""}>
                {creating && <Spinner data-icon="inline-start" className="size-4" />}
                {creating ? "Creating policy set…" : "Create policy set"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={setToDelete !== null}
        onOpenChange={(open): void => { if (!open) setSetToDelete(null); }}
        title="Delete policy set"
        description={
          <>
            Are you sure you want to delete policy set <strong className="text-foreground">{setToDelete?.attributes.name}</strong>? Policies in this set will be permanently removed and workspaces will no longer be checked against it.
          </>
        }
        confirmText="Delete policy set"
        confirmVariant="destructive"
        requireText={setToDelete?.attributes.name}
        loading={deleting}
        onConfirm={async (): Promise<void> => {
          if (setToDelete !== null) {
            await handleDelete(setToDelete);
          }
        }}
      />
    </PageShell>
  );
}
