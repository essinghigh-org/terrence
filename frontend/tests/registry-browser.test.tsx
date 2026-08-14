import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { RegistrySettingsRedirect } from "../src/App";
import { Registry } from "../src/views/Registry";
import { RegistryModuleDetail } from "../src/views/RegistryModuleDetail";

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

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <span>{location.pathname}{location.search}</span>;
}

const moduleResource = (canManage = false): Record<string, unknown> => ({
  id: "mod-network",
  type: "registry-modules",
  attributes: {
    name: "network",
    namespace: "acme",
    provider: "aws",
    description: "Reusable network foundations.",
    status: "setup_complete",
    "publishing-mechanism": "vcs",
    "publishing-workflow": "tag",
    "created-at": "2026-08-01T12:00:00.000Z",
    "updated-at": "2026-08-02T12:00:00.000Z",
    "last-successful-sync-at": "2026-08-02T12:00:00.000Z",
    "version-statuses": [{ version: "2.0.0", status: "ok", deprecated: false, revoked: false }, { version: "1.0.0", status: "ok", deprecated: false, revoked: false }],
    "vcs-repo": {
      identifier: "acme/terraform-network",
      "display-identifier": "acme/terraform-network",
      "repository-url": "https://github.com/acme/terraform-network",
      "source-directory": "modules/network",
      "tag-prefix": "network-v",
    },
    permissions: { "can-delete": canManage, "can-resync": canManage, "can-retry": canManage },
  },
});

const section = (path: string, readme: string): Record<string, unknown> => ({
  path,
  readme,
  description: "Network module",
  inputs: [
    { name: "region", type: "string", description: "AWS region", required: true, sensitive: false, nullable: false },
    { name: "zones", type: "list(string)", description: "Availability zones", defaultValue: ["a", "b"], required: false, sensitive: false, nullable: true },
  ],
  outputs: [{ name: "vpc_id", description: "VPC identifier", sensitive: false }],
  providers: [{ name: "aws", source: "hashicorp/aws", versionConstraint: ">= 5.0" }],
  modules: [{ name: "labels", source: "terraform-aws-modules/label/null", versionConstraint: "1.0.0" }],
  resources: [
    { name: "main", type: "aws_vpc", mode: "managed" },
    { name: "current", type: "aws_caller_identity", mode: "data" },
  ],
});

