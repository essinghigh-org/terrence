import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { Layout } from "../src/components/Layout";
import { AdminDashboard } from "../src/views/AdminDashboard";

const originalFetch = globalThis.fetch;
const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

/**
 * React-DOM records the last value on each controlled input in an internal
 * tracker; bun's testing DOM does not sync it before dispatching, so a plain
 * fireEvent is ignored by React's onChange. Reset the tracker first — the same
 * workaround flows.test.tsx uses.
 */
const typeInput = (element: HTMLInputElement, value: string): void => {
  const tracker = Reflect.get(element, "_valueTracker") as { setValue: (v: string) => void } | undefined;
  if (tracker !== undefined) tracker.setValue("");
  Reflect.set(element, "value", value);
  fireEvent.input(element, { target: { value } });
  fireEvent.change(element, { target: { value } });
};
const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("shows SAML and OIDC auth configuration in the admin dashboard", async (): Promise<void> => {
  // Track the configuration as the mock IdP "server" sees it after each PATCH,
  // so the GET re-fetches after saving reflect the newly enabled providers.
  let samlServerEnabled = false;
  let oidcServerEnabled = false;
  let ldapServerEnabled = false;
  let localAuthServerEnabled = true;
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
            "client-secret": null,
            scopes: "openid profile email",
            "pkce-method": null,
          },
        },
      });
    }
    if (url === "/api/v2/admin/saml-settings" && init?.method === "PATCH") {
      samlServerEnabled = true;
      return json({
        data: {
          id: "saml",
          type: "saml-settings",
          attributes: {
            enabled: true,
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
      oidcServerEnabled = true;
      return json({
        data: {
          id: "oidc-settings",
          type: "oidc-settings",
          attributes: {
            enabled: true,
            issuer: "https://accounts.example.com",
            "client-id": "my-client-id",
            "client-secret": null,
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
      const body = typeof init.body === "string" ? JSON.parse(init.body) as { data?: { attributes?: { "local-auth-enabled"?: boolean } } } : {};
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
            host: null,
            port: 389,
            encryption: "plain",
            "bind-dn": null,
            "bind-password-set": false,
            "base-dn": null,
            "user-filter": "(uid={{username}})",
            "attr-username": "uid",
            "attr-email": "mail",
            "attr-display-name": "cn",
          },
        },
      });
    }
    if (url === "/api/v2/admin/ldap-settings" && init?.method === "PATCH") {
      ldapServerEnabled = true;
      return json({
        data: {
          id: "ldap-settings",
          type: "ldap-settings",
          attributes: { enabled: true, host: "ldap.example.com", port: 389, "base-dn": "dc=example,dc=com" },
        },
      });
    }
    throw new Error(`Unexpected request: ${url} method=${init?.method ?? "GET"}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

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
  expect(view.getByRole("link", { name: "Security overview" }).getAttribute("href"))
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
  const samlSection = view.getByText("SAML SSO").closest('[data-slot="card"]') ?? document.body;
  expect(within(samlSection).getByText(/Security Assertion Markup Language/)).toBeTruthy();

  // Enable SAML
  const samlEnabledCheckbox = within(samlSection).getByLabelText("Enable SAML SSO") as HTMLInputElement;
  expect(samlEnabledCheckbox.checked).toBeFalse();
  await act(async (): Promise<void> => { fireEvent.click(samlEnabledCheckbox); });

  // Fill in SSO endpoint
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
  const oidcSection = view.getByText("OpenID Connect").closest('[data-slot="card"]') ?? document.body;
  expect(within(oidcSection).getByText(/OpenID Connect provider/)).toBeTruthy();

  // Fill in OIDC issuer URL
  const issuerInput = within(oidcSection).getByLabelText("Issuer URL") as HTMLInputElement;
  await act(async (): Promise<void> => { typeInput(issuerInput, "https://accounts.example.com"); });
  expect(issuerInput.value).toBe("https://accounts.example.com");

  // Save OIDC settings
  const saveOidc = within(oidcSection).getByRole("button", { name: "Save OIDC settings" });
  await act(async (): Promise<void> => { fireEvent.click(saveOidc); });
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/admin/oidc-settings" && init?.method === "PATCH")).toBeTrue();
  });

  // --- Local authentication section ---
  const localAuthCard = view.getByText("Local Authentication").closest('[data-slot="card"]') ?? document.body;
  const localAuthCheckbox = within(localAuthCard).getByLabelText("Allow local password authentication") as HTMLInputElement;
  expect(localAuthCheckbox.checked).toBeTrue();
  await act(async (): Promise<void> => { fireEvent.click(localAuthCheckbox); });
  const saveLocalAuth = within(localAuthCard).getByRole("button", { name: "Save sign-in settings" });
  await act(async (): Promise<void> => { fireEvent.click(saveLocalAuth); });
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/admin/general-settings"
      && init?.method === "PATCH"
      && typeof init.body === "string"
      && !(JSON.parse(init.body) as { data: { attributes: { "local-auth-enabled": boolean } } }).data.attributes["local-auth-enabled"],
    )).toBeTrue();
  });

  // --- LDAP section ---
  const ldapSection = view.getByText("LDAP").closest('[data-slot="card"]') ?? document.body;
  expect(within(ldapSection).getByText(/directory access protocol password authentication/i)).toBeTruthy();
  const ldapEnabledCheckbox = within(ldapSection).getByLabelText("Enable LDAP") as HTMLInputElement;
  expect(ldapEnabledCheckbox.checked).toBeFalse();

  // Enabling LDAP without a host must be blocked client-side (the save would
  // otherwise fail the API's host/base-dn requirement).
  await act(async (): Promise<void> => { fireEvent.click(ldapEnabledCheckbox); });
  const saveLdap = within(ldapSection).getByRole("button", { name: "Save LDAP settings" });
  await act(async (): Promise<void> => { fireEvent.click(saveLdap); });
  await waitFor((): void => {
    expect(within(ldapSection).getByText("Host and Base DN are required when LDAP is enabled.")).toBeTruthy();
  });
  // No request should have been sent for the unusable configuration.
  expect(fetchMock.mock.calls.some(([input, init]): boolean =>
    urlOf(input) === "/api/v2/admin/ldap-settings" && init?.method === "PATCH")).toBeFalse();
  // Disable again to leave the auth-tab state consistent.
  await act(async (): Promise<void> => { fireEvent.click(ldapEnabledCheckbox); });
});

test("hides the site administration sidebar from non-admin users", async (): Promise<void> => {
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/account/details") {
      return json({ data: { attributes: { username: "bob", "is-site-admin": false } } });
    }
    if (url === "/api/v2/organizations?page[size]=100") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

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
  expect(view.queryByRole("link", { name: "Security overview" })).toBeNull();
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
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

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
  expect(view.getByRole("link", { name: "Security overview" }).getAttribute("aria-current"))
    .toBe("page");

  const identityCard = view.getByText("Identity providers").closest('[data-slot="card"]') ?? document.body;
  expect(within(identityCard).getByText("Enabled")).toBeTruthy();
  expect(view.getByText("Local account signup")).toBeTruthy();
  expect(view.getByText("Site administrators").nextElementSibling?.textContent).toBe("1");
  expect(view.getByText("Suspended users").nextElementSibling?.textContent).toBe("1");
  expect(view.getByText("Sandbox available")).toBeTruthy();
  expect(view.getByText("Available")).toBeTruthy();
  expect(view.getByText("Latest: user.suspend")).toBeTruthy();
});
