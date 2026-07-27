import { useState, useEffect } from "react";
import { fetchApi } from "../lib/api";
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

export function AdminDashboard() {
  const [activeTab, setActiveTab] = useState<"users" | "orgs" | "workspaces" | "runs" | "versions" | "audit">("users");
  const [users, setUsers] = useState<any[]>([]);
  const [orgs, setOrgs] = useState<any[]>([]);
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [tfVersions, setTfVersions] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Version form state
  const [newVersion, setNewVersion] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newSha, setNewSha] = useState("");

  const loadAdminData = async () => {
    setLoading(true);
    setError(null);
    try {
      if (activeTab === "users") {
        const res = await fetchApi("/api/v2/admin/users");
        setUsers(res.data || []);
      } else if (activeTab === "orgs") {
        const res = await fetchApi("/api/v2/admin/organizations");
        setOrgs(res.data || []);
      } else if (activeTab === "workspaces") {
        const res = await fetchApi("/api/v2/admin/workspaces");
        setWorkspaces(res.data || []);
      } else if (activeTab === "runs") {
        const res = await fetchApi("/api/v2/admin/runs");
        setRuns(res.data || []);
      } else if (activeTab === "versions") {
        const res = await fetchApi("/api/v2/admin/terraform-versions");
        setTfVersions(res.data || []);
      } else if (activeTab === "audit") {
        const res = await fetchApi("/api/v2/admin/audit-logs");
        setAuditLogs(res.data || []);
      }
    } catch (err: any) {
      setError(err.message || "Failed to load admin data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAdminData();
  }, [activeTab]);

  const handleAddVersion = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (!newVersion) return;
    try {
      await fetchApi("/api/v2/admin/terraform-versions", {
        method: "POST",
        body: JSON.stringify({
          data: {
            attributes: {
              version: newVersion,
              url: newUrl || null,
              sha: newSha || null,
            },
          },
        }),
      });
      setNewVersion("");
      setNewUrl("");
      setNewSha("");
      loadAdminData();
    } catch (err: any) {
      alert(`Error adding version: ${err.message}`);
    }
  };

  const handleDeleteVersion = async (id: string) => {
    if (!confirm("Are you sure you want to delete this version?")) return;
    try {
      await fetchApi(`/api/v2/admin/terraform-versions/${id}`, { method: "DELETE" });
      loadAdminData();
    } catch (err: any) {
      alert(`Error deleting version: ${err.message}`);
    }
  };

  const handleCancelRun = async (runId: string, force = false) => {
    try {
      await fetchApi(`/api/v2/admin/runs/${runId}/actions/${force ? "force-cancel" : "cancel"}`, {
        method: "POST",
      });
      loadAdminData();
    } catch (err: any) {
      alert(`Error canceling run: ${err.message}`);
    }
  };

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
          { id: "users", label: "Users", icon: Users },
          { id: "orgs", label: "Organizations", icon: Building2 },
          { id: "workspaces", label: "Workspaces", icon: Box },
          { id: "runs", label: "System Runs", icon: PlayCircle },
          { id: "versions", label: "Tool Versions", icon: FileCode },
          { id: "audit", label: "Audit Logs", icon: History },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id as any); }}
              className={`flex items-center gap-2 pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {error && (
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
                <CardDescription>Manage user accounts across the TFE instance</CardDescription>
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
                        users.map((u) => (
                          <tr key={u.id} className="hover:bg-gray-50/50">
                            <td className="px-4 py-3 font-medium text-gray-900">{u.attributes.username}</td>
                            <td className="px-4 py-3 text-gray-600">{u.attributes.email || "—"}</td>
                            <td className="px-4 py-3">
                              {u.attributes["is-site-admin"] ? (
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
                        orgs.map((o) => (
                          <tr key={o.id} className="hover:bg-gray-50/50">
                            <td className="px-4 py-3 font-medium text-gray-900">{o.attributes.name}</td>
                            <td className="px-4 py-3">
                              <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 border border-blue-100">
                                {o.attributes["iac-binary"] || "tofu"}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-gray-600">{o.attributes["default-terraform-version"] || "latest"}</td>
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
                        workspaces.map((w) => (
                          <tr key={w.id} className="hover:bg-gray-50/50">
                            <td className="px-4 py-3 font-medium text-gray-900">{w.attributes.name}</td>
                            <td className="px-4 py-3 text-gray-600">{w.attributes["auto-apply"] ? "Enabled" : "Disabled"}</td>
                            <td className="px-4 py-3">
                              {w.attributes.locked ? (
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
                        runs.map((r) => (
                          <tr key={r.id} className="hover:bg-gray-50/50">
                            <td className="px-4 py-3 font-mono text-xs font-semibold text-gray-900">{r.id}</td>
                            <td className="px-4 py-3">
                              <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">
                                {r.attributes.status}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-gray-600">{r.attributes.message || "—"}</td>
                            <td className="px-4 py-3">
                              {r.attributes.actions["is-cancelable"] && (
                                <div className="flex gap-2">
                                  <Button size="sm" variant="outline" onClick={async () => handleCancelRun(r.id, false)}>
                                    Cancel
                                  </Button>
                                  <Button size="sm" variant="destructive" onClick={async () => handleCancelRun(r.id, true)}>
                                    Force Cancel
                                  </Button>
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
                        onChange={(e) => { setNewVersion(e.target.value); }}
                        required
                      />
                    </div>
                    <div className="space-y-1 flex-1">
                      <label className="text-xs font-medium text-gray-700">Download URL (Optional)</label>
                      <Input
                        placeholder="https://releases.hashicorp.com/terraform/..."
                        value={newUrl}
                        onChange={(e) => { setNewUrl(e.target.value); }}
                      />
                    </div>
                    <div className="space-y-1 flex-1">
                      <label className="text-xs font-medium text-gray-700">SHA256 (Optional)</label>
                      <Input
                        placeholder="a1b2c3..."
                        value={newSha}
                        onChange={(e) => { setNewSha(e.target.value); }}
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
                          tfVersions.map((v) => (
                            <tr key={v.id} className="hover:bg-gray-50/50">
                              <td className="px-4 py-3 font-semibold text-gray-900">{v.attributes.version}</td>
                              <td className="px-4 py-3 text-xs text-gray-500 truncate max-w-xs">{v.attributes.url || "Default download"}</td>
                              <td className="px-4 py-3 text-xs font-mono text-gray-400">{v.attributes.sha ? v.attributes.sha.slice(0, 12) + "..." : "—"}</td>
                              <td className="px-4 py-3">
                                <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700" onClick={async () => handleDeleteVersion(v.id)}>
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
                        auditLogs.map((log) => (
                          <tr key={log.id} className="hover:bg-gray-50/50">
                            <td className="px-4 py-3 text-xs text-gray-500">{new Date(log.attributes["created-at"]).toLocaleString()}</td>
                            <td className="px-4 py-3 font-medium text-gray-900">{log.attributes.action}</td>
                            <td className="px-4 py-3 text-gray-600">{log.attributes["resource-type"]}</td>
                            <td className="px-4 py-3 text-xs font-mono text-gray-400">{log.attributes["resource-id"] || "—"}</td>
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
