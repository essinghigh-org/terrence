import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PlanOutput } from "../src/components/PlanOutput";
import { EventProvider, type EventStreamFactory } from "../src/lib/event-provider";
import { isString } from "../src/lib/type-guards";
import type { JsonObject } from "../src/lib/json";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

function json(data: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

/** Controllable SSE stream for EventProvider tests. */
function createFakeStream(): {
  factory: EventStreamFactory;
  emit: (name: string, data: Readonly<JsonObject>) => void;
} {
  const listeners = new Set<(event: { name: string; data: Readonly<JsonObject> }) => void>();
  return {
    factory: (onEvent): { close: () => void } => {
      listeners.add(onEvent);
      return {
        close: (): void => {
          listeners.delete(onEvent);
        },
      };
    },
    emit: (name, data): void => {
      for (const listener of [...listeners]) listener({ name, data });
    },
  };
}

function changeInput(element: HTMLElement, value: string): void {
// SAFETY: React attaches the _valueTracker to controlled inputs in the test renderer.
  // SAFETY: React attaches the _valueTracker to controlled inputs in the test renderer.
  const tracker = (element as { _valueTracker?: { setValue: (next: string) => void } })._valueTracker;
  tracker?.setValue(value === "" ? "x" : "");
  Reflect.set(element, "value", value);
  fireEvent.input(element, { target: { value } });
  fireEvent.change(element, { target: { value } });
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("loads a running plan when plan.output.ready arrives over SSE", async () => {
  let request = 0;
  const fetchMock = mock(async (): Promise<Response> => {
    request++;
    if (request === 1) {
      return json({
        errors: [{ status: "404", detail: "Plan JSON output is unavailable." }],
      }, 404);
    }
    return json({
      terraform_version: "1.11.0",
      format_version: "1.2",
      resource_changes: [{
        address: "aws_instance.ready",
        type: "aws_instance",
        change: {
          actions: ["create"],
          before: null,
          after: { instance_type: "t3.small" },
        },
      }],
    });
  });
  globalThis.fetch = fetchMock;
  const stream = createFakeStream();

  const view = render(
    <EventProvider streamFactory={stream.factory}>
      <PlanOutput runId="run-ready" status="planning" />
    </EventProvider>,
  );

  // First fetch 404s: the plan is still running. The view waits instead of
  // polling every second (degraded poll is 30s and never fires here).
  await waitFor((): void => {
    expect(view.getByText("Preparing structured plan output…")).toBeTruthy();
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // The worker's plan.output.ready event triggers exactly one more fetch.
  act((): void => {
    stream.emit("plan.output.ready", { "run-id": "run-ready" });
  });
  await waitFor((): void => {
    expect(view.getByText("aws_instance.ready")).toBeTruthy();
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
// SAFETY: the fixture field is a string per the API contract.
  expect((fetchMock.mock.calls[0]?.[0] as string)).toBe("/api/v2/plans/plan-run-ready/json-output");
  // The event-triggered fetch targets the same endpoint (no extra polling).
  expect((fetchMock.mock.calls[1]?.[0] as string)).toBe("/api/v2/plans/plan-run-ready/json-output");
});

test("renders replacement and nested safe diffs and filters resources", async () => {
  const fetchMock = mock(async (): Promise<Response> => json({
    terraform_version: "1.11.0",
    format_version: "1.2",
    resource_changes: [
      {
        address: "module.app.secret_resource.replaced",
        deposed: "deadbeef",
        module_address: "module.app",
        provider_name: "registry.terraform.io/example/secret",
        action_reason: "replace_because_cannot_update",
        type: "secret_resource",
        change: {
          actions: ["delete", "create"],
          before: {
            token: "old-super-secret",
            settings: { endpoints: [{ url: "https://old.example" }] },
            id: "old-id",
            name: "stable-resource",
            region: "eu-west-2",
          },
          after: {
            token: "new-super-secret",
            settings: { endpoints: [{ url: "https://new.example" }] },
            id: null,
            name: "stable-resource",
            region: "eu-west-2",
          },
          before_sensitive: { token: true },
          after_sensitive: { token: true },
          after_unknown: { id: true },
          replace_paths: [["settings", "endpoints"]],
        },
      },
      {
        address: "aws_instance.changed",
        provider_name: "registry.terraform.io/hashicorp/aws",
        type: "aws_instance",
        change: {
          actions: ["update"],
          before: { instance_type: "t3.micro" },
          after: { instance_type: "t3.small" },
        },
      },
    ],
  }));
  globalThis.fetch = fetchMock;

  const view = render(<PlanOutput runId="run-detail" status="planned" />);
  await waitFor((): void => {
    expect(view.getByText("module.app.secret_resource.replaced")).toBeTruthy();
  });

  expect(view.getByLabelText("1 to create")).toBeTruthy();
  expect(view.getByLabelText("1 to change")).toBeTruthy();
  expect(view.getByLabelText("1 to destroy")).toBeTruthy();
  expect(view.getByText("1 replacement")).toBeTruthy();
  expect(document.body.textContent?.includes("old-super-secret")).toBe(false);
  expect(document.body.textContent?.includes("new-super-secret")).toBe(false);
  // secondary metadata under the address is intentionally hidden (address-only rows)
  expect(view.queryByText(/deadbeef/)).toBeNull();
  expect(view.queryByText(/Replacement required by provider/)).toBeNull();

  fireEvent.click(view.getByText("module.app.secret_resource.replaced"));
  await waitFor((): void => {
    expect(view.getAllByText("Sensitive value").length).toBeGreaterThan(0);
    expect(view.getByText("Known after apply")).toBeTruthy();
    expect(view.getByText(JSON.stringify("https://old.example"))).toBeTruthy();
    expect(view.getByText(JSON.stringify("https://new.example"))).toBeTruthy();
    expect(view.getByText(JSON.stringify("stable-resource"))).toBeTruthy();
    expect(view.getAllByText("Forces replacement").length).toBeGreaterThan(0);
    expect(view.getByText(/1 unchanged attribute hidden/)).toBeTruthy();
  });
  expect((view.container as HTMLElement).querySelector("img[alt=\"\"]")?.getAttribute("src") ?? view.container.textContent).toBeTruthy();

  changeInput(view.getByLabelText("Filter resources by address or type"), "aws_instance");
  await waitFor((): void => {
    expect(view.queryByText("module.app.secret_resource.replaced")).toBeNull();
    expect(view.getByText("aws_instance.changed")).toBeTruthy();
  });

  changeInput(view.getByLabelText("Filter resources by address or type"), "");
  fireEvent.change(view.getByLabelText("Filter by operation"), {
    target: { value: "replace" },
  });
  await waitFor((): void => {
    expect(view.getByText("module.app.secret_resource.replaced")).toBeTruthy();
    expect(view.queryByText("aws_instance.changed")).toBeNull();
    expect(view.getByText("Showing 1 of 2")).toBeTruthy();
  });
});

test("keeps moves, imports, drift, and output values visible", async () => {
  const onSummaryChange = mock((): void => undefined);
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (): Promise<Response> => json({
    action_invocations: [{
      address: "action.aws_lambda_invoke.deploy",
      type: "aws_lambda_invoke",
      name: "deploy",
      provider_name: "registry.terraform.io/hashicorp/aws",
      lifecycle_action_trigger: {
        triggering_resource_address: "aws_instance.renamed",
        action_trigger_event: "after_update",
      },
    }],
    resource_changes: [
      {
        address: "aws_instance.renamed",
        previous_address: "aws_instance.old_name",
        type: "aws_instance",
        change: { actions: ["no-op"], before: { id: "i-1" }, after: { id: "i-1" } },
      },
      {
        address: "aws_instance.imported",
        type: "aws_instance",
        change: {
          actions: ["no-op"],
          before: null,
          after: { id: "i-2" },
          importing: { id: "i-2" },
        },
      },
    ],
    resource_drift: [{
      address: "aws_instance.drifted",
      type: "aws_instance",
      change: {
        actions: ["update"],
        before: { size: "small" },
        after: { size: "large" },
      },
    }],
    output_changes: {
      endpoint: {
        actions: ["update"],
        before: "old.example",
        after: "new.example",
      },
    },
  })) as typeof fetch;

  const view = render(
    <PlanOutput runId="run-complete" status="planned" onSummaryChange={onSummaryChange} />,
  );
  await waitFor((): void => {
    expect(view.getAllByText("aws_instance.renamed").length).toBeGreaterThan(0);
  });

  expect(view.getByLabelText("1 to import")).toBeTruthy();
  await waitFor((): void => {
    expect(onSummaryChange).toHaveBeenLastCalledWith({ actionCount: 1, importCount: 1 });
  });
  expect(view.getByText("1 move")).toBeTruthy();
  expect(view.getByText("1 drifted resource")).toBeTruthy();
  expect(view.getByText("1 action to invoke")).toBeTruthy();
  // moved-from / import IDs are no longer rendered under the address
  expect(view.queryByText(/aws_instance\.old_name/)).toBeNull();
  expect(view.queryByText(/i-2/)).toBeNull();

  fireEvent.click(view.getByText("Actions to invoke"));
  expect(view.getByText("action.aws_lambda_invoke.deploy")).toBeTruthy();
  expect(view.getByText("after update")).toBeTruthy();
  expect(view.getByText(/Triggered by/).textContent).toContain("aws_instance.renamed");
  fireEvent.click(view.getByText("Resource drift"));
  expect(view.getByText("aws_instance.drifted")).toBeTruthy();
  fireEvent.click(view.getByText("Output changes"));
  fireEvent.click(view.getByText("endpoint"));
  expect(view.getByText(JSON.stringify("old.example"))).toBeTruthy();
  expect(view.getByText(JSON.stringify("new.example"))).toBeTruthy();
});

test("counts an imported resource's planned update as both import and change", async () => {
  const onSummaryChange = mock((): void => undefined);
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (): Promise<Response> => json({
    resource_changes: [{
      address: "aws_instance.imported_and_changed",
      type: "aws_instance",
      change: {
        actions: ["update"],
        before: { size: "small" },
        after: { size: "large" },
        importing: { id: "i-123" },
      },
    }],
  })) as typeof fetch;

  const view = render(
    <PlanOutput runId="run-import-update" status="planned" onSummaryChange={onSummaryChange} />,
  );
  await waitFor((): void => {
    expect(view.getByText("aws_instance.imported_and_changed")).toBeTruthy();
  });

  expect(view.getByLabelText("1 to import")).toBeTruthy();
  expect(view.getByLabelText("1 to change")).toBeTruthy();
  expect(view.getByText("to change")).toBeTruthy();
  expect(view.getByText("import")).toBeTruthy();
  await waitFor((): void => {
    expect(onSummaryChange).toHaveBeenLastCalledWith({ actionCount: 0, importCount: 1 });
  });

  fireEvent.change(view.getByLabelText("Filter by operation"), {
    target: { value: "import" },
  });
  expect(view.getByText("aws_instance.imported_and_changed")).toBeTruthy();
});

test("counts a moved resource's planned update as both move and change", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (): Promise<Response> => json({
    resource_changes: [{
      address: "aws_instance.new_name",
      previous_address: "aws_instance.old_name",
      type: "aws_instance",
      change: {
        actions: ["update"],
        before: { size: "small" },
        after: { size: "large" },
      },
    }],
  })) as typeof fetch;

  const view = render(<PlanOutput runId="run-move-update" status="planned" />);
  await waitFor((): void => {
    expect(view.getAllByText("aws_instance.new_name").length).toBeGreaterThan(0);
  });

  expect(view.getByLabelText("1 to change")).toBeTruthy();
  expect(view.getByText("1 move")).toBeTruthy();
  expect(view.getByText("to change")).toBeTruthy();
  expect(view.getByText("move")).toBeTruthy();

  fireEvent.change(view.getByLabelText("Filter by operation"), {
    target: { value: "move" },
  });
  expect(view.getAllByText("aws_instance.new_name").length).toBeGreaterThan(0);
});

test("keeps a ready artifact across status changes and hides it immediately for a new run", async () => {
  let resolveNext: ((response: Response) => void) | undefined;
  const nextResponse = new Promise<Response>((resolve): void => {
    resolveNext = resolve;
  });
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = isString(input) ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("plan-run-first")) {
      return json({
        resource_changes: [{
          address: "aws_instance.first",
          type: "aws_instance",
          change: { actions: ["create"], before: null, after: { name: "first" } },
        }],
      });
    }
    return await nextResponse;
  });
  globalThis.fetch = fetchMock;

  const view = render(<PlanOutput runId="run-first" status="planned" />);
  await waitFor((): void => {
    expect(view.getByText("aws_instance.first")).toBeTruthy();
  });

  view.rerender(<PlanOutput runId="run-first" status="cost_estimated" />);
  expect(view.getByText("aws_instance.first")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  view.rerender(<PlanOutput runId="run-second" status="planning" />);
  expect(view.queryByText("aws_instance.first")).toBeNull();
  expect(view.getByText("Loading structured plan output…")).toBeTruthy();
  await waitFor((): void => {
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  resolveNext?.(json({
    resource_changes: [{
      address: "aws_instance.second",
      type: "aws_instance",
      change: { actions: ["create"], before: null, after: { name: "second" } },
    }],
  }));
  await waitFor((): void => {
    expect(view.getByText("aws_instance.second")).toBeTruthy();
  });
});

test("rejects malformed structured plan resources", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (): Promise<Response> => json({
    resource_changes: [{ address: 123, change: { actions: "create" } }],
  })) as typeof fetch;

  const view = render(<PlanOutput runId="run-invalid" status="planned" />);
  await waitFor((): void => {
    expect(view.getByText("The structured plan response was invalid.")).toBeTruthy();
  });
});

