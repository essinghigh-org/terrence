import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Spinner } from "../components/ui/spinner";
import { Badge } from "../components/ui/badge";
import { Tags } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

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
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
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
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
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
    <PageShell>
      <PageHeader
        eyebrow={`${orgName} / Settings`}
        title="Tag-based policy sets"
        description="Policy sets scoped by tag selectors are automatically applied to workspaces whose tags match."
      />

      <Card>
        <CardContent className="p-0">
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
                    {loading ? (
                      <TableRow>
                        <TableCell colSpan={4} className="h-32 text-center">
                          <Spinner />
                        </TableCell>
                      </TableRow>
                    ) : error !== "" ? (
                      <TableRow>
                        <TableCell colSpan={4} className="h-32 text-center text-sm text-muted-foreground">{error}</TableCell>
                      </TableRow>
                    ) : sets.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                          <div className="flex flex-col items-center justify-center gap-2">
                            <Tags className="h-8 w-8 text-muted-foreground/60" />
                            <p className="text-sm">No tag-based policy sets found.</p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : sets.map((policySet): React.JSX.Element => (
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
        </CardContent>
      </Card>
    </PageShell>
  );
}