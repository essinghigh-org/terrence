import { useState, useEffect } from "react";
import { Navigate, useNavigate, useOutletContext } from "react-router-dom";
import { fetchAllApiPages, fetchApi } from "../lib/api";
import { formatDateTime } from "../lib/utils";
import type { LayoutOutletContext } from "../components/Layout";
import {
  Shield,
  CheckCircle2,
  AlertCircle,
  Plus,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { toast } from "../components/ui/toast";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { PageHeader, PageShell } from "../components/PageHeader";

export type AdminSection =
  | "security"
  | "users"
  | "orgs"
  | "workspaces"
  | "runs"
  | "versions"
  | "audit"
  | "auth";

const attrString = (attrs: Record<string, unknown>, key: string, fallback: string): string => {
  const value = attrs[key];
  return typeof value === "string" ? value : fallback;
};

const attrBoolean = (attrs: Record<string, unknown>, key: string, fallback: boolean): boolean => {
  const value = attrs[key];
  return typeof value === "boolean" ? value : fallback;
};

async function saveAuthSettings(options: Readonly<{
  setSaving: (saving: boolean) => void;
  setError: (error: string | null) => void;
  save: () => Promise<void>;
  reload: () => void;
  successTitle: string;
  fallbackError: string;
}>): Promise<void> {
  options.setSaving(true);
  options.setError(null);
  try {
    await options.save();
    options.reload();
    toast.add({ title: options.successTitle, type: "success" });
  } catch (err: unknown) {
    options.setError(err instanceof Error ? err.message : options.fallbackError);
  } finally {
    options.setSaving(false);
  }
}
type ItemAttrs = {
  username?: string;
  email?: string | null;

  "is-site-admin"?: boolean;
  "is-suspended"?: boolean;
  name?: string;

  "iac-binary"?: string;

  "default-terraform-version"?: string;

  "auto-apply"?: boolean;
  locked?: boolean;
  status?: string;
  message?: string | null;

  "has-changes"?: boolean;

  actions?: {
    "is-cancelable"?: boolean;
    "is-force-cancelable"?: boolean;
  };
  version?: string;
  url?: string | null;
  sha?: string | null;

  "created-at"?: string;
  action?: string;

  "resource-type"?: string;

  "resource-id"?: string | null;
  "actor-username"?: string | null;
  "actor-email"?: string | null;
  [key: string]: unknown;
};

type DataItem = { id: string; attributes: ItemAttrs };

type SecuritySummary = Readonly<{
  signupEnabled: boolean;
  sandboxEnabled: boolean;
  sandboxAvailable: boolean;
  sandboxReason: string | null;
}>;

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
    void fetchApi("/api/v2/admin/database-metrics")
      .then((body: unknown): void => {
        if (!cancelled) setMetrics((body as { data?: DatabaseMetrics | null }).data ?? null);
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

function SecurityOverview(props: Readonly<{
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
                <h2 className="text-lg font-semibold text-foreground">Security overview</h2>
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
}

function UsersAdmin(props: Readonly<{
  users: DataItem[];
  setCreateDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setDeleteUserId: React.Dispatch<React.SetStateAction<{ id: string; label: string } | null>>;
  loadAdminData: () => Promise<void>;
}>): React.JSX.Element {
  const { users, setCreateDialogOpen, setDeleteUserId, loadAdminData } = props;
  const runUserAction = (id: string, actionPath: string, successTitle: string, failureTitle: string): void => {
    void fetchApi(`/api/v2/admin/users/${id}/actions/${actionPath}`, { method: "POST" })
      .then((): void => { void loadAdminData(); toast.add({ title: successTitle, type: "success" }); })
      .catch((err: unknown): void => { toast.add({ title: failureTitle, description: err instanceof Error ? err.message : "Unknown error", type: "error" }); });
  };
  return (
            <Card>
              <CardHeader variant="section">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle className="text-lg">Registered Users</CardTitle>
                    <CardDescription>Manage user accounts across this instance. Use the admin user creation form to add local accounts.</CardDescription>
                  </div>
                  <Button
                    size="sm"
                    className="gap-2 self-start sm:self-auto"
                    onClick={(): void => { setCreateDialogOpen(true); }}
                  >
                    <Plus className="h-4 w-4" />
                    Create user
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-x-auto">
                  <Table className="w-full text-left text-sm">
                    <TableHeader className="bg-muted border-b text-muted-foreground font-medium">
                      <TableRow>
                        <TableHead className="px-4 py-3">Username</TableHead>
                        <TableHead className="px-4 py-3">Email</TableHead>
                        <TableHead className="px-4 py-3">Site Admin</TableHead>
                        <TableHead className="px-4 py-3">Status</TableHead>
                        <TableHead className="px-4 py-3">User ID</TableHead>
                        <TableHead className="px-4 py-3">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="divide-y">
                      {users.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                            No users found.
                          </TableCell>
                        </TableRow>
                      ) : (
                        users.map((u): React.JSX.Element => (
                          <TableRow key={u.id} className="hover:bg-muted/50">
                            <TableCell className="px-4 py-3 font-medium text-foreground">{u.attributes.username}</TableCell>
                            <TableCell className="px-4 py-3 text-muted-foreground">{u.attributes.email ?? "—"}</TableCell>
                            <TableCell className="px-4 py-3">
                              {u.attributes["is-site-admin"] === true ? (
                                <span className="inline-flex items-center gap-1 rounded bg-success/10 px-2 py-0.5 text-xs font-semibold text-success border border-success/30">
                                  <CheckCircle2 className="h-3 w-3" /> Yes
                                </span>
                              ) : (
                                <span className="text-muted-foreground/70 text-xs">No</span>
                              )}
                            </TableCell>
                            <TableCell className="px-4 py-3">
                              {u.attributes["is-suspended"] === true ? (
                                <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive border border-destructive/30">
                                  Suspended
                                </span>
                              ) : (
                                <span className="text-muted-foreground/70 text-xs">Active</span>
                              )}
                            </TableCell>
                            <TableCell className="px-4 py-3 text-xs font-mono text-muted-foreground/70">{u.id}</TableCell>
                            <TableCell className="px-4 py-3">
                              <div className="flex gap-1.5 flex-wrap">
                                {/* Promote / Demote Admin */}
                                {u.attributes["is-site-admin"] === true ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    onClick={(): void => { runUserAction(u.id, "revoke_admin", "Admin privileges revoked", "Failed to revoke admin"); }}
                                  >
                                    Demote
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    onClick={(): void => { runUserAction(u.id, "grant_admin", "Admin privileges granted", "Failed to grant admin"); }}
                                  >
                                    Promote
                                  </Button>
                                )}
                                {/* Suspend / Unsuspend */}
                                {u.attributes["is-suspended"] === true ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    onClick={(): void => { runUserAction(u.id, "unsuspend", "User unsuspended", "Failed to unsuspend"); }}
                                  >
                                    Unsuspend
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    onClick={(): void => { runUserAction(u.id, "suspend", "User suspended", "Failed to suspend"); }}
                                  >
                                    Suspend
                                  </Button>
                                )}
                                {/* Delete */}
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  className="h-7 text-xs"
                                  aria-label="Delete user"
                                  onClick={(): void => { setDeleteUserId({ id: u.id, label: u.attributes.username ?? u.id }); }}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
  );
}

function OrgsAdmin(props: Readonly<{ orgs: DataItem[]; }>): React.JSX.Element {
  const { orgs } = props;
  return (
            <Card>
              <CardHeader variant="section">
                <CardTitle className="text-lg">Organizations</CardTitle>
                <CardDescription>Overview of all active tenant organizations</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-x-auto">
                  <Table className="w-full text-left text-sm">
                    <TableHeader className="bg-muted border-b text-muted-foreground font-medium">
                      <TableRow>
                        <TableHead className="px-4 py-3">Organization Name</TableHead>
                        <TableHead className="px-4 py-3">Default Engine</TableHead>
                        <TableHead className="px-4 py-3">Default Version</TableHead>
                        <TableHead className="px-4 py-3">Org ID</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="divide-y">
                      {orgs.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                            No organizations found.
                          </TableCell>
                        </TableRow>
                      ) : (
                        orgs.map((o): React.JSX.Element => (
                          <TableRow key={o.id} className="hover:bg-muted/50">
                            <TableCell className="px-4 py-3 font-medium text-foreground">{o.attributes.name}</TableCell>
                            <TableCell className="px-4 py-3">
                              <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary border border-primary/20">
                                {o.attributes["iac-binary"] ?? "tofu"}
                              </span>
                            </TableCell>
                            <TableCell className="px-4 py-3 text-muted-foreground">{o.attributes["default-terraform-version"] ?? "latest"}</TableCell>
                            <TableCell className="px-4 py-3 text-xs font-mono text-muted-foreground/70">{o.id}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
  );
}

function WorkspacesAdmin(props: Readonly<{ workspaces: DataItem[]; }>): React.JSX.Element {
  const { workspaces } = props;
  return (
            <Card>
              <CardHeader variant="section">
                <CardTitle className="text-lg">Workspaces</CardTitle>
                <CardDescription>Instance-wide inventory of managed infrastructure workspaces</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-x-auto">
                  <Table className="w-full text-left text-sm">
                    <TableHeader className="bg-muted border-b text-muted-foreground font-medium">
                      <TableRow>
                        <TableHead className="px-4 py-3">Workspace Name</TableHead>
                        <TableHead className="px-4 py-3">Auto Apply</TableHead>
                        <TableHead className="px-4 py-3">Lock Status</TableHead>
                        <TableHead className="px-4 py-3">Workspace ID</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="divide-y">
                      {workspaces.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                            No workspaces found.
                          </TableCell>
                        </TableRow>
                      ) : (
                        workspaces.map((w): React.JSX.Element => (
                          <TableRow key={w.id} className="hover:bg-muted/50">
                            <TableCell className="px-4 py-3 font-medium text-foreground">{w.attributes.name}</TableCell>
                            <TableCell className="px-4 py-3 text-muted-foreground">{w.attributes["auto-apply"] === true ? "Enabled" : "Disabled"}</TableCell>
                            <TableCell className="px-4 py-3">
                              {w.attributes.locked === true ? (
                                <span className="rounded bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning border border-warning/30">
                                  Locked
                                </span>
                              ) : (
                                <span className="text-muted-foreground/70 text-xs">Unlocked</span>
                              )}
                            </TableCell>
                            <TableCell className="px-4 py-3 text-xs font-mono text-muted-foreground/70">{w.id}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
  );
}

function RunsAdmin(props: Readonly<{ runs: DataItem[]; handleCancelRun: (runId: string, force?: boolean) => Promise<void>; }>): React.JSX.Element {
  const { runs, handleCancelRun } = props;
  return (
            <Card>
              <CardHeader variant="section">
                <CardTitle className="text-lg">System run queue</CardTitle>
                <CardDescription>Monitor and control active execution runs</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-x-auto">
                  <Table className="w-full text-left text-sm">
                    <TableHeader className="bg-muted border-b text-muted-foreground font-medium">
                      <TableRow>
                        <TableHead className="px-4 py-3">Run ID</TableHead>
                        <TableHead className="px-4 py-3">Status</TableHead>
                        <TableHead className="px-4 py-3">Message</TableHead>
                        <TableHead className="px-4 py-3">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="divide-y">
                      {runs.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                            No active runs found.
                          </TableCell>
                        </TableRow>
                      ) : (
                        runs.map((r): React.JSX.Element => (
                          <TableRow key={r.id} className="hover:bg-muted/50">
                            <TableCell className="px-4 py-3 font-mono text-xs font-semibold text-foreground">{r.id}</TableCell>
                            <TableCell className="px-4 py-3">
                              <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                                {r.attributes.status}
                              </span>
                            </TableCell>
                            <TableCell className="px-4 py-3 text-muted-foreground">{r.attributes.message ?? "—"}</TableCell>
                            <TableCell className="px-4 py-3">
                              {r.attributes.actions !== undefined && (
                                <div className="flex gap-2">
                                  {r.attributes.actions["is-cancelable"] === true && (
                                    <Button size="sm" variant="outline" onClick={(): void => { void handleCancelRun(r.id, false); }}>
                                      Cancel
                                    </Button>
                                  )}
                                  {r.attributes.actions["is-force-cancelable"] === true && (
                                    <Button size="sm" variant="destructive" onClick={(): void => { void handleCancelRun(r.id, true); }}>
                                      Force Cancel
                                    </Button>
                                  )}
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
  );
}

function VersionsAdmin(props: Readonly<{
  handleAddVersion: (event: React.SyntheticEvent) => Promise<void>;
  newVersion: string;
  setNewVersion: React.Dispatch<React.SetStateAction<string>>;
  newUrl: string;
  setNewUrl: React.Dispatch<React.SetStateAction<string>>;
  newSha: string;
  setNewSha: React.Dispatch<React.SetStateAction<string>>;
  tfVersions: DataItem[];
  setVersionToDelete: React.Dispatch<React.SetStateAction<{ id: string; label: string } | null>>;
}>): React.JSX.Element {
  const { handleAddVersion, newVersion, setNewVersion, newUrl, setNewUrl, newSha, setNewSha, tfVersions, setVersionToDelete } = props;
  return (
            <div className="space-y-6">
              <Card>
                <CardHeader variant="section">
                  <CardTitle className="text-lg">Register a Terraform version</CardTitle>
                  <CardDescription>Add binary versions available for workspace execution</CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleAddVersion} className="flex gap-4 items-end">
                    <div className="space-y-1 flex-1">
                      <label className="text-xs font-medium text-foreground/85" htmlFor="admin-version">Version</label>
                      <Input
                        id="admin-version"
                        name="version"
                        placeholder="1.6.2"
                        value={newVersion}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setNewVersion(event.target.value); }}
                        required
                      />
                    </div>
                    <div className="space-y-1 flex-1">
                      <label className="text-xs font-medium text-foreground/85" htmlFor="admin-version-url">Download URL (Optional)</label>
                      <Input
                        id="admin-version-url"
                        name="download-url"
                        type="url"
                        placeholder="https://releases.hashicorp.com/terraform/…"
                        value={newUrl}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setNewUrl(event.target.value); }}
                      />
                    </div>
                    <div className="space-y-1 flex-1">
                      <label className="text-xs font-medium text-foreground/85" htmlFor="admin-version-sha">SHA256 (Optional)</label>
                      <Input
                        id="admin-version-sha"
                        name="sha256"
                        autoComplete="off"
                        placeholder="a1b2c3…"
                        value={newSha}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setNewSha(event.target.value); }}
                      />
                    </div>
                    <Button type="submit" className="gap-2">
                      <Plus className="h-4 w-4" /> Add Version
                    </Button>
                  </form>
                </CardContent>
              </Card>

              <Card>
                <CardHeader variant="section">
                  <CardTitle className="text-lg">Available Terraform and OpenTofu versions</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="rounded-md border overflow-x-auto">
                    <Table className="w-full text-left text-sm">
                      <TableHeader className="bg-muted border-b text-muted-foreground font-medium">
                        <TableRow>
                          <TableHead className="px-4 py-3">Version</TableHead>
                          <TableHead className="px-4 py-3">URL</TableHead>
                          <TableHead className="px-4 py-3">SHA256</TableHead>
                          <TableHead className="px-4 py-3">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody className="divide-y">
                        {tfVersions.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                              No custom versions registered. Defaulting to the latest releases.
                            </TableCell>
                          </TableRow>
                        ) : (
                          tfVersions.map((v): React.JSX.Element => (
                            <TableRow key={v.id} className="hover:bg-muted/50">
                              <TableCell className="px-4 py-3 font-semibold text-foreground">{v.attributes.version}</TableCell>
                            <TableCell className="px-4 py-3 text-xs text-muted-foreground truncate max-w-xs">{v.attributes.url ?? "Default download"}</TableCell>
                            <TableCell className="px-4 py-3 text-xs font-mono text-muted-foreground/70">{v.attributes.sha != null ? v.attributes.sha.slice(0, 12) + "…" : "—"}</TableCell>
                            <TableCell className="px-4 py-3">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive hover:text-destructive"
                                aria-label="Delete version"
                                onClick={(): void => { setVersionToDelete({ id: v.id, label: v.attributes.version ?? v.id }); }}
                              >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </div>
  );
}

function AuditAdmin(props: Readonly<{ auditLogs: DataItem[]; }>): React.JSX.Element {
  const { auditLogs } = props;
  return (
            <Card>
              <CardHeader variant="section">
                <CardTitle className="text-lg">Instance Audit Trail</CardTitle>
                <CardDescription>Security audit log of administrative actions</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-x-auto">
                  <Table className="w-full text-left text-sm">
                    <TableHeader className="bg-muted border-b text-muted-foreground font-medium">
                      <TableRow>
                        <TableHead className="px-4 py-3">Timestamp</TableHead>
                        <TableHead className="px-4 py-3">Action</TableHead>
                        <TableHead className="px-4 py-3">Resource Type</TableHead>
                        <TableHead className="px-4 py-3">Resource ID</TableHead>
                        <TableHead className="px-4 py-3">Actor</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="divide-y">
                      {auditLogs.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                            No audit log entries recorded.
                          </TableCell>
                        </TableRow>
                      ) : (
                        auditLogs.map((log): React.JSX.Element => (
                          <TableRow key={log.id} className="hover:bg-muted/50">
                            <TableCell className="px-4 py-3 text-xs text-muted-foreground">{formatDateTime(log.attributes["created-at"])}</TableCell>
                            <TableCell className="px-4 py-3 font-medium text-foreground">{log.attributes.action}</TableCell>
                            <TableCell className="px-4 py-3 text-muted-foreground">{log.attributes["resource-type"]}</TableCell>
                            <TableCell className="px-4 py-3 text-xs font-mono text-muted-foreground/70">{log.attributes["resource-id"] ?? "—"}</TableCell>
                            <TableCell className="px-4 py-3 text-muted-foreground">
                              {log.attributes["actor-username"] ?? log.attributes["actor-email"] ?? "System"}
                              {log.attributes["actor-email"] !== null && log.attributes["actor-email"] !== undefined && (
                                <span className="block text-xs text-muted-foreground/70">{log.attributes["actor-email"]}</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
  );
}

function AuthAdmin(props: Readonly<{
  general: Readonly<{
    loading: boolean;
    saving: boolean;
    error: string | null;
    localAuthEnabled: boolean;
    setLocalAuthEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    trustedClientIpHeaders: string;
    setTrustedClientIpHeaders: React.Dispatch<React.SetStateAction<string>>;
    persistedSamlEnabled: boolean | null;
    persistedOidcEnabled: boolean | null;
    persistedLdapEnabled: boolean | null;
    handleSave: (event: React.SyntheticEvent) => Promise<void>;
  }>;
  saml: Readonly<{
    loading: boolean;
    saving: boolean;
    error: string | null;
    enabled: boolean;
    setEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    debug: boolean;
    setDebug: React.Dispatch<React.SetStateAction<boolean>>;
    linkByEmail: boolean;
    setLinkByEmail: React.Dispatch<React.SetStateAction<boolean>>;
    ssoUrl: string;
    setSsoUrl: React.Dispatch<React.SetStateAction<string>>;
    idpEntityId: string;
    setIdpEntityId: React.Dispatch<React.SetStateAction<string>>;
    sloUrl: string;
    setSloUrl: React.Dispatch<React.SetStateAction<string>>;
    idpCert: string;
    setIdpCert: React.Dispatch<React.SetStateAction<string>>;
    attrUsername: string;
    setAttrUsername: React.Dispatch<React.SetStateAction<string>>;
    attrGroups: string;
    setAttrGroups: React.Dispatch<React.SetStateAction<string>>;
    attrEmail: string;
    setAttrEmail: React.Dispatch<React.SetStateAction<string>>;
    attrSiteAdmin: string;
    setAttrSiteAdmin: React.Dispatch<React.SetStateAction<string>>;
    siteAdminRole: string;
    setSiteAdminRole: React.Dispatch<React.SetStateAction<string>>;
    timeout: number;
    setTimeout: React.Dispatch<React.SetStateAction<number>>;
    acsUrl: string;
    metadataUrl: string;
    handleSave: (event: React.SyntheticEvent) => Promise<void>;
  }>;
  oidc: Readonly<{
    loading: boolean;
    saving: boolean;
    error: string | null;
    enabled: boolean;
    setEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    linkByEmail: boolean;
    setLinkByEmail: React.Dispatch<React.SetStateAction<boolean>>;
    issuer: string;
    setIssuer: React.Dispatch<React.SetStateAction<string>>;
    clientId: string;
    setClientId: React.Dispatch<React.SetStateAction<string>>;
    clientSecret: string;
    setClientSecret: React.Dispatch<React.SetStateAction<string>>;
    clientSecretSet: boolean;
    scopes: string;
    setScopes: React.Dispatch<React.SetStateAction<string>>;
    pkceMethod: string;
    setPkceMethod: React.Dispatch<React.SetStateAction<string>>;
    signingAlg: string;
    setSigningAlg: React.Dispatch<React.SetStateAction<string>>;
    handleSave: (event: React.SyntheticEvent) => Promise<void>;
  }>;
  ldap: Readonly<{
    loading: boolean;
    saving: boolean;
    error: string | null;
    enabled: boolean;
    setEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    linkByEmail: boolean;
    setLinkByEmail: React.Dispatch<React.SetStateAction<boolean>>;
    host: string;
    setHost: React.Dispatch<React.SetStateAction<string>>;
    port: number;
    setPort: React.Dispatch<React.SetStateAction<number>>;
    encryption: string;
    setEncryption: React.Dispatch<React.SetStateAction<string>>;
    baseDn: string;
    setBaseDn: React.Dispatch<React.SetStateAction<string>>;
    bindDn: string;
    setBindDn: React.Dispatch<React.SetStateAction<string>>;
    bindPassword: string;
    setBindPassword: React.Dispatch<React.SetStateAction<string>>;
    bindPasswordSet: boolean;
    userFilter: string;
    setUserFilter: React.Dispatch<React.SetStateAction<string>>;
    attrUsername: string;
    setAttrUsername: React.Dispatch<React.SetStateAction<string>>;
    attrEmail: string;
    setAttrEmail: React.Dispatch<React.SetStateAction<string>>;
    attrDisplayName: string;
    setAttrDisplayName: React.Dispatch<React.SetStateAction<string>>;
    handleSave: (event: React.SyntheticEvent) => Promise<void>;
  }>;
}>): React.JSX.Element {
  const {
    general: {
      loading: generalLoading,
      saving: generalSaving,
      error: generalError,
      localAuthEnabled,
      setLocalAuthEnabled,
      trustedClientIpHeaders,
      setTrustedClientIpHeaders,
      persistedSamlEnabled,
      persistedOidcEnabled,
      persistedLdapEnabled,
      handleSave: handleSaveGeneral,
    },
    saml: {
      loading: samlLoading,
      saving: samlSaving,
      error: samlError,
      enabled: samlEnabled,
      setEnabled: setSamlEnabled,
      debug: samlDebug,
      setDebug: setSamlDebug,
      linkByEmail: samlLinkByEmail,
      setLinkByEmail: setSamlLinkByEmail,
      ssoUrl: samlSsoUrl,
      setSsoUrl: setSamlSsoUrl,
      idpEntityId: samlIdpEntityId,
      setIdpEntityId: setSamlIdpEntityId,
      sloUrl: samlSloUrl,
      setSloUrl: setSamlSloUrl,
      idpCert: samlIdpCert,
      setIdpCert: setSamlIdpCert,
      attrUsername: samlAttrUsername,
      setAttrUsername: setSamlAttrUsername,
      attrGroups: samlAttrGroups,
      setAttrGroups: setSamlAttrGroups,
      attrEmail: samlAttrEmail,
      setAttrEmail: setSamlAttrEmail,
      attrSiteAdmin: samlAttrSiteAdmin,
      setAttrSiteAdmin: setSamlAttrSiteAdmin,
      siteAdminRole: samlSiteAdminRole,
      setSiteAdminRole: setSamlSiteAdminRole,
      timeout: samlTimeout,
      setTimeout: setSamlTimeout,
      acsUrl: samlAcsUrl,
      metadataUrl: samlMetadataUrl,
      handleSave: handleSaveSaml,
    },
    oidc: {
      loading: oidcLoading,
      saving: oidcSaving,
      error: oidcError,
      enabled: oidcEnabled,
      setEnabled: setOidcEnabled,
      linkByEmail: oidcLinkByEmail,
      setLinkByEmail: setOidcLinkByEmail,
      issuer: oidcIssuer,
      setIssuer: setOidcIssuer,
      clientId: oidcClientId,
      setClientId: setOidcClientId,
      clientSecret: oidcClientSecret,
      setClientSecret: setOidcClientSecret,
      clientSecretSet: oidcClientSecretSet,
      scopes: oidcScopes,
      setScopes: setOidcScopes,
      pkceMethod: oidcPkceMethod,
      setPkceMethod: setOidcPkceMethod,
      signingAlg: oidcSigningAlg,
      setSigningAlg: setOidcSigningAlg,
      handleSave: handleSaveOidc,
    },
    ldap: {
      loading: ldapLoading,
      saving: ldapSaving,
      error: ldapError,
      enabled: ldapEnabled,
      setEnabled: setLdapEnabled,
      linkByEmail: ldapLinkByEmail,
      setLinkByEmail: setLdapLinkByEmail,
      host: ldapHost,
      setHost: setLdapHost,
      port: ldapPort,
      setPort: setLdapPort,
      encryption: ldapEncryption,
      setEncryption: setLdapEncryption,
      baseDn: ldapBaseDn,
      setBaseDn: setLdapBaseDn,
      bindDn: ldapBindDn,
      setBindDn: setLdapBindDn,
      bindPassword: ldapBindPassword,
      setBindPassword: setLdapBindPassword,
      bindPasswordSet: ldapBindPasswordSet,
      userFilter: ldapUserFilter,
      setUserFilter: setLdapUserFilter,
      attrUsername: ldapAttrUsername,
      setAttrUsername: setLdapAttrUsername,
      attrEmail: ldapAttrEmail,
      setAttrEmail: setLdapAttrEmail,
      attrDisplayName: ldapAttrDisplayName,
      setAttrDisplayName: setLdapAttrDisplayName,
      handleSave: handleSaveLdap,
    },
  } = props;
  return (
            <div className="space-y-8">
              {/* LOCAL AUTHENTICATION */}
              <Card>
                <CardHeader variant="section">
                  <CardTitle className="text-lg">Local Authentication</CardTitle>
                  <CardDescription>Username and password sign-in for this instance</CardDescription>
                </CardHeader>
                <CardContent>
                  {generalLoading ? (
                    <div role="status" className="py-6 text-center text-sm text-muted-foreground">Loading sign-in settings…</div>
                  ) : (
                    <form onSubmit={handleSaveGeneral} className="space-y-5">
                      {generalError !== null && (
                        <div role="alert" className="p-3 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-sm flex items-center gap-2">
                          <AlertCircle className="h-4 w-4 shrink-0" />
                          <span>{generalError}</span>
                        </div>
                      )}
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          id="local-auth-enabled"
                          name="local-auth-enabled"
                          type="checkbox"
                          checked={localAuthEnabled}
                          onChange={(e): void => { setLocalAuthEnabled(e.target.checked); }}
                          className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label="Allow local password authentication"
                        />
                        Allow local password authentication
                      </label>
                      <p className="text-xs text-muted-foreground">
                        When disabled, the sign-in page accepts only single sign-on (SAML, OIDC, or LDAP where
                        configured). Existing local accounts cannot sign in with a password until this is re-enabled.
                      </p>

                      <div className="space-y-2 pt-1">
                        <label htmlFor="trusted-client-ip-headers" className="block text-sm font-medium text-foreground">
                          Trusted client-IP headers
                        </label>
                        <input
                          id="trusted-client-ip-headers"
                          name="trusted-client-ip-headers"
                          type="text"
                          autoComplete="off"
                          spellCheck={false}
                          value={trustedClientIpHeaders}
                          onChange={(e): void => { setTrustedClientIpHeaders(e.target.value); }}
                          placeholder="CF-Connecting-IP, X-Forwarded-For"
                          className="h-9 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                        />
                        <p className="text-xs text-muted-foreground">
                          Comma-separated proxy headers, ordered by priority, used to determine the real client IP
                          for browser sessions and rate limiting. Only set this when the app sits behind a trusting
                          reverse proxy (e.g. Cloudflare). Leave empty to always trust the direct connection.
                        </p>
                      </div>
                      <Button
                        type="submit"
                        disabled={generalSaving || persistedSamlEnabled === null || persistedOidcEnabled === null || persistedLdapEnabled === null}
                        aria-label="Save sign-in settings"
                      >
                        {generalSaving ? "Saving…" : "Save sign-in settings"}
                      </Button>
                      {(persistedSamlEnabled === null || persistedOidcEnabled === null || persistedLdapEnabled === null) && (
                        <p className="text-xs text-warning">Waiting for all SSO settings to load before saving local authentication.</p>
                      )}
                    </form>
                  )}
                </CardContent>
              </Card>

              {/* SAML SSO */}
              <Card>
                <CardHeader variant="section">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-lg">SAML SSO</CardTitle>
                      <CardDescription>Security Assertion Markup Language single sign-on configuration</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {samlLoading ? (
                    <div role="status" className="py-6 text-center text-sm text-muted-foreground">Loading SAML settings…</div>
                  ) : (
                    <form onSubmit={handleSaveSaml} className="space-y-5">
                      {samlError !== null && (
                        <div role="alert" className="p-3 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-sm flex items-center gap-2">
                          <AlertCircle className="h-4 w-4 shrink-0" />
                          <span>{samlError}</span>
                        </div>
                      )}
                      <div className="grid gap-5 sm:grid-cols-2">
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            id="saml-enabled"
                            name="saml-enabled"
                            type="checkbox"
                            checked={samlEnabled}
                            onChange={(e): void => { setSamlEnabled(e.target.checked); }}
                            className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label="Enable SAML SSO"
                          />
                          Enable SAML SSO
                        </label>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            id="saml-debug"
                            name="saml-debug"
                            type="checkbox"
                            checked={samlDebug}
                            onChange={(e): void => { setSamlDebug(e.target.checked); }}
                            className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label="Enable SAML debug mode"
                          />
                          Debug mode
                        </label>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            id="saml-link-by-email"
                            name="saml-link-by-email"
                            type="checkbox"
                            checked={samlLinkByEmail}
                            onChange={(e): void => { setSamlLinkByEmail(e.target.checked); }}
                            className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label="Allow SAML email linking"
                          />
                          Link verified email addresses to existing accounts
                        </label>
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="saml-sso-url" className="text-xs font-medium text-foreground/85">SSO Endpoint URL</label>
                        <Input
                          id="saml-sso-url"
                          name="saml-sso-url"
                          autoComplete="url"
                          placeholder="https://idp.example.com/sso"
                          value={samlSsoUrl}
                          onChange={(e): void => { setSamlSsoUrl(e.target.value); }}
                          aria-label="SSO Endpoint URL"
                        />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="saml-idp-entity-id" className="text-xs font-medium text-foreground/85">IdP Entity ID</label>
                        <Input
                          id="saml-idp-entity-id"
                          name="saml-idp-entity-id"
                          autoComplete="url"
                          placeholder="https://idp.example.com/metadata"
                          value={samlIdpEntityId}
                          onChange={(e): void => { setSamlIdpEntityId(e.target.value); }}
                          aria-label="IdP Entity ID"
                        />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="saml-slo-url" className="text-xs font-medium text-foreground/85">SLO Endpoint URL</label>
                        <Input
                          id="saml-slo-url"
                          name="saml-slo-url"
                          autoComplete="url"
                          placeholder="https://idp.example.com/slo"
                          value={samlSloUrl}
                          onChange={(e): void => { setSamlSloUrl(e.target.value); }}
                          aria-label="SLO Endpoint URL"
                        />
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="saml-idp-cert" className="text-xs font-medium text-foreground/85">IdP Certificate (PEM)</label>
                        <textarea
                          id="saml-idp-cert"
                          name="saml-idp-certificate"
                          autoComplete="off"
                          spellCheck={false}
                          rows={5}
                          placeholder="Paste IdP certificate"
                          value={samlIdpCert}
                          onChange={(e): void => { setSamlIdpCert(e.target.value); }}
                          aria-label="IdP Certificate (PEM)"
                          className="min-h-28 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        />
                      </div>
                      <div className="border-t pt-4">
                        <p className="text-xs font-semibold text-foreground/85 mb-3">Attribute mappings</p>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div className="space-y-1">
                            <label htmlFor="saml-attr-username" className="text-xs font-medium text-foreground/85">Username attribute</label>
                            <Input
                              id="saml-attr-username"
                              name="saml-username-attribute"
                              autoComplete="off"
                              spellCheck={false}
                              value={samlAttrUsername}
                              onChange={(e): void => { setSamlAttrUsername(e.target.value); }}
                            />
                          </div>
                          <div className="space-y-1">
                            <label htmlFor="saml-attr-groups" className="text-xs font-medium text-foreground/85">Groups attribute</label>
                            <Input
                              id="saml-attr-groups"
                              name="saml-groups-attribute"
                              autoComplete="off"
                              spellCheck={false}
                              value={samlAttrGroups}
                              onChange={(e): void => { setSamlAttrGroups(e.target.value); }}
                            />
                          </div>
                          <div className="space-y-1">
                            <label htmlFor="saml-attr-email" className="text-xs font-medium text-foreground/85">Email attribute</label>
                            <Input
                              id="saml-attr-email"
                              name="saml-email-attribute"
                              autoComplete="off"
                              spellCheck={false}
                              value={samlAttrEmail}
                              onChange={(e): void => { setSamlAttrEmail(e.target.value); }}
                              aria-label="SAML email attribute"
                            />
                          </div>
                          <div className="space-y-1">
                            <label htmlFor="saml-attr-site-admin" className="text-xs font-medium text-foreground/85">Site admin attribute</label>
                            <Input
                              id="saml-attr-site-admin"
                              name="saml-site-admin-attribute"
                              autoComplete="off"
                              spellCheck={false}
                              value={samlAttrSiteAdmin}
                              onChange={(e): void => { setSamlAttrSiteAdmin(e.target.value); }}
                            />
                          </div>
                          <div className="space-y-1">
                            <label htmlFor="saml-site-admin-role" className="text-xs font-medium text-foreground/85">Site admin role value</label>
                            <Input
                              id="saml-site-admin-role"
                              name="saml-site-admin-role"
                              autoComplete="off"
                              spellCheck={false}
                              value={samlSiteAdminRole}
                              onChange={(e): void => { setSamlSiteAdminRole(e.target.value); }}
                            />
                          </div>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="saml-timeout" className="text-xs font-medium text-foreground/85">SSO API token session timeout (seconds)</label>
                        <Input
                          id="saml-timeout"
                          name="saml-session-timeout"
                          inputMode="numeric"
                          type="number"
                          value={samlTimeout}
                          onChange={(e): void => { setSamlTimeout(Number(e.target.value)); }}
                        />
                      </div>
                      <div className="border-t pt-4">
                        <p className="text-xs font-semibold text-foreground/85 mb-2">Service provider endpoints</p>
                        <p className="text-xs text-muted-foreground">
                          Use these URLs to register this instance with your identity provider.
                        </p>
                        <dl className="mt-2 space-y-1 text-xs">
                          <div className="flex flex-col gap-0.5">
                            <dt className="font-medium text-foreground/85">ACS consumer URL</dt>
                            <dd className="break-all text-muted-foreground font-mono">{samlAcsUrl !== "" ? samlAcsUrl : "—"}</dd>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <dt className="font-medium text-foreground/85">Metadata URL</dt>
                            <dd className="break-all text-muted-foreground font-mono">{samlMetadataUrl !== "" ? samlMetadataUrl : "—"}</dd>
                          </div>
                        </dl>
                      </div>
                      <Button type="submit" disabled={samlSaving} aria-label="Save SAML settings">
                        {samlSaving ? "Saving…" : "Save SAML settings"}
                      </Button>
                    </form>
                  )}
                </CardContent>
              </Card>

              {/* OIDC */}
              <Card>
                <CardHeader variant="section">
                  <CardTitle className="text-lg">OpenID Connect</CardTitle>
                  <CardDescription>OpenID Connect provider configuration</CardDescription>
                </CardHeader>
                <CardContent>
                  {oidcLoading ? (
                    <div role="status" className="py-6 text-center text-sm text-muted-foreground">Loading OIDC settings…</div>
                  ) : (
                    <form onSubmit={handleSaveOidc} className="space-y-5">
                      {oidcError !== null && (
                        <div role="alert" className="p-3 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-sm flex items-center gap-2">
                          <AlertCircle className="h-4 w-4 shrink-0" />
                          <span>{oidcError}</span>
                        </div>
                      )}
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          id="oidc-enabled"
                          name="oidc-enabled"
                          type="checkbox"
                          checked={oidcEnabled}
                          onChange={(e): void => { setOidcEnabled(e.target.checked); }}
                          className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label="Enable OIDC"
                        />
                        Enable OpenID Connect
                      </label>
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          id="oidc-link-by-email"
                          name="oidc-link-by-email"
                          type="checkbox"
                          checked={oidcLinkByEmail}
                          onChange={(e): void => { setOidcLinkByEmail(e.target.checked); }}
                          className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label="Allow OIDC email linking"
                        />
                        Link verified email addresses to existing accounts
                      </label>
                      <div className="grid gap-5 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label htmlFor="oidc-issuer" className="text-xs font-medium text-foreground/85">Issuer URL</label>
                          <Input
                            id="oidc-issuer"
                            name="oidc-issuer"
                            autoComplete="url"
                            placeholder="https://accounts.example.com"
                            value={oidcIssuer}
                            onChange={(e): void => { setOidcIssuer(e.target.value); }}
                            aria-label="Issuer URL"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="oidc-client-id" className="text-xs font-medium text-foreground/85">Client ID</label>
                          <Input
                            id="oidc-client-id"
                            name="oidc-client-id"
                            autoComplete="off"
                            spellCheck={false}
                            value={oidcClientId}
                            onChange={(e): void => { setOidcClientId(e.target.value); }}
                            aria-label="Client ID"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="oidc-client-secret" className="text-xs font-medium text-foreground/85">Client Secret</label>
                          <Input
                            id="oidc-client-secret"
                            name="oidc-client-secret"
                            autoComplete="new-password"
                            type="password"
                            placeholder={oidcClientSecretSet ? "····· (leave blank to keep)" : undefined}
                            value={oidcClientSecret}
                            onChange={(e): void => { setOidcClientSecret(e.target.value); }}
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="oidc-scopes" className="text-xs font-medium text-foreground/85">Scopes</label>
                          <Input
                            id="oidc-scopes"
                            name="oidc-scopes"
                            autoComplete="off"
                            spellCheck={false}
                            value={oidcScopes}
                            onChange={(e): void => { setOidcScopes(e.target.value); }}
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="oidc-pkce-method" className="text-xs font-medium text-foreground/85">PKCE Method</label>
                          <Input
                            id="oidc-pkce-method"
                            name="oidc-pkce-method"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="S256"
                            value={oidcPkceMethod}
                            onChange={(e): void => { setOidcPkceMethod(e.target.value); }}
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="oidc-signing-alg" className="text-xs font-medium text-foreground/85">ID token signing algorithm</label>
                          <select
                            id="oidc-signing-alg"
                            name="oidc-signing-algorithm"
                            value={oidcSigningAlg}
                            onChange={(e): void => { setOidcSigningAlg(e.target.value); }}
                            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            aria-label="OIDC signing algorithm"
                          >
                            <option value="">Provider-advertised asymmetric algorithm</option>
                            {[
                              "RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "PS384", "PS512",
                              "HS256", "HS384", "HS512",
                            ].map((algorithm): React.JSX.Element => <option key={algorithm} value={algorithm}>{algorithm}</option>)}
                          </select>
                        </div>
                      </div>
                      <Button type="submit" disabled={oidcSaving} aria-label="Save OIDC settings">
                        {oidcSaving ? "Saving…" : "Save OIDC settings"}
                      </Button>
                    </form>
                  )}
                </CardContent>
              </Card>

              {/* LDAP */}
              <Card>
                <CardHeader variant="section">
                  <CardTitle className="text-lg">LDAP</CardTitle>
                  <CardDescription>Lightweight Directory Access Protocol password authentication</CardDescription>
                </CardHeader>
                <CardContent>
                  {ldapLoading ? (
                    <div role="status" className="py-6 text-center text-sm text-muted-foreground">Loading LDAP settings…</div>
                  ) : (
                    <form onSubmit={handleSaveLdap} className="space-y-5">
                      {ldapError !== null && (
                        <div role="alert" className="p-3 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-sm flex items-center gap-2">
                          <AlertCircle className="h-4 w-4 shrink-0" />
                          <span>{ldapError}</span>
                        </div>
                      )}
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          id="ldap-enabled"
                          name="ldap-enabled"
                          type="checkbox"
                          checked={ldapEnabled}
                          onChange={(e): void => { setLdapEnabled(e.target.checked); }}
                          className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label="Enable LDAP"
                        />
                        Enable LDAP authentication
                      </label>
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          id="ldap-link-by-email"
                          name="ldap-link-by-email"
                          type="checkbox"
                          checked={ldapLinkByEmail}
                          onChange={(e): void => { setLdapLinkByEmail(e.target.checked); }}
                          className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label="Allow LDAP email linking"
                        />
                        Link directory email addresses to existing accounts
                      </label>
                      <div className="grid gap-5 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label htmlFor="ldap-host" className="text-xs font-medium text-foreground/85">Host</label>
                          <Input
                            id="ldap-host"
                            name="ldap-host"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="ldap.example.com"
                            value={ldapHost}
                            onChange={(e): void => { setLdapHost(e.target.value); }}
                            aria-label="LDAP host"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="ldap-port" className="text-xs font-medium text-foreground/85">Port</label>
                          <Input
                            id="ldap-port"
                            name="ldap-port"
                            inputMode="numeric"
                            type="number"
                            value={ldapPort}
                            onChange={(e): void => { setLdapPort(Number(e.target.value)); }}
                            aria-label="LDAP port"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="ldap-encryption" className="text-xs font-medium text-foreground/85">Encryption</label>
                          <select
                            id="ldap-encryption"
                            name="ldap-encryption"
                            value={ldapEncryption}
                            onChange={(e): void => { setLdapEncryption(e.target.value); }}
                            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            aria-label="LDAP encryption"
                          >
                            <option value="plain">Plain (LDAP)</option>
                            <option value="starttls">StartTLS</option>
                            <option value="ldaps">LDAPS</option>
                          </select>
                          {ldapEncryption === "plain" && (
                            <p className="text-xs text-warning">
                              Warning: plain LDAP transmits the bind password and user passwords without
                              encryption. Use StartTLS or LDAPS when possible.
                            </p>
                          )}
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="ldap-base-dn" className="text-xs font-medium text-foreground/85">Base DN</label>
                          <Input
                            id="ldap-base-dn"
                            name="ldap-base-dn"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="dc=example,dc=com"
                            value={ldapBaseDn}
                            onChange={(e): void => { setLdapBaseDn(e.target.value); }}
                            aria-label="LDAP base DN"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="ldap-bind-dn" className="text-xs font-medium text-foreground/85">Bind DN (service account, optional)</label>
                          <Input
                            id="ldap-bind-dn"
                            name="ldap-bind-dn"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="cn=service,dc=example,dc=com"
                            value={ldapBindDn}
                            onChange={(e): void => { setLdapBindDn(e.target.value); }}
                            aria-label="LDAP bind DN"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="ldap-bind-password" className="text-xs font-medium text-foreground/85">Bind password</label>
                          <Input
                            id="ldap-bind-password"
                            name="ldap-bind-password"
                            autoComplete="new-password"
                            type="password"
                            placeholder={ldapBindPasswordSet ? "····· (leave blank to keep)" : undefined}
                            value={ldapBindPassword}
                            onChange={(e): void => { setLdapBindPassword(e.target.value); }}
                            aria-label="LDAP bind password"
                          />
                        </div>
                      </div>
                      <div className="border-t pt-4">
                        <p className="text-xs font-semibold text-foreground/85 mb-3">User mapping</p>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div className="space-y-1">
                            <label htmlFor="ldap-user-filter" className="text-xs font-medium text-foreground/85">User filter (containing &#123;&#123;username&#125;&#125;)</label>
                            <Input
                              id="ldap-user-filter"
                              name="ldap-user-filter"
                              autoComplete="off"
                              spellCheck={false}
                              value={ldapUserFilter}
                              onChange={(e): void => { setLdapUserFilter(e.target.value); }}
                              aria-label="LDAP user filter"
                            />
                          </div>
                          <div className="space-y-1">
                            <label htmlFor="ldap-attr-username" className="text-xs font-medium text-foreground/85">Username attribute</label>
                            <Input
                              id="ldap-attr-username"
                              name="ldap-username-attribute"
                              autoComplete="off"
                              spellCheck={false}
                              value={ldapAttrUsername}
                              onChange={(e): void => { setLdapAttrUsername(e.target.value); }}
                              aria-label="LDAP username attribute"
                            />
                          </div>
                          <div className="space-y-1">
                            <label htmlFor="ldap-attr-email" className="text-xs font-medium text-foreground/85">Email attribute</label>
                            <Input
                              id="ldap-attr-email"
                              name="ldap-email-attribute"
                              autoComplete="off"
                              spellCheck={false}
                              value={ldapAttrEmail}
                              onChange={(e): void => { setLdapAttrEmail(e.target.value); }}
                              aria-label="LDAP email attribute"
                            />
                          </div>
                          <div className="space-y-1">
                            <label htmlFor="ldap-attr-display-name" className="text-xs font-medium text-foreground/85">Display name attribute</label>
                            <Input
                              id="ldap-attr-display-name"
                              name="ldap-display-name-attribute"
                              autoComplete="off"
                              spellCheck={false}
                              value={ldapAttrDisplayName}
                              onChange={(e): void => { setLdapAttrDisplayName(e.target.value); }}
                              aria-label="LDAP display name attribute"
                            />
                          </div>
                        </div>
                        <p className="mt-3 text-xs text-muted-foreground">
                          The sign-in form first attempts LDAP, then falls back to local passwords (when enabled).
                          A user who already exists locally with the same username will block LDAP provisioning to
                          avoid account takeover.
                        </p>
                      </div>
                      <Button type="submit" disabled={ldapSaving} aria-label="Save LDAP settings">
                        {ldapSaving ? "Saving…" : "Save LDAP settings"}
                      </Button>
                    </form>
                  )}
                </CardContent>
              </Card>
            </div>
  );
}

export function AdminDashboard({ section }: Readonly<{ section: AdminSection }>): React.JSX.Element {
  const navigate = useNavigate();
  const { accountLoaded, siteAdmin } = useOutletContext<LayoutOutletContext>();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [users, setUsers] = useState<DataItem[]>([]);
  const [orgs, setOrgs] = useState<DataItem[]>([]);
  const [workspaces, setWorkspaces] = useState<DataItem[]>([]);
  const [runs, setRuns] = useState<DataItem[]>([]);
  const [tfVersions, setTfVersions] = useState<DataItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<DataItem[]>([]);
  const [securitySummary, setSecuritySummary] = useState<SecuritySummary>({
    signupEnabled: false,
    sandboxEnabled: false,
    sandboxAvailable: false,
    sandboxReason: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteUserId, setDeleteUserId] = useState<{ id: string; label: string } | null>(null);

  // Auth config state
  const [samlEnabled, setSamlEnabled] = useState(false);
  const [persistedSamlEnabled, setPersistedSamlEnabled] = useState<boolean | null>(null);
  const [samlLinkByEmail, setSamlLinkByEmail] = useState(false);
  const [samlDebug, setSamlDebug] = useState(false);
  const [samlSsoUrl, setSamlSsoUrl] = useState("");
  const [samlSloUrl, setSamlSloUrl] = useState("");
  const [samlIdpCert, setSamlIdpCert] = useState("");
  const [samlIdpEntityId, setSamlIdpEntityId] = useState("");
  const [samlAttrUsername, setSamlAttrUsername] = useState("Username");
  const [samlAttrEmail, setSamlAttrEmail] = useState("email");
  const [samlAttrGroups, setSamlAttrGroups] = useState("MemberOf");
  const [samlAttrSiteAdmin, setSamlAttrSiteAdmin] = useState("SiteAdmin");
  const [samlSiteAdminRole, setSamlSiteAdminRole] = useState("site-admins");
  const [samlTimeout, setSamlTimeout] = useState(1209600);
  const [samlLoading, setSamlLoading] = useState(false);
  const [samlSaving, setSamlSaving] = useState(false);
  const [samlError, setSamlError] = useState<string | null>(null);

  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [persistedOidcEnabled, setPersistedOidcEnabled] = useState<boolean | null>(null);
  const [oidcLinkByEmail, setOidcLinkByEmail] = useState(false);
  const [oidcIssuer, setOidcIssuer] = useState("");
  const [oidcClientId, setOidcClientId] = useState("");
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [oidcClientSecretSet, setOidcClientSecretSet] = useState(false);
  const [oidcScopes, setOidcScopes] = useState("openid profile email");
  const [oidcPkceMethod, setOidcPkceMethod] = useState("");
  const [oidcSigningAlg, setOidcSigningAlg] = useState("");
  const [oidcLoading, setOidcLoading] = useState(false);
  const [oidcSaving, setOidcSaving] = useState(false);
  const [oidcError, setOidcError] = useState<string | null>(null);

  // Local authentication state
  const [localAuthEnabled, setLocalAuthEnabled] = useState(true);
  const [trustedClientIpHeaders, setTrustedClientIpHeaders] = useState("");
  const [generalLoading, setGeneralLoading] = useState(false);
  const [generalSaving, setGeneralSaving] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

  // LDAP state
  const [ldapEnabled, setLdapEnabled] = useState(false);
  const [persistedLdapEnabled, setPersistedLdapEnabled] = useState<boolean | null>(null);
  const [ldapLinkByEmail, setLdapLinkByEmail] = useState(false);
  const [ldapHost, setLdapHost] = useState("");
  const [ldapPort, setLdapPort] = useState(636);
  const [ldapEncryption, setLdapEncryption] = useState("ldaps");
  const [ldapBindDn, setLdapBindDn] = useState("");
  const [ldapBindPassword, setLdapBindPassword] = useState("");
  // bind-password is write-only; an empty field must not clear a stored value.
  const [ldapBindPasswordSet, setLdapBindPasswordSet] = useState(false);
  const [ldapBaseDn, setLdapBaseDn] = useState("");
  const [ldapUserFilter, setLdapUserFilter] = useState("(uid={{username}})");
  const [ldapAttrUsername, setLdapAttrUsername] = useState("uid");
  const [ldapAttrEmail, setLdapAttrEmail] = useState("mail");
  const [ldapAttrDisplayName, setLdapAttrDisplayName] = useState("cn");
  const [ldapLoading, setLdapLoading] = useState(false);
  const [ldapSaving, setLdapSaving] = useState(false);
  const [ldapError, setLdapError] = useState<string | null>(null);

  // SAML display URLs
  const [samlAcsUrl, setSamlAcsUrl] = useState("");
  const [samlMetadataUrl, setSamlMetadataUrl] = useState("");

  // Create user form state
  const [newUsername, setNewUsername] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [createUserError, setCreateUserError] = useState<string | null>(null);

  const resetCreateForm = (): void => {
    setNewUsername("");
    setNewEmail("");
    setNewPassword("");
    setNewIsAdmin(false);
    setCreateUserError(null);
  };

  const handleCreateUser = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    const username = newUsername.trim();
    if (username === "" || newPassword.length < 10) {
      setCreateUserError("Username is required and password must be at least 10 characters.");
      return;
    }
    setCreatingUser(true);
    setCreateUserError(null);
    try {
      await fetchApi("/api/v2/admin/users", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "users",
            attributes: {
              username,
              email: newEmail.trim() !== "" ? newEmail.trim() : null,
              password: newPassword,
              "is-site-admin": newIsAdmin,
            },
          },
        }),
      });
      setCreateDialogOpen(false);
      resetCreateForm();
      void loadAdminData();
      toast.add({ title: "User created", type: "success" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error creating user";
      setCreateUserError(msg);
    } finally {
      setCreatingUser(false);
    }
  };

  const handleDeleteUser = async (id: string): Promise<void> => {
    try {
      await fetchApi(`/api/v2/admin/users/${id}`, { method: "DELETE" });
      setDeleteUserId(null);
      void loadAdminData();
      toast.add({ title: "User deleted", type: "success" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error deleting user";
      toast.add({ title: "Could not delete user", description: msg, type: "error" });
    }
  };

  // Version form state
  const [newVersion, setNewVersion] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newSha, setNewSha] = useState("");

  const loadAdminData = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      if (section === "auth") {
        await Promise.all([
          loadGeneralSettings(),
          loadLdapSettings(),
          loadSamlSettings(),
          loadOidcSettings(),
        ]);
      } else if (section === "security") {
        const [usersResponse, auditResponse, pingResponse, metaResponse, samlResponse, oidcResponse, ldapResponse] = await Promise.all([
          fetchAllApiPages<DataItem>("/admin/users?page[size]=100"),
          fetchApi("/api/v2/admin/audit-logs"),
          fetchApi("/api/v2/ping"),
          fetchApi("/api/v2/meta"),
          fetchApi("/api/v2/admin/saml-settings"),
          fetchApi("/api/v2/admin/oidc-settings"),
          fetchApi("/api/v2/admin/ldap-settings"),
        ]);
        setUsers(usersResponse);
        setAuditLogs((auditResponse as { data?: DataItem[] }).data ?? []);
        const ping = pingResponse as { "signup-enabled"?: boolean };
        const sandbox = (metaResponse as {
          data?: { "run-sandbox"?: { enabled?: boolean; available?: boolean; reason?: string | null } };
        }).data?.["run-sandbox"];
        setSecuritySummary({
          signupEnabled: ping["signup-enabled"] === true,
          sandboxEnabled: sandbox?.enabled === true,
          sandboxAvailable: sandbox?.available === true,
          sandboxReason: typeof sandbox?.reason === "string" ? sandbox.reason : null,
        });
        const samlIsEnabled = (samlResponse as { data?: { attributes?: { enabled?: boolean } } }).data?.attributes?.enabled === true;
        const oidcIsEnabled = (oidcResponse as { data?: { attributes?: { enabled?: boolean } } }).data?.attributes?.enabled === true;
        const ldapIsEnabled = (ldapResponse as { data?: { attributes?: { enabled?: boolean } } }).data?.attributes?.enabled === true;
        setSamlEnabled(samlIsEnabled);
        setPersistedSamlEnabled(samlIsEnabled);
        setOidcEnabled(oidcIsEnabled);
        setPersistedOidcEnabled(oidcIsEnabled);
        setLdapEnabled(ldapIsEnabled);
        setPersistedLdapEnabled(ldapIsEnabled);
      } else if (section === "users") {
        const res = await fetchApi("/api/v2/admin/users") as { data: DataItem[] };
        setUsers(res.data);
      } else if (section === "orgs") {
        const res = await fetchApi("/api/v2/admin/organizations") as { data: DataItem[] };
        setOrgs(res.data);
      } else if (section === "workspaces") {
        const res = await fetchApi("/api/v2/admin/workspaces") as { data: DataItem[] };
        setWorkspaces(res.data);
      } else if (section === "runs") {
        const res = await fetchApi("/api/v2/admin/runs") as { data: DataItem[] };
        setRuns(res.data);
      } else if (section === "versions") {
        const res = await fetchApi("/api/v2/admin/terraform-versions") as { data: DataItem[] };
        setTfVersions(res.data);
      } else {
        const res = await fetchApi("/api/v2/admin/audit-logs") as { data: DataItem[] };
        setAuditLogs(res.data);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load admin data";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect((): void => {
    if (siteAdmin) {
      setError(null);
      void loadAdminData();
    }
  }, [section, siteAdmin]);

  const handleAddVersion = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (newVersion === "") return;
    try {
      await fetchApi("/api/v2/admin/terraform-versions", {
        method: "POST",
        body: JSON.stringify({
          data: {
            attributes: {
              version: newVersion,
              url: newUrl !== "" ? newUrl : null,
              sha: newSha !== "" ? newSha : null,
            },
          },
        }),
      });
      setNewVersion("");
      setNewUrl("");
      setNewSha("");
      void loadAdminData();
      toast.add({ title: "Terraform version added", type: "success" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error adding version";
      toast.add({ title: "Could not add Terraform version", description: msg, type: "error" });
    }
  };

  const [versionToDelete, setVersionToDelete] = useState<{ id: string; label: string } | null>(null);

  const handleDeleteVersion = async (id: string): Promise<void> => {
    try {
      await fetchApi(`/api/v2/admin/terraform-versions/${id}`, { method: "DELETE" });
      void loadAdminData();
      toast.add({ title: "Terraform version deleted", type: "success" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error deleting version";
      toast.add({ title: "Could not delete Terraform version", description: msg, type: "error" });
    } finally {
      setVersionToDelete(null);
    }
  };

  const handleCancelRun = async (runId: string, force = false): Promise<void> => {
    try {
      await fetchApi(`/api/v2/admin/runs/${runId}/actions/${force ? "force-cancel" : "cancel"}`, {
        method: "POST",
      });
      void loadAdminData();
      toast.add({ title: force ? "Run force-canceled" : "Run canceled", type: "success" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error canceling run";
      toast.add({ title: "Could not cancel run", description: msg, type: "error" });
    }
  };

  // --- Auth settings helpers ---
  const loadSamlSettings = async (): Promise<void> => {
    setSamlLoading(true);
    setSamlError(null);
    try {
      const res = await fetchApi("/api/v2/admin/saml-settings") as {
        data: { attributes: Record<string, unknown> };
      };
      const attrs = res.data.attributes;
      setSamlEnabled(attrBoolean(attrs, "enabled", false));
      setPersistedSamlEnabled(attrBoolean(attrs, "enabled", false));
      setSamlLinkByEmail(attrBoolean(attrs, "link-by-email", false));
      setSamlDebug(attrBoolean(attrs, "debug", false));
      setSamlSsoUrl(attrString(attrs, "sso-endpoint-url", ""));
      setSamlSloUrl(attrString(attrs, "slo-endpoint-url", ""));
      setSamlIdpCert(attrString(attrs, "idp-cert", ""));
      setSamlIdpEntityId(attrString(attrs, "idp-entity-id", ""));
      setSamlAttrUsername(attrString(attrs, "attr-username", "Username"));
      setSamlAttrEmail(attrString(attrs, "attr-email", "email"));
      setSamlAttrGroups(attrString(attrs, "attr-groups", "MemberOf"));
      setSamlAttrSiteAdmin(attrString(attrs, "attr-site-admin", "SiteAdmin"));
      setSamlSiteAdminRole(attrString(attrs, "site-admin-role", "site-admins"));
      setSamlTimeout(typeof attrs["sso-api-token-session-timeout"] === "number" ? attrs["sso-api-token-session-timeout"] : 1209600);
      setSamlAcsUrl(attrString(attrs, "acs-consumer-url", ""));
      setSamlMetadataUrl(attrString(attrs, "metadata-url", ""));
    } catch (err: unknown) {
      setSamlError(err instanceof Error ? err.message : "Failed to load SAML settings");
      // The persisted flag stays null on failure: "unknown" must not look
      // like a disabled provider, and the lockout guards skip validation
      // while any provider state is unknown.
    } finally {
      setSamlLoading(false);
    }
  };

  const loadGeneralSettings = async (): Promise<void> => {
    setGeneralLoading(true);
    setGeneralError(null);
    try {
      const res = await fetchApi("/api/v2/admin/general-settings") as {
        data: { attributes: Record<string, unknown> };
      };
      setLocalAuthEnabled(res.data.attributes["local-auth-enabled"] !== false);
      const trusted = res.data.attributes["trusted-client-ip-headers"];
      setTrustedClientIpHeaders(Array.isArray(trusted) ? trusted.join(", ") : "");
    } catch (err: unknown) {
      setGeneralError(err instanceof Error ? err.message : "Failed to load general settings");
    } finally {
      setGeneralLoading(false);
    }
  };

  const loadLdapSettings = async (): Promise<void> => {
    setLdapLoading(true);
    setLdapError(null);
    try {
      const res = await fetchApi("/api/v2/admin/ldap-settings") as {
        data: { attributes: Record<string, unknown> };
      };
      const attrs = res.data.attributes;
      setLdapEnabled(attrBoolean(attrs, "enabled", false));
      setPersistedLdapEnabled(attrBoolean(attrs, "enabled", false));
      setLdapLinkByEmail(attrBoolean(attrs, "link-by-email", false));
      setLdapHost(attrString(attrs, "host", ""));
      setLdapPort(typeof attrs["port"] === "number" ? attrs["port"] : 636);
      setLdapEncryption(attrString(attrs, "encryption", "ldaps"));
      setLdapBindDn(attrString(attrs, "bind-dn", ""));
      setLdapBindPassword("");
      setLdapBindPasswordSet(attrs["bind-password-set"] === true);
      setLdapBaseDn(attrString(attrs, "base-dn", ""));
      setLdapUserFilter(attrString(attrs, "user-filter", "(uid={{username}})"));
      setLdapAttrUsername(attrString(attrs, "attr-username", "uid"));
      setLdapAttrEmail(attrString(attrs, "attr-email", "mail"));
      setLdapAttrDisplayName(attrString(attrs, "attr-display-name", "cn"));
    } catch (err: unknown) {
      setLdapError(err instanceof Error ? err.message : "Failed to load LDAP settings");
      // The persisted flag stays null on failure (see loadSamlSettings).
    } finally {
      setLdapLoading(false);
    }
  };

  const handleSaveGeneral = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!localAuthEnabled && persistedSamlEnabled === false && persistedOidcEnabled === false && persistedLdapEnabled === false) {
      setGeneralError("At least one authentication method must remain enabled.");
      return;
    }
    await saveAuthSettings({
      setSaving: setGeneralSaving,
      setError: setGeneralError,
      save: async (): Promise<void> => {
        await fetchApi("/api/v2/admin/general-settings", {
          method: "PATCH",
          body: JSON.stringify({
            data: {
              type: "general-settings",
              attributes: {
                "local-auth-enabled": localAuthEnabled,
                "trusted-client-ip-headers": trustedClientIpHeaders
                  .split(",")
                  .map((name): string => name.trim())
                  .filter((name): boolean => name !== ""),
              },
            },
          }),
        });
      },
      reload: (): void => { void loadGeneralSettings(); },
      successTitle: "Sign-in settings saved",
      fallbackError: "Failed to save sign-in settings",
    });
  };

  const handleSaveLdap = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    // Client-side mirror of the API validation so the admin sees the error
    // before submitting an unusable configuration.
    if (ldapEnabled && (ldapHost.trim() === "" || ldapBaseDn.trim() === "")) {
      setLdapError("Host and Base DN are required when LDAP is enabled.");
      return;
    }
    // The port must be usable whenever the form is saved, even while LDAP is
    // disabled: a dormant misconfiguration breaks the next enable.
    if (!Number.isInteger(ldapPort) || ldapPort < 1 || ldapPort > 65535) {
      setLdapError("Port must be between 1 and 65535.");
      return;
    }
    if (ldapEnabled && !ldapUserFilter.includes("{{username}}")) {
      setLdapError("User filter must contain the {{username}} placeholder.");
      return;
    }
    if (ldapBindDn.trim() !== "" && ldapBindPassword === "" && !ldapBindPasswordSet) {
      setLdapError("A bind password is required when a bind DN is set.");
      return;
    }
    // Never allow the last authentication method to be switched off.
    if (!ldapEnabled && !localAuthEnabled && persistedSamlEnabled === false && persistedOidcEnabled === false) {
      setLdapError("At least one authentication method must remain enabled.");
      return;
    }
    const body: Record<string, unknown> = {
      data: {
        type: "ldap-settings",
        attributes: {
          enabled: ldapEnabled,
          "link-by-email": ldapLinkByEmail,
          host: ldapHost.trim() !== "" ? ldapHost.trim() : null,
          port: ldapPort,
          encryption: ldapEncryption,
          "bind-dn": ldapBindDn.trim() !== "" ? ldapBindDn.trim() : null,
          // bind-password is write-only after the initial save. An empty
          // field preserves the stored value; a typed value replaces it.
          // Clearing the bind DN explicitly removes the stored secret.
          ...(ldapBindDn.trim() === ""
            ? { "bind-password": null }
            : ldapBindPassword !== ""
              ? { "bind-password": ldapBindPassword }
              : {}),
          "base-dn": ldapBaseDn.trim() !== "" ? ldapBaseDn.trim() : null,
          "user-filter": ldapUserFilter,
          "attr-username": ldapAttrUsername,
          "attr-email": ldapAttrEmail,
          "attr-display-name": ldapAttrDisplayName,
        },
      },
    };
    await saveAuthSettings({
      setSaving: setLdapSaving,
      setError: setLdapError,
      save: async (): Promise<void> => {
        await fetchApi("/api/v2/admin/ldap-settings", {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        setPersistedLdapEnabled(ldapEnabled);
      },
      reload: (): void => { void loadLdapSettings(); },
      successTitle: "LDAP settings saved",
      fallbackError: "Failed to save LDAP settings",
    });
  };

  const loadOidcSettings = async (): Promise<void> => {
    setOidcLoading(true);
    setOidcError(null);
    try {
      const res = await fetchApi("/api/v2/admin/oidc-settings") as {
        data: { attributes: Record<string, unknown> };
      };
      const attrs = res.data.attributes;
      setOidcEnabled(attrBoolean(attrs, "enabled", false));
      setPersistedOidcEnabled(attrBoolean(attrs, "enabled", false));
      setOidcLinkByEmail(attrBoolean(attrs, "link-by-email", false));
      setOidcIssuer(attrString(attrs, "issuer", ""));
      setOidcClientId(attrString(attrs, "client-id", ""));
      setOidcClientSecret("");
      setOidcClientSecretSet(attrs["client-secret-set"] === true);
      setOidcScopes(attrString(attrs, "scopes", "openid profile email"));
      setOidcPkceMethod(attrString(attrs, "pkce-method", ""));
      setOidcSigningAlg(attrString(attrs, "signing-alg", ""));
    } catch (err: unknown) {
      setOidcError(err instanceof Error ? err.message : "Failed to load OIDC settings");
      // The persisted flag stays null on failure (see loadSamlSettings).
    } finally {
      setOidcLoading(false);
    }
  };

  const handleSaveSaml = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    // Client-side mirror of the API's lockout guard: never allow the last
    // authentication method to be switched off.
    if (!samlEnabled && !localAuthEnabled && persistedOidcEnabled === false && persistedLdapEnabled === false) {
      setSamlError("At least one authentication method must remain enabled.");
      return;
    }
    const body: Record<string, unknown> = {
      data: {
        type: "saml-settings",
        attributes: {
          enabled: samlEnabled,
          "link-by-email": samlLinkByEmail,
          debug: samlDebug,
          "sso-endpoint-url": samlSsoUrl.trim() !== "" ? samlSsoUrl.trim() : null,
          "slo-endpoint-url": samlSloUrl.trim() !== "" ? samlSloUrl.trim() : null,
          "idp-cert": samlIdpCert.trim() !== "" ? samlIdpCert.trim() : null,
          "idp-entity-id": samlIdpEntityId.trim() !== "" ? samlIdpEntityId.trim() : null,
          "attr-username": samlAttrUsername,
          "attr-email": samlAttrEmail,
          "attr-groups": samlAttrGroups,
          "attr-site-admin": samlAttrSiteAdmin,
          "site-admin-role": samlSiteAdminRole,
          "sso-api-token-session-timeout": samlTimeout,
        },
      },
    };
    await saveAuthSettings({
      setSaving: setSamlSaving,
      setError: setSamlError,
      save: async (): Promise<void> => {
        await fetchApi("/api/v2/admin/saml-settings", {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        setPersistedSamlEnabled(samlEnabled);
      },
      reload: (): void => { void loadSamlSettings(); },
      successTitle: "SAML settings saved",
      fallbackError: "Failed to save SAML settings",
    });
  };

  const handleSaveOidc = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    // Client-side mirror of the API's lockout guard (see handleSaveSaml).
    if (!oidcEnabled && !localAuthEnabled && persistedSamlEnabled === false && persistedLdapEnabled === false) {
      setOidcError("At least one authentication method must remain enabled.");
      return;
    }
    const body: Record<string, unknown> = {
      data: {
        type: "oidc-settings",
        attributes: {
          enabled: oidcEnabled,
          "link-by-email": oidcLinkByEmail,
          issuer: oidcIssuer.trim() !== "" ? oidcIssuer.trim() : null,
          "client-id": oidcClientId.trim() !== "" ? oidcClientId.trim() : null,
          // An untouched field preserves the stored secret; a typed value
          // replaces it; clearing the client ID removes the secret too.
          ...(oidcClientId.trim() === ""
            ? { "client-secret": null }
            : oidcClientSecret.trim() !== ""
              ? { "client-secret": oidcClientSecret.trim() }
              : {}),
          scopes: oidcScopes,
          "pkce-method": oidcPkceMethod.trim() !== "" ? oidcPkceMethod.trim() : null,
          "signing-alg": oidcSigningAlg.trim() !== "" ? oidcSigningAlg.trim() : null,
        },
      },
    };
    await saveAuthSettings({
      setSaving: setOidcSaving,
      setError: setOidcError,
      save: async (): Promise<void> => {
        await fetchApi("/api/v2/admin/oidc-settings", {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        setPersistedOidcEnabled(oidcEnabled);
      },
      reload: (): void => { void loadOidcSettings(); },
      successTitle: "OIDC settings saved",
      fallbackError: "Failed to save OIDC settings",
    });
  };

  if (!accountLoaded) return <p role="status" className="p-8 text-sm text-muted-foreground">Checking site administration access…</p>;
  if (!siteAdmin) return <Navigate to="/app" replace />;

  return (
    <PageShell className="max-w-7xl space-y-8">
      <PageHeader
        eyebrow="Administration"
        title={(
          <span className="flex items-center gap-2">
            <Shield className="size-7 text-primary" aria-hidden="true" />
            Site administration
          </span>
        )}
        description="Instance-wide governance, security, and version management."
        action={(
          <Button variant="outline" size="sm" onClick={(): void => { void loadAdminData(); }} className="gap-2">
            <RefreshCw className="size-4" aria-hidden="true" />
            Refresh
          </Button>
        )}
      />

      {error != null && error !== "" && (
        <div role="alert" className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
          Loading admin resources…
        </div>
      ) : (
        <>
          {/* SECURITY OVERVIEW TAB */}
          {section === "security" && (
            <SecurityOverview
              navigate={navigate}
              samlEnabled={samlEnabled}
              oidcEnabled={oidcEnabled}
              ldapEnabled={ldapEnabled}
              securitySummary={securitySummary}
              users={users}
              auditLogs={auditLogs}
            />
          )}

          {/* USERS TAB */}
          {section === "users" && (
            <UsersAdmin
              users={users}
              setCreateDialogOpen={setCreateDialogOpen}
              setDeleteUserId={setDeleteUserId}
              loadAdminData={loadAdminData}
            />
          )}

          {/* ORGANIZATIONS TAB */}
          {section === "orgs" && (
            <OrgsAdmin orgs={orgs} />
          )}

          {/* WORKSPACES TAB */}
          {section === "workspaces" && (
            <WorkspacesAdmin workspaces={workspaces} />
          )}

          {/* RUNS TAB */}
          {section === "runs" && (
            <RunsAdmin runs={runs} handleCancelRun={handleCancelRun} />
          )}

          {/* TOOL VERSIONS TAB */}
          {section === "versions" && (
            <VersionsAdmin
              handleAddVersion={handleAddVersion}
              newVersion={newVersion}
              setNewVersion={setNewVersion}
              newUrl={newUrl}
              setNewUrl={setNewUrl}
              newSha={newSha}
              setNewSha={setNewSha}
              tfVersions={tfVersions}
              setVersionToDelete={setVersionToDelete}
            />
          )}

          {/* AUDIT LOGS TAB */}
          {section === "audit" && (
            <AuditAdmin auditLogs={auditLogs} />
          )}

          {/* AUTHENTICATION TAB */}
          {section === "auth" && (
<AuthAdmin
              general={{
                loading: generalLoading,
                saving: generalSaving,
                error: generalError,
                localAuthEnabled,
                setLocalAuthEnabled,
                trustedClientIpHeaders,
                setTrustedClientIpHeaders,
                persistedSamlEnabled,
                persistedOidcEnabled,
                persistedLdapEnabled,
                handleSave: handleSaveGeneral,
              }}
              saml={{
                loading: samlLoading,
                saving: samlSaving,
                error: samlError,
                enabled: samlEnabled,
                setEnabled: setSamlEnabled,
                debug: samlDebug,
                setDebug: setSamlDebug,
                linkByEmail: samlLinkByEmail,
                setLinkByEmail: setSamlLinkByEmail,
                ssoUrl: samlSsoUrl,
                setSsoUrl: setSamlSsoUrl,
                idpEntityId: samlIdpEntityId,
                setIdpEntityId: setSamlIdpEntityId,
                sloUrl: samlSloUrl,
                setSloUrl: setSamlSloUrl,
                idpCert: samlIdpCert,
                setIdpCert: setSamlIdpCert,
                attrUsername: samlAttrUsername,
                setAttrUsername: setSamlAttrUsername,
                attrGroups: samlAttrGroups,
                setAttrGroups: setSamlAttrGroups,
                attrEmail: samlAttrEmail,
                setAttrEmail: setSamlAttrEmail,
                attrSiteAdmin: samlAttrSiteAdmin,
                setAttrSiteAdmin: setSamlAttrSiteAdmin,
                siteAdminRole: samlSiteAdminRole,
                setSiteAdminRole: setSamlSiteAdminRole,
                timeout: samlTimeout,
                setTimeout: setSamlTimeout,
                acsUrl: samlAcsUrl,
                metadataUrl: samlMetadataUrl,
                handleSave: handleSaveSaml,
              }}
              oidc={{
                loading: oidcLoading,
                saving: oidcSaving,
                error: oidcError,
                enabled: oidcEnabled,
                setEnabled: setOidcEnabled,
                linkByEmail: oidcLinkByEmail,
                setLinkByEmail: setOidcLinkByEmail,
                issuer: oidcIssuer,
                setIssuer: setOidcIssuer,
                clientId: oidcClientId,
                setClientId: setOidcClientId,
                clientSecret: oidcClientSecret,
                setClientSecret: setOidcClientSecret,
                clientSecretSet: oidcClientSecretSet,
                scopes: oidcScopes,
                setScopes: setOidcScopes,
                pkceMethod: oidcPkceMethod,
                setPkceMethod: setOidcPkceMethod,
                signingAlg: oidcSigningAlg,
                setSigningAlg: setOidcSigningAlg,
                handleSave: handleSaveOidc,
              }}
              ldap={{
                loading: ldapLoading,
                saving: ldapSaving,
                error: ldapError,
                enabled: ldapEnabled,
                setEnabled: setLdapEnabled,
                linkByEmail: ldapLinkByEmail,
                setLinkByEmail: setLdapLinkByEmail,
                host: ldapHost,
                setHost: setLdapHost,
                port: ldapPort,
                setPort: setLdapPort,
                encryption: ldapEncryption,
                setEncryption: setLdapEncryption,
                baseDn: ldapBaseDn,
                setBaseDn: setLdapBaseDn,
                bindDn: ldapBindDn,
                setBindDn: setLdapBindDn,
                bindPassword: ldapBindPassword,
                setBindPassword: setLdapBindPassword,
                bindPasswordSet: ldapBindPasswordSet,
                userFilter: ldapUserFilter,
                setUserFilter: setLdapUserFilter,
                attrUsername: ldapAttrUsername,
                setAttrUsername: setLdapAttrUsername,
                attrEmail: ldapAttrEmail,
                setAttrEmail: setLdapAttrEmail,
                attrDisplayName: ldapAttrDisplayName,
                setAttrDisplayName: setLdapAttrDisplayName,
                handleSave: handleSaveLdap,
              }}
            />
          )}
        </>
      )}

      <ConfirmDialog
        open={versionToDelete !== null}
        onOpenChange={(open): void => { if (!open) setVersionToDelete(null); }}
        title="Delete Terraform Version"
        description={`Permanently delete version "${versionToDelete?.label ?? ""}" from the registered binaries? This cannot be undone; runs pinned to it will fail until a replacement version is registered.`}
        confirmText="Delete Version"
        confirmVariant="destructive"
        requireText={versionToDelete?.label}
        onConfirm={async (): Promise<void> => {
          if (versionToDelete !== null) {
            await handleDeleteVersion(versionToDelete.id);
          }
        }}
      />

      {/* Create User Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={(open: boolean): void => { if (!open) { setCreateDialogOpen(false); resetCreateForm(); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create New User</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateUser} className="flex flex-col gap-4">
            {createUserError !== null && (
              <div role="alert" className="p-3 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-sm">{createUserError}</div>
            )}
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground/85" htmlFor="admin-new-username">Username *</label>
              <Input
                id="admin-new-username"
                name="username"
                autoComplete="username"
                spellCheck={false}
                placeholder="jdoe"
                value={newUsername}
                onChange={(e): void => { setNewUsername(e.target.value); }}
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground/85" htmlFor="admin-new-email">Email (optional)</label>
              <Input
                id="admin-new-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="jdoe@example.com"
                value={newEmail}
                onChange={(e): void => { setNewEmail(e.target.value); }}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground/85" htmlFor="admin-new-password">Password *</label>
              <Input
                id="admin-new-password"
                name="password"
                type="password"
                autoComplete="new-password"
                placeholder="At least 10 characters"
                value={newPassword}
                onChange={(e): void => { setNewPassword(e.target.value); }}
                required
                minLength={10}
              />
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                id="new-user-site-admin"
                name="site-admin"
                type="checkbox"
                checked={newIsAdmin}
                onChange={(e): void => { setNewIsAdmin(e.target.checked); }}
                className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Grant site admin privileges"
              />
              Grant site admin privileges
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={(): void => { setCreateDialogOpen(false); resetCreateForm(); }} disabled={creatingUser}>
                Cancel
              </Button>
              <Button type="submit" disabled={creatingUser}>
                {creatingUser ? "Creating…" : "Create User"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete User Confirmation */}
      <ConfirmDialog
        open={deleteUserId !== null}
        onOpenChange={(open): void => { if (!open) setDeleteUserId(null); }}
        title="Delete User"
        description={`Permanently delete user "${deleteUserId?.label ?? ""}"? This action cannot be undone. All associated data will be removed.`}
        confirmText="Delete User"
        confirmVariant="destructive"
        requireText={deleteUserId?.label}
        onConfirm={async (): Promise<void> => {
          if (deleteUserId !== null) {
            await handleDeleteUser(deleteUserId.id);
          }
        }}
      />
    </PageShell>
  );
}
