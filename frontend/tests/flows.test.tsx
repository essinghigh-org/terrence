import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { CreateWorkspaceModal } from "../src/components/CreateWorkspaceModal";
import { Toaster } from "../src/components/ui/toast";
import { Login } from "../src/views/Login";
import { RunDetail } from "../src/views/RunDetail";
import { RunList } from "../src/views/RunList";
import { WorkspaceDetail } from "../src/views/WorkspaceDetail";
import { Workspaces } from "../src/views/Workspaces";
import { VariableSets } from "../src/views/VariableSets";

const originalFetch = globalThis.fetch;
const originalConfirm = globalThis.confirm;
const originalAlert = globalThis.alert;
const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

afterEach((): void => {
  cleanup();
  if (typeof localStorage !== "undefined") localStorage.clear();
  globalThis.fetch = originalFetch;
  globalThis.confirm = originalConfirm;
  globalThis.alert = originalAlert;
});

function getUrlString(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input !== null && typeof input === "object" && "url" in input) {
    const u = input.url;
    if (typeof u === "string") return u;
  }
  return "";
}

const asElement = (el: unknown): HTMLElement => el as HTMLElement;

const changeInput = (element: HTMLElement, value: string): void => {
  const tracker = Reflect.get(element, "_valueTracker") as { setValue: (v: string) => void } | undefined;
  if (tracker !== undefined) {
    tracker.setValue(value === "" ? "x" : "");
  }
  Reflect.set(element, "value", value);

  fireEvent.input(element, { target: { value } });
  fireEvent.change(element, { target: { value } });
};


