import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { CompatibilityDashboard } from "../src/views/CompatibilityDashboard";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;
const json = (data: JsonValue, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/vnd.api+json" } });
const urlOf = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.toString() : input.url;

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("renders the provider surface catalog with counts and filters", async () => {
  const surface = {
    provider: "hashicorp/tfe v0.79.0",
    resource_count: 2,
    data_source_count: 1,
    resources_covered: 1,
    data_sources_covered: 1,
    resources: [
      { name: "tfe_agent_pool", status: "covered" },
      { name: "tfe_admin_organization_settings", status: "admin" },
    ],
    data_sources: [
      { name: "tfe_workspace", status: "covered" },
    ],
  };
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/admin/provider-surface") return json({ data: surface });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/admin/compatibility"]}>
      <Routes>
        <Route path="/app/admin/compatibility" element={<CompatibilityDashboard />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("tfe_agent_pool")).toBeTruthy();
  });
  expect(view.getByText(/hashicorp\/tfe v0\.79\.0/)).toBeTruthy();
  expect(view.getAllByText("Covered").length).toBeGreaterThanOrEqual(1);
  expect(view.getAllByText("Admin only").length).toBeGreaterThanOrEqual(1);
  expect(view.getByText("tfe_workspace")).toBeTruthy();
  // Counts cards.
  expect(view.getByText("2", { selector: ".text-2xl" })).toBeTruthy();
  expect(view.getAllByText("1", { selector: ".text-2xl" }).length).toBeGreaterThanOrEqual(1);

  // Status filter narrows rows.
  fireEvent.change(view.getByLabelText("Status filter"), { target: { value: "admin" } });
  await waitFor((): void => {
    expect(view.getByText("tfe_admin_organization_settings")).toBeTruthy();
    expect(view.queryByText("tfe_agent_pool")).toBeNull();
  });

  // Search narrows data sources too.
  fireEvent.change(view.getByLabelText("Status filter"), { target: { value: "" } });
  await act(async (): Promise<void> => {
    fireEvent.input(view.getByLabelText("Filter resources"), { target: { value: "workspace" } });
  });
  await waitFor((): void => {
    expect(view.getByText("tfe_workspace")).toBeTruthy();
    expect(view.queryByText("tfe_agent_pool")).toBeNull();
  });
});