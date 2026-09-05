import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { WorkspaceNotifications } from "../src/components/WorkspaceNotifications";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const json = (data: JsonValue): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

const urlOf = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.toString() : input.url;

// Issue #633: Discord destinations are selectable and delivery failures
// surface on the tab instead of living only in server logs.
test("shows a discord option and failed last deliveries", async () => {
  const fetchMock = mock(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url.endsWith("/workspaces/ws-1/notification-configurations")) {
      return json({
        data: [
          {
            id: "nc-discord",
            attributes: {
              name: "Ops channel",
              "destination-type": "discord",
              url: "https://discord.com/api/webhooks/123/abc",
              triggers: ["run:errored"],
              enabled: true,
              "last-delivery": {
                "sent-at": "2026-09-05T12:00:00.000Z",
                successful: false,
                code: "500",
                error: "Internal Server Error",
              },
            },
          },
          {
            id: "nc-ok",
            attributes: {
              name: "Healthy hook",
              "destination-type": "slack",
              url: "https://hooks.slack.com/ok",
              triggers: ["run:completed"],
              enabled: true,
              "last-delivery": { "sent-at": "2026-09-05T12:00:00.000Z", successful: true, code: "200", error: null },
            },
          },
        ],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(<WorkspaceNotifications workspaceId="ws-1" />);
  await waitFor((): void => {
    expect(view.getByText("Ops channel")).toBeTruthy();
  });

  // Failed last delivery surfaces inline on the failing row only.
  const failingRow = view.getByText("Ops channel").closest("tr") as HTMLElement;
  expect(within(failingRow).getByText(/Last delivery failed \(HTTP 500\)/)).toBeTruthy();
  const healthyRow = view.getByText("Healthy hook").closest("tr") as HTMLElement;
  expect(within(healthyRow).queryByText(/Last delivery failed/)).toBeNull();

  // Discord is a first-class destination in the editor.
  fireEvent.click(view.getByRole("button", { name: "Add notification" }));
  await waitFor((): void => {
    expect(view.getByRole("option", { name: "Discord" })).toBeTruthy();
  });
});
