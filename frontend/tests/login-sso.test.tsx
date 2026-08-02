import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { Login } from "../src/views/Login";

const originalFetch = globalThis.fetch;
const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("renders SAML and OIDC single sign-on buttons when the providers are enabled", async (): Promise<void> => {
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

test("hides the local password form when local authentication is disabled", async (): Promise<void> => {
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
    expect(view.getByText(/Local password sign-in is disabled/)).toBeTruthy();
  });
  expect(view.queryByLabelText(/Username/i)).toBeNull();
  expect(view.queryByRole("button", { name: "Sign in" })).toBeNull();
});

test("renders the password form when no SSO provider is enabled", async (): Promise<void> => {
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