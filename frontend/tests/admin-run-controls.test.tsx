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
    <MemoryRouter initialEntries={["/admin/runs"]}>
      <Routes>
        <Route element={<Outlet context={{ accountLoaded: true, siteAdmin: true }} />}>
          <Route path="/admin" element={<AdminDashboard section="security" />} />
          <Route path="/admin/runs" element={<AdminDashboard section="runs" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

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

test("destructive confirmations name the exact user and version (kanban 25.5)", async () => {
  const deleted: string[] = [];
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/admin/users") {
      return json({
        data: [
          { id: "user-henry", attributes: { username: "henry.essing", email: "henry@essinghigh.dev" } },
          { id: "user-ops", attributes: { username: "ops-bot", email: "bot@essinghigh.dev" } },
        ],
      });
    }
    if (url === "/api/v2/admin/terraform-versions") {
      return json({
        data: [
          { id: "tv-1110", attributes: { version: "1.11.0", url: "https://example.test/1.11.0" } },
        ],
      });
    }
    if (url === "/api/v2/admin/users/user-henry" && init?.method === "DELETE") {
      deleted.push("user");
      return json({ data: {} });
    }
    if (url === "/api/v2/admin/terraform-versions/tv-1110" && init?.method === "DELETE") {
      deleted.push("version");
      return json({ data: {} });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/admin/users"]}>
      <Routes>
        <Route element={<Outlet context={{ accountLoaded: true, siteAdmin: true }} />}>
          <Route path="/admin/users" element={<AdminDashboard section="users" />} />
          <Route path="/admin/versions" element={<AdminDashboard section="versions" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("henry.essing")).toBeTruthy();
  });
  const henryRow = view.getByText("henry.essing").closest("tr") as HTMLElement;
  fireEvent.click(within(henryRow).getByRole("button", { name: "Delete user" }));

  const userDialog = view.getByRole("dialog");
  expect(within(userDialog).getByText(/Permanently delete user "henry\.essing"\?/)).toBeTruthy();
  expect(within(userDialog).getByText(/cannot be undone/)).toBeTruthy();
  fireEvent.click(within(userDialog).getByRole("button", { name: "Delete User" }));
  await waitFor((): void => {
    expect(deleted).toContain("user");
  });

  // Same flow for registered Terraform versions (separate section route).
  const versionsView = render(
    <MemoryRouter initialEntries={["/admin/versions"]}>
      <Routes>
        <Route element={<Outlet context={{ accountLoaded: true, siteAdmin: true }} />}>
          <Route path="/admin/versions" element={<AdminDashboard section="versions" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  await waitFor((): void => {
    expect(versionsView.getByText("1.11.0")).toBeTruthy();
  });
  const versionRow = versionsView.getByText("1.11.0").closest("tr") as HTMLElement;
  fireEvent.click(within(versionRow).getByRole("button", { name: "Delete version" }));

  const versionDialog = versionsView.getByRole("dialog", { name: "Delete Terraform Version" });
  expect(within(versionDialog).getByText(/Permanently delete version "1\.11\.0"/)).toBeTruthy();
  expect(within(versionDialog).getByText(/cannot be undone/)).toBeTruthy();
  fireEvent.click(within(versionDialog).getByRole("button", { name: "Delete Version" }));
  await waitFor((): void => {
    expect(deleted).toContain("version");
  });
});
