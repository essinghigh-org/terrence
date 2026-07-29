import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { WorkspaceResources } from "../src/components/WorkspaceResources";

const originalFetch = globalThis.fetch;
const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("shows searchable resources and redacts sensitive outputs", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("/api/v2/workspaces/ws-1/resources?")) {
      return json({
        data: [{
          id: "resource-1",
          attributes: {
            address: "aws_instance.web",
            provider: "aws",
            "provider-type": "aws_instance",
            module: "root",
            "updated-at": "2026-07-29",
          },
        }],
      });
    }
    if (url === "/api/v2/workspaces/ws-1/current-state-version-outputs") {
      return json({
        data: [
          { id: "output-1", attributes: { name: "endpoint", value: "example.test", type: "string" } },
          { id: "output-2", attributes: { name: "token", value: "never-render", type: "string", sensitive: true } },
        ],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(<WorkspaceResources workspaceId="ws-1" />);
  await waitFor((): void => { expect(view.getByText("aws_instance.web")).toBeTruthy(); });

  fireEvent.input(view.getByLabelText("Search resources"), { target: { value: "missing" } });
  expect(view.getByText("No resources match this search.")).toBeTruthy();

  fireEvent.click(view.getByRole("tab", { name: "outputs" }));
  expect(view.getByText("example.test")).toBeTruthy();
  expect(view.getByText("Sensitive value")).toBeTruthy();
  expect(view.queryByText("never-render")).toBeNull();
});
