import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { WorkspaceRunTasks } from "../src/components/WorkspaceRunTasks";
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

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("respects permissions and fully manages workspace run task bindings", async () => {
  let costTaskAttached = false;
  let scannerTaskAttached = true;
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme/run-tasks") {
      return json({
        data: [
          {
            id: "task-scanner",
            attributes: {
              name: "Security scanner",
              description: "Checks the planned resources.",
              enabled: true,
            },
          },
          {
            id: "task-cost",
            attributes: { name: "Cost guard", enabled: true },
          },
        ],
      });
    }
    if (url === "/api/v2/workspaces/ws-1/run-tasks" && init?.method === "POST") {
      costTaskAttached = true;
      return json({ data: { id: "binding-cost", type: "workspace-run-tasks" } }, 201);
    }
    if (url === "/api/v2/workspaces/ws-1/run-tasks") {
      const data = [];
      if (scannerTaskAttached) {
        data.push({
          id: "binding-scanner",
          attributes: {
            stage: "post_plan",
            "enforcement-level": "advisory",
            "run-task-name": "Security scanner",
            "run-task-description": "Checks the planned resources.",
            "run-task-enabled": true,
          },
          relationships: {
            "run-task": { data: { id: "task-scanner", type: "run-tasks" } },
          },
        });
      }
      if (costTaskAttached) {
        data.push({
          id: "binding-cost",
          attributes: { stage: "pre_apply", "enforcement-level": "mandatory" },
          relationships: {
            "run-task": { data: { id: "task-cost", type: "run-tasks" } },
          },
        });
      }
      return json({ data });
    }
    if (url === "/api/v2/workspaces/ws-1/run-tasks/task-scanner" && init?.method === "DELETE") {
      scannerTaskAttached = false;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(
    <WorkspaceRunTasks orgName="acme" workspaceId="ws-1" canManage={false} />,
  );

  await waitFor((): void => { expect(view.getByText("Security scanner")).toBeTruthy(); });
  expect(view.getByText(/only workspace administrators/i)).toBeTruthy();
  expect(view.queryByRole("button", { name: "Attach run task" })).toBeNull();
  expect(fetchMock.mock.calls.some(([input]): boolean =>
    urlOf(input) === "/api/v2/organizations/acme/run-tasks")).toBe(false);

  view.rerender(<WorkspaceRunTasks orgName="acme" workspaceId="ws-1" canManage />);
  await waitFor((): void => { expect(view.getByText("Security scanner")).toBeTruthy(); });

  fireEvent.change(view.getByLabelText("Run task"), { target: { value: "task-cost" } });
  fireEvent.change(view.getByLabelText("Stage"), { target: { value: "pre_apply" } });
  fireEvent.change(view.getByLabelText("Enforcement"), { target: { value: "mandatory" } });
  await act(async (): Promise<void> => {
    const form = view.getByRole("button", { name: "Attach run task" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => { expect(view.getByText("Run task attached.")).toBeTruthy(); });
  const attachCall = fetchMock.mock.calls.find(([input, init]): boolean =>
    urlOf(input) === "/api/v2/workspaces/ws-1/run-tasks" && init?.method === "POST");
  expect(attachCall).toBeDefined();
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
  expect(JSON.parse(attachCall?.[1]?.body as string)).toEqual({
    data: {
      type: "workspace-run-tasks",
      attributes: {
        stage: "pre_apply",
        "enforcement-level": "mandatory",
      },
      relationships: {
        "run-task": { data: { id: "task-cost", type: "run-tasks" } },
      },
    },
  });

  fireEvent.click(view.getByRole("button", { name: "Remove Security scanner" }));
  // Removal requires confirmation (issue #588).
  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "Remove run task?" })).toBeTruthy();
  });
  fireEvent.click(view.getByRole("button", { name: "Remove run task" }));
  await waitFor((): void => { expect(view.getByText("Run task removed.")).toBeTruthy(); });
  expect(fetchMock.mock.calls.some(([input, init]): boolean =>
    urlOf(input) === "/api/v2/workspaces/ws-1/run-tasks/task-scanner"
    && init?.method === "DELETE")).toBe(true);
  expect(view.queryByRole("button", { name: "Remove Security scanner" })).toBeNull();
});