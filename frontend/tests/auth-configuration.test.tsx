import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { Layout } from "../src/components/Layout";
import { AdminDashboard } from "../src/views/AdminDashboard";
import { isString } from "../src/lib/type-guards";
import type { JsonObject, JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;
const json = (data: JsonValue): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

/**
 * React-dom's `isInputEventSupported` flag is computed when react-dom loads
 * (before this suite's jsdom setup), so text-input `onChange` only fires
 * through the keyup polyfill path: focus the field, update its value, then
 * dispatch keyup so the change is detected. Plain fireEvent.change alone is
 * ignored by React's onChange in this environment.
 */
const typeInput = (element: HTMLInputElement, value: string): void => {
  fireEvent.focusIn(element);
  fireEvent.change(element, { target: { value } });
  fireEvent.keyUp(element, { key: "a" });
};
const urlOf = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.toString() : input.url;

// Track the configuration as the mock IdP "server" sees it after each PATCH,
// so the GET re-fetches after saving reflect the newly enabled providers.
let samlServerEnabled = false;
let oidcServerEnabled = false;
let oidcServerSecretSet = true;
let ldapServerEnabled = false;
let oidcPatchAttributes: JsonObject | null = null;
let ldapPatchAttributes: JsonObject | null = null;
let localAuthServerEnabled = true;

beforeEach((): void => {
  samlServerEnabled = false;
  oidcServerEnabled = false;
  oidcServerSecretSet = true;
  ldapServerEnabled = false;
  oidcPatchAttributes = null;
  ldapPatchAttributes = null;
  localAuthServerEnabled = true;
});

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("shows SAML and OIDC auth configuration in the admin dashboard", async (): Promise<void> => {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/account/details") {
      return json({ data: { attributes: { username: "alice", "is-site-admin": true } } });
    }
    if (url === "/api/v2/organizations?page[size]=100") return json({ data: [] });
    if (url.startsWith("/api/v2/admin/users")) return json({ data: [] });
    if (url === "/api/v2/admin/saml-settings" && init?.method === undefined) {
      return json({
        data: {
          id: "saml",
          type: "saml-settings",
          attributes: {
            enabled: samlServerEnabled,
            debug: false,
            "idp-cert": null,
            "old-idp-cert": null,
            "sso-endpoint-url": null,
            "slo-endpoint-url": null,
            "attr-username": "Username",
            "attr-groups": "MemberOf",
            "attr-site-admin": "SiteAdmin",
            "site-admin-role": "site-admins",
            "sso-api-token-session-timeout": 1209600,
            "acs-consumer-url": "http://localhost/users/saml/auth",
            "metadata-url": "http://localhost/users/saml/metadata",
          },
        },
      });
    }
    if (url === "/api/v2/admin/oidc-settings" && init?.method === undefined) {
      return json({
        data: {
          id: "oidc-settings",
          type: "oidc-settings",
          attributes: {
            enabled: oidcServerEnabled,
            issuer: null,
            "client-id": null,
            "client-secret-set": oidcServerSecretSet,
            scopes: "openid profile email",
            "pkce-method": null,
          },
        },
      });
    }
    if (url === "/api/v2/admin/saml-settings" && init?.method === "PATCH") {
      // SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const body = isString(init.body)
        ? JSON.parse(init.body) as { data?: { attributes?: { enabled?: unknown } } }
        : {};
      samlServerEnabled = body.data?.attributes?.enabled === true;
      return json({
        data: {
          id: "saml",
          type: "saml-settings",
          attributes: {
            enabled: samlServerEnabled,
            debug: false,
            "sso-endpoint-url": "https://idp.example.com/sso",
            "slo-endpoint-url": null,
            "idp-cert": null,
            "attr-username": "Username",
            "attr-groups": "MemberOf",
            "attr-site-admin": "SiteAdmin",
            "site-admin-role": "site-admins",
            "sso-api-token-session-timeout": 1209600,
          },
        },
      });
    }
    if (url === "/api/v2/admin/oidc-settings" && init?.method === "PATCH") {
      // SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const body = isString(init.body)
        ? JSON.parse(init.body) as { data?: { attributes?: JsonObject } }
        : {};
      const attributes = body.data?.attributes ?? {};
      oidcPatchAttributes = attributes;
      oidcServerEnabled = attributes["enabled"] === true;
      if (isString(attributes["client-secret"])) oidcServerSecretSet = true;
      if (attributes["client-secret"] === null) oidcServerSecretSet = false;
      return json({
        data: {
          id: "oidc-settings",
          type: "oidc-settings",
          attributes: {
            enabled: oidcServerEnabled,
            issuer: "https://accounts.example.com",
            "client-id": "my-client-id",
            "client-secret-set": oidcServerSecretSet,
            scopes: "openid profile email",
            "pkce-method": "S256",
          },
        },
      });
    }
    if (url === "/api/v2/admin/general-settings" && init?.method === undefined) {
      return json({ data: { id: "general-settings", type: "general-settings", attributes: { "local-auth-enabled": localAuthServerEnabled } } });
    }
    if (url === "/api/v2/admin/general-settings" && init?.method === "PATCH") {
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const body = isString(init.body) ? JSON.parse(init.body) as { data?: { attributes?: { "local-auth-enabled"?: boolean } } } : {};
      localAuthServerEnabled = body.data?.attributes?.["local-auth-enabled"] ?? localAuthServerEnabled;
      return json({ data: { id: "general-settings", type: "general-settings", attributes: { "local-auth-enabled": localAuthServerEnabled } } });
    }
    if (url === "/api/v2/admin/ldap-settings" && init?.method === undefined) {
      return json({
        data: {
          id: "ldap-settings",
          type: "ldap-settings",
          attributes: {
            enabled: ldapServerEnabled,
            host: "ldap.example.com",
            port: 389,
            encryption: "plain",
            "bind-dn": null,
            "bind-password-set": true,
            "base-dn": "dc=example,dc=com",
            "user-filter": "(uid={{username}})",
            "attr-username": "uid",
            "attr-email": "mail",
            "attr-display-name": "cn",
          },
        },
      });
    }
    if (url === "/api/v2/admin/ldap-settings" && init?.method === "PATCH") {
      // SAFETY: the fixture matches the JSON:API envelope the component consumes.
      const body = isString(init.body)
        ? JSON.parse(init.body) as { data?: { attributes?: JsonObject } }
        : {};
      ldapPatchAttributes = body.data?.attributes ?? null;
      ldapServerEnabled = body.data?.attributes?.["enabled"] === true;
      return json({
        data: {
          id: "ldap-settings",
          type: "ldap-settings",
          attributes: { enabled: ldapServerEnabled, host: "ldap.example.com", port: 389, "base-dn": "dc=example,dc=com" },
        },
      });
    }
    throw new Error(`Unexpected request: ${url} method=${init?.method ?? "GET"}`);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/admin/auth"]}>
      <Routes>
        <Route path="/app" element={<Layout />}>
          <Route path="admin" element={<AdminDashboard section="security" />} />
          <Route path="admin/users" element={<AdminDashboard section="users" />} />
          <Route path="admin/auth" element={<AdminDashboard section="auth" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  // The admin sections live in the sidebar, not in a dashboard navbar
  await waitFor((): void => { expect(view.getByText("SAML SSO")).toBeTruthy(); });
  expect(view.getByRole("link", { name: "Site overview" }).getAttribute("href"))
    .toBe("/app/admin");
  expect(view.getByRole("link", { name: "Users" }).getAttribute("href"))
    .toBe("/app/admin/users");
  expect(
    view.getAllByRole("link", { name: "Organizations" })
      .some((link): boolean => link.getAttribute("href") === "/app/admin/organizations"),
  ).toBeTrue();
  expect(view.getByRole("link", { name: "Authentication" }).getAttribute("aria-current"))
    .toBe("page");

  // Navigate between sections via the sidebar
  fireEvent.click(view.getByRole("link", { name: "Users" }));
  await waitFor((): void => { expect(view.getByText("Registered Users")).toBeTruthy(); });
  fireEvent.click(view.getByRole("link", { name: "Authentication" }));
  await waitFor((): void => {
    expect(view.getByRole("link", { name: "Authentication" }).getAttribute("aria-current"))
      .toBe("page");
    expect(view.getByLabelText("Enable SAML SSO")).toBeTruthy();
  });
  expect(view.getByText("OpenID Connect")).toBeTruthy();

  // --- SAML section ---
  const samlSection = view.getByText("SAML SSO").closest<HTMLElement>('[data-slot="card"]') ?? document.body;
  expect(within(samlSection).getByText(/Security Assertion Markup Language/)).toBeTruthy();

  // Enable SAML
// SAFETY: the component renders this element type for the queried role/label.
  const samlEnabledCheckbox = within(samlSection).getByLabelText("Enable SAML SSO") as HTMLInputElement;
  expect(samlEnabledCheckbox.checked).toBeFalse();
  await act(async (): Promise<void> => { fireEvent.click(samlEnabledCheckbox); });

  // Fill in SSO endpoint
// SAFETY: the component renders this element type for the queried role/label.
  const ssoInput = within(samlSection).getByLabelText("SSO Endpoint URL") as HTMLInputElement;
  await act(async (): Promise<void> => { typeInput(ssoInput, "https://idp.example.com/sso"); });
  expect(ssoInput.value).toBe("https://idp.example.com/sso");

  // Save SAML settings
  const saveSaml = within(samlSection).getByRole("button", { name: "Save SAML settings" });
  await act(async (): Promise<void> => { fireEvent.click(saveSaml); });
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/admin/saml-settings" && init?.method === "PATCH")).toBeTrue();
  });

  // --- OIDC section ---
  const oidcSection = view.getByText("OpenID Connect").closest<HTMLElement>('[data-slot="card"]') ?? document.body;
  expect(within(oidcSection).getByText(/OpenID Connect provider/)).toBeTruthy();

  // Fill in OIDC issuer URL and client ID
// SAFETY: the component renders this element type for the queried role/label.
  const issuerInput = within(oidcSection).getByLabelText("Issuer URL") as HTMLInputElement;
  await act(async (): Promise<void> => { typeInput(issuerInput, "https://accounts.example.com"); });
  expect(issuerInput.value).toBe("https://accounts.example.com");
// SAFETY: the component renders this element type for the queried role/label.
  const clientIdInput = within(oidcSection).getByLabelText("Client ID") as HTMLInputElement;
  await act(async (): Promise<void> => { typeInput(clientIdInput, "my-client-id"); });
  expect(clientIdInput.value).toBe("my-client-id");

  // Save OIDC settings
  const saveOidc = within(oidcSection).getByRole("button", { name: "Save OIDC settings" });
  await act(async (): Promise<void> => { fireEvent.click(saveOidc); });
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/admin/oidc-settings" && init?.method === "PATCH")).toBeTrue();
  });
  // The secret field was left untouched: with a client ID configured, an
  // empty secret preserves the stored value instead of clearing it.
  expect(oidcPatchAttributes?.["client-secret"]).toBeUndefined();

  // --- Local authentication section ---
  const localAuthCard = view.getByText("Local Authentication").closest<HTMLElement>('[data-slot="card"]');
  expect(localAuthCard).not.toBeNull();
  if (localAuthCard === null) throw new Error("Local authentication card is missing");
