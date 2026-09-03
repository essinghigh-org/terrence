import { afterEach, expect, mock, test } from "bun:test";
import type { Mock } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { Layout } from "../src/components/Layout";
import { Docs } from "../src/views/Docs";
import { DocsIndexProvider } from "../src/lib/docs-index";
import { isString } from "../src/lib/type-guards";
import type { JsonObject, JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

const json = (data: JsonValue): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

const getUrl = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.toString() : input.url;

const docsIndex = {
  data: [
    { attributes: { slug: "overview", title: "Overview", category: "Getting started", order: 1, description: "What Terrence is." } },
    { attributes: { slug: "quickstart", title: "Quickstart", category: "Getting started", order: 2, description: "First steps." } },
    { attributes: { slug: "workspaces", title: "Workspaces", category: "Workspaces", order: 10, description: "Manage workspaces." } },
    { attributes: { slug: "variables", title: "Variables", category: "Workspaces", order: 20, description: "Manage variables." } },
  ],
};

const docDetail = (slug: string, title: string, category: string, order: number, description: string, markdown: string): JsonObject => ({
  data: {
    attributes: { slug, title, category, order, description, markdown },
  },
});

function installFetchMock(): Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>> {
  const fetchMock = mock(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = getUrl(input);
    if (url === "/api/v2/docs") return json(docsIndex);
    if (url === "/api/v2/docs/overview") {
      return json(docDetail("overview", "Overview", "Getting started", 1, "What Terrence is.", "# Overview docs\n\n[Read variables](variables)"));
    }
    if (url === "/api/v2/docs/quickstart") {
      return json(docDetail("quickstart", "Quickstart", "Getting started", 2, "First steps.", "# Quickstart docs\n\nContent."));
    }
    if (url === "/api/v2/docs/workspaces") {
      return json(docDetail("workspaces", "Workspaces", "Workspaces", 10, "Manage workspaces.", "# Workspaces docs\n\nContent."));
    }
    if (url === "/api/v2/docs/variables") {
      return json(docDetail("variables", "Variables", "Workspaces", 20, "Manage variables.", "# Variables docs\n\nContent."));
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;
  return fetchMock;
}

function renderDocs(initialPath: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/app/docs"
          element={
            <DocsIndexProvider>
              <Layout />
            </DocsIndexProvider>
          }
        >
          <Route index element={<Docs />} />
          <Route path=":slug" element={<Docs />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function CurrentLocation(): React.JSX.Element {
  const location = useLocation();
  return (
    <output aria-label="Current location">
      {location.pathname}
    </output>
  );
}

afterEach((): void => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
});

test("renders the documentation tree in the application sidebar", async () => {
  installFetchMock();
  const view = render(
    <MemoryRouter initialEntries={["/app/docs/overview"]}>
      <CurrentLocation />
      <Routes>
        <Route
          path="/app/docs"
          element={
            <DocsIndexProvider>
              <Layout />
            </DocsIndexProvider>
          }
        >
          <Route index element={<Docs />} />
          <Route path=":slug" element={<Docs />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  // The active document's category is expanded; the others are collapsed.
  await waitFor((): void => {
    expect(view.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  });
  expect(view.getByRole("button", { name: "Getting started" }).getAttribute("aria-expanded")).toBe("true");
  expect(view.getByRole("button", { name: "Workspaces" }).getAttribute("aria-expanded")).toBe("false");
  // Collapsed categories do not render their documents.
  expect(view.queryByRole("link", { name: "Variables" })).toBeNull();

  // The back link leaves the documentation section.
  expect(view.getByRole("link", { name: "Organizations" }).getAttribute("href")).toBe("/app");

  // Expanding a category reveals its documents.
  fireEvent.click(view.getByRole("button", { name: "Workspaces" }));
  await waitFor((): void => {
    expect(view.getByRole("button", { name: "Workspaces" }).getAttribute("aria-expanded")).toBe("true");
  });
  expect(view.getByRole("link", { name: "Variables" })).toBeTruthy();

  // Clicking a document navigates and moves the highlight.
  fireEvent.click(view.getByRole("link", { name: "Variables" }));
  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "Variables" })).toBeTruthy();
  });
  expect(view.getByRole("link", { name: "Variables" }).getAttribute("aria-current")).toBe("page");
  expect(view.getByLabelText("Current location").textContent).toBe("/app/docs/variables");

  // The article renders its markdown content without a second sidebar.
  expect(view.getByRole("heading", { name: "Variables docs" })).toBeTruthy();
});

test("shows previous and next navigation within the same category", async () => {
  installFetchMock();
  const view = renderDocs("/app/docs/overview");

  // First document of "Getting started": next only.
  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "Overview" })).toBeTruthy();
  });
  expect(view.queryByRole("link", { name: /Previous/ })).toBeNull();
  expect(view.getByRole("link", { name: /Next/ }).textContent).toContain("Quickstart");

  // Last document of a category: previous only.
  fireEvent.click(view.getByRole("link", { name: /Next/ }));
  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "Quickstart" })).toBeTruthy();
  });
  expect(view.getByRole("link", { name: /Previous/ }).textContent).toContain("Overview");
  expect(view.queryByRole("link", { name: /Next/ })).toBeNull();

  // Middle document: both directions.
  fireEvent.click(view.getByRole("link", { name: /Previous/ }));
  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "Overview" })).toBeTruthy();
  });
  expect(view.getByRole("link", { name: /Next/ }).textContent).toContain("Quickstart");
});

test("defaults to the first document of the index and highlights it in the sidebar", async () => {
  installFetchMock();
  const view = renderDocs("/app/docs");

  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "Overview" })).toBeTruthy();
  });
  expect(view.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
});

test("routes relative doc-to-doc links through the SPA", async () => {
  installFetchMock();
  const view = render(
    <MemoryRouter initialEntries={["/app/docs/overview"]}>
      <CurrentLocation />
      <Routes>
        <Route
          path="/app/docs"
          element={
            <DocsIndexProvider>
              <Layout />
            </DocsIndexProvider>
          }
        >
          <Route index element={<Docs />} />
          <Route path=":slug" element={<Docs />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("link", { name: "Read variables" })).toBeTruthy();
  });
  fireEvent.click(view.getByRole("link", { name: "Read variables" }));
  await waitFor((): void => {
    expect(view.getByRole("heading", { name: "Variables" })).toBeTruthy();
  });
  expect(view.getByLabelText("Current location").textContent).toBe("/app/docs/variables");
});
