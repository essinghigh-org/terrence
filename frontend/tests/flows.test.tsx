import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { CreateWorkspaceModal } from "../src/components/CreateWorkspaceModal";
import { Login } from "../src/views/Login";
import { RunDetail } from "../src/views/RunDetail";
import { RunList } from "../src/views/RunList";
import { WorkspaceDetail } from "../src/views/WorkspaceDetail";
import { VariableSets } from "../src/views/VariableSets";

const originalFetch = globalThis.fetch;
const originalConfirm = globalThis.confirm;
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

afterEach(() => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
  globalThis.confirm = originalConfirm;
});

test("logs in, stores the token, and navigates home", async () => {
  const fetchMock = mock(async () =>
    json({ data: { attributes: { token: "user-token" } } }),
  );
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  );

  fireEvent.change(view.getByLabelText("Username"), { target: { value: "alice" } });
  fireEvent.change(view.getByLabelText("Password"), { target: { value: "correct horse" } });
  fireEvent.submit(view.getByRole("button", { name: "Sign in" }).closest("form")!);

  await waitFor(() => expect(view.getByText("Home")).toBeTruthy());
  expect(localStorage.getItem("tfe_token")).toBe("user-token");
  const [loginUrl, loginOptions] = fetchMock.mock.calls[0]!;
  expect(loginUrl).toBe("/api/v2/users/login");
  expect(JSON.parse((loginOptions as RequestInit).body as string)).toEqual({
    data: { attributes: { username: "alice", password: "correct horse" } },
  });
});

test("creates a workspace from the modal", async () => {
  const fetchMock = mock(async () =>
    json({ data: { id: "ws-1", attributes: { name: "production" } } }),
  );
  const onCreated = mock(() => {});
  globalThis.fetch = fetchMock as typeof fetch;
  const view = render(
    <CreateWorkspaceModal
      orgName="acme"
      open
      onOpenChange={() => {}}
      onCreated={onCreated}
    />,
  );

  fireEvent.change(view.getByLabelText("Workspace Name"), {
    target: { value: "production" },
  });
  fireEvent.change(view.getByLabelText("Execution Engine"), {
    target: { value: "terraform" },
  });
  fireEvent.change(view.getByLabelText(/Engine Version/), {
    target: { value: "1.9.3" },
  });
  fireEvent.click(view.getByLabelText("Auto-apply plans upon completion"));
  fireEvent.submit(view.getByRole("button", { name: "Create Workspace" }).closest("form")!);

  await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  const [workspaceUrl, workspaceOptions] = fetchMock.mock.calls[0]!;
  expect(workspaceUrl).toBe("/api/v2/organizations/acme/workspaces");
  expect(JSON.parse((workspaceOptions as RequestInit).body as string)).toEqual({
    data: {
      attributes: {
        name: "production",
        "auto-apply": true,
        "iac-binary": "terraform",
        "terraform-version": "1.9.3",
      },
      type: "workspaces",
    },
  });
});

test("creates and deletes a workspace variable", async () => {
  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
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
    if (url.endsWith("/workspaces/ws-1/vars") && !init?.method) return json({ data: [] });
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

  await waitFor(() => expect(view.getByText("Execution Engine")).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "variables" }));
  fireEvent.click(view.getByRole("button", { name: "Add variable" }));
  fireEvent.change(view.getByLabelText("Key"), { target: { value: "region" } });
  fireEvent.change(view.getByLabelText("Value"), { target: { value: "eu-west-2" } });
  fireEvent.submit(view.getByRole("button", { name: "Save variable" }).closest("form")!);

  await waitFor(() => expect(view.getByText("region")).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(view.queryByText("region")).toBeNull());
  expect(fetchMock.mock.calls.some(([url, init]) =>
    String(url).endsWith("/workspaces/ws-1/vars") && (init as RequestInit)?.method === "POST"
  )).toBeTrue();
  expect(fetchMock.mock.calls.some(([url, init]) =>
    String(url).endsWith("/workspaces/ws-1/vars/var-1") && (init as RequestInit)?.method === "DELETE"
  )).toBeTrue();
});

