import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchApi } from "@/lib/api";

type PolicySet = {
  id: string;
  attributes: {
    name: string;
    description?: string | null;
    kind: string;
    scope: "workspace" | "project" | "global";
    overridable?: boolean;
    "policy-count"?: number;
  };
};

export function WorkspacePolicySets({
  workspaceId,
}: Readonly<{ workspaceId: string }>): React.JSX.Element {
  const [policySets, setPolicySets] = useState<PolicySet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setError("");
    fetchApi(`/workspaces/${workspaceId}/policy-sets`)
      .then((response: unknown): void => {
        if (!active) return;
        const data = (response as { data?: PolicySet[] }).data;
        setPolicySets(Array.isArray(data) ? data : []);
      })
      .catch((caught: unknown): void => {
        if (active) {
          setError(caught instanceof Error ? caught.message : "Failed to load policy sets");
        }
      })
      .finally((): void => {
        if (active) setLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [workspaceId]);

  return (
    <Card className="max-w-4xl">
      <CardHeader>
        <CardTitle>Policy sets</CardTitle>
        <CardDescription>
          Effective policy sets applied directly, through the project, or across the organization.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldError>{error}</FieldError>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Framework</TableHead>
                <TableHead>Policies</TableHead>
                <TableHead>Override</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                    Loading policy sets…
                  </TableCell>
                </TableRow>
              )}
              {!loading && policySets.map((policySet: PolicySet): React.JSX.Element => (
                <TableRow key={policySet.id}>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{policySet.attributes.name}</span>
                      {policySet.attributes.description != null && policySet.attributes.description !== "" && (
                        <span className="max-w-md text-sm text-muted-foreground">
                          {policySet.attributes.description}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={policySet.attributes.scope === "global" ? "default" : "secondary"}>
                      {policySet.attributes.scope}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{policySet.attributes.kind.toUpperCase()}</Badge>
                  </TableCell>
                  <TableCell>{policySet.attributes["policy-count"] ?? 0}</TableCell>
                  <TableCell>{policySet.attributes.overridable === true ? "Allowed" : "Blocked"}</TableCell>
                </TableRow>
              ))}
              {!loading && error === "" && policySets.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                    No policy sets apply to this workspace.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
