import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { Layout } from "../src/components/Layout";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

const json = (data: JsonValue): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

function urlOf(input: string | URL | Request): string {
  return isString(input) ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach((): void => {
  cleanup();
  if (localStorage !== undefined) localStorage.clear();
  globalThis.fetch = originalFetch;
});

function installFetch(): void {
// SAFETY: the mock's handling mirrors the backend contract for these tests.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/account/details") {
      return json({ data: { attributes: { username: "alice", "is-site-admin": true } } });
    }
    if (url === "/api/v2/organizations?page[size]=100") return json({ data: [] });
    if (url === "/api/v2/docs") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
}

let capturedPathname = "";
function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  capturedPathname = location.pathname;
  return <></>;
}

function renderLayout(initialEntry = "/app/acme"): ReturnType<typeof render> {
  installFetch();
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route path="/app/account" element={<p>ACCOUNT PAGE</p>} />
        <Route path="/app/:orgName" element={<Layout />}>
          <Route index element={<p>Organization content</p>} />
          <Route path="workspaces" element={<p>WORKSPACES PAGE</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

test("[ collapses and expands the sidebar", async () => {
  const view = renderLayout();
  await waitFor((): void => { expect(view.getByText("Organization content")).toBeTruthy(); });

  const toggle = view.getByRole("button", { name: "Collapse sidebar" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");

  fireEvent.keyDown(document.body, { key: "[" });

  const expandedToggle = await waitFor((): HTMLElement =>
    view.getByRole("button", { name: "Expand sidebar" }));
  expect(expandedToggle.getAttribute("aria-expanded")).toBe("false");

  fireEvent.keyDown(document.body, { key: "[" });
  await waitFor((): void => {
    expect(view.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
  });
});

test("/ opens the command palette and Escape closes it again", async () => {
  const view = renderLayout();
  await waitFor((): void => { expect(view.getByText("Organization content")).toBeTruthy(); });
  expect(view.queryByPlaceholderText(/Type a command/)).toBeNull();

  fireEvent.keyDown(document.body, { key: "/" });

  await waitFor((): void => {
    expect(view.getByPlaceholderText(/Type a command/)).toBeTruthy();
  });

  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor((): void => {
    expect(view.queryByPlaceholderText(/Type a command/)).toBeNull();
  });
});

test("? opens the shortcuts help", async () => {
  const view = renderLayout();
  await waitFor((): void => { expect(view.getByText("Organization content")).toBeTruthy(); });

  fireEvent.keyDown(document.body, { key: "?" });

  await waitFor((): void => {
    expect(view.getByText("Keyboard Shortcuts")).toBeTruthy();
  });
});

test("g then w jumps to the organization's workspaces", async () => {
  const view = renderLayout();
  await waitFor((): void => { expect(view.getByText("Organization content")).toBeTruthy(); });

  fireEvent.keyDown(document.body, { key: "g" });
  fireEvent.keyDown(document.body, { key: "w" });

  await waitFor((): void => { expect(capturedPathname).toBe("/app/acme/workspaces"); });
  expect(view.getByText("WORKSPACES PAGE")).toBeTruthy();
});

test("g then h jumps to account settings", async () => {
  const view = renderLayout();
  await waitFor((): void => { expect(view.getByText("Organization content")).toBeTruthy(); });

  fireEvent.keyDown(document.body, { key: "g" });
  fireEvent.keyDown(document.body, { key: "h" });

  await waitFor((): void => { expect(capturedPathname).toBe("/app/account"); });
  expect(view.getByText("ACCOUNT PAGE")).toBeTruthy();
});

test("a lone g without a follow-up key navigates nowhere", async () => {
  const view = renderLayout();
  await waitFor((): void => { expect(view.getByText("Organization content")).toBeTruthy(); });

  fireEvent.keyDown(document.body, { key: "g" });
  fireEvent.keyDown(document.body, { key: "x" });
  fireEvent.keyDown(document.body, { key: "w" });

  // Give the router a tick; the plain "w" must not be treated as a sequence.
  await new Promise((resolve): void => { setTimeout(resolve, 50); });
  expect(capturedPathname).toBe("/app/acme");
});

test("typing / inside a form field does not open the palette", async () => {
  const view = renderLayout();
  await waitFor((): void => { expect(view.getByText("Organization content")).toBeTruthy(); });

  const input = document.createElement("input");
  input.setAttribute("data-testid", "plain-input");
  document.body.appendChild(input);
  input.focus();

  try {
    fireEvent.keyDown(input, { key: "/" });
    fireEvent.keyDown(input, { key: "g" });
    await new Promise((resolve): void => { setTimeout(resolve, 50); });
    expect(view.queryByPlaceholderText(/Type a command/)).toBeNull();
    expect(capturedPathname).toBe("/app/acme");
  } finally {
    input.remove();
  }
});
