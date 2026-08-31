import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { Layout } from "../src/components/Layout";
import { WorkspaceDetail } from "../src/views/WorkspaceDetail";
import { isString } from "../src/lib/type-guards";
import { formatDateTime } from "../src/lib/utils";
import type { JsonObject, JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

const json = (data: JsonValue): Response =>
  new Response(JSON.stringify(data), {
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

function CurrentLocation(): React.JSX.Element {
  const location = useLocation();
  return (
    <output aria-label="Current location">
      {location.pathname}{location.search}{location.hash}
    </output>
  );
}

afterEach((): void => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
});

test("uses a persisted, route-aware workspace settings sidebar", async () => {
  const view = render(
    <MemoryRouter
      initialEntries={["/app/acme/workspaces/production/settings/general"]}
    >
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName"
          element={<Layout />}
        >
          <Route index element={<div>Overview content</div>} />
          <Route path="runs" element={<div>Runs content</div>} />
          <Route
            path="settings/general"
            element={<div>General settings content</div>}
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  expect(view.getByRole("link", { name: "Skip to main content" }).getAttribute("href"))
    .toBe("#main-content");
  expect(view.getByRole("link", { name: "General" }).getAttribute("aria-current"))
    .toBe("page");
  expect(view.getByRole("link", { name: "production" }).getAttribute("href"))
    .toBe("/app/acme/workspaces/production");
  expect(view.getByRole("link", { name: "Run Tasks" }).getAttribute("href"))
    .toBe("/app/acme/workspaces/production/settings/tasks");
  expect(view.getByRole("link", { name: "Destruction and deletion" }).getAttribute("href"))
    .toBe("/app/acme/workspaces/production/settings/delete");
  fireEvent.click(view.getByRole("button", { name: "Help and support" }));
  await waitFor((): void => {
    expect(view.getByRole("menuitem", { name: "Documentation" })).toBeTruthy();
    expect(view.getByRole("menuitem", { name: "Support" }).getAttribute("href"))
      .toBe("https://github.com/essinghigh-org/terrence/issues");
    expect(view.getByRole("menuitem", { name: "Support" }).getAttribute("target"))
      .toBe("_blank");
    expect(view.queryByRole("menuitem", { name: "Tutorials" })).toBeNull();
    expect(view.queryByRole("menuitem", { name: "Status" })).toBeNull();
  });

  const collapse = view.getByRole("button", { name: "Collapse sidebar" });
  expect(collapse.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(collapse);
  expect(localStorage.getItem("terrence-sidebar-collapsed")).toBe("true");
  expect(view.getByRole("button", { name: "Expand sidebar" }).getAttribute("aria-expanded"))
    .toBe("false");

  fireEvent.click(view.getByRole("link", { name: "production" }));
  await waitFor((): void => {
    expect(view.getByText("Overview content")).toBeTruthy();
  });
  expect(view.getByRole("link", { name: "Overview" }).getAttribute("aria-current"))
    .toBe("page");
});

test("ignores an aborted workspace response after the route changes", async () => {
  const production = deferred<Response>();
  const staging = deferred<Response>();
  let productionSignal: AbortSignal | null = null;
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = isString(input)
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      productionSignal = init?.signal ?? null;
      return production.promise;
    }
    if (url === "/api/v2/organizations/acme/workspaces/staging") return staging.promise;
    if (url === "/api/v2/workspaces/ws-staging/runs?page[size]=1") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
      <Link to="/app/acme/workspaces/staging">Open staging</Link>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName"
          element={<WorkspaceDetail section="overview" />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(productionSignal).not.toBeNull(); });
  fireEvent.click(view.getByRole("link", { name: "Open staging" }));
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input]): boolean =>
      (isString(input) ? input : input instanceof URL ? input.toString() : input.url)
        === "/api/v2/organizations/acme/workspaces/staging")).toBe(true);
  });
  await act(async (): Promise<void> => {
    staging.resolve(json({ data: { id: "ws-staging", attributes: { name: "staging" } } }));
  });
  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "staging" })).toBeTruthy();
  });
  expect(productionSignal?.aborted).toBe(true);

  await act(async (): Promise<void> => {
    production.resolve(json({ data: { id: "ws-production", attributes: { name: "production" } } }));
    await new Promise<void>((resolve): void => { window.setTimeout(resolve, 0); });
  });
  expect(view.getByRole("heading", { name: "staging" })).toBeTruthy();
  expect(view.queryByRole("heading", { name: "production" })).toBeNull();
});

