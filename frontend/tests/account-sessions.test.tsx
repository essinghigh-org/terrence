import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AccountSettings } from "../src/views/AccountSettings";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

function json(data: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  return isString(input) ? input : input instanceof URL ? input.toString() : input.url;
}

function account(): Response {
  return json({
    data: {
      id: "user-1",
      type: "users",
      attributes: {
        username: "alice",
        email: "alice@example.com",
        "must-change-password": false,
      },
    },
  });
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("shows honest browser-session metadata and revokes a non-current session", async () => {
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/account/details") return account();
    if (url === "/api/v2/users/user-1/authentication-tokens") return json({ data: [] });
    if (url === "/api/v2/account/sessions" && init?.method === undefined) {
      return json({
        data: [
          {
            id: "session-current",
            type: "browser-sessions",
            attributes: {
              current: true,
              "created-at": "2026-07-29T10:00:00.000Z",
              "last-rotated-at": "2026-07-29T11:00:00.000Z",
              "expires-at": "2026-08-28T10:00:00.000Z",
              "ip-address": "203.0.113.10",
              "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            },
          },
          {
            id: "session-other",
            type: "browser-sessions",
            attributes: {
              current: false,
              "created-at": "2026-07-28T10:00:00.000Z",
              "last-rotated-at": null,
              "expires-at": "2026-08-27T10:00:00.000Z",
              "ip-address": "198.51.100.7",
              "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
            },
          },
          {
            id: "session-null-meta",
            type: "browser-sessions",
            attributes: {
              current: false,
              "created-at": "2026-07-27T10:00:00.000Z",
              "last-rotated-at": null,
              "expires-at": "2026-08-26T10:00:00.000Z",
              "ip-address": null,
              "user-agent": null,
            },
          },
        ],
      });
    }
    if (url === "/api/v2/account/sessions/session-other" && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter>
      <AccountSettings />
    </MemoryRouter>,
  );

  const currentRow = (await view.findByText("203.0.113.10")).closest("tr");
  const otherRow = (await view.findByText("198.51.100.7")).closest("tr");
  if (currentRow === null || otherRow === null) throw new Error("Expected session rows");

  expect(view.getByText(/IP address and browser recorded when you signed in/)).toBeTruthy();
  expect(within(currentRow).getByText("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")).toBeTruthy();
  expect(within(currentRow).getByText("Current")).toBeTruthy();
  expect(within(currentRow).queryByRole("button", { name: /Revoke session/ })).toBeNull();
  expect(within(otherRow).getByText("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15")).toBeTruthy();
  expect(within(otherRow).getByText("Not rotated yet")).toBeTruthy();

  const nullMetaRow = (await view.findByText("Unknown IP")).closest("tr");
  if (nullMetaRow === null) throw new Error("Expected null-metadata session row");
  expect(within(nullMetaRow).getByText("Unknown device")).toBeTruthy();
  expect(within(nullMetaRow).getByText("Not rotated yet")).toBeTruthy();

  fireEvent.click(within(otherRow).getByRole("button", { name: "Revoke session session-other" }));
  await waitFor((): void => {
    expect(view.queryByText("198.51.100.7")).toBeNull();
  });
  expect(view.getByText("203.0.113.10")).toBeTruthy();
  expect(view.getByText("Session revoked")).toBeTruthy();
  expect(fetchMock.mock.calls.some(([input, init]): boolean =>
    requestUrl(input) === "/api/v2/account/sessions/session-other"
    && init?.method === "DELETE")).toBeTrue();
});

test("keeps session load errors local and retries to an honest empty state", async () => {
  let sessionRequests = 0;
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/account/details") return account();
    if (url === "/api/v2/users/user-1/authentication-tokens") return json({ data: [] });
    if (url === "/api/v2/account/sessions") {
      sessionRequests += 1;
      return sessionRequests === 1
        ? json({ errors: [{ title: "Service unavailable" }] }, 503)
        : json({ data: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter>
      <AccountSettings />
    </MemoryRouter>,
  );

  expect(await view.findByText(/Could not load browser sessions/)).toBeTruthy();
  expect(view.getByRole("button", { name: "Save Profile" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Retry sessions" }));
  expect(await view.findByText("No active browser sessions. API tokens are listed separately.")).toBeTruthy();
  expect(sessionRequests).toBe(2);
});