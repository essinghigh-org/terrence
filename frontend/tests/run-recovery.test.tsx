import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RunDetail } from "../src/views/RunDetail";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalAnchorClick = HTMLAnchorElement.prototype.click;

function json(data: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (isString(input)) return input;
  return input instanceof URL ? input.toString() : input.url;
}

function runFixture(runId: string, extraAttributes: Record<string, JsonValue> = {}): JsonValue {
  return {
    data: {
      id: runId,
      type: "runs",
      attributes: {
        message: "Recovery run",
        status: "errored",
        actions: {
          "is-confirmable": false,
          "is-discardable": false,
          "is-cancelable": false,
          "is-force-cancelable": false,
        },
        permissions: {
          "can-apply": false,
          "can-discard": false,
          "can-cancel": false,
          "can-comment": true,
        },
        "created-at": "2026-07-29T10:00:00.000Z",
        "status-timestamps": { "applying-at": "2026-07-29T09:05:00.000Z" },
        ...extraAttributes,
      },
      relationships: {
        workspace: { data: { id: "ws-1", type: "workspaces" } },
      },
    },
  };
}

function installFetch(
  runId: string,
  run: JsonValue,
  extra: (url: string, init?: RequestInit) => Response | null,
  seen: string[],
): void {
  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    if (method === "POST") seen.push(`POST ${url}`);
    if (method === "GET") seen.push(`GET ${url}`);
    const handled = extra(url, init);
    if (handled !== null) return handled;
    if (url === `/api/v2/runs/${runId}`) return json(run);
    if (url === `/api/v2/runs/${runId}/plan`) return json({ data: { attributes: { status: "finished" } } });
    if (url === `/api/v2/applies/apply-${runId}`) return json({ data: { attributes: { status: "errored" } } });
    if (url === `/api/v2/runs/${runId}/logs`) return json({ data: [] });
    if (url.endsWith("/cost-estimate")) return json({ data: null });
    return json({ data: [] });
  };
  globalThis.fetch = (mock(handler)) as unknown as typeof fetch;
}

function renderDetail(runId: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/app/acme/workspaces/production/runs/${runId}`]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<RunDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  HTMLAnchorElement.prototype.click = originalAnchorClick;
});

// Issue #580: the run page must surface an interrupted-apply recovery copy
// with download and recover actions instead of leaving it invisible.
test("shows the recovery section only when a verified copy exists", async () => {
  const seen: string[] = [];
  installFetch("run-rec", runFixture("run-rec", { "has-recovery-state": true }), () => null, seen);
  const view = renderDetail("run-rec");
  await view.findByText("Recovery state available");
  expect(view.getByRole("button", { name: "Download recovery state" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Recover into new state version" })).toBeTruthy();
  cleanup();

  const seenBare: string[] = [];
  installFetch("run-plain", runFixture("run-plain"), () => null, seenBare);
  const plain = renderDetail("run-plain");
  await waitFor((): void => { expect(plain.queryByText("Recovery state available")).toBeNull(); });
  expect(plain.queryByRole("button", { name: "Download recovery state" })).toBeNull();
});

test("recover posts the recover-state action and refreshes", async () => {
  const seen: string[] = [];
  installFetch("run-rec", runFixture("run-rec", { "has-recovery-state": true }), (url) => {
    if (url === "/api/v2/runs/run-rec/actions/recover-state") {
      return json({ data: { id: "sv-1", type: "state-versions" } }, 201);
    }
    return null;
  }, seen);
  const view = renderDetail("run-rec");
  await view.findByText("Recovery state available");
  fireEvent.click(view.getByRole("button", { name: "Recover into new state version" }));
  await waitFor((): void => {
    expect(seen).toContain("POST /api/v2/runs/run-rec/actions/recover-state");
  });
});

test("recover explains the workspace lock requirement on conflict", async () => {
  const seen: string[] = [];
  installFetch("run-rec", runFixture("run-rec", { "has-recovery-state": true }), (url) => {
    if (url === "/api/v2/runs/run-rec/actions/recover-state") {
      return json({ errors: [{ status: "409", title: "Conflict", detail: "Workspace must be locked" }] }, 409);
    }
    return null;
  }, seen);
  const view = renderDetail("run-rec");
  await view.findByText("Recovery state available");
  fireEvent.click(view.getByRole("button", { name: "Recover into new state version" }));
  await view.findByText("The workspace must be locked by you before recovering state. Lock it on the workspace page, then try again.");
});

test("download fetches the recovery copy", async () => {
  const seen: string[] = [];
  URL.createObjectURL = mock((): string => "blob:recovery") as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = mock((): void => {}) as unknown as typeof URL.revokeObjectURL;
  // jsdom cannot navigate: swallow the programmatic download click.
  HTMLAnchorElement.prototype.click = mock((): void => {}) as unknown as typeof HTMLAnchorElement.prototype.click;
  installFetch("run-rec", runFixture("run-rec", { "has-recovery-state": true }), (url) => {
    if (url === "/api/v2/runs/run-rec/recovery-state") {
      return new Response(JSON.stringify({ version: 4, serial: 7 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return null;
  }, seen);
  const view = renderDetail("run-rec");
  await view.findByText("Recovery state available");
  fireEvent.click(view.getByRole("button", { name: "Download recovery state" }));
  await waitFor((): void => {
    expect(seen).toContain("GET /api/v2/runs/run-rec/recovery-state");
  });
  expect(view.queryByRole("alert")).toBeNull();
});
