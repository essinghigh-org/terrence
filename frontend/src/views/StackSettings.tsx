import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Spinner } from "../components/ui/spinner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Layers, Trash2 } from "lucide-react";

type Stack = {
  id: string;
  attributes: {
    name: string;
    "vcs-repo"?: { identifier?: string; branch?: string } | null;
    "working-directory"?: string | null;
    "speculative-enabled"?: boolean;
    "created-at"?: string;
  };
};

export function StackSettings(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [manageableOrganizationName, setManageableOrganizationName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const canManage = orgName !== "" && manageableOrganizationName === orgName;

  const [stackToDelete, setStackToDelete] = useState<Stack | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect((): void => {
    setStacks([]);
    setManageableOrganizationName("");
    if (orgName !== "") void loadStacks();
  }, [orgName]);

  const loadStacks = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    try {
      const organizationResponse = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}`,
      ) as {
        data?: { attributes?: { permissions?: { "can-manage-projects"?: boolean } } };
      };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      const permissions = organizationResponse.data?.attributes?.permissions;
      if (permissions?.["can-manage-projects"] !== true) {
        setError("You do not have permission to manage stacks for this organization.");
        setLoading(false);
        return;
      }
      setManageableOrganizationName(requestedOrganizationName);
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}/stacks`,
      ) as { data: Stack[] };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setStacks(response.data);
    } catch (reason) {
      if (activeOrganizationName.current === requestedOrganizationName) {
        setError(reason instanceof Error ? reason.message : "Failed to load stacks.");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (stackToDelete === null) return;
    setDeleting(true);
    try {
      await fetchApi(`/stacks/${stackToDelete.id}`, { method: "DELETE" });
      setStacks((prev): Stack[] => prev.filter((s): boolean => s.id !== stackToDelete.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to delete stack.");
    } finally {
      setDeleting(false);
      setStackToDelete(null);
    }
  };

  const vcsRepo = (stack: Stack): { identifier?: string; branch?: string } | null =>
    stack.attributes["vcs-repo"] ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Stacks</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Stacks let you manage collections of workspaces and the infrastructure they deploy.
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
          ) : stacks.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
              <Layers className="h-8 w-8" />
              <p className="text-sm">No stacks.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>VCS repo</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Working directory</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {stacks.map((stack): React.JSX.Element => (
                  <TableRow key={stack.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Layers className="h-4 w-4 text-muted-foreground" />
                        {stack.attributes.name}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {vcsRepo(stack)?.identifier ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {vcsRepo(stack)?.branch ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {stack.attributes["working-directory"] ?? "—"}
                    </TableCell>
                    <TableCell>
                      {canManage && (
                        <Button variant="ghost" size="icon" onClick={(): void => { setStackToDelete(stack); }} aria-label={`Delete ${stack.attributes.name}`}>
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
        open={stackToDelete !== null}
        onOpenChange={(open): void => { if (!open) setStackToDelete(null); }}
        title="Delete stack"
        description="Deleting a stack removes it and its deployments."
        confirmText="Delete"
        confirmVariant="destructive"
        loading={deleting}
        onConfirm={confirmDelete}
      />
    </div>
  );
}