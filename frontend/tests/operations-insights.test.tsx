import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { AdminOperationsCenter } from "../src/views/AdminOperationsCenter";
import { WorkspaceInsights } from "../src/views/WorkspaceInsights";
import { RunInsights } from "../src/views/RunInsights";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

function requestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  throw new Error("Expected a JSON string request body");
}

const json = (data: JsonValue, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });

const urlOf = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.toString() : input.url;

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function AdminOutlet({ siteAdmin }: Readonly<{ siteAdmin: boolean }>): React.JSX.Element {
  return <Outlet context={{ accountLoaded: true, siteAdmin, setMustChangePassword: (): void => undefined }} />;
}

test("operations center exposes runtime, recovery and maintenance evidence only to site admins", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/admin/system-info") {
      return json({
        data: {
          version: "1.2.3",
          storage: { "free-bytes": 10 * 1024 ** 3 },
          worker: { enabled: true, "runs-queued": 3, "local-runs-executing": 1, "run-concurrency-limit": 4 },
          sandbox: { enabled: true, available: true },
        },
      });
    }
    if (url === "/api/v2/admin/operations-center") {
      return json({
        data: {
          id: "current",
          type: "operations-center",
          attributes: {
            "checked-at": "2026-09-19T12:00:00.000Z",
            "local-node-id": "ha-node-a",
            "ha-enabled": true,
            "supported-topology": "active-active-api-elected-coordinator",
            coordinator: {
              "owner-node-id": "ha-node-a",
              epoch: 7,
              active: true,
              "heartbeat-at": "2026-09-19T11:59:58.000Z",
              "expires-at": "2026-09-19T12:00:13.000Z",
            },
            "rehearsal-max-age-days": 30,
            backup: {
              status: "current",
              "last-verified-restore-at": "2026-09-18T12:00:00.000Z",
            },
            nodes: [
              {
                id: "ha-node-a",
                version: "1.2.3",
                status: "active",
                role: "leader",
                "coordinator-epoch": 7,
                stale: false,
                "last-heartbeat-at": "2026-09-19T12:00:00.000Z",
              },
              {
                id: "ha-node-b",
                version: "1.2.3",
                status: "active",
                role: "follower",
                "coordinator-epoch": 7,
                stale: false,
                "last-heartbeat-at": "2026-09-19T11:59:59.000Z",
              },
            ],
          },
        },
      });
    }
    if (url === "/api/v2/admin/maintenance-windows/preview") {
      return json({
        data: {
          id: "maintenance-windows",
          type: "maintenance-schedules",
          attributes: { enabled: false, policy: "applies-only", windows: [] },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/admin/operations"]}>
      <Routes>
        <Route path="/app" element={<AdminOutlet siteAdmin />}>
          <Route path="admin/operations" element={<AdminOperationsCenter />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "Operations center" })).toBeTruthy();
    expect(view.getByText("Runtime and execution")).toBeTruthy();
    expect(view.getByText("Control plane and recovery")).toBeTruthy();
    expect(view.getByText("Maintenance schedule")).toBeTruthy();
  });
  expect(view.getByText("3")).toBeTruthy();
  expect(view.getByText("1 / 4")).toBeTruthy();
  expect(view.getByText("current")).toBeTruthy();
  expect(view.getByText(/Topology:\s*active-active-api-elected-coordinator/)).toBeTruthy();
  expect(view.getByText("ha-node-b")).toBeTruthy();
  expect(view.getByText("follower")).toBeTruthy();

  cleanup();
  const denied = render(
    <MemoryRouter initialEntries={["/app/admin/operations"]}>
      <Routes>
        <Route path="/app" element={<AdminOutlet siteAdmin={false} />}>
          <Route path="admin/operations" element={<AdminOperationsCenter />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  expect(denied.getByText("Site-administrator access is required.")).toBeTruthy();
});

