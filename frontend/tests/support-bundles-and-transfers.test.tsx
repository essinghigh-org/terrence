import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { SupportBundles } from "../src/views/SupportBundles";
import { WorkspaceTransfers } from "../src/views/WorkspaceTransfers";

const originalFetch = globalThis.fetch;
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/vnd.api+json" },
});

afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

test("support bundle page lists bundles and starts a bundle", async () => {
  const fetchMock = mock(async (input: string | URL | Request, options?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (options?.method === "POST") return json({ data: { id: "bundle-new", attributes: { status: "generating", created_at: "2026-01-01T00:00:00Z", nodes: [] } } }, 202);
    return json({ data: [{ id: "bundle-1", attributes: { status: "finished", created_at: "2026-01-01T00:00:00Z", size_bytes: 1024, nodes: [{ node: "node-1", status: "finished" }] }, links: { download: "/api/v1/support/bundle-requests/bundle-1/download" } }] });
  });
  globalThis.fetch = fetchMock as typeof fetch;
  const view = render(<MemoryRouter><SupportBundles /></MemoryRouter>);
  await waitFor(() => { expect(view.getByText("bundle-1")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Create support bundle" }));
  await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith("/api/v1/support/bundle-requests", expect.objectContaining({ method: "POST" })); });
});

test("workspace transfers renders transfers and submits a transfer", async () => {
  const fetchMock = mock(async (input: string | URL | Request, options?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (options?.method === "POST") return json({ data: { id: "wt-new", attributes: { status: "pending" } } }, 201);
    return json({ data: [{ id: "wt-1", attributes: { status: "pending", "approval-mode": "auto", "created-at": "2026-01-01T00:00:00Z" }, relationships: {} }] });
  });
  globalThis.fetch = fetchMock as typeof fetch;
  const view = render(<MemoryRouter><WorkspaceTransfers /></MemoryRouter>);
  await waitFor(() => { expect(view.getByText("wt-1")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "New workspace transfer" }));
  fireEvent.change(view.getByLabelText("Source workspace"), { target: { value: "ws-1" } });
  fireEvent.change(view.getByLabelText("Destination organization"), { target: { value: "org-1" } });
  fireEvent.click(view.getByRole("button", { name: "Create transfer" }));
  await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith("/api/v2/workspace-transfers", expect.objectContaining({ method: "POST" })); });
});

