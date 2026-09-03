import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { isValidElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AdminDatabaseMigration } from "../src/views/AdminDatabaseMigration";
import { ApplyOutput } from "../src/components/ApplyOutput";
import { PlanOutput } from "../src/components/PlanOutput";
import {
  clearProviderIconCacheForTests,
  ProviderIcon,
} from "../src/components/ProviderIcon";
import { RunList } from "../src/views/RunList";
import { waitForAbortableDelay } from "../src/views/RunDetail";
import { WorkspaceDetail } from "../src/views/WorkspaceDetail";
import { EventProvider } from "../src/lib/event-provider";
import type { EventStreamHandle, SseEvent } from "../src/lib/events";
import { inlineMarkdown } from "../src/components/MarkdownContent";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;
const originalSetInterval = window.setInterval.bind(window);
const originalSetTimeout = window.setTimeout.bind(window);
const originalClearTimeout = window.clearTimeout.bind(window);

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

function workspaceDocument(): JsonValue {
  return {
    data: {
      id: "ws-1",
      type: "workspaces",
      attributes: {
        name: "production",
        description: null,
        locked: false,
        "working-directory": null,
        "execution-mode": "remote",
        "iac-binary": "tofu",
        "terraform-version": "latest",
        "auto-apply": false,
        permissions: {
          "can-queue-run": false,
          "can-read-state-versions": false,
        },
      },
    },
  };
}

function runDocument(status: string): JsonValue {
  return {
    data: [{
      id: "run-1",
      type: "runs",
      attributes: {
        status,
        message: "Regression fixture",
        "created-at": "2026-09-03T10:00:00.000Z",
      },
    }],
  };
}

function renderWorkspace(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
      <Routes>
        <Route path="/app/:orgName/workspaces/:workspaceName" element={<WorkspaceDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.setInterval = originalSetInterval;
  window.setTimeout = originalSetTimeout;
  window.clearTimeout = originalClearTimeout;
  clearProviderIconCacheForTests();
  setDocumentHidden(false);
});

test("renders the apply fallback when plan JSON responds with 204", async () => {
  globalThis.fetch = (mock(async (): Promise<Response> => new Response(null, { status: 204 }))) as unknown as typeof fetch;

  const view = render(
    <ApplyOutput runId="run-204" status="applied" applyStatus="applied" applyLogs="raw apply log" />,
  );

  await waitFor((): void => {
    expect(view.getByText("Apply view is unavailable. See raw apply logs below.")).toBeTruthy();
  });
  expect(view.queryByText("Cannot read properties of null")).toBeNull();
});

test("resolves duplicate provider icons by notification without per-instance intervals", async () => {
  clearProviderIconCacheForTests();
  let resolveFetch: ((response: Response) => void) | undefined;
  const response = new Promise<Response>((resolve): void => {
    resolveFetch = resolve;
  });
  const fetchMock = mock(async (): Promise<Response> => response);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  let intervalCalls = 0;
  window.setInterval = ((handler: TimerHandler, timeout?: number): number => {
    intervalCalls++;
    return originalSetInterval(handler, timeout);
  }) as typeof window.setInterval;

  const view = render(
    <>
      <ProviderIcon providerName="hashicorp/aws" />
      <ProviderIcon providerName="hashicorp/aws" />
    </>,
  );

  await waitFor((): void => { expect(fetchMock).toHaveBeenCalledTimes(1); });
  expect(intervalCalls).toBe(0);
  if (resolveFetch === undefined) throw new Error("Expected the provider icon request to be pending");
  resolveFetch(json({
    data: [{ id: "hashicorp/aws", attributes: { "icon-url": "https://example.com/aws.svg" } }],
  }));

  await waitFor((): void => { expect(view.container.querySelectorAll("img")).toHaveLength(2); });
});

