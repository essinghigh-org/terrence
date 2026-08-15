import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { WorkspaceVariables } from "../src/components/WorkspaceVariables";

const originalFetch = globalThis.fetch;

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/vnd.api+json" },
});

const noContent = (): Response => new Response(null, { status: 204 });

const workspaceVar = (id: string, key: string, category: "terraform" | "env", sensitive = false): Record<string, unknown> => ({
  id,
  type: "vars",
  attributes: {
    key,
    value: sensitive ? null : "value-of-" + key,
    category,
    sensitive,
    hcl: false,
    description: null,
  },
});

const setVar = (id: string, key: string, category: "terraform" | "env", sensitive = false): Record<string, unknown> => ({
  id,
  type: "vars",
  attributes: {
    key,
    value: sensitive ? null : "set-" + key,
    category,
    sensitive,
    hcl: false,
    description: "from set",
  },
});

const variableSet = (id: string, name: string, options: { global?: boolean; description?: string | null; workspaceCount?: number; varCount?: number } = {}): Record<string, unknown> => ({
  id,
  type: "varsets",
  attributes: {
    name,
    description: options.description ?? null,
    global: options.global ?? false,
    priority: false,
    "parent-project-id": null,
    "var-count": options.varCount ?? 0,
    "workspace-count": options.workspaceCount ?? 1,
    "project-count": 0,
    "stack-count": 0,
  },
  relationships: {
    organization: { data: { id: "essighigh", type: "organizations" } },
    workspaces: { data: [{ id: "ws-1", type: "workspaces" }] },
    projects: { data: [] },
    stacks: { data: [] },
  },
});

afterEach((): void => {
  globalThis.fetch = originalFetch;
});

test("renders workspace variables and attached variable sets as separate sections", async () => {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url, "http://terrence.local").pathname;
    if (path === "/api/v2/workspaces/ws-1/vars") {
      return json({ data: [workspaceVar("wv-1", "LOCAL_KEY", "env")] });
    }
    if (path === "/api/v2/workspaces/ws-1/varsets") {
      return json({ data: [variableSet("vs-1", "github-provider", { workspaceCount: 2, varCount: 2 })] });
    }
    if (path === "/api/v2/varsets/vs-1/relationships/vars") {
      return json({ data: [setVar("sv-1", "GITHUB_TOKEN", "env", true), setVar("sv-2", "GITHUB_OWNER", "env")] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(<WorkspaceVariables workspaceId="ws-1" orgName="essighigh" canUpdate />);
  await waitFor((): void => { expect(view.getByText("LOCAL_KEY")).toBeTruthy(); });
  await waitFor((): void => { expect(view.getByText("github-provider")).toBeTruthy(); });
  await waitFor((): void => { expect(view.getByText("GITHUB_TOKEN")).toBeTruthy(); });

  // Inherited variables are read-only: exactly one Edit/Delete pair exists, for the
  // workspace-owned variable only.
  expect(view.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
  expect(view.getAllByRole("button", { name: "Delete" })).toHaveLength(1);
  // The set's sensitive variable is marked and its value is hidden.
  expect(view.getAllByText("Sensitive").length).toBeGreaterThanOrEqual(1);
  expect(view.getByText("Sensitive — write only")).toBeTruthy();
  // Set metadata: attached workspace count.
  expect(view.getByText(/2 workspaces/)).toBeTruthy();
});

test("attaches and detaches variable sets from the workspace", async () => {
  let attached = [variableSet("vs-1", "github-provider", { workspaceCount: 2, varCount: 2 })];
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url, "http://terrence.local").pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/v2/workspaces/ws-1/vars") return json({ data: [] });
    if (path === "/api/v2/workspaces/ws-1/varsets") {
      return json({ data: attached });
    }
    if (path === "/api/v2/varsets/vs-1/relationships/vars") {
      return json({ data: [setVar("sv-1", "GITHUB_TOKEN", "env", true)] });
    }
    if (path === "/api/v2/varsets/vs-2/relationships/vars") {
      return json({ data: [setVar("sv-3", "AWS_REGION", "env")] });
    }
    if (path === "/api/v2/organizations/essighigh/varsets") {
      return json({ data: [variableSet("vs-2", "aws-shared", { workspaceCount: 3, varCount: 1 })] });
    }
    if (path === "/api/v2/varsets/vs-2/relationships/workspaces" && method === "POST") {
      attached = [variableSet("vs-1", "github-provider", { workspaceCount: 2, varCount: 2 }), variableSet("vs-2", "aws-shared", { workspaceCount: 3, varCount: 1 })];
      return noContent();
    }
    if (path === "/api/v2/varsets/vs-1/relationships/workspaces" && method === "DELETE") {
      attached = [];
      return noContent();
    }
    throw new Error(`Unexpected request: ${url} (${method})`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(<WorkspaceVariables workspaceId="ws-1" orgName="essighigh" canUpdate />);
  await waitFor((): void => { expect(view.getByText("github-provider")).toBeTruthy(); });

  // Attach flow: the dialog lists unattached organization sets.
  fireEvent.click(view.getByRole("button", { name: "Attach variable set" }));
  await waitFor((): void => { expect(view.getByText("aws-shared")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Attach" }));
  await waitFor((): void => { expect(view.getByText("AWS_REGION")).toBeTruthy(); });

  const postCall = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
  expect(postCall).toBeTruthy();
  expect(JSON.parse(postCall?.[1]?.body as string)).toEqual({
    data: [{ type: "workspaces", id: "ws-1" }],
  });

  // Detach flow: the card button removes the set.
  fireEvent.click(view.getAllByRole("button", { name: "Detach" })[0]!);
  await waitFor((): void => { expect(view.queryByText("github-provider")).toBeNull(); });
  const deleteCall = fetchMock.mock.calls.find(([, options]) => options?.method === "DELETE");
  expect(deleteCall).toBeTruthy();
  expect(JSON.parse(deleteCall?.[1]?.body as string)).toEqual({
    data: [{ type: "workspaces", id: "ws-1" }],
  });
});
