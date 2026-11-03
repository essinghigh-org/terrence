import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StackPolicySets, stackScopeAction } from "../src/views/StackPolicySets";
import { TfpolicyVersionsAdmin, validateTfpolicyVersion } from "../src/views/admin/tfpolicy-versions";
const originalFetch = globalThis.fetch;
afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});
const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/vnd.api+json" } });
const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
const binary = { os: "linux", arch: "amd64", url: "https://example.com/binary", sha: "a".repeat(64) };
const attributes = {
  version: "0.2.0",
  official: false,
  enabled: true,
  beta: false,
  deprecated: false,
  "deprecated-reason": null,
  archs: [binary],
};
const policy = {
  id: "ps-one",
  attributes: { name: "Security", kind: "tfpolicy", global: false },
  relationships: { stacks: { data: [] as { id: string }[] } },
};
const noop = (): void => {
  /* keep test dialog mounted */
};
test("scope distinguishes inclusion and global exclusion", (): void => {
  expect(stackScopeAction(policy, "st-one").relationship).toBe("stacks");
  expect(
    stackScopeAction(
      {
        ...policy,
        attributes: { ...policy.attributes, global: true },
        relationships: { "stack-exclusions": { data: [{ id: "st-one" }] } },
      },
      "st-one",
    ),
  ).toMatchObject({ relationship: "stack-exclusions", remove: true });
});
test("Stack scope paginates, warns, confirms mutation and supports read-only", async (): Promise<void> => {
  const writes: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (init?.method === "POST") {
      writes.push({
        url,
        method: init.method,
        body: JSON.parse(typeof init.body === "string" ? init.body : "null") as unknown,
      });
      return new Response(null, { status: 204 });
    }
    if (url.includes("page[number]=1")) return json({ data: [], meta: { pagination: { "next-page": 2 } } });
    return json({ data: [policy] });
  }) as typeof fetch;
  const view = render(
    <MemoryRouter>
      <StackPolicySets
        orgName="acme"
        stack={{ id: "st-one", attributes: { name: "Production" } }}
        canManage
        onClose={noop}
      />
    </MemoryRouter>,
  );
  await waitFor((): void => {
    expect(view.getByText("Security")).toBeTruthy();
  });
  expect(view.getByText(/tfpolicy execution is not supported/)).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Include Stack" }));
  expect(writes).toHaveLength(0);
  fireEvent.click(view.getByRole("button", { name: "Save scope" }));
  await waitFor((): void => {
    expect(writes).toHaveLength(1);
  });
  expect(writes[0]).toEqual({
    url: "/api/v2/policy-sets/ps-one/relationships/stacks",
    method: "POST",
    body: { data: [{ id: "st-one", type: "stacks" }] },
  });
  view.unmount();
  const read = render(
    <MemoryRouter>
      <StackPolicySets
        orgName="acme"
        stack={{ id: "st-one", attributes: { name: "Production" } }}
        canManage={false}
        onClose={noop}
      />
    </MemoryRouter>,
  );
  await waitFor((): void => {
    expect(read.getByText("Security")).toBeTruthy();
  });
  expect(read.queryByRole("button", { name: "Include Stack" })).toBeNull();
});
test("catalog validates checksums, URLs, duplicate architectures and deprecation", (): void => {
  expect(validateTfpolicyVersion(attributes)).toBeNull();
  expect(validateTfpolicyVersion({ ...attributes, archs: [{ ...binary, sha: "bad" }] })).toContain("SHA-256");
  expect(validateTfpolicyVersion({ ...attributes, archs: [{ ...binary, url: "file:///bad" }] })).toContain("HTTP");
  expect(validateTfpolicyVersion({ ...attributes, archs: [binary, binary] })).toContain("unique");
  expect(validateTfpolicyVersion({ ...attributes, deprecated: true })).toContain("reason");
});
test("catalog edits complete metadata, clears deprecation and protects official deletion", async (): Promise<void> => {
  const writes: unknown[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.method === "PATCH") {
      writes.push(JSON.parse(typeof init.body === "string" ? init.body : "null") as unknown);
      return json({ data: {} });
    }
    return json({
      data: [
        { id: "tool-one", attributes: { ...attributes, official: true, deprecated: true, "deprecated-reason": "Old" } },
      ],
    });
  }) as typeof fetch;
  const view = render(<TfpolicyVersionsAdmin />);
  await waitFor((): void => {
    expect(view.getByRole("button", { name: "Edit tfpolicy 0.2.0" })).toBeTruthy();
  });
  expect((view.getByRole("button", { name: "Delete tfpolicy 0.2.0" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(view.getByRole("button", { name: "Edit tfpolicy 0.2.0" }));
  fireEvent.click(view.getByRole("checkbox", { name: "Deprecated" }));
  fireEvent.click(view.getByRole("button", { name: "Save tfpolicy version" }));
  await waitFor((): void => {
    expect(writes).toHaveLength(1);
  });
  expect(writes[0]).toMatchObject({
    data: { type: "tfpolicy-versions", attributes: { ...attributes, official: true, "deprecated-reason": null } },
  });
});

test("Stack exclusions DELETE the correct relationship and tag scope prevents adding", async (): Promise<void> => {
  const writes: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.method === "DELETE") {
      writes.push(urlOf(input));
      return new Response(null, { status: 204 });
    }
    return json({
      data: [
        {
          ...policy,
          attributes: { ...policy.attributes, global: true },
          relationships: { "stack-exclusions": { data: [{ id: "st-one" }] } },
        },
        {
          ...policy,
          id: "ps-tag",
          attributes: { ...policy.attributes, name: "Tagged", "tag-selectors": [{ "tag-key": "env" }] },
        },
      ],
    });
  }) as typeof fetch;
  const view = render(
    <MemoryRouter>
      <StackPolicySets
        orgName="acme"
        stack={{ id: "st-one", attributes: { name: "Production" } }}
        canManage
        onClose={noop}
      />
    </MemoryRouter>,
  );
  await waitFor((): void => {
    expect(view.getByText("Tagged")).toBeTruthy();
  });
  expect((view.getByRole("button", { name: "Include Stack" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(view.getByRole("button", { name: "Remove exclusion" }));
  fireEvent.click(view.getByRole("button", { name: "Save scope" }));
  await waitFor((): void => {
    expect(writes).toEqual(["/api/v2/policy-sets/ps-one/relationships/stack-exclusions"]);
  });
});

test("catalog registers a version, paginates and confirms custom-version deletion", async (): Promise<void> => {
  const writes: { method: string; body?: unknown }[] = [];
  const reads: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.method === "POST" || init?.method === "DELETE") {
      writes.push({
        method: init.method,
        ...(init.body === undefined
          ? {}
          : { body: JSON.parse(typeof init.body === "string" ? init.body : "null") as unknown }),
      });
      return init.method === "DELETE" ? new Response(null, { status: 204 }) : json({ data: {} });
    }
    reads.push(urlOf(input));
    return json({
      data: [{ id: "tool-one", attributes }],
      meta: { pagination: { "next-page": urlOf(input).includes("page[number]=1") ? 2 : null } },
    });
  }) as typeof fetch;
  const view = render(<TfpolicyVersionsAdmin />);
  await waitFor((): void => {
    expect(view.getByRole("button", { name: "Delete tfpolicy 0.2.0" })).toBeTruthy();
  });
  fireEvent.click(view.getByRole("button", { name: "Next versions" }));
  await waitFor((): void => {
    expect(reads.some((url): boolean => url.includes("page[number]=2"))).toBe(true);
  });
  fireEvent.click(view.getByRole("button", { name: "Register tfpolicy version" }));
  fireEvent.input(view.getByLabelText("Version"), { target: { value: "0.3.0" } });
  fireEvent.input(view.getByLabelText("Download URL"), { target: { value: binary.url } });
  fireEvent.input(view.getByLabelText("SHA-256"), { target: { value: binary.sha } });
  fireEvent.click(view.getByRole("button", { name: "Save tfpolicy version" }));
  await waitFor((): void => {
    expect(writes).toHaveLength(1);
  });
  expect(writes[0]).toMatchObject({
    method: "POST",
    body: { data: { attributes: { ...attributes, version: "0.3.0" } } },
  });
  await waitFor((): void => {
    expect(view.getByRole("button", { name: "Delete tfpolicy 0.2.0" })).toBeTruthy();
  });
  fireEvent.click(view.getByRole("button", { name: "Delete tfpolicy 0.2.0" }));
  expect(writes).toHaveLength(1);
  fireEvent.click(view.getByRole("button", { name: "Delete version" }));
  await waitFor((): void => {
    expect(writes).toHaveLength(2);
  });
  expect(writes[1]).toEqual({ method: "DELETE" });
}, 15000);

