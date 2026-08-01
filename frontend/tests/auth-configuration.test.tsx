import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";

import { AdminDashboard } from "../src/views/AdminDashboard";

const originalFetch = globalThis.fetch;
const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });
const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("shows SAML and OIDC auth configuration in the admin dashboard", async (): Promise<void> => {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/admin/saml-settings" && init?.method === undefined) {
      return json({
        data: {
          id: "saml",
          type: "saml-settings",
          attributes: {
            enabled: false,
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
            enabled: false,
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
    throw new Error(`Unexpected request: ${url} method=${init?.method ?? "GET"}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route element={<Outlet context={{ accountLoaded: true, siteAdmin: true }} />}>
          <Route path="/admin" element={<AdminDashboard />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  // Wait for admin dashboard to load
  await waitFor((): void => { expect(view.getByText("Registered Users")).toBeTruthy(); });

  // Switch to Authentication tab
  fireEvent.click(view.getByRole("button", { name: "Authentication" }));
  await waitFor((): void => { expect(view.getByText("SAML SSO")).toBeTruthy(); });
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
  await act(async (): Promise<void> => {
    fireEvent.input(ssoInput, { target: { value: "https://idp.example.com/sso" } });
  });
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
  await act(async (): Promise<void> => {
    fireEvent.input(issuerInput, { target: { value: "https://accounts.example.com" } });
  });
  expect(issuerInput.value).toBe("https://accounts.example.com");

  // Save OIDC settings
  const saveOidc = within(oidcSection).getByRole("button", { name: "Save OIDC settings" });
  await act(async (): Promise<void> => { fireEvent.click(saveOidc); });
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/admin/oidc-settings" && init?.method === "PATCH")).toBeTrue();
  });
});

test("hides the authentication tab from non-admin users", async (): Promise<void> => {
  globalThis.fetch = mock(async (): Promise<Response> => json({ data: [] })) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route element={<Outlet context={{ accountLoaded: true, siteAdmin: false }} />}>
          <Route path="/admin" element={<AdminDashboard />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  expect(view.queryByRole("button", { name: "Authentication" })).toBeNull();
});

test("shows the security overview from existing admin controls", async (): Promise<void> => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
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
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route element={<Outlet context={{ accountLoaded: true, siteAdmin: true }} />}>
          <Route path="/admin" element={<AdminDashboard />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Registered Users")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Security overview" }));
  await waitFor((): void => { expect(view.getByText("Identity providers")).toBeTruthy(); });

  const identityCard = view.getByText("Identity providers").closest('[data-slot="card"]') ?? document.body;
  expect(within(identityCard).getByText("Enabled")).toBeTruthy();
  expect(view.getByText("Local account signup")).toBeTruthy();
  expect(view.getByText("Site administrators").nextElementSibling?.textContent).toBe("1");
  expect(view.getByText("Suspended users").nextElementSibling?.textContent).toBe("1");
  expect(view.getByText("Sandbox available")).toBeTruthy();
  expect(view.getByText("Available")).toBeTruthy();
  expect(view.getByText("Latest: user.suspend")).toBeTruthy();
});
