import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { WorkspaceSettings } from "../src/components/WorkspaceSettings";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

const json = (data: JsonValue, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });

const getUrl = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.toString() : input.url;

afterEach((): void => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
});

function mockOrgDefault(value: string | null): void {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = getUrl(input);
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: value === null ? {} : { "default-iac-binary": value } } });
    }
    return json({ data: [] }, 404);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;
}

function agentWorkspace(explicit: string | null): Record<string, unknown> {
  return {
    id: "ws-engine",
    attributes: {
      name: "engine",
      ...(explicit === null ? {} : { "iac-binary": explicit }),
      "execution-mode": "agent",
      "setting-overwrites": { "execution-mode": true },
      permissions: { "can-update": false },
    },
  };
}

// Issue #600: settings must show the workspace value next to the effective
// engine, and warn when agent runs will ignore the organization default.
const exactText = (wanted: string): ((_: string | null, el: Element | null) => boolean) => {
  return (_: string | null, el: Element | null): boolean => el?.textContent === wanted;
};

test("shows the effective engine and warns when agents ignore a tofu org default", async () => {
  mockOrgDefault("tofu");
  const view = render(
    <WorkspaceSettings
      orgName="acme"
      workspace={agentWorkspace(null) as never}
      onSaved={(): void => { /* assertions read the DOM, not the callback */ }}
    />,
  );
  await view.findByText(exactText("Binary used for plans and applies. Effective engine: Terraform (agent execution default)."));
  await view.findByText(exactText("Agent runs will use Terraform."));
});

test("shows the workspace value when an engine is set explicitly", async () => {
  mockOrgDefault("tofu");
  const view = render(
    <WorkspaceSettings
      orgName="acme"
      workspace={agentWorkspace("terraform") as never}
      onSaved={(): void => { /* assertions read the DOM, not the callback */ }}
    />,
  );
  await view.findByText(exactText("Binary used for plans and applies. Effective engine: Terraform (this workspace)."));
  expect(view.queryByText(exactText("Agent runs will use Terraform."))).toBeNull();
});

test("stays quiet for agent runs when the org default is already terraform", async () => {
  mockOrgDefault("terraform");
  const view = render(
    <WorkspaceSettings
      orgName="acme"
      workspace={agentWorkspace(null) as never}
      onSaved={(): void => { /* assertions read the DOM, not the callback */ }}
    />,
  );
  await view.findByText(exactText("Binary used for plans and applies. Effective engine: Terraform (agent execution default)."));
  expect(view.queryByText(exactText("Agent runs will use Terraform."))).toBeNull();
});