test("catalog preserves edits when the API rejects a save", async (): Promise<void> => {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.method === "PATCH")
      return new Response(JSON.stringify({ errors: [{ title: "Duplicate version" }] }), {
        status: 422,
        headers: { "Content-Type": "application/vnd.api+json" },
      });
    return json({ data: [{ id: "tool-one", attributes }] });
  }) as typeof fetch;
  const view = render(<TfpolicyVersionsAdmin />);
  await waitFor((): void => {
    expect(view.getByRole("button", { name: "Edit tfpolicy 0.2.0" })).toBeTruthy();
  });
  fireEvent.click(view.getByRole("button", { name: "Edit tfpolicy 0.2.0" }));
  fireEvent.click(view.getByRole("button", { name: "Add binary" }));
  expect(view.getAllByLabelText("Architecture")).toHaveLength(2);
  fireEvent.click(view.getByRole("button", { name: "Remove binary 2" }));
  expect(view.getAllByLabelText("Architecture")).toHaveLength(1);
  fireEvent.click(view.getByRole("button", { name: "Save tfpolicy version" }));
  await waitFor((): void => {
    expect(view.getByRole("alert").textContent).toContain("Duplicate version");
  });
  expect(view.getByRole("button", { name: "Save tfpolicy version" })).toBeTruthy();
});
