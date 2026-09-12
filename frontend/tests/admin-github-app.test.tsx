import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AdminGitHubApp } from "../src/views/AdminGitHubApp";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;
const originalLocation = window.location;

const json = (data: JsonValue): Response =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/vnd.api+json" },
  });

const getUrl = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.toString() : input.url;

const getAccept = (init?: RequestInit): string | null =>
  new Headers(init?.headers as HeadersInit | undefined).get("Accept");

function stubLocationAssign(assignedUrls: string[]): void {
  // @ts-expect-error Mocking window.location in test
  window.location = {
    assign: (url: string | URL): void => {
      assignedUrls.push(String(url));
    },
  };
}

afterEach((): void => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
  // @ts-expect-error Mocking window.location in test
  window.location = originalLocation;
});

test("manifest setup requests the JSON:API media type the Accept gate requires", async () => {
  const assignedUrls: string[] = [];
  stubLocationAssign(assignedUrls);

  const setupAccepts: (string | null)[] = [];
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = getUrl(input);
    if (url === "/api/v2/admin/github-app") {
      return json({ data: { attributes: { status: "unconfigured" } } });
    }
    if (url === "/api/v2/admin/github-app/manifest/setup") {
      setupAccepts.push(getAccept(init));
      return json({
        data: {
          id: "state-1",
          type: "vcs-authorization-requests",
          attributes: { "authorization-url": "https://github.com/settings/apps/new?state=state-1" },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(<AdminGitHubApp />);
  const startButton = await view.findByRole("button", { name: /Create or replace with GitHub/ });
  fireEvent.click(startButton);

  await waitFor((): void => {
    expect(setupAccepts.length).toBeGreaterThan(0);
  });
  // The JSON:API Accept gate 406s plain application/json here.
  expect(setupAccepts[setupAccepts.length - 1]).toBe("application/vnd.api+json");
  await waitFor((): void => {
    expect(assignedUrls).toEqual(["https://github.com/settings/apps/new?state=state-1"]);
  });
  view.unmount();
});