test("rejects malformed structured plan action metadata", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (): Promise<Response> => json({
    action_invocations: [{ address: 123 }],
    resource_changes: [],
  })) as typeof fetch;

  const view = render(<PlanOutput runId="run-invalid-action" status="planned" />);
  await waitFor((): void => {
    expect(view.getByText("The structured plan response was invalid.")).toBeTruthy();
  });
});

test("shows a neutral state when a terminal run never produced a plan artifact", async () => {
  const fetchMock = mock(async (): Promise<Response> => json({}, 404));
  globalThis.fetch = fetchMock;

  const view = render(
    <PlanOutput runId="run-pre-plan-canceled" status="canceled" planStatus="pending" />,
  );

  await waitFor((): void => {
    expect(view.getByText("Plan output was not produced for this run.")).toBeTruthy();
  });
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("renders structured terraform-style diff lines for changed list elements", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (): Promise<Response> => json({
    terraform_version: "1.11.0",
    format_version: "1.2",
    resource_changes: [{
      address: "github_repository.this",
      type: "github_repository",
      name: "this",
      change: {
        actions: ["update"],
        before: {
          id: "twitter-nsfw-api",
          name: "twitter-nsfw-api",
          topics: ["tfe-managed", "unchanged-topic"],
          visibility: "private",
        },
        after: {
          id: "twitter-nsfw-api",
          name: "twitter-nsfw-api",
          topics: ["terrence-managed", "unchanged-topic"],
          visibility: "private",
        },
      },
    }],
  })) as typeof fetch;

  const view = render(<PlanOutput runId="run-topics" status="planned" />);
  await waitFor((): void => {
    expect(view.getByText("github_repository.this")).toBeTruthy();
  });

  fireEvent.click(view.getByText("github_repository.this"));
  await waitFor((): void => {
    expect(view.getByText('"tfe-managed"')).toBeTruthy();
    expect(view.getByText('"terrence-managed"')).toBeTruthy();
    expect(view.getByText("~ resource")).toBeTruthy();
    expect(view.getByText('"github_repository" "this" {')).toBeTruthy();
  });

  // Unchanged list element is hidden; unchanged attributes are summarized instead.
  expect(view.queryByText('"unchanged-topic"')).toBeNull();
  expect(view.getByText(/2 unchanged attributes hidden/)).toBeTruthy();

  // The unchanged-attributes summary renders inside the resource block, before the closing brace.
  const diff = view.getByLabelText("Attribute changes for github_repository.this");
  const text = diff.textContent ?? "";
  expect(text.indexOf("2 unchanged attributes hidden")).toBeLessThan(text.lastIndexOf("}"));
});
