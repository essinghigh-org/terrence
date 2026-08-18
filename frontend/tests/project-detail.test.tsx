import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ProjectDetail } from "../src/views/ProjectDetail";
import { Toaster } from "../src/components/ui/toast";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

function json(data: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/vnd.api+json" } });
}

function urlOf(input: string | URL | Request): string {
  return isString(input) ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const project = {
  id: "prj-1",
  attributes: {
    name: "Platform",
    description: null,
    permissions: { "can-update": true, "can-destroy": true },
  },
};

const baseFetchMock = (overrides: Readonly<Record<string, (init?: RequestInit) => Response>>) =>
  mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";
    const override = overrides[`${method} ${url}`];
    if (override !== undefined) return override(init);
    if (url === "/api/v2/projects/prj-1" && method === "GET") return json({ data: project });
    if (url.startsWith("/api/v2/organizations/acme/workspaces") && method === "GET") return json({ data: [] });
    if (url.startsWith("/api/v2/organizations/acme/runs") && method === "GET") return json({ data: [] });
    if (url.startsWith("/api/v2/organizations/acme/varsets") && method === "GET") return json({ data: [] });
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

function renderProject(section: "settings" | "variable-sets"): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/app/acme/projects/prj-1"]}>
      <Routes>
        <Route
          path="/app/:orgName/projects/:projectId"
          element={<ProjectDetail section={section} />}
        />
      </Routes>
      <Toaster />
    </MemoryRouter>,
  );
}

test("creates a project variable set from the project detail settings", async () => {
  let postedBody: unknown;
  const fetchMock = baseFetchMock({
    "POST /api/v2/organizations/acme/varsets": (init) => {
      postedBody = init?.body;
      return json({
        data: { id: "vs-1", attributes: { name: "Shared", description: "Shared values" } },
      }, 201);
    },
  });
  globalThis.fetch = fetchMock;

  const view = renderProject("variable-sets");

  const button = await view.findByRole("button", { name: "New variable set" });
  fireEvent.click(button);

  await view.findByRole("heading", { name: "Create a new project variable set" });

  fireEvent.input(view.getByLabelText("Name"), { target: { value: "Shared" } });
  fireEvent.input(view.getByLabelText("Description (Optional)"), { target: { value: "Shared values" } });

  const form = view.getByRole("button", { name: "Create variable set" }).closest("form");
  expect(form).not.toBeNull();
  // SAFETY: closest("form") above resolved the form element for the dialog.
  fireEvent.submit(form as HTMLFormElement);

await waitFor((): void => {
    expect(postedBody).toBeDefined();
  });
// SAFETY: the captured call argument is a stringified JSON body.
  const posted = JSON.parse(postedBody as string) as { data?: { attributes?: { name?: string; "parent-project-id"?: string } } };
  expect(posted.data?.attributes?.name).toBe("Shared");
  expect(posted.data?.attributes?.["parent-project-id"]).toBe("prj-1");
  await waitFor((): void => { expect(view.getByText("Shared")).toBeTruthy(); });
});

