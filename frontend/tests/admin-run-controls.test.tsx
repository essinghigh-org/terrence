import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";

import { AdminDashboard } from "../src/views/AdminDashboard";

const originalFetch = globalThis.fetch;
const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });
const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("renders and invokes only the advertised admin run actions", async () => {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/admin/users") return json({ data: [] });
    if (url === "/api/v2/admin/runs") {
      return json({
        data: [
          {
            id: "run-cancel",
            attributes: {
              status: "planning",
              message: "Cancel only",
              actions: { "is-cancelable": true, "is-force-cancelable": false },
            },
          },
          {
            id: "run-force",
            attributes: {
              status: "applying",
              message: "Force only",
              actions: { "is-cancelable": false, "is-force-cancelable": true },
            },
          },
        ],
      });
    }
    if (
      url === "/api/v2/admin/runs/run-cancel/actions/cancel"
      || url === "/api/v2/admin/runs/run-force/actions/force-cancel"
    ) return json({ data: {} });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route element={<Outlet context={{ accountLoaded: true, siteAdmin: true }} />}>
          <Route path="/admin" element={<AdminDashboard />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Registered Users")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "System Runs" }));

  const cancelRow = await waitFor((): HTMLElement => view.getByText("Cancel only").closest("tr") as HTMLElement);
  const forceRow = view.getByText("Force only").closest("tr") as HTMLElement;
  expect(within(cancelRow).getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(within(cancelRow).queryByRole("button", { name: "Force Cancel" })).toBeNull();
  expect(within(forceRow).queryByRole("button", { name: "Cancel" })).toBeNull();
  expect(within(forceRow).getByRole("button", { name: "Force Cancel" })).toBeTruthy();

  await act(async (): Promise<void> => {
    fireEvent.click(within(cancelRow).getByRole("button", { name: "Cancel" }));
  });
  await act(async (): Promise<void> => {
    fireEvent.click(within(forceRow).getByRole("button", { name: "Force Cancel" }));
  });

  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/admin/runs/run-cancel/actions/cancel" && init?.method === "POST")).toBeTrue();
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/admin/runs/run-force/actions/force-cancel" && init?.method === "POST")).toBeTrue();
  });
});
