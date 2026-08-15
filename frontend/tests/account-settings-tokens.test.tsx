import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AccountSettings } from "../src/views/AccountSettings";
import { isString } from "../src/lib/type-guards";

const originalFetch = globalThis.fetch;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/vnd.api+json" } });
}

function requestUrl(input: string | URL | Request): string {
  return isString(input) ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function token() {
  return {
    id: "tkn-1",
    attributes: {
      description: "CI pipeline",
      "created-at": "2026-07-01T00:00:00.000Z",
      "last-used-at": null,
      scopes: null,
    },
  };
}

test("deletes an API token and removes it from the list on success", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/account/details") {
      return json({ data: { id: "user-1", type: "users", attributes: { username: "alice", email: "alice@example.com", "must-change-password": false } } });
    }
    if (url === "/api/v2/users/user-1/authentication-tokens") return json({ data: [token()] });
    if (url === "/api/v2/authentication-tokens/tkn-1" && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter>
      <AccountSettings />
    </MemoryRouter>,
  );

const deleteButton = await view.findByRole("button", { name: "Delete token tkn-1" });
  fireEvent.click(deleteButton);

  await waitFor((): void => {
    expect(view.queryByText("CI pipeline")).toBeNull();
  });
  expect(view.getByText("Token deleted")).toBeTruthy();
  expect(view.getAllByText("No personal API tokens.").length).toBeGreaterThan(0);
});

test("keeps the token when deleting it fails", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/account/details") {
      return json({ data: { id: "user-1", type: "users", attributes: { username: "alice", email: "alice@example.com", "must-change-password": false } } });
    }
    if (url === "/api/v2/users/user-1/authentication-tokens") return json({ data: [token()] });
    if (url === "/api/v2/authentication-tokens/tkn-1" && init?.method === "DELETE") {
      return json({ errors: [{ title: "Token cannot be deleted" }] }, 400);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter>
      <AccountSettings />
    </MemoryRouter>,
  );

  const deleteButton = await view.findByRole("button", { name: "Delete token tkn-1" });
  fireEvent.click(deleteButton);

  await waitFor((): void => {
    expect(view.getByText("Token cannot be deleted")).toBeTruthy();
  });
  expect(view.getByText("CI pipeline")).toBeTruthy();
});