import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { StateHistory } from "../src/views/StateHistory";

const originalFetch = globalThis.fetch;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("loads every state-version page without showing a false empty state", async () => {
  let resolveFirstPage: ((response: Response) => void) | undefined;
  const firstPage = new Promise<Response>((resolve): void => {
    resolveFirstPage = resolve;
  });
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/workspaces/ws-1/state-versions") return await firstPage;
    if (url === "/api/v2/workspaces/ws-1/state-versions?page%5Bnumber%5D=2") {
      return json({
        data: [{ id: "sv-1", attributes: { serial: 1, state: "{\"name\":\"secondary\"}" } }],
        meta: { pagination: { "next-page": null } },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(<StateHistory workspaceId="ws-1" />);

  expect(view.getByRole("status").textContent).toContain("Loading state versions");
  expect(view.queryByText("No state versions recorded yet.")).toBeNull();

  await act(async (): Promise<void> => {
    resolveFirstPage?.(json({
      data: [{ id: "sv-2", attributes: { serial: 2, state: "{\"name\":\"primary\"}" } }],
      meta: { pagination: { "next-page": 2 } },
    }));
    await firstPage;
  });

  await waitFor((): void => {
    expect(view.getByText("sv-2")).toBeTruthy();
    expect(view.getByText("sv-1")).toBeTruthy();
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(view.getAllByRole("button", { name: "Download state" })).toHaveLength(2);

  fireEvent.click(view.getAllByRole("button", { name: "View JSON" })[0]!);
  expect(view.getByRole("dialog").textContent).toContain("\"name\": \"primary\"");
});

test("shows a retryable error separately from the empty state", async () => {
  let attempt = 0;
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url !== "/api/v2/workspaces/ws-1/state-versions") {
      throw new Error(`Unexpected request: ${url}`);
    }
    attempt += 1;
    return attempt === 1
      ? json({ errors: [{ status: "503", detail: "State service unavailable" }] }, 503)
      : json({ data: [], meta: { pagination: { "next-page": null } } });
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(<StateHistory workspaceId="ws-1" />);

  await waitFor((): void => {
    expect(view.getByRole("alert").textContent).toContain("State service unavailable");
  });
  expect(view.queryByText("No state versions recorded yet.")).toBeNull();

  fireEvent.click(view.getByRole("button", { name: "Try again" }));

  await waitFor((): void => {
    expect(view.getByText("No state versions recorded yet.")).toBeTruthy();
  });
  expect(view.queryByRole("alert")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("uploads a Terraform state file and adds the new state version", async () => {
  const uploadedState = JSON.stringify({ version: 4, serial: 17, lineage: "lineage", resources: [] });
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/workspaces/ws-1/state-versions") return json({ data: [], meta: { pagination: { "next-page": null } } });
    if (url === "/api/v2/workspaces/ws-1/state-versions/upload") {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(uploadedState);
      return json({ data: { id: "sv-uploaded", attributes: { serial: 1, status: "Finalized" } } }, 201);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(<StateHistory workspaceId="ws-1" />);
  await waitFor((): void => {
    expect(view.getByText("No state versions recorded yet.")).toBeTruthy();
  });

  const file = new File([uploadedState], "terraform.tfstate", { type: "application/json" });
  fireEvent.change(view.getByLabelText("Upload Terraform/OpenTofu state"), { target: { files: [file] } });

  await waitFor((): void => {
    expect(view.getByText("sv-uploaded")).toBeTruthy();
  });
  expect(view.getByRole("button", { name: "Upload state" })).toBeTruthy();
});