test("saves a project default execution mode and agent pool", async () => {
  let postedBody: string | undefined;
  const projectWithSettings = {
    ...project,
    attributes: {
      ...project.attributes,
      "default-execution-mode": "remote",
      "setting-overwrites": { "execution-mode": false },
    },
    relationships: { "default-agent-pool": { data: null } },
  };
  const fetchMock = baseFetchMock({
    "GET /api/v2/projects/prj-1": () => json({ data: projectWithSettings }),
    "GET /api/v2/organizations/acme/agent-pools": () => json({
      data: [{ id: "apool-build", attributes: { name: "Build pool" } }],
    }),
    "PATCH /api/v2/projects/prj-1": (init) => {
      // SAFETY: this component sends the PATCH body through JSON.stringify.
      postedBody = init?.body as string;
      return json({
        data: {
          ...projectWithSettings,
          attributes: {
            ...projectWithSettings.attributes,
            "default-execution-mode": "agent",
            "setting-overwrites": { "execution-mode": true },
          },
          relationships: { "default-agent-pool": { data: { id: "apool-build", type: "agent-pools" } } },
        },
      });
    },
  });
  globalThis.fetch = fetchMock;

  const view = renderProject("settings");
  const executionMode = await view.findByLabelText("Default execution mode");
  expect((executionMode as HTMLSelectElement).value).toBe("inherit");
  fireEvent.change(executionMode, { target: { value: "agent" } });
  await view.findByRole("option", { name: "Build pool" });
  fireEvent.change(view.getByLabelText("Default agent pool"), {
    target: { value: "apool-build" },
  });

  const form = view.getByRole("button", { name: "Save changes" }).closest("form");
  expect(form).not.toBeNull();
  // SAFETY: the form is present because the preceding role query found its submit button.
  fireEvent.submit(form as HTMLFormElement);

  await waitFor((): void => { expect(postedBody).toBeDefined(); });
  if (postedBody === undefined) throw new Error("Expected a serialized project PATCH body");
  // SAFETY: the request body is JSON.stringify'd by the component and has the JSON:API shape asserted below.
  const posted = JSON.parse(postedBody) as {
    data?: {
      attributes?: {
        "default-execution-mode"?: string;
        "setting-overwrites"?: { "execution-mode"?: boolean };
      };
      relationships?: { "default-agent-pool"?: { data?: { id?: string } | null } };
    };
  };
  expect(posted.data?.attributes?.["default-execution-mode"]).toBe("agent");
  expect(posted.data?.attributes?.["setting-overwrites"]?.["execution-mode"]).toBe(true);
  expect(posted.data?.relationships?.["default-agent-pool"]?.data?.id).toBe("apool-build");
});

test("preserves an inherited project execution mode when saving other settings", async () => {
  let postedBody: string | undefined;
  const inheritedProject = {
    ...project,
    attributes: {
      ...project.attributes,
      "default-execution-mode": "remote",
      "setting-overwrites": { "execution-mode": false },
    },
    relationships: { "default-agent-pool": { data: null } },
  };
  const fetchMock = baseFetchMock({
    "GET /api/v2/projects/prj-1": () => json({ data: inheritedProject }),
    "PATCH /api/v2/projects/prj-1": (init) => {
      postedBody = init?.body as string;
      return json({ data: inheritedProject });
    },
  });
  globalThis.fetch = fetchMock;

  const view = renderProject("settings");
  const executionMode = await view.findByLabelText("Default execution mode");
  expect((executionMode as HTMLSelectElement).value).toBe("inherit");

  const form = view.getByRole("button", { name: "Save changes" }).closest("form");
  expect(form).not.toBeNull();
  // SAFETY: the form is present because the preceding role query found its submit button.
  fireEvent.submit(form as HTMLFormElement);

  await waitFor((): void => { expect(postedBody).toBeDefined(); });
  if (postedBody === undefined) throw new Error("Expected a serialized project PATCH body");
  // SAFETY: the request body is JSON.stringify'd by the component and has the JSON:API shape asserted below.
  const posted = JSON.parse(postedBody) as {
    data?: {
      attributes?: { "setting-overwrites"?: { "execution-mode"?: boolean } };
      relationships?: Record<string, unknown>;
    };
  };
  expect(posted.data?.attributes?.["setting-overwrites"]?.["execution-mode"]).toBe(false);
  expect(posted.data?.relationships).toEqual({});
});

test("deletes a project from the project detail settings", async () => {
  let deleteCalled = false;
  const fetchMock = baseFetchMock({
    "DELETE /api/v2/projects/prj-1": (): Response => {
      deleteCalled = true;
      return new Response(null, { status: 204 });
    },
  });
  globalThis.fetch = fetchMock;

  const page = renderProject("settings");

  const deleteButtons = await page.findAllByRole("button", { name: "Delete project" });
  fireEvent.click(deleteButtons[0]);

  const confirmButtons = await page.findAllByRole("button", { name: "Delete project" });
  fireEvent.click(confirmButtons[confirmButtons.length - 1]);

  await page.findByText("Project deleted");
  expect(deleteCalled).toBe(true);
});