test("workspace insights compares retained state evidence without implying live cloud state", async () => {
  let comparisonBody: Record<string, unknown> | undefined;
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          type: "workspaces",
          attributes: {
            name: "production",
            "iac-binary": "terraform",
            "execution-mode": "remote",
            locked: false,
            permissions: {
              "can-read-state-versions": true,
              "can-manage-run-tasks": true,
              "can-queue-run": true,
              "can-read-variable": true,
              "can-update": true,
            },
          },
        },
      });
    }
    if (url === "/api/v2/workspaces/ws-1/state-versions?page[size]=100") {
      return json({
        data: [
          { id: "sv-2", type: "state-versions", attributes: { serial: 2, "created-at": "2026-09-19T11:00:00Z" } },
          { id: "sv-1", type: "state-versions", attributes: { serial: 1, "created-at": "2026-09-18T11:00:00Z" } },
        ],
      });
    }
    if (url === "/api/v2/workspaces/ws-1/inventory-history?q=") {
      return json({
        data: [
          {
            id: "inventory-1",
            type: "inventory-observations",
            attributes: {
              address: "azurerm_resource_group.example",
              provider: "registry.terraform.io/hashicorp/azurerm",
              serial: 2,
              "observed-at": "2026-09-19T11:00:00Z",
              "run-id": "run-2",
            },
          },
        ],
        meta: { source: "state-history", "live-cloud-current": false },
      });
    }
    if (url === "/api/v2/workspaces/ws-1/state-comparisons" && init?.method === "POST") {
      comparisonBody = JSON.parse(requestBodyText(init.body)) as Record<string, unknown>;
      return json(
        {
          data: {
            id: "cmp-1",
            type: "state-comparisons",
            attributes: {
              comparison: {
                mode: "detailed",
                resources: {
                  added: [{ address: "azurerm_storage_account.new" }],
                  removed: [],
                  changed: [],
                  moved: [],
                },
                outputs: {},
              },
            },
          },
        },
        201,
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/insights"]}>
      <Routes>
        <Route path="/app/:orgName/workspaces/:workspaceName/insights" element={<WorkspaceInsights />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "Workspace insights" })).toBeTruthy();
    expect(view.getByText("Compare state versions")).toBeTruthy();
    expect(view.getByText("Resource history")).toBeTruthy();
    expect(view.getByText("azurerm_resource_group.example")).toBeTruthy();
  });

  fireEvent.click(view.getByRole("button", { name: "Compare states" }));
  await waitFor((): void => {
    expect(comparisonBody).toBeDefined();
    expect(view.getByText(/retained state evidence, not live cloud resources/i)).toBeTruthy();
    expect(view.getByText("azurerm_storage_account.new")).toBeTruthy();
  });
  const attributes = ((comparisonBody?.["data"] as Record<string, unknown>)?.["attributes"] ?? {}) as Record<
    string,
    unknown
  >;
  expect(attributes).toEqual({
    "before-state-version-id": "sv-1",
    "after-state-version-id": "sv-2",
  });
});

