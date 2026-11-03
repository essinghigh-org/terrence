import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { RegistryArtifactTags } from "../src/components/RegistryArtifactTags";

const originalFetch = globalThis.fetch;
afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});
const response = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/vnd.api+json" } });
const existing = [{ id: "tagb-1", type: "tag-bindings", attributes: { key: "team", value: "platform" } }];
function setup(canManage: boolean, data = existing): ReturnType<typeof render> {
  globalThis.fetch = mock(async (): Promise<Response> => response({ data })) as unknown as typeof fetch;
  return render(
    <RegistryArtifactTags
      artifactId="mod-1"
      kind="modules"
      updatePath="/organizations/acme/registry-modules/private/acme/vpc/aws"
      canManage={canManage}
    />,
  );
}

test("read-only users see metadata without edit controls", async (): Promise<void> => {
  const view = setup(false);
  await view.findByText("team: platform");
  expect(view.queryByRole("button", { name: "Edit tags" })).toBeNull();
});

test("empty artifact tags are explicit and editable for managers", async (): Promise<void> => {
  const view = setup(true, []);
  await view.findByText("No artifact tags.");
  fireEvent.click(view.getByRole("button", { name: "Edit tags" }));
  fireEvent.click(view.getByRole("button", { name: "Add tag" }));
  expect(view.getByRole("button", { name: "Save tags" }).hasAttribute("disabled")).toBe(true);
  fireEvent.input(view.getByLabelText("Tag 1 key"), { target: { value: "owner" } });
  expect(view.getByRole("button", { name: "Save tags" }).hasAttribute("disabled")).toBe(false);
});

test("manager updates values, validates duplicate keys, and cancels without a write", async (): Promise<void> => {
  const view = setup(true);
  await view.findByText("team: platform");
  fireEvent.click(view.getByRole("button", { name: "Edit tags" }));
  fireEvent.click(view.getByRole("button", { name: "Add tag" }));
  fireEvent.input(view.getByLabelText("Tag 2 key"), { target: { value: "team" } });
  expect(view.getByRole("button", { name: "Save tags" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  expect(view.getByText("team: platform")).toBeDefined();
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

test("saving metadata uses the artifact relationship without overwriting publication settings", async (): Promise<void> => {
  const view = setup(true);
  await view.findByText("team: platform");
  let savedBody: unknown;
  let savedPath = "";
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    savedPath = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    savedBody = JSON.parse(typeof init?.body === "string" ? init.body : "null");
    expect(init?.method).toBe("PATCH");
    return response({ data: {} });
  }) as unknown as typeof fetch;
  fireEvent.click(view.getByRole("button", { name: "Edit tags" }));
  fireEvent.input(view.getByLabelText("Tag 1 value"), { target: { value: "security" } });
  fireEvent.click(view.getByRole("button", { name: "Save tags" }));
  await view.findByText("Artifact tags saved.");
  expect(savedPath).toContain("/organizations/acme/registry-modules/private/acme/vpc/aws");
  expect(savedBody).toEqual({
    data: {
      type: "registry-modules",
      relationships: {
        "tag-bindings": { data: [{ type: "tag-bindings", attributes: { key: "team", value: "security" } }] },
      },
    },
  });
  expect(view.getByText("team: security")).toBeDefined();
});

test("providers can clear all bindings and save failures preserve the editable draft", async (): Promise<void> => {
  globalThis.fetch = mock(async (): Promise<Response> => response({ data: existing })) as unknown as typeof fetch;
  const view = render(
    <RegistryArtifactTags
      artifactId="prov-1"
      kind="providers"
      updatePath="/organizations/acme/registry-providers/private/acme/test"
      canManage
    />,
  );
  await view.findByText("team: platform");
  globalThis.fetch = mock(
    async (): Promise<Response> => response({ errors: [{ title: "Write rejected" }] }, 422),
  ) as unknown as typeof fetch;
  fireEvent.click(view.getByRole("button", { name: "Edit tags" }));
  fireEvent.click(view.getByRole("button", { name: "Remove tag 1" }));
  fireEvent.click(view.getByRole("button", { name: "Save tags" }));
  await waitFor((): void => {
    expect(view.getByRole("alert").textContent).toContain("Write rejected");
  });
  expect(view.getByRole("button", { name: "Save tags" })).toBeDefined();
  let savedBody: unknown;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    savedBody = JSON.parse(typeof init?.body === "string" ? init.body : "null");
    return response({ data: {} });
  }) as unknown as typeof fetch;
  fireEvent.click(view.getByRole("button", { name: "Save tags" }));
  await view.findByText("Artifact tags saved.");
  expect(savedBody).toEqual({ data: { type: "registry-providers", relationships: { "tag-bindings": { data: [] } } } });
  expect(view.getByText("No artifact tags.")).toBeDefined();
});

test("failed tag reads can be retried and never offer editing unknown bindings", async (): Promise<void> => {
  globalThis.fetch = mock(
    async (): Promise<Response> => response({ errors: [{ title: "Unavailable" }] }, 500),
  ) as unknown as typeof fetch;
  const view = render(<RegistryArtifactTags artifactId="mod-1" kind="modules" updatePath="/unused" canManage />);
  await view.findByRole("alert");
  expect(view.queryByRole("button", { name: "Edit tags" })).toBeNull();
  globalThis.fetch = mock(async (): Promise<Response> => response({ data: existing })) as unknown as typeof fetch;
  fireEvent.click(view.getByRole("button", { name: "Retry loading tags" }));
  await view.findByText("team: platform");
  expect(view.getByRole("button", { name: "Edit tags" })).toBeDefined();
});

test.each([true, false])(
  "provider detail exposes artifact tags with manage-providers permission %s",
  async (canManage): Promise<void> => {
    const { MemoryRouter, Route, Routes } = await import("react-router-dom");
    const { RegistryProviderDetail } = await import("../src/views/RegistryProviderDetail");
    globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/organizations/acme"))
        return response({ data: { attributes: { permissions: { "can-manage-providers": canManage } } } });
      if (url.endsWith("/tag-bindings")) return response({ data: existing });
      if (url.endsWith("/versions")) return response({ data: [] });
      if (url.endsWith("/registry-providers/private/acme/example")) return response({ data: { id: "prov-1" } });
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const view = render(
      <MemoryRouter initialEntries={["/app/acme/registry/providers/acme/example"]}>
        <Routes>
          <Route path="/app/:orgName/registry/providers/:namespace/:name" element={<RegistryProviderDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await view.findByText("team: platform");
    expect(view.getByText("No provider versions")).toBeDefined();
    expect(view.queryByRole("button", { name: "Edit tags" }) !== null).toBe(canManage);
  },
);
