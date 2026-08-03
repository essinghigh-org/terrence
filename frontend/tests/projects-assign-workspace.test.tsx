import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { Projects } from "../src/views/Projects";

const originalFetch = globalThis.fetch;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/vnd.api+json" } });
}

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("assigns a workspace to another project via the workspace assignment dialog", async () => {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";
    if (url === "/api/v2/organizations/acme/projects" && method === "GET") {
      return json({
        data: [
          { id: "prj-1", attributes: { name: "Default" } },
          { id: "prj-2", attributes: { name: "Platform" } },
        ],
      });
    }
    if (url === "/api/v2/organizations/acme/workspaces?page%5Bsize%5D=100" && method === "GET") {
      return json({
        data: [{
          id: "ws-1",
          attributes: { name: "production" },
          relationships: { project: { data: { id: "prj-1", type: "projects" } } },
        }],
      });
    }
    if (url === "/api/v2/organizations/acme" && method === "GET") {
      return json({
        data: { attributes: { permissions: { "can-manage-projects": true } } },
      });
    }
    if (url === "/api/v2/workspaces/ws-1" && method === "PATCH") {
      const body = JSON.parse(init?.body as string) as {
        data?: { relationships?: { project?: { data?: { id?: string } } } };
      };
      expect(body.data?.relationships?.project?.data?.id).toBe("prj-2");
      return json({
        data: { id: "ws-1", attributes: { name: "production" } },
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/projects"]}>
      <Routes>
        <Route path="/app/:orgName/projects" element={<Projects />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Platform")).toBeTruthy(); });

  fireEvent.click(view.getByRole("button", { name: "Assign workspaces" }));
  await waitFor((): void => {
    expect(view.getByLabelText("Project for production")).toBeTruthy();
  });

  fireEvent.change(view.getByLabelText("Project for production"), { target: { value: "prj-2" } });

  await waitFor((): void => {
    const patchCall = fetchMock.mock.calls.find(([callUrl, callInit]): boolean =>
      urlOf(callUrl as string | URL | Request) === "/api/v2/workspaces/ws-1" && callInit?.method === "PATCH");
    expect(patchCall).toBeTruthy();
  });
});

test("does not allow workspace assignment without manage-project permission", async () => {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme/projects") {
      return json({ data: [{ id: "prj-1", attributes: { name: "Default" } }] });
    }
    if (url === "/api/v2/organizations/acme/workspaces?page%5Bsize%5D=100") {
      return json({ data: [{ id: "ws-1", attributes: { name: "production" } }] });
    }
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { permissions: { "can-manage-projects": false } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/projects"]}>
      <Routes>
        <Route path="/app/:orgName/projects" element={<Projects />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Default")).toBeTruthy(); });
  expect(view.queryByRole("button", { name: "Assign workspaces" })).toBeNull();
  expect(fetchMock.mock.calls.some(([callUrl]): boolean =>
    urlOf(callUrl as string | URL | Request) === "/api/v2/workspaces/ws-1")).toBeFalse();
});