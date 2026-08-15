import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

import { TokenScopeDialog } from "../src/components/TokenScopeDialog";
import { isString } from "../src/lib/type-guards";

const originalFetch = globalThis.fetch;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  return isString(input) ? input : input instanceof URL ? input.toString() : input.url;
}

type MockOrg = Readonly<{ id: string; externalId: string }>;
type MockChild = Readonly<{ id: string; name: string }>;

/** JSON:API create-token body captured by the fetch mock. */
type PostedBody = { data: { type: string; attributes: Record<string, unknown> } } | null;

/** Token resource passed to onCreated. */
type CreatedToken = { id: string; attributes: Record<string, unknown> };

function mockApi(options: { orgs?: MockOrg[]; projects?: MockChild[]; workspaces?: MockChild[] } = {}) {
  const orgs: MockOrg[] = options.orgs ?? [{ id: "acme-org", externalId: "org-111" }];
  const projects: MockChild[] = options.projects ?? [];
  const workspaces: MockChild[] = options.workspaces ?? [];
  let posted: PostedBody = null;
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input);
    const orgName = url.split("/")[4] ?? "";
    const org = orgs.find((o): boolean => o.id === orgName);
    if (url === "/api/v2/organizations?page[size]=100") {
      return json({
        data: orgs.map((o) => ({
          id: o.id,
          type: "organizations",
          attributes: { name: o.id, "external-id": o.externalId },
        })),
      });
    }
    if (org !== undefined && url === `/api/v2/organizations/${orgName}/projects?page[size]=100`) {
      return json({
        data: projects.map((p) => ({ id: p.id, type: "projects", attributes: { name: p.name } })),
      });
    }
    if (org !== undefined && url === `/api/v2/organizations/${orgName}/workspaces?page[size]=100`) {
      return json({
        data: workspaces.map((w) => ({ id: w.id, type: "workspaces", attributes: { name: w.name } })),
      });
    }
    if (url === "/api/v2/tokens" && init?.method === "POST") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      posted = JSON.parse(init.body as string);
      return json({ data: { id: "tok-1", type: "tokens", attributes: { token: "secret", scopes: null } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  return { postedBody: (): PostedBody => posted, fetchMock };
}

/** Testid anchors the root group plus every nested group (see TokenScopeDialog). */
function tagGroupQueries(dialog: HTMLElement) {
  const groups = (): HTMLElement[] => within(dialog).getAllByTestId("tag-group");
  const root = (): HTMLElement => groups()[0]!;
  const nested = (): HTMLElement | null => groups()[1] ?? null;
  const outsideNested = (els: HTMLElement[]): HTMLElement[] =>
    els.filter((el): boolean => !(nested()?.contains(el) ?? false));
  const inNested = (): HTMLElement[] => {
    const n = nested();
    return n === null ? [] : within(n).getAllByLabelText("Tag key");
  };
  return {
    rootKeys: (): HTMLElement[] => outsideNested(within(root()).getAllByLabelText("Tag key")),
    nestedKeys: inNested,
    rootCombinator: (): HTMLElement => outsideNested(within(root()).getAllByLabelText("Combine with"))[0]!,
    nestedCombinator: (): HTMLElement => (nested()!) ? within(nested()!).getByLabelText("Combine with") : (() => { throw new Error("no nested group"); })(),
    rootAddCondition: (): HTMLElement => outsideNested(within(root()).getAllByRole("button", { name: "Add condition" }))[0]!,
    nestedAddCondition: (): HTMLElement => (nested()!) ? within(nested()!).getByRole("button", { name: "Add condition" }) : (() => { throw new Error("no nested group"); })(),
  };
}

async function openFineGrainedDialog(): Promise<HTMLElement> {
  const view = render(
    <TokenScopeDialog open onOpenChange={(): void => { /* noop */ }} onCreated={(): void => { /* noop */ }} />,
  );
  const dialog = await view.findByRole("dialog");
  fireEvent.click(within(dialog).getByText("Fine-grained"));
  return dialog;
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("lists organizations from JSON:API attributes and scopes the token to the real org id", async () => {
  const { postedBody, fetchMock } = mockApi({
    orgs: [
      { id: "zorg", externalId: "org-222" },
      { id: "acme-org", externalId: "org-111" },
    ],
    projects: [{ id: "prj-1", name: "payments" }],
    workspaces: [{ id: "ws-1", name: "prod-us" }],
  });
  globalThis.fetch = fetchMock;

  let created: CreatedToken | null = null;
  const view = render(
    <TokenScopeDialog open onOpenChange={(): void => { /* noop */ }} onCreated={(token): void => { created = token; }} />,
  );

  const dialog = await view.findByRole("dialog");
  fireEvent.click(within(dialog).getByText("Fine-grained"));
// SAFETY: the component renders this element type for the queried role/label.
  const orgSelect = within(dialog).getByLabelText("Organization") as HTMLSelectElement;
  await waitFor((): void => {
    expect(orgSelect.options.length).toBe(2);
  });
  // Sorted by display name; the option value is the DB id, not the JSON:API id.
  expect(orgSelect.options[0]?.textContent).toBe("acme-org");
  expect(orgSelect.options[0]?.value).toBe("org-111");
  expect(orgSelect.options[1]?.textContent).toBe("zorg");
  expect(orgSelect.options[1]?.value).toBe("org-222");
  expect(orgSelect.value).toBe("org-111");

  // Projects + workspaces parse name from attributes.
  await waitFor((): void => {
    expect(within(dialog).getByText("payments")).toBeTruthy();
    expect(within(dialog).getByText("prod-us")).toBeTruthy();
  });

  // Select a couple of the expanded permission grants.
  fireEvent.click(within(dialog).getByText("Lock and unlock workspaces"));
  fireEvent.click(within(dialog).getByText("Read organization audit logs"));
  fireEvent.click(within(dialog).getByText("Apply plans to planned runs"));

  fireEvent.click(within(dialog).getByRole("button", { name: "Create token" }));

  await waitFor((): void => {
    expect(postedBody()).not.toBeNull();
  });
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
  const attributes = (postedBody() as { data: { attributes: Record<string, unknown> } }).data.attributes;
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
  const { postedBody, fetchMock } = mockApi();
  globalThis.fetch = fetchMock;

  const dialog = await openFineGrainedDialog();
  await waitFor((): void => {
// SAFETY: the component renders this element type for the queried role/label.
    expect((within(dialog).getByLabelText("Organization") as HTMLSelectElement).options.length).toBe(1);
  });
  const q = tagGroupQueries(dialog);

  // First condition: foo=bar at the root.
  fireEvent.input(q.rootKeys()[0]!, { target: { value: "foo" } });
  fireEvent.input(within(dialog).getAllByLabelText("Tag value")[0]!, { target: { value: "bar" } });

  // Wrap it into a nested group, then switch that group to AND.
  fireEvent.click(within(dialog).getByRole("button", { name: "group" }));
  await waitFor((): void => {
    expect(within(dialog).getAllByTestId("tag-group").length).toBe(2);
  });
  fireEvent.change(q.nestedCombinator(), { target: { value: "AND" } });

  // Add a condition inside the nested group: baz=bing.
  fireEvent.click(q.nestedAddCondition());
  await waitFor((): void => {
    expect(q.nestedKeys().length).toBe(2);
  });
  fireEvent.input(q.nestedKeys()[1]!, { target: { value: "baz" } });
  fireEvent.input(within(dialog).getAllByLabelText("Tag value")[1]!, { target: { value: "bing" } });

  // Add a sibling condition at the root: xyz=abc. (foo=bar was wrapped into
  // the nested group, so the root has exactly one key row again.)
  fireEvent.click(q.rootAddCondition());
  await waitFor((): void => {
    expect(q.rootKeys().length).toBe(1);
  });
  fireEvent.input(q.rootKeys()[0]!, { target: { value: "xyz" } });
  fireEvent.input(within(dialog).getAllByLabelText("Tag value")[2]!, { target: { value: "abc" } });

  // Live label renders the nested expression.
  await waitFor((): void => {
    expect(within(dialog).getByText("(foo=bar AND baz=bing) OR xyz=abc")).toBeTruthy();
  });

  fireEvent.click(within(dialog).getByRole("button", { name: "Create token" }));
  await waitFor((): void => {
    expect(postedBody()).not.toBeNull();
  });
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
  const attributes = (postedBody() as { data: { attributes: Record<string, unknown> } }).data.attributes;
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

test("root combinator changes leave nested groups untouched, and empty rows are pruned", async () => {
  const { postedBody, fetchMock } = mockApi();
  globalThis.fetch = fetchMock;

  const dialog = await openFineGrainedDialog();
  await waitFor((): void => {
// SAFETY: the component renders this element type for the queried role/label.
    expect((within(dialog).getByLabelText("Organization") as HTMLSelectElement).options.length).toBe(1);
  });
  const q = tagGroupQueries(dialog);

  // Build foo=bar OR baz=bing inside a nested group (default OR), then flip
  // the ROOT to AND: the payload must show root AND + nested OR. If a bug
  // made nested groups follow the root combinator, the nested OR would
  // silently become AND and the assertion would fail.
  fireEvent.input(q.rootKeys()[0]!, { target: { value: "foo" } });
  fireEvent.input(within(dialog).getAllByLabelText("Tag value")[0]!, { target: { value: "bar" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "group" }));
  await waitFor((): void => {
    expect(within(dialog).getAllByTestId("tag-group").length).toBe(2);
  });
  fireEvent.click(q.nestedAddCondition());
  await waitFor((): void => {
    expect(q.nestedKeys().length).toBe(2);
  });
  fireEvent.input(q.nestedKeys()[1]!, { target: { value: "baz" } });
  fireEvent.input(within(dialog).getAllByLabelText("Tag value")[1]!, { target: { value: "bing" } });

  fireEvent.change(q.rootCombinator(), { target: { value: "AND" } });

  // The empty root row (added below) must be pruned from the payload.
  fireEvent.click(q.rootAddCondition());
  await waitFor((): void => {
    expect(q.rootKeys().length).toBe(1);
  });

  fireEvent.click(within(dialog).getByRole("button", { name: "Create token" }));
  await waitFor((): void => {
    expect(postedBody()).not.toBeNull();
  });
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
  const attributes = (postedBody() as { data: { attributes: Record<string, unknown> } }).data.attributes;
  expect(attributes["scopes"]).toEqual({
    version: 1,
    orgs: ["org-111"],
    projects: null,
    workspaces: null,
    tags: {
      combinator: "AND",
      rules: [
        { combinator: "OR", rules: [{ key: "foo", value: "bar" }, { key: "baz", value: "bing" }] },
      ],
    },
    permissions: {},
  });
});