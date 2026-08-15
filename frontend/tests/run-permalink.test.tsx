import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { RunDetail } from "../src/views/RunDetail";
import { Toaster } from "../src/components/ui/toast";

const originalFetch = globalThis.fetch;
const originalClipboard = navigator.clipboard;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
  Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
});

test("copies the canonical run permalink", async () => {
  const writeText = mock(async (): Promise<void> => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/runs/run-copy") {
      return json({
        data: {
          id: "run-copy",
          attributes: {
            message: "Copyable run",
            status: "planned",
            "created-at": "2026-08-07T12:00:00.000Z",
            "status-timestamps": {},
            actions: {},
            permissions: {},
          },
        },
      });
    }
    if (url === "/api/v2/runs/run-copy/plan") return json({ data: { attributes: { status: "finished" } } });
    if (url === "/api/v2/applies/apply-run-copy") return json({ data: { attributes: { status: "pending" } } });
    if (url === "/api/v2/runs/run-copy/cost-estimate") return json({ data: null });
    if (url === "/api/v2/plans/plan-run-copy/json-output") return json({ terraform_version: "1.11.0", resource_changes: [] });
    return json({ data: [] });
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-copy"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<RunDetail showBreadcrumb={false} />}
        />
      </Routes>
      <Toaster />
    </MemoryRouter>,
  );

  const button = await waitFor(() => view.getByRole("button", { name: "Copy run permalink" }));
  fireEvent.click(button);

  await waitFor(() => {
    expect(writeText).toHaveBeenCalledWith("http://localhost/app/acme/workspaces/production/runs/run-copy");
    expect(view.getByText("Run permalink copied")).toBeTruthy();
  });
});
