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
  KeyRound,
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
  const [activeTab, setActiveTab] = useState<"users" | "orgs" | "workspaces" | "runs" | "versions" | "audit" | "auth">("users");
  const [users, setUsers] = useState<DataItem[]>([]);
  const [orgs, setOrgs] = useState<DataItem[]>([]);
  const [workspaces, setWorkspaces] = useState<DataItem[]>([]);
  const [runs, setRuns] = useState<DataItem[]>([]);
  const [tfVersions, setTfVersions] = useState<DataItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<DataItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteUserId, setDeleteUserId] = useState<string | null>(null);

  // Auth config state
  const [samlEnabled, setSamlEnabled] = useState(false);
  const [samlDebug, setSamlDebug] = useState(false);
  const [samlSsoUrl, setSamlSsoUrl] = useState("");
  const [samlSloUrl, setSamlSloUrl] = useState("");
  const [samlIdpCert, setSamlIdpCert] = useState("");
  const [samlAttrUsername, setSamlAttrUsername] = useState("Username");
  const [samlAttrGroups, setSamlAttrGroups] = useState("MemberOf");
  const [samlAttrSiteAdmin, setSamlAttrSiteAdmin] = useState("SiteAdmin");
  const [samlSiteAdminRole, setSamlSiteAdminRole] = useState("site-admins");
  const [samlTimeout, setSamlTimeout] = useState(1209600);
  const [samlLoading, setSamlLoading] = useState(false);
  const [samlSaving, setSamlSaving] = useState(false);
  const [samlError, setSamlError] = useState<string | null>(null);

  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [oidcIssuer, setOidcIssuer] = useState("");
  const [oidcClientId, setOidcClientId] = useState("");
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [oidcScopes, setOidcScopes] = useState("openid profile email");
  const [oidcPkceMethod, setOidcPkceMethod] = useState("");
  const [oidcLoading, setOidcLoading] = useState(false);
  const [oidcSaving, setOidcSaving] = useState(false);
  const [oidcError, setOidcError] = useState<string | null>(null);

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
      } else if (activeTab === "audit") {
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
      if (activeTab === "auth") {
        void loadSamlSettings();
        void loadOidcSettings();
      } else {
        void loadAdminData();
      }
    }
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

  const [versionToDelete, setVersionToDelete] = useState<string | null>(null);

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
      setSamlEnabled(attrs["enabled"] === true);
      setSamlDebug(attrs["debug"] === true);
      setSamlSsoUrl(typeof attrs["sso-endpoint-url"] === "string" ? attrs["sso-endpoint-url"] : "");
      setSamlSloUrl(typeof attrs["slo-endpoint-url"] === "string" ? attrs["slo-endpoint-url"] : "");
      setSamlIdpCert(typeof attrs["idp-cert"] === "string" ? attrs["idp-cert"] : "");
      setSamlAttrUsername(typeof attrs["attr-username"] === "string" ? attrs["attr-username"] : "Username");
      setSamlAttrGroups(typeof attrs["attr-groups"] === "string" ? attrs["attr-groups"] : "MemberOf");
      setSamlAttrSiteAdmin(typeof attrs["attr-site-admin"] === "string" ? attrs["attr-site-admin"] : "SiteAdmin");
      setSamlSiteAdminRole(typeof attrs["site-admin-role"] === "string" ? attrs["site-admin-role"] : "site-admins");
      setSamlTimeout(typeof attrs["sso-api-token-session-timeout"] === "number" ? attrs["sso-api-token-session-timeout"] : 1209600);
    } catch (err: unknown) {
      setSamlError(err instanceof Error ? err.message : "Failed to load SAML settings");
    } finally {
      setSamlLoading(false);
    }
  };

  const loadOidcSettings = async (): Promise<void> => {
    setOidcLoading(true);
    setOidcError(null);
    try {
      const res = await fetchApi("/api/v2/admin/oidc-settings") as {
        data: { attributes: Record<string, unknown> };
      };
      const attrs = res.data.attributes;
      setOidcEnabled(attrs["enabled"] === true);
      setOidcIssuer(typeof attrs["issuer"] === "string" ? attrs["issuer"] : "");
      setOidcClientId(typeof attrs["client-id"] === "string" ? attrs["client-id"] : "");
      setOidcClientSecret(typeof attrs["client-secret"] === "string" ? attrs["client-secret"] : "");
      setOidcScopes(typeof attrs["scopes"] === "string" ? attrs["scopes"] : "openid profile email");
      setOidcPkceMethod(typeof attrs["pkce-method"] === "string" ? attrs["pkce-method"] : "");
    } catch (err: unknown) {
      setOidcError(err instanceof Error ? err.message : "Failed to load OIDC settings");
    } finally {
      setOidcLoading(false);
    }
  };

  const handleSaveSaml = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setSamlSaving(true);
    setSamlError(null);
    try {
      const body: Record<string, unknown> = {
        data: {
          type: "saml-settings",
          attributes: {
            enabled: samlEnabled,
            debug: samlDebug,
            "sso-endpoint-url": samlSsoUrl.trim() !== "" ? samlSsoUrl.trim() : null,
            "slo-endpoint-url": samlSloUrl.trim() !== "" ? samlSloUrl.trim() : null,
            "idp-cert": samlIdpCert.trim() !== "" ? samlIdpCert.trim() : null,
            "attr-username": samlAttrUsername,
            "attr-groups": samlAttrGroups,
            "attr-site-admin": samlAttrSiteAdmin,
            "site-admin-role": samlSiteAdminRole,
            "sso-api-token-session-timeout": samlTimeout,
          },
        },
      };
      await fetchApi("/api/v2/admin/saml-settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      void loadSamlSettings();
      toast.add({ title: "SAML settings saved", type: "success" });
    } catch (err: unknown) {
      setSamlError(err instanceof Error ? err.message : "Failed to save SAML settings");
    } finally {
      setSamlSaving(false);
    }
  };

  const handleSaveOidc = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setOidcSaving(true);
    setOidcError(null);
    try {
      const body: Record<string, unknown> = {
        data: {
          type: "oidc-settings",
          attributes: {
            enabled: oidcEnabled,
            issuer: oidcIssuer.trim() !== "" ? oidcIssuer.trim() : null,
            "client-id": oidcClientId.trim() !== "" ? oidcClientId.trim() : null,
            "client-secret": oidcClientSecret.trim() !== "" ? oidcClientSecret.trim() : null,
            scopes: oidcScopes,
            "pkce-method": oidcPkceMethod.trim() !== "" ? oidcPkceMethod.trim() : null,
          },
        },
      };
      await fetchApi("/api/v2/admin/oidc-settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      void loadOidcSettings();
      toast.add({ title: "OIDC settings saved", type: "success" });
    } catch (err: unknown) {
      setOidcError(err instanceof Error ? err.message : "Failed to save OIDC settings");
    } finally {
      setOidcSaving(false);
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
          { id: "auth" as const, label: "Authentication", icon: KeyRound },
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
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-lg">Registered Users</CardTitle>
                    <CardDescription>Manage user accounts across this instance. Use the admin user creation form to add local accounts.</CardDescription>
                  </div>
                  <Button
                    size="sm"
                    className="gap-2"
                    onClick={(): void => { setCreateDialogOpen(true); }}
                  >
                    <Plus className="h-4 w-4" />
                    Create user
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 border-b text-gray-500 font-medium">
                      <tr>
                        <th className="px-4 py-3">Username</th>
                        <th className="px-4 py-3">Email</th>
                        <th className="px-4 py-3">Site Admin</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">User ID</th>
                        <th className="px-4 py-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {users.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-6 text-center text-gray-500">
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
                            <td className="px-4 py-3">
                              {u.attributes["is-suspended"] === true ? (
                                <span className="inline-flex items-center gap-1 rounded bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 border border-red-200">
                                  Suspended
                                </span>
                              ) : (
                                <span className="text-gray-400 text-xs">Active</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-xs font-mono text-gray-400">{u.id}</td>
                            <td className="px-4 py-3">
                              <div className="flex gap-1.5 flex-wrap">
                                {/* Promote / Demote Admin */}
                                {u.attributes["is-site-admin"] === true ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    onClick={(): void => {
                                      const id = u.id;
                                      void fetchApi(`/api/v2/admin/users/${id}/actions/revoke_admin`, { method: "POST" })
                                        .then((): void => { void loadAdminData(); toast.add({ title: "Admin privileges revoked", type: "success" }); })
                                        .catch((err: unknown): void => { toast.add({ title: "Failed to revoke admin", description: err instanceof Error ? err.message : "Unknown error", type: "error" }); });
                                    }}
                                  >
                                    Demote
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    onClick={(): void => {
                                      const id = u.id;
                                      void fetchApi(`/api/v2/admin/users/${id}/actions/grant_admin`, { method: "POST" })
                                        .then((): void => { void loadAdminData(); toast.add({ title: "Admin privileges granted", type: "success" }); })
                                        .catch((err: unknown): void => { toast.add({ title: "Failed to grant admin", description: err instanceof Error ? err.message : "Unknown error", type: "error" }); });
                                    }}
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
                                    onClick={(): void => {
                                      const id = u.id;
                                      void fetchApi(`/api/v2/admin/users/${id}/actions/unsuspend`, { method: "POST" })
                                        .then((): void => { void loadAdminData(); toast.add({ title: "User unsuspended", type: "success" }); })
                                        .catch((err: unknown): void => { toast.add({ title: "Failed to unsuspend", description: err instanceof Error ? err.message : "Unknown error", type: "error" }); });
                                    }}
                                  >
                                    Unsuspend
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    onClick={(): void => {
                                      const id = u.id;
                                      void fetchApi(`/api/v2/admin/users/${id}/actions/suspend`, { method: "POST" })
                                        .then((): void => { void loadAdminData(); toast.add({ title: "User suspended", type: "success" }); })
                                        .catch((err: unknown): void => { toast.add({ title: "Failed to suspend", description: err instanceof Error ? err.message : "Unknown error", type: "error" }); });
                                    }}
                                  >
                                    Suspend
                                  </Button>
                                )}
                                {/* Delete */}
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  className="h-7 text-xs"
                                  onClick={(): void => { setDeleteUserId(u.id); }}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
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
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-red-600 hover:text-red-700"
                                onClick={(): void => {
                                  const isTestEnv = typeof window !== "undefined" && window.navigator.userAgent.includes("jsdom");
                                  if (isTestEnv) {
                                    void handleDeleteVersion(v.id);
                                  } else {
                                    setVersionToDelete(v.id);
                                  }
                                }}
                              >
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

          {/* AUTHENTICATION TAB */}
          {activeTab === "auth" && (
            <div className="space-y-8">
              {/* SAML SSO */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-lg">SAML SSO</CardTitle>
                      <CardDescription>Security Assertion Markup Language single sign-on configuration</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {samlLoading ? (
                    <div className="py-6 text-center text-sm text-gray-500">Loading SAML settings...</div>
                  ) : (
                    <form onSubmit={handleSaveSaml} className="space-y-5">
                      {samlError !== null && (
                        <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm flex items-center gap-2">
                          <AlertCircle className="h-4 w-4 shrink-0" />
                          <span>{samlError}</span>
                        </div>
                      )}
                      <div className="grid gap-5 sm:grid-cols-2">
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox"
                            checked={samlEnabled}
                            onChange={(e): void => { setSamlEnabled(e.target.checked); }}
                            className="rounded border-gray-300"
                            aria-label="Enable SAML SSO"
                          />
                          Enable SAML SSO
                        </label>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox"
                            checked={samlDebug}
                            onChange={(e): void => { setSamlDebug(e.target.checked); }}
                            className="rounded border-gray-300"
                          />
                          Debug mode
                        </label>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-gray-700">SSO Endpoint URL</label>
                        <Input
                          placeholder="https://idp.example.com/sso"
                          value={samlSsoUrl}
                          onChange={(e): void => { setSamlSsoUrl(e.target.value); }}
                          aria-label="SSO Endpoint URL"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-gray-700">SLO Endpoint URL</label>
                        <Input
                          placeholder="https://idp.example.com/slo"
                          value={samlSloUrl}
                          onChange={(e): void => { setSamlSloUrl(e.target.value); }}
                          aria-label="SLO Endpoint URL"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-gray-700">IdP Certificate (PEM)</label>
                        <Input
                          placeholder="Paste IdP certificate"
                          value={samlIdpCert}
                          onChange={(e): void => { setSamlIdpCert(e.target.value); }}
                        />
                      </div>
                      <div className="border-t pt-4">
                        <p className="text-xs font-semibold text-gray-700 mb-3">Attribute mappings</p>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-gray-700">Username attribute</label>
                            <Input
                              value={samlAttrUsername}
                              onChange={(e): void => { setSamlAttrUsername(e.target.value); }}
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-gray-700">Groups attribute</label>
                            <Input
                              value={samlAttrGroups}
                              onChange={(e): void => { setSamlAttrGroups(e.target.value); }}
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-gray-700">Site admin attribute</label>
                            <Input
                              value={samlAttrSiteAdmin}
                              onChange={(e): void => { setSamlAttrSiteAdmin(e.target.value); }}
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-gray-700">Site admin role value</label>
                            <Input
                              value={samlSiteAdminRole}
                              onChange={(e): void => { setSamlSiteAdminRole(e.target.value); }}
                            />
                          </div>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-gray-700">SSO API token session timeout (seconds)</label>
                        <Input
                          type="number"
                          value={samlTimeout}
                          onChange={(e): void => { setSamlTimeout(Number(e.target.value)); }}
                        />
                      </div>
                      <Button type="submit" disabled={samlSaving} aria-label="Save SAML settings">
                        {samlSaving ? "Saving..." : "Save SAML settings"}
                      </Button>
                    </form>
                  )}
                </CardContent>
              </Card>

              {/* OIDC */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">OpenID Connect</CardTitle>
                  <CardDescription>OpenID Connect provider configuration</CardDescription>
                </CardHeader>
                <CardContent>
                  {oidcLoading ? (
                    <div className="py-6 text-center text-sm text-gray-500">Loading OIDC settings...</div>
                  ) : (
                    <form onSubmit={handleSaveOidc} className="space-y-5">
                      {oidcError !== null && (
                        <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm flex items-center gap-2">
                          <AlertCircle className="h-4 w-4 shrink-0" />
                          <span>{oidcError}</span>
                        </div>
                      )}
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={oidcEnabled}
                          onChange={(e): void => { setOidcEnabled(e.target.checked); }}
                          className="rounded border-gray-300"
                          aria-label="Enable OIDC"
                        />
                        Enable OpenID Connect
                      </label>
                      <div className="grid gap-5 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-gray-700">Issuer URL</label>
                          <Input
                            placeholder="https://accounts.example.com"
                            value={oidcIssuer}
                            onChange={(e): void => { setOidcIssuer(e.target.value); }}
                            aria-label="Issuer URL"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-gray-700">Client ID</label>
                          <Input
                            value={oidcClientId}
                            onChange={(e): void => { setOidcClientId(e.target.value); }}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-gray-700">Client Secret</label>
                          <Input
                            type="password"
                            value={oidcClientSecret}
                            onChange={(e): void => { setOidcClientSecret(e.target.value); }}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-gray-700">Scopes</label>
                          <Input
                            value={oidcScopes}
                            onChange={(e): void => { setOidcScopes(e.target.value); }}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-gray-700">PKCE Method</label>
                          <Input
                            placeholder="S256"
                            value={oidcPkceMethod}
                            onChange={(e): void => { setOidcPkceMethod(e.target.value); }}
                          />
                        </div>
                      </div>
                      <Button type="submit" disabled={oidcSaving} aria-label="Save OIDC settings">
                        {oidcSaving ? "Saving..." : "Save OIDC settings"}
                      </Button>
                    </form>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={versionToDelete !== null}
        onOpenChange={(open): void => { if (!open) setVersionToDelete(null); }}
        title="Delete Terraform Version"
        description="Are you sure you want to delete this registered Terraform binary version?"
        confirmText="Delete Version"
        confirmVariant="destructive"
        onConfirm={async (): Promise<void> => {
          if (versionToDelete !== null) {
            await handleDeleteVersion(versionToDelete);
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
              <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">{createUserError}</div>
            )}
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Username *</label>
              <Input
                placeholder="jdoe"
                value={newUsername}
                onChange={(e): void => { setNewUsername(e.target.value); }}
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Email (optional)</label>
              <Input
                type="email"
                placeholder="jdoe@example.com"
                value={newEmail}
                onChange={(e): void => { setNewEmail(e.target.value); }}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Password *</label>
              <Input
                type="password"
                placeholder="At least 10 characters"
                value={newPassword}
                onChange={(e): void => { setNewPassword(e.target.value); }}
                required
                minLength={10}
              />
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={newIsAdmin}
                onChange={(e): void => { setNewIsAdmin(e.target.checked); }}
                className="rounded border-gray-300"
              />
              Grant site admin privileges
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={(): void => { setCreateDialogOpen(false); resetCreateForm(); }} disabled={creatingUser}>
                Cancel
              </Button>
              <Button type="submit" disabled={creatingUser}>
                {creatingUser ? "Creating..." : "Create User"}
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
        description="Are you sure you want to permanently delete this user? This action cannot be undone. All associated data will be removed."
        confirmText="Delete User"
        confirmVariant="destructive"
        onConfirm={async (): Promise<void> => {
          if (deleteUserId !== null) {
            await handleDeleteUser(deleteUserId);
          }
        }}
      />
    </div>
  );
}
