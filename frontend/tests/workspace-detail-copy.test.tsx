import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, waitFor, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { WorkspaceDetail } from "../src/views/WorkspaceDetail";
import { Toaster } from "../src/components/ui/toast";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;
const originalClipboard = navigator.clipboard;

function json(data: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/vnd.api+json" } });
}

function urlOf(input: string | URL | Request): string {
  return isString(input) ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
  Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
});

function workspaceFetchMock(clipboard: { writeText: (text: string) => Promise<void> }): typeof fetch {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  return mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: { name: "production", "auto-apply": false, "iac-binary": "tofu", locked: false },
        },
      });
    }
    if (url.startsWith("/api/v2/workspaces/ws-1/runs")) return json({ data: [] });
    if (url.startsWith("/api/v2/workspaces/ws-1/vars")) return json({ data: [] });
    return json({ data: [] });
  }) as typeof fetch;
}

test("copies the workspace ID to the clipboard on success", async () => {
  const writeText = mock(async (text: string): Promise<void> => { expect(text).toBe("ws-1"); });
  const clipboard = { writeText };
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });

  globalThis.fetch = workspaceFetchMock(clipboard);

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
      <Routes>
        <Route path="/app/:orgName/workspaces/:workspaceName" element={<WorkspaceDetail />} />
      </Routes>
      <Toaster />
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByLabelText("Copy workspace ID")).toBeTruthy(); });

  fireEvent.click(view.getByLabelText("Copy workspace ID"));

  await waitFor((): void => { expect(writeText).toHaveBeenCalledWith("ws-1"); });
  await waitFor((): void => { expect(view.getByText("Workspace ID copied")).toBeTruthy(); });
});

test("shows an error toast when copying the workspace id fails", async () => {
  const clipboard = {
    writeText: mock(async (): Promise<void> => { throw new Error("Clipboard blocked"); }),
  };
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });

  globalThis.fetch = workspaceFetchMock(clipboard);

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
      <Routes>
        <Route path="/app/:orgName/workspaces/:workspaceName" element={<WorkspaceDetail />} />
      </Routes>
      <Toaster />
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByLabelText("Copy workspace ID")).toBeTruthy(); });

  fireEvent.click(view.getByLabelText("Copy workspace ID"));

  await waitFor((): void => { expect(view.getByText("Could not copy workspace ID")).toBeTruthy(); });
});

test("links the configured GitHub repository and shows its working directory", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme/workspaces/production") {
      return json({
        data: {
          id: "ws-1",
          attributes: {
            name: "production",
            "vcs-repo": {
              identifier: "acme/infrastructure",
              "github-app-installation-id": "ghain-1",
            },
            "working-directory": "environments/production",
            "iac-binary": "tofu",
            "terraform-version": "1.9.3",
            locked: false,
          },
        },
      });
    }
    if (url === "/api/v2/workspaces/ws-1/runs?page[size]=1") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/workspaces/production"]}>
      <Routes>
        <Route path="/app/:orgName/workspaces/:workspaceName" element={<WorkspaceDetail />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Workspace details")).toBeTruthy(); });
  const repositoryLink = view.getByRole("link", { name: "Open GitHub repository acme/infrastructure" });
  expect(repositoryLink.getAttribute("href")).toBe("https://github.com/acme/infrastructure");
  expect(repositoryLink.getAttribute("target")).toBe("_blank");
  expect(view.getByText("environments/production")).toBeTruthy();
  expect(view.getByText("OpenTofu")).toBeTruthy();
});