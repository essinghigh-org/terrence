import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { WorkspaceDetail } from "../src/views/WorkspaceDetail";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

// Kanban 25.2: the fullscreen plan/apply log dialog must move focus into the
// dialog when it opens and hand focus back to the trigger button on close
// (both via the Close button and via Escape).

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

function buildFetchMock(): ReturnType<typeof mock> {
  return mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
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
            message: "Focus restoration",
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
          { attributes: { phase: "plan", "output-text": "PLAN_FULLSCREEN_LINE" } },
        ],
      });
    }
    if (url === "/api/v2/runs/run-focus/plan") {
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
    if (url === "/api/v2/applies/apply-run-focus") {
      return json({
        data: { attributes: { status: "pending" } },
      });
    }
    if (url === "/api/v2/plans/plan-run-focus/json-output") {
      return json({
        terraform_version: "1.11.0",
        resource_changes: [],
        configuration: { root_module: { resources: [] } },
      });
    }
    if (url.endsWith("/cost-estimate")) return json({ data: null });
    if (url === "/api/v2/runs/run-focus/run-events") return json({ data: [] });
    if (url === "/api/v2/runs/run-focus/comments") return json({ data: [] });
    if (url.endsWith("/policy-checks")) return json({ data: [] });
    if (url.endsWith("/assessments")) return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
}

function renderRunDetail(fetchMock: ReturnType<typeof mock>): ReturnType<typeof render> {
  globalThis.fetch = fetchMock;
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

test("fullscreen log dialog returns focus to its trigger button on close", async () => {
  const view = renderRunDetail(buildFetchMock());

  await waitFor((): void => {
    expect(view.getByText("PLAN_FULLSCREEN_LINE")).toBeTruthy();
  });

// SAFETY: the component renders this element type for the queried role/label.
  const trigger = view.getByRole("button", { name: "Open raw plan log fullscreen" }) as HTMLButtonElement;
  trigger.focus();
  fireEvent.click(trigger);

  await waitFor((): void => {
    expect(view.getByRole("dialog", { name: "Raw plan log" })).toBeTruthy();
  });
// SAFETY: the component renders this element type for the queried role/label.
  const closeButton = view.getByRole("button", { name: "Close fullscreen log" }) as HTMLButtonElement;

  // Focus moved into the dialog, away from the trigger.
  expect(document.activeElement).toBe(closeButton);

  fireEvent.click(closeButton);

  await waitFor((): void => {
    expect(view.queryByRole("dialog", { name: "Raw plan log" })).toBeNull();
  });
  // Focus returned to the control that opened the dialog.
  expect(document.activeElement).toBe(trigger);
});

test("fullscreen log dialog restores focus when closed with Escape", async () => {
  const view = renderRunDetail(buildFetchMock());

  await waitFor((): void => {
    expect(view.getByText("PLAN_FULLSCREEN_LINE")).toBeTruthy();
  });

// SAFETY: the component renders this element type for the queried role/label.
  const trigger = view.getByRole("button", { name: "Open raw plan log fullscreen" }) as HTMLButtonElement;
  trigger.focus();
  fireEvent.click(trigger);

  await waitFor((): void => {
    expect(view.getByRole("button", { name: "Close fullscreen log" })).toBeTruthy();
  });

  fireEvent.keyDown(window, { key: "Escape" });

  await waitFor((): void => {
    expect(view.queryByRole("dialog", { name: "Raw plan log" })).toBeNull();
  });
  expect(document.activeElement).toBe(trigger);
});