import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AgentPools } from "../src/views/AgentPools";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

const json = (data: JsonValue): Response => new Response(JSON.stringify(data), {
  headers: { "Content-Type": "application/vnd.api+json" },
});

const urlOf = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.toString() : input.url;

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("explains pool capacity, scope, and worker health from server records", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { permissions: { "can-manage-agent-pools": true } } } });
    }
    if (url === "/api/v2/organizations/acme/agent-pools") {
      return json({
        data: [{
          id: "pool-1",
          type: "agent-pools",
          attributes: { name: "private-workers", organization: "acme", "organization-scoped": false, "agent-count": 3 },
          relationships: {
            "allowed-workspaces": { data: [{ id: "ws-1" }] },
            "allowed-projects": { data: [{ id: "project-1" }] },
            "excluded-workspaces": { data: [{ id: "ws-excluded" }] },
          },
        }],
      });
    }
    if (url === "/api/v2/agent-pools/pool-1/agents") {
      return json({
        data: [
          {
            id: "agent-tofu",
            type: "agents",
            attributes: {
              name: "linux-tofu",
              status: "idle",
              version: "1.3.0",
              architecture: "linux-amd64",
              "iac-binaries": ["tofu", "terraform"],
              "last-ping-at": "2026-09-06T11:59:30.000Z",
            },
          },
          {
            id: "agent-busy",
            type: "agents",
            attributes: {
              name: "linux-busy",
              status: "busy",
              version: "1.2.0",
              architecture: "linux-amd64",
              "iac-binaries": ["terraform"],
              "last-ping-at": "2026-09-06T11:59:00.000Z",
            },
          },
          {
            id: "agent-stale",
            type: "agents",
            attributes: {
              name: "offline-worker",
              status: "unknown",
              version: null,
              architecture: null,
              "iac-binaries": ["terraform"],
              "last-ping-at": "2026-09-06T11:00:00.000Z",
            },
          },
        ],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings/agents"]}>
      <Routes>
        <Route path="/app/:orgName/settings/agents" element={<AgentPools />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("2 usable")).toBeTruthy();
  });
  expect(view.getByText(/1 heartbeat stale/)).toBeTruthy();
  expect(view.getByText("1 workspace, 1 project · 1 excluded")).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: "Worker health" }));
  const dialog = await view.findByRole("dialog");
  expect(within(dialog).getByRole("heading", { name: "Worker health — private-workers" })).toBeTruthy();
  expect(within(dialog).getByText("linux-tofu")).toBeTruthy();
  expect(within(dialog).getByText("Heartbeat stale")).toBeTruthy();
  expect(within(dialog).getAllByText("linux-amd64")).toHaveLength(2);
  expect(within(dialog).getByText("tofu")).toBeTruthy();
  expect(within(dialog).getAllByText("terraform")).toHaveLength(3);
});
