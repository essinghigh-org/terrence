import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { WorkspaceResources } from "../src/components/WorkspaceResources";

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
    if (url === "/api/v2/workspaces/ws-1/readme") {
      return json({
        data: {
          id: "readme-run-1",
          attributes: {
            content: "# Infrastructure\n\nA **safe** deployment.\n> Read this first.\n\n- Terraform\n- OpenTofu\n\n```hcl\nterraform {}\n```",
            "run-id": "run-1",
            "created-at": "2026-07-29T10:00:00.000Z",
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(<WorkspaceResources workspaceId="ws-1" />);
  await waitFor((): void => { expect(view.getByText("aws_instance.web")).toBeTruthy(); });
  expect(view.getByRole("heading", { name: "README.md" })).toBeTruthy();
  expect(view.getByRole("heading", { name: "Infrastructure" })).toBeTruthy();
  expect(view.getByText("safe", { selector: "strong" })).toBeTruthy();
  expect(view.getByText("Read this first.", { selector: "blockquote" })).toBeTruthy();

  fireEvent.input(view.getByLabelText("Search resources"), { target: { value: "missing" } });
  expect(view.getByText("No resources match this search.")).toBeTruthy();

  fireEvent.click(view.getByRole("tab", { name: "outputs" }));
  expect(view.getByText("example.test")).toBeTruthy();
  expect(view.getByText("Sensitive value")).toBeTruthy();
  expect(view.queryByText("never-render")).toBeNull();
});

test("paginates resources and outputs independently", async () => {
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("/api/v2/workspaces/ws-1/resources?")) {
      return json({
        data: Array.from({ length: 21 }, (_, index) => ({
          id: `resource-${index}`,
          attributes: { address: `aws_instance.web_${index}`, provider: "aws", "provider-type": "aws_instance" },
        })),
      });
    }
    if (url === "/api/v2/workspaces/ws-1/current-state-version-outputs") {
      return json({
        data: Array.from({ length: 21 }, (_, index) => ({
          id: `output-${index}`,
          attributes: { name: `output_${index}`, value: index, type: "number" },
        })),
      });
    }
    if (url === "/api/v2/workspaces/ws-1/readme") return json({ errors: [{ status: "404" }] }, 404);
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(<WorkspaceResources workspaceId="ws-1" />);
  await waitFor((): void => { expect(view.getByText("aws_instance.web_0")).toBeTruthy(); });
  expect(view.getByText("Page 1 of 2")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Next resources page" }));
  expect(view.getByText("aws_instance.web_20")).toBeTruthy();

  fireEvent.click(view.getByRole("tab", { name: "outputs" }));
  expect(view.getByText("Page 1 of 2")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Next outputs page" }));
  expect(view.getByText("output_20")).toBeTruthy();

  fireEvent.click(view.getByRole("tab", { name: "resources" }));
  expect(view.getByText("Page 2 of 2")).toBeTruthy();
  expect(view.getByText("aws_instance.web_20")).toBeTruthy();
});
