import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AccountSettings } from "../src/views/AccountSettings";
import { Login } from "../src/views/Login";

const originalFetch = globalThis.fetch;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/vnd.api+json" } });
}
function url(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}
function account(): Response {
  return json({ data: { id: "user-1", type: "users", attributes: { username: "alice", email: "alice@example.com", "must-change-password": false } } });
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("enrolls MFA after verifying an authenticator code", async () => {
  const calls: [string, RequestInit | undefined][] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl = url(input);
    calls.push([requestUrl, init]);
    if (requestUrl === "/api/v2/account/details") return account();
    if (requestUrl === "/api/v2/users/user-1/authentication-tokens") return json({ data: [] });
    if (requestUrl === "/api/v2/account/sessions") return json({ data: [] });
    if (requestUrl === "/api/v2/account/mfa" && init?.method === undefined) return json({ data: { attributes: { enabled: false } } });
    if (requestUrl === "/api/v2/account/mfa/enroll") return json({ data: { attributes: { secret: "JBSWY3DPEHPK3PXP", "otpauth-url": "otpauth://totp/Terrence:alice" } } });
    if (requestUrl === "/api/v2/account/mfa/verify") return json({ data: { attributes: { enabled: true } } });
    throw new Error(`Unexpected request: ${requestUrl}`);
  }) as typeof fetch;

  const view = render(<MemoryRouter><AccountSettings /></MemoryRouter>);
  await view.findByText("MFA is not enabled on this account.");
  fireEvent.click(view.getByRole("button", { name: "Set up MFA" }));
  expect(await view.findByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
  fireEvent.input(view.getByLabelText("Verification code"), { target: { value: "123456" } });
  fireEvent.click(view.getByRole("button", { name: "Verify and enable MFA" }));
  await waitFor((): void => { expect(view.getByText("Multi-factor authentication enabled")).toBeTruthy(); });
  expect(calls.some(([requestUrl, init]) => requestUrl === "/api/v2/account/mfa/verify" && init?.method === "POST")).toBeTrue();
});

test("completes an MFA login challenge without exposing the password again", async () => {
  const calls: [string, RequestInit | undefined][] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl = url(input);
    calls.push([requestUrl, init]);
    if (requestUrl === "/api/v2/ping") return json({ "signup-enabled": false });
    if (requestUrl === "/api/v2/users/login" && init?.method === "POST") return json({ data: { attributes: { "mfa-required": true, "mfa-challenge-token": "challenge-1" } } });
    if (requestUrl === "/api/v2/users/login/mfa") return json({ data: { attributes: { token: "access-1" } } });
    throw new Error(`Unexpected request: ${requestUrl}`);
  }) as typeof fetch;

  const view = render(<MemoryRouter><Login /></MemoryRouter>);
  fireEvent.input(view.getByLabelText("Username or email address"), { target: { value: "alice" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "password" } });
  fireEvent.click(view.getByRole("button", { name: "Sign in" }));
  expect(await view.findByText("Verify your sign-in")).toBeTruthy();
  fireEvent.input(view.getByLabelText("Authentication code"), { target: { value: "654321" } });
  fireEvent.click(view.getByRole("button", { name: "Verify code" }));
  await waitFor((): void => {
    expect(calls.some(([requestUrl]) => requestUrl === "/api/v2/users/login/mfa")).toBeTrue();
  });
  expect(localStorage.getItem("tfe_token")).toBe("access-1");
});

test("disables MFA with a current authenticator code", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl = url(input);
    if (requestUrl === "/api/v2/account/details") return account();
    if (requestUrl === "/api/v2/users/user-1/authentication-tokens") return json({ data: [] });
    if (requestUrl === "/api/v2/account/sessions") return json({ data: [] });
    if (requestUrl === "/api/v2/account/mfa" && init?.method === undefined) return json({ data: { attributes: { enabled: true } } });
    if (requestUrl === "/api/v2/account/mfa" && init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${requestUrl}`);
  }) as typeof fetch;
  const view = render(<MemoryRouter><AccountSettings /></MemoryRouter>);
  await view.findByText("Your account requires an authenticator code at sign in.");
  fireEvent.input(view.getByLabelText("Authenticator code to disable MFA"), { target: { value: "123456" } });
  fireEvent.click(view.getByRole("button", { name: "Disable MFA" }));
  expect(await view.findByText("Multi-factor authentication disabled")).toBeTruthy();
});