test("keeps a mounted provider icon subscribed after the fallback timeout", async () => {
  clearProviderIconCacheForTests();
  let resolveFetch: ((response: Response) => void) | undefined;
  const response = new Promise<Response>((resolve): void => {
    resolveFetch = resolve;
  });
  const fetchMock = mock(async (): Promise<Response> => response);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  let triggerFallback: (() => void) | undefined;
  window.setTimeout = ((handler: TimerHandler, timeout?: number): number => {
    if (timeout === 5000) {
      triggerFallback = (): void => {
        if (typeof handler === "function") handler();
      };
      return 0;
    }
    return originalSetTimeout(handler, timeout);
  }) as typeof window.setTimeout;

  const view = render(<ProviderIcon providerName="hashicorp/aws" fallback={<span>Fallback</span>} />);
  await waitFor((): void => {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(triggerFallback).toBeTruthy();
  });
  const fallbackTimer = triggerFallback;
  if (fallbackTimer === undefined) throw new Error("Expected the provider icon fallback timer");
  act((): void => { fallbackTimer(); });
  expect(view.getByText("Fallback")).toBeTruthy();

  const resolve = resolveFetch;
  if (resolve === undefined) throw new Error("Expected the provider icon request to be pending");
  resolve(json({
    data: [{ id: "hashicorp/aws", attributes: { "icon-url": "https://example.com/aws.svg" } }],
  }));
  await waitFor((): void => { expect(view.container.querySelector("img")).toBeTruthy(); });
});

