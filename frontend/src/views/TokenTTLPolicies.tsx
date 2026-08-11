import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { formatDate } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Spinner } from "../components/ui/spinner";
import { Select } from "../components/ui/select";
import { Hourglass, Pencil, Plus, Trash2 } from "lucide-react";

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

// The token slots the backend actually stores (see db/schema.ts
// orgTokenTTLPolicies). New policies are picked from this list instead of
// asking the user to type a token type.
const TOKEN_TYPES: readonly { value: string; label: string }[] = [
  { value: "user", label: "User tokens" },
  { value: "organization", label: "Organization token" },
  { value: "audit-trails", label: "Audit trail token" },
];

// The backend stores the user-token slot as an empty string (see
// db/schema.ts apiTokens.tokenType), which is unusable as a <select> option
// value because it collides with "no selection". The UI uses "user" as the
// option value and maps it back to "" on submit.
function toTokenTypeSlot(optionValue: string): string {
  return optionValue === "user" ? "" : optionValue;
}

function humanizeTokenType(tokenType: string): string {
  if (tokenType === "") return "User tokens";
  const words = tokenType.replace(/-/g, " ").trim().split(/\s+/);
  const humanized = words
    .map((word: string): string => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return humanized === "" ? "User tokens" : humanized;
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

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [newTokenType, setNewTokenType] = useState("");
  const [newMaxTtl, setNewMaxTtl] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect((): void => {
    setPolicies([]);
    setManageableOrganizationName("");
    setEditingPolicy(null);
    setAddDialogOpen(false);
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

  // The backend PATCH endpoint replaces the whole list, so every mutation
  // (add, edit, delete) is expressed as a new full list.
  const persistPolicies = async (next: TokenTTLPolicy[]): Promise<void> => {
    await fetchApi(`/organizations/${encodeURIComponent(orgName)}/token-ttl-policies`, {
      method: "PATCH",
      body: JSON.stringify({
        data: {
          type: "organization-token-ttl-policies",
          attributes: {
            "token-ttl-policies": next.map((policy: TokenTTLPolicy): Record<string, unknown> => ({
              "token-type": policy.attributes["token-type"],
              "max-ttl-ms": policy.attributes["max-ttl-ms"],
            })),
          },
        },
      }),
    });
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
          ? { ...policy, attributes: { ...policy.attributes, "max-ttl-ms": maxTtlMs } }
          : policy
      ));
      await persistPolicies(updatedPolicies);
      setEditingPolicy(null);
      await loadTokenTTLPolicies();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Failed to update token TTL policy.");
    } finally {
      setSaving(false);
    }
  };

  const openAddDialog = (): void => {
    // Preselect the first token type that does not yet have a policy.
    const configured = new Set(policies.map((policy: TokenTTLPolicy): string => policy.attributes["token-type"]));
    const firstFree = TOKEN_TYPES.find((option): boolean => !configured.has(toTokenTypeSlot(option.value)));
    setNewTokenType(firstFree?.value ?? "");
    setNewMaxTtl("");
    setFormError("");
    setAddDialogOpen(true);
  };

  const addPolicy = async (): Promise<void> => {
    const configured = new Set(policies.map((policy: TokenTTLPolicy): string => policy.attributes["token-type"]));
    if (newTokenType === "" || configured.has(toTokenTypeSlot(newTokenType))) {
      setFormError("Choose a token type that does not already have a policy.");
      return;
    }
    const trimmed = newMaxTtl.trim();
    if (trimmed === "") {
      setFormError("Max TTL is required.");
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setFormError("Max TTL must be a non-negative number of milliseconds.");
      return;
    }
    setAdding(true);
    setFormError("");
    try {
      const nowIso = new Date().toISOString();
      const next: TokenTTLPolicy[] = [
        ...policies,
        {
          id: `ttl-${crypto.randomUUID()}`,
          attributes: {
            "token-type": toTokenTypeSlot(newTokenType),
            "max-ttl-ms": Math.trunc(parsed),
            "created-at": nowIso,
            "updated-at": nowIso,
          },
        },
      ];
      await persistPolicies(next);
      setAddDialogOpen(false);
      await loadTokenTTLPolicies();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Failed to add token TTL policy.");
    } finally {
      setAdding(false);
    }
  };

  const deletePolicy = async (policy: TokenTTLPolicy): Promise<void> => {
    setSaving(true);
    setFormError("");
    try {
      const next = policies.filter((p: TokenTTLPolicy): boolean => p.id !== policy.id);
      await persistPolicies(next);
      await loadTokenTTLPolicies();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Failed to delete token TTL policy.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Token TTL policies</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Token TTL policies limit the maximum lifespan of tokens created in this organization.
          </p>
        </div>
        {canManage && (
          <Button onClick={openAddDialog}>
            <Plus className="mr-1.5 size-4" /> Add policy
          </Button>
        )}
      </div>

      {formError !== "" && (
        <div role="alert" className="rounded-md bg-destructive/15 p-3 text-sm font-medium text-destructive">
          {formError}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Token type</TableHead>
                <TableHead>Max TTL</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-20" />
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
              ) : policies.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Hourglass className="h-8 w-8 text-muted-foreground/60" />
                      <p className="text-sm">No token TTL policies.</p>
                      {canManage && (
                        <p className="text-xs text-muted-foreground">
                          Add a policy to cap how long each token type can live.
                        </p>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ) : policies.map((policy): React.JSX.Element => (
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
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={(): void => { openEditDialog(policy); }}
                            aria-label={`Edit ${humanizeTokenType(policy.attributes["token-type"])} TTL policy`}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={(): void => { void deletePolicy(policy); }}
                            disabled={saving}
                            aria-label={`Delete ${humanizeTokenType(policy.attributes["token-type"])} TTL policy`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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

      <Dialog open={addDialogOpen} onOpenChange={(open: boolean): void => { if (!open) setAddDialogOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add token TTL policy</DialogTitle>
            <DialogDescription>
              Cap the maximum lifespan for a token type that has no policy yet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Token type</label>
              <Select
                value={newTokenType}
                onValueChange={(value: string): void => { setNewTokenType(value); }}
              >
                {TOKEN_TYPES.map((option): React.JSX.Element => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={policies.some((policy: TokenTTLPolicy): boolean => policy.attributes["token-type"] === toTokenTypeSlot(option.value))}
                  >
                    {option.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Token types that already have a policy are shown but cannot be chosen.
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Max TTL</label>
              <Input
                type="number"
                min={0}
                value={newMaxTtl}
                onChange={(e): void => { setNewMaxTtl(e.target.value); }}
                placeholder="2592000000"
              />
              <p className="text-xs text-muted-foreground">Value in milliseconds.</p>
            </div>
            {formError !== "" && <div className="text-sm text-red-500">{formError}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={(): void => { setAddDialogOpen(false); }}>Cancel</Button>
            <Button onClick={addPolicy} disabled={adding}>
              {adding ? <Spinner /> : "Add policy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