test("queues a run, displays its logs, and applies it", async () => {
  let runCreated = false;
  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
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
      return json({ data: [{ attributes: { phase: "plan", "output-text": "Plan: 1 to add." } }] });
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
  await waitFor(() => expect(list.getByText("No runs recorded for this workspace.")).toBeTruthy());
  fireEvent.click(list.getByRole("button", { name: "Start new run" }));
  await waitFor(() => expect(list.getByText("Queued manually via UI")).toBeTruthy());
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
  await waitFor(() => expect(detail.getByText("Plan: 1 to add.")).toBeTruthy());
  fireEvent.click(detail.getByRole("button", { name: "Confirm & Apply" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
    String(url).endsWith("/runs/run-12345678/actions/apply") &&
    (init as RequestInit)?.method === "POST"
  )).toBeTrue());
});

const createVarsetsFetchMock = (initialSets: any[] = []) => {
  const variableSet = (
    id: string,
    name: string,
    global: boolean,
    workspaceIds: string[] = [],
    description: string | null = null,
    variableCount = 0,
  ) => ({
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
        data: workspaceIds.map((workspaceId) => ({ id: workspaceId, type: "workspaces" })),
      },
    },
  });

  const shared = variableSet("varset-shared", "Shared credentials", false, ["ws-dev"], null, 1);
  const sets = initialSets.length ? initialSets : [shared];
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

  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/organizations/acme/varsets?") && !init?.method) {
      return json({ data: sets });
    }
    if (url.includes("/organizations/acme/workspaces?") && !init?.method) {
      return json({
        data: [
          { id: "ws-dev", type: "workspaces", attributes: { name: "development" } },
          { id: "ws-prod", type: "workspaces", attributes: { name: "production" } },
        ],
      });
    }
    if (
      url.includes("/varsets/varset-shared/relationships/vars?") &&
      !init?.method
    ) {
      return json({ data: [apiToken] });
    }
    if (
      url.endsWith("/varsets/varset-shared/relationships/vars") &&
      init?.method === "POST"
    ) {
      const body = JSON.parse(init.body as string);
      return json({
        data: {
          id: "var-database",
          type: "vars",
          attributes: { ...body.data.attributes, hcl: false },
        },
      });
    }
    if (
      url.endsWith("/varsets/varset-shared/relationships/vars/var-token") &&
      init?.method === "PATCH"
    ) {
      const body = JSON.parse(init.body as string);
      return json({
        data: {
          ...apiToken,
          attributes: {
            ...apiToken.attributes,
            ...body.data.attributes,
            value: null,
          },
        },
      });
    }
    if (
      url.endsWith("/varsets/varset-shared/relationships/vars/var-database") &&
      init?.method === "DELETE"
    ) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/organizations/acme/varsets") && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      const newSet = variableSet(
        "varset-global",
        body.data.attributes.name,
        body.data.attributes.global,
        [],
        body.data.attributes.description,
      );
      sets.push(newSet);
      return json({ data: newSet });
    }
    if (url.endsWith("/varsets/varset-global") && init?.method === "PATCH") {
      const body = JSON.parse(init.body as string);
      const updated = variableSet(
        "varset-global",
        body.data.attributes.name,
        body.data.attributes.global,
        [],
        body.data.attributes.description,
      );
      const idx = sets.findIndex((s) => s.id === "varset-global");
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

  await waitFor(() => expect(view.getByText("Shared credentials")).toBeTruthy());

  fireEvent.click(view.getByRole("button", { name: "New variable set" }));
  fireEvent.change(view.getByLabelText("Name"), { target: { value: "Global defaults" } });
  fireEvent.change(view.getByLabelText("Description"), {
    target: { value: "Organization defaults" },
  });
  fireEvent.click(view.getByLabelText("Global"));
  fireEvent.submit(view.getByRole("button", { name: "Save variable set" }).closest("form")!);

  await waitFor(() => expect(view.getByText("Global defaults")).toBeTruthy());
  const createCall = fetchMock.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith("/organizations/acme/varsets") &&
      (init as RequestInit)?.method === "POST",
  );
  expect(createCall).toBeDefined();
  expect(JSON.parse((createCall![1] as RequestInit).body as string)).toEqual({
    data: {
      type: "varsets",
      attributes: {
        name: "Global defaults",
        description: "Organization defaults",
        global: true,
      },
    },
  });

  const globalRow = view.getByText("Global defaults").closest("tr")!;
  expect(within(globalRow).getByText("Global")).toBeTruthy();
  fireEvent.click(within(globalRow).getByRole("button", { name: "Edit" }));
  fireEvent.change(view.getByLabelText("Name"), {
    target: { value: "Environment defaults" },
  });
  fireEvent.click(view.getByLabelText("Global"));
  fireEvent.submit(view.getByRole("button", { name: "Save variable set" }).closest("form")!);

  await waitFor(() => expect(view.getByText("Environment defaults")).toBeTruthy());
  expect(
    within(view.getByText("Environment defaults").closest("tr")!).getByText("Selected"),
  ).toBeTruthy();
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

  await waitFor(() => expect(view.getByText("Shared credentials")).toBeTruthy());

  const sharedRow = view.getByText("Shared credentials").closest("tr")!;
  fireEvent.click(within(sharedRow).getByRole("button", { name: "Workspaces" }));
  fireEvent.click(view.getByLabelText("development"));
  fireEvent.click(view.getByLabelText("production"));
  fireEvent.submit(view.getByRole("button", { name: "Save workspaces" }).closest("form")!);

  await waitFor(() =>
    expect(view.queryByRole("heading", { name: "Manage workspaces" })).toBeNull(),
  );
  const attachmentCalls = fetchMock.mock.calls.filter(([url]) =>
    String(url).endsWith("/varsets/varset-shared/relationships/workspaces"),
  );
  expect(attachmentCalls).toHaveLength(2);
  const attachCall = attachmentCalls.find(([, init]) =>
    (init as RequestInit)?.method === "POST"
  );
  const detachCall = attachmentCalls.find(([, init]) =>
    (init as RequestInit)?.method === "DELETE"
  );
  expect(attachCall).toBeDefined();
  expect(detachCall).toBeDefined();
  expect(JSON.parse((attachCall![1] as RequestInit).body as string)).toEqual({
    data: [{ id: "ws-prod", type: "workspaces" }],
  });
  expect(JSON.parse((detachCall![1] as RequestInit).body as string)).toEqual({
    data: [{ id: "ws-dev", type: "workspaces" }],
  });
});

