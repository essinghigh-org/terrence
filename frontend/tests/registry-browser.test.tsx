import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

import { Layout } from "../src/components/Layout";
import { Registry } from "../src/views/Registry";

const originalFetch = globalThis.fetch;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete): void => {
    resolve = complete;
  });
  return { promise, resolve };
}

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("browses organization modules and providers through read-only registry contracts", async () => {
  const requests: Readonly<{ method: string | undefined; url: string }>[] = [];
  globalThis.fetch = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = urlOf(input);
    requests.push({ method: init?.method, url });
    if (url === "/api/v2/organizations/acme/registry-modules") {
      return json({
        data: [{
          id: "mod-network",
          type: "registry-modules",
          attributes: {
            name: "network",
            namespace: "acme",
            provider: "aws",
            "created-at": "2026-07-20T12:00:00.000Z",
          },
        }],
      });
    }
    if (url === "/api/v2/organizations/acme/registry-providers") {
      return json({
        data: [{
          id: "provider-sendgrid",
          type: "registry-providers",
          attributes: {
            name: "sendgrid",
            namespace: "acme",
            "registry-name": "private",
            "created-at": "2026-07-21T12:00:00.000Z",
          },
        }],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/registry"]}>
      <Routes>
        <Route path="/app/:orgName/registry" element={<Registry />} />
      </Routes>
    </MemoryRouter>,
  );

  await view.findByText("network");
  expect(view.getByText("acme/network/aws")).toBeTruthy();
  expect(view.getByRole("link", { name: "Modules" }).getAttribute("aria-current")).toBe("page");
  expect(requests.map(({ url }): string => url).sort()).toEqual([
    "/api/v2/organizations/acme/registry-modules",
    "/api/v2/organizations/acme/registry-providers",
  ]);
  expect(requests.every(({ method }): boolean => method === undefined)).toBeTrue();

  fireEvent.input(view.getByRole("searchbox", { name: "Search registry" }), {
    target: { value: "sendgrid" },
  });
  expect(view.getByText("No modules match your search")).toBeTruthy();

  fireEvent.click(view.getByRole("link", { name: "Providers" }));
  await view.findByText("sendgrid");
  expect(view.getByText("private/acme/sendgrid")).toBeTruthy();
  expect(view.getByRole("searchbox", { name: "Search registry" }).getAttribute("value"))
    .toBe("sendgrid");
  expect(view.getByRole("link", { name: "Providers" }).getAttribute("aria-current")).toBe("page");
  expect(view.queryByRole("button", { name: /publish/i })).toBeNull();
});

test("shows retryable errors and honest empty states", async () => {
  let moduleAttempts = 0;
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme/registry-modules") {
      moduleAttempts += 1;
      if (moduleAttempts === 1) {
        return json({ errors: [{ detail: "Registry service unavailable" }] }, 503);
      }
      return json({ data: [] });
    }
    if (url === "/api/v2/organizations/acme/registry-providers") {
      return json({ data: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/registry"]}>
      <Routes>
        <Route path="/app/:orgName/registry" element={<Registry />} />
      </Routes>
    </MemoryRouter>,
  );

  await view.findByText("Modules unavailable");
  expect(view.getByText("Registry service unavailable")).toBeTruthy();
  expect(view.queryByText("No private modules")).toBeNull();

  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  await view.findByText("No private modules");
  expect(moduleAttempts).toBe(2);

  fireEvent.click(view.getByRole("link", { name: "Providers" }));
  expect(view.getByText("No private providers")).toBeTruthy();
});

test("ignores aborted registry results after changing organizations", async () => {
  const acmeModules = deferred<Response>();
  const acmeProviders = deferred<Response>();
  let acmeModulesSignal: AbortSignal | null = null;
  let acmeProvidersSignal: AbortSignal | null = null;

  globalThis.fetch = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme/registry-modules") {
      acmeModulesSignal = init?.signal ?? null;
      return acmeModules.promise;
    }
    if (url === "/api/v2/organizations/acme/registry-providers") {
      acmeProvidersSignal = init?.signal ?? null;
      return acmeProviders.promise;
    }
    if (url === "/api/v2/organizations/platform/registry-modules") {
      return json({
        data: [{
          id: "mod-platform",
          attributes: {
            name: "platform-network",
            namespace: "platform",
            provider: "aws",
          },
        }],
      });
    }
    if (url === "/api/v2/organizations/platform/registry-providers") {
      return json({ data: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/registry"]}>
      <Link to="/app/platform/registry">Open platform registry</Link>
      <Routes>
        <Route path="/app/:orgName/registry" element={<Registry />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(acmeModulesSignal).not.toBeNull();
    expect(acmeProvidersSignal).not.toBeNull();
  });

  fireEvent.click(view.getByRole("link", { name: "Open platform registry" }));
  await view.findByText("platform-network");
  expect(acmeModulesSignal?.aborted).toBeTrue();
  expect(acmeProvidersSignal?.aborted).toBeTrue();

  await act(async (): Promise<void> => {
    acmeModules.resolve(json({
      data: [{
        id: "mod-acme",
        attributes: { name: "stale-acme-module", namespace: "acme", provider: "aws" },
      }],
    }));
    acmeProviders.resolve(json({ data: [] }));
    await Promise.resolve();
  });

  expect(view.queryByText("stale-acme-module")).toBeNull();
  expect(view.getByText("platform-network")).toBeTruthy();
});

test("marks Registry active in the organization sidebar", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/account/details") {
      return json({ data: { attributes: { username: "alice", "is-site-admin": false } } });
    }
    if (url === "/api/v2/organizations?page[size]=100") {
      return json({ data: [{ id: "org-acme", attributes: { name: "acme" } }] });
    }
    if (url === "/api/v2/organizations/acme") {
      return json({
        data: {
          attributes: {
            permissions: {
              "can-manage-workspaces": true,
              "can-read-projects": true,
            },
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/registry?tab=providers"]}>
      <Routes>
        <Route
          path="/app/:orgName/registry"
          element={<Layout><p>Registry content</p></Layout>}
        />
      </Routes>
    </MemoryRouter>,
  );

  await view.findByText("Registry content");
  const registryLinks = view.getAllByRole("link", { name: "Registry" });
  expect(registryLinks.some((link): boolean =>
    link.getAttribute("href") === "/app/acme/registry"
    && link.getAttribute("aria-current") === "page")).toBeTrue();
});
