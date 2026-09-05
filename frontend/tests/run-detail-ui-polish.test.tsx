import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RunDetail, runExecutionDurationMilliseconds } from "../src/views/RunDetail";
import { OperationFilterDropdown } from "../src/components/OperationFilterDropdown";
import type { Operation } from "../src/lib/plan-operations";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";
import { handlePhaseLogs } from "./support/run-log-fixture";

const originalFetch = globalThis.fetch;

function json(data: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (isString(input)) return input;
  return input instanceof URL ? input.toString() : input.url;
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("run duration sums execution phases and ignores input-state metadata", () => {
  expect(runExecutionDurationMilliseconds({
    "planning-at": "2026-08-24T20:40:00.000Z",
    "planned-at": "2026-08-24T20:46:26.000Z",
    "input-state-serial": "1346",
    "confirmed-at": "2026-08-24T20:54:00.000Z",
    "applying-at": "2026-08-24T20:54:30.000Z",
    "applied-at": "2026-08-24T20:55:32.000Z",
  }, false, Date.parse("2026-08-24T20:55:32.000Z"))).toBe(6 * 60_000 + 26_000 + 62_000);
});

test("legacy applied runs with planning markers show the full duration", () => {
  expect(runExecutionDurationMilliseconds({
    "planning-at": "2026-08-24T20:40:00.000Z",
    "planned-at": "2026-08-24T20:46:26.000Z",
    "applied-at": "2026-08-24T20:55:32.000Z",
  }, false, Date.parse("2026-08-24T20:55:32.000Z"))).toBe(15 * 60_000 + 32_000);
});

test("collapsible plan warnings appear at top of plan with diagnostic details", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/runs/run-warn") {
      return json({
        data: {
          id: "run-warn",
          type: "runs",
          attributes: {
            message: "Run with plan warning",
            status: "planned",
            actions: {
              "is-confirmable": true,
              "is-discardable": true,
              "is-cancelable": false,
              "is-force-cancelable": false,
            },
            permissions: {
              "can-apply": true,
              "can-discard": true,
            },
            "created-at": "2026-07-29T10:00:00.000Z",
            "status-timestamps": {
              "planning-at": "2026-07-29T08:59:00.000Z",
              "planned-at": "2026-07-29T09:00:00.000Z",
              "input-state-serial": "1346",
            },
          },
        },
      });
    }
    if (url === "/api/v2/runs/run-warn/plan") {
      return json({
        data: {
          attributes: {
            status: "finished",
            "resource-additions": 1,
            "resource-changes": 0,
            "resource-destructions": 0,
            "resource-imports": 0,
          },
        },
      });
    }
    if (url === "/api/v2/applies/apply-run-warn") {
      return json({ data: { attributes: { status: "pending" } } });
    }
    {
      const phaseLog = handlePhaseLogs(url, "run-warn", {
        plan: "Warning: Argument is deprecated\n\n  on main.tf line 5:\n  Use new_param instead of old_param.\n",
      });
      if (phaseLog !== null) return phaseLog;
    }
    if (url === "/api/v2/plans/plan-run-warn/json-output") {
      return json({
        resource_changes: [
          {
            address: "aws_instance.new",
            type: "aws_instance",
            change: { actions: ["create"], before: null, after: { id: "i-123" } },
          },
        ],
      });
    }
    if (url.endsWith("/cost-estimate")) return json({ data: null });
    return json({ data: [] });
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-warn"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<RunDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("Warnings")).toBeTruthy();
    expect(view.getByText("(1)")).toBeTruthy();
  });

  // Verify warning details are present in the collapsible banner
  expect(view.getAllByText("Argument is deprecated").length).toBeGreaterThan(0);
  expect(view.getAllByText(/Use new_param instead of old_param/).length).toBeGreaterThan(0);
  expect(view.getByText("Input state serial")).toBeTruthy();
  expect(view.getByText("#1346")).toBeTruthy();
});