// SAFETY: the component renders this element type for the queried role/label.
  const localAuthCheckbox = within(localAuthCard).getByLabelText("Allow local password authentication") as HTMLInputElement;
  expect(localAuthCheckbox.checked).toBeTrue();
  await act(async (): Promise<void> => { fireEvent.click(localAuthCheckbox); });
  const saveLocalAuth = within(localAuthCard).getByRole("button", { name: "Save sign-in settings" });
  await act(async (): Promise<void> => { fireEvent.click(saveLocalAuth); });
  await waitFor((): void => {
    // SAFETY: the fixture matches the JSON:API envelope the component consumes.
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/admin/general-settings"
      && init?.method === "PATCH"
      && isString(init.body)
      && !(JSON.parse(init.body) as { data: { attributes: { "local-auth-enabled": boolean } } }).data.attributes["local-auth-enabled"],
    )).toBeTrue();
  });

  // --- LDAP section ---
  const ldapSection = view.getByText("LDAP").closest<HTMLElement>('[data-slot="card"]');
  if (ldapSection === null) throw new Error("LDAP card is missing");
  expect(within(ldapSection).getByText(/directory access protocol password authentication/i)).toBeTruthy();
  await waitFor((): void => { expect(view.getByRole("button", { name: "Save LDAP settings" })).toBeTruthy(); });
