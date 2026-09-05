import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { CreateWorkspaceModal } from "../src/components/CreateWorkspaceModal";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";
import { MemoryRouter } from "react-router-dom";

const originalFetch = globalThis.fetch;

const json = (data: JsonValue, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });

const getUrl = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.toString() : input.url;

type PoolsScenario = "empty" | "error" | "list";

function installFetch(scenario: PoolsScenario, posted: unknown[]): void {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = getUrl(input);
    const method = init?.method ?? "GET";
    if (url.includes("/available-versions")) return json({ data: [] });
    if (url.includes("/agent-pools")) {
      if (scenario === "error") {
        return json({ errors: [{ status: "404", title: "Not Found", detail: "nope" }] }, 404);
      }
      if (scenario === "list") {
        return json({ data: [{ id: "pool-1", type: "agent-pools", attributes: { name: "pool-1" } }] });
      }
      return json({ data: [] });
    }
    if (url.endsWith("/workspaces") && method === "POST") {
      const rawBody = init?.body;
      posted.push(JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as unknown);
      return json({ data: { id: "ws-new", type: "workspaces" } });
    }
    return json({ data: [] }, 404);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;
}

afterEach((): void => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
});

function renderModal(): ReturnType<typeof render> {
  // The modal links to organization settings from its dead-end states (no VCS
  // connections, no agent pools), so it needs a router in scope.
  return render(
    <MemoryRouter>
      <CreateWorkspaceModal
        orgName="acme"
        open={true}
        onOpenChange={(): void => { /* assertions read fetch traffic, not the callback */ }}
        onCreated={(): void => { /* assertions read fetch traffic, not the callback */ }}
      />
    </MemoryRouter>,
  );
}

const modeSelect = (view: ReturnType<typeof render>): HTMLElement =>
  view.getByLabelText("Execution mode") as unknown as HTMLElement;

// Issue #598: the creation modal offers engine and version but no execution
// mode, and picking agent with no pool attached flips runs to unreachable
// with only a log line.
test("inherits project execution settings by default", async () => {
  const posted: unknown[] = [];
  installFetch("empty", posted);
  const view = renderModal();
  fireEvent.input(view.getByLabelText("Workspace name"), { target: { value: "infra" } });
  fireEvent.click(view.getByRole("button", { name: "Create Workspace" }));
  await waitFor((): void => { expect(posted).toHaveLength(1); });
  const body = posted[0] as { data: { attributes: Record<string, unknown> } };
  expect(body.data.attributes["execution-mode"]).toBeUndefined();
  expect(body.data.attributes["agent-pool-id"]).toBeUndefined();
});

test("warns when agent is selected with no pools available", async () => {
  installFetch("empty", []);
  const view = renderModal();
  fireEvent.change(modeSelect(view), { target: { value: "agent" } });
  await view.findByText(/No agent pools are available/);
});

test("requires an agent pool before submitting agent execution", async () => {
  const posted: unknown[] = [];
  installFetch("empty", posted);
  const view = renderModal();
  fireEvent.change(modeSelect(view), { target: { value: "agent" } });
  await view.findByText(/No agent pools are available/);
  fireEvent.input(view.getByLabelText("Workspace name"), { target: { value: "infra" } });
  fireEvent.click(view.getByRole("button", { name: "Create Workspace" }));
  await view.findByText("Choose an agent pool before creating the workspace.");
  expect(posted).toHaveLength(0);
});

test("surfaces agent-pool load failures instead of staying silent", async () => {
  installFetch("error", []);
  const view = renderModal();
  fireEvent.change(modeSelect(view), { target: { value: "agent" } });
  await view.findByText("Agent pools are unavailable. Ask an organization administrator for agent-pool access.");
});

test("stays quiet about pools when they exist", async () => {
  installFetch("list", []);
  const view = renderModal();
  fireEvent.change(modeSelect(view), { target: { value: "agent" } });
  await view.findByText("Runs wait for an agent pool to pick them up.");
  expect(view.queryByText(/No agent pools are available/)).toBeNull();
});

test("submits the selected agent pool", async () => {
  const posted: unknown[] = [];
  installFetch("list", posted);
  const view = renderModal();
  fireEvent.change(modeSelect(view), { target: { value: "agent" } });
  fireEvent.change(await view.findByLabelText("Agent pool"), { target: { value: "pool-1" } });
  fireEvent.input(view.getByLabelText("Workspace name"), { target: { value: "infra" } });
  fireEvent.click(view.getByRole("button", { name: "Create Workspace" }));
  await waitFor((): void => { expect(posted).toHaveLength(1); });
  const body = posted[0] as { data: { attributes: Record<string, unknown> } };
  expect(body.data.attributes["execution-mode"]).toBe("agent");
  expect(body.data.attributes["agent-pool-id"]).toBe("pool-1");
});