test("renders before the latest run finishes and ignores an aborted run response", async () => {
  const createdAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const productionRun = deferred<Response>();
  const stagingRun = deferred<Response>();
  let productionRunSignal: AbortSignal | null = null;
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = isString(input)
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({ data: { id: "ws-production", attributes: { name: "production" } } });
    }
    if (url === "/api/v2/organizations/acme/workspaces/staging") {
      return json({ data: { id: "ws-staging", attributes: { name: "staging" } } });
    }
    if (url === "/api/v2/workspaces/ws-production/runs?page[size]=1") {
      productionRunSignal = init?.signal ?? null;
      return productionRun.promise;
    }
    if (url === "/api/v2/workspaces/ws-staging/runs?page[size]=1") return stagingRun.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
      <Link to="/app/acme/workspaces/staging">Open staging</Link>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName"
          element={<WorkspaceDetail section="overview" />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "production" })).toBeTruthy();
    expect(productionRunSignal).not.toBeNull();
  });
  expect(view.getByText("Loading run history…")).toBeTruthy();
  expect(view.getByRole("link", { name: "View runs" }).getAttribute("href"))
    .toBe("/app/acme/workspaces/production/runs");

  fireEvent.click(view.getByRole("link", { name: "Open staging" }));
  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "staging" })).toBeTruthy();
  });
  expect(productionRunSignal?.aborted).toBe(true);

  await act(async (): Promise<void> => {
    stagingRun.resolve(json({
      data: [{
        id: "run-staging",
        attributes: { status: "planned_and_finished", "created-at": createdAt },
      }],
    }));
  });
  await waitFor((): void => {
    expect(view.getByRole("link", { name: "Latest run: Planned and finished" })).toBeTruthy();
  });
  const latestRunTime = view.getByText("5 minutes ago");
  expect(latestRunTime.getAttribute("dateTime")).toBe(createdAt);
  expect(latestRunTime.getAttribute("title")).toBe(formatDateTime(createdAt));

  await act(async (): Promise<void> => {
    productionRun.resolve(json({
      data: [{ id: "run-production", attributes: { status: "applied" } }],
    }));
    await new Promise<void>((resolve): void => { window.setTimeout(resolve, 0); });
  });
  expect(view.getByRole("link", { name: "Latest run: Planned and finished" })).toBeTruthy();
  expect(view.queryByRole("link", { name: "Latest run: applied" })).toBeNull();
});

