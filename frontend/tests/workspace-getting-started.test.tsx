import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
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
