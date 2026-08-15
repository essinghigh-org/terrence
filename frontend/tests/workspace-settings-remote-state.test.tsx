import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { WorkspaceSettings } from "../src/components/WorkspaceSettings";
import { WorkspaceDetail } from "../src/views/WorkspaceDetail";
import { isString } from "../src/lib/type-guards";

const originalFetch = globalThis.fetch;

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });

const getUrl = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.toString() : input.url;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete): void => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach((): void => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
});

test("loads every workspace page and replaces specific remote-state consumers", async () => {
  const workspace = {
    id: "ws-production",
    attributes: {
      name: "production",
      "global-remote-state": false,
      "project-remote-state": false,
      permissions: { "can-update": true },
    },
  };
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = getUrl(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({ data: workspace });
    }
    if (
      url.startsWith("/api/v2/organizations/acme/workspaces?")
      && init?.method === undefined
    ) {
      const page = new URL(url, "http://terrence.local").searchParams.get("page[number]");
      if (page === "2") {
        return json({
          data: [{
            id: "ws-staging",
            type: "workspaces",
            attributes: { name: "staging" },
          }],
          meta: { pagination: { "next-page": null } },
        });
      }
      return json({
        data: [
          {
            id: "ws-production",
            type: "workspaces",
            attributes: { name: "production" },
          },
          {
            id: "ws-application",
            type: "workspaces",
            attributes: { name: "application" },
          },
        ],
        meta: { pagination: { "next-page": 2 } },
      });
    }
    if (
      url === "/api/v2/workspaces/ws-production/relationships/remote-state-consumers"
      && init?.method === undefined
    ) {
      return json({ data: [{ id: "ws-staging", type: "workspaces" }] });
    }
    if (url === "/api/v2/workspaces/ws-production" && init?.method === "PATCH") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      const payload = JSON.parse(init.body as string) as {
        data: { attributes: Record<string, unknown> };
      };
      return json({
        data: {
          ...workspace,
          attributes: { ...workspace.attributes, ...payload.data.attributes },
        },
      });
    }
    if (
      url === "/api/v2/workspaces/ws-production/relationships/remote-state-consumers"
      && init?.method === "PATCH"
    ) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/settings/general"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/settings/general"
          element={<WorkspaceDetail section="settings" />}
        />
      </Routes>
    </MemoryRouter>,
  );

  const staging = await view.findByRole("checkbox", { name: "staging" });
  const application = view.getByRole("checkbox", { name: "application" });
  expect(staging.getAttribute("aria-checked")).toBe("true");
  expect(application.getAttribute("aria-checked")).toBe("false");
  expect(view.queryByRole("checkbox", { name: "production" })).toBeNull();

  fireEvent.change(view.getByLabelText("Remote state sharing"), {
    target: { value: "global" },
  });
  expect(view.queryByRole("checkbox", { name: "application" })).toBeNull();
  fireEvent.change(view.getByLabelText("Remote state sharing"), {
    target: { value: "specific" },
  });

  fireEvent.click(view.getByRole("checkbox", { name: "staging" }));
  fireEvent.click(view.getByRole("checkbox", { name: "application" }));
  await act(async (): Promise<void> => {
    const form = view.getByRole("button", { name: "Save settings" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => { expect(view.getByText("Settings saved.")).toBeTruthy(); });
  expect(fetchMock.mock.calls.some(([input]): boolean => {
    const url = getUrl(input);
    return url.startsWith("/api/v2/organizations/acme/workspaces?")
      && new URL(url, "http://terrence.local").searchParams.get("page[number]") === "2";
  })).toBe(true);

  const workspacePatch = fetchMock.mock.calls.find(([input, init]): boolean =>
    getUrl(input) === "/api/v2/workspaces/ws-production" && init?.method === "PATCH");
  if (workspacePatch === undefined) throw new Error("Expected workspace settings PATCH");
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
  const workspacePayload = JSON.parse(workspacePatch[1]?.body as string) as {
    data: { attributes: Record<string, unknown> };
  };
  expect(workspacePayload.data.attributes["global-remote-state"]).toBe(false);
  expect(workspacePayload.data.attributes["project-remote-state"]).toBe(false);

  const relationshipPatch = fetchMock.mock.calls.find(([input, init]): boolean =>
    getUrl(input) === "/api/v2/workspaces/ws-production/relationships/remote-state-consumers"
    && init?.method === "PATCH");
  if (relationshipPatch === undefined) throw new Error("Expected remote-state relationship PATCH");
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
  expect(JSON.parse(relationshipPatch[1]?.body as string)).toEqual({
    data: [{ id: "ws-application", type: "workspaces" }],
  });
});

test("reconciles general settings before reporting a remote-state replacement failure", async () => {
  const relationshipPatch = deferred<Response>();
  const onSaved = mock((): void => {
    // Asserted below.
  });
  const workspace = {
    id: "ws-production",
    attributes: {
      name: "production",
      description: "",
      "global-remote-state": false,
      "project-remote-state": false,
      permissions: { "can-update": true },
    },
  };
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = getUrl(input);
    if (
      url.startsWith("/api/v2/organizations/acme/workspaces?")
      && init?.method === undefined
    ) {
      return json({ data: [workspace] });
    }
    if (
      url === "/api/v2/workspaces/ws-production/relationships/remote-state-consumers"
      && init?.method === undefined
    ) {
      return json({ data: [] });
    }
    if (url === "/api/v2/workspaces/ws-production" && init?.method === "PATCH") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      const payload = JSON.parse(init.body as string) as {
        data: { attributes: Record<string, unknown> };
      };
      return json({
        data: {
          ...workspace,
          attributes: { ...workspace.attributes, ...payload.data.attributes },
        },
      });
    }
    if (
      url === "/api/v2/workspaces/ws-production/relationships/remote-state-consumers"
      && init?.method === "PATCH"
    ) {
      return relationshipPatch.promise;
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <WorkspaceSettings orgName="acme" workspace={workspace} onSaved={onSaved} />,
  );
  await view.findByText("There are no other workspaces in this organization.");
  fireEvent.input(view.getByLabelText("Description"), {
    target: { value: "Saved before consumers" },
  });
  const form = view.getByRole("button", { name: "Save settings" }).closest("form");
  if (form !== null) fireEvent.submit(form);

  await waitFor((): void => {
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(view.getByText("Settings saved.")).toBeTruthy();
  });
  expect(view.getByLabelText("Description").value)
    .toBe("Saved before consumers");

  await act(async (): Promise<void> => {
    relationshipPatch.resolve(json({
      errors: [{ title: "Service unavailable", detail: "consumer update failed" }],
    }, 503));
  });
  await view.findByText(
    "Workspace settings were saved, but approved workspaces could not be updated: consumer update failed",
  );
  expect(onSaved).toHaveBeenCalledTimes(1);
});

