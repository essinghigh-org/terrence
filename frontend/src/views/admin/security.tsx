import { useEffect, useState } from "react";
import { fetchApi } from "../../lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { type DataItem, type SecuritySummary, } from "./types";
function ProviderStatusRow(props: Readonly<{ label: string; enabled: boolean }>): React.JSX.Element {
  const { label, enabled } = props;
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
      <span>{label}</span>
      <span className={enabled ? "font-medium text-success" : "text-muted-foreground"}>{enabled ? "Enabled" : "Disabled"}</span>
    </div>
  );
}
type DatabaseMetrics = Readonly<{
  sizeBytes: number;
  walSizeBytes: number | null;
  journalMode: string;
  pageSize: number;
  pageCount: number;
  path: string;
}>;
function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
function DatabaseStorageCard(): React.JSX.Element {
  const [metrics, setMetrics] = useState<DatabaseMetrics | null>(null);
  useEffect((): (() => void) => {
    let cancelled = false;
    void fetchApi<{ data?: DatabaseMetrics | null }>("/api/v2/admin/database-metrics")
      .then((body): void => {
        if (!cancelled) {
          setMetrics(body.data ?? null);
        }
      })
      .catch((): void => {
        // Admin-only page; a failed metrics fetch leaves the card empty.
      });
    return (): void => {
      cancelled = true;
    };
  }, []);
  const totalBytes = metrics === null ? null : metrics.sizeBytes + (metrics.walSizeBytes ?? 0);
  const renderRow = (label: string, value: string): React.JSX.Element => (
    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
      <span>{label}</span>
      <span className="font-mono text-xs text-foreground/85">{value}</span>
    </div>
  );
  return (
    <Card>
      <CardHeader variant="section">
        <CardTitle className="text-base">Database storage</CardTitle>
        <CardDescription>On-disk footprint of the SQLite store.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {metrics === null ? (
          renderRow("Total on disk", "—")
        ) : (
          <>
            {renderRow("Total on disk", formatBytes(totalBytes))}
            {renderRow("Database file", formatBytes(metrics.sizeBytes))}
            {renderRow("WAL sidecar", formatBytes(metrics.walSizeBytes))}
            {renderRow("Journal mode", metrics.journalMode)}
          </>
        )}
      </CardContent>
    </Card>
  );
}
export function SecurityOverview(props: Readonly<{
  navigate: (path: string) => void;
  samlEnabled: boolean;
  oidcEnabled: boolean;
  ldapEnabled: boolean;
  securitySummary: SecuritySummary;
  users: DataItem[];
  auditLogs: DataItem[];
}>): React.JSX.Element {
  const { navigate, samlEnabled, oidcEnabled, ldapEnabled, securitySummary, users, auditLogs } = props;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Site overview</h2>
        <p className="text-sm text-muted-foreground">A quick read of the instance-wide controls that protect access and runs.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader variant="section">
            <CardTitle className="text-base">Identity providers</CardTitle>
            <CardDescription>Configured sign-in paths for this instance.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ProviderStatusRow label="SAML SSO" enabled={samlEnabled} />
            <ProviderStatusRow label="OpenID Connect" enabled={oidcEnabled} />
            <ProviderStatusRow label="LDAP" enabled={ldapEnabled} />
            <Button variant="outline" size="sm" onClick={(): void => { navigate("/app/admin/auth"); }}>
              Open authentication settings
            </Button>
          </CardContent>
        </Card>
        <DatabaseStorageCard />
        <Card>
          <CardHeader variant="section">
            <CardTitle className="text-base">Account safeguards</CardTitle>
            <CardDescription>Local access and privileged-account posture.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>Local account signup</span>
              <span className={securitySummary.signupEnabled ? "font-medium text-warning" : "font-medium text-success"}>
                {securitySummary.signupEnabled ? "Enabled" : "Disabled"}
              </span>
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>Site administrators</span>
              <span className="font-medium text-foreground">{users.filter((item): boolean => item.attributes["is-site-admin"] === true).length}</span>
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>Suspended users</span>
              <span className="font-medium text-foreground">{users.filter((item): boolean => item.attributes["is-suspended"] === true).length}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader variant="section">
            <CardTitle className="text-base">Execution isolation</CardTitle>
            <CardDescription>Whether Terraform runs are required and supported by the host.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>Sandbox required</span>
              <span className={securitySummary.sandboxEnabled ? "font-medium text-success" : "font-medium text-warning"}>
                {securitySummary.sandboxEnabled ? "Yes" : "No"}
              </span>
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>Sandbox available</span>
              <span className={securitySummary.sandboxAvailable ? "font-medium text-success" : "font-medium text-destructive"}>
                {securitySummary.sandboxAvailable ? "Available" : "Unavailable"}
              </span>
            </div>
            {securitySummary.sandboxReason !== null && (
              <p className="text-xs text-muted-foreground">{securitySummary.sandboxReason}</p>
            )}
            {securitySummary.sandboxExtraRwAllowed && (
              <div className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-warning">
                Warning: extra sandbox read-write paths are enabled (TERRENCE_SANDBOX_EXTRA_RW_ALLOWED). The sandbox allow-list is widened beyond the default.
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader variant="section">
            <CardTitle className="text-base">Latest audit events</CardTitle>
            <CardDescription>Most recent administrative events returned by the instance.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-2xl font-semibold text-foreground">{auditLogs.length}</p>
            <p className="text-sm text-muted-foreground">
              {auditLogs.length === 0 ? "No recent events returned" : `Showing ${auditLogs.length} latest event${auditLogs.length === 1 ? "" : "s"}`}
            </p>
            {auditLogs[0]?.attributes.action !== undefined && (
              <p className="truncate text-sm text-foreground/85">Latest: {auditLogs[0].attributes.action}</p>
            )}
            <Button variant="outline" size="sm" onClick={(): void => { navigate("/app/admin/audit"); }}>
              Open audit log
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};