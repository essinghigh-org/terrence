import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { Registry } from "../src/views/Registry";

const originalFetch = globalThis.fetch;
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/vnd.api+json" },
});
const urlOf = (input: string | URL | Request): string => typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

function changeInput(element: HTMLElement, value: string): void {
  fireEvent.input(element, { target: { value } });
  fireEvent.change(element, { target: { value } });
}

function moduleResource(id: string, name: string, provider: string, mechanism: "vcs" | "manual" = "vcs") {
  return {
    id,
    type: "registry-modules",
    attributes: {
      name,
      namespace: "acme",
      provider,
      status: "setup_complete",
      "publishing-mechanism": mechanism,
      "publishing-workflow": mechanism === "vcs" ? "tag" : null,
      "version-statuses": [{ version: "1.0.0", status: "ok", deprecated: false, revoked: false }],
      permissions: { "can-delete": true, "can-resync": mechanism === "vcs" },
    },
  };
}

function baseResponse(url: string): Response | null {
  if (url === "/api/v2/organizations/acme") return json({ data: { attributes: { permissions: { "can-manage-modules": true, "can-manage-providers": false } } } });
  if (url.startsWith("/api/v2/organizations/acme/registry-modules?")) return json({ data: [], meta: { pagination: { "total-pages": 1 }, providers: [] } });
  if (url === "/api/v2/organizations/acme/github-app/installations") return json({ data: [{ id: "installation-1", attributes: { name: "Acme GitHub" } }] });
  if (url === "/api/v2/organizations/acme/oauth-clients") return json({ data: [] });
  if (url === "/api/v2/organizations/acme/vcs-connections/github-app%3Ainstallation-1/repositories") return json({ data: [
    { attributes: { identifier: "acme/terraform-network", name: "terraform-network", owner: "acme" } },
    { attributes: { identifier: "acme/terraform-storage", name: "terraform-storage", owner: "acme" } },
  ] });
  return null;
}

