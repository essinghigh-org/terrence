import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { Boxes } from "lucide-react";

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

  useEffect((): void => {
    setPools([]);
    setError("");
    if (orgName !== "") void loadPools();
  }, [orgName]);

  const loadPools = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    try {
      const organizationResponse = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}`,
      ) as {
        data?: { attributes?: { permissions?: { "can-manage-agent-pools"?: boolean } } };
      };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      const permissions = organizationResponse.data?.attributes?.permissions;
      if (permissions?.["can-manage-agent-pools"] !== true) {
        setError("You do not have permission to manage agent pools for this organization.");
        setLoading(false);
        return;
      }
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

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agent pool scoping</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Which workspaces and projects each agent pool is allowed, or explicitly excluded, from running in.
          </p>
        </div>
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
    </div>
  );
}