test("manages variable set variables (CRUD)", async () => {
  const { fetchMock } = createVarsetsFetchMock();
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/variable-sets"]}>
      <Routes>
        <Route path="/app/:orgName/variable-sets" element={<VariableSets />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor(() => expect(view.getByText("Shared credentials")).toBeTruthy());

  fireEvent.click(
    within(view.getByText("Shared credentials").closest("tr")!).getByRole("button", {
      name: "Variables",
    }),
  );
  await waitFor(() => expect(view.getByText("API_TOKEN")).toBeTruthy());
  expect(view.getByText("••••••••")).toBeTruthy();

  fireEvent.click(
    within(view.getByText("API_TOKEN").closest("tr")!).getByRole("button", { name: "Edit" }),
  );
  expect((view.getByLabelText("Value") as HTMLInputElement).value).toBe("");
  fireEvent.change(view.getByLabelText("Description"), {
    target: { value: "Rotated secret" },
  });
  fireEvent.submit(view.getByRole("button", { name: "Save variable" }).closest("form")!);
  await waitFor(() =>
    expect(view.getByRole("heading", { name: "Variables in Shared credentials" })).toBeTruthy(),
  );

  fireEvent.click(view.getByRole("button", { name: "Add variable" }));
  fireEvent.change(view.getByLabelText("Key"), { target: { value: "DATABASE_URL" } });
  fireEvent.change(view.getByLabelText("Value"), {
    target: { value: "postgres://database" },
  });
  fireEvent.change(view.getByLabelText("Description"), {
    target: { value: "Application database" },
  });
  fireEvent.submit(view.getByRole("button", { name: "Save variable" }).closest("form")!);
  await waitFor(() => expect(view.getByText("DATABASE_URL")).toBeTruthy());

  const createVariableCall = fetchMock.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith("/varsets/varset-shared/relationships/vars") &&
      (init as RequestInit)?.method === "POST",
  );
  expect(createVariableCall).toBeDefined();

  fireEvent.click(
    within(view.getByText("DATABASE_URL").closest("tr")!).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() => expect(view.queryByText("DATABASE_URL")).toBeNull());
  expect(fetchMock.mock.calls.some(
    ([url, init]) =>
      String(url).endsWith("/varsets/varset-shared/relationships/vars/var-database") &&
      (init as RequestInit)?.method === "DELETE",
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

  await waitFor(() => expect(view.getByText("Shared credentials")).toBeTruthy());

  const sharedRow = view.getByText("Shared credentials").closest("tr")!;
  fireEvent.click(within(sharedRow).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(view.queryByText("Shared credentials")).toBeNull());
  expect(fetchMock.mock.calls.some(
    ([url, init]) =>
      String(url).endsWith("/varsets/varset-shared") &&
      (init as RequestInit)?.method === "DELETE",
  )).toBeTrue();
});