test("drift review saves a changed assignee without requiring an unrelated note", async () => {
  let patchBody: Record<string, unknown> | undefined;
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          type: "workspaces",
          attributes: {
            name: "production",
            "execution-mode": "remote",
            locked: false,
            permissions: { "can-manage-run-tasks": true, "can-queue-run": true },
          },
        },
      });
    }
    if (url === "/api/v2/workspaces/ws-1/assessment-results") return json({ data: [] });
    if (url === "/api/v2/workspaces/ws-1/drift-incidents") {
      return json({
        data: [
          {
            id: "incident-1",
            type: "drift-incidents",
            attributes: {
              status: "open",
              assignee: "alice",
              "latest-assessment-id": "assessment-1",
              "observed-at": "2026-09-19T12:00:00Z",
              "updated-at": "2026-09-19T12:00:00Z",
            },
          },
        ],
      });
    }
    if (url === "/api/v2/drift-incidents/incident-1" && init?.method === "PATCH") {
      patchBody = JSON.parse(requestBodyText(init.body)) as Record<string, unknown>;
      return json({
        data: { id: "incident-1", type: "drift-incidents", attributes: { status: "open", assignee: "bob" } },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/insights?tab=drift"]}>
      <Routes>
        <Route path="/app/:orgName/workspaces/:workspaceName/insights" element={<WorkspaceInsights />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("Incident incident-1")).toBeTruthy();
  });
  const save = view.getByRole("button", { name: "Save note and assignee" });
  expect(save.hasAttribute("disabled")).toBe(true);
  fireEvent.input(view.getByLabelText("Assignee"), { target: { value: "bob" } });
  expect(save.hasAttribute("disabled")).toBe(false);
  fireEvent.click(save);
  await waitFor((): void => {
    expect(patchBody).toBeDefined();
  });
  expect((patchBody?.["data"] as Record<string, unknown>)["attributes"] as Record<string, unknown>).toEqual({
    comment: "",
    assignee: "bob",
  });
});

test("run insights defaults to the latest earlier successful run and posts an explicit plan comparison", async () => {
  let comparisonBody: Record<string, unknown> | undefined;
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/runs/run-2") {
      return json({
        data: {
          id: "run-2",
          type: "runs",
          attributes: {
            status: "applied",
            message: "Current run",
            "created-at": "2026-09-19T12:00:00Z",
            "is-destroy": false,
          },
          relationships: { workspace: { data: { id: "ws-1", type: "workspaces" } } },
        },
      });
    }
    if (url === "/api/v2/workspaces/ws-1/runs?page[size]=100") {
      return json({
        data: [
          {
            id: "run-2",
            type: "runs",
            attributes: { status: "applied", message: "Current run", "created-at": "2026-09-19T12:00:00Z" },
          },
          {
            id: "run-1",
            type: "runs",
            attributes: {
              status: "applied",
              message: "Previous successful run",
              "created-at": "2026-09-18T12:00:00Z",
              "is-destroy": false,
            },
          },
        ],
      });
    }
    if (url === "/api/v2/runs/run-2/plan-comparisons" && init?.method === "POST") {
      comparisonBody = JSON.parse(requestBodyText(init.body)) as Record<string, unknown>;
      return json(
        {
          data: {
            id: "plan-cmp-1",
            type: "plan-comparisons",
            attributes: {
              comparison: {
                mode: "detailed",
                resources: {
                  added: [],
                  removed: [],
                  changed: [{ address: "azurerm_virtual_network.main" }],
                  moved: [],
                },
                outputs: {},
              },
            },
          },
        },
        201,
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-2/insights"]}>
      <Routes>
        <Route path="/app/:orgName/workspaces/:workspaceName/runs/:runId/insights" element={<RunInsights />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "Run insights" })).toBeTruthy();
    expect(view.getByText("Compare with a previous run")).toBeTruthy();
    expect(view.getByLabelText("Baseline run")).toBeTruthy();
  });
  const baseline = view.getByLabelText("Baseline run") as HTMLSelectElement;
  expect(baseline.value).toBe("run-1");
  expect(view.getByRole("link", { name: "Open baseline run" }).getAttribute("href")).toBe(
    "/app/acme/workspaces/production/runs/run-1",
  );

  fireEvent.click(view.getByRole("button", { name: "Compare plans" }));
  await waitFor((): void => {
    expect(comparisonBody).toBeDefined();
    expect(view.getByText("azurerm_virtual_network.main")).toBeTruthy();
    expect(view.getByText(/retained public plan projections, not live cloud state/i)).toBeTruthy();
  });
  const attributes = ((comparisonBody?.["data"] as Record<string, unknown>)?.["attributes"] ?? {}) as Record<
    string,
    unknown
  >;
  expect(attributes).toEqual({ "before-run-id": "run-1" });
});
