import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { WorkspaceNotifications } from "../src/components/WorkspaceNotifications";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

const json = (data: JsonValue, status = 200): Response => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/vnd.api+json" },
});

afterEach((): void => {
  globalThis.fetch = originalFetch;
});

test("loads workspace webhooks and creates a webhook using notification configuration API", async () => {
  const created = {
    id: "nc-2",
    type: "notification-configurations",
    attributes: {
      name: "Deploy alerts",
      "destination-type": "generic",
      url: "https://hooks.example.test/deploy",
      triggers: ["run:completed"],
      enabled: true,
    },
  };
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = isString(input) ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/v2/workspaces/ws-1/notification-configurations" && init?.method === "POST") return json({ data: created }, 201);
    if (url === "/api/v2/workspaces/ws-1/notification-configurations") {
      return json({ data: [{ ...created, id: "nc-1", attributes: { ...created.attributes, name: "Existing webhook" } }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(<WorkspaceNotifications mode="webhooks" workspaceId="ws-1" />);
  await waitFor((): void => { expect(view.getByText("Existing webhook")).toBeTruthy(); });

  fireEvent.click(view.getByRole("button", { name: "Add webhook" }));
  fireEvent.input(view.getByLabelText("Name"), { target: { value: "Deploy alerts" } });
  fireEvent.change(view.getByLabelText("Name"), { target: { value: "Deploy alerts" } });
  fireEvent.input(view.getByLabelText("Webhook URL"), { target: { value: "https://hooks.example.test/deploy" } });
  fireEvent.change(view.getByLabelText("Webhook URL"), { target: { value: "https://hooks.example.test/deploy" } });
  fireEvent.click(view.getByRole("button", { name: "Save webhook" }));

  await waitFor((): void => { expect(view.getByText("Deploy alerts")).toBeTruthy(); });
  const postCall = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
  expect(postCall).toBeTruthy();
  const postRequest = postCall?.[1];
  expect(postRequest).toBeTruthy();
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
  expect(JSON.parse(postRequest?.body as string)).toEqual({
    data: {
      type: "notification-configurations",
      attributes: {
        name: "Deploy alerts",
        "destination-type": "generic",
        url: "https://hooks.example.test/deploy",
        triggers: ["run:completed", "run:errored"],
        enabled: true,
      },
    },
  });
});

test("requires a name and URL before creating a webhook", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (): Promise<Response> => json({ data: [] }))) as unknown as typeof fetch;
  const view = render(<WorkspaceNotifications mode="webhooks" workspaceId="ws-1" />);
  await waitFor((): void => { expect(view.getByText("No webhooks have been added.")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Add webhook" }));
  fireEvent.click(view.getByRole("button", { name: "Save webhook" }));
  expect(view.getByText("Name and webhook URL are required.")).toBeTruthy();
});