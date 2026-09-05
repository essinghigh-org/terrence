import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { runHistoryPageUrl } from "../src/lib/run-history";
import { RunList } from "../src/views/RunList";
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

type ApiRun = {
  id: string;
  attributes: Record<string, string | null>;
};

const run = (id: string, message: string): ApiRun => ({
  id,
  attributes: {
    message,
    status: "planned",
    "created-at": new Date().toISOString(),
    source: "tfe-api",
    "trigger-reason": "manual",
  },
});

const pageEnvelope = (items: ApiRun[], total: number, next: number | null): JsonValue => ({
  data: items.map((item) => ({
    id: item.id,
    type: "runs",
    attributes: item.attributes,
    relationships: { "created-by": { data: null } },
  })),
  meta: {
    pagination: {
      "current-page": 1,
      "page-size": 20,
      "total-pages": Math.max(1, Math.ceil(total / 20)),
      "total-count": total,
      ...(next === null ? {} : { "next-page": next }),
    },
  },
});

// Five-run history across three pages; the search query matches one run.
const allRuns = [run("run-1", "first deploy"), run("run-2", "second deploy"), run("run-3", "needle-haystack"), run("run-4", "fourth"), run("run-5", "fifth")];

function installFetchMock(): void {
  const fetchMock = mock((input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/v2/workspaces/ws-1/runs")) {
      const params = new URL(url, "http://terrence.local").searchParams;
      const search = params.get("search[basic]") ?? "";
      const pool = search === "" ? allRuns : allRuns.filter((item) => item.attributes["message"]?.includes(search) === true);
      const page = Number(params.get("page[number]") ?? "1");
      const size = 2;
      const items = pool.slice((page - 1) * size, page * size);
      const hasMore = page * size < pool.length;
      return Promise.resolve(json(pageEnvelope(items, pool.length, hasMore ? page + 1 : null)));
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;
}

function renderList(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <RunList workspaceId="ws-1" orgName="acme" workspaceName="production" canStartRun={false} />
    </MemoryRouter>,
  );
}

test("run history shows the server total and loads more pages (issue #591)", async () => {
  installFetchMock();
  const list = renderList();

  await waitFor((): void => {
    expect(list.getByText("Showing 2 of 5 runs")).toBeTruthy();
  });
  expect(list.getByRole("button", { name: /Load more \(2 of 5 shown\)/ })).toBeTruthy();

  await act(async (): Promise<void> => {
    fireEvent.click(list.getByRole("button", { name: /Load more/ }));
  });
  await waitFor((): void => {
    expect(list.getByText("Showing 4 of 5 runs")).toBeTruthy();
  });

  await act(async (): Promise<void> => {
    fireEvent.click(list.getByRole("button", { name: /Load more/ }));
  });
  await waitFor((): void => {
    expect(list.getByText("Showing 5 of 5 runs")).toBeTruthy();
  });
  expect(list.queryByRole("button", { name: /Load more/ })).toBeNull();
});

test("run filter builds a server-side whole-history search URL (issue #591)", () => {
  // jsdom cannot drive React 19 controlled inputs in this harness (state
  // never updates, even for a bare fireEvent.change), so the filter box
  // itself is covered in browser E2E; the query contract is pinned here.
  expect(runHistoryPageUrl("ws-1", null, "", "")).toBe("/api/v2/workspaces/ws-1/runs");
  expect(runHistoryPageUrl("ws-1", null, "-created-at", "")).toBe(
    "/api/v2/workspaces/ws-1/runs?sort=-created-at",
  );
  expect(runHistoryPageUrl("ws-1", 2, "", "")).toBe("/api/v2/workspaces/ws-1/runs?page%5Bnumber%5D=2");
  expect(runHistoryPageUrl("ws-1", null, "", "  needle  ")).toBe(
    "/api/v2/workspaces/ws-1/runs?search%5Bbasic%5D=needle",
  );
  expect(runHistoryPageUrl("ws-1", 3, "status", "old run")).toBe(
    "/api/v2/workspaces/ws-1/runs?page%5Bnumber%5D=3&sort=status&search%5Bbasic%5D=old+run",
  );
});
