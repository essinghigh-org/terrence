import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

import { TokenScopeDialog } from "../src/components/TokenScopeDialog";

const originalFetch = globalThis.fetch;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("lists organizations from JSON:API attributes and scopes the token to the real org id", async () => {
  let postedBody: unknown = null;
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/organizations?page[size]=100") {
      return json({
        data: [
          { id: "zorg", type: "organizations", attributes: { name: "zorg", "external-id": "org-222" } },
          { id: "acme-org", type: "organizations", attributes: { name: "acme-org", "external-id": "org-111" } },
        ],
      });
    }
    if (url === "/api/v2/organizations/acme-org/projects?page[size]=100") {
      return json({ data: [{ id: "prj-1", type: "projects", attributes: { name: "payments" } }] });
    }
    if (url === "/api/v2/organizations/acme-org/workspaces?page[size]=100") {
      return json({ data: [{ id: "ws-1", type: "workspaces", attributes: { name: "prod-us" } }] });
    }
    if (url === "/api/v2/tokens" && init?.method === "POST") {
      postedBody = JSON.parse(String(init.body));
      return json({ data: { id: "tok-1", type: "tokens", attributes: { token: "secret", scopes: null } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  let created: unknown = null;
  const view = render(
    <TokenScopeDialog open onOpenChange={(): void => { /* noop */ }} onCreated={(token): void => { created = token; }} />,
  );

  const dialog = await view.findByRole("dialog");
  fireEvent.click(within(dialog).getByText("Fine-grained"));
  const orgSelect = within(dialog).getByLabelText("Organization") as HTMLSelectElement;
  await waitFor((): void => {
    expect(orgSelect.options.length).toBe(2);
  });
  // Sorted by display name; the option value is the DB id, not the JSON:API id.
  expect(orgSelect.options[0]?.textContent).toBe("acme-org");
  expect(orgSelect.options[0]?.value).toBe("org-111");
  expect(orgSelect.options[1]?.textContent).toBe("zorg");
  expect(orgSelect.value).toBe("org-111");

  // Projects + workspaces parse name from attributes.
  await waitFor((): void => {
    expect(within(dialog).getByText("payments")).toBeTruthy();
    expect(within(dialog).getByText("prod-us")).toBeTruthy();
  });

  // Select a couple of the expanded permission grants.
  fireEvent.click(within(dialog).getByText("Lock and unlock workspaces"));
  fireEvent.click(within(dialog).getByText("Read organization audit logs"));
  fireEvent.click(within(dialog).getByText("Apply plans (also allows discarding and canceling runs)"));

  fireEvent.click(within(dialog).getByRole("button", { name: "Create token" }));

  await waitFor((): void => {
    expect(postedBody).not.toBeNull();
  });
  const attributes = (postedBody as { data: { attributes: Record<string, unknown> } }).data.attributes;
  expect(attributes["scopes"]).toEqual({
    version: 1,
    orgs: ["org-111"],
    projects: null,
    workspaces: null,
    tags: null,
    permissions: {
      "workspaces:lock": true,
      "audit-logs:read": true,
      "runs:apply": true,
    },
  });
  expect(created).toEqual({ id: "tok-1", type: "tokens", attributes: { token: "secret", scopes: null } });
});

test("builds a (foo=bar AND baz=bing) OR xyz=abc tag rule", async () => {
  let postedBody: unknown = null;
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/organizations?page[size]=100") {
      return json({ data: [{ id: "acme-org", type: "organizations", attributes: { name: "acme-org", "external-id": "org-111" } }] });
    }
    if (url === "/api/v2/organizations/acme-org/projects?page[size]=100") {
      return json({ data: [] });
    }
    if (url === "/api/v2/organizations/acme-org/workspaces?page[size]=100") {
      return json({ data: [] });
    }
    if (url === "/api/v2/tokens" && init?.method === "POST") {
      postedBody = JSON.parse(String(init.body));
      return json({ data: { id: "tok-2", type: "tokens", attributes: { token: "secret", scopes: null } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <TokenScopeDialog open onOpenChange={(): void => { /* noop */ }} onCreated={(): void => { /* noop */ }} />,
  );

  const dialog = await view.findByRole("dialog");
  fireEvent.click(within(dialog).getByText("Fine-grained"));
  await waitFor((): void => {
    expect((within(dialog).getByLabelText("Organization") as HTMLSelectElement).options.length).toBe(1);
  });

  const keyInputs = (): HTMLElement[] => within(dialog).getAllByLabelText("Tag key");
  const valueInputs = (): HTMLElement[] => within(dialog).getAllByLabelText("Tag value");
  const combinators = (): HTMLElement[] => within(dialog).getAllByLabelText("Combine with");

  // First condition: foo=bar at the root.
  fireEvent.input(keyInputs()[0] as HTMLElement, { target: { value: "foo" } });
  fireEvent.input(valueInputs()[0] as HTMLElement, { target: { value: "bar" } });

  // Wrap it into a nested group, then switch that group to AND.
  fireEvent.click(within(dialog).getByRole("button", { name: "group" }));
  await waitFor((): void => {
    expect(combinators().length).toBe(2);
  });
  fireEvent.change(combinators()[1] as HTMLElement, { target: { value: "AND" } });

  // Add a condition inside the nested group: baz=bing.
  const addConditionButtons = (): HTMLElement[] => within(dialog).getAllByRole("button", { name: "Add condition" });
  fireEvent.click(addConditionButtons()[1] as HTMLElement);
  await waitFor((): void => {
    expect(keyInputs().length).toBe(2);
  });
  fireEvent.input(keyInputs()[1] as HTMLElement, { target: { value: "baz" } });
  fireEvent.input(valueInputs()[1] as HTMLElement, { target: { value: "bing" } });

  // Add a sibling condition at the root: xyz=abc.
  fireEvent.click(addConditionButtons()[0] as HTMLElement);
  await waitFor((): void => {
    expect(keyInputs().length).toBe(3);
  });
  fireEvent.input(keyInputs()[2] as HTMLElement, { target: { value: "xyz" } });
  fireEvent.input(valueInputs()[2] as HTMLElement, { target: { value: "abc" } });

  // Live label renders the nested expression.
  await waitFor((): void => {
    expect(within(dialog).getByText("(foo=bar AND baz=bing) OR xyz=abc")).toBeTruthy();
  });

  fireEvent.click(within(dialog).getByRole("button", { name: "Create token" }));
  await waitFor((): void => {
    expect(postedBody).not.toBeNull();
  });
  const attributes = (postedBody as { data: { attributes: Record<string, unknown> } }).data.attributes;
  expect(attributes["scopes"]).toEqual({
    version: 1,
    orgs: ["org-111"],
    projects: null,
    workspaces: null,
    tags: {
      combinator: "OR",
      rules: [
        { combinator: "AND", rules: [{ key: "foo", value: "bar" }, { key: "baz", value: "bing" }] },
        { key: "xyz", value: "abc" },
      ],
    },
    permissions: {},
  });
});
