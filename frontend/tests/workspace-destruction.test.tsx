import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { WorkspaceDestruction } from "../src/components/WorkspaceDestruction";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

const json = (data: JsonValue, status = 200): Response => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/vnd.api+json" },
});

const requestUrl = (input: string | URL | Request): string => (
  isString(input) ? input : input instanceof URL ? input.toString() : input.url
);

const changeInput = (element: HTMLElement, value: string): void => {
// SAFETY: React attaches the _valueTracker to controlled inputs in the test renderer.
  // SAFETY: React attaches the _valueTracker to controlled inputs in the test renderer.
  const tracker = (element as { _valueTracker?: { setValue: (nextValue: string) => void } })._valueTracker;
  tracker?.setValue(value === "" ? "x" : "");
  Reflect.set(element, "value", value);
  fireEvent.input(element, { target: { value } });
  fireEvent.change(element, { target: { value } });
};

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("fails closed and deletes only after exact confirmation and a successful response", async () => {
  let resolveSuccess: ((response: Response) => void) | undefined;
  let deleteAttempts = 0;
  const fetchMock = mock(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    deleteAttempts += 1;
    if (deleteAttempts === 1) {
      return new Response(JSON.stringify({
        errors: [{ status: "409", detail: "Workspace could not be deleted" }],
      }), {
        status: 409,
        headers: { "Content-Type": "application/vnd.api+json" },
      });
    }
    return await new Promise<Response>((resolve): void => {
      resolveSuccess = resolve;
    });
  });
  const onDeleted = mock((): void => {
    // Callback assertion below.
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter>
      <WorkspaceDestruction
        workspace={{ id: "ws/1", attributes: { name: "production" } }}
        onDeleted={onDeleted}
      />
    </MemoryRouter>,
  );

  const closedButton = view.getByRole("button", { name: "Delete workspace" });
  expect(closedButton.disabled).toBe(true);
  fireEvent.click(closedButton);
  expect(fetchMock).not.toHaveBeenCalled();

  view.rerender(
    <MemoryRouter>
      <WorkspaceDestruction
        workspace={{
          id: "ws/1",
          attributes: { name: "production", permissions: { "can-force-delete": true } },
        }}
        onDeleted={onDeleted}
      />
    </MemoryRouter>,
  );
  fireEvent.click(view.getByRole("button", { name: "Delete workspace" }));

  const confirmation = view.getByLabelText("Workspace name");
  changeInput(confirmation, "Production");
  expect(view.getByRole("button", { name: "Delete workspace permanently" }).disabled)
    .toBe(true);
  changeInput(confirmation, "production");
  expect(view.getByRole("button", { name: "Delete workspace permanently" }).disabled)
    .toBe(false);

  await act(async (): Promise<void> => {
    fireEvent.click(view.getByRole("button", { name: "Delete workspace permanently" }));
  });
  expect((await view.findByRole("alert")).textContent).toBe("Workspace could not be deleted");
  expect(onDeleted).not.toHaveBeenCalled();

  fireEvent.click(view.getByRole("button", { name: "Delete workspace permanently" }));
  await waitFor((): void => {
    expect(view.getByRole("button", { name: "Deleting" })).toBeTruthy();
  });
  expect(onDeleted).not.toHaveBeenCalled();

  await act(async (): Promise<void> => {
    resolveSuccess?.(new Response(null, { status: 204 }));
  });
  await waitFor((): void => {
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });
  expect(view.queryByRole("dialog")).toBeNull();
  expect(fetchMock.mock.calls.map(([input, init]): [string, string | undefined] => [
    isString(input) ? input : input instanceof URL ? input.toString() : input.url,
    init?.method,
  ])).toEqual([
    ["/api/v2/workspaces/ws%2F1", "DELETE"],
    ["/api/v2/workspaces/ws%2F1", "DELETE"],
  ]);
});

test("updates destroy-plan permission and navigates to the queued destroy run", async () => {
  let patchBody: unknown;
  let runBody: unknown;
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/workspaces/ws%2F1" && init?.method === "PATCH") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      patchBody = isString(init.body) ? JSON.parse(init.body) as unknown : undefined;
      return json({ data: { id: "ws/1", type: "workspaces" } });
    }
    if (url === "/api/v2/runs" && init?.method === "POST") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      runBody = isString(init.body) ? JSON.parse(init.body) as unknown : undefined;
      return json({ data: { id: "run/destroy", type: "runs" } }, 201);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;
  const onDeleted = mock((): void => {
    // Delete behavior is covered separately.
  });

  const renderComponent = (canUpdate: boolean): React.JSX.Element => (
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/settings/delete"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/settings/delete"
          element={(
            <WorkspaceDestruction
              workspace={{
                id: "ws/1",
                attributes: {
                  name: "production",
                  "allow-destroy-plan": false,
                  permissions: {
                    "can-force-delete": true,
                    "can-queue-destroy": true,
                    "can-update": canUpdate,
                  },
                },
              }}
              onDeleted={onDeleted}
            />
          )}
        />
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<p>Created destroy run</p>}
        />
      </Routes>
    </MemoryRouter>
  );

  const view = render(renderComponent(false));
  const setting = view.getByRole("checkbox", { name: "Allow destroy plans" });
  const queueButton = view.getByRole("button", { name: "Queue destroy plan" });
  expect(setting.disabled).toBe(true);
  expect(queueButton.disabled).toBe(true);
  expect(view.getByRole("button", { name: "Delete workspace" })).toBeTruthy();
  expect(view.getByText("You do not have permission to change this setting.")).toBeTruthy();

  view.rerender(renderComponent(true));
  fireEvent.click(view.getByRole("checkbox", { name: "Allow destroy plans" }));
  await waitFor((): void => {
    expect(view.getByRole("checkbox", { name: "Allow destroy plans" }).getAttribute("aria-checked")).toBe("true");
  });
  expect(view.getByRole("button", { name: "Queue destroy plan" }).disabled).toBe(false);
  expect(patchBody).toMatchObject({
    data: {
      id: "ws/1",
      type: "workspaces",
      attributes: { "allow-destroy-plan": true },
    },
  });

  fireEvent.click(view.getByRole("button", { name: "Queue destroy plan" }));
  await waitFor((): void => {
    expect(view.getByText("Created destroy run")).toBeTruthy();
  });
  expect(runBody).toMatchObject({
    data: {
      type: "runs",
      attributes: {
        "auto-apply": false,
        "is-destroy": true,
        message: "Destroy plan queued manually",
      },
      relationships: {
        workspace: { data: { type: "workspaces", id: "ws/1" } },
      },
    },
  });
  expect(onDeleted).not.toHaveBeenCalled();
});