// SAFETY: the component renders this element type for the queried role/label.
  const ldapEnabledCheckbox = within(ldapSection).getByLabelText("Enable LDAP") as HTMLInputElement;
  expect(ldapEnabledCheckbox.checked).toBeFalse();

  await waitFor((): void => {
// SAFETY: the component renders this element type for the queried role/label.
    expect((view.getByLabelText("LDAP host") as HTMLInputElement).value).toBe("ldap.example.com");
// SAFETY: the component renders this element type for the queried role/label.
    expect((view.getByLabelText("LDAP base DN") as HTMLInputElement).value).toBe("dc=example,dc=com");
  });
  await act(async (): Promise<void> => { fireEvent.click(ldapEnabledCheckbox); });
  const saveLdap = within(ldapSection).getByRole("button", { name: "Save LDAP settings" });
  // Fill in a service account bind DN
// SAFETY: the component renders this element type for the queried role/label.
  const bindDnInput = within(ldapSection).getByLabelText("LDAP bind DN") as HTMLInputElement;
  await act(async (): Promise<void> => { typeInput(bindDnInput, "cn=service,dc=example,dc=com"); });
  expect(bindDnInput.value).toBe("cn=service,dc=example,dc=com");
  await act(async (): Promise<void> => {
    fireEvent.click(saveLdap);
  });
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/admin/ldap-settings" && init?.method === "PATCH")).toBeTrue();
  });
  // The bind password field was left untouched: with a bind DN configured,
  // an empty password preserves the stored value instead of clearing it.
  expect(ldapPatchAttributes?.["bind-password"]).toBeUndefined();
  expect(ldapPatchAttributes?.["enabled"]).toBeTrue();
});

