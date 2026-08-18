import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { Login } from "../src/views/Login";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;
const json = (data: JsonValue): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("falls back to local sign-in when the ping request fails", async (): Promise<void> => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (): Promise<Response> => {
    throw new Error("ping unavailable");
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/app" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  );

  // The fallback restores local authentication and signup while keeping the
  // SSO flags disabled, so the credential form renders.
  await waitFor((): void => {
    expect(view.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(view.getByLabelText(/Username/i)).toBeTruthy();
    expect(view.getByRole("link", { name: "Create account" })).toBeTruthy();
  });
  expect(view.queryByRole("button", { name: "Sign in with SAML SSO" })).toBeNull();
  expect(view.queryByRole("button", { name: "Sign in with OpenID Connect" })).toBeNull();
});

test("renders SAML and OIDC single sign-on buttons when the providers are enabled", async (): Promise<void> => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (): Promise<Response> => json({
    "signup-enabled": false,
    "local-auth-enabled": true,
    sso: { saml: true, oidc: true, ldap: false },
  })) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/app" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("button", { name: "Sign in with SAML SSO" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Sign in with OpenID Connect" })).toBeTruthy();
  });
  expect(view.getByLabelText(/Username/i)).toBeTruthy();
});

test("shows the credential form for LDAP when local authentication is disabled", async (): Promise<void> => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (): Promise<Response> => json({
    "signup-enabled": false,
    "local-auth-enabled": false,
    sso: { saml: true, oidc: false, ldap: true },
  })) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/app" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("button", { name: "Sign in with SAML SSO" })).toBeTruthy();
    expect(view.getByLabelText(/Username/i)).toBeTruthy();
  });
  expect(view.getByRole("button", { name: "Sign in" })).toBeTruthy();
  expect(view.queryByText(/Local password sign-in is disabled/)).toBeNull();
});

test("warns when local authentication and LDAP are disabled", async (): Promise<void> => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (): Promise<Response> => json({
    "signup-enabled": false,
    "local-auth-enabled": false,
    sso: { saml: true, oidc: false, ldap: false },
  })) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/app" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("Local password sign-in is disabled. Use single sign-on below.")).toBeTruthy();
    expect(view.getByRole("button", { name: "Sign in with SAML SSO" })).toBeTruthy();
  });
  expect(view.queryByLabelText(/Username/i)).toBeNull();
  expect(view.queryByRole("button", { name: "Sign in" })).toBeNull();
});

test("reports when every authentication method is disabled", async (): Promise<void> => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (): Promise<Response> => json({
    "signup-enabled": false,
    "local-auth-enabled": false,
    sso: { saml: false, oidc: false, ldap: false },
  })) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/app" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("No authentication methods are configured. Contact an administrator.")).toBeTruthy();
  });
  expect(view.queryByLabelText(/Username/i)).toBeNull();
  expect(view.queryByRole("button", { name: "Sign in with SAML SSO" })).toBeNull();
  expect(view.queryByRole("button", { name: "Sign in with OpenID Connect" })).toBeNull();
  expect(view.queryByText("Or sign in with single sign-on")).toBeNull();
  expect(view.queryByRole("button", { name: "Sign in" })).toBeNull();
});

test("renders the password form when no SSO provider is enabled", async (): Promise<void> => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (): Promise<Response> => json({
    "signup-enabled": true,
    "local-auth-enabled": true,
    sso: { saml: false, oidc: false, ldap: false },
  })) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/app" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByLabelText(/Username/i)).toBeTruthy(); });
  expect(view.queryByRole("button", { name: "Sign in with SAML SSO" })).toBeNull();
  expect(view.queryByRole("button", { name: /single sign-on/ })).toBeNull();
});