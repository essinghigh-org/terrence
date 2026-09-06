import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { WorkspaceGettingStarted } from "../src/components/WorkspaceGettingStarted";

afterEach(cleanup);
const defaults = { orgName: "homelab", workspaceName: "network", engine: "tofu", hasRepository: false, localExecution: false, canQueueRun: true, canUpdate: true, canReadVariable: true };

test("CLI onboarding uses the workspace engine and actual connection names without proposing an apply", () => {
  const view = render(<MemoryRouter><WorkspaceGettingStarted {...defaults} /></MemoryRouter>);
  expect(view.getByText(/backend "remote"/).textContent).toContain('organization = "homelab"');
  expect(view.getByText(/backend "remote"/).textContent).toContain('name = "network"');
  const commands = view.getByText(/tofu login/).textContent;
  expect(commands).toContain("tofu init\ntofu plan");
  expect(commands).not.toContain("apply");
  expect(view.getByRole("link", { name: "Configure variables" }).getAttribute("href")).toBe("/app/homelab/workspaces/network/variables");
  expect(view.queryByRole("link", { name: "Start first plan" })).toBeNull();
});

test("connected repositories get a first-plan action while read-only users get no mutation links", () => {
  const view = render(<MemoryRouter><WorkspaceGettingStarted {...defaults} hasRepository /></MemoryRouter>);
  expect(view.queryByText(/backend "remote"/)).toBeNull();
  expect(view.getByRole("link", { name: "Start first plan" }).getAttribute("href")).toBe("/app/homelab/workspaces/network/runs?new-run=true");
  view.rerender(<MemoryRouter><WorkspaceGettingStarted {...defaults} hasRepository canQueueRun={false} canUpdate={false} canReadVariable={false} /></MemoryRouter>);
  expect(view.queryByRole("link", { name: "Start first plan" })).toBeNull();
  expect(view.queryByRole("link", { name: "Configure variables" })).toBeNull();
});

test("local execution keeps CLI instructions even when a repository is attached", () => {
  const view = render(<MemoryRouter><WorkspaceGettingStarted {...defaults} engine="terraform" hasRepository localExecution /></MemoryRouter>);
  expect(view.getByText(/terraform login/)).toBeTruthy();
  expect(view.getByText("Plans execute on your computer. Terrence stores the state.")).toBeTruthy();
  expect(view.queryByRole("link", { name: "Start first plan" })).toBeNull();
});

test("readiness checklist distinguishes setup work from a workspace ready to plan", () => {
  const view = render(<MemoryRouter><WorkspaceGettingStarted {...defaults} /></MemoryRouter>);
  expect(view.getByRole("heading", { name: "Workspace readiness" })).toBeTruthy();
  expect(view.getByText("Setup required")).toBeTruthy();
  expect(view.getByText("Configuration connection is still needed")).toBeTruthy();

  view.rerender(
    <MemoryRouter>
      <WorkspaceGettingStarted {...defaults} hasRepository />
    </MemoryRouter>,
  );
  expect(view.getByText("Ready for a plan")).toBeTruthy();
  expect(view.getByText("Repository is connected")).toBeTruthy();
});

test("readiness checks verify inputs and remote run capability without reading secret values", async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("/api/v2/workspaces/ws-1/vars")) {
      return new Response(JSON.stringify({ data: [{ id: "var-1", attributes: { key: "TOKEN" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/vnd.api+json" },
      });
    }
    if (url === "/api/v2/meta") {
      return new Response(JSON.stringify({ data: { attributes: { "run-sandbox": { enabled: true, available: true } } } }), {
        status: 200,
        headers: { "Content-Type": "application/vnd.api+json" },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    const view = render(
      <MemoryRouter>
        <WorkspaceGettingStarted {...defaults} workspaceId="ws-1" hasRepository />
      </MemoryRouter>,
    );
    expect(view.getByText(/Secret values are never fetched/)).toBeTruthy();
    await waitFor((): void => {
      expect(view.getByText("Variable access is configured; code-specific requirements are verified by a plan.")).toBeTruthy();
      expect(view.getByText("The remote run sandbox is available.")).toBeTruthy();
    });
    expect(view.getByText("The Terrence worker is the execution target.")).toBeTruthy();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