test("hides the site administration sidebar from non-admin users", async (): Promise<void> => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/account/details") {
      return json({ data: { attributes: { username: "bob", "is-site-admin": false } } });
    }
    if (url === "/api/v2/organizations?page[size]=100") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/admin"]}>
      <Routes>
        <Route path="/app" element={<Layout />}>
          <Route index element={<p>Redirect target</p>} />
          <Route path="admin" element={<AdminDashboard section="security" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  // Non-admins are redirected to the app home once their account is loaded
  await waitFor((): void => { expect(view.getByText("Redirect target")).toBeTruthy(); });
  expect(view.queryByRole("link", { name: "Authentication" })).toBeNull();
  expect(view.queryByRole("link", { name: "Site overview" })).toBeNull();
  expect(view.getByRole("link", { name: "Organizations" }).getAttribute("href")).toBe("/app");
});

test("shows the security overview from existing admin controls", async (): Promise<void> => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/account/details") {
      return json({ data: { attributes: { username: "alice", "is-site-admin": true } } });
    }
    if (url === "/api/v2/organizations?page[size]=100") return json({ data: [] });
    if (url.startsWith("/api/v2/admin/users")) {
      return json({
        data: [
          { id: "admin-1", attributes: { username: "alice", "is-site-admin": true, "is-suspended": false } },
          { id: "user-1", attributes: { username: "bob", "is-site-admin": false, "is-suspended": true } },
        ],
      });
    }
    if (url === "/api/v2/admin/audit-logs") {
      return json({ data: [{ id: "audit-1", attributes: { action: "user.suspend" } }] });
    }
    if (url === "/api/v2/ping") return json({ "signup-enabled": false });
    if (url === "/api/v2/meta") {
      return json({ data: { "run-sandbox": { enabled: true, available: true, reason: null } } });
    }
    if (url === "/api/v2/admin/saml-settings") return json({ data: { attributes: { enabled: true } } });
    if (url === "/api/v2/admin/oidc-settings") return json({ data: { attributes: { enabled: false } } });
    if (url === "/api/v2/admin/ldap-settings") return json({ data: { attributes: { enabled: false } } });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/admin"]}>
      <Routes>
        <Route path="/app" element={<Layout />}>
          <Route path="admin" element={<AdminDashboard section="security" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Identity providers")).toBeTruthy(); });
  expect(view.getByRole("link", { name: "Site overview" }).getAttribute("aria-current"))
    .toBe("page");

  const identityCard = view.getByText("Identity providers").closest<HTMLElement>('[data-slot="card"]') ?? document.body;
  expect(within(identityCard).getByText("Enabled")).toBeTruthy();
  expect(view.getByText("Local account signup")).toBeTruthy();
  expect(view.getByText("Site administrators").nextElementSibling?.textContent).toBe("1");
  expect(view.getByText("Suspended users").nextElementSibling?.textContent).toBe("1");
  expect(view.getByText("Sandbox available")).toBeTruthy();
  expect(view.getByText("Available")).toBeTruthy();
  expect(view.getByText("Latest: user.suspend")).toBeTruthy();
});