import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { SyntheticEvent } from "react";
import { RunDetail } from "../src/views/RunDetail";
import { RunList } from "../src/views/RunList";
import { useRunActions } from "../src/lib/use-run-actions";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";
import { anyPhaseLog, phaseLogResponse } from "./support/run-log-fixture";

import { EventProvider, type EventStreamFactory } from "../src/lib/event-provider";
import type { SseEvent } from "../src/lib/events";

const originalFetch = globalThis.fetch;

function json(data: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

/** A whole phase log served over the byte-offset raw log protocol. */
function rawLog(body: string, url: string): Response {
  return phaseLogResponse(body, url);
}

function requestUrl(input: string | URL | Request): string {
  if (isString(input)) return input;
  return input instanceof URL ? input.toString() : input.url;
}

type RunOverrides = {
  id?: string;
  status?: string;
  extraAttributes?: Record<string, JsonValue>;
  actions?: Record<string, boolean>;
  permissions?: Record<string, boolean>;
  cvId?: string | null;
};

function runFixture(overrides: RunOverrides = {}): JsonValue {
  const relationships: Record<string, JsonValue> = {
    workspace: { data: { id: "ws-1", type: "workspaces" } },
  };
  if (overrides.cvId !== undefined && overrides.cvId !== null) {
    relationships["configuration-version"] = { data: { id: overrides.cvId, type: "configuration-versions" } };
  }
  return {
    data: {
      id: overrides.id ?? "run-polish",
      type: "runs",
      attributes: {
        message: "Polished run",
        status: overrides.status ?? "planned",
        actions: {
          "is-confirmable": false,
          "is-discardable": false,
          "is-cancelable": false,
          "is-force-cancelable": false,
          ...(overrides.actions ?? {}),
        },
        permissions: {
          "can-apply": false,
          "can-discard": false,
          "can-cancel": false,
          "can-comment": true,
          ...(overrides.permissions ?? {}),
        },
        "created-at": "2026-07-29T10:00:00.000Z",
        "status-timestamps": { "planned-at": "2026-07-29T09:00:00.000Z" },
        ...(overrides.extraAttributes ?? {}),
      },
      relationships,
    },
  };
}

function baseMock(
  runId: string,
  run: JsonValue,
  extra: (url: string, init?: RequestInit) => Response | null,
  seen: string[],
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (init?.method === "POST") seen.push(`${init.method} ${url}`);
    const handled = extra(url, init);
    if (handled !== null) return handled;
    if (url === `/api/v2/runs/${runId}`) return json(run);
    if (url === `/api/v2/runs/${runId}/plan`) return json({ data: { attributes: { status: "finished" } } });
    if (url === `/api/v2/applies/apply-${runId}`) return json({ data: { attributes: { status: "pending" } } });
    if (url.startsWith(`/api/v2/runs/${runId}/plan/log`)) return rawLog("", url);
    if (url.startsWith(`/api/v2/runs/${runId}/apply/log`)) return rawLog("", url);
    if (url.endsWith("/cost-estimate")) return json({ data: null });
    return json({ data: [] });
  };
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
});

test("failed apply keeps the raw log visible beside diagnostics (issue #589)", async () => {
  const seen: string[] = [];
  globalThis.fetch = mock(baseMock("run-failed", runFixture({
    id: "run-failed",
    status: "failed",
    extraAttributes: { "status-timestamps": { "applying-at": "2026-07-29T09:05:00.000Z" } },
  }), (url) => {
    if (url === "/api/v2/applies/apply-run-failed") {
      return json({ data: { attributes: { status: "errored" } } });
    }
    if (url.startsWith("/api/v2/runs/run-failed/apply/log")) {
      return rawLog("Error: Apply failed\n\n  on main.tf line 1:\n  boom\n", url);
    }
    return null;
  }, seen)) as unknown as typeof fetch;

  const view = renderDetail("run-failed");
  await waitFor((): void => { expect(view.getByText("Raw apply log")).toBeTruthy(); });
  expect(seen).toEqual([]);
});

test("a blocked action names its blocker on the button it blocks (issue #597)", async () => {
  const seen: string[] = [];
  globalThis.fetch = mock(baseMock("run-planned", runFixture({
    id: "run-planned",
    actions: { "is-confirmable": true, "is-discardable": true },
    permissions: { "can-apply": false, "can-discard": true },
  }), () => null, seen)) as unknown as typeof fetch;

  const view = renderDetail("run-planned");
  const apply = await waitFor((): HTMLElement => view.getByRole("button", { name: "Apply changes" }));
  // Disabled, with the reason on the control rather than in a separate list
  // that had to restate which action each line referred to.
  expect(apply.hasAttribute("disabled")).toBe(true);
  expect(apply.getAttribute("title")).toContain("permission to apply");
  // The action the user *can* take is still live beside it.
  expect(view.getByRole("button", { name: "Discard plan" }).hasAttribute("disabled")).toBe(false);
});

test("actions the run cannot take at all are not rendered as dead buttons", async () => {
  const seen: string[] = [];
  globalThis.fetch = mock(baseMock("run-quiet", runFixture({
    id: "run-quiet",
    status: "planning",
    actions: { "is-cancelable": false, "is-force-cancelable": false },
  }), () => null, seen)) as unknown as typeof fetch;

  const view = renderDetail("run-quiet");
  // "Planning" renders in several places at once (breadcrumb, status badge,
  // decision panel), so wait for all of them instead of a getByText that
  // throws on multiple matches.
  await waitFor((): void => { expect(view.getAllByText("Planning").length).toBeGreaterThan(0); });
  expect(view.queryByRole("button", { name: "Force cancel" })).toBeNull();
  // And no panel asking the user to review changes that do not exist yet.
  expect(view.queryByText(/review the planned changes/i)).toBeNull();
});

