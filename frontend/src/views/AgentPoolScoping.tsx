import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { useOrganizationPermissions } from "../hooks/useOrganizationPermissions";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Boxes, Plus } from "lucide-react";

// The GET /organizations/:org/agent-pools serializer emits each pool's scope
// relationships as raw resource identifiers ({ id, type }) — the backend
// agentPoolResource maps agentPoolAllowedWorkspaces / agentPoolAllowedProjects /
// agentPoolExcludedWorkspaces join rows to their workspace/project UUIDs. No
// resolved names are included, so the UI renders counts with the ids available
// as hover detail.
type AgentPool = {
  id: string;
  attributes: {
    name: string;
  };
  relationships?: {
    "allowed-workspaces"?: { data?: { id: string }[] };
    "allowed-projects"?: { data?: { id: string }[] };
    "excluded-workspaces"?: { data?: { id: string }[] };
  };
};

type Relationship = { data?: { id: string }[] };

const relationshipIds = (relationship: Relationship | undefined): string[] =>
  Array.isArray(relationship?.data) ? relationship.data.map((entry): string => entry.id) : [];

function ScopeCell({ ids }: { ids: string[] }): React.JSX.Element {
  if (ids.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <Badge variant="secondary" title={ids.join(", ")} className="cursor-help">
      {ids.length}
    </Badge>
  );
}

export function AgentPoolScoping(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [pools, setPools] = useState<AgentPool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const orgPermissions = useOrganizationPermissions(orgName === "" ? undefined : orgName);
  const canManage = orgName !== "" && orgPermissions.loaded && orgPermissions.has("can-manage-agent-pools");

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");
  const [name, setName] = useState("");
  const [organizationScoped, setOrganizationScoped] = useState(true);

  useEffect((): void => {
    setPools([]);
    setError("");
    permissionGateFired.current = false;
    setCreateDialogOpen(false);
  }, [orgName]);

  // Central permission gate (14.6): once org permissions load, surface a clear
  // error when the operator lacks access. When access is granted, load the data
  // exactly once (the initial call early-returns while permissions are loading).
  const permissionGateFired = useRef(false);
  useEffect((): void => {
    if (!orgPermissions.loaded) return;
    if (orgPermissions.has("can-manage-agent-pools")) {
      setError("");
      if (!permissionGateFired.current) {
        permissionGateFired.current = true;
        void loadPools();
      }
    } else {
      setError(orgPermissions.error ?? "You do not have permission to manage agent pools for this organization.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgPermissions.loaded, orgPermissions.has]);

  const loadPools = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    if (!canManage) {
      setLoading(false);
      return;
    }
    try {
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}/agent-pools`,
      ) as { data?: AgentPool[] };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setPools(Array.isArray(response.data) ? response.data : []);
    } catch (reason) {
      if (activeOrganizationName.current === requestedOrganizationName) {
        setError(reason instanceof Error ? reason.message : "Failed to load agent pools.");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  };

  const createAgentPool = async (): Promise<void> => {
    if (name.trim() === "") {
      setFormError("Name is required.");
      return;
    }
    setCreating(true);
    setFormError("");
    try {
      await fetchApi(`/organizations/${encodeURIComponent(orgName)}/agent-pools`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "agent-pools",
            attributes: {
              name: name.trim(),
              "organization-scoped": organizationScoped,
            },
          },
        }),
      });
      setCreateDialogOpen(false);
      setName("");
      setOrganizationScoped(true);
      await loadPools();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Failed to create agent pool.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agent pool scoping</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Which workspaces and projects each agent pool is allowed, or explicitly excluded, from running in.
          </p>
        </div>
        {canManage && (
          <Button onClick={(): void => { setCreateDialogOpen(true); }}>
            <Plus className="mr-2 h-4 w-4" />
            New agent pool
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
          ) : pools.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
              <Boxes className="h-8 w-8" />
              <p className="text-sm">No agent pools.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Allowed workspaces</TableHead>
                  <TableHead>Allowed projects</TableHead>
                  <TableHead>Excluded workspaces</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pools.map((pool): React.JSX.Element => (
                  <TableRow key={pool.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Boxes className="h-4 w-4 text-muted-foreground" />
                        {pool.attributes.name}
                      </div>
                    </TableCell>
                    <TableCell>
                      <ScopeCell ids={relationshipIds(pool.relationships?.["allowed-workspaces"])} />
                    </TableCell>
                    <TableCell>
                      <ScopeCell ids={relationshipIds(pool.relationships?.["allowed-projects"])} />
                    </TableCell>
                    <TableCell>
                      <ScopeCell ids={relationshipIds(pool.relationships?.["excluded-workspaces"])} />
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
            <DialogTitle>New agent pool</DialogTitle>
            <DialogDescription>
              Create a new agent pool with a name and optional organization-wide scoping.
            </DialogDescription>
          </DialogHeader>
          <form id="agent-pool-create-form" onSubmit={(event): void => { event.preventDefault(); void createAgentPool(); }} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="agent-pool-name">Name</label>
              <Input id="agent-pool-name" value={name} onChange={(e): void => { setName(e.target.value); }} placeholder="my-agent-pool" />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <label className="text-sm" htmlFor="agent-pool-org-scoped">
                <div className="font-medium">Organization-scoped</div>
                <div className="text-muted-foreground">When enabled, the agent pool is scoped to the whole organization by default.</div>
              </label>
              <input id="agent-pool-org-scoped" type="checkbox" className="h-4 w-4" checked={organizationScoped} onChange={(e): void => { setOrganizationScoped(e.target.checked); }} />
            </div>
            {formError !== "" && <div className="text-sm text-red-500">{formError}</div>}
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={(): void => { setCreateDialogOpen(false); }}>Cancel</Button>
            <Button type="submit" form="agent-pool-create-form" disabled={creating}>
              {creating ? <Spinner /> : "Create agent pool"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}