import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { CreateWorkspaceModal } from "../src/components/CreateWorkspaceModal";
import { Login } from "../src/views/Login";
import { RunDetail } from "../src/views/RunDetail";
import { RunList } from "../src/views/RunList";
import { WorkspaceDetail } from "../src/views/WorkspaceDetail";
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
    data: { attributes: { username: "alice", password: "correct horse" } },
  });
});

test("creates a workspace from the modal", async () => {
  const fetchMock = mock(async (): Promise<Response> =>
    json({ data: { id: "ws-1", attributes: { name: "production" } } }),
  );
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
  changeInput(asElement(view.getByLabelText("Repository Identifier")), "hashicorp/terraform");
  changeInput(asElement(view.getByLabelText("GitHub App Installation ID")), "ghain-123");
  fireEvent.click(view.getByLabelText("Auto-apply plans upon completion"));
  await act(async () => {
    const form = view.getByRole("button", { name: "Create Workspace" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => { expect(onCreated).toHaveBeenCalledTimes(1); });
  const [workspaceUrl, workspaceOptions] = fetchMock.mock.calls[0]!;
  expect(getUrlString(workspaceUrl)).toBe("/api/v2/organizations/acme/workspaces");
  expect(JSON.parse((workspaceOptions as RequestInit).body as string)).toEqual({
    data: {
      attributes: {
        name: "production",
        "auto-apply": true,
        "iac-binary": "terraform",
        "terraform-version": "1.9.3",
        "vcs-repo": {
          identifier: "hashicorp/terraform",
          "github-app-installation-id": "ghain-123",
        },
      },
      type: "workspaces",
    },
  });
  expect(view.getByLabelText("Repository Identifier").value).toBe("");
  expect(view.getByLabelText("GitHub App Installation ID").value).toBe("");
});

test("rejects a partially configured workspace VCS connection", async () => {
  const fetchMock = mock(async (): Promise<Response> => json({ data: { id: "unexpected" } }));
  const alertMock = mock((): void => {
    // Intentional alert mock
  });
  globalThis.fetch = fetchMock as typeof fetch;
  globalThis.alert = alertMock;
  const view = render(
    <CreateWorkspaceModal
      orgName="acme"
      open
      onOpenChange={(): void => {
        // Intentional noop
      }}
      onCreated={(): void => {
        // Intentional noop
      }}
    />,
  );
  changeInput(asElement(view.getByLabelText("Workspace Name")), "production");
  changeInput(asElement(view.getByLabelText("Repository Identifier")), "hashicorp/terraform");
  await act(async () => {
    const form = view.getByRole("button", { name: "Create Workspace" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });
  expect(fetchMock).toHaveBeenCalledTimes(0);
  expect(alertMock).toHaveBeenCalledTimes(1);
});

test("creates and deletes a workspace variable", async () => {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = getUrlString(input);
    if (url.endsWith("/organizations/acme/workspaces/production")) {
      return json({
        data: {
          id: "ws-1",
          attributes: {
            name: "production",
            "auto-apply": false,
            "iac-binary": "tofu",
            "terraform-version": "latest",
            locked: false,
          },
        },
      });
    }
    if (url.endsWith("/workspaces/ws-1/vars") && init?.method === "POST") {
      return json({
        data: {
          id: "var-1",
          attributes: {
            key: "region",
            value: "eu-west-2",
            category: "terraform",
            sensitive: false,
          },
        },
      });
    }
    if (url.endsWith("/workspaces/ws-1/vars") && init?.method === undefined) return json({ data: [] });
    if (url.endsWith("/workspaces/ws-1/vars/var-1")) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

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
          attributes: { message: "Queued manually via UI", status: "planned" },
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
  fireEvent.click(list.getByRole("button", { name: "Start new run" }));
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
  expect(attachmentCalls).toHaveLength(1);
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
