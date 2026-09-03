import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

import { WorkspaceResources } from "../src/components/WorkspaceResources";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;
const json = (data: JsonValue, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("shows searchable resources and redacts sensitive outputs", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = isString(input) ? input : input instanceof URL ? input.toString() : input.url;
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
    if (url === "/api/v2/workspaces/ws-1/dependency-graph") {
      return json({
        data: {
          attributes: {
            nodes: [
              { address: "aws_vpc.main", dependencies: [] },
              { address: "aws_subnet.web", dependencies: ["aws_vpc.main"] },
            ],
            edges: [{ from: "aws_vpc.main", to: "aws_subnet.web" }],
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;

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

  fireEvent.click(view.getByRole("tab", { name: "Dependency graph" }));
  await waitFor((): void => {
    const canvas = view.getByRole("region", { name: "Terraform resource dependency graph" });
    expect(canvas.querySelector(".react-flow__node[data-id=\"aws_vpc.main\"]")).toBeTruthy();
    expect(canvas.querySelector(".react-flow__node[data-id=\"aws_subnet.web\"]")).toBeTruthy();
    expect(canvas.querySelector(".react-flow__edge[data-id=\"aws_vpc.main->aws_subnet.web\"]")).toBeTruthy();
  });

  fireEvent.click(view.getByText("aws_subnet.web"));
  await waitFor((): void => {
    const panel = view.getByLabelText("Resource details");
    expect(within(panel).getByText("aws_subnet.web")).toBeTruthy();
    expect(within(panel).getByText("aws")).toBeTruthy();
    expect(within(panel).getByText("aws_subnet")).toBeTruthy();
    expect(within(panel).getByText("1")).toBeTruthy();
  });

  const panel = view.getByLabelText("Resource details");
  fireEvent.click(within(panel).getByText("aws_vpc.main"));
  await waitFor((): void => {
    expect(within(view.getByLabelText("Resource details")).getByText("Nothing in this state.")).toBeTruthy();
  });

  fireEvent.click(within(view.getByLabelText("Resource details")).getByRole("button", { name: "Close details" }));
  expect(view.queryByLabelText("Resource details")).toBeNull();

  const canvas = view.getByRole("region", { name: "Terraform resource dependency graph" });
  const edge = canvas.querySelector(".react-flow__edge[data-id=\"aws_vpc.main->aws_subnet.web\"]");
  expect(edge).not.toBeNull();
  if (edge !== null) fireEvent.click(edge);
  await waitFor((): void => {
    const dependencyDetails = view.getByLabelText("Dependency details");
    expect(within(dependencyDetails).getByText("aws_vpc.main")).toBeTruthy();
    expect(within(dependencyDetails).getByText("View source")).toBeTruthy();
  });

  fireEvent.click(within(view.getByLabelText("Dependency details")).getByRole("button", { name: "View target" }));
  await waitFor((): void => {
    const resourceDetails = view.getByLabelText("Resource details");
    expect(within(resourceDetails).getByText("aws_subnet.web")).toBeTruthy();
  });
});

test("paginates resources and outputs independently", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = isString(input) ? input : input instanceof URL ? input.toString() : input.url;
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
    if (url === "/api/v2/workspaces/ws-1/dependency-graph") return json({ errors: [{ status: "404" }] }, 404);
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;

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