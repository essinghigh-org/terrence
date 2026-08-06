import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { Tags } from "lucide-react";

// Matches the backend policySetAttributes serializer (backend/src/routes/policies.ts):
//   "tag-selectors": selectors.map((s) => ({ "tag-key": s.key, "tag-value": s.value, "is-exclude": s.isExclude === true }))
type TagSelector = {
  "tag-key": string;
  "tag-value": string | null;
  "is-exclude": boolean;
};

type PolicyTagsSet = {
  id: string;
  attributes: {
    name: string;
    description?: string | null;
    kind?: string | null;
    "tag-selectors"?: TagSelector[];
    "workspace-count"?: number;
  };
};

export function PolicySetsTags(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const navigate = useNavigate();
  const [sets, setSets] = useState<PolicyTagsSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;

  useEffect((): void => {
    setSets([]);
    setError("");
    if (orgName !== "") void loadPolicySetsTags();
  }, [orgName]);

  const loadPolicySetsTags = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    try {
      const organizationResponse = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}`,
      ) as {
        data?: { attributes?: { permissions?: { "can-manage-policies"?: boolean } } };
      };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      const permissions = organizationResponse.data?.attributes?.permissions;
      if (permissions?.["can-manage-policies"] !== true) {
        setError("You do not have permission to view tag-based policy sets for this organization.");
        setLoading(false);
        return;
      }
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}/policy-sets`,
      ) as { data?: PolicyTagsSet[] };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      const all = Array.isArray(response.data) ? response.data : [];
      // Only tag-scoped policy sets are relevant to this view.
      const tagged = all.filter((policySet): boolean => (policySet.attributes["tag-selectors"]?.length ?? 0) > 0);
      setSets(tagged);
    } catch (reason) {
      if (activeOrganizationName.current === requestedOrganizationName) {
        setError(reason instanceof Error ? reason.message : "Failed to load tag-based policy sets.");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  };

  const formatSelector = (selector: TagSelector): string => {
    const tag = selector["tag-value"] != null && selector["tag-value"] !== ""
      ? `${selector["tag-key"].toLowerCase()}:${selector["tag-value"]}`
      : selector["tag-key"].toLowerCase();
    return selector["is-exclude"] ? `-${tag}` : tag;
  };

  const tagSummary = (policySet: PolicyTagsSet): string => {
    const joined = (policySet.attributes["tag-selectors"] ?? []).map(formatSelector).join(", ");
    return joined === "" ? "—" : joined;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tag-based policy sets</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Policy sets scoped by tag selectors are automatically applied to workspaces whose tags match.
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
          ) : sets.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
              <Tags className="h-8 w-8" />
              <p className="text-sm">No tag-based policy sets found.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Tag selectors</TableHead>
                  <TableHead>Description</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sets.map((policySet): React.JSX.Element => (
                  <TableRow
                    key={policySet.id}
                    className="cursor-pointer"
                    onClick={(): void => {
                      void navigate(`/app/${encodeURIComponent(orgName)}/settings/policy-sets/${encodeURIComponent(policySet.id)}`);
                    }}
                  >
                    <TableCell className="font-medium">
                      <Link
                        to={`/app/${encodeURIComponent(orgName)}/settings/policy-sets/${encodeURIComponent(policySet.id)}`}
                        className="flex items-center gap-2 hover:underline"
                      >
                        <Tags className="h-4 w-4 text-primary" />
                        {policySet.attributes.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{(policySet.attributes.kind ?? "sentinel").toUpperCase()}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{tagSummary(policySet)}</TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {policySet.attributes.description != null && policySet.attributes.description !== "" ? (
                        policySet.attributes.description
                      ) : (
                        "—"
                      )}
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