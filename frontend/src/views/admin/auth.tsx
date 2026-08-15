import { AlertCircle, } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
export function AuthAdmin(props: Readonly<{
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
};