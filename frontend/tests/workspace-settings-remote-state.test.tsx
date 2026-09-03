import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { WorkspaceSettings } from "../src/components/WorkspaceSettings";
import { WorkspaceDetail } from "../src/views/WorkspaceDetail";
import { isString } from "../src/lib/type-guards";
import type { JsonObject, JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

const json = (data: JsonValue, status = 200): Response =>
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
        data: { attributes: JsonObject };
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
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

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
    data: { attributes: JsonObject };
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
        data: { attributes: JsonObject };
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
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

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
  expect((view.getByLabelText("Description") as HTMLInputElement).value)
    .toBe("Saved before consumers");

  await act(async (): Promise<void> => {
    relationshipPatch.resolve(json({
      errors: [{ title: "Service unavailable", detail: "consumer update failed" }],
    }, 503));
  });
  await view.findByText(
    "Workspace settings were saved, but approved workspaces could not be updated: consumer update failed",
  );
  expect(view.queryByText("Settings saved.")).toBeNull();
  expect(view.getByRole("button", { name: "Save settings" })).toBeTruthy();
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
        data: { attributes: JsonObject };
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
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

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
  // Save is dirty-gated, so edit something first: the point of this test is
  // that a failed approved-workspaces load does not block saving the rest.
  fireEvent.input(view.getByLabelText("Description"), {
    target: { value: "Edited while consumers were loading" },
  });
  expect((view.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled)
    .toBe(false);

  await act(async (): Promise<void> => {
    workspaceList.resolve(json({
      errors: [{ title: "Service unavailable", detail: "temporarily unavailable" }],
    }, 503));
  });
  await view.findByText("Could not load approved workspaces: temporarily unavailable");
  expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect((view.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled)
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

test("configures a workspace-specific agent pool override", async () => {
  let workspaceBody: string | undefined;
  const workspace = {
    id: "ws-production",
    attributes: {
      name: "production",
      "execution-mode": "remote",
      "setting-overwrites": { "execution-mode": false, "agent-pool": false },
      "global-remote-state": false,
      "project-remote-state": false,
      permissions: { "can-update": true },
    },
    relationships: { project: { data: { id: "prj-1", type: "projects" } } },
  };
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = getUrl(input);
    if (url === "/api/v2/projects/prj-1" && init?.method === undefined) {
      return json({ data: { attributes: { "default-execution-mode": "agent" } } });
    }
    if (url === "/api/v2/organizations/acme/agent-pools" && init?.method === undefined) {
      return json({ data: [{ id: "apool-workspace", attributes: { name: "Workspace pool" } }] });
    }
    if (url.startsWith("/api/v2/organizations/acme/workspaces?") && init?.method === undefined) {
      return json({ data: [] });
    }
    if (
      url === "/api/v2/workspaces/ws-production/relationships/remote-state-consumers"
      && init?.method === undefined
    ) {
      return json({ data: [] });
    }
    if (url === "/api/v2/workspaces/ws-production" && init?.method === "PATCH") {
      // SAFETY: this component sends the PATCH body through JSON.stringify.
      workspaceBody = init.body as string;
      // SAFETY: the request body is JSON.stringify'd by the component and has the JSON:API shape asserted below.
      const payload = JSON.parse(workspaceBody) as { data: { attributes: JsonObject } };
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
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(
    <WorkspaceSettings
      orgName="acme"
      workspace={workspace}
      onSaved={(): void => { /* asserted through the request body */ }}
    />,
  );

  await view.findByRole("option", { name: "Workspace pool" });
  // SAFETY: these labels resolve the native selects rendered by the Select component.
  const executionModeSelect = view.getByLabelText("Execution mode") as HTMLSelectElement;
  // SAFETY: this label resolves the native select rendered by the Select component.
  const agentPoolSelect = view.getByLabelText("Agent pool") as HTMLSelectElement;
  expect(executionModeSelect.value).toBe("inherit");
  expect(agentPoolSelect.value).toBe("");
  fireEvent.change(view.getByLabelText("Execution mode"), { target: { value: "agent" } });
  fireEvent.change(view.getByLabelText("Agent pool"), {
    target: { value: "apool-workspace" },
  });
  const form = view.getByRole("button", { name: "Save settings" }).closest("form");
  expect(form).not.toBeNull();
  // SAFETY: the form is present because the preceding role query found its submit button.
  fireEvent.submit(form as HTMLFormElement);

  await waitFor((): void => { expect(workspaceBody).toBeDefined(); });
  if (workspaceBody === undefined) throw new Error("Expected a serialized workspace PATCH body");
  // SAFETY: the request body is JSON.stringify'd by the component and has the JSON:API shape asserted below.
  const payload = JSON.parse(workspaceBody) as {
    data?: { attributes?: JsonObject };
  };
  expect(payload.data?.attributes?.["execution-mode"]).toBe("agent");
  expect(payload.data?.attributes?.["agent-pool-id"]).toBe("apool-workspace");
  expect(payload.data?.attributes?.["setting-overwrites"]).toEqual({
    "execution-mode": true,
    "agent-pool": true,
  });
});