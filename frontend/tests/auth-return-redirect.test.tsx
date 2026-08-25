import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { ProtectedRoute } from "../src/App";
import { Toaster } from "../src/components/ui/toast";
import { expireAuthSession } from "../src/lib/api";
import { Login } from "../src/views/Login";
import { isRecord, isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

const json = (data: JsonValue): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

afterEach((): void => {
  cleanup();
  expireAuthSession();
  if (localStorage !== undefined) localStorage.clear();
  globalThis.fetch = originalFetch;
});

function getUrlString(input: string | URL | Request): string {
  if (isString(input)) return input;
  if (input instanceof URL) return input.toString();
  if (isRecord(input) && "url" in input) {
    const u = input.url;
    if (isString(u)) return u;
  }
  return "";
}

// SAFETY: the value is an element in the test DOM; callers treat it as an HTMLElement.
const asElement = (el: Element | null): HTMLElement => el as HTMLElement;

const changeInput = (element: HTMLElement, value: string): void => {
// SAFETY: React attaches the _valueTracker to controlled inputs in the test renderer.
  const tracker = (element as { _valueTracker?: { setValue: (v: string) => void } })._valueTracker;
  if (tracker !== undefined) {
    tracker.setValue(value === "" ? "x" : "");
  }
  Reflect.set(element, "value", value);
  fireEvent.input(element, { target: { value } });
  fireEvent.change(element, { target: { value } });
};

let capturedPathname = "";
let capturedSearch = "";
function LocationCapture(): React.JSX.Element {
  const location = useLocation();
  capturedPathname = location.pathname;
  capturedSearch = location.search;
  return <div>Login</div>;
}

test("unauthenticated deep links carry their destination to /login", () => {
  render(
    <MemoryRouter initialEntries={["/app/account?email-verified=1"]}>
      <Routes>
        <Route path="/login" element={<LocationCapture />} />
        <Route path="/app/*" element={<ProtectedRoute><div>APP</div></ProtectedRoute>} />
      </Routes>
    </MemoryRouter>,
  );

  expect(capturedPathname).toBe("/login");
  const loginQuery = new URLSearchParams(capturedSearch);
  expect(loginQuery.get("returnTo")).toBe("/app/account?email-verified=1");
});

test("verification flags ride along to the login URL and raise the login toast", async () => {
  const view = render(
    <MemoryRouter initialEntries={["/app/account?email-verified=1"]}>
      <Toaster />
      <Routes>
        <Route path="/login" element={<><LocationCapture /><Login /></>} />
        <Route path="/app/*" element={<ProtectedRoute><div>APP</div></ProtectedRoute>} />
      </Routes>
    </MemoryRouter>,
  );

  // Full unauthenticated click-through: ProtectedRoute must surface the
  // verification flag at the top level of the login query string, not just
  // encode it inside returnTo, for the Login effect to see it.
  await waitFor((): void => {
    expect(capturedSearch.startsWith("?")).toBe(true);
    expect(new URLSearchParams(capturedSearch).get("email-verified")).toBe("1");
  });
  await waitFor((): void => { expect(view.getByText("Verification link processed")).toBeTruthy(); });
});

test("non-app paths do not get a returnTo parameter", () => {
  render(
    <MemoryRouter initialEntries={["/somewhere-else"]}>
      <Routes>
        <Route path="/login" element={<LocationCapture />} />
        <Route path="*" element={<ProtectedRoute><div>APP</div></ProtectedRoute>} />
      </Routes>
    </MemoryRouter>,
  );

  expect(capturedPathname).toBe("/login");
  expect(capturedSearch).toBe("");
});

test("sign-in returns the user to the preserved destination", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = getUrlString(input);
    if (url === "/api/v2/ping") return json({});
    if (url === "/api/v2/users/login") return json({ data: { attributes: { token: "user-token" } } });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/login?returnTo=%2Fapp%2Faccount"]}>
      <Toaster />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/app/account" element={<div>ACCOUNT</div>} />
        <Route path="/app" element={<div>HOME</div>} />
      </Routes>
    </MemoryRouter>,
  );

  changeInput(asElement(view.getByLabelText(/Username/i)), "alice");
  changeInput(asElement(view.getByLabelText("Password")), "correct horse");
  await act(async (): Promise<void> => {
    const form = view.getByRole("button", { name: "Sign in" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => { expect(view.getByText("ACCOUNT")).toBeTruthy(); });
  expect(view.queryByText("HOME")).toBeNull();
});

test("external returnTo values are ignored", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = getUrlString(input);
    if (url === "/api/v2/ping") return json({});
    if (url === "/api/v2/users/login") return json({ data: { attributes: { token: "user-token" } } });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/login?returnTo=https%3A%2F%2Fevil.example"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/app" element={<div>HOME</div>} />
      </Routes>
    </MemoryRouter>,
  );

  changeInput(asElement(view.getByLabelText(/Username/i)), "alice");
  changeInput(asElement(view.getByLabelText("Password")), "correct horse");
  await act(async (): Promise<void> => {
    const form = view.getByRole("button", { name: "Sign in" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => { expect(view.getByText("HOME")).toBeTruthy(); });
});

test("arriving at login from the verification redirect shows a confirmation toast", async () => {
  const view = render(
    <MemoryRouter initialEntries={["/login?email-verified=1"]}>
      <Toaster />
      <Routes>
        <Route path="/login" element={<Login />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Verification link processed")).toBeTruthy(); });
});
