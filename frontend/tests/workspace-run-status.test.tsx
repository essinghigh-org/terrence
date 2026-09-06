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
    if (url.includes("filter%5Bproject%5D")) return json({ data: [] });
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
  await waitFor((): void => { expect(view.getByText("No workspaces match the current filters")).toBeTruthy(); });
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
  expect(view.getByText("Ask an organization owner to create a workspace or give you access to one.")).toBeTruthy();
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
  await view.findByText("Projects could not be refreshed. Workspace results are still available.");
  expect(view.queryByText(/Workspace data is unavailable/)).toBeNull();
});

test("KPI totals stay org-wide on a bounded filtered page", async () => {
  const seen: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    seen.push(url);
    if (url.includes("/workspaces?")) return json({
      data: [{ id: "ws-1", attributes: { name: "filtered-only", locked: true }, relationships: currentRunRelationship("run-1") }],
      included: [includedRun("run-1", "post_plan_running", "ws-1")],
      meta: { pagination: { "total-count": 80, "total-pages": 2 }, "workspace-summary": { total: 10000, locked: 120, "run-statuses": { post_plan_running: 80, errored: 15 } } },
    });
    if (url.includes("/projects?")) return json({ data: [] });
    if (url === "/api/v2/organizations/acme") return json({ data: { attributes: { permissions: {} } } });
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  const view = render(<MemoryRouter initialEntries={["/app/acme?status=running"]}><Routes><Route path="/app/:orgName" element={<Workspaces />} /></Routes></MemoryRouter>);
  await waitFor((): void => { expect(view.getByText("Running post-plan tasks")).toBeTruthy(); });
  expect(view.getByText("Total Workspaces").parentElement!.textContent).toContain("10000");
  expect(view.getByText("Locked Workspaces").parentElement!.textContent).toContain("120");
  expect(view.getByText("Active Runs").parentElement!.textContent).toContain("80");
  expect(view.getByText("Attention Needed").parentElement!.textContent).toContain("15");
  expect(seen.filter((url): boolean => url.includes("/workspaces?"))).toHaveLength(1);
});

test("missing summary is unavailable rather than misrepresented by the page count", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url.includes("/workspaces?")) return json({ data: [{ id: "ws-1", attributes: { name: "visible", locked: true } }] });
    if (url.includes("/projects?")) return json({ data: [] });
    return json({ data: { attributes: { permissions: {} } } });
  }) as unknown as typeof fetch;
  const view = render(<MemoryRouter initialEntries={["/app/acme"]}><Routes><Route path="/app/:orgName" element={<Workspaces />} /></Routes></MemoryRouter>);
  await waitFor((): void => { expect(view.getByText("visible")).toBeTruthy(); });
  expect(view.getByText(/workspace totals are unavailable/)).toBeTruthy();
  for (const label of ["Total Workspaces", "Locked Workspaces", "Active Runs", "Attention Needed"]) {
    expect(view.getByText(label).parentElement!.textContent).toContain("—");
  }
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
        meta: { "workspace-summary": { total: 1, locked: 0, "run-statuses": { errored: 1 } } },
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