test("blocks update-only settings when can-update is false", async () => {
  const requestedUrls: string[] = [];
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = isString(input)
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    requestedUrls.push(url);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: {
            name: "production",
            permissions: { "can-update": false },
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const settings = [
    { section: "notifications", control: "Add notification" },
    { section: "run-triggers", control: "Add trigger" },
    { section: "ssh-key", control: "Save assignment" },
    { section: "team-access", control: "Add team" },
  ] as const;
  for (const setting of settings) {
    const view = render(
      <MemoryRouter initialEntries={[`/app/acme/workspaces/production/settings/${setting.section}`]}>
        <Routes>
          <Route
            path="/app/:orgName/workspaces/:workspaceName/settings/:setting"
            element={<WorkspaceDetail section={setting.section} />}
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor((): void => {
      expect(view.getByText("Workspace administrator access required")).toBeTruthy();
    });
    expect(view.queryByRole("button", { name: setting.control })).toBeNull();
    view.unmount();
  }

  expect(requestedUrls).toEqual(
    settings.map((): string => "/api/v2/organizations/acme/workspaces/production"),
  );
});

test("fails closed when update permission is missing from readable settings", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = isString(input)
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: { name: "production", permissions: {} },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  for (const setting of [
    { section: "health", control: "Save health settings" },
    { section: "vcs", control: "Connect repository" },
  ] as const) {
    const view = render(
      <MemoryRouter initialEntries={[`/app/acme/workspaces/production/settings/${setting.section}`]}>
        <Routes>
          <Route
            path="/app/:orgName/workspaces/:workspaceName/settings/:setting"
            element={<WorkspaceDetail section={setting.section} />}
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor((): void => {
      expect(view.getByRole("button", { name: setting.control }).disabled)
        .toBe(true);
    });
    view.unmount();
  }
});

test("keeps workspace variables readable without mutation permission", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = isString(input)
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: {
            name: "production",
            permissions: {
              "can-read-variable": true,
              "can-update-variable": false,
            },
          },
        },
      });
    }
    if (url === "/api/v2/workspaces/ws-1/vars?page[size]=100") {
      return json({
        data: [{
          id: "var-1",
          attributes: {
            key: "region",
            value: "eu-west-2",
            category: "env",
            sensitive: false,
            hcl: false,
            description: "Deployment region",
          },
        }],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/variables"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/variables"
          element={<WorkspaceDetail section="variables" />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("region")).toBeTruthy(); });
  expect(view.getByText("You can view variables, but you do not have permission to change them.")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Add variable" })).toBeNull();
  expect(view.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(view.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(view.queryByRole("columnheader", { name: "Actions" })).toBeNull();
});

test("keeps the current settings route in sync after renaming a workspace", async () => {
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = isString(input)
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const workspace = {
      id: "ws-1",
      attributes: {
        name: url.endsWith("/renamed") ? "renamed" : "production",
        permissions: { "can-update": true },
      },
    };
    if (
      url === "/api/v2/organizations/acme/workspaces/production"
      || url === "/api/v2/organizations/acme/workspaces/renamed"
    ) {
      return json({ data: workspace });
    }
    if (url === "/api/v2/workspaces/ws-1" && init?.method === "PATCH") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      const body = JSON.parse(init.body as string) as {
        data: { attributes: JsonObject };
      };
      return json({
        data: {
          ...workspace,
          attributes: { ...workspace.attributes, ...body.data.attributes },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/settings/general?from=test#advanced"]}>
      <CurrentLocation />
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/settings/general"
          element={<WorkspaceDetail section="settings" />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("General settings")).toBeTruthy(); });
  fireEvent.input(view.getByLabelText("Name"), { target: { value: "renamed" } });
  await act(async (): Promise<void> => {
    const form = view.getByRole("button", { name: "Save settings" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input]): boolean =>
      (isString(input) ? input : input instanceof URL ? input.toString() : input.url)
        === "/api/v2/organizations/acme/workspaces/renamed")).toBe(true);
  });
  expect(view.getByRole("link", { name: "renamed" }).getAttribute("href"))
    .toBe("/app/acme/workspaces/renamed");
  expect(view.getByLabelText("Current location").textContent)
    .toBe("/app/acme/workspaces/renamed/settings/general?from=test#advanced");
});

test("renders controlled workspace sections with current resources and project context", async () => {
  const project = deferred<Response>();
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = isString(input)
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: {
            name: "production",
            locked: false,
            "terraform-version": "1.9.3",
            "vcs-repo": {
              identifier: "acme/infrastructure",
              "github-app-installation-id": "ghain-1",
            },
            "working-directory": "modules/network",
            "iac-binary": "tofu",
            permissions: {
              "can-queue-run": true,
              "can-read-state-versions": true,
            },
          },
          relationships: {
            project: { data: { id: "prj-1", type: "projects" } },
          },
        },
      });
    }
    if (url === "/api/v2/workspaces/ws-1/runs?page[size]=1") {
      return json({
        data: [{
          id: "run-1",
          attributes: {
            status: "planned_and_finished",
          },
        }],
      });
    }
    if (url === "/api/v2/projects/prj-1") {
      return project.promise;
    }
    if (url.startsWith("/api/v2/workspaces/ws-1/resources?")) {
      return json({
        data: [{
          id: "resource-1",
          attributes: {
            address: "aws_instance.web",
            provider: "aws",
            "provider-type": "aws_instance",
          },
        }],
      });
    }
    if (url === "/api/v2/workspaces/ws-1/current-state-version-outputs") {
      return json({ data: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName"
          element={<WorkspaceDetail section="overview" />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("Workspace details")).toBeTruthy();
  });
  expect(view.queryByRole("navigation", { name: "Workspace sections" })).toBeNull();
  expect(view.getByRole("link", { name: "Workspaces" }).getAttribute("href"))
    .toBe("/app/acme/workspaces");
  expect(view.getByRole("link", { name: "New run" }).getAttribute("href"))
    .toBe("/app/acme/workspaces/production/runs?new-run=true");
  expect(view.getByRole("link", { name: "Open GitHub repository acme/infrastructure" }).getAttribute("href"))
    .toBe("https://github.com/acme/infrastructure");
  expect(view.getByText("modules/network")).toBeTruthy();
  expect(view.getByText("OpenTofu")).toBeTruthy();
  expect(view.getByText("Loading project…")).toBeTruthy();
  await act(async (): Promise<void> => {
    project.resolve(json({ data: { id: "prj-1", attributes: { name: "Platform foundation" } } }));
  });
  await waitFor((): void => {
    expect(view.getByText("aws_instance.web")).toBeTruthy();
    expect(view.getByRole("link", { name: "Platform foundation" }).getAttribute("href"))
      .toBe("/app/acme/projects/prj-1");
  });
});

test("passes workspace run-task permission into the routed settings section", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = isString(input)
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: {
            name: "production",
            permissions: { "can-manage-run-tasks": true },
          },
        },
      });
    }
    if (url === "/api/v2/workspaces/ws-1/runs?page[size]=1") return json({ data: [] });
    if (url === "/api/v2/organizations/acme/run-tasks") return json({ data: [] });
    if (url === "/api/v2/workspaces/ws-1/run-tasks") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/settings/tasks"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/settings/tasks"
          element={<WorkspaceDetail section="run-tasks" />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("button", { name: "Attach run task" })).toBeTruthy();
  });
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input]): boolean =>
      (isString(input) ? input : input instanceof URL ? input.toString() : input.url)
        === "/api/v2/organizations/acme/run-tasks")).toBe(true);
  });
});

test("returns to the organization workspace list after deleting a workspace", async () => {
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = isString(input)
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: {
            name: "production",
            permissions: { "can-force-delete": true },
          },
        },
      });
    }
    if (url === "/api/v2/workspaces/ws-1/runs?page[size]=1") return json({ data: [] });
    if (url === "/api/v2/workspaces/ws-1" && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/settings/delete"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/settings/delete"
          element={<WorkspaceDetail section="destruction" />}
        />
        <Route path="/app/:orgName/workspaces" element={<p>Organization workspaces</p>} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("button", { name: "Delete workspace" })).toBeTruthy();
  });
  fireEvent.click(view.getByRole("button", { name: "Delete workspace" }));
  fireEvent.input(view.getByLabelText("Workspace name"), { target: { value: "production" } });
  await act(async (): Promise<void> => {
    fireEvent.click(view.getByRole("button", { name: "Delete workspace permanently" }));
  });

  await waitFor((): void => {
    expect(view.getByText("Organization workspaces")).toBeTruthy();
  });
  expect(fetchMock.mock.calls.some(([input, init]): boolean =>
    (isString(input) ? input : input instanceof URL ? input.toString() : input.url)
      === "/api/v2/workspaces/ws-1"
    && init?.method === "DELETE")).toBe(true);
});

test("project settings sidebar marks exactly one section active", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = isString(input)
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url === "/api/v2/account/details") {
      return json({ data: { attributes: { username: "alice" } } });
    }
    if (url === "/api/v2/projects/prj-1") {
      return json({ data: { id: "prj-1", attributes: { name: "Default Project" } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/projects/prj-1/settings"]}>
      <Routes>
        <Route path="/app" element={<Layout />}>
          <Route path=":orgName/projects/:projectId/settings" element={<p>Project settings</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("Project settings")).toBeTruthy();
  });
  const general = view.getByRole("link", { name: "General" });
  const variableSets = view.getByRole("link", { name: "Variable sets" });
  expect(general.getAttribute("aria-current")).toBe("page");
  expect(variableSets.getAttribute("aria-current")).toBeNull();
});

test("project settings variable sets section marks only variable sets active", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = isString(input)
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url === "/api/v2/account/details") {
      return json({ data: { attributes: { username: "alice" } } });
    }
    if (url === "/api/v2/projects/prj-1") {
      return json({ data: { id: "prj-1", attributes: { name: "Default Project" } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/projects/prj-1/settings/variable-sets"]}>
      <Routes>
        <Route path="/app" element={<Layout />}>
          <Route path=":orgName/projects/:projectId/settings/variable-sets" element={<p>Variable sets content</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("Variable sets content")).toBeTruthy();
  });
  const general = view.getByRole("link", { name: "General" });
  const variableSets = view.getByRole("link", { name: "Variable sets" });
  expect(general.getAttribute("aria-current")).toBeNull();
  expect(variableSets.getAttribute("aria-current")).toBe("page");
});

test("confirms workspace locking and unlocking before sending mutations", async () => {
  let locked = false;
  let reason: string | null = null;
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = getUrl(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: {
            name: "production",
            locked,
            "locked-reason": reason,
            permissions: { "can-lock": true, "can-unlock": true },
          },
        },
      });
    }
    if (url === "/api/v2/workspaces/ws-1/runs?page[size]=1") return json({ data: [] });
    if (url === "/api/v2/workspaces/ws-1/actions/lock" && init?.method === "POST") {
      locked = true;
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      reason = JSON.parse(init.body as string).reason as string;
      return json({ data: { id: "ws-1", attributes: { name: "production", locked: true } } });
    }
    if (url === "/api/v2/workspaces/ws-1/actions/unlock" && init?.method === "POST") {
      locked = false;
      reason = null;
      return json({ data: { id: "ws-1", attributes: { name: "production", locked: false } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

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
  fireEvent.click(view.getByRole("button", { name: "Lock" }));
  expect(fetchMock.mock.calls.some(([input, init]): boolean =>
    getUrl(input) === "/api/v2/workspaces/ws-1/actions/lock" && init?.method === "POST")).toBe(false);
  fireEvent.input(view.getByLabelText("Reason (Optional)"), { target: { value: "Maintenance" } });
  fireEvent.click(view.getByRole("button", { name: "Lock workspace" }));
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      getUrl(input) === "/api/v2/workspaces/ws-1/actions/lock" && init?.method === "POST")).toBe(true);
  });
  const lockCall = fetchMock.mock.calls.find(([input, init]): boolean =>
    getUrl(input) === "/api/v2/workspaces/ws-1/actions/lock" && init?.method === "POST");
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
  expect(JSON.parse(lockCall?.[1]?.body as string).reason).toBe("Maintenance");

  await waitFor((): void => { expect(view.getByText("Locked")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Unlock" }));
  expect(view.getByRole("heading", { name: "Unlock workspace production" })).toBeTruthy();
  expect(view.getByText(/cannot be undone/)).toBeTruthy();
  expect(fetchMock.mock.calls.some(([input, init]): boolean =>
    getUrl(input) === "/api/v2/workspaces/ws-1/actions/unlock" && init?.method === "POST")).toBe(false);
  fireEvent.click(view.getByRole("button", { name: "Yes, unlock workspace" }));
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      getUrl(input) === "/api/v2/workspaces/ws-1/actions/unlock" && init?.method === "POST")).toBe(true);
  });
});