const versionResource = (id: string, version: string, readme: string): Record<string, unknown> => ({
  id,
  type: "registry-module-versions",
  attributes: {
    version,
    status: "ok",
    deprecated: false,
    revoked: false,
    "published-at": "2026-08-02T12:00:00.000Z",
    tag: `network-v${version}`,
    "commit-sha": "0123456789abcdef",
    metadata: {
      ...section(".", readme),
      submodules: [section("modules/child", "# Child docs")],
      examples: [section("examples/basic", "# Basic example")],
      diagnostics: [],
    },
  },
});

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("browses and filters registry cards with distinct module permissions", async () => {
  const requests: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    requests.push(url);
    if (url === "/api/v2/organizations/acme") return json({ data: { attributes: { permissions: { "can-manage-providers": true, "can-manage-modules": false } } } });
    if (url.startsWith("/api/v2/organizations/acme/registry-modules?")) return json({ data: [moduleResource()], meta: { pagination: { "total-pages": 2 }, providers: ["aws", "azurerm"] } });
    if (url === "/api/v2/organizations/acme/registry-providers") return json({ data: [{ id: "provider-sendgrid", attributes: { name: "sendgrid", namespace: "acme", "registry-name": "private", "created-at": "2026-08-01T12:00:00.000Z" } }] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(<MemoryRouter initialEntries={["/app/acme/registry"]}><Routes><Route path="/app/:orgName/registry" element={<Registry />} /></Routes></MemoryRouter>);
  const title = await view.findByText("network");
  expect(title.closest("a")?.getAttribute("href")).toBe("/app/acme/registry/modules/acme/network/aws");
  expect(view.queryByRole("button", { name: "Publish module" })).toBeNull();
  expect(view.getByRole("option", { name: "azurerm" })).toBeTruthy();

  changeInput(view.getByRole("searchbox", { name: "Search registry" }), "net");
  fireEvent.change(view.getByRole("combobox", { name: "Filter by provider" }), { target: { value: "aws" } });
  fireEvent.change(view.getByRole("combobox", { name: "Filter by publishing type" }), { target: { value: "vcs" } });
  await waitFor((): void => {
    const latest = new URL(requests.filter((url): boolean => url.includes("registry-modules?")).at(-1) ?? "", "http://localhost");
    expect(latest.searchParams.get("q")).toBe("net");
    expect(latest.searchParams.get("filter[provider]")).toBe("aws");
    expect(latest.searchParams.get("filter[publishing_mechanism]")).toBe("vcs");
  });
  fireEvent.click(view.getByRole("button", { name: "Next" }));
  await waitFor((): void => { expect(requests.some((url): boolean => url.includes("page%5Bnumber%5D=2"))).toBeTrue(); });

  fireEvent.click(view.getByRole("link", { name: "Providers" }));
  changeInput(view.getByRole("searchbox", { name: "Search registry" }), "");
  const provider = await view.findByText("sendgrid");
  expect(provider.closest("a")?.getAttribute("href")).toBe("/app/acme/registry/providers/acme/sendgrid");
});

test("shows loading, retryable errors, and an honest empty state", async () => {
  let attempts = 0;
  let resolveFirst!: (response: Response) => void;
  const first = new Promise<Response>((resolve): void => { resolveFirst = resolve; });
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme") return json({ data: { attributes: { permissions: { "can-manage-modules": true } } } });
    if (url.startsWith("/api/v2/organizations/acme/registry-modules?")) {
      attempts += 1;
      if (attempts === 1) return first;
      return json({ data: [], meta: { pagination: { "total-pages": 1 }, providers: [] } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(<MemoryRouter initialEntries={["/app/acme/registry"]}><Routes><Route path="/app/:orgName/registry" element={<Registry />} /></Routes></MemoryRouter>);
  expect(view.getByRole("status").textContent).toContain("Loading registry");
  resolveFirst(json({ errors: [{ detail: "Registry service unavailable" }] }, 503));
  await view.findByText("Registry service unavailable");
  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  await view.findByText("No private modules");
  expect(view.getByRole("button", { name: "Publish module" })).toBeTruthy();
});

test("renders version-specific module documentation, usage, lifecycle, and keyboard tabs", async () => {
  const requests: Readonly<{ method: string; url: string }>[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    if (url === "/api/v2/organizations/acme/registry-modules/private/acme/network/aws") return json({ data: moduleResource(true) });
    if (url === "/api/v2/registry-modules/mod-network/versions") return json({ data: [versionResource("version-2", "2.0.0", "# Version two"), versionResource("version-1", "1.0.0", "# Root docs")] });
    if (url === "/api/v2/registry-module-versions/version-1" && method === "PATCH") return json({ data: versionResource("version-1", "1.0.0", "# Root docs") });
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  const view = render(<MemoryRouter initialEntries={["/app/acme/registry/modules/acme/network/aws?version=1.0.0"]}><Routes><Route path="/app/:orgName/registry/modules/:namespace/:name/:provider" element={<RegistryModuleDetail />} /></Routes></MemoryRouter>);
  await view.findByRole("heading", { name: "Root docs" });
  expect(view.getByText(/localhost\/acme\/network\/aws/)).toBeTruthy();
  expect(view.getByText(/<TERRAFORM_API_TOKEN>/)).toBeTruthy();
  expect(view.getByRole("button", { name: "Settings" })).toBeTruthy();

  fireEvent.click(view.getByRole("tab", { name: /Inputs/ }));
  expect(view.getByText("Required")).toBeTruthy();
  expect(view.getByText("Optional")).toBeTruthy();
  fireEvent.click(view.getByRole("tab", { name: /Outputs/ }));
  expect(view.getByText("vpc_id")).toBeTruthy();
  fireEvent.click(view.getByRole("tab", { name: /Dependencies/ }));
  expect(view.getByText("hashicorp/aws")).toBeTruthy();
  expect(view.getByText("labels")).toBeTruthy();
  fireEvent.click(view.getByRole("tab", { name: /Resources/ }));
  expect(view.getByText("aws_vpc.main")).toBeTruthy();
  expect(view.getByText("Data source")).toBeTruthy();
  const resourcesTab = view.getByRole("tab", { name: /Resources/ });
  resourcesTab.focus();
  fireEvent.keyDown(resourcesTab, { key: "ArrowLeft" });
  expect(view.getByRole("tab", { name: /Dependencies/ }).getAttribute("aria-selected")).toBe("true");

  fireEvent.change(view.getByLabelText("Documentation section"), { target: { value: "modules/child" } });
  fireEvent.click(view.getByRole("tab", { name: "README" }));
  expect(view.getByRole("heading", { name: "Child docs" })).toBeTruthy();
  fireEvent.change(view.getByRole("combobox", { name: "Select module version" }), { target: { value: "2.0.0" } });
  expect(view.getByRole("heading", { name: "Version two" })).toBeTruthy();

  fireEvent.change(view.getByRole("combobox", { name: "Select module version" }), { target: { value: "1.0.0" } });
  fireEvent.click(view.getByRole("button", { name: "Deprecate" }));
  await waitFor((): void => { expect(requests.some((request): boolean => request.method === "PATCH" && request.url.endsWith("/registry-module-versions/version-1"))).toBeTrue(); });
});

test("keeps module management hidden from a read-only detail viewer", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url.endsWith("/organizations/acme/registry-modules/private/acme/network/aws")) return json({ data: moduleResource(false) });
    if (url.endsWith("/registry-modules/mod-network/versions")) return json({ data: [versionResource("version-1", "1.0.0", "# Root docs")] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const view = render(<MemoryRouter initialEntries={["/app/acme/registry/modules/acme/network/aws?version=1.0.0"]}><Routes><Route path="/app/:orgName/registry/modules/:namespace/:name/:provider" element={<RegistryModuleDetail />} /></Routes></MemoryRouter>);
  await view.findByRole("heading", { name: "Root docs" });
  expect(view.queryByRole("button", { name: "Settings" })).toBeNull();
  expect(view.queryByRole("button", { name: "Add version" })).toBeNull();
  expect(view.queryByText("Manage version")).toBeNull();
});

test("keeps legacy registry settings URLs as redirects", async () => {
  const modules = render(<MemoryRouter initialEntries={["/app/acme/settings/registry-modules"]}><Routes><Route path="/app/:orgName/settings/registry-modules" element={<RegistrySettingsRedirect tab="modules" />} /><Route path="/app/:orgName/registry" element={<LocationProbe />} /></Routes></MemoryRouter>);
  await modules.findByText("/app/acme/registry");
  modules.unmount();

  const providers = render(<MemoryRouter initialEntries={["/app/acme/settings/registry-providers"]}><Routes><Route path="/app/:orgName/settings/registry-providers" element={<RegistrySettingsRedirect tab="providers" />} /><Route path="/app/:orgName/registry" element={<LocationProbe />} /></Routes></MemoryRouter>);
  await providers.findByText("/app/acme/registry?tab=providers");
});
