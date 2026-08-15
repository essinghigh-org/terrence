import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RunList } from "../src/views/RunList";
import { WorkspaceDetail } from "../src/views/WorkspaceDetail";
import { isString } from "../src/lib/type-guards";

// Kanban 25.1: custom-styled buttons must keep a visible keyboard focus
// indicator. Base UI controls and ui/button already carry ring styles; these
// tests pin the custom ones that were missing them.

const originalFetch = globalThis.fetch;

function json(data: unknown, status = 200): Response {
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

test("run list sort headers carry a visible focus style", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/workspaces/ws-1/runs" || url === "/api/v2/workspaces/ws-1/runs?sort=-created-at") {
      return json({
        data: [
          {
            id: "run-table",
            type: "runs",
            attributes: {
              message: "Table run",
              status: "applied",
              "created-at": "2026-07-29T10:00:00.000Z",
            },
          },
        ],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs"
          element={<RunList workspaceId="ws-1" orgName="acme" workspaceName="production" canStartRun />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("button", { name: /Sort runs by status/ })).toBeTruthy();
  });
  const statusButton = view.getByRole("button", { name: /Sort runs by status/ });
  const createdButton = view.getByRole("button", { name: /Sort runs by created date/ });
  expect(statusButton.className).toContain("focus-visible:ring-2");
  expect(createdButton.className).toContain("focus-visible:ring-2");
  expect(statusButton.className).toContain("focus-visible:outline-none");
});

function buildRunDetailMock(): ReturnType<typeof mock> {
  return mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: {
            name: "production",
            description: "Production infrastructure",
            permissions: { "can-queue-run": true },
          },
        },
      });
    }
    if (url === "/api/v2/runs/run-focus") {
      return json({
        data: {
          id: "run-focus",
          attributes: {
            message: "Focus styles",
            status: "planned",
            actions: {
              "is-confirmable": true,
              "is-discardable": false,
              "is-cancelable": false,
              "is-force-cancelable": false,
            },
            permissions: {
              "can-apply": true,
              "can-discard": true,
              "can-cancel": true,
              "can-force-cancel": true,
              "can-comment": true,
            },
            "created-at": "2026-07-29T10:00:00.000Z",
            "status-timestamps": {
              "planning-at": "2026-07-29T09:00:01.000Z",
              "planned-at": "2026-07-29T09:00:02.000Z",
            },
          },
        },
      });
    }
    if (url === "/api/v2/runs/run-focus/logs") {
      return json({
        data: [
          { attributes: { phase: "plan", "output-text": "PLAN_FOCUS_LINE" } },
        ],
      });
    }
    if (url === "/api/v2/runs/run-focus/plan") {
      return json({
        data: {
          attributes: {
            status: "finished",
            "log-read-url": "http://terrence.test/api/v2/runs/run-focus/plan/log/token",
            "resource-additions": 1,
            "resource-changes": 0,
            "resource-destructions": 0,
            "resource-imports": 0,
          },
        },
      });
    }
    if (url === "/api/v2/applies/apply-run-focus") {
      return json({ data: { attributes: { status: "pending" } } });
    }
    if (url === "/api/v2/plans/plan-run-focus/json-output") {
      return new Response(JSON.stringify({ errors: [{ status: "500", title: "Plan boom" }] }), {
        status: 500,
        headers: { "Content-Type": "application/vnd.api+json" },
      });
    }
    if (url.endsWith("/cost-estimate")) return json({ data: null });
    if (url === "/api/v2/runs/run-focus/run-events") return json({ data: [] });
    if (url === "/api/v2/runs/run-focus/comments") return json({ data: [] });
    if (url.endsWith("/policy-checks")) return json({ data: [] });
    if (url.endsWith("/check-results")) return json({ data: [] });
    if (url.endsWith("/assessments")) return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
}

function renderRunDetail(): ReturnType<typeof render> {
  globalThis.fetch = buildRunDetailMock();
  return render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-focus"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<WorkspaceDetail section="run-detail" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

test("run detail wrap toggle and plan error retry carry visible focus styles", async () => {
  const view = renderRunDetail();

  await waitFor((): void => {
    expect(view.getByText("Could not load plan output")).toBeTruthy();
  });

// SAFETY: the component renders this element type for the queried role/label.
  const wrapToggle = view.getByRole("button", { name: /Wrap/ }) as HTMLButtonElement;
  expect(wrapToggle.className).toContain("focus-visible:ring-2");

// SAFETY: the component renders this element type for the queried role/label.
  const retry = view.getByRole("button", { name: "Try again" }) as HTMLButtonElement;
  expect(retry.className).toContain("focus-visible:ring-2");
  expect(retry.className).toContain("focus-visible:outline-none");

  // Toggling still works after the class change (aria-pressed reflects state).
  fireEvent.click(wrapToggle);
  expect(wrapToggle.getAttribute("aria-pressed")).toBe("false");
});