test("keeps general settings usable when remote-state consumers fail to load", async () => {
  const workspaceList = deferred<Response>();
  const workspace = {
    id: "ws-production",
    attributes: {
      name: "production",
      "global-remote-state": false,
      "project-remote-state": false,
      permissions: { "can-update": true },
    },
  };
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = getUrl(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({ data: workspace });
    }
    if (
      url.startsWith("/api/v2/organizations/acme/workspaces?")
      && init?.method === undefined
    ) {
      return workspaceList.promise;
    }
    if (
      url === "/api/v2/workspaces/ws-production/relationships/remote-state-consumers"
      && init?.method === undefined
    ) {
      return json({ data: [{ id: "ws-existing", type: "workspaces" }] });
    }
    if (url === "/api/v2/workspaces/ws-production" && init?.method === "PATCH") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      const payload = JSON.parse(init.body as string) as {
        data: { attributes: Record<string, unknown> };
      };
      return json({
        data: {
          ...workspace,
          attributes: { ...workspace.attributes, ...payload.data.attributes },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/settings/general"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/settings/general"
          element={<WorkspaceDetail section="settings" />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await view.findByText("Loading approved workspaces…");
  expect(view.getByRole("button", { name: "Save settings" }).disabled)
    .toBe(false);

  await act(async (): Promise<void> => {
    workspaceList.resolve(json({
      errors: [{ title: "Service unavailable", detail: "temporarily unavailable" }],
    }, 503));
  });
  await view.findByText("Could not load approved workspaces: temporarily unavailable");
  expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Save settings" }).disabled)
    .toBe(false);

  await act(async (): Promise<void> => {
    const form = view.getByRole("button", { name: "Save settings" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });
  await waitFor((): void => { expect(view.getByText("Settings saved.")).toBeTruthy(); });
  expect(fetchMock.mock.calls.some(([input, init]): boolean =>
    getUrl(input) === "/api/v2/workspaces/ws-production/relationships/remote-state-consumers"
    && init?.method === "PATCH")).toBe(false);
});