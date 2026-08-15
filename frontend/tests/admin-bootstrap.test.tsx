import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AccountSettings } from "../src/views/AccountSettings";
import { getAuthToken, setAuthToken } from "../src/lib/api";
import { Login } from "../src/views/Login";
import { isString } from "../src/lib/type-guards";

const originalFetch = globalThis.fetch;
const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

afterEach((): void => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
});

function changeInput(element: HTMLElement, value: string): void {
// SAFETY: React attaches the _valueTracker to controlled inputs in the test renderer.
  const tracker = Reflect.get(element, "_valueTracker") as { setValue: (next: string) => void } | undefined;
  tracker?.setValue(value === "" ? "x" : "");
  Reflect.set(element, "value", value);
  fireEvent.input(element, { target: { value } });
  fireEvent.change(element, { target: { value } });
}

function requestUrl(input: string | URL | Request): string {
  if (isString(input)) return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

test("sends a temporary administrator to the password page", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (): Promise<Response> =>
    json({ data: { attributes: { token: "temporary-token", "must-change-password": true } } }),
  ) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/app/account" element={<div>Password page</div>} />
      </Routes>
    </MemoryRouter>,
  );
  changeInput(view.getByLabelText(/Username/i), "admin");
  changeInput(view.getByLabelText("Password"), "temporary-admin-password");
  await act(async () => {
    const form = view.getByRole("button", { name: "Sign in" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => { expect(view.getByText("Password page")).toBeTruthy(); });
  // Access tokens live in memory; localStorage must stay clean.
  expect(localStorage.getItem("tfe_token")).toBeNull();
  expect(getAuthToken()).toBe("temporary-token");
});

test("uses the account API to clear a forced password change", async () => {
  setAuthToken("temporary-token");
  let requiresChange = true;
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/account/details") {
      return json({
        data: {
          id: "user-1",
          attributes: {
            username: "admin",
            email: null,
            "must-change-password": requiresChange,
          },
        },
      });
    }
    if (url === "/api/v2/account/password" && init?.method === "PATCH") {
      requiresChange = false;
      return json({ data: { id: "user-1", attributes: { "must-change-password": false } } });
    }
    if (url === "/api/v2/users/user-1/authentication-tokens") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter>
      <AccountSettings />
    </MemoryRouter>,
  );
  await waitFor((): void => {
    expect(view.getByText("Change the temporary administrator password before continuing.")).toBeTruthy();
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);

  changeInput(view.getByLabelText("Current password"), "temporary-admin-password");
  changeInput(view.getByLabelText("New password"), "permanent-admin-password");
  changeInput(view.getByLabelText("Confirm new password"), "permanent-admin-password");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Change Password" }));
  });

  await waitFor((): void => {
    expect(view.queryByText("Change the temporary administrator password before continuing.")).toBeNull();
  });
  const passwordCall = fetchMock.mock.calls.find(([url]: [string | URL | Request]): boolean =>
    url === "/api/v2/account/password");
  expect(passwordCall).toBeDefined();
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
  expect(JSON.parse(passwordCall![1]!.body as string)).toEqual({
    data: {
      type: "users",
      attributes: {
        current_password: "temporary-admin-password",
        password: "permanent-admin-password",
        password_confirmation: "permanent-admin-password",
      },
    },
  });
});