test("logs in, stores the token, and navigates home", async () => {
  const fetchMock = mock(async (): Promise<Response> =>
    json({ data: { attributes: { token: "user-token" } } }),
  );
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/app" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  );

  changeInput(asElement(view.getByLabelText("Username")), "alice");
  changeInput(asElement(view.getByLabelText("Password")), "correct horse");
  await act(async () => {
    const form = view.getByRole("button", { name: "Sign in" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => { expect(view.getByText("Home")).toBeTruthy(); });
  expect(localStorage.getItem("tfe_token")).toBe("user-token");
  const [loginUrl, loginOptions] = fetchMock.mock.calls[0]!;
  expect(getUrlString(loginUrl)).toBe("/api/v2/users/login");
  expect(JSON.parse((loginOptions as RequestInit).body as string)).toEqual({
    data: { attributes: { username: "alice", password: "correct horse", "browser-session": true } },
  });
  expect(localStorage.getItem("tfe_refreshable_session")).toBe("true");
});

test("creates a workspace from the modal", async () => {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = getUrlString(input);
    if (url === "/api/v2/organizations/acme/github-app/installations") {
      return json({ data: [{ id: "ghain-123", attributes: { name: "Acme GitHub" } }] });
    }
    if (url === "/api/v2/organizations/acme/oauth-clients") return json({ data: [] });
    if (url === "/api/v2/organizations/acme/workspaces" && init?.method === "POST") {
      return json({ data: { id: "ws-1", attributes: { name: "production" } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const onCreated = mock((): void => {
    // Intentional callback mock
  });
  globalThis.fetch = fetchMock as typeof fetch;
  const view = render(
    <CreateWorkspaceModal
      orgName="acme"
      open
      onOpenChange={(): void => {
        // Intentional noop
      }}
      onCreated={onCreated}
    />,
  );

  changeInput(asElement(view.getByLabelText("Workspace Name")), "production");
  changeInput(asElement(view.getByLabelText("Execution Engine")), "terraform");
  changeInput(asElement(view.getByLabelText(/Engine Version/)), "1.9.3");
  // Switch source to VCS so Repository Identifier fields appear
  fireEvent.change(view.getByLabelText("Workspace Source"), { target: { value: "vcs" } });
  await waitFor((): void => { expect(view.getByText("Acme GitHub — GitHub App")).toBeTruthy(); });
  changeInput(asElement(view.getByLabelText("Repository Identifier")), "hashicorp/terraform");
  fireEvent.change(view.getByLabelText("VCS Connection"), { target: { value: "github-app:ghain-123" } });
  fireEvent.click(view.getByLabelText("Auto-apply plans upon completion"));
  await act(async () => {
    const form = view.getByRole("button", { name: "Create Workspace" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => { expect(onCreated).toHaveBeenCalledTimes(1); });
  const workspaceCall = fetchMock.mock.calls.find(([input, init]): boolean =>
    getUrlString(input) === "/api/v2/organizations/acme/workspaces" && init?.method === "POST");
  if (workspaceCall === undefined) throw new Error("Expected workspace create request");
  const [workspaceUrl, workspaceOptions] = workspaceCall;
  expect(getUrlString(workspaceUrl)).toBe("/api/v2/organizations/acme/workspaces");
  expect(JSON.parse(workspaceOptions!.body as string)).toEqual({
    data: {
      attributes: {
        name: "production",
        "auto-apply": true,
        "iac-binary": "terraform",
        "terraform-version": "1.9.3",
        source: "tfe-api",
        "vcs-repo": {
          identifier: "hashicorp/terraform",
          "github-app-installation-id": "ghain-123",
        },
      },
      type: "workspaces",
    },
  });
  expect(view.queryByLabelText("Repository Identifier")).toBeNull();
  expect(view.queryByLabelText("VCS Connection")).toBeNull();
});

test("opens workspace creation from the workspace list", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    if (getUrlString(input) === "/api/v2/organizations/acme") {
      return json({
        data: {
          attributes: {
            permissions: { "can-manage-workspaces": true },
          },
        },
      });
    }
    return json({ data: [] });
  }) as typeof fetch;
  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Routes>
        <Route path="/app/:orgName" element={<Workspaces />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("No workspaces yet")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "New workspace" }));
  expect(view.getByRole("heading", { name: "New Workspace" })).toBeTruthy();
  expect(view.getByLabelText("Execution Engine")).toBeTruthy();
});

test("rejects a partially configured workspace VCS connection", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = getUrlString(input);
    if (url === "/api/v2/organizations/acme/github-app/installations") {
      return json({ data: [{ id: "ghain-123", attributes: { name: "Acme GitHub" } }] });
    }
    if (url === "/api/v2/organizations/acme/oauth-clients") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;
  const view = render(
    <>
      <CreateWorkspaceModal
        orgName="acme"
        open
        onOpenChange={(): void => {
          // Intentional noop
        }}
        onCreated={(): void => {
          // Intentional noop
        }}
      />
      <Toaster />
    </>,
  );
  changeInput(asElement(view.getByLabelText("Workspace Name")), "production");
  fireEvent.change(view.getByLabelText("Workspace Source"), { target: { value: "vcs" } });
  await waitFor((): void => { expect(view.getByText("Acme GitHub — GitHub App")).toBeTruthy(); });
  changeInput(asElement(view.getByLabelText("Repository Identifier")), "hashicorp/terraform");
  await act(async () => {
    const form = view.getByRole("button", { name: "Create Workspace" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });
  expect(fetchMock.mock.calls.some(([, init]): boolean => init?.method === "POST")).toBe(false);
  await waitFor((): void => {
    expect(view.getByText("Incomplete VCS connection")).toBeTruthy();
  });
});

test("does not report a successful latest run for a workspace with no runs", async () => {
  globalThis.fetch = mock(async (input: unknown): Promise<Response> => {
    const url = getUrlString(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: { name: "production" },
        },
      });
    }
    if (url === "/api/v2/workspaces/ws-1/runs?page[size]=1") return json({ data: [] });
    return json({ data: [] });
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
      <Routes>
        <Route path="/app/:orgName/workspaces/:workspaceName" element={<WorkspaceDetail />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("No runs yet")).toBeTruthy(); });
  expect(view.queryByText("Latest run finished")).toBeNull();
});

test("creates, edits, and deletes a workspace variable", async () => {
  const variables: {
    id: string;
    attributes: Record<string, unknown>;
  }[] = [];
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = getUrlString(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: {
            name: "production",
            "auto-apply": false,
            "iac-binary": "tofu",
            "terraform-version": "latest",
            locked: false,
            permissions: {
              "can-read-variable": true,
              "can-update-variable": true,
            },
          },
        },
      });
    }
    if (url.endsWith("/workspaces/ws-1/vars") && init?.method === "POST") {
      const payload = JSON.parse(init.body as string) as { data: { attributes: Record<string, unknown> } };
      const variable = { id: "var-1", attributes: payload.data.attributes };
      variables.push(variable);
      return json({ data: variable });
    }
    if (url.includes("/workspaces/ws-1/vars?") && init?.method === undefined) return json({ data: variables });
    if (url.endsWith("/workspaces/ws-1/vars/var-1") && init?.method === "PATCH") {
      const payload = JSON.parse(init.body as string) as { data: { attributes: Record<string, unknown> } };
      variables[0] = { id: "var-1", attributes: payload.data.attributes };
      return json({ data: variables[0] });
    }
    if (url.endsWith("/workspaces/ws-1/vars/var-1") && init?.method === "DELETE") {
      variables.splice(0);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;
  globalThis.confirm = mock((): boolean => true);

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName"
          element={<WorkspaceDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Workspace details")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "variables" }));
  await waitFor((): void => { expect(view.getByText("No workspace variables have been added.")).toBeTruthy(); });

  fireEvent.click(view.getByRole("button", { name: "Add variable" }));
  changeInput(asElement(view.getByLabelText("Key")), "region");
  changeInput(asElement(view.getByLabelText("Value")), "eu-west-2");
  fireEvent.change(view.getByLabelText("Category"), { target: { value: "env" } });
  changeInput(asElement(view.getByLabelText("Description")), "Deployment region");
  await act(async () => {
    const form = view.getByRole("button", { name: "Save variable" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  const createdRow = await waitFor((): HTMLElement =>
    view.getByText("region").closest("tr") as HTMLElement,
  );
  expect(within(createdRow).getByText("eu-west-2")).toBeTruthy();
  expect(within(createdRow).getByText("Environment")).toBeTruthy();

  fireEvent.click(within(createdRow).getByRole("button", { name: "Edit" }));
  changeInput(asElement(view.getByLabelText("Value")), "eu-central-1");
  fireEvent.click(view.getByLabelText("Sensitive"));
  await act(async () => {
    const form = view.getByRole("button", { name: "Save variable" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  const editedRow = await waitFor((): HTMLElement =>
    view.getByText("region").closest("tr") as HTMLElement,
  );
  expect(within(editedRow).getByText("Sensitive — write only")).toBeTruthy();
  fireEvent.click(within(editedRow).getByRole("button", { name: "Delete" }));
  await waitFor((): void => {
    expect(view.getByText("No workspace variables have been added.")).toBeTruthy();
  });

  expect(fetchMock.mock.calls.map(([input]): string => getUrlString(input))).toContain(
    "/api/v2/workspaces/ws-1/vars/var-1",
  );
});

test("updates workspace execution and auto-apply settings", async () => {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = getUrlString(input);
    const workspace = {
      id: "ws-1",
      attributes: {
        name: "production",
        description: "Production infrastructure",
        "auto-apply": false,
        "auto-apply-run-trigger": false,
        "execution-mode": "remote",
        "global-remote-state": false,
        "iac-binary": "tofu",
        "project-remote-state": false,
        "terraform-version": "latest",
        "working-directory": null,
        locked: false,
        permissions: { "can-update": true },
      },
    };
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({ data: workspace });
    }
    if (url === "/api/v2/workspaces/ws-1" && init?.method === "PATCH") {
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
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
      <Routes>
        <Route path="/app/:orgName/workspaces/:workspaceName" element={<WorkspaceDetail />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Workspace details")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "settings" }));
  changeInput(asElement(view.getByLabelText("Description")), "Primary production stack");
  fireEvent.change(view.getByLabelText("Execution mode"), { target: { value: "local" } });
  fireEvent.change(view.getByLabelText("Execution engine"), { target: { value: "terraform" } });
  changeInput(asElement(view.getByLabelText("Engine version")), "1.9.3");
  changeInput(asElement(view.getByLabelText("Terraform working directory")), "environments/production");
  fireEvent.change(view.getByLabelText("Remote state sharing"), { target: { value: "project" } });
  fireEvent.click(view.getByLabelText("Auto-apply API, UI, and VCS runs"));
  fireEvent.click(view.getByLabelText("Auto-apply run-triggered runs"));
  await act(async () => {
    const form = view.getByRole("button", { name: "Save settings" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => { expect(view.getByText("Settings saved.")).toBeTruthy(); });
  const patchCall = fetchMock.mock.calls.find(([input, init]): boolean =>
    getUrlString(input) === "/api/v2/workspaces/ws-1" && init?.method === "PATCH"
  );
  expect(patchCall).toBeDefined();
  if (patchCall === undefined) throw new Error("Expected workspace settings PATCH request");
  expect(JSON.parse(patchCall[1]!.body as string)).toEqual({
    data: {
      id: "ws-1",
      type: "workspaces",
      attributes: {
        name: "production",
        description: "Primary production stack",
        "execution-mode": "local",
        "working-directory": "environments/production",
        "global-remote-state": false,
        "project-remote-state": true,
        "iac-binary": "terraform",
        "terraform-version": "1.9.3",
        "auto-apply": true,
        "auto-apply-run-trigger": true,
      },
    },
  });
});

test("assigns an SSH key and enables workspace health assessments", async () => {
  const workspace = {
    id: "ws-1",
    attributes: {
      name: "production",
      "assessments-enabled": false,
      locked: false,
      permissions: { "can-update": true },
    },
    relationships: { "ssh-key": { data: null } },
  };
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = getUrlString(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") return json({ data: workspace });
    if (url === "/api/v2/organizations/acme/ssh-keys") {
      return json({ data: [{ id: "ssh-1", attributes: { name: "Deploy key" } }] });
    }
    if (url === "/api/v2/workspaces/ws-1/relationships/ssh-key" && init?.method === "PATCH") {
      return json({ data: { id: "ws-1", relationships: { "ssh-key": { data: { id: "ssh-1", type: "ssh-keys" } } } } });
    }
    if (url === "/api/v2/workspaces/ws-1" && init?.method === "PATCH") {
      const payload = JSON.parse(init.body as string) as { data: { attributes: Record<string, unknown> } };
      return json({
        data: {
          ...workspace,
          attributes: { ...workspace.attributes, ...payload.data.attributes },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
      <Routes>
        <Route path="/app/:orgName/workspaces/:workspaceName" element={<WorkspaceDetail />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Workspace details")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "ssh key" }));
  await waitFor((): void => { expect(view.getByLabelText("Assigned key")).toBeTruthy(); });
  fireEvent.change(view.getByLabelText("Assigned key"), { target: { value: "ssh-1" } });
  await act(async () => {
    const form = view.getByRole("button", { name: "Save assignment" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });
  await waitFor((): void => { expect(view.getByText("SSH key assignment saved.")).toBeTruthy(); });
  fireEvent.change(view.getByLabelText("Assigned key"), { target: { value: "" } });
  await act(async () => {
    const form = view.getByRole("button", { name: "Save assignment" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });
  await waitFor((): void => {
    expect(fetchMock.mock.calls.filter(([input]): boolean =>
      getUrlString(input) === "/api/v2/workspaces/ws-1/relationships/ssh-key"
    )).toHaveLength(2);
  });

  fireEvent.click(view.getByRole("button", { name: "health" }));
  fireEvent.click(view.getByLabelText("Enable health assessments"));
  await act(async () => {
    const form = view.getByRole("button", { name: "Save health settings" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });
  await waitFor((): void => { expect(view.getByText("Health assessment setting saved.")).toBeTruthy(); });

  const sshPatches = fetchMock.mock.calls.filter(([input]): boolean =>
    getUrlString(input) === "/api/v2/workspaces/ws-1/relationships/ssh-key"
  );
  const [assignPatch, removePatch] = sshPatches;
  if (assignPatch === undefined || removePatch === undefined) {
    throw new Error("Expected SSH key assignment and removal PATCH requests");
  }
  expect(JSON.parse(assignPatch[1]!.body as string)).toEqual({
    data: { id: "ssh-1", type: "ssh-keys" },
  });
  expect(JSON.parse(removePatch[1]!.body as string)).toEqual({ data: null });
  const healthPatch = fetchMock.mock.calls.find(([input]): boolean =>
    getUrlString(input) === "/api/v2/workspaces/ws-1"
  );
  if (healthPatch === undefined) throw new Error("Expected health assessment PATCH request");
  expect(JSON.parse(healthPatch[1]!.body as string).data.attributes).toEqual({
    "assessments-enabled": true,
  });
});

test("manages workspace run triggers and custom team access", async () => {
  const triggers: Record<string, unknown>[] = [];
  const teamAccess: {
    id: string;
    attributes: Record<string, unknown>;
    relationships: Record<string, unknown>;
  }[] = [];
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = getUrlString(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: {
            name: "production",
            locked: false,
            permissions: { "can-update": true },
          },
        },
      });
    }
    if (url.includes("/organizations/acme/workspaces?")) {
      return json({
        data: [
          { id: "ws-1", attributes: { name: "production" } },
          { id: "ws-source", attributes: { name: "networking" } },
        ],
      });
    }
    if (url === "/api/v2/workspaces/ws-1/run-triggers") return json({ data: triggers });
    if (url === "/api/v2/workspaces/ws-1/relationships/run-triggers" && init?.method === "POST") {
      triggers.push({
        id: "rt-1",
        attributes: { "created-at": "2026-07-28T12:00:00.000Z" },
        relationships: {
          "sourceable-workspace": { data: { id: "ws-source", type: "workspaces" } },
        },
      });
      return new Response(null, { status: 204 });
    }
    if (url === "/api/v2/workspaces/ws-1/relationships/run-triggers" && init?.method === "DELETE") {
      triggers.splice(0);
      return new Response(null, { status: 204 });
    }
    if (url === "/api/v2/organizations/acme/teams") {
      return json({ data: [{ id: "team-1", attributes: { name: "Platform" } }] });
    }
    if (url.includes("/api/v2/team-workspaces?")) return json({ data: teamAccess });
    if (url === "/api/v2/team-workspaces" && init?.method === "POST") {
      const payload = JSON.parse(init.body as string) as {
        data: {
          attributes: Record<string, unknown>;
          relationships: Record<string, unknown>;
        };
      };
      const relationship = {
        id: "tw-1",
        attributes: payload.data.attributes,
        relationships: payload.data.relationships,
      };
      teamAccess.push(relationship);
      return json({ data: relationship });
    }
    if (url === "/api/v2/team-workspaces/tw-1" && init?.method === "PATCH") {
      const payload = JSON.parse(init.body as string) as { data: { attributes: Record<string, unknown> } };
      teamAccess[0] = {
        ...teamAccess[0]!,
        attributes: payload.data.attributes,
      };
      return json({ data: teamAccess[0] });
    }
    if (url === "/api/v2/team-workspaces/tw-1" && init?.method === "DELETE") {
      teamAccess.splice(0);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;
  globalThis.confirm = mock((): boolean => true);

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
      <Routes>
        <Route path="/app/:orgName/workspaces/:workspaceName" element={<WorkspaceDetail />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Workspace details")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "run triggers" }));
  await waitFor((): void => { expect(view.getByText("No upstream workspaces are configured.")).toBeTruthy(); });
  fireEvent.change(view.getByLabelText("Source workspace"), { target: { value: "ws-source" } });
  fireEvent.click(view.getByRole("button", { name: "Add trigger" }));
  const triggerRow = await waitFor((): HTMLElement =>
    view.getByRole("cell", { name: "networking" }).closest("tr") as HTMLElement,
  );
  fireEvent.click(within(triggerRow).getByRole("button", { name: "Remove" }));
  await waitFor((): void => { expect(view.getByText("No upstream workspaces are configured.")).toBeTruthy(); });

  fireEvent.click(view.getByRole("button", { name: "team access" }));
  await waitFor((): void => { expect(view.getByText("No teams have explicit access to this workspace.")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Add team" }));
  fireEvent.change(view.getByLabelText("Team"), { target: { value: "team-1" } });
  fireEvent.change(view.getByLabelText("Access level"), { target: { value: "custom" } });
  fireEvent.change(view.getByLabelText("Runs"), { target: { value: "apply" } });
  fireEvent.change(view.getByLabelText("Variables"), { target: { value: "write" } });
  fireEvent.click(view.getByLabelText("Workspace locking"));
  await act(async () => {
    const form = view.getByRole("button", { name: "Save team access" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  const teamRow = await waitFor((): HTMLElement =>
    view.getByRole("cell", { name: "Platform" }).closest("tr") as HTMLElement,
  );
  expect(within(teamRow).getByText("custom")).toBeTruthy();
  fireEvent.click(within(teamRow).getByRole("button", { name: "Edit" }));
  fireEvent.change(view.getByLabelText("Access level"), { target: { value: "admin" } });
  await act(async () => {
    const form = view.getByRole("button", { name: "Save team access" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });
  const adminRow = await waitFor((): HTMLElement =>
    view.getByRole("cell", { name: "Platform" }).closest("tr") as HTMLElement,
  );
  expect(within(adminRow).getByText("admin")).toBeTruthy();
  fireEvent.click(within(adminRow).getByRole("button", { name: "Remove" }));
  await waitFor((): void => { expect(view.getByText("No teams have explicit access to this workspace.")).toBeTruthy(); });

  const customCreate = fetchMock.mock.calls.find(([input, init]): boolean =>
    getUrlString(input) === "/api/v2/team-workspaces" && init?.method === "POST"
  );
  if (customCreate === undefined) throw new Error("Expected custom team access POST request");
  const customAttributes = JSON.parse(customCreate[1]!.body as string).data.attributes;
  expect(customAttributes.access).toBe("custom");
  expect(customAttributes.permissions).toMatchObject({
    runs: "apply",
    variables: "write",
    "workspace-locking": true,
  });
});

test("creates, verifies, edits, and deletes a workspace notification", async () => {
  const configurations: {
    id: string;
    attributes: Record<string, unknown>;
  }[] = [];
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = getUrlString(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: {
            name: "production",
            locked: false,
            permissions: { "can-update": true },
          },
        },
      });
    }
    if (url === "/api/v2/workspaces/ws-1/notification-configurations" && init?.method === undefined) {
      return json({ data: configurations });
    }
    if (url === "/api/v2/workspaces/ws-1/notification-configurations" && init?.method === "POST") {
      const payload = JSON.parse(init.body as string) as { data: { attributes: Record<string, unknown> } };
      const configuration = { id: "nc-1", attributes: payload.data.attributes };
      configurations.push(configuration);
      return json({ data: configuration });
    }
    if (url === "/api/v2/notification-configurations/nc-1/actions/verify" && init?.method === "POST") {
      return json({ status: "verification_sent" });
    }
    if (url === "/api/v2/notification-configurations/nc-1" && init?.method === "PATCH") {
      const payload = JSON.parse(init.body as string) as { data: { attributes: Record<string, unknown> } };
      configurations[0] = { id: "nc-1", attributes: payload.data.attributes };
      return json({ data: configurations[0] });
    }
    if (url === "/api/v2/notification-configurations/nc-1" && init?.method === "DELETE") {
      configurations.splice(0);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;
  globalThis.confirm = mock((): boolean => true);

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
      <Routes>
        <Route path="/app/:orgName/workspaces/:workspaceName" element={<WorkspaceDetail />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Workspace details")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "notifications" }));
  await waitFor((): void => {
    expect(view.getByText("No notification configurations have been added.")).toBeTruthy();
  });
  fireEvent.click(view.getByRole("button", { name: "Add notification" }));
  changeInput(asElement(view.getByLabelText("Name")), "Deploy alerts");
  fireEvent.change(view.getByLabelText("Destination type"), { target: { value: "slack" } });
  changeInput(asElement(view.getByLabelText("Webhook URL")), "https://hooks.example.test/deploy");
  await act(async () => {
    const form = view.getByRole("button", { name: "Save notification" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  let notificationRow = await waitFor((): HTMLElement =>
    view.getByText("Deploy alerts").closest("tr") as HTMLElement,
  );
  expect(within(notificationRow).getByText("slack")).toBeTruthy();
  fireEvent.click(within(notificationRow).getByRole("button", { name: "Verify" }));
  await waitFor((): void => {
    expect(view.getByText("Verification requested for Deploy alerts.")).toBeTruthy();
  });
  fireEvent.click(within(notificationRow).getByRole("button", { name: "Edit" }));
  fireEvent.click(view.getByLabelText("Enabled"));
  await act(async () => {
    const form = view.getByRole("button", { name: "Save notification" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });
  notificationRow = await waitFor((): HTMLElement =>
    view.getByText("Deploy alerts").closest("tr") as HTMLElement,
  );
  expect(within(notificationRow).getByText("Disabled")).toBeTruthy();
  fireEvent.click(within(notificationRow).getByRole("button", { name: "Delete" }));
  await waitFor((): void => {
    expect(view.getByText("No notification configurations have been added.")).toBeTruthy();
  });
});

test("shows effective policy sets and manages workspace VCS settings", async () => {
  let workspace = {
    id: "ws-1",
    attributes: {
      name: "production",
      locked: false,
      "working-directory": "",
      "auto-apply": false,
      "file-triggers-enabled": true,
      "trigger-prefixes": ["modules"],
      "trigger-patterns": ["services/**/*.tf"],
      "speculative-enabled": true,
      "vcs-repo": {
        identifier: "acme/infrastructure",
        branch: "main",
        githubAppInstallationId: "ghain-123",
        ingressSubmodules: false,
      },
      permissions: { "can-update": true },
    },
  };
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = getUrlString(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({ data: workspace });
    }
    if (url === "/api/v2/workspaces/ws-1/policy-sets") {
      return json({
        data: [{
          id: "polset-1",
          type: "policy-sets",
          attributes: {
            name: "Production guardrails",
            description: "Security rules for production infrastructure.",
            kind: "opa",
            scope: "global",
            overridable: false,
            "policy-count": 2,
          },
        }],
      });
    }
    if (url === "/api/v2/workspaces/ws-1" && init?.method === "PATCH") {
      const payload = JSON.parse(init.body as string) as {
        data: { attributes: Record<string, unknown> };
      };
      const vcsRepo = payload.data.attributes["vcs-repo"];
      workspace = {
        ...workspace,
        attributes: {
          ...workspace.attributes,
          ...payload.data.attributes,
          "vcs-repo": vcsRepo === null ? null : {
            identifier: (vcsRepo as Record<string, unknown>)["identifier"] as string,
            branch: ((vcsRepo as Record<string, unknown>)["branch"] as string | null) ?? undefined,
            githubAppInstallationId: (
              (vcsRepo as Record<string, unknown>)["github-app-installation-id"] as string | null
            ) ?? undefined,
            ingressSubmodules: (vcsRepo as Record<string, unknown>)["ingress-submodules"] as boolean,
            tagsRegex: ((vcsRepo as Record<string, unknown>)["tags-regex"] as string | null) ?? undefined,
          },
        },
      };
      return json({ data: workspace });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;
  globalThis.confirm = mock((): boolean => true);

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
      <Routes>
        <Route path="/app/:orgName/workspaces/:workspaceName" element={<WorkspaceDetail />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Workspace details")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "policy sets" }));
  const policyRow = await waitFor((): HTMLElement =>
    view.getByText("Production guardrails").closest("tr") as HTMLElement,
  );
  expect(within(policyRow).getByText("global")).toBeTruthy();
  expect(within(policyRow).getByText("OPA")).toBeTruthy();
  expect(within(policyRow).getByText("2")).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: "vcs" }));
  await waitFor((): void => { expect(view.getByText("Connected")).toBeTruthy(); });
  changeInput(asElement(view.getByLabelText("VCS branch")), "release");
  changeInput(asElement(view.getByLabelText("Terraform working directory")), "environments/production");
  changeInput(asElement(view.getByLabelText("Git tag regular expression")), "^v\\d+\\.\\d+\\.\\d+$");
  changeInput(asElement(view.getByLabelText("Trigger prefixes")), "modules, shared");
  changeInput(asElement(view.getByLabelText("Trigger patterns")), "services/**/*.tf, common/**/*.tf");
  fireEvent.click(view.getByLabelText("Auto-apply successful plans"));
  fireEvent.click(view.getByLabelText("Include submodules when cloning"));
  await act(async () => {
    const form = view.getByRole("button", { name: "Save VCS settings" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });
  await waitFor((): void => { expect(view.getByText("VCS settings saved.")).toBeTruthy(); });

  const saveCall = fetchMock.mock.calls.find(([input, init]): boolean => {
    if (getUrlString(input) !== "/api/v2/workspaces/ws-1" || init?.method !== "PATCH") return false;
    const body = JSON.parse(init.body as string) as { data: { attributes: Record<string, unknown> } };
    return body.data.attributes["vcs-repo"] !== null;
  });
  if (saveCall === undefined) throw new Error("Expected VCS settings PATCH request");
  expect(JSON.parse(saveCall[1]!.body as string).data.attributes).toEqual({
    "vcs-repo": {
      identifier: "acme/infrastructure",
      branch: "release",
      "github-app-installation-id": "ghain-123",
      "oauth-token-id": null,
      "ingress-submodules": true,
      "tags-regex": "^v\\d+\\.\\d+\\.\\d+$",
    },
    "working-directory": "environments/production",
    "auto-apply": true,
    "file-triggers-enabled": true,
    "trigger-prefixes": ["modules", "shared"],
    "trigger-patterns": ["services/**/*.tf", "common/**/*.tf"],
    "speculative-enabled": true,
  });

  fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
  await waitFor((): void => { expect(view.getByText("Not connected")).toBeTruthy(); });
  const disconnectCall = fetchMock.mock.calls.find(([input, init]): boolean => {
    if (getUrlString(input) !== "/api/v2/workspaces/ws-1" || init?.method !== "PATCH") return false;
    const body = JSON.parse(init.body as string) as { data: { attributes: Record<string, unknown> } };
    return body.data.attributes["vcs-repo"] === null;
  });
  expect(disconnectCall).toBeDefined();
});

test("displays run cost and policy check results", async () => {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = getUrlString(input);
    if (url === "/api/v2/runs/run-policy") {
      return json({
        data: {
          id: "run-policy",
          attributes: {
            message: "Review production changes",
            status: "policy_soft_failed",
            permissions: { "can-override-policy-check": true },
            "created-at": "2026-07-28T12:00:00.000Z",
          },
        },
      });
    }
    if (url === "/api/v2/runs/run-policy/logs") {
      return json({ data: [{ attributes: { "output-text": "Plan: 2 to change." } }] });
    }
    if (url === "/api/v2/runs/run-policy/cost-estimate") {
      return json({
        data: {
          id: "ce-run-policy",
          attributes: {
            status: "finished",
            "prior-monthly-cost": "100",
            "proposed-monthly-cost": "125.5",
            "delta-monthly-cost": "25.5",
            "resources-count": 3,
            "matched-resources-count": 2,
            "unmatched-resources-count": 1,
            "error-message": null,
          },
        },
      });
    }
    if (url === "/api/v2/runs/run-policy/policy-checks") {
      return json({
        data: [{
          id: "polchk-regions",
          attributes: {
            status: "soft_failed",
            result: { policy: "Restrict regions", violations: ["eu-west-3"] },
          },
        }],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-policy"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<RunDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getAllByText("$25.50 / month").length).toBeGreaterThan(0);
  });
  expect(view.getByText("$100.00 / month")).toBeTruthy();
  expect(view.getByText("$125.50 / month")).toBeTruthy();
  expect(view.getByText("2 of 3")).toBeTruthy();
  expect(view.getByText("Restrict regions — 1 violation: eu-west-3")).toBeTruthy();
  expect(view.getByText("polchk-regions")).toBeTruthy();
  expect(view.getByRole("button", { name: "Override policy" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Confirm & Apply" })).toBeNull();
});

test("keeps advisory policy failures non-blocking and names the policy", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = getUrlString(input);
    if (url === "/api/v2/runs/run-advisory") {
      return json({
        data: {
          id: "run-advisory",
          attributes: {
            message: "Review advisory policy",
            status: "planned",
            source: "github",
            "trigger-reason": "pull_request",
            permissions: {},
          },
        },
      });
    }
    if (url === "/api/v2/runs/run-advisory/plan") {
      return json({ data: { attributes: { status: "finished" } } });
    }
    if (url === "/api/v2/applies/apply-run-advisory") {
      return json({ data: { attributes: { status: "pending" } } });
    }
    if (url === "/api/v2/plans/plan-run-advisory/json-output") {
      return json({ resource_changes: [] });
    }
    if (url === "/api/v2/runs/run-advisory/policy-checks") {
      return json({
        data: [
          {
            id: "pchk-advisory",
            attributes: {
              status: "failed",
              "policy-name": "Tag recommendations",
              "enforcement-level": "advisory",
              result: {
                "total-failed": 1,
                "hard-failed": 0,
                "soft-failed": 0,
                "advisory-failed": 1,
              },
            },
          },
          {
            id: "pchk-advisory-error",
            attributes: {
              status: "errored",
              "policy-name": "Optional naming advice",
              "enforcement-level": "advisory",
              result: { error: "Advisory service unavailable" },
            },
          },
        ],
      });
    }
    if (url === "/api/v2/runs/run-advisory/run-events") {
      return json({
        data: [{
          id: "event-advisory-created",
          attributes: {
            action: "create",
            details: { source: "github", triggerReason: "pull_request" },
          },
        }],
      });
    }
    if (url.endsWith("/logs") || url.endsWith("/comments")) {
      return json({ data: [] });
    }
    if (url.endsWith("/cost-estimate")) return json({ data: null });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-advisory"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<RunDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await view.findByText("Tag recommendations");
  expect(view.getByText(/Pull request · GitHub · Created/)).toBeTruthy();
  expect(view.getByText("Pull request from GitHub")).toBeTruthy();
  expect(view.getByText("Optional naming advice")).toBeTruthy();
  expect(view.getByText("passed · 2 advisory issues")).toBeTruthy();
  expect(view.getByText("1 advisory failure")).toBeTruthy();
  expect(view.getByText("advisory failed")).toBeTruthy();
  expect(view.getByText("advisory errored")).toBeTruthy();
  expect(view.getByText("Advisory service unavailable")).toBeTruthy();
  expect(view.getByText("pchk-advisory")).toBeTruthy();
});

test("queues a run, displays its logs, and applies it", async () => {
  let runCreated = false;
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = getUrlString(input);
    if (url.endsWith("/runs") && init?.method === "POST") {
      runCreated = true;
      return json({ data: { id: "run-12345678" } });
    }
    if (url.endsWith("/workspaces/ws-1/runs")) {
      return json({
        data: runCreated
          ? [{ id: "run-12345678", attributes: { message: "Queued manually via UI", status: "planned" } }]
          : [],
      });
    }
    if (url.endsWith("/runs/run-12345678/actions/apply")) return new Response(null, { status: 202 });
    if (url.endsWith("/runs/run-12345678/logs")) {
      return json({ logs: [{ message: "Plan: 1 to add." }] });
    }
    if (url.endsWith("/runs/run-12345678")) {
      return json({
        data: {
          id: "run-12345678",
          attributes: {
            message: "Queued manually via UI",
            status: "planned",
            actions: { "is-confirmable": true },
            permissions: { "can-apply": true },
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const list = render(
    <MemoryRouter>
      <RunList
        workspaceId="ws-1"
        orgName="acme"
        workspaceName="production"
      />
    </MemoryRouter>,
  );
  await waitFor((): void => { expect(list.getByText("There is no run history for this workspace.")).toBeTruthy(); });
  fireEvent.click(list.getAllByRole("button", { name: "Start new run" })[0]);
  await waitFor((): void => { expect(list.getByText("Configure and start a new run for this workspace.")).toBeTruthy(); });
  fireEvent.click(list.getByRole("button", { name: "Start run" }));
  await waitFor((): void => { expect(list.getByText("Queued manually via UI")).toBeTruthy(); });
  cleanup();

  const detail = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-12345678"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<RunDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor((): void => { expect(detail.getByText(/Plan: 1 to add./)).toBeTruthy(); }, { timeout: 5000 });
  fireEvent.click(detail.getByRole("button", { name: "Confirm & Apply" }));
  await waitFor((): void => { expect(fetchMock.mock.calls.some(([url, init]): boolean =>
    getUrlString(url).endsWith("/runs/run-12345678/actions/apply") &&
    init?.method === "POST"
  )).toBeTrue(); });
});

type VarSetItem = {
  readonly id: string;
  readonly type: string;
  readonly attributes: {
    name: string;
    description: string | null;
    global: boolean;
    "var-count": number;
    "workspace-count": number;
  };
  readonly relationships: {
    readonly workspaces: {
      readonly data: readonly { readonly id: string; readonly type: string }[];
    };
  };
};

const createVarsetsFetchMock = (initialSets: VarSetItem[] = []) => {
  const variableSet = (
    id: string,
    name: string,
    global: boolean,
    workspaceIds: readonly string[] = [],
    description: string | null = null,
    variableCount = 0,
  ): VarSetItem => ({
    id,
    type: "varsets",
    attributes: {
      name,
      description,
      global,
      "var-count": variableCount,
      "workspace-count": workspaceIds.length,
    },
    relationships: {
      workspaces: {
        data: workspaceIds.map((workspaceId: string) => ({ id: workspaceId, type: "workspaces" })),
      },
    },
  });

  const shared = variableSet("varset-shared", "Shared credentials", false, ["ws-dev"], null, 1);
  const sets: VarSetItem[] = initialSets.length > 0 ? initialSets : [shared];
  const apiToken = {
    id: "var-token",
    type: "vars",
    attributes: {
      key: "API_TOKEN",
      value: null,
      category: "env",
      sensitive: true,
      hcl: false,
      description: "Existing secret",
    },
  };

  const varsList: Record<string, unknown>[] = [apiToken];

  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = getUrlString(input);
    if (url === "/api/v2/organizations/acme" && init?.method === undefined) {
      return json({ data: { attributes: { permissions: { "can-manage-workspaces": true } } } });
    }
    if (url.includes("/organizations/acme/varsets?") && init?.method === undefined) {
      return json({ data: sets });
    }
    if (url.includes("/organizations/acme/workspaces?") && init?.method === undefined) {
      return json({
        data: [
          { id: "ws-dev", type: "workspaces", attributes: { name: "development" } },
          { id: "ws-prod", type: "workspaces", attributes: { name: "production" } },
        ],
      });
    }
    if (
      url.includes("/varsets/varset-shared/relationships/vars?") &&
      init?.method === undefined
    ) {
      return json({ data: varsList });
    }
    if (
      url.endsWith("/varsets/varset-shared/relationships/vars") &&
      init?.method === "POST"
    ) {
      const payload = JSON.parse(init.body as string) as { data: { attributes: Record<string, unknown> } };
      const newVar = {
        id: "var-database",
        type: "vars",
        attributes: { ...payload.data.attributes, hcl: false },
      };
      varsList.push(newVar);
      return json({ data: newVar });
    }
    if (
      url.endsWith("/varsets/varset-shared/relationships/vars/var-token") &&
      init?.method === "PATCH"
    ) {
      const payload = JSON.parse(init.body as string) as { data: { attributes: Record<string, unknown> } };
      const updatedToken = {
        ...apiToken,
        attributes: {
          ...apiToken.attributes,
          ...payload.data.attributes,
          value: null,
        },
      };
      const idx = varsList.findIndex((v: Record<string, unknown>): boolean => v["id"] === "var-token");
      if (idx !== -1) varsList[idx] = updatedToken;
      return json({ data: updatedToken });
    }
    if (
      url.endsWith("/varsets/varset-shared/relationships/vars/var-database") &&
      init?.method === "DELETE"
    ) {
      const idx = varsList.findIndex((v: Record<string, unknown>): boolean => v["id"] === "var-database");
      if (idx !== -1) varsList.splice(idx, 1);
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/organizations/acme/varsets") && init?.method === "POST") {
      const payload = JSON.parse(init.body as string) as { data: { attributes: { name: string; global: boolean; description: string | null } } };
      const newSet = variableSet(
        "varset-global",
        payload.data.attributes.name,
        payload.data.attributes.global,
        [],
        payload.data.attributes.description,
      );
      sets.push(newSet);
      return json({ data: newSet });
    }
    if (url.endsWith("/varsets/varset-global") && init?.method === "PATCH") {
      const payload = JSON.parse(init.body as string) as { data: { attributes: { name: string; global: boolean; description: string | null } } };
      const updated = variableSet(
        "varset-global",
        payload.data.attributes.name,
        payload.data.attributes.global,
        [],
        payload.data.attributes.description,
      );
      const idx = sets.findIndex((s: VarSetItem): boolean => s.id === "varset-global");
      if (idx !== -1) sets[idx] = updated;
      return json({ data: updated });
    }
    if (
      url.endsWith("/varsets/varset-shared/relationships/workspaces") &&
      ["POST", "DELETE"].includes(init?.method ?? "")
    ) {
      return new Response(null, { status: 204 });
    }
    if (
      (url.endsWith("/varsets/varset-global") || url.endsWith("/varsets/varset-shared")) &&
      init?.method === "DELETE"
    ) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  return { fetchMock, variableSet, shared };
};

test("keeps variable sets readable without workspace management permission", async () => {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = getUrlString(input);
    if (url.includes("/organizations/acme/varsets?")) {
      return json({
        data: [{
          id: "varset-shared",
          attributes: {
            name: "Shared credentials",
            description: null,
            global: false,
            "var-count": 1,
            "workspace-count": 0,
          },
          relationships: { workspaces: { data: [] } },
        }],
      });
    }
    if (url.includes("/organizations/acme/workspaces?")) return json({ data: [] });
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { permissions: { "can-manage-workspaces": false } } } });
    }
    if (url.includes("/varsets/varset-shared/relationships/vars?")) {
      return json({
        data: [{
          id: "var-token",
          attributes: {
            key: "API_TOKEN",
            value: null,
            category: "env",
            sensitive: true,
            hcl: false,
            description: null,
          },
        }],
      });
    }
    throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/variable-sets"]}>
      <Routes>
        <Route path="/app/:orgName/variable-sets" element={<VariableSets />} />
      </Routes>
    </MemoryRouter>,
  );

  await view.findByText("Shared credentials");
  expect(view.queryByRole("button", { name: "New variable set" })).toBeNull();
  expect(view.queryByRole("button", { name: "Workspaces" })).toBeNull();
  expect(view.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(view.queryByRole("button", { name: "Delete" })).toBeNull();

  fireEvent.click(view.getByRole("button", { name: "Variables" }));
  const body = within(asElement(window.document.body));
  await body.findByText("API_TOKEN");
  expect(body.queryByRole("button", { name: "Add variable" })).toBeNull();
  expect(body.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(body.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(fetchMock.mock.calls.every(([, init]): boolean => init?.method === undefined)).toBeTrue();
});

test("creates variable sets and toggles global scope", async () => {
  const { fetchMock } = createVarsetsFetchMock();
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/variable-sets"]}>
      <Routes>
        <Route path="/app/:orgName/variable-sets" element={<VariableSets />} />
      </Routes>
    </MemoryRouter>,
  );

  const getBody = (): ReturnType<typeof within> => within(asElement(window.document.body));
  await waitFor((): void => { expect(view.getByText("Shared credentials")).toBeTruthy(); });

  fireEvent.click(view.getByRole("button", { name: "New variable set" }));
  changeInput(asElement(getBody().getByLabelText("Name")), "Global defaults");
  changeInput(asElement(getBody().getByLabelText("Description")), "Organization defaults");
  fireEvent.click(getBody().getByLabelText("Global"));
  await act(async () => {
    const form = getBody().getByRole("button", { name: "Save variable set" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => { expect(view.getByText("Global defaults")).toBeTruthy(); });
  const createCall = fetchMock.mock.calls.find(
    ([url, init]): boolean =>
      getUrlString(url).endsWith("/organizations/acme/varsets") &&
      init?.method === "POST",
  );
  expect(createCall).toBeDefined();
  expect(JSON.parse((createCall![1]!).body as string)).toEqual({
    data: {
      type: "varsets",
      attributes: {
        name: "Global defaults",
        description: "Organization defaults",
        global: true,
      },
    },
  });

  const globalRow = view.getByText("Global defaults").closest("tr");
  if (globalRow !== null) {
    expect(within(asElement(globalRow)).getByText("Global")).toBeTruthy();
    fireEvent.click(within(asElement(globalRow)).getByRole("button", { name: "Edit" }));
  }
  changeInput(asElement(getBody().getByLabelText("Name")), "Environment defaults");
  fireEvent.click(getBody().getByLabelText("Global"));
  await act(async () => {
    const form = getBody().getByRole("button", { name: "Save variable set" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => { expect(view.getByText("Environment defaults")).toBeTruthy(); });
  const envRow = view.getByText("Environment defaults").closest("tr");
  if (envRow !== null) {
    expect(
      within(asElement(envRow)).getByText("Selected"),
    ).toBeTruthy();
  }
});

test("manages workspace attachments for variable sets", async () => {
  const { fetchMock } = createVarsetsFetchMock();
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/variable-sets"]}>
      <Routes>
        <Route path="/app/:orgName/variable-sets" element={<VariableSets />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Shared credentials")).toBeTruthy(); });

  const sharedRow = view.getByText("Shared credentials").closest("tr");
  if (sharedRow !== null) {
    fireEvent.click(within(asElement(sharedRow)).getByRole("button", { name: "Workspaces" }));
  }
  fireEvent.click(view.getByLabelText("development"));
  fireEvent.click(view.getByLabelText("production"));
  const form = view.getByRole("button", { name: "Save workspaces" }).closest("form");
  if (form !== null) fireEvent.submit(form);

  await waitFor((): void =>
    { expect(view.queryByRole("heading", { name: "Manage workspaces" })).toBeNull(); },
  );
  const attachmentCalls = fetchMock.mock.calls.filter(([url]): boolean =>
    getUrlString(url).endsWith("/varsets/varset-shared/relationships/workspaces"),
  );
  expect(attachmentCalls).toHaveLength(2);
  expect(attachmentCalls.map(([, init]): string | undefined => init?.method).sort()).toEqual([
    "DELETE",
    "POST",
  ]);
});

test("manages variables inside a variable set", async () => {
  const { fetchMock } = createVarsetsFetchMock();
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/variable-sets"]}>
      <Routes>
        <Route path="/app/:orgName/variable-sets" element={<VariableSets />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Shared credentials")).toBeTruthy(); });

  const sharedRow = view.getByText("Shared credentials").closest("tr");
  if (sharedRow !== null) {
    fireEvent.click(
      within(asElement(sharedRow)).getByRole("button", {
        name: "Variables",
      }),
    );
  }
  const getBody = (): ReturnType<typeof within> => within(asElement(window.document.body));
  await waitFor((): void => { expect(getBody().getByText("API_TOKEN")).toBeTruthy(); });
  expect(getBody().getByText("••••••••")).toBeTruthy();

  const tokenRow = getBody().getByText("API_TOKEN").closest("tr");
  if (tokenRow !== null) {
    fireEvent.click(
      within(asElement(tokenRow)).getByRole("button", { name: "Edit" }),
    );
  }
  expect((getBody().getByLabelText("Value") as HTMLInputElement).value).toBe("");
  changeInput(asElement(getBody().getByLabelText("Description")), "Rotated secret");
  await act(async () => {
    const editForm = getBody().getByRole("button", { name: "Save variable" }).closest("form");
    if (editForm !== null) fireEvent.submit(editForm);
  });
  await waitFor((): void =>
    { expect(getBody().getByText("Variables in Shared credentials")).toBeTruthy(); },
  );

  fireEvent.click(getBody().getByRole("button", { name: "Add variable" }));
  await waitFor((): void => { expect(window.document.getElementById("variable-key")).not.toBeNull(); });
  const k = window.document.getElementById("variable-key") as HTMLInputElement;
  const v = window.document.getElementById("variable-value") as HTMLInputElement;
  const d = window.document.getElementById("variable-description") as HTMLInputElement;
  changeInput(k, "DATABASE_URL");
  changeInput(v, "postgres://database");
  changeInput(d, "Application database");
  await act(async () => {
    const addForm = getBody().getByRole("button", { name: "Save variable" }).closest("form");
    if (addForm !== null) fireEvent.submit(addForm);
  });
  await waitFor((): void => { expect(window.document.body.textContent).toContain("DATABASE_URL"); });

  const createVariableCall = fetchMock.mock.calls.find(
    ([url, init]): boolean =>
      getUrlString(url).endsWith("/varsets/varset-shared/relationships/vars") &&
      init?.method === "POST",
  );
  expect(createVariableCall).toBeDefined();

  const dbRow = getBody().getByText("DATABASE_URL").closest("tr");
  if (dbRow !== null) {
    fireEvent.click(
      within(asElement(dbRow)).getByRole("button", {
        name: "Delete",
      }),
    );
  }
  await waitFor((): void => { expect(getBody().queryByText("DATABASE_URL")).toBeNull(); });
  expect(fetchMock.mock.calls.some(
    ([url, init]): boolean =>
      getUrlString(url).endsWith("/varsets/varset-shared/relationships/vars/var-database") &&
      init?.method === "DELETE",
  )).toBeTrue();
});

test("deletes variable sets", async () => {
  const { fetchMock } = createVarsetsFetchMock();
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/variable-sets"]}>
      <Routes>
        <Route path="/app/:orgName/variable-sets" element={<VariableSets />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Shared credentials")).toBeTruthy(); });

  const sharedRow = view.getByText("Shared credentials").closest("tr");
  if (sharedRow !== null) {
    fireEvent.click(within(asElement(sharedRow)).getByRole("button", { name: "Delete" }));
  }
  await waitFor((): void => { expect(view.queryByText("Shared credentials")).toBeNull(); });
  expect(fetchMock.mock.calls.some(
    ([url, init]): boolean =>
      getUrlString(url).endsWith("/varsets/varset-shared") &&
      init?.method === "DELETE",
  )).toBeTrue();
});