function renderRegistry(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/app/acme/registry"]}>
      <Routes>
        <Route path="/app/:orgName/registry" element={<Registry />} />
        <Route path="/app/:orgName/registry/modules/:namespace/:name/:provider" element={<p>Module detail landing</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openPublish(view: ReturnType<typeof render>): Promise<void> {
  fireEvent.click(await view.findByRole("button", { name: "Publish module" }));
  await view.findByRole("heading", { name: "Publish module" });
}

async function selectRepository(view: ReturnType<typeof render>): Promise<void> {
  fireEvent.change(await view.findByLabelText("VCS connection"), { target: { value: "github-app:installation-1" } });
  const repository = await view.findByRole("combobox", { name: "Repository" });
  fireEvent.focus(repository);
  await view.findByRole("option", { name: /acme\/terraform-network/ });
  fireEvent.keyDown(repository, { key: "ArrowDown" });
  await waitFor((): void => { expect(repository.getAttribute("aria-activedescendant")).not.toBeNull(); });
  fireEvent.keyDown(repository, { key: "Enter" });
  expect((repository as HTMLInputElement).value).toBe("acme/terraform-network");
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("publishes a tag-based VCS module with the existing keyboard repository picker", async () => {
  let payload: Record<string, unknown> | null = null;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const base = baseResponse(url);
    if (base !== null) return base;
    if (url === "/api/v2/organizations/acme/registry-modules/vcs" && init?.method === "POST") {
      payload = JSON.parse(init.body as string) as Record<string, unknown>;
      return json({ data: moduleResource("mod-vcs", "network", "aws") }, 201);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;

  const view = renderRegistry();
  await openPublish(view);
  await selectRepository(view);
  changeInput(view.getByLabelText("Module name"), "network");
  changeInput(view.getByLabelText("Provider"), "aws");
  changeInput(view.getByLabelText("Source directory"), "modules/network");
  changeInput(view.getByLabelText("Tag prefix"), "network-v");
  fireEvent.click(view.getByRole("button", { name: "Publish from VCS" }));
  await view.findByText("Module detail landing");

  const attributes = ((payload?.data as Record<string, unknown>).attributes as Record<string, unknown>);
  expect(attributes["module-name"]).toBe("network");
  expect(attributes["module-provider"]).toBe("aws");
  expect(attributes["source-directory"]).toBe("modules/network");
  expect(attributes["tag-prefix"]).toBe("network-v");
  expect(attributes["vcs-repo"]).toEqual({
    identifier: "acme/terraform-network",
    "display-identifier": "acme/terraform-network",
    "github-app-installation-id": "installation-1",
  });
});

test("publishes branch configuration with branch and initial version", async () => {
  let attributes: Record<string, unknown> | null = null;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const base = baseResponse(url);
    if (base !== null) return base;
    if (url.endsWith("/registry-modules/vcs") && init?.method === "POST") {
      const body = JSON.parse(init.body as string) as { data: { attributes: Record<string, unknown> } };
      attributes = body.data.attributes;
      return json({ data: moduleResource("mod-branch", "network", "azurerm") }, 201);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;

  const view = renderRegistry();
  await openPublish(view);
  await selectRepository(view);
  fireEvent.click(view.getByLabelText("Branch-based"));
  changeInput(view.getByLabelText("Module name"), "network");
  changeInput(view.getByLabelText("Provider"), "azurerm");
  changeInput(view.getByLabelText("Source directory"), "terraform/module");
  changeInput(view.getByLabelText("Branch"), "release");
  changeInput(view.getByLabelText("Initial version"), "3.2.1");
  fireEvent.click(view.getByRole("button", { name: "Publish from VCS" }));
  await view.findByText("Module detail landing");
  expect(attributes?.["source-directory"]).toBe("terraform/module");
  expect(attributes?.version).toBe("3.2.1");
  expect((attributes?.["vcs-repo"] as Record<string, unknown>)["branch"]).toBe("release");
  expect(attributes?.["tag-prefix"]).toBe("");
});

test("manual publication uploads the selected archive bytes and retries without duplicate records", async () => {
  const archive = new File([new Uint8Array([31, 139, 8, 1, 2, 3, 4])], "network.tar.gz", { type: "application/gzip" });
  const uploadBodies: BodyInit[] = [];
  let moduleCreates = 0;
  let versionCreates = 0;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const base = baseResponse(url);
    if (base !== null) return base;
    if (url === "/api/v2/organizations/acme/registry-modules" && init?.method === "POST") {
      moduleCreates += 1;
      return json({ data: moduleResource("mod-manual", "network", "aws", "manual") }, 201);
    }
    if (url === "/api/v2/registry-modules/mod-manual/versions" && init?.method === "POST") {
      versionCreates += 1;
      return json({ data: { id: "version-manual", attributes: { version: "1.0.0", status: "pending" } } }, 201);
    }
    if (url === "/api/v2/registry-module-versions/version-manual/upload" && init?.method === "PUT") {
      uploadBodies.push(init.body as BodyInit);
      if (uploadBodies.length === 1) return json({ errors: [{ detail: "Archive traversal detected" }] }, 422);
      return json({ data: { id: "version-manual", attributes: { status: "ok" } } });
    }
    if (url === "/api/v2/registry-modules/mod-manual") return json({ data: moduleResource("mod-manual", "network", "aws", "manual") });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;

  const view = renderRegistry();
  await openPublish(view);
  fireEvent.click(view.getByLabelText(/^Module archive/));
  changeInput(view.getByLabelText("Module name"), "network");
  changeInput(view.getByLabelText("Provider"), "aws");
  changeInput(view.getByLabelText("Version"), "1.0.0");
  fireEvent.change(view.getByLabelText("Module archive", { selector: 'input[type="file"]' }), { target: { files: [archive] } });
  fireEvent.click(view.getByRole("button", { name: "Upload module" }));
  await view.findByText("Archive traversal detected");
  expect(uploadBodies[0]).toBe(archive);
  expect([...new Uint8Array(await (uploadBodies[0] as Blob).arrayBuffer())]).toEqual([31, 139, 8, 1, 2, 3, 4]);

  fireEvent.click(view.getByRole("button", { name: "Retry upload" }));
  await view.findByText("Module detail landing");
  expect(moduleCreates).toBe(1);
  expect(versionCreates).toBe(1);
  expect(uploadBodies).toEqual([archive, archive]);
});

test("cancelling after a failed manual upload removes the staged module", async () => {
  let deleted = false;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const base = baseResponse(url);
    if (base !== null) return base;
    if (url === "/api/v2/organizations/acme/registry-modules" && init?.method === "POST") return json({ data: moduleResource("mod-staged", "network", "aws", "manual") }, 201);
    if (url === "/api/v2/registry-modules/mod-staged/versions" && init?.method === "POST") return json({ data: { id: "version-staged" } }, 201);
    if (url === "/api/v2/registry-module-versions/version-staged/upload" && init?.method === "PUT") return json({ errors: [{ detail: "Expanded archive is too large" }] }, 422);
    if (url === "/api/v2/registry-modules/mod-staged" && init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;

  const view = renderRegistry();
  await openPublish(view);
  fireEvent.click(view.getByLabelText(/^Module archive/));
  changeInput(view.getByLabelText("Module name"), "network");
  changeInput(view.getByLabelText("Provider"), "aws");
  fireEvent.change(view.getByLabelText("Module archive", { selector: 'input[type="file"]' }), { target: { files: [new File(["real"], "network.tar.gz")] } });
  fireEvent.click(view.getByRole("button", { name: "Upload module" }));
  await view.findByText("Expanded archive is too large");
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  await waitFor((): void => { expect(deleted).toBeTrue(); });
});