test("when apply is running, apply disabled reasons are NOT shown", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/runs/run-applying") {
      return json({
        data: {
          id: "run-applying",
          type: "runs",
          attributes: {
            message: "Applying run",
            status: "applying",
            actions: {
              "is-confirmable": false,
              "is-discardable": false,
              "is-cancelable": true,
              "is-force-cancelable": true,
            },
            permissions: {
              "can-apply": true,
              "can-discard": true,
              "can-cancel": true,
            },
            "created-at": "2026-07-29T10:00:00.000Z",
            "status-timestamps": {
              "planned-at": "2026-07-29T09:00:00.000Z",
              "applying-at": "2026-07-29T09:01:00.000Z",
            },
          },
        },
      });
    }
    if (url === "/api/v2/runs/run-applying/plan") {
      return json({
        data: {
          attributes: {
            status: "finished",
            "resource-additions": 1,
            "resource-changes": 0,
            "resource-destructions": 0,
            "resource-imports": 0,
          },
        },
      });
    }
    if (url === "/api/v2/applies/apply-run-applying") {
      return json({
        data: {
          attributes: {
            status: "running",
          },
        },
      });
    }
    {
      const phaseLog = handlePhaseLogs(url, "run-applying", {
        apply: "aws_instance.web: Creating...\n",
      });
      if (phaseLog !== null) return phaseLog;
    }
    if (url === "/api/v2/plans/plan-run-applying/json-output") {
      return json({
        resource_changes: [
          {
            address: "aws_instance.web",
            type: "aws_instance",
            change: { actions: ["create"], before: null, after: { id: "i-web" } },
          },
        ],
      });
    }
    if (url.endsWith("/cost-estimate")) return json({ data: null });
    return json({ data: [] });
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-applying"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<RunDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("Applying run")).toBeTruthy();
  });

  // A run that is already applying must not be told its apply is waiting on
  // anything, in any of the wordings this page has used for that.
  expect(view.queryByText(/Why is Apply disabled/i)).toBeNull();
  expect(view.queryByText(/Why am I unable to run this plan/i)).toBeNull();
  expect(view.queryByText(/Plan, policy checks, and pre-apply tasks are still running/i)).toBeNull();
  expect(view.queryByText(/have to finish before anything can be applied/i)).toBeNull();
  // Nor asked to review changes it is in the middle of making.
  expect(view.queryByText(/review the planned changes/i)).toBeNull();
});

test("OperationFilterDropdown toggles operations, select all, clear, and reset", () => {
  const options: readonly Operation[] = ["create", "update", "delete", "replace", "move", "import", "remove", "read"];
  const defaultOps: ReadonlySet<Operation> = new Set(options.filter((op) => op !== "read"));
  let selected = new Set(defaultOps);

  const onChange = mock((next: ReadonlySet<Operation>) => {
    selected = new Set(next);
  });

  const opCounts = {
    create: 2,
    update: 1,
    delete: 0,
    replace: 1,
    move: 1,
    import: 0,
    remove: 0,
    read: 3,
  };

  const view = render(
    <OperationFilterDropdown
      options={options}
      defaultOps={defaultOps}
      selectedOps={selected}
      onChange={onChange}
      opCounts={opCounts}
    />,
  );

  // Read is off by default
  expect(selected.has("read")).toBe(false);
  expect(selected.has("create")).toBe(true);
  expect(view.getByText("Operations")).toBeTruthy();
  expect(view.getByText("7")).toBeTruthy();

  // Open the dropdown
  fireEvent.click(view.getByRole("button", { name: "Filter operations" }));
  const menu = view.getByRole("menu");
  expect(within(menu).getByText("Filter by operation")).toBeTruthy();

  // Toggle "read" to true
  fireEvent.click(within(menu).getByText("Read"));
  expect(onChange).toHaveBeenCalled();
  expect(selected.has("read")).toBe(true);

  // Clear all
  fireEvent.click(within(menu).getByRole("button", { name: "Clear" }));
  expect(selected.size).toBe(0);

  // Select all
  fireEvent.click(within(menu).getByRole("button", { name: "All" }));
  expect(selected.size).toBe(options.length);

  // Reset to default
  fireEvent.click(within(menu).getByRole("button", { name: "Reset" }));
  expect(selected.has("read")).toBe(false);
  expect(selected.size).toBe(7);
});
