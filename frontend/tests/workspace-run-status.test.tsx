import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { Workspaces } from "../src/views/Workspaces";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;
const json = (data: JsonValue, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
const urlOf = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.toString() : input.url;

// The workspace list now aggregates the latest run per workspace server-side
// (include=current_run): the mocks mirror that shape with a current-run
// relationship plus an included run resource.
const includedRun = (id: string, status: string, workspaceId: string) => ({
  id,
  type: "runs",
  attributes: { status, "created-at": "2026-08-01T00:00:00.000Z", message: "Manual run" },
  relationships: { workspace: { data: { id: workspaceId, type: "workspaces" } } },
});
const currentRunRelationship = (runId: string | null) => ({
  "current-run": { data: runId === null ? null : { id: runId, type: "runs" } },
});

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("shows the latest run status instead of treating an unlocked workspace as a status", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url.includes("/workspaces?")) {
      return json({
        data: [{
          id: "ws-1",
          attributes: { name: "production", locked: false },
          relationships: { project: { data: null }, ...currentRunRelationship("run-1") },
        }],
        included: [includedRun("run-1", "policy_soft_failed", "ws-1")],
      });
    }
    if (url.includes("/projects?")) {
      return json({ data: [{ id: "project-1", attributes: { name: "Platform" } }] });
    }
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { permissions: { "can-manage-workspaces": false } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Routes><Route path="/app/:orgName" element={<Workspaces />} /></Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Policy override required")).toBeTruthy(); });
  expect(view.queryByText("Available")).toBeNull();
  expect(view.queryByRole("button", { name: "New workspace" })).toBeNull();
  fireEvent.change(view.getByLabelText("Project filter"), { target: { value: "project-1" } });
  expect(view.getByText("No workspaces match the current filters")).toBeTruthy();
});

test("fails closed when workspace management permission cannot be loaded", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme") {
      return json({ errors: [{ status: "500", title: "Internal Server Error" }] }, 500);
    }
    if (url.includes("/workspaces?") || url.includes("/projects?") || url.includes("/runs?")) {
      return json({ data: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;

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
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url.includes("/workspaces?")) {
      return json({
        data: [{
          id: "ws-1",
          attributes: { name: "production", locked: false },
          relationships: { project: { data: { id: "project-1", type: "projects" } }, ...currentRunRelationship(null) },
        }],
        included: [],
      });
    }
    if (url.includes("/projects?")) {
      return json({ errors: [{ title: "Projects unavailable" }] }, 503);
    }
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { permissions: { "can-manage-workspaces": false } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;

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
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url.includes("current-run")) {
      // Server-filtered view: only the applying workspace matches, and its
      // latest run arrives as an included resource.
      return json({
        data: [{
          id: "ws-1",
          attributes: { name: "filtered-only", locked: true },
          relationships: { project: { data: null }, ...currentRunRelationship("run-1") },
        }],
        included: [includedRun("run-1", "post_plan_running", "ws-1")],
      });
    }
    if (url.includes("/workspaces?")) {
      // Unfiltered: the org-wide set used purely for the KPI cards.
      return json({
        data: [
          { id: "ws-1", attributes: { name: "filtered-only", locked: true }, relationships: { project: { data: null }, ...currentRunRelationship(null) } },
          { id: "ws-2", attributes: { name: "idle-ws", locked: false }, relationships: { project: { data: null }, ...currentRunRelationship(null) } },
        ],
        included: [],
      });
    }
    if (url.includes("/projects?")) return json({ data: [] });
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { permissions: { "can-manage-workspaces": false } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Routes><Route path="/app/:orgName" element={<Workspaces />} /></Routes>
    </MemoryRouter>,
  );
  fireEvent.change(view.getByLabelText("Status filter"), { target: { value: "running" } });

  await waitFor((): void => { expect(view.getByText("Running post-plan tasks")).toBeTruthy(); });
  const totalCard = view.getByText("Total Workspaces").parentElement!;
  const lockedCard = view.getByText("Locked Workspaces").parentElement!;
  expect(totalCard.textContent).toContain("2");
  expect(lockedCard.textContent).toContain("1");
  // The table still shows only the server-filtered workspace.
  expect(view.queryByText("idle-ws")).toBeNull();
  expect(view.getByText("filtered-only")).toBeTruthy();
  // post_plan_running is only on the filtered page: the org-wide tile stays 0 (issue #611).
  expect(view.getByText("Active Runs").parentElement!.textContent).not.toContain("1");
  expect(view.getByText("Active Runs").parentElement!.textContent).toContain("0");
});

test("KPI totals degrade visibly when the org-wide count cannot be loaded", async () => {
  let failUnfiltered = false;
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url.includes("current-run")) {
      return json({
        data: [{
          id: "ws-1",
          attributes: { name: "filtered-only", locked: true },
          relationships: { project: { data: null }, ...currentRunRelationship(null) },
        }],
        included: [],
      });
    }
    if (url.includes("/workspaces?")) {
      return failUnfiltered
        ? json({ errors: [{ title: "Count unavailable" }] }, 503)
        : json({
            data: [{
              id: "ws-1",
              attributes: { name: "filtered-only", locked: true },
              relationships: { project: { data: null }, ...currentRunRelationship(null) },
            }],
            included: [],
          });
    }
    if (url.includes("/projects?")) return json({ data: [] });
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { permissions: { "can-manage-workspaces": false } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;

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
  expect(view.getByText("Active Runs").parentElement!.textContent).toContain("—");
  expect(view.getByText("Attention Needed").parentElement!.textContent).toContain("—");
});

test("Attention tile counts errored runs and its filter includes them (issue #612)", async () => {
  const seen: string[] = [];
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    seen.push(url);
    if (url.includes("/workspaces?")) {
      return json({
        data: [{
          id: "ws-1",
          attributes: { name: "broken", locked: false },
          relationships: { project: { data: null }, ...currentRunRelationship("run-err") },
        }],
        included: [includedRun("run-err", "errored", "ws-1")],
      });
    }
    if (url.includes("/projects?")) return json({ data: [] });
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { permissions: { "can-manage-workspaces": false } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Routes><Route path="/app/:orgName" element={<Workspaces />} /></Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("broken")).toBeTruthy(); });
  expect(view.getByText("Attention Needed").parentElement!.textContent).toContain("1");
  fireEvent.click(view.getByText("Attention Needed"));
  await waitFor((): void => {
    expect(seen.some((entry: string): boolean => entry.includes("current-run") && entry.includes("errored"))).toBe(true);
  });
});