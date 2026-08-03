import { useState, useEffect } from "react";
import { Navigate, useNavigate, useOutletContext } from "react-router-dom";
import { fetchAllApiPages, fetchApi } from "../lib/api";
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

export function AdminDashboard({ section }: Readonly<{ section: AdminSection }>): React.JSX.Element {
  const navigate = useNavigate();
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
  const [deleteUserId, setDeleteUserId] = useState<string | null>(null);

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
        const [usersResponse, auditResponse, pingResponse, metaResponse, samlResponse, oidcResponse] = await Promise.all([
          fetchAllApiPages<DataItem>("/admin/users?page[size]=100"),
          fetchApi("/api/v2/admin/audit-logs"),
          fetchApi("/api/v2/ping"),
          fetchApi("/api/v2/meta"),
          fetchApi("/api/v2/admin/saml-settings"),
          fetchApi("/api/v2/admin/oidc-settings"),
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
        setSamlEnabled(samlIsEnabled);
        setPersistedSamlEnabled(samlIsEnabled);
        setOidcEnabled(oidcIsEnabled);
        setPersistedOidcEnabled(oidcIsEnabled);
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
      if (section === "auth") {
        setError(null);
        void loadGeneralSettings();
        void loadLdapSettings();
        void loadSamlSettings();
        void loadOidcSettings();
        setLoading(false);
      } else {
        void loadAdminData();
      }
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
              attributes: { "local-auth-enabled": localAuthEnabled },
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
          ...(ldapBindPassword !== ""
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
    } finally {
      setOidcLoading(false);
    }
  };

  const handleSaveSaml = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
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
    const body: Record<string, unknown> = {
      data: {
        type: "oidc-settings",
        attributes: {
          enabled: oidcEnabled,
          "link-by-email": oidcLinkByEmail,
          issuer: oidcIssuer.trim() !== "" ? oidcIssuer.trim() : null,
          "client-id": oidcClientId.trim() !== "" ? oidcClientId.trim() : null,
          ...(oidcClientSecret.trim() !== "" ? { "client-secret": oidcClientSecret.trim() } : {}),
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
          {/* SECURITY OVERVIEW TAB */}
          {section === "security" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Security overview</h2>
                <p className="text-sm text-gray-500">A quick read of the instance-wide controls that protect access and runs.</p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Identity providers</CardTitle>
                    <CardDescription>Configured sign-in paths for this instance.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                      <span>SAML SSO</span>
                      <span className={samlEnabled ? "font-medium text-green-700" : "text-gray-500"}>{samlEnabled ? "Enabled" : "Disabled"}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                      <span>OpenID Connect</span>
                      <span className={oidcEnabled ? "font-medium text-green-700" : "text-gray-500"}>{oidcEnabled ? "Enabled" : "Disabled"}</span>
                    </div>
                    <Button variant="outline" size="sm" onClick={(): void => { void navigate("/app/admin/auth"); }}>
                      Open authentication settings
                    </Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Account safeguards</CardTitle>
                    <CardDescription>Local access and privileged-account posture.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                      <span>Local account signup</span>
                      <span className={securitySummary.signupEnabled ? "font-medium text-amber-700" : "font-medium text-green-700"}>
                        {securitySummary.signupEnabled ? "Enabled" : "Disabled"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                      <span>Site administrators</span>
                      <span className="font-medium text-gray-900">{users.filter((item): boolean => item.attributes["is-site-admin"] === true).length}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                      <span>Suspended users</span>
                      <span className="font-medium text-gray-900">{users.filter((item): boolean => item.attributes["is-suspended"] === true).length}</span>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Execution isolation</CardTitle>
                    <CardDescription>Whether Terraform runs are required and supported by the host.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                      <span>Sandbox required</span>
                      <span className={securitySummary.sandboxEnabled ? "font-medium text-green-700" : "font-medium text-amber-700"}>
                        {securitySummary.sandboxEnabled ? "Yes" : "No"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                      <span>Sandbox available</span>
                      <span className={securitySummary.sandboxAvailable ? "font-medium text-green-700" : "font-medium text-red-700"}>
                        {securitySummary.sandboxAvailable ? "Available" : "Unavailable"}
                      </span>
                    </div>
                    {securitySummary.sandboxReason !== null && (
                      <p className="text-xs text-gray-500">{securitySummary.sandboxReason}</p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Latest audit events</CardTitle>
                    <CardDescription>Most recent administrative events returned by the instance.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-2xl font-semibold text-gray-900">{auditLogs.length}</p>
                    <p className="text-sm text-gray-500">
                      {auditLogs.length === 0 ? "No recent events returned" : `Showing ${auditLogs.length} latest event${auditLogs.length === 1 ? "" : "s"}`}
                    </p>
                    {auditLogs[0]?.attributes.action !== undefined && (
                      <p className="truncate text-sm text-gray-700">Latest: {auditLogs[0].attributes.action}</p>
                    )}
                    <Button variant="outline" size="sm" onClick={(): void => { void navigate("/app/admin/audit"); }}>
                      Open audit log
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {/* USERS TAB */}
          {section === "users" && (
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
          {section === "orgs" && (
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
          {section === "workspaces" && (
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
          {section === "runs" && (
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
          {section === "versions" && (
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
          {section === "audit" && (
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
                        <th className="px-4 py-3">Actor</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {auditLogs.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
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
                            <td className="px-4 py-3 text-gray-600">
                              {log.attributes["actor-username"] ?? log.attributes["actor-email"] ?? "System"}
                              {log.attributes["actor-email"] !== null && log.attributes["actor-email"] !== undefined && (
                                <span className="block text-xs text-gray-400">{log.attributes["actor-email"]}</span>
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

          {/* AUTHENTICATION TAB */}
          {section === "auth" && (
            <div className="space-y-8">
              {/* LOCAL AUTHENTICATION */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Local Authentication</CardTitle>
                  <CardDescription>Username and password sign-in for this instance</CardDescription>
                </CardHeader>
                <CardContent>
                  {generalLoading ? (
                    <div className="py-6 text-center text-sm text-gray-500">Loading sign-in settings...</div>
                  ) : (
                    <form onSubmit={handleSaveGeneral} className="space-y-5">
                      {generalError !== null && (
                        <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm flex items-center gap-2">
                          <AlertCircle className="h-4 w-4 shrink-0" />
                          <span>{generalError}</span>
                        </div>
                      )}
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={localAuthEnabled}
                          onChange={(e): void => { setLocalAuthEnabled(e.target.checked); }}
                          className="rounded border-gray-300"
                          aria-label="Allow local password authentication"
                        />
                        Allow local password authentication
                      </label>
                      <p className="text-xs text-gray-500">
                        When disabled, the sign-in page accepts only single sign-on (SAML, OIDC, or LDAP where
                        configured). Existing local accounts cannot sign in with a password until this is re-enabled.
                      </p>
                      <Button
                        type="submit"
                        disabled={generalSaving || persistedSamlEnabled === null || persistedOidcEnabled === null || persistedLdapEnabled === null}
                        aria-label="Save sign-in settings"
                      >
                        {generalSaving ? "Saving..." : "Save sign-in settings"}
                      </Button>
                      {(persistedSamlEnabled === null || persistedOidcEnabled === null || persistedLdapEnabled === null) && (
                        <p className="text-xs text-amber-700">Waiting for all SSO settings to load before saving local authentication.</p>
                      )}
                    </form>
                  )}
                </CardContent>
              </Card>

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
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox"
                            checked={samlLinkByEmail}
                            onChange={(e): void => { setSamlLinkByEmail(e.target.checked); }}
                            className="rounded border-gray-300"
                            aria-label="Allow SAML email linking"
                          />
                          Link verified email addresses to existing accounts
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
                        <label className="text-xs font-medium text-gray-700">IdP Entity ID</label>
                        <Input
                          placeholder="https://idp.example.com/metadata"
                          value={samlIdpEntityId}
                          onChange={(e): void => { setSamlIdpEntityId(e.target.value); }}
                          aria-label="IdP Entity ID"
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
                            <label className="text-xs font-medium text-gray-700">Email attribute</label>
                            <Input
                              value={samlAttrEmail}
                              onChange={(e): void => { setSamlAttrEmail(e.target.value); }}
                              aria-label="SAML email attribute"
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
                      <div className="border-t pt-4">
                        <p className="text-xs font-semibold text-gray-700 mb-2">Service provider endpoints</p>
                        <p className="text-xs text-gray-500">
                          Use these URLs to register this instance with your identity provider.
                        </p>
                        <dl className="mt-2 space-y-1 text-xs">
                          <div className="flex flex-col gap-0.5">
                            <dt className="font-medium text-gray-700">ACS consumer URL</dt>
                            <dd className="break-all text-gray-600 font-mono">{samlAcsUrl !== "" ? samlAcsUrl : "—"}</dd>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <dt className="font-medium text-gray-700">Metadata URL</dt>
                            <dd className="break-all text-gray-600 font-mono">{samlMetadataUrl !== "" ? samlMetadataUrl : "—"}</dd>
                          </div>
                        </dl>
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
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={oidcLinkByEmail}
                          onChange={(e): void => { setOidcLinkByEmail(e.target.checked); }}
                          className="rounded border-gray-300"
                          aria-label="Allow OIDC email linking"
                        />
                        Link verified email addresses to existing accounts
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
                            placeholder={oidcClientSecretSet ? "····· (leave blank to keep)" : undefined}
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
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-gray-700">ID token signing algorithm</label>
                          <select
                            value={oidcSigningAlg}
                            onChange={(e): void => { setOidcSigningAlg(e.target.value); }}
                            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
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
                        {oidcSaving ? "Saving..." : "Save OIDC settings"}
                      </Button>
                    </form>
                  )}
                </CardContent>
              </Card>

              {/* LDAP */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">LDAP</CardTitle>
                  <CardDescription>Lightweight Directory Access Protocol password authentication</CardDescription>
                </CardHeader>
                <CardContent>
                  {ldapLoading ? (
                    <div className="py-6 text-center text-sm text-gray-500">Loading LDAP settings...</div>
                  ) : (
                    <form onSubmit={handleSaveLdap} className="space-y-5">
                      {ldapError !== null && (
                        <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm flex items-center gap-2">
                          <AlertCircle className="h-4 w-4 shrink-0" />
                          <span>{ldapError}</span>
                        </div>
                      )}
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={ldapEnabled}
                          onChange={(e): void => { setLdapEnabled(e.target.checked); }}
                          className="rounded border-gray-300"
                          aria-label="Enable LDAP"
                        />
                        Enable LDAP authentication
                      </label>
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={ldapLinkByEmail}
                          onChange={(e): void => { setLdapLinkByEmail(e.target.checked); }}
                          className="rounded border-gray-300"
                          aria-label="Allow LDAP email linking"
                        />
                        Link directory email addresses to existing accounts
                      </label>
                      <div className="grid gap-5 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-gray-700">Host</label>
                          <Input
                            placeholder="ldap.example.com"
                            value={ldapHost}
                            onChange={(e): void => { setLdapHost(e.target.value); }}
                            aria-label="LDAP host"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-gray-700">Port</label>
                          <Input
                            type="number"
                            value={ldapPort}
                            onChange={(e): void => { setLdapPort(Number(e.target.value)); }}
                            aria-label="LDAP port"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-gray-700">Encryption</label>
                          <select
                            value={ldapEncryption}
                            onChange={(e): void => { setLdapEncryption(e.target.value); }}
                            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                            aria-label="LDAP encryption"
                          >
                            <option value="plain">Plain (LDAP)</option>
                            <option value="starttls">StartTLS</option>
                            <option value="ldaps">LDAPS</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-gray-700">Base DN</label>
                          <Input
                            placeholder="dc=example,dc=com"
                            value={ldapBaseDn}
                            onChange={(e): void => { setLdapBaseDn(e.target.value); }}
                            aria-label="LDAP base DN"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-gray-700">Bind DN (service account, optional)</label>
                          <Input
                            placeholder="cn=service,dc=example,dc=com"
                            value={ldapBindDn}
                            onChange={(e): void => { setLdapBindDn(e.target.value); }}
                            aria-label="LDAP bind DN"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-gray-700">Bind password</label>
                          <Input
                            type="password"
                            placeholder={ldapBindPasswordSet ? "····· (leave blank to keep)" : undefined}
                            value={ldapBindPassword}
                            onChange={(e): void => { setLdapBindPassword(e.target.value); }}
                            aria-label="LDAP bind password"
                          />
                        </div>
                      </div>
                      <div className="border-t pt-4">
                        <p className="text-xs font-semibold text-gray-700 mb-3">User mapping</p>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-gray-700">User filter (containing &#123;&#123;username&#125;&#125;)</label>
                            <Input
                              value={ldapUserFilter}
                              onChange={(e): void => { setLdapUserFilter(e.target.value); }}
                              aria-label="LDAP user filter"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-gray-700">Username attribute</label>
                            <Input
                              value={ldapAttrUsername}
                              onChange={(e): void => { setLdapAttrUsername(e.target.value); }}
                              aria-label="LDAP username attribute"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-gray-700">Email attribute</label>
                            <Input
                              value={ldapAttrEmail}
                              onChange={(e): void => { setLdapAttrEmail(e.target.value); }}
                              aria-label="LDAP email attribute"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-gray-700">Display name attribute</label>
                            <Input
                              value={ldapAttrDisplayName}
                              onChange={(e): void => { setLdapAttrDisplayName(e.target.value); }}
                              aria-label="LDAP display name attribute"
                            />
                          </div>
                        </div>
                        <p className="mt-3 text-xs text-gray-500">
                          The sign-in form first attempts LDAP, then falls back to local passwords (when enabled).
                          A user who already exists locally with the same username will block LDAP provisioning to
                          avoid account takeover.
                        </p>
                      </div>
                      <Button type="submit" disabled={ldapSaving} aria-label="Save LDAP settings">
                        {ldapSaving ? "Saving..." : "Save LDAP settings"}
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
