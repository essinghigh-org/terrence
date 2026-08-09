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

test("KPI totals stay org-wide when a status filter is active", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url.includes("current-run")) {
      // Server-filtered view: only the applying workspace matches.
      return json({ data: [{
        id: "ws-1",
        attributes: { name: "filtered-only", locked: true },
        relationships: { project: { data: null } },
      }] });
    }
    if (url.includes("/workspaces?")) {
      // Unfiltered: the org-wide set used purely for the KPI cards.
      return json({ data: [
        { id: "ws-1", attributes: { name: "filtered-only", locked: true }, relationships: { project: { data: null } } },
        { id: "ws-2", attributes: { name: "idle-ws", locked: false }, relationships: { project: { data: null } } },
      ] });
    }
    if (url.includes("/projects?")) return json({ data: [] });
    if (url.includes("/runs?")) {
      return json({ data: [
        { id: "run-1", attributes: { status: "post_plan_running" }, relationships: { workspace: { data: { id: "ws-1" } } } },
        { id: "run-2", attributes: { status: "planned" }, relationships: { workspace: { data: { id: "ws-2" } } } },
      ] });
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
  fireEvent.change(view.getByLabelText("Status filter"), { target: { value: "running" } });

  await waitFor((): void => { expect(view.getByText("Post Plan Running")).toBeTruthy(); });
  const totalCard = view.getByText("Total Workspaces").parentElement!;
  const lockedCard = view.getByText("Locked Workspaces").parentElement!;
  expect(totalCard.textContent).toContain("2");
  expect(lockedCard.textContent).toContain("1");
  // The table still shows only the server-filtered workspace.
  expect(view.queryByText("idle-ws")).toBeNull();
  expect(view.getByText("filtered-only")).toBeTruthy();
  // post_plan_running counts as an active run.
  expect(view.getByText("Active Runs").parentElement!.textContent).toContain("1");
});

test("KPI totals degrade visibly when the org-wide count cannot be loaded", async () => {
  let failUnfiltered = false;
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url.includes("current-run")) {
      return json({ data: [{
        id: "ws-1",
        attributes: { name: "filtered-only", locked: true },
        relationships: { project: { data: null } },
      }] });
    }
    if (url.includes("/workspaces?")) {
      return failUnfiltered
        ? json({ errors: [{ title: "Count unavailable" }] }, 503)
        : json({ data: [{
            id: "ws-1",
            attributes: { name: "filtered-only", locked: true },
            relationships: { project: { data: null } },
          }] });
    }
    if (url.includes("/projects?")) return json({ data: [] });
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
  await waitFor((): void => { expect(view.getByText("filtered-only")).toBeTruthy(); });
  failUnfiltered = true;
  fireEvent.change(view.getByLabelText("Status filter"), { target: { value: "running" } });

  await waitFor((): void => {
    expect(view.getByText(/workspace totals are stale/)).toBeTruthy();
  });
  expect(view.getByText("Total Workspaces").parentElement!.textContent).toContain("—");
  expect(view.getByText("Locked Workspaces").parentElement!.textContent).toContain("—");
});
