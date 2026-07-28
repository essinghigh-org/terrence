import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { NoCodeProvisioning } from "../src/views/NoCodeProvisioning";

const originalFetch = globalThis.fetch;
const originalAlert = globalThis.alert;
const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.alert = originalAlert;
});

function getUrl(input: unknown): string {
  if (typeof input === "string") return input;
  return input !== null && typeof input === "object" && "url" in input && typeof input.url === "string"
    ? input.url
    : "";
}

function changeInput(element: HTMLElement, value: string): void {
  const tracker = Reflect.get(element, "_valueTracker") as { setValue: (next: string) => void } | undefined;
  tracker?.setValue(value === "" ? "x" : "");
  Reflect.set(element, "value", value);
  fireEvent.input(element, { target: { value } });
  fireEvent.change(element, { target: { value } });
}

test("provisions an enabled no-code module and queues its initial run", async () => {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = getUrl(input);
    if (url === "/api/v2/organizations/acme/no-code-modules") {
      return json({
        data: [
          {
            id: "nocode-1",
            attributes: { enabled: true, "version-pin": "1.4.0" },
            relationships: {
              "registry-module": { data: { id: "mod-1" } },
              "variable-options": { data: [] },
            },
          },
          {
            id: "nocode-disabled",
            attributes: { enabled: false, "version-pin": "1.0.0" },
            relationships: { "registry-module": { data: { id: "mod-disabled" } } },
          },
        ],
      });
    }
    if (url === "/api/v2/organizations/acme/registry-modules") {
      return json({
        data: [
          { id: "mod-1", attributes: { name: "network", namespace: "acme", provider: "aws" } },
          { id: "mod-disabled", attributes: { name: "legacy", namespace: "acme", provider: "aws" } },
        ],
      });
    }
    if (url === "/api/v2/organizations/acme/projects") {
      return json({ data: [{ id: "prj-1", attributes: { name: "Platform" } }] });
    }
    if (url === "/api/v2/no-code-modules/nocode-1/input-variables") {
      return json({
        data: [
          {
            id: "nocode-1:region",
            attributes: {
              name: "region",
              type: "string",
              description: "AWS deployment region",
              required: true,
              "has-default": false,
              sensitive: false,
              nullable: true,
              options: ["eu-west-1", "us-east-1"],
            },
          },
          {
            id: "nocode-1:replicas",
            attributes: {
              name: "replicas",
              type: "number",
              description: null,
              required: false,
              "has-default": true,
              default: 2,
              sensitive: false,
              nullable: true,
              options: [],
            },
          },
          {
            id: "nocode-1:enable_monitoring",
            attributes: {
              name: "enable_monitoring",
              type: "bool",
              description: null,
              required: false,
              "has-default": true,
              default: true,
              sensitive: false,
              nullable: true,
              options: [],
            },
          },
        ],
      });
    }
    if (url === "/api/v2/no-code-modules/nocode-1/workspaces" && init?.method === "POST") {
      return json({ data: { id: "ws-1", attributes: { name: "edge-network" } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/no-code"]}>
      <Routes>
        <Route path="/app/:orgName/no-code" element={<NoCodeProvisioning />} />
        <Route path="/app/:orgName/workspaces/:workspaceName" element={<div>Workspace created</div>} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("option", { name: "acme/network/aws" })).toBeTruthy();
    expect(view.getByLabelText("region *")).toBeTruthy();
  });
  expect(view.queryByRole("option", { name: "acme/legacy/aws" })).toBeNull();

  changeInput(view.getByLabelText("Workspace name"), "edge-network");
  changeInput(view.getByLabelText("Description"), "Shared edge networking");
  fireEvent.change(view.getByLabelText("Project"), { target: { value: "prj-1" } });
  fireEvent.change(view.getByLabelText("region *"), { target: { value: "eu-west-1" } });

  await act(async () => {
    const form = view.getByRole("button", { name: "Create workspace" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });

  await waitFor((): void => {
    expect(view.getByText("Workspace created")).toBeTruthy();
  });

  const workspaceCall = fetchMock.mock.calls.find(([input, init]): boolean =>
    getUrl(input) === "/api/v2/no-code-modules/nocode-1/workspaces" && init?.method === "POST",
  );
  if (workspaceCall === undefined) throw new Error("Expected workspace creation request");
  expect(JSON.parse(workspaceCall[1]!.body as string)).toEqual({
    data: {
      type: "workspaces",
      attributes: {
        name: "edge-network",
        description: "Shared edge networking",
        auto_apply: true,
      },
      relationships: {
        project: { data: { id: "prj-1", type: "projects" } },
        vars: {
          data: [
            {
              type: "vars",
              attributes: {
                key: "region",
                value: "eu-west-1",
                category: "terraform",
                hcl: false,
                sensitive: false,
                description: "AWS deployment region",
              },
            },
            {
              type: "vars",
              attributes: {
                key: "replicas",
                value: "2",
                category: "terraform",
                hcl: true,
                sensitive: false,
                description: null,
              },
            },
            {
              type: "vars",
              attributes: {
                key: "enable_monitoring",
                value: "true",
                category: "terraform",
                hcl: true,
                sensitive: false,
                description: null,
              },
            },
          ],
        },
      },
    },
  });
});

test("explains when the organization has no enabled no-code modules", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = getUrl(input);
    if (url.endsWith("/no-code-modules")) return json({ data: [] });
    if (url.endsWith("/registry-modules")) return json({ data: [] });
    if (url.endsWith("/projects")) return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/no-code"]}>
      <Routes>
        <Route path="/app/:orgName/no-code" element={<NoCodeProvisioning />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("No no-code modules are enabled.")).toBeTruthy();
  });
  expect(view.getByRole("button", { name: "Create workspace" }).hasAttribute("disabled")).toBeTrue();
});
