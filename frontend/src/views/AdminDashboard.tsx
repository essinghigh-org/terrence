import { useState, useEffect } from "react";
import { Navigate, useNavigate, useOutletContext } from "react-router-dom";
import { fetchAllApiPages, fetchApi } from "../lib/api";
import type { LayoutOutletContext } from "../components/Layout";
import { Shield, AlertCircle, RefreshCw } from "lucide-react";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { toast } from "../components/ui/toast";
import { PageHeader, PageShell } from "../components/PageHeader";
import { SecurityOverview } from "./admin/security";
import { UsersAdmin } from "./admin/users";
import { OrgsAdmin } from "./admin/orgs";
import { WorkspacesAdmin } from "./admin/workspaces";
import { RunsAdmin } from "./admin/runs";
import { VersionsAdmin } from "./admin/versions";
import { AuditAdmin } from "./admin/audit";
import { AuthAdmin } from "./admin/auth";
import type { AdminSection, DataItem, SecuritySummary } from "./admin/types";
import { isBoolean, isNumber, isString } from "../lib/type-guards";
import type { JsonObject } from "@/lib/json";
const attrString = (attrs: JsonObject, key: string, fallback: string): string => {
  const value = attrs[key];
  return isString(value) ? value : fallback;
};
const attrBoolean = (attrs: JsonObject, key: string, fallback: boolean): boolean => {
  const value = attrs[key];
  return isBoolean(value) ? value : fallback;
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
    sandboxExtraRwAllowed: false,
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
  const [workloadIdentityKeys, setWorkloadIdentityKeys] = useState<DataItem[]>([]);
  const [workloadIdentityError, setWorkloadIdentityError] = useState<string | null>(null);
  const [workloadIdentityAction, setWorkloadIdentityAction] = useState<"rotate" | "trim" | null>(null);
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
          loadWorkloadIdentityKeys(),
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
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        setAuditLogs((auditResponse as { data?: DataItem[] }).data ?? []);
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const ping = pingResponse as { "signup-enabled"?: boolean };
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
        const sandbox = (metaResponse as {
          data?: { "run-sandbox"?: { enabled?: boolean; available?: boolean; reason?: string | null; extraRwAllowed?: boolean } };
        }).data?.["run-sandbox"];
        setSecuritySummary({
          signupEnabled: ping["signup-enabled"] === true,
          sandboxEnabled: sandbox?.enabled === true,
          sandboxAvailable: sandbox?.available === true,
          sandboxReason: isString(sandbox?.reason) ? sandbox.reason : null,
          sandboxExtraRwAllowed: sandbox?.extraRwAllowed === true,
        });
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const samlIsEnabled = (samlResponse as { data?: { attributes?: { enabled?: boolean } } }).data?.attributes?.enabled === true;
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const oidcIsEnabled = (oidcResponse as { data?: { attributes?: { enabled?: boolean } } }).data?.attributes?.enabled === true;
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const ldapIsEnabled = (ldapResponse as { data?: { attributes?: { enabled?: boolean } } }).data?.attributes?.enabled === true;
        setSamlEnabled(samlIsEnabled);
        setPersistedSamlEnabled(samlIsEnabled);
        setOidcEnabled(oidcIsEnabled);
        setPersistedOidcEnabled(oidcIsEnabled);
        setLdapEnabled(ldapIsEnabled);
        setPersistedLdapEnabled(ldapIsEnabled);
      } else if (section === "users") {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const res = await fetchApi("/api/v2/admin/users") as { data: DataItem[] };
        setUsers(res.data);
      } else if (section === "orgs") {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const res = await fetchApi("/api/v2/admin/organizations") as { data: DataItem[] };
        setOrgs(res.data);
      } else if (section === "workspaces") {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const res = await fetchApi("/api/v2/admin/workspaces") as { data: DataItem[] };
        setWorkspaces(res.data);
      } else if (section === "runs") {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const res = await fetchApi("/api/v2/admin/runs") as { data: DataItem[] };
        setRuns(res.data);
      } else if (section === "versions") {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const res = await fetchApi("/api/v2/admin/terraform-versions") as { data: DataItem[] };
        setTfVersions(res.data);
      } else {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
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
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const res = await fetchApi("/api/v2/admin/saml-settings") as {
        data: { attributes: JsonObject };
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
      setSamlTimeout(isNumber(attrs["sso-api-token-session-timeout"]) ? attrs["sso-api-token-session-timeout"] : 1209600);
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
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const res = await fetchApi("/api/v2/admin/general-settings") as {
        data: { attributes: JsonObject };
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
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const res = await fetchApi("/api/v2/admin/ldap-settings") as {
        data: { attributes: JsonObject };
      };
      const attrs = res.data.attributes;
      setLdapEnabled(attrBoolean(attrs, "enabled", false));
      setPersistedLdapEnabled(attrBoolean(attrs, "enabled", false));
      setLdapLinkByEmail(attrBoolean(attrs, "link-by-email", false));
      setLdapHost(attrString(attrs, "host", ""));
      setLdapPort(isNumber(attrs["port"]) ? attrs["port"] : 636);
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
    const body = {
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
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const res = await fetchApi("/api/v2/admin/oidc-settings") as {
        data: { attributes: JsonObject };
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
  const loadWorkloadIdentityKeys = async (): Promise<void> => {
    setWorkloadIdentityError(null);
    try {
      const response = await fetchApi("/api/v2/admin/oidc-settings/workload-identity-keys") as { data?: DataItem[] };
      setWorkloadIdentityKeys(response.data ?? []);
    } catch (err: unknown) {
      setWorkloadIdentityError(err instanceof Error ? err.message : "Failed to load workload identity keys");
    }
  };
  const runWorkloadIdentityAction = async (action: "rotate" | "trim"): Promise<void> => {
    setWorkloadIdentityAction(action);
    setWorkloadIdentityError(null);
    try {
      await fetchApi(`/api/v2/admin/oidc-settings/actions/${action}-key`, { method: "POST" });
      await loadWorkloadIdentityKeys();
      toast.add({ title: action === "rotate" ? "Workload identity key rotated" : "Retired workload identity keys trimmed", type: "success" });
    } catch (err: unknown) {
      setWorkloadIdentityError(err instanceof Error ? err.message : "Failed to update workload identity keys");
    } finally {
      setWorkloadIdentityAction(null);
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
    const body = {
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
    const body = {
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
            <>
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
            <div className="space-y-4 rounded-md border border-border p-5">
              <div>
                <h2 className="text-base font-semibold">Workload identity signing keys</h2>
                <p className="mt-1 text-sm text-muted-foreground">Dynamic provider credentials use the public JWKS at <code>/.well-known/jwks</code>. Retired keys remain available until trimmed.</p>
              </div>
              {workloadIdentityError !== null && <p role="alert" className="text-sm text-destructive">{workloadIdentityError}</p>}
              <div className="space-y-2 text-sm">
                {workloadIdentityKeys.length === 0 ? <p className="text-muted-foreground">No signing keys have been generated yet.</p> : workloadIdentityKeys.map((key): React.JSX.Element => (
                  <div key={key.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/70 px-3 py-2">
                    <code className="text-xs">{String(key.attributes?.["key-id"] ?? key.id)}</code>
                    <span className="text-muted-foreground">{String(key.attributes?.status ?? "unknown")}</span>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={(): void => { void runWorkloadIdentityAction("rotate"); }} disabled={workloadIdentityAction !== null}>Rotate key</Button>
                <Button variant="outline" size="sm" onClick={(): void => { void runWorkloadIdentityAction("trim"); }} disabled={workloadIdentityAction !== null}>Trim retired keys</Button>
              </div>
            </div>
            </>
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
