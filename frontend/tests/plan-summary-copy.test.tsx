import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { PlanOutput, planSummaryMarkdown } from "../src/components/PlanOutput";

const originalFetch = globalThis.fetch;
const originalClipboard = navigator.clipboard;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function planFixture(): Record<string, unknown> {
  return {
    terraform_version: "1.11.0",
    resource_changes: [
      {
        address: "aws_vpc.main",
        type: "aws_vpc",
        change: { actions: ["create"], before: null, after: { cidr_block: "10.0.0.0/16" } },
      },
      {
        address: "aws_instance.web",
        type: "aws_instance",
        change: { actions: ["create"], before: null, after: { instance_type: "t3.small" }, importing: { id: "i-web" } },
      },
      {
        address: "aws_instance.app",
        type: "aws_instance",
        change: { actions: ["update"], before: { instance_type: "t3.micro" }, after: { instance_type: "t3.small" } },
      },
      {
        address: "aws_db.default",
        type: "aws_db_instance",
        change: { actions: ["delete"], before: {}, after: null },
      },
    ],
  };
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
  Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
});

test("formats the plan summary as markdown", () => {
  const markdown = planSummaryMarkdown({ add: 1, change: 1, destroy: 1, replace: 0, importCount: 1 });
  expect(markdown).toBe([
    "## Plan summary",
    "",
    "- 1 to import",
    "- 1 to create",
    "- 1 to change",
    "- 1 to destroy",
    "",
  ].join("\n"));
});

test("copies the plan summary as markdown from the toolbar", async () => {
  const writeText = mock(async (): Promise<void> => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  globalThis.fetch = mock(async (): Promise<Response> => json(planFixture())) as typeof fetch;

  const view = render(<PlanOutput runId="run-summary" status="planned" />);
  await waitFor((): void => {
    expect(view.getByText("aws_vpc.main")).toBeTruthy();
  });

  fireEvent.click(view.getByRole("button", { name: "Copy plan summary as markdown" }));

  await waitFor(() => {
    expect(writeText).toHaveBeenCalledWith([
      "## Plan summary",
      "",
      "- 1 to import",
      "- 2 to create",
      "- 1 to change",
      "- 1 to destroy",
      "",
    ].join("\n"));
  });
});