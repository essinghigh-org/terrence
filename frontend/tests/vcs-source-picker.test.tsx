import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { setAuthToken } from "../src/lib/api";
import { CreateWorkspaceModal } from "../src/components/CreateWorkspaceModal";
import { WorkspaceVcs } from "../src/components/WorkspaceVcs";
import { isString } from "../src/lib/type-guards";
import type { JsonObject, JsonValue } from "../src/lib/json";

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

function changeInput(element: HTMLElement, value: string): void {
  Reflect.set(element, "value", value);
  fireEvent.input(element, { target: { value } });
  fireEvent.change(element, { target: { value } });
}

afterEach((): void => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
});

test("creates a VCS workspace from choices listed for a manage-workspaces-only session", async () => {
  let createBody: unknown;
  const listAuthorizations: (string | null)[] = [];
  const onCreated = mock((): void => {
    // Asserted below.
  });
  localStorage.removeItem("tfe_token");
  setAuthToken("manage-workspaces-only");
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/organizations/acme/github-app/installations") {
      listAuthorizations.push(new Headers(init?.headers).get("Authorization"));
      return json({
        data: [{ id: "ghain-1", attributes: { name: "Acme GitHub" } }],
      });
    }
    if (url === "/api/v2/organizations/acme/oauth-clients") {
      listAuthorizations.push(new Headers(init?.headers).get("Authorization"));
      return json({ data: [] });
    }
    if (url === "/api/v2/organizations/acme/workspaces" && init?.method === "POST") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      createBody = JSON.parse(init.body as string);
      return json({ data: { id: "ws-1" } }, 201);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(
    <CreateWorkspaceModal
      orgName="acme"
      open
      onOpenChange={(): void => {
        // Dialog state is controlled by the test.
      }}
      onCreated={onCreated}
    />,
  );

  changeInput(view.getByLabelText(/Workspace Name/i), "production");
  fireEvent.change(view.getByLabelText(/Workspace Source/i), { target: { value: "vcs" } });

  await waitFor((): void => {
    expect(view.getByRole("option", { name: "Acme GitHub — GitHub App" })).toBeTruthy();
  });
  expect(view.queryByLabelText(/installation id|oauth token id/i)).toBeNull();

  changeInput(view.getByLabelText("Repository Identifier"), "acme/infrastructure");
  fireEvent.change(view.getByLabelText(/VCS connection/i), {
    target: { value: "github-app:ghain-1" },
  });
  await act(async (): Promise<void> => {
    const form = view.getByRole("button", { name: "Create Workspace" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => {
    expect(onCreated).toHaveBeenCalledTimes(1);
  });
  expect(listAuthorizations).toEqual([
    "Bearer manage-workspaces-only",
    "Bearer manage-workspaces-only",
  ]);
  expect(createBody).toEqual({
    data: {
      attributes: {
        name: "production",
        "auto-apply": false,
        "execution-mode": "remote",
        // Issue #629: no org default here, so the canonical terraform default applies.
        "iac-binary": "terraform",
        "terraform-version": "latest",
        source: "tfe-api",
        "vcs-repo": {
          identifier: "acme/infrastructure",
          "github-app-installation-id": "ghain-1",
        },
      },
      type: "workspaces",
    },
  });
});

test("switches an existing workspace to a registered OAuth connection", async () => {
  let patchBody: unknown;
  const onSaved = mock((): void => {
    // Asserted below.
  });
  const workspace = {
    id: "ws-1",
    attributes: {
      name: "production",
      "vcs-repo": {
        identifier: "acme/infrastructure",
        branch: "main",
        "github-app-installation-id": "ghain-1",
        "ingress-submodules": true,
        "tags-regex": "^v\\d+$",
      },
      permissions: { "can-update": true },
    },
  };
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/organizations/acme/github-app/installations") {
      return json({ data: [{ id: "ghain-1", attributes: { name: "Acme GitHub" } }] });
    }
    if (url === "/api/v2/organizations/acme/oauth-clients") {
      return json({
        data: [{
          id: "oc-1",
          attributes: {
            name: "Legacy GitHub",
            "service-provider-display-name": "GitHub",
          },
        }],
      });
    }
    if (url === "/api/v2/oauth-clients/oc-1/oauth-tokens") {
      return json({
        data: [{
          id: "ot-1",
          attributes: { "service-provider-user": "alice" },
        }],
      });
    }
    if (url === "/api/v2/workspaces/ws-1" && init?.method === "PATCH") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      patchBody = JSON.parse(init.body as string);
      return json({ data: workspace });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/settings/version-control"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/settings/version-control"
          element={<WorkspaceVcs workspace={workspace} onSaved={onSaved} />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("option", { name: "Legacy GitHub — GitHub (alice)" })).toBeTruthy();
  });
  expect((view.getByLabelText("VCS connection") as HTMLSelectElement).value).toBe("github-app:ghain-1");
  expect(view.getByRole("checkbox", { name: "Include submodules when cloning" }).getAttribute("aria-checked")).toBe("true");
  expect((view.getByLabelText("Git tag regular expression") as HTMLInputElement).value).toBe("^v\\d+$");
  expect(view.queryByLabelText(/installation id|oauth token id/i)).toBeNull();

  fireEvent.change(view.getByLabelText("VCS connection"), {
    target: { value: "oauth-token:ot-1" },
  });
  await act(async (): Promise<void> => {
    const form = view.getByRole("button", { name: "Save VCS settings" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => {
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
  const attributes = (patchBody as {
    data: { attributes: JsonObject };
  }).data.attributes;
  expect(attributes["vcs-repo"]).toEqual({
    identifier: "acme/infrastructure",
    branch: "main",
    "github-app-installation-id": null,
    "oauth-token-id": "ot-1",
    "ingress-submodules": true,
    "tags-regex": "^v\\d+$",
  });
});

test("keeps local workspace creation independent from VCS connections", async () => {
  let createBody: unknown;
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/organizations/acme/workspaces" && init?.method === "POST") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      createBody = JSON.parse(init.body as string);
      return json({ data: { id: "ws-local" } }, 201);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(
    <CreateWorkspaceModal
      orgName="acme"
      open
      onOpenChange={(): void => {
        // Dialog state is controlled by the test.
      }}
      onCreated={(): void => {
        // Payload is asserted below.
      }}
    />,
  );
  changeInput(view.getByLabelText(/Workspace Name/i), "local");
  fireEvent.change(view.getByLabelText(/Workspace Source/i), { target: { value: "local" } });
  fireEvent.click(view.getByRole("button", { name: "Create Workspace" }));

  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      requestUrl(input) === "/api/v2/organizations/acme/workspaces" && init?.method === "POST")).toBe(true);
  });
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
  const attributes = (createBody as {
    data: { attributes: JsonObject };
  }).data.attributes;
  expect(attributes["source"]).toBe("local");
  expect(Object.hasOwn(attributes, "vcs-repo")).toBe(false);
});