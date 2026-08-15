import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

import { Layout } from "../src/components/Layout";
import { WorkspaceDetail } from "../src/views/WorkspaceDetail";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

const json = (data: JsonValue): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

const getUrl = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.toString() : input.url;

afterEach((): void => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
});

test("only shows state and variable navigation for the current workspace permissions", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = getUrl(input);
    if (url === "/api/v2/account/details") {
      return json({ data: { attributes: { username: "alice" } } });
    }
    if (url === "/api/v2/organizations?page[size]=100") return json({ data: [] });
    if (url === "/api/v2/organizations/acme/workspaces/private") {
      return json({
        data: {
          attributes: {
            permissions: {
              "can-read-state-versions": false,
              "can-read-variable": false,
            },
          },
        },
      });
    }
    if (url === "/api/v2/organizations/acme/workspaces/shared") {
      return json({
        data: {
          attributes: {
            permissions: {
              "can-read-state-versions": true,
              "can-read-variable": true,
            },
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/private"]}>
      <Link to="/app/acme/workspaces/shared">Open shared workspace</Link>
      <Link to="/app/acme/workspaces/private">Open private workspace</Link>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName"
          element={<Layout><p>Workspace content</p></Layout>}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input]): boolean =>
      getUrl(input) === "/api/v2/organizations/acme/workspaces/private")).toBe(true);
  });
  expect(view.queryByRole("link", { name: "States" })).toBeNull();
  expect(view.queryByRole("link", { name: "Variables" })).toBeNull();

  fireEvent.click(view.getByRole("link", { name: "Open shared workspace" }));
  await waitFor((): void => {
    expect(view.getByRole("link", { name: "States" })).toBeTruthy();
    expect(view.getByRole("link", { name: "Variables" })).toBeTruthy();
  });

  fireEvent.click(view.getByRole("link", { name: "Open private workspace" }));
  await waitFor((): void => {
    expect(view.queryByRole("link", { name: "States" })).toBeNull();
    expect(view.queryByRole("link", { name: "Variables" })).toBeNull();
  });
});

test("does not mount state-derived workspace sections without read permissions", async () => {
  const requestedUrls: string[] = [];
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = getUrl(input);
    requestedUrls.push(url);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: {
            name: "production",
            permissions: {
              "can-read-state-versions": false,
              "can-read-variable": false,
            },
          },
        },
      });
    }
    if (url === "/api/v2/workspaces/ws-1/runs?page[size]=1") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  let view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName"
          element={<WorkspaceDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );
  await view.findByText("Workspace details");
  expect(view.queryByRole("button", { name: "states" })).toBeNull();
  expect(view.queryByRole("button", { name: "variables" })).toBeNull();
  view.unmount();

  view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/states"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/states"
          element={<WorkspaceDetail section="states" />}
        />
      </Routes>
    </MemoryRouter>,
  );
  await view.findByText("Workspace data access required");
  view.unmount();

  view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/variables"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/variables"
          element={<WorkspaceDetail section="variables" />}
        />
      </Routes>
    </MemoryRouter>,
  );
  await view.findByText("Workspace data access required");
  await act(async (): Promise<void> => {
    await new Promise<void>((resolve): void => { window.setTimeout(resolve, 0); });
  });

  expect(requestedUrls.some((url): boolean =>
    url.includes("/resources")
    || url.includes("/current-state-version")
    || url.includes("/state-versions")
    || url.includes("/vars"))).toBe(false);
});