test("does not poll WorkspaceDetail while hidden and resumes on visibility", async () => {
  let runRequests = 0;
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") return json(workspaceDocument());
    if (url === "/api/v2/workspaces/ws-1/runs?page[size]=1") {
      runRequests++;
      return json(runDocument("planning"));
    }
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;
  setDocumentHidden(true);

  const view = renderWorkspace();
  await waitFor((): void => { expect(view.getByRole("heading", { name: "production" })).toBeTruthy(); });
  expect(runRequests).toBe(0);

  act((): void => {
    setDocumentHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor((): void => { expect(runRequests).toBe(1); });
  expect(view.getByText("Latest run: Planning")).toBeTruthy();

  act((): void => {
    setDocumentHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
  });
});

test("stops WorkspaceDetail polling after a terminal run but refreshes on run status events", async () => {
  let runRequests = 0;
  const runResolvers: ((response: Response) => void)[] = [];
  const scheduledDelays: number[] = [];
  let emitRunStatus: ((event: SseEvent) => void) | undefined;
  const streamFactory = (onEvent: (event: SseEvent) => void): EventStreamHandle => {
    emitRunStatus = onEvent;
    return { close: (): void => undefined };
  };
  window.setTimeout = ((handler: TimerHandler, timeout?: number): number => {
    if (timeout === 5000) scheduledDelays.push(timeout);
    return originalSetTimeout(handler, timeout);
  }) as typeof window.setTimeout;
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") return json(workspaceDocument());
    if (url === "/api/v2/workspaces/ws-1/runs?page[size]=1") {
      runRequests++;
      return new Promise<Response>((resolve): void => { runResolvers.push(resolve); });
    }
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;

  const view = render(
    <EventProvider streamFactory={streamFactory}>
      <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
        <Routes>
          <Route path="/app/:orgName/workspaces/:workspaceName" element={<WorkspaceDetail />} />
        </Routes>
      </MemoryRouter>
    </EventProvider>,
  );
  await waitFor((): void => { expect(runResolvers).toHaveLength(1); });
  const resolveInitial = runResolvers[0];
  if (resolveInitial === undefined) throw new Error("Expected the initial latest-run request");
  act((): void => { resolveInitial(json(runDocument("applied"))); });
  await waitFor((): void => { expect(view.getByText("Latest run: Applied")).toBeTruthy(); });
  expect(runRequests).toBe(1);
  expect(scheduledDelays).toHaveLength(0);
  const liveRegion = view.container.querySelector('[aria-live="polite"]');
  expect(liveRegion?.textContent).toContain("Latest run: Applied");

  const emit = emitRunStatus;
  if (emit === undefined) throw new Error("Expected the SSE stream to be connected");
  act((): void => {
    emit({
      name: "run.status",
      data: {
        "run-id": "run-2",
        "workspace-id": "ws-1",
        "org-id": "org-1",
        status: "planning",
        at: "2026-09-03T10:00:02.000Z",
      },
    });
    emit({
      name: "run.status",
      data: {
        "run-id": "run-3",
        "workspace-id": "ws-1",
        "org-id": "org-1",
        status: "planning",
        at: "2026-09-03T10:00:03.000Z",
      },
    });
  });
  await waitFor((): void => { expect(runRequests).toBe(3); });
  const resolveOlder = runResolvers[1];
  const resolveNewest = runResolvers[2];
  if (resolveOlder === undefined || resolveNewest === undefined) {
    throw new Error("Expected both event-triggered latest-run requests");
  }
  act((): void => {
    resolveNewest(json(runDocument("planning")));
    resolveOlder(json(runDocument("errored")));
  });
  await waitFor((): void => { expect(view.getByText("Latest run: Planning")).toBeTruthy(); });
  expect(view.queryByText("Latest run: Errored")).toBeNull();
  expect(scheduledDelays).toHaveLength(1);

  act((): void => {
    setDocumentHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
  });
});

test("announces run status in the RunList live region", async () => {
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/workspaces/ws-1/runs") {
      return json({
        data: [{
          id: "run-1",
          type: "runs",
          attributes: {
            status: "applied",
            message: "Completed fixture",
            "created-at": "2026-09-03T10:00:00.000Z",
          },
        }],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production/runs"]}>
      <RunList workspaceId="ws-1" orgName="acme" workspaceName="production" canStartRun={false} />
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Applied")).toBeTruthy(); });
  const liveRegion = view.container.querySelector('[aria-live="polite"]');
  expect(liveRegion?.textContent).toContain("Applied");
});

test("announces the polled database migration phase", async () => {
  globalThis.fetch = (mock(async (): Promise<Response> => json({
    data: {
      wizard: {
        id: "migration-1",
        phase: "copying",
        createdAt: "2026-09-03T10:00:00.000Z",
        updatedAt: "2026-09-03T10:00:01.000Z",
        targetUrl: "postgres://internal",
        targetMasked: "postgres://***",
        steps: [],
        verification: null,
        report: null,
        error: null,
        copyProgress: null,
      },
      running: true,
      "source-database": { path: "/tmp/terrence.db", memory: false },
      "restart-disabled": false,
      "environment-database-url": null,
    },
  }))) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter>
      <AdminDatabaseMigration />
    </MemoryRouter>,
  );
  await waitFor((): void => { expect(view.getByText("Copying records")).toBeTruthy(); });
  const liveRegion = view.container.querySelector('[aria-live="polite"]');
  expect(liveRegion?.textContent).toContain("Copying records");
});

test("removes the abort listener after every explainer retry delay", async () => {
  const controller = new AbortController();
  let removeCount = 0;
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  Object.defineProperty(controller.signal, "removeEventListener", {
    configurable: true,
    value: ((...args: Parameters<AbortSignal["removeEventListener"]>): void => {
      if (args[0] === "abort") removeCount++;
      remove(...args);
    }) as AbortSignal["removeEventListener"],
  });

  await waitForAbortableDelay(controller.signal, 0);
  await waitForAbortableDelay(controller.signal, 0);
  await waitForAbortableDelay(controller.signal, 0);

  expect(removeCount).toBe(3);
});

test("keeps semantic inline markdown keys stable when earlier text changes", () => {
  const before = inlineMarkdown("**same**");
  const after = inlineMarkdown("prefix **same**");
  const beforeElements = Array.isArray(before) ? before.filter(isValidElement) : [];
  const afterElements = Array.isArray(after) ? after.filter(isValidElement) : [];

  expect(beforeElements).toHaveLength(1);
  expect(afterElements).toHaveLength(1);
  expect(afterElements[0]?.key).toBe(beforeElements[0]?.key);
  expect(String(afterElements[0]?.key)).toContain("inline:");
});

test("keeps derived plan and apply output visible across rerenders", async () => {
  const plan: JsonValue = {
    terraform_version: "1.11.0",
    format_version: "1.2",
    resource_changes: [{
      address: "aws_instance.web",
      type: "aws_instance",
      change: {
        actions: ["create"],
        before: null,
        after: { id: "i-web" },
      },
    }],
  };
  globalThis.fetch = (mock(async (): Promise<Response> => json(plan))) as unknown as typeof fetch;

  const view = render(
    <>
      <PlanOutput runId="run-memo" status="planned" />
      <ApplyOutput runId="run-memo" status="applied" applyStatus="applied" applyLogs="" />
    </>,
  );
  await waitFor((): void => { expect(view.getAllByText("aws_instance.web").length).toBeGreaterThanOrEqual(2); });

  view.rerender(
    <>
      <PlanOutput runId="run-memo" status="planned" />
      <ApplyOutput runId="run-memo" status="applied" applyStatus="applied" applyLogs="" />
    </>,
  );
  expect(view.getAllByText("aws_instance.web").length).toBeGreaterThanOrEqual(2);
});
