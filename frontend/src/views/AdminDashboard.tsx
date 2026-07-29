import { useState, useEffect } from "react";
import { Navigate, useOutletContext } from "react-router-dom";
import { fetchApi } from "../lib/api";
import type { LayoutOutletContext } from "../components/Layout";
import {
  Shield,
  Users,
  Building2,
  Box,
  PlayCircle,
  FileCode,
  History,
  CheckCircle2,
  AlertCircle,
  Plus,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { toast } from "../components/ui/toast";

export function AdminDashboard(): React.JSX.Element {
  const { accountLoaded, siteAdmin } = useOutletContext<LayoutOutletContext>();
  type ItemAttrs = {
    username?: string;
    email?: string | null;

    "is-site-admin"?: boolean;
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
    [key: string]: unknown;
  };
  type DataItem = { id: string; attributes: ItemAttrs };
  const [activeTab, setActiveTab] = useState<"users" | "orgs" | "workspaces" | "runs" | "versions" | "audit">("users");
  const [users, setUsers] = useState<DataItem[]>([]);
  const [orgs, setOrgs] = useState<DataItem[]>([]);
  const [workspaces, setWorkspaces] = useState<DataItem[]>([]);
  const [runs, setRuns] = useState<DataItem[]>([]);
  const [tfVersions, setTfVersions] = useState<DataItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<DataItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Version form state
  const [newVersion, setNewVersion] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newSha, setNewSha] = useState("");

  const loadAdminData = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      if (activeTab === "users") {
        const res = await fetchApi("/api/v2/admin/users") as { data: DataItem[] };
        setUsers(res.data);
      } else if (activeTab === "orgs") {
        const res = await fetchApi("/api/v2/admin/organizations") as { data: DataItem[] };
        setOrgs(res.data);
      } else if (activeTab === "workspaces") {
        const res = await fetchApi("/api/v2/admin/workspaces") as { data: DataItem[] };
        setWorkspaces(res.data);
      } else if (activeTab === "runs") {
        const res = await fetchApi("/api/v2/admin/runs") as { data: DataItem[] };
        setRuns(res.data);
      } else if (activeTab === "versions") {
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
    if (siteAdmin) void loadAdminData();
  }, [activeTab, siteAdmin]);

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

  const handleDeleteVersion = async (id: string): Promise<void> => {
    if (!confirm("Are you sure you want to delete this version?")) return;
    try {
      await fetchApi(`/api/v2/admin/terraform-versions/${id}`, { method: "DELETE" });
      void loadAdminData();
      toast.add({ title: "Terraform version deleted", type: "success" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error deleting version";
      toast.add({ title: "Could not delete Terraform version", description: msg, type: "error" });
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

  if (!accountLoaded) return <p className="p-8 text-sm text-muted-foreground">Checking site administration access…</p>;
  if (!siteAdmin) return <Navigate to="/app" replace />;

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      <div className="flex items-center justify-between border-b pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 rounded-lg text-blue-700">
            <Shield className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Site Administration</h1>
            <p className="text-sm text-gray-500">Instance-wide governance, security, and version management</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={loadAdminData} className="gap-2">
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Tabs Nav */}
      <div className="flex border-b border-gray-200 gap-6">
        {[
          { id: "users" as const, label: "Users", icon: Users },
          { id: "orgs" as const, label: "Organizations", icon: Building2 },
          { id: "workspaces" as const, label: "Workspaces", icon: Box },
          { id: "runs" as const, label: "System Runs", icon: PlayCircle },
          { id: "versions" as const, label: "Tool Versions", icon: FileCode },
          { id: "audit" as const, label: "Audit Logs", icon: History },
        ].map((tab): React.JSX.Element => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={(): void => { setActiveTab(tab.id); }}
              className={`flex items-center gap-2 pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {error != null && error !== "" && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center text-gray-500 text-sm">Loading admin resources...</div>
      ) : (
        <>
          {/* USERS TAB */}
          {activeTab === "users" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Registered Users</CardTitle>
                <CardDescription>View user accounts across the TFE instance</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 border-b text-gray-500 font-medium">
                      <tr>
                        <th className="px-4 py-3">Username</th>
                        <th className="px-4 py-3">Email</th>
                        <th className="px-4 py-3">Site Admin</th>
                        <th className="px-4 py-3">User ID</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {users.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-gray-500">
                            No users found.
                          </td>
                        </tr>
                      ) : (
                        users.map((u): React.JSX.Element => (
                          <tr key={u.id} className="hover:bg-gray-50/50">
                            <td className="px-4 py-3 font-medium text-gray-900">{u.attributes.username}</td>
                            <td className="px-4 py-3 text-gray-600">{u.attributes.email ?? "—"}</td>
                            <td className="px-4 py-3">
                              {u.attributes["is-site-admin"] === true ? (
                                <span className="inline-flex items-center gap-1 rounded bg-green-50 px-2 py-0.5 text-xs font-semibold text-green-700 border border-green-200">
                                  <CheckCircle2 className="h-3 w-3" /> Yes
                                </span>
                              ) : (
                                <span className="text-gray-400 text-xs">No</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-xs font-mono text-gray-400">{u.id}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ORGANIZATIONS TAB */}
          {activeTab === "orgs" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Organizations</CardTitle>
                <CardDescription>Overview of all active tenant organizations</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 border-b text-gray-500 font-medium">
                      <tr>
                        <th className="px-4 py-3">Organization Name</th>
                        <th className="px-4 py-3">Default Engine</th>
                        <th className="px-4 py-3">Default Version</th>
                        <th className="px-4 py-3">Org ID</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {orgs.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-gray-500">
                            No organizations found.
                          </td>
                        </tr>
                      ) : (
                        orgs.map((o): React.JSX.Element => (
                          <tr key={o.id} className="hover:bg-gray-50/50">
                            <td className="px-4 py-3 font-medium text-gray-900">{o.attributes.name}</td>
                            <td className="px-4 py-3">
                              <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 border border-blue-100">
                                {o.attributes["iac-binary"] ?? "tofu"}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-gray-600">{o.attributes["default-terraform-version"] ?? "latest"}</td>
                            <td className="px-4 py-3 text-xs font-mono text-gray-400">{o.id}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* WORKSPACES TAB */}
          {activeTab === "workspaces" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Global Workspaces</CardTitle>
                <CardDescription>Instance-wide inventory of managed infrastructure workspaces</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 border-b text-gray-500 font-medium">
                      <tr>
                        <th className="px-4 py-3">Workspace Name</th>
                        <th className="px-4 py-3">Auto Apply</th>
                        <th className="px-4 py-3">Lock Status</th>
                        <th className="px-4 py-3">Workspace ID</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {workspaces.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-gray-500">
                            No workspaces found.
                          </td>
                        </tr>
                      ) : (
                        workspaces.map((w): React.JSX.Element => (
                          <tr key={w.id} className="hover:bg-gray-50/50">
                            <td className="px-4 py-3 font-medium text-gray-900">{w.attributes.name}</td>
                            <td className="px-4 py-3 text-gray-600">{w.attributes["auto-apply"] === true ? "Enabled" : "Disabled"}</td>
                            <td className="px-4 py-3">
                              {w.attributes.locked === true ? (
                                <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 border border-amber-200">
                                  Locked
                                </span>
                              ) : (
                                <span className="text-gray-400 text-xs">Unlocked</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-xs font-mono text-gray-400">{w.id}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* RUNS TAB */}
          {activeTab === "runs" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">System Runs Queue</CardTitle>
                <CardDescription>Monitor and control active execution runs</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 border-b text-gray-500 font-medium">
                      <tr>
                        <th className="px-4 py-3">Run ID</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Message</th>
                        <th className="px-4 py-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {runs.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-gray-500">
                            No active runs found.
                          </td>
                        </tr>
                      ) : (
                        runs.map((r): React.JSX.Element => (
                          <tr key={r.id} className="hover:bg-gray-50/50">
                            <td className="px-4 py-3 font-mono text-xs font-semibold text-gray-900">{r.id}</td>
                            <td className="px-4 py-3">
                              <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">
                                {r.attributes.status}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-gray-600">{r.attributes.message ?? "—"}</td>
                            <td className="px-4 py-3">
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
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* TOOL VERSIONS TAB */}
          {activeTab === "versions" && (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Register New Terraform Version</CardTitle>
                  <CardDescription>Add binary versions available for workspace execution</CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleAddVersion} className="flex gap-4 items-end">
                    <div className="space-y-1 flex-1">
                      <label className="text-xs font-medium text-gray-700">Version</label>
                      <Input
                        placeholder="1.6.2"
                        value={newVersion}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setNewVersion(event.target.value); }}
                        required
                      />
                    </div>
                    <div className="space-y-1 flex-1">
                      <label className="text-xs font-medium text-gray-700">Download URL (Optional)</label>
                      <Input
                        placeholder="https://releases.hashicorp.com/terraform/..."
                        value={newUrl}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setNewUrl(event.target.value); }}
                      />
                    </div>
                    <div className="space-y-1 flex-1">
                      <label className="text-xs font-medium text-gray-700">SHA256 (Optional)</label>
                      <Input
                        placeholder="a1b2c3..."
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
                <CardHeader>
                  <CardTitle className="text-lg">Available Terraform / OpenTofu Versions</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="rounded-md border overflow-hidden">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-gray-50 border-b text-gray-500 font-medium">
                        <tr>
                          <th className="px-4 py-3">Version</th>
                          <th className="px-4 py-3">URL</th>
                          <th className="px-4 py-3">SHA256</th>
                          <th className="px-4 py-3">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {tfVersions.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="px-4 py-6 text-center text-gray-500">
                              No custom versions registered. (Defaulting to latest releases)
                            </td>
                          </tr>
                        ) : (
                          tfVersions.map((v): React.JSX.Element => (
                            <tr key={v.id} className="hover:bg-gray-50/50">
                              <td className="px-4 py-3 font-semibold text-gray-900">{v.attributes.version}</td>
                            <td className="px-4 py-3 text-xs text-gray-500 truncate max-w-xs">{v.attributes.url ?? "Default download"}</td>
                            <td className="px-4 py-3 text-xs font-mono text-gray-400">{v.attributes.sha != null ? v.attributes.sha.slice(0, 12) + "..." : "—"}</td>
                            <td className="px-4 py-3">
                              <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700" onClick={(): void => { void handleDeleteVersion(v.id); }}>
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* AUDIT LOGS TAB */}
          {activeTab === "audit" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Instance Audit Trail</CardTitle>
                <CardDescription>Security audit log of administrative actions</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 border-b text-gray-500 font-medium">
                      <tr>
                        <th className="px-4 py-3">Timestamp</th>
                        <th className="px-4 py-3">Action</th>
                        <th className="px-4 py-3">Resource Type</th>
                        <th className="px-4 py-3">Resource ID</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {auditLogs.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-6 text-center text-gray-500">
                            No audit log entries recorded.
                          </td>
                        </tr>
                      ) : (
                        auditLogs.map((log): React.JSX.Element => (
                          <tr key={log.id} className="hover:bg-gray-50/50">
                            <td className="px-4 py-3 text-xs text-gray-500">{new Date(log.attributes["created-at"] ?? "").toLocaleString()}</td>
                            <td className="px-4 py-3 font-medium text-gray-900">{log.attributes.action}</td>
                            <td className="px-4 py-3 text-gray-600">{log.attributes["resource-type"]}</td>
                            <td className="px-4 py-3 text-xs font-mono text-gray-400">{log.attributes["resource-id"] ?? "—"}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