test("cancel during apply warns about partial state before firing (issue #604)", async () => {
  const seen: string[] = [];
  globalThis.fetch = mock(baseMock("run-applying", runFixture({
    id: "run-applying",
    status: "applying",
    actions: { "is-cancelable": true },
    permissions: { "can-cancel": true },
    extraAttributes: { "status-timestamps": { "applying-at": "2026-07-29T09:05:00.000Z" } },
  }), (url) => {
    if (url === "/api/v2/runs/run-applying/actions/cancel") return new Response(null, { status: 202 });
    return null;
  }, seen)) as unknown as typeof fetch;

  const view = renderDetail("run-applying");
  await waitFor((): void => { expect(view.getByRole("button", { name: "Cancel run" })).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Cancel run" }));
  await waitFor((): void => { expect(view.getByRole("heading", { name: "Cancel this run?" })).toBeTruthy(); });
  expect(view.getByText(/partial state/).textContent).toBeTruthy();
  expect(seen).toEqual([]);
  fireEvent.click(view.getByRole("button", { name: "Yes, cancel the run" }));
  await waitFor((): void => { expect(seen).toContain("POST /api/v2/runs/run-applying/actions/cancel"); });
}, 15000);

test("force cancel and override route through confirmation with copy (issue #610)", async () => {
  const seen: string[] = [];
  globalThis.fetch = mock(baseMock("run-stuck", runFixture({
    id: "run-stuck",
    status: "applying",
    actions: { "is-force-cancelable": true },
    permissions: { "can-force-cancel": true },
    extraAttributes: { "status-timestamps": { "applying-at": "2026-07-29T09:05:00.000Z" } },
  }), () => null, seen)) as unknown as typeof fetch;

  const view = renderDetail("run-stuck");
  await waitFor((): void => { expect(view.getByRole("button", { name: "Force cancel" })).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Force cancel" }));
  await waitFor((): void => { expect(view.getByRole("heading", { name: "Force cancel this run?" })).toBeTruthy(); });
  expect(view.getByText(/without waiting for the process to exit/).textContent).toBeTruthy();
  expect(seen).toEqual([]);
}, 15000);

test("destroy runs show a disabled re-run with a reason (issue #630)", async () => {
  const seen: string[] = [];
  globalThis.fetch = mock(baseMock("run-destroy", runFixture({
    id: "run-destroy",
    extraAttributes: { "is-destroy": true },
  }), () => null, seen)) as unknown as typeof fetch;

  const view = renderDetail("run-destroy");
  await waitFor((): void => { expect(view.getByText("Rerun is unavailable for destroy runs.")).toBeTruthy(); });
  expect(view.getByRole("button", { name: "Re-run" }).hasAttribute("disabled")).toBe(true);
});

test("speculative runs get a badge and a never-applies note (issue #603)", async () => {
  const seen: string[] = [];
  globalThis.fetch = mock(baseMock("run-spec", runFixture({
    id: "run-spec",
    extraAttributes: { "plan-only": true },
    cvId: "cv-spec",
  }), (url) => {
    if (url === "/api/v2/configuration-versions/cv-spec") {
      return json({ data: { id: "cv-spec", type: "configuration-versions", attributes: { speculative: true } } });
    }
    return null;
  }, seen)) as unknown as typeof fetch;

  const view = renderDetail("run-spec");
  await waitFor((): void => { expect(view.getByText("Speculative")).toBeTruthy(); });
  await waitFor((): void => {
    expect(view.getByRole("heading", { name: /Speculative plan .* never applies/ })).toBeTruthy();
  });
});

test("destroy runs from the dialog confirm and pin auto-apply false (issue #586)", async () => {
  let createBody: unknown;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/workspaces/ws-1/runs" || url === "/api/v2/workspaces/ws-1/runs?sort=-created-at") {
      return json({ data: [] });
    }
    if (url === "/api/v2/runs" && init?.method === "POST") {
      if (!isString(init.body)) throw new Error("Expected a JSON request body");
      createBody = JSON.parse(init.body) as unknown;
      return json({ data: { id: "run-destroy-new" } }, 201);
    }
    {
      const phaseLogFallback = anyPhaseLog(url);
      if (phaseLogFallback !== null) return phaseLogFallback;
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs"]}>
      <Routes>
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs"
          element={<RunList workspaceId="ws-1" orgName="acme" workspaceName="production" canStartRun />}
        />
        <Route
          path="/app/:orgName/workspaces/:workspaceName/runs/:runId"
          element={<p>Destroy run detail</p>}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getAllByRole("button", { name: "Start new run" }).length).toBeGreaterThan(0); });
  const startButtons = view.getAllByRole("button", { name: "Start new run" });
  const startButton = startButtons[0];
  if (startButton === undefined) throw new Error("Start new run button not found");
  fireEvent.click(startButton);
  await waitFor((): void => { expect(view.getByRole("dialog")).toBeTruthy(); });
  fireEvent.click(view.getByLabelText("Destroy infrastructure"));
  fireEvent.click(view.getByRole("button", { name: "Start run" }));
  await waitFor((): void => { expect(view.getByRole("heading", { name: "Destroy infrastructure?" })).toBeTruthy(); });
  expect(createBody).toBeUndefined();
  fireEvent.click(view.getByRole("button", { name: "Start destroy run" }));
  await waitFor((): void => { expect(view.getByText("Destroy run detail")).toBeTruthy(); });
  expect(createBody).toMatchObject({
    data: { attributes: { "auto-apply": false, "is-destroy": true } },
  });
}, 15000);


test("an explicit apply collapse survives the apply starting", async () => {
  let status = "planned";
  let applyReads = 0;
  let emit: ((event: SseEvent) => void) | undefined;
  const streamFactory: EventStreamFactory = (listener) => {
    emit = listener;
    return { close: (): void => undefined };
  };
  globalThis.fetch = mock(baseMock("run-expand", runFixture({ id: "run-expand" }), (url) => {
    if (url === "/api/v2/runs/run-expand") return json(runFixture({ id: "run-expand", status }));
    if (url === "/api/v2/applies/apply-run-expand") {
      applyReads += 1;
      return json({ data: { attributes: { status: status === "applying" ? "running" : "pending" } } });
    }
    return null;
  }, [])) as unknown as typeof fetch;
  const view = render(
    <EventProvider streamFactory={streamFactory}>
      <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs/run-expand"]}>
        <Routes><Route path="/app/:orgName/workspaces/:workspaceName/runs/:runId" element={<RunDetail />} /></Routes>
      </MemoryRouter>
    </EventProvider>,
  );
  const section = await waitFor((): HTMLDetailsElement => {
    const element = view.container.querySelector<HTMLDetailsElement>('details[aria-labelledby="apply-heading"]');
    expect(element).not.toBeNull();
    return element!;
  });
  const summary = section.querySelector("summary")!;
  fireEvent.click(summary);
  await waitFor((): void => { expect(section.open).toBe(true); });
  const raw = view.getByText("Raw apply log").closest("details")!;
  expect(raw.open).toBe(false);
  fireEvent.click(summary);
  await waitFor((): void => { expect(section.open).toBe(false); });
  const readsBeforeApply = applyReads;
  act((): void => {
    status = "applying";
    emit?.({ name: "run.status", data: { "run-id": "run-expand", status } });
  });
  // The refresh lands (the apply section re-reads and its heading reports
  // the new Running state) but the explicit collapse is preserved instead
  // of being forced back open.
  await waitFor((): void => { expect(applyReads).toBeGreaterThan(readsBeforeApply); });
  await waitFor((): void => { expect(within(section).getByText("Running")).toBeTruthy(); });
  expect(section.open).toBe(false);
  expect(raw.open).toBe(false);
});

test("double-submitting a comment sends one request", async () => {
  const posts: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (init?.method === "POST") posts.push(`${init.method} ${url}`);
    if (url === "/api/v2/runs/run-comment-guard/comments") return json({ data: { id: "c1", type: "comments" } });
    return json({ data: [] });
  }) as unknown as typeof fetch;

  const hook = renderHook(() => useRunActions({
    runId: "run-comment-guard",
    markActionSent: (): void => undefined,
    markActionSettled: (): void => undefined,
    refreshAll: (): void => undefined,
    refresh: (): void => undefined,
  }));
  act((): void => { hook.result.current.setCommentBody("Double-click guard"); });
  const submit = hook.result.current.handleCommentSubmit;
  const event = { preventDefault: (): void => undefined } as unknown as SyntheticEvent<HTMLFormElement>;
  // Two submissions from the same render closure: the synchronous in-flight
  // guard must drop the second one.
  await act(async (): Promise<void> => {
    await Promise.all([submit(event), submit(event)]);
  });
  expect(posts.filter((entry) => entry === "POST /api/v2/runs/run-comment-guard/comments")).toHaveLength(1);
});

test("double-confirming apply sends one action request", async () => {
  const posts: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (init?.method === "POST") posts.push(`${init.method} ${url}`);
    if (url === "/api/v2/runs/run-apply-guard/actions/apply") return new Response(null, { status: 202 });
    return json({ data: [] });
  }) as unknown as typeof fetch;

  const hook = renderHook(() => useRunActions({
    runId: "run-apply-guard",
    markActionSent: (): void => undefined,
    markActionSettled: (): void => undefined,
    refreshAll: (): void => undefined,
    refresh: (): void => undefined,
  }));
  const send = hook.result.current.performRunAction;
  await act(async (): Promise<void> => {
    const [first, second] = await Promise.all([send("apply", "Applied"), send("apply", "Applied")]);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
  expect(posts.filter((entry) => entry === "POST /api/v2/runs/run-apply-guard/actions/apply")).toHaveLength(1);
});
