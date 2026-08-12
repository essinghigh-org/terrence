import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi, ApiError } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useOrganizationPermissions } from "../hooks/useOrganizationPermissions";
import { FileClock, KeyRound, RefreshCw, ShieldX } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

type AuditTrailToken = {
  id: string;
  attributes: {
    "expired-at"?: string | null;
    "created-at"?: string | null;
  };
};

type AuditTrailTokenResponse = {
  data: AuditTrailToken & { attributes: { token?: string | null } };
};

export function AuditTrailTokens(): React.JSX.Element {
  const { orgName: rawOrgName } = useParams<{ orgName: string }>();
  const orgName = rawOrgName ?? "";
  const [token, setToken] = useState<AuditTrailToken | null>(null);
  const [generatedToken, setGeneratedToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const activeOrganizationName = useRef(orgName);
  activeOrganizationName.current = orgName;
  const orgPermissions = useOrganizationPermissions(orgName === "" ? undefined : orgName);
  const canManage = orgName !== "" && orgPermissions.loaded && orgPermissions.has("can-manage-auditing");

  const [expiresIn, setExpiresIn] = useState("");
  const [generating, setGenerating] = useState(false);
  const [actionError, setActionError] = useState("");
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  useEffect((): void => {
    setToken(null);
    setGeneratedToken("");
    setActionError("");
    permissionGateFired.current = false;
  }, [orgName]);

  // Central permission gate (14.6): once org permissions load, surface a clear
  // error when the operator lacks access. When access is granted, load the data
  // exactly once (the initial call early-returns while permissions are loading).
  const permissionGateFired = useRef(false);
  useEffect((): void => {
    if (!orgPermissions.loaded) return;
    if (orgPermissions.has("can-manage-auditing")) {
      setError("");
      if (!permissionGateFired.current) {
        permissionGateFired.current = true;
        void loadAuditTrailToken();
      }
    } else {
      setError(orgPermissions.error ?? "You do not have permission to manage the audit trail token for this organization.");
    }
  }, [orgPermissions.loaded, orgPermissions.has]);

  const loadAuditTrailToken = async (): Promise<void> => {
    const requestedOrganizationName = orgName;
    setLoading(true);
    setError("");
    if (!canManage) {
      setLoading(false);
      return;
    }
    try {
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(requestedOrganizationName)}/authentication-token?token=audit-trails`,
      ) as { data: AuditTrailToken };
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      setToken(response.data);
    } catch (reason) {
      if (activeOrganizationName.current !== requestedOrganizationName) return;
      if (reason instanceof ApiError && reason.status === 404) {
        setToken(null);
      } else {
        setError(reason instanceof Error ? reason.message : "Failed to load the audit trail token.");
      }
    } finally {
      if (activeOrganizationName.current === requestedOrganizationName) setLoading(false);
    }
  };

  const generateToken = async (): Promise<void> => {
    setGenerating(true);
    setActionError("");
    try {
      const attributes: Record<string, unknown> = {};
      if (expiresIn.trim() !== "") {
        attributes["expired-at"] = expiresIn.trim();
      }
      const response = await fetchApi(
        `/organizations/${encodeURIComponent(orgName)}/authentication-token?token=audit-trails`,
        {
          method: "POST",
          body: JSON.stringify({
            data: {
              type: "authentication-tokens",
              attributes,
            },
          }),
        },
      ) as AuditTrailTokenResponse;
      const secret = response.data.attributes.token;
      setGeneratedToken(typeof secret === "string" ? secret : "");
      setExpiresIn("");
      await loadAuditTrailToken();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Failed to generate the audit trail token.");
    } finally {
      setGenerating(false);
    }
  };

  const revokeToken = async (): Promise<void> => {
    setRevoking(true);
    try {
      await fetchApi(
        `/organizations/${encodeURIComponent(orgName)}/authentication-token?token=audit-trails`,
        { method: "DELETE" },
      );
      setToken(null);
      setGeneratedToken("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to revoke the audit trail token.");
    } finally {
      setRevoking(false);
      setRevokeOpen(false);
    }
  };

  const formatExpiry = (value: string | null | undefined): string => {
    if (value === null || value === undefined || value === "") return "Never";
    return value;
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow={`${orgName} / Settings`}
        title="Audit trail token"
        description="An organization-scoped token used to export audit trail (activity log) records."
        action={canManage ? (
          <Button onClick={(): void => { void generateToken(); }} disabled={generating}>
            <RefreshCw className={generating ? "mr-2 h-4 w-4 animate-spin" : "mr-2 h-4 w-4"} />
            {token !== null ? "Rotate token" : "Generate new token"}
          </Button>
        ) : undefined}
      />

      {actionError !== "" && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {generatedToken !== "" && (
        <div className="space-y-2 rounded-md border p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            Your new token
          </div>
          <pre className="break-all whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-sm">{generatedToken}</pre>
          <p className="text-xs text-muted-foreground">The token is only shown once. Copy it now and store it somewhere safe.</p>
        </div>
      )}

      <Card>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : error !== "" ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{error}</div>
          ) : token === null ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
              <FileClock className="h-8 w-8" />
              <p className="text-sm">No audit trail token has been generated for this organization.</p>
              {canManage && (
                <p className="max-w-md text-xs">
                  Generate a token to authenticate audit trail ingestion.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <FileClock className="h-5 w-5 text-muted-foreground" />
                <span className="font-medium">Current token</span>
              </div>
              <dl className="grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Token ID</dt>
                  <dd className="mt-1 truncate font-mono text-sm text-foreground">{token.id}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Expires at</dt>
                  <dd className="mt-1 text-sm text-foreground">
                    {formatExpiry(token.attributes["expired-at"])}
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </CardContent>
      </Card>

      {canManage ? (
        <Card>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="expires-in">Expires in</label>
              <Input
                id="expires-in"
                name="expires-in"
                autoComplete="off"
                spellCheck={false}
                value={expiresIn}
                onChange={(e): void => { setExpiresIn(e.target.value); }}
                placeholder="ISO timestamp, e.g. 2026-12-31T23:59:59.000Z (leave empty for no expiry)"
              />
              <p className="text-xs text-muted-foreground">
                Optional expiry timestamp applied when generating a new token. Leave blank to create a token that never expires.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={(): void => { void generateToken(); }} disabled={generating}>
                {generating ? <Spinner data-icon="inline-start" /> : <KeyRound data-icon="inline-start" />}
                {generating ? "Generating token…" : "Generate new token"}
              </Button>
              {token !== null && (
                <Button variant="destructive" onClick={(): void => { setRevokeOpen(true); }} disabled={revoking}>
                  <ShieldX className="mr-2 h-4 w-4" />
                  Revoke
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <ConfirmDialog
        open={revokeOpen}
        onOpenChange={(open): void => { if (!open) setRevokeOpen(false); }}
        title="Revoke audit trail token"
        description="Revoking the audit trail token will immediately invalidate it. Any clients using this token will stop being able to authenticate. This cannot be undone."
        confirmText="Revoke token"
        confirmVariant="destructive"
        loading={revoking}
        onConfirm={revokeToken}
      />
    </PageShell>
  );
}
