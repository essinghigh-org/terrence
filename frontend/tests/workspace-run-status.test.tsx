import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { Workspaces } from "../src/views/Workspaces";

const originalFetch = globalThis.fetch;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("shows the latest run status instead of treating an unlocked workspace as a status", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url.includes("/workspaces?")) {
      return json({ data: [{ id: "ws-1", attributes: { name: "production", locked: false }, relationships: { project: { data: null } } }] });
    }
    if (url.includes("/projects?")) {
      return json({ data: [{ id: "project-1", attributes: { name: "Platform" } }] });
    }
    if (url.includes("/runs?")) {
      return json({ data: [{ id: "run-1", attributes: { status: "policy_soft_failed" }, relationships: { workspace: { data: { id: "ws-1" } } } }] });
    }
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { permissions: { "can-manage-workspaces": false } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Routes><Route path="/app/:orgName" element={<Workspaces />} /></Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Policy Soft Failed")).toBeTruthy(); });
  expect(view.queryByText("Available")).toBeNull();
  expect(view.queryByRole("button", { name: "New workspace" })).toBeNull();
  fireEvent.change(view.getByLabelText("Project filter"), { target: { value: "project-1" } });
  expect(view.getByText("No workspaces match the current filters")).toBeTruthy();
});

test("fails closed when workspace management permission cannot be loaded", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme") {
      return json({ errors: [{ status: "500", title: "Internal Server Error" }] }, 500);
    }
    if (url.includes("/workspaces?") || url.includes("/projects?") || url.includes("/runs?")) {
      return json({ data: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Routes><Route path="/app/:orgName" element={<Workspaces />} /></Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("No workspaces yet")).toBeTruthy(); });
  expect(view.getByText("No workspaces are available in this organization.")).toBeTruthy();
  expect(view.queryByRole("button", { name: "New workspace" })).toBeNull();
  expect(view.queryByRole("heading", { name: "New Workspace" })).toBeNull();
});

test("keeps workspaces visible when project metadata cannot be loaded", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url.includes("/workspaces?")) {
      return json({
        data: [{
          id: "ws-1",
          attributes: { name: "production", locked: false },
          relationships: { project: { data: { id: "project-1", type: "projects" } } },
        }],
      });
    }
    if (url.includes("/projects?")) {
      return json({ errors: [{ title: "Projects unavailable" }] }, 503);
    }
    if (url.includes("/runs?")) return json({ data: [] });
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { permissions: { "can-manage-workspaces": false } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Routes><Route path="/app/:orgName" element={<Workspaces />} /></Routes>
    </MemoryRouter>,
  );

  await view.findByText("production");
  expect(view.getByText("Projects could not be refreshed. Workspace results are still available.")).toBeTruthy();
  expect(view.queryByText(/Workspace data is unavailable/)).toBeNull();
});
