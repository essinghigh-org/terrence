import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { Dashboard } from "../src/views/Dashboard";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;
const json = (data: JsonValue, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/vnd.api+json" } });
const urlOf = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.toString() : input.url;

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.localStorage.removeItem("terrence-last-org");
});

test("creates an organization and opens the working destination", async () => {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations?page[size]=100") {
      return json({ data: [{ id: "org-existing", attributes: { name: "existing", "default-iac-binary": "tofu" } }] });
    }
    if (url === "/api/v2/organizations" && init?.method === "POST") {
      return json({ data: { id: "org-acme", attributes: { name: "acme", "default-iac-binary": "terraform" } } }, 201);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app"]}>
      <Routes>
        <Route path="/app" element={<Dashboard />} />
        <Route path="/app/:orgName" element={<p>Organization opened</p>} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("existing")).toBeTruthy(); });
  expect(view.getByRole("link", { name: "existing" }).getAttribute("href")).toBe("/app/existing");
  expect(view.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/app/existing");
  fireEvent.click(view.getByRole("button", { name: "New organization" }));
  fireEvent.input(view.getByLabelText("Name"), { target: { value: "acme" } });
  fireEvent.change(view.getByLabelText("Default engine"), { target: { value: "terraform" } });
  await act(async (): Promise<void> => {
    const form = view.getByRole("button", { name: "Create organization" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => { expect(view.getByText("Organization opened")).toBeTruthy(); });
  const createCall = fetchMock.mock.calls.find(([input, init]): boolean =>
    urlOf(input) === "/api/v2/organizations" && init?.method === "POST");
  expect(createCall).toBeDefined();
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
  expect(JSON.parse(createCall?.[1]?.body as string).data.attributes).toEqual({
    name: "acme",
    "default-iac-binary": "terraform",
  });
});

test("resumes the last selected organization on a fresh page load", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations?page[size]=100") {
      return json({ data: [{ id: "org-acme", attributes: { name: "acme" } }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;
  window.localStorage.setItem("terrence-last-org", "acme");

  const view = render(
    <MemoryRouter initialEntries={["/app"]}>
      <Routes>
        <Route path="/app" element={<Dashboard />} />
        <Route path="/app/:orgName" element={<p>Organization opened</p>} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("Organization opened")).toBeTruthy();
  });
});

test("does not resume an organization that no longer exists", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations?page[size]=100") {
      return json({ data: [{ id: "org-acme", attributes: { name: "acme" } }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;
  window.localStorage.setItem("terrence-last-org", "deleted-org");

  const view = render(
    <MemoryRouter initialEntries={["/app"]}>
      <Routes>
        <Route path="/app" element={<Dashboard />} />
        <Route path="/app/:orgName" element={<p>Organization opened</p>} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("acme")).toBeTruthy();
  });
  expect(view.queryByText("Organization opened")).toBeNull();
});