import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AgentPools } from "../src/views/AgentPools";

const originalFetch = globalThis.fetch;

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("fails closed on the direct agent-pools route without management permission", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/v2/organizations/acme") {
      return new Response(JSON.stringify({
        data: { attributes: { permissions: { "can-manage-agent-pools": false } } },
      }), { headers: { "Content-Type": "application/vnd.api+json" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings/agents"]}>
      <Routes>
        <Route path="/app/:orgName/settings/agents" element={<AgentPools />} />
      </Routes>
    </MemoryRouter>,
  );

  await view.findByText("Agent pool access is unavailable.");
  expect(view.getByText("You do not have permission to manage agent pools for this organization.")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Create Agent Pool" })).toBeNull();
  expect(fetchMock.mock.calls.every(([input]): boolean => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return !url.endsWith("/agent-pools");
  })).toBeTrue();
});
