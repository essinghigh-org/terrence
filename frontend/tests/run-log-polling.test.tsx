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

// Issue #595: while a run is active the log window must refresh on a fast
// interval (SSE carries status transitions only, and long init/plan/apply
// stretches send none); terminal runs must not keep polling.
function installFetchMock(status: string, onLogs: () => void): void {
  const fetchMock = mock((input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/runs/run-polling")) {
      return Promise.resolve(json({
        data: {
          id: "run-polling",
          attributes: {
            message: "Polling run",
            status,
            actions: { "is-confirmable": false },
            permissions: { "can-apply": false },
            "created-at": "2026-07-29T10:00:00.000Z",
            "status-timestamps": {},
          },
        },
      }));
    }
    if (url.endsWith("/runs/run-polling/logs")) {
      onLogs();
      return Promise.resolve(json({ data: [] }));
    }
    return Promise.resolve(json({ data: null }));
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;
}

function renderDetail(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-polling"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<RunDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

test("active runs poll logs on a fast interval", async () => {
  let logsCalls = 0;
  installFetchMock("planning", (): void => {
    logsCalls += 1;
  });
  renderDetail();

  // Initial full refresh plus at least one 4s poll tick.
  await waitFor(
    (): void => {
      expect(logsCalls).toBeGreaterThanOrEqual(2);
    },
    { timeout: 15000 },
  );
}, 20000);

test("terminal runs do not poll logs", async () => {
  let logsCalls = 0;
  installFetchMock("applied", (): void => {
    logsCalls += 1;
  });
  renderDetail();

  // Initial full refresh loads logs once; no poll ticks may follow.
  await waitFor(
    (): void => {
      expect(logsCalls).toBeGreaterThanOrEqual(1);
    },
    { timeout: 15000 },
  );
  await new Promise((resolve): void => {
    setTimeout(resolve, 5500);
  });
  expect(logsCalls).toBe(1);
}, 20000);
