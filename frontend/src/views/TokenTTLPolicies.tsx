import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Spinner } from "../components/ui/spinner";
import { Hourglass, Pencil } from "lucide-react";

type TokenTTLPolicy = {
  id: string;
  attributes: {
    "token-type": string;
    "max-ttl-ms": number;
    "created-at"?: string;
    "updated-at"?: string;
  };
};

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_YEAR = 365 * MS_PER_DAY;

function humanizeTokenType(tokenType: string): string {
  const words = tokenType.replace(/-/g, " ").trim().split(/\s+/);
  return words
    .map((word: string): string => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatMaxTtl(maxTtlMs: number): string {
  if (maxTtlMs >= MS_PER_YEAR && maxTtlMs % MS_PER_YEAR === 0) {
    return `${maxTtlMs / MS_PER_YEAR}y`;
  }
  if (maxTtlMs >= MS_PER_DAY && maxTtlMs % MS_PER_DAY === 0) {
    return `${maxTtlMs / MS_PER_DAY}d`;
  }
  if (maxTtlMs >= MS_PER_HOUR && maxTtlMs % MS_PER_HOUR === 0) {
    return `${maxTtlMs / MS_PER_HOUR}h`;
  }
  if (maxTtlMs >= MS_PER_MINUTE && maxTtlMs % MS_PER_MINUTE === 0) {
    return `${maxTtlMs / MS_PER_MINUTE}m`;
  }
  if (maxTtlMs >= MS_PER_SECOND && maxTtlMs % MS_PER_SECOND === 0) {
    return `${maxTtlMs / MS_PER_SECOND}s`;
  }
  return `${maxTtlMs} ms`;
}

function formatDate(value?: string): string {
  if (value === undefined || value === "") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString();
}

export function TokenTTLPolicies(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [policies, setPolicies] = useState<TokenTTLPolicy[]>([]);
  const [manageableOrganizationName, setManageableOrganizationName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const canManage = orgName !== "" && manageableOrganizationName === orgName;

  const [editingPolicy, setEditingPolicy] = useState<TokenTTLPolicy | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect((): void => {
    setPolicies([]);
    setManageableOrganizationName("");
    setEditingPolicy(null);
    if (orgName !== "") void loadTokenTTLPolicies();
  }, [orgName]);

  const loadTokenTTLPolicies = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    try {
      const organizationResponse = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}`,
      ) as {
        data?: { attributes?: { permissions?: { "can-manage-organization-access"?: boolean } } };
      };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      const permissions = organizationResponse.data?.attributes?.permissions;
      if (permissions?.["can-manage-organization-access"] !== true) {
        setError("You do not have permission to manage token TTL policies for this organization.");
        setLoading(false);
        return;
      }
      setManageableOrganizationName(requestedOrganizationName);
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}/token-ttl-policies`,
      ) as { data: TokenTTLPolicy[] };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setPolicies(response.data);
    } catch (reason) {
      if (activeOrganizationName.current === requestedOrganizationName) {
        setError(reason instanceof Error ? reason.message : "Failed to load token TTL policies.");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  };

  const openEditDialog = (policy: TokenTTLPolicy): void => {
    setEditingPolicy(policy);
    setEditingValue(String(policy.attributes["max-ttl-ms"]));
    setFormError("");
  };

  const savePolicy = async (): Promise<void> => {
    if (editingPolicy === null) return;
    const trimmed = editingValue.trim();
    if (trimmed === "") {
      setFormError("Max TTL is required.");
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setFormError("Max TTL must be a non-negative number of milliseconds.");
      return;
    }
    const maxTtlMs = Math.trunc(parsed);
    setSaving(true);
    setFormError("");
    try {
      const updatedPolicies = policies.map((policy: TokenTTLPolicy): TokenTTLPolicy => (
        policy.id === editingPolicy.id
          ? {
              ...policy,
              attributes: { ...policy.attributes, "max-ttl-ms": maxTtlMs },
            }
          : policy
      ));
      await fetchApi(`/organizations/${encodeURIComponent(orgName)}/token-ttl-policies`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            type: "organization-token-ttl-policies",
            attributes: {
              "token-ttl-policies": updatedPolicies.map((policy: TokenTTLPolicy): Record<string, unknown> => ({
                "token-type": policy.attributes["token-type"],
                "max-ttl-ms": policy.attributes["max-ttl-ms"],
              })),
            },
          },
        }),
      });
      setEditingPolicy(null);
      await loadTokenTTLPolicies();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Failed to update token TTL policy.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Token TTL policies</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Token TTL policies limit the maximum lifespan of tokens created in this organization.
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
          ) : policies.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
              <Hourglass className="h-8 w-8" />
              <p className="text-sm">No token TTL policies.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Token type</TableHead>
                  <TableHead>Max TTL</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {policies.map((policy): React.JSX.Element => (
                  <TableRow key={policy.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Hourglass className="h-4 w-4 text-muted-foreground" />
                        {humanizeTokenType(policy.attributes["token-type"])}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatMaxTtl(policy.attributes["max-ttl-ms"])}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(policy.attributes["updated-at"])}</TableCell>
                    <TableCell>
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={(): void => { openEditDialog(policy); }}
                          aria-label={`Edit ${humanizeTokenType(policy.attributes["token-type"])} TTL policy`}
                        >
                          <Pencil className="h-4 w-4" />
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

      <Dialog open={editingPolicy !== null} onOpenChange={(open: boolean): void => { if (!open) setEditingPolicy(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Edit {editingPolicy === null ? "" : humanizeTokenType(editingPolicy.attributes["token-type"])} TTL policy
            </DialogTitle>
            <DialogDescription>
              Set the maximum lifespan for {editingPolicy === null ? "" : humanizeTokenType(editingPolicy.attributes["token-type"])} tokens.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Max TTL</label>
              <Input
                type="number"
                min={0}
                value={editingValue}
                onChange={(e): void => { setEditingValue(e.target.value); }}
                placeholder="2592000000"
              />
              <p className="text-xs text-muted-foreground">Value in milliseconds.</p>
            </div>
            {formError !== "" && <div className="text-sm text-red-500">{formError}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={(): void => { setEditingPolicy(null); }}>Cancel</Button>
            <Button onClick={savePolicy} disabled={saving}>
              {saving ? <Spinner /> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
