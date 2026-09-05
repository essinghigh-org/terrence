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

/**
 * A phase log that grows between polls, served over the byte-offset protocol
 * the raw log endpoints speak.
 *
 * The view used to read the paged `/runs/:id/logs` collection, which returns
 * page 1 of 20 rows: once a run wrote more than twenty rows the pane was
 * pinned to the first twenty forever, which is what "the log window is frozen
 * while the run streams" was. These fixtures make that failure observable —
 * a reader that ignores `offset` can only ever show the first chunk.
 */
function logSlice(whole: string, offsetParam: string | null): Response {
  const bytes = new TextEncoder().encode(whole);
  const offset = Number.parseInt(offsetParam ?? "0", 10);
  const from = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
  return new Response(bytes.slice(from), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Terrence-Log-Total-Bytes": String(bytes.byteLength),
      "X-Terrence-Log-Truncated": "false",
    },
  });
}

function installFetchMock(
  status: string,
  onPlanLog: (offset: string | null) => void,
  planLog: () => string,
  onApplyLog: (offset: string | null) => void = (): void => undefined,
): void {
  const fetchMock = mock((input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === "string"
      ? input
      : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "http://terrence.local");
    if (url.pathname.endsWith("/runs/run-polling")) {
      return Promise.resolve(json({
        data: {
          id: "run-polling",
          attributes: {
            message: "Polling run",
            status,
            actions: { "is-confirmable": false },
            permissions: { "can-apply": false },
            "created-at": "2026-07-29T10:00:00.000Z",
            "status-timestamps": { "planning-at": "2026-07-29T10:00:01.000Z" },
          },
        },
      }));
    }
    if (url.pathname.endsWith("/runs/run-polling/plan/log")) {
      onPlanLog(url.searchParams.get("offset"));
      return Promise.resolve(logSlice(planLog(), url.searchParams.get("offset")));
    }
    if (url.pathname.endsWith("/runs/run-polling/apply/log")) {
      onApplyLog(url.searchParams.get("offset"));
      return Promise.resolve(logSlice("", url.searchParams.get("offset")));
    }
    return Promise.resolve(json({ data: null }));
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;
}

/** This test does not care which offsets were requested, only what renders. */
const noteNothing = (): void => undefined;

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

test("an active run tails its plan log forward from the last byte it holds", async () => {
  const offsets: (string | null)[] = [];
  let log = "first line\n";
  installFetchMock("planning", (offset): void => { offsets.push(offset); }, (): string => log);
  renderDetail();

  await waitFor((): void => {
    expect(offsets.length).toBeGreaterThanOrEqual(1);
  }, { timeout: 10000 });
  // The opening read starts at the beginning of the stream.
  expect(offsets[0] === null || offsets[0] === "0").toBe(true);

  // The run writes more output. The next poll must ask for the bytes after
  // what the page already has, not re-read page one.
  log = "first line\nsecond line\n";
  await waitFor((): void => {
    const advanced = offsets.some((offset: string | null): boolean =>
      offset !== null && Number.parseInt(offset, 10) > 0);
    expect(advanced).toBe(true);
  }, { timeout: 15000 });
}, 25000);

test("appended log output is added to what is already on screen", async () => {
  let log = "alpha\n";
  installFetchMock("planning", noteNothing, (): string => log);
  // NOTE: global `screen` queries stay bound to the document at import time
  // and throw under bun+happy-dom ("a global document has to be available"),
  // so every query here goes through the render result like the other suites.
  const view = renderDetail();

  await waitFor((): void => {
    expect(view.getByText(/alpha/)).toBeTruthy();
  }, { timeout: 10000 });

  log = "alpha\nomega\n";
  // Both the original and the appended text must be present: a reader that
  // replaced its buffer with each response would show only the delta.
  await waitFor((): void => {
    const pane = view.getByText(/omega/);
    expect(pane.textContent ?? "").toContain("alpha");
  }, { timeout: 15000 });
}, 25000);

test("a terminal run stops polling once it has read its logs", async () => {
  let calls = 0;
  // Both phases are counted: a terminal run that kept polling its apply log
  // must fail here, not just one that re-reads the plan log.
  const count = (): void => { calls += 1; };
  installFetchMock("applied", count, (): string => "done\n", count);
  renderDetail();

  await waitFor((): void => {
    expect(calls).toBeGreaterThanOrEqual(1);
  }, { timeout: 10000 });
  const settled = calls;
  await new Promise((resolve): void => { setTimeout(resolve, 5500); });
  // No cadence at all for a finished run: the page it replaces kept a 30s
  // timer refetching applied runs for as long as the tab stayed open.
  expect(calls).toBe(settled);
}, 25000);
