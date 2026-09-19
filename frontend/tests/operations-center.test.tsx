import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { AdminOperationsCenter } from "../src/views/AdminOperationsCenter";

const originalFetch = globalThis.fetch;

function requestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  throw new Error("Expected a JSON string request body");
}
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/vnd.api+json" } });
const resource = (id: string, attributes: Record<string, unknown>) => ({ id, type: "evidence", attributes });
const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
const operation = (status = "unknown") => ({
  data: resource("operations-center", {
    "rehearsal-max-age-days": 30,
    "checked-at": "2026-09-19T12:00:00Z",
    "local-node-id": "node-1",
    nodes: [],
    backup: { status, "last-verified-restore-at": null },
  }),
});
const show = (tab = "overview", siteAdmin = true) =>
  render(
    <MemoryRouter initialEntries={[`/app/admin/operations?tab=${tab}`]}>
      <Routes>
        <Route element={<Outlet context={{ accountLoaded: true, siteAdmin }} />}>
          <Route path="/app/admin/operations" element={<AdminOperationsCenter />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("the operations center does not fetch privileged endpoints for a non-admin", async () => {
  const fetcher = mock(async () => json({}));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  const view = show("overview", false);
  expect(view.getByText("Site-administrator access is required.")).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});

test("runtime errors stay local and recovery is shown as unknown rather than healthy", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = urlOf(input);
    if (url.endsWith("/admin/system-info")) return json({ errors: [{ detail: "Database unavailable" }] }, 503);
    if (url.endsWith("/admin/operations-center")) return json(operation());
    if (url.includes("maintenance-windows/preview"))
      return json({ data: resource("windows", { enabled: false, windows: [] }) });
    throw new Error(url);
  }) as unknown as typeof fetch;
  const view = show();
  await waitFor(() => {
    expect(view.getByText("Database unavailable")).toBeTruthy();
  });
  expect(view.getByText("unknown")).toBeTruthy();
  expect(view.getByText(/No node heartbeats recorded/)).toBeTruthy();
  expect(view.getByText("Edit maintenance windows")).toBeTruthy();
});

test("backup verification only starts after the user confirms a source copy", async () => {
  const writes: { url: string; body: { data: { attributes: Record<string, unknown> } } }[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    if (url.endsWith("/admin/operations-center")) return json(operation());
    if (init?.method === "POST") {
      writes.push({ url, body: JSON.parse(requestBodyText(init.body)) });
      return json({
        data: resource("verification", {
          passed: true,
          checks: [{ code: "database-integrity", status: "pass", detail: "Verified copy" }],
        }),
      });
    }
    throw new Error(url);
  }) as unknown as typeof fetch;
  const view = show("backups");
  await waitFor(() => {
    expect(view.getByText(/No successful restore rehearsal/)).toBeTruthy();
  });
  expect(writes).toHaveLength(0);
  fireEvent.input(view.getByLabelText("Backup path"), { target: { value: "/backups/copy" } });
  fireEvent.click(view.getByRole("button", { name: "Verify integrity" }));
  expect(writes).toHaveLength(0);
  const confirm = view.getByRole("button", { name: "Continue" });
  expect(confirm.hasAttribute("disabled")).toBe(true);
  fireEvent.click(view.getByLabelText(/This is an operator-created/));
  fireEvent.click(confirm);
  await waitFor(() => {
    expect(view.getByText("Verified copy")).toBeTruthy();
  });
  expect(writes).toHaveLength(1);
  expect(writes[0]?.url).toBe("/api/v2/admin/backups/integrity-checks");
  expect(writes[0]?.body.data.attributes["backup-path"]).toBe("/backups/copy");
});

test("webhook delivery paging and retries use fixed application endpoints", async () => {
  const requests: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/actions/retry")) return json({ data: resource("failed-job", { status: "pending" }) });
    if (url.includes("webhook-deliveries?"))
      return json({
        data: [
          resource("failed-job", {
            status: "failed",
            repository: "org/repo",
            provider: "github",
            "event-name": "push",
            attempts: 2,
          }),
          resource("done-job", { status: "processed", repository: "org/other", provider: "github" }),
        ],
        meta: { pagination: { "current-page": 1, "total-pages": 2, "total-count": 22 } },
      });
    throw new Error(url);
  }) as unknown as typeof fetch;
  const view = show("webhooks");
  await waitFor(() => {
    expect(view.getByText("org/repo")).toBeTruthy();
  });
  expect(view.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  expect(requests.some((item) => item.startsWith("POST"))).toBe(false);
  fireEvent.click(view.getByRole("button", { name: "Retry delivery" }));
  await waitFor(() => {
    expect(requests.some((item) => item === "POST /api/v2/admin/webhook-deliveries/failed-job/actions/retry")).toBe(
      true,
    );
  });
  await waitFor(() => {
    expect(view.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
  });
  fireEvent.click(view.getByRole("button", { name: "Next" }));
  await waitFor(() => {
    expect(requests.some((item) => item.includes("page[number]=2"))).toBe(true);
  });
});

test("support bundle actions never require or call the separate System API", async () => {
  const requests: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "POST")
      return json({ data: resource("support-1", { status: "finished", nodes: [{ node: "local" }] }) }, 202);
    return json({ data: [] });
  }) as unknown as typeof fetch;
  const view = show("support");
  await waitFor(() => {
    expect(view.getByText("No retained support bundles.")).toBeTruthy();
  });
  fireEvent.click(view.getByRole("button", { name: "Generate local bundle" }));
  expect(requests.filter((item) => item.startsWith("POST"))).toHaveLength(0);
  fireEvent.click(view.getByRole("button", { name: "Generate bundle" }));
  await waitFor(() => {
    expect(requests).toContain("POST /api/v2/admin/support-bundles");
  });
  expect(requests.every((item) => !item.includes("/api/v1/"))).toBe(true);
});
