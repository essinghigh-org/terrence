import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor, act, fireEvent } from "@testing-library/react";
import { collectionDocument, resourceDocument, useInsightResource, useInsightAction } from "../src/lib/insights-api";

const originalFetch = globalThis.fetch;

const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/vnd.api+json" } });
const resource = (id: string) => ({ data: { id, type: "evidence", attributes: { label: id } } });
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("missing and malformed resources cannot become an empty healthy result", () => {
  for (const value of [{}, { data: null }, { data: {} }, { data: [{ id: "x", type: "evidence" }] }])
    expect(() => collectionDocument(value)).toThrow();
  expect(collectionDocument({ data: [] }).data).toEqual([]);
  expect(() => resourceDocument({ data: { id: "x", attributes: {} } })).toThrow();
  expect(
    collectionDocument({ data: [], meta: { pagination: { current_page: 2, total_pages: 3, total_count: 42 } } }),
  ).toMatchObject({ page: 2, pages: 3, total: 42 });
  expect(
    collectionDocument({ data: [], meta: { pagination: { "current-page": 2, "total-pages": 3, "total-count": 42 } } }),
  ).toMatchObject({ page: 2, pages: 3, total: 42 });
});

function Reader({ endpoint }: { endpoint: string }) {
  const load = useInsightResource(endpoint, resourceDocument);
  return (
    <div>
      {load.data?.id ?? "loading"}
      <span>{load.error}</span>
    </div>
  );
}

test("delayed evidence from a previous workspace is discarded after navigation", async () => {
  let resolveOld!: (response: Response) => void;
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    if (urlOf(input).endsWith("/old"))
      return new Promise<Response>((resolve) => {
        resolveOld = resolve;
      });
    return json(resource("new-evidence"));
  }) as unknown as typeof fetch;
  const view = render(<Reader endpoint="/old" />);
  await waitFor(() => {
    expect(resolveOld).toBeDefined();
  });
  view.rerender(<Reader endpoint="/new" />);
  await waitFor(() => {
    expect(view.getByText("new-evidence")).toBeTruthy();
  });
  await act(async () => {
    resolveOld(json(resource("old-evidence")));
    await Promise.resolve();
  });
  expect(view.queryByText("old-evidence")).toBeNull();
});

function ScopedWriter({ scope }: Readonly<{ scope: string }>) {
  const action = useInsightAction(scope);
  return (
    <>
      <button
        onClick={() => {
          void action.execute("/evidence", { scope });
        }}
      >
        Scoped write
      </button>
      <span>{action.result?.id}</span>
    </>
  );
}

test("an action response from the previous committed scope is discarded after navigation", async () => {
  let resolveOld!: (response: Response) => void;
  globalThis.fetch = mock(
    async () =>
      new Promise<Response>((resolve) => {
        resolveOld = resolve;
      }),
  ) as unknown as typeof fetch;
  const view = render(<ScopedWriter scope="workspace-old" />);
  fireEvent.click(view.getByText("Scoped write"));
  await waitFor(() => {
    expect(resolveOld).toBeDefined();
  });
  view.rerender(<ScopedWriter scope="workspace-new" />);
  await act(async () => {
    resolveOld(json(resource("old-write")));
    await Promise.resolve();
  });
  expect(view.queryByText("old-write")).toBeNull();
});

function Writer() {
  const action = useInsightAction("one-workspace");
  return (
    <>
      <button
        onClick={() => {
          void action.execute("/evidence", { value: "x" });
        }}
      >
        Write
      </button>
      <p>{action.error}</p>
      <span>{action.result?.id}</span>
    </>
  );
}

test("writes are single-flight, not automatically retried, and manual failure retries retain the request key", async () => {
  const requests: RequestInit[] = [];
  let resolveFirst!: (response: Response) => void;
  globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
    requests.push(init ?? {});
    if (requests.length === 1)
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    return json(resource("recorded"));
  }) as unknown as typeof fetch;
  const view = render(<Writer />);
  fireEvent.click(view.getByText("Write"));
  fireEvent.click(view.getByText("Write"));
  await waitFor(() => {
    expect(requests).toHaveLength(1);
  });
  await act(async () => {
    resolveFirst(json({ errors: [{ detail: "Please retry explicitly" }] }, 503));
  });
  await waitFor(() => {
    expect(view.getByText("Please retry explicitly")).toBeTruthy();
  });
  expect(requests).toHaveLength(1);
  fireEvent.click(view.getByText("Write"));
  await waitFor(() => {
    expect(view.getByText("recorded")).toBeTruthy();
  });
  expect(new Headers(requests[0]?.headers).get("Idempotency-Key")).toBe(
    new Headers(requests[1]?.headers).get("Idempotency-Key"),
  );
  expect(new Headers(requests[0]?.headers).get("Idempotency-Key")).not.toBeNull();
});
