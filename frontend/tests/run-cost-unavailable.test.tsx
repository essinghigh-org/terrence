import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RunDetail } from "../src/views/RunDetail";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const json = (data: JsonValue): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

function getUrlString(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// Issue #605: a missing Infracost binary records an "unavailable" estimate.
// The run page must show the section with a one-line explanation (neutral,
// not an error) instead of hiding it or styling it as a transient failure.
test("unavailable cost estimate renders a neutral one-line explanation", async () => {
  const fetchMock = mock((input: string | URL | Request): Promise<Response> => {
    const url = getUrlString(input);
    if (url === "/api/v2/runs/run-no-infracost") {
      return Promise.resolve(json({
        data: {
          id: "run-no-infracost",
          attributes: {
            message: "Plan without cost tooling",
            status: "planned",
            permissions: {},
            "created-at": "2026-07-29T10:00:00.000Z",
          },
        },
      }));
    }
    if (url === "/api/v2/runs/run-no-infracost/logs") {
      return Promise.resolve(json({ data: [{ attributes: { "output-text": "Plan: 1 to add." } }] }));
    }
    if (url === "/api/v2/runs/run-no-infracost/cost-estimate") {
      return Promise.resolve(json({
        data: {
          id: "ce-run-no-infracost",
          attributes: {
            status: "unavailable",
            "prior-monthly-cost": "0.0",
            "proposed-monthly-cost": "0.0",
            "delta-monthly-cost": "0.0",
            "resources-count": 0,
            "matched-resources-count": 0,
            "unmatched-resources-count": 0,
            "error-message": "Cost estimation is not installed in this image (no Infracost binary override and managed install failed).",
          },
        },
      }));
    }
    if (url.endsWith("/logs") || url.endsWith("/comments")) {
      return Promise.resolve(json({ data: [] }));
    }
    return Promise.resolve(json({ data: null }));
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-no-infracost"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<RunDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "Cost estimation" })).toBeTruthy();
  });
  // One-line explanation, not cost numbers.
  expect(view.getByText(/Cost estimation is not installed in this image/)).toBeTruthy();
  expect(view.queryByText("Prior monthly")).toBeNull();
  expect(view.queryByText("Proposed monthly")).toBeNull();
  // Neutral presentation: no destructive styling for a permanent setup state.
  expect(view.queryByText("$0.00 / month")).toBeNull();
}, 20000);
