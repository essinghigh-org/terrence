import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Workspaces } from "../src/views/Workspaces";

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const row = (i: number) => ({ id: `ws-${i}`, attributes: { name: `workspace-${i}`, locked: false } });
const pageBody = (start: number, size: number, total = 10000) => ({
  data: Array.from({ length: size }, (_, i) => row(start + i)),
  meta: { pagination: { "total-count": total, "total-pages": Math.ceil(total / 50) }, "workspace-summary": { total, locked: 0, "run-statuses": {} } },
});
const renderList = () => render(<MemoryRouter initialEntries={["/app/acme"]}><Routes><Route path="/app/:orgName" element={<Workspaces />} /></Routes></MemoryRouter>);

test("renders one bounded page before auxiliary metadata, cancels old filters and resets pagination", async () => {
  const calls: { url: URL; signal: AbortSignal | null | undefined }[] = [];
  let finishProjects!: (response: Response) => void;
  let finishOldPage!: (response: Response) => void;
  const projects = new Promise<Response>((resolve) => { finishProjects = resolve; });
  const oldPage = new Promise<Response>((resolve) => { finishOldPage = resolve; });
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
    if (url.pathname.endsWith("/projects")) return projects;
    if (!url.pathname.endsWith("/workspaces")) return Response.json({ data: { attributes: { permissions: {} } } });
    calls.push({ url, signal: init?.signal });
    if (url.searchParams.get("page[number]") === "2") return oldPage;
    return Response.json(pageBody(url.searchParams.has("search[query]") ? 9000 : 0, 50));
  }) as unknown as typeof fetch;
  const view = renderList();
  await view.findByText("workspace-0");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url.searchParams.get("page[size]")).toBe("50");
  expect(view.getAllByRole("row")).toHaveLength(51);
  expect(view.getByText("Page 1 of 200")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: /^Next$/ }));
  await waitFor(() => { expect(calls).toHaveLength(2); });
  await act(async () => { fireEvent.input(view.getByLabelText("Search workspaces"), { target: { value: "needle" } }); });
  await view.findByText("workspace-9000");
  expect(calls[1]?.signal?.aborted).toBe(true);
  expect(calls[2]?.url.searchParams.get("page[number]")).toBe("1");
  await act(async () => { finishOldPage(Response.json(pageBody(50, 50))); finishProjects(Response.json({ data: [] })); });
  expect(view.queryByText("workspace-50")).toBeNull();
  expect(view.getByText("Page 1 of 200")).toBeTruthy();
  await act(async () => { fireEvent.input(view.getByLabelText("Search workspaces"), { target: { value: "" } }); });
  await view.findByText("workspace-0");
  expect(calls.at(-1)?.url.searchParams.get("page[number]")).toBe("1");
  expect(calls).toHaveLength(4);
});

test("export is explicit, reports progress and cancellation never publishes a partial file", async () => {
  const originalCreate = URL.createObjectURL.bind(URL);
  const originalRevoke = URL.revokeObjectURL.bind(URL);
  const downloads: Blob[] = [];
  let finishExport!: (response: Response) => void;
  let exportSignal: AbortSignal | null | undefined;
  let exports = 0;
  const click = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { /* Capture the download without navigating jsdom. */ });
  URL.createObjectURL = (blob) => { if (!(blob instanceof Blob)) throw new Error("Expected Blob download"); downloads.push(blob); return "blob:test-export"; };
  URL.revokeObjectURL = () => { /* The test URL holds no browser resources. */ };
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
    if (url.pathname.endsWith("/projects")) return Response.json({ data: [] });
    if (!url.pathname.endsWith("/workspaces")) return Response.json({ data: { attributes: { permissions: {} } } });
    if (url.searchParams.has("include")) return Response.json(pageBody(0, 50, 150));
    exports++;
    if (url.searchParams.get("page[number]") === "2") {
      exportSignal = init?.signal;
      return new Promise<Response>((resolve) => { finishExport = resolve; });
    }
    return Response.json({ data: Array.from({ length: 100 }, (_, i) => row(i)), meta: { pagination: { "next-page": 2 } } });
  }) as unknown as typeof fetch;
  try {
    const view = renderList();
    await view.findByText("workspace-0");
    expect(exports).toBe(0);
    fireEvent.click(view.getByRole("button", { name: "Export matching workspaces" }));
    await view.findByText("Exported 100 workspaces…");
    expect(downloads).toHaveLength(0);
    fireEvent.click(view.getByRole("button", { name: "Cancel export" }));
    expect(exportSignal?.aborted).toBe(true);
    await act(async () => { finishExport(Response.json({ data: [row(100)] })); });
    expect(downloads).toHaveLength(0);
    fireEvent.click(view.getByRole("button", { name: "Export matching workspaces" }));
    await view.findByText("Exported 100 workspaces…");
    await act(async () => { finishExport(Response.json({ data: Array.from({ length: 50 }, (_, i) => row(100 + i)), meta: { pagination: { "next-page": null } } })); });
    await waitFor(() => { expect(downloads).toHaveLength(1); });
    const payload = JSON.parse(await downloads[0]!.text());
    expect(payload.organization).toBe("acme");
    expect(payload.workspaces).toHaveLength(150);
    expect(new Set(payload.workspaces.map((workspace: { id: string }) => workspace.id)).size).toBe(150);
    expect(click).toHaveBeenCalledTimes(1);
  } finally { click.mockRestore(); URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
});
