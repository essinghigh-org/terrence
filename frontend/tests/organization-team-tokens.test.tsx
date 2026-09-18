import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

import { OrganizationApiTokens } from "../src/components/OrganizationApiTokens";
import { TeamApiTokensDialog } from "../src/components/TeamApiTokensDialog";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;

function json(data: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  return isString(input) ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("organization token settings use the modern plural collection and keep compatibility credentials out of the UI", async () => {
  const requested: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    requested.push(url);
    if (url === "/api/v2/organizations/acme/authentication-tokens?page[size]=100") {
      return json({
        data: [
          {
            id: "org-token-1",
            type: "authentication-tokens",
            attributes: {
              description: "CI organization token",
              "created-at": "2026-09-01T12:00:00.000Z",
              "last-used-at": null,
              "expired-at": null,
              scopes: null,
            },
          },
        ],
      });
    }
    if (
      url === "/api/v2/organizations/acme/projects?page[size]=100" ||
      url === "/api/v2/organizations/acme/workspaces?page[size]=100"
    ) {
      return json({ data: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;

  const view = render(<OrganizationApiTokens orgId="org-111" orgName="acme" canManage />);

  expect(await view.findByText("CI organization token")).toBeTruthy();
  expect(view.getByText(/TFE-compatible singular organization credentials remain API-only/i)).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: "New token" }));
  const dialog = await view.findByRole("dialog");
  expect(within(dialog).getByText("Create organization API token")).toBeTruthy();

  await waitFor((): void => {
    expect(requested).toContain("/api/v2/organizations/acme/projects?page[size]=100");
  });
  expect(requested).not.toContain("/api/v2/organizations?page[size]=100");
  expect(requested.some((url): boolean => url.endsWith("/authentication-token"))).toBeFalse();
});

test("team token dialog lists and creates only modern plural team tokens", async () => {
  const requested: string[] = [];
  let postedDescription = "";
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    requested.push(url);
    if (url === "/api/v2/teams/team-1/authentication-tokens" && (init?.method ?? "GET") === "GET") {
      return json({
        data: [
          {
            id: "team-token-1",
            type: "authentication-tokens",
            attributes: {
              description: "Existing team token",
              "created-at": "2026-09-01T12:00:00.000Z",
              "last-used-at": null,
              "expired-at": null,
            },
          },
        ],
      });
    }
    if (url === "/api/v2/teams/team-1/authentication-tokens" && init?.method === "POST") {
      const body = JSON.parse(init.body as string) as {
        data: { attributes: { description: string } };
      };
      postedDescription = body.data.attributes.description;
      return json(
        {
          data: {
            id: "team-token-2",
            type: "authentication-tokens",
            attributes: {
              description: postedDescription,
              token: "team-secret",
              "created-at": "2026-09-18T00:00:00.000Z",
              "last-used-at": null,
              "expired-at": null,
            },
          },
        },
        201,
      );
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as unknown as typeof fetch;

  const view = render(
    <TeamApiTokensDialog
      teamId="team-1"
      teamName="Platform"
      open
      onOpenChange={(): void => {
        /* noop */
      }}
    />,
  );

  const dialog = await view.findByRole("dialog");
  expect(await within(dialog).findByText("Existing team token")).toBeTruthy();
  expect(within(dialog).getByText(/singular team credentials remain API-only/i)).toBeTruthy();

  fireEvent.input(within(dialog).getByLabelText("Description"), {
    target: { value: "Deployment automation" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

  await waitFor((): void => {
    expect(postedDescription).toBe("Deployment automation");
    expect(within(dialog).getByText("team-secret")).toBeTruthy();
  });
  expect(requested.some((url): boolean => url.endsWith("/authentication-token"))).toBeFalse();
});
