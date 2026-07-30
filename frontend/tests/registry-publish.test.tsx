import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { Registry } from "../src/views/Registry";

const originalFetch = globalThis.fetch;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

test("publishes a new registry module with version and archive upload", async () => {
  const requests: Readonly<{ method: string | undefined; url: string }>[] = [];
  let moduleId = "mod-new-vpc";
  let versionId = "modver-new-vpc-v1";

  globalThis.fetch = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url });

    const moduleListGets = requests.filter(
      (r): boolean => r.url === "/api/v2/organizations/acme/registry-modules" && r.method === "GET",
    );

    // GET: refetch after publish — return the new module (check first so it takes priority)
    if (url === "/api/v2/organizations/acme/registry-modules" && method === "GET" && moduleListGets.length >= 2) {
      return json({
        data: [{
          id: moduleId,
          type: "registry-modules",
          attributes: {
            name: "vpc",
            namespace: "acme",
            provider: "aws",
            "created-at": "2026-07-30T12:00:00.000Z",
          },
        }],
      });
    }

    // GET: refetch after publish — providers are still empty
    if (url === "/api/v2/organizations/acme/registry-providers" && method === "GET" && moduleListGets.length >= 2) {
      return json({ data: [] });
    }

    // GET: initial empty registry-modules list
    if (url === "/api/v2/organizations/acme/registry-modules" && method === "GET") {
      return json({ data: [] });
    }
    // GET: initial empty registry-providers list
    if (url === "/api/v2/organizations/acme/registry-providers" && method === "GET") {
      return json({ data: [] });
    }

    // POST: create module
    if (url === "/api/v2/organizations/acme/registry-modules" && method === "POST") {
      const body = JSON.parse(init?.body as string);
      const attrs = body.data?.attributes ?? {};
      return json({
        data: {
          id: moduleId,
          type: "registry-modules",
          attributes: {
            name: attrs.name ?? "vpc",
            namespace: attrs.namespace ?? "acme",
            provider: attrs.provider ?? "aws",
            "created-at": "2026-07-30T12:00:00.000Z",
          },
        },
      }, 201);
    }

    // POST: create version
    if (url === `/api/v2/registry-modules/${moduleId}/versions` && method === "POST") {
      const body = JSON.parse(init?.body as string);
      const version = body.data?.attributes?.version ?? "1.0.0";
      versionId = `modver-${moduleId}-${version}`;
      return json({
        data: {
          id: versionId,
          type: "registry-module-versions",
          attributes: { version, status: "pending" },
        },
      }, 201);
    }

    // PUT: upload archive
    if (url === `/api/v2/registry-module-versions/${versionId}/upload` && method === "PUT") {
      return json({
        data: {
          id: versionId,
          type: "registry-module-versions",
          attributes: { status: "ok" },
        },
      }, 200);
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/registry"]}>
      <Routes>
        <Route path="/app/:orgName/registry" element={<Registry />} />
      </Routes>
    </MemoryRouter>,
  );

  // Wait for initial empty state
  await view.findByText("No private modules");

  // There should be a publish button
  const publishButton = view.getByRole("button", { name: /publish/i });
  expect(publishButton).toBeTruthy();

  // Click publish to open modal
  fireEvent.click(publishButton);

  // Wait for dialog content to appear — the DialogTitle should be visible
  await view.findByRole("heading", { name: /publish module/i });

  // Fill in module details using the field's id
  const nameInput = view.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
  fireEvent.input(nameInput, { target: { value: "vpc" } });

  const providerInput = view.getByRole("textbox", { name: "Provider" }) as HTMLInputElement;
  fireEvent.input(providerInput, { target: { value: "aws" } });

  // Click "Create module" to proceed
  const createButton = view.getByRole("button", { name: /create module/i });
  fireEvent.click(createButton);

  // After creating the module, the dialog should show the version step
  await view.findByRole("heading", { name: /publish version/i });

  // Fill version
  const versionInput = view.getByRole("textbox", { name: "Version" }) as HTMLInputElement;
  fireEvent.input(versionInput, { target: { value: "1.0.0" } });

  // Click publish version
  const publishVersionBtn = view.getByRole("button", { name: /publish version$/i });
  fireEvent.click(publishVersionBtn);

  // Wait for the modal to close and the module list to refresh
  await waitFor((): void => {
    expect(view.queryByRole("heading", { name: /publish/i })).toBeNull();
  });

  // The new module should appear in the list
  await view.findByText("vpc");
  expect(view.getByText("acme/vpc/aws")).toBeTruthy();
});

test("publish button is absent when registry fails to load", async () => {
  globalThis.fetch = mock(async (): Promise<Response> => {
    return json({ errors: [{ detail: "Registry unavailable" }] }, 503);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/registry"]}>
      <Routes>
        <Route path="/app/:orgName/registry" element={<Registry />} />
      </Routes>
    </MemoryRouter>,
  );

  await view.findByText("Modules unavailable");
  expect(view.queryByRole("button", { name: /publish/i })).toBeNull();
});

test("publish modal can be cancelled", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";
    if (url === "/api/v2/organizations/acme/registry-modules" && method === "GET") {
      return json({ data: [] });
    }
    if (url === "/api/v2/organizations/acme/registry-providers" && method === "GET") {
      return json({ data: [] });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/registry"]}>
      <Routes>
        <Route path="/app/:orgName/registry" element={<Registry />} />
      </Routes>
    </MemoryRouter>,
  );

  await view.findByText("No private modules");

  fireEvent.click(view.getByRole("button", { name: /publish/i }));
  await view.findByRole("heading", { name: /publish module/i });

  fireEvent.click(view.getByRole("button", { name: /cancel/i }));
  await waitFor((): void => {
    expect(view.queryByRole("heading", { name: /publish/i })).toBeNull();
  });
});

test("shows validation errors on empty required fields in publish modal", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";
    if (url === "/api/v2/organizations/acme/registry-modules" && method === "GET") {
      return json({ data: [] });
    }
    if (url === "/api/v2/organizations/acme/registry-providers" && method === "GET") {
      return json({ data: [] });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/registry"]}>
      <Routes>
        <Route path="/app/:orgName/registry" element={<Registry />} />
      </Routes>
    </MemoryRouter>,
  );

  await view.findByText("No private modules");

  fireEvent.click(view.getByRole("button", { name: /publish/i }));
  await view.findByRole("heading", { name: /publish module/i });

  // Click create without filling required fields
  fireEvent.click(view.getByRole("button", { name: /create module/i }));

  // Validation error should appear
  await view.findByText(/name is required/i);
});
