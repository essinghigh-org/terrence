import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

import { expireAuthSession, setAuthToken } from "../src/lib/api";
import { VcsIntegrations } from "../src/views/VcsIntegrations";
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

function organization(canManageVcsSettings: boolean, name = "acme"): Response {
  return json({
    data: {
      id: `org-${name}`,
      type: "organizations",
      attributes: {
        name,
        permissions: { "can-manage-vcs-settings": canManageVcsSettings },
      },
    },
  });
}

afterEach((): void => {
  cleanup();
  expireAuthSession();
  localStorage.removeItem("tfe_token");
  globalThis.fetch = originalFetch;
});

test("derives VCS status from persisted connections and opens server-issued onboarding URLs", async () => {
  setAuthToken("spa-token");
  const requests: { accept: string | null; authorization: string | null; url: string }[] = [];
  const deletedInstallations: string[] = [];
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const headers = new Headers(init?.headers);
    requests.push({
      accept: headers.get("accept"),
      authorization: headers.get("authorization"),
      url,
    });
    if (url === "/api/v2/organizations/acme") return organization(true);
    if (url === "/api/v2/organizations/acme/github-app/installations") {
      return json({
        data: [{
          id: "ghain-1",
          type: "github-app-installations",
          attributes: {
            name: "Acme GitHub",
            "installation-id": 1234,
            "icon-url": null,
            "installation-type": "Organization",
            "installation-url": "https://github.com/settings/installations/1234",
          },
        }],
      });
    }
    if (url === "/api/v2/organizations/acme/oauth-clients") {
      return json({
        data: [
          {
            id: "oc-connected",
            type: "oauth-clients",
            attributes: {
              name: "Connected GitHub",
              "service-provider": "github",
              "http-url": "https://github.com",
              "connect-path": "/api/v2/oauth-clients/oc-connected/connect",
            },
            relationships: {
              "oauth-tokens": {
                links: { related: "/api/v2/oauth-clients/oc-connected/oauth-tokens" },
              },
            },
          },
          {
            id: "oc-empty",
            type: "oauth-clients",
            attributes: {
              name: "Unconnected GitLab",
              "service-provider": "gitlab",
              "http-url": "https://gitlab.com",
              "connect-path": "/api/v2/oauth-clients/oc-empty/connect",
            },
            relationships: {
              "oauth-tokens": {
                links: { related: "/api/v2/oauth-clients/oc-empty/oauth-tokens" },
              },
            },
          },
          {
            id: "oc-unknown",
            type: "oauth-clients",
            attributes: {
              name: "Unavailable Bitbucket",
              "service-provider": "bitbucket",
              "http-url": "https://bitbucket.org",
            },
          },
        ],
      });
    }
    if (url === "/api/v2/oauth-clients/oc-connected/oauth-tokens") {
      return json({
        data: [{
          id: "ot-1",
          type: "oauth-tokens",
          attributes: { "service-provider-user": "octocat" },
        }],
      });
    }
    if (url === "/api/v2/oauth-clients/oc-empty/oauth-tokens") return json({ data: [] });
    if (url === "/api/v2/oauth-clients/oc-unknown/oauth-tokens") {
      return json({ errors: [{ title: "Unavailable" }] }, 503);
    }
    if (url === "/api/v2/oauth-clients/oc-empty/connect") {
      return json({
        data: {
          id: "oauth-state",
          type: "vcs-authorization-requests",
          attributes: {
            "authorization-url": "https://gitlab.com/oauth/authorize?state=oauth-state",
          },
        },
      });
    }
    if (url === "/api/v2/organizations/acme/github-app/installations/setup") {
      return json({
        data: {
          id: "github-state",
          type: "vcs-authorization-requests",
          attributes: {
            "authorization-url": "https://github.com/apps/terrence/installations/new?state=github-state",
          },
        },
      });
    }
    if (url === "/api/v2/organizations/acme/github-app/installations/ghain-1" && init?.method === "DELETE") {
      deletedInstallations.push("ghain-1");
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;
  const destinations: string[] = [];

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings/vcs"]}>
      <Routes>
        <Route
          path="/app/:orgName/settings/vcs"
          element={<VcsIntegrations navigateExternal={(url): void => { destinations.push(url); }} />}
        />
      </Routes>
    </MemoryRouter>,
  );

  const connectedRow = (await view.findByText("Connected GitHub")).closest("tr");
  const emptyRow = (await view.findByText("Unconnected GitLab")).closest("tr");
  const unavailableRow = (await view.findByText("Unavailable Bitbucket")).closest("tr");
  const appRow = view.getByText("Acme GitHub").closest("tr");
  if (connectedRow === null || emptyRow === null || unavailableRow === null || appRow === null) {
    throw new Error("Expected OAuth client rows");
  }
  expect(within(connectedRow).getByText("Connected as octocat")).toBeTruthy();
  expect(within(emptyRow).getByText("Not connected")).toBeTruthy();
  expect(within(unavailableRow).getByText("Status unavailable")).toBeTruthy();
  expect(within(appRow).getByText("Connected")).toBeTruthy();

  fireEvent.click(within(appRow).getByRole("button", { name: "Remove" }));
  const confirmation = await view.findByPlaceholderText("Acme GitHub");
  fireEvent.input(confirmation, { target: { value: "Acme GitHub" } });
  await waitFor((): void => {
// SAFETY: the component renders this element type for the queried role/label.
    expect((view.getByRole("button", { name: "Remove Integration" }) as HTMLButtonElement).disabled).toBe(false);
  });
  fireEvent.click(view.getByRole("button", { name: "Remove Integration" }));
  await waitFor((): void => {
    expect(deletedInstallations).toEqual(["ghain-1"]);
    expect(view.queryByText("Acme GitHub")).toBeNull();
  });

  fireEvent.click(within(emptyRow).getByRole("button", { name: "Connect" }));
  await waitFor((): void => {
    expect(destinations).toContain("https://gitlab.com/oauth/authorize?state=oauth-state");
  });
  fireEvent.click(view.getByRole("button", { name: "Install GitHub App" }));
  await waitFor((): void => {
    expect(destinations).toContain("https://github.com/apps/terrence/installations/new?state=github-state");
  });

  for (const url of [
    "/api/v2/oauth-clients/oc-empty/connect",
    "/api/v2/organizations/acme/github-app/installations/setup",
  ]) {
    expect(requests).toContainEqual({
      accept: "application/vnd.api+json",
      authorization: "Bearer spa-token",
      url,
    });
  }
});

test("creates an OAuth client and immediately starts its real authorization flow", async () => {
  setAuthToken("spa-token");
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/organizations/acme") return organization(true);
    if (url === "/api/v2/organizations/acme/github-app/installations") return json({ data: [] });
    if (url === "/api/v2/organizations/acme/oauth-clients" && init?.method !== "POST") {
      return json({ data: [] });
    }
    if (url === "/api/v2/organizations/acme/oauth-clients" && init?.method === "POST") {
      return json({
        data: {
          id: "oc-new",
          type: "oauth-clients",
          attributes: {
            name: "GitHub",
            "service-provider": "github",
            "http-url": "https://github.com",
            "connect-path": "/api/v2/oauth-clients/oc-new/connect",
          },
        },
      }, 201);
    }
    if (url === "/api/v2/oauth-clients/oc-new/connect") {
      expect(new Headers(init?.headers).get("accept")).toBe("application/vnd.api+json");
      return json({
        data: {
          id: "new-state",
          type: "vcs-authorization-requests",
          attributes: {
            "authorization-url": "https://github.com/login/oauth/authorize?state=new-state",
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;
  const destinations: string[] = [];

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings/vcs"]}>
      <Routes>
        <Route
          path="/app/:orgName/settings/vcs"
          element={<VcsIntegrations navigateExternal={(url): void => { destinations.push(url); }} />}
        />
      </Routes>
    </MemoryRouter>,
  );

  await view.findByText("No VCS Providers connected. Connect a VCS provider to trigger workspace runs from git commits.");
  fireEvent.click(view.getByRole("button", { name: "Add VCS Provider" }));
  fireEvent.change(view.getByLabelText("Name"), { target: { value: "GitHub" } });
  fireEvent.change(view.getByLabelText("OAuth Application Client ID"), { target: { value: "client-id" } });
  fireEvent.change(view.getByLabelText("OAuth Client Secret"), { target: { value: "client-secret" } });
  fireEvent.click(view.getByRole("button", { name: "Connect VCS Provider" }));

  await waitFor((): void => {
    expect(destinations).toEqual(["https://github.com/login/oauth/authorize?state=new-state"]);
  });
});

test("uses provider-specific OAuth URL defaults", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/organizations/acme") return organization(true);
    if (url === "/api/v2/organizations/acme/github-app/installations") return json({ data: [] });
    if (url === "/api/v2/organizations/acme/oauth-clients") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings/vcs"]}>
      <Routes>
        <Route path="/app/:orgName/settings/vcs" element={<VcsIntegrations />} />
      </Routes>
    </MemoryRouter>,
  );

  await view.findByText("No VCS Providers connected. Connect a VCS provider to trigger workspace runs from git commits.");
  fireEvent.click(view.getByRole("button", { name: "Add VCS Provider" }));
  const provider = view.getByLabelText("VCS Type") as HTMLSelectElement;
  const httpUrl = view.getByLabelText("HTTP URL") as HTMLInputElement;
  const apiUrl = view.getByLabelText("API URL") as HTMLInputElement;

  expect(httpUrl.value).toBe("https://github.com");
  expect(apiUrl.value).toBe("https://api.github.com");

  fireEvent.change(provider, { target: { value: "github_enterprise" } });
  expect(httpUrl.value).toBe("");
  expect(apiUrl.value).toBe("");

  fireEvent.change(provider, { target: { value: "gitlab" } });
  expect(httpUrl.value).toBe("https://gitlab.com");
  expect(apiUrl.value).toBe("https://gitlab.com/api/v4");

  fireEvent.change(provider, { target: { value: "bitbucket" } });
  expect(httpUrl.value).toBe("https://bitbucket.org");
  expect(apiUrl.value).toBe("https://api.bitbucket.org/2.0");
});

test("fails closed when the organization does not grant VCS management", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/organizations/acme") return organization(false);
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = (fetchMock) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings/vcs"]}>
      <Routes>
        <Route path="/app/:orgName/settings/vcs" element={<VcsIntegrations />} />
      </Routes>
    </MemoryRouter>,
  );

  expect(await view.findByText("You do not have permission to manage VCS settings for this organization.")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Install GitHub App" })).toBeNull();
  expect(view.queryByRole("button", { name: "Add VCS Provider" })).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("ignores integration responses after switching organizations", async () => {
  let resolveAcmeInstallations!: (response: Response) => void;
  const acmeInstallations = new Promise<Response>((resolve): void => {
    resolveAcmeInstallations = resolve;
  });
  let acmeSignal: AbortSignal | null = null;

// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = (mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "/api/v2/organizations/acme") return organization(true);
    if (url === "/api/v2/organizations/acme/github-app/installations") {
      acmeSignal = init?.signal ?? null;
      return acmeInstallations;
    }
    if (url === "/api/v2/organizations/acme/oauth-clients") {
      return json({
        data: [{
          id: "oc-acme",
          type: "oauth-clients",
          attributes: {
            name: "Acme GitHub",
            "service-provider": "github",
            "http-url": "https://github.com",
          },
        }],
      });
    }
    if (url === "/api/v2/organizations/platform") return organization(true, "platform");
    if (url === "/api/v2/organizations/platform/github-app/installations") return json({ data: [] });
    if (url === "/api/v2/organizations/platform/oauth-clients") {
      return json({
        data: [{
          id: "oc-platform",
          type: "oauth-clients",
          attributes: {
            name: "Platform GitLab",
            "service-provider": "gitlab",
            "http-url": "https://gitlab.com",
          },
        }],
      });
    }
    if (url === "/api/v2/oauth-clients/oc-platform/oauth-tokens") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  })) as unknown as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings/vcs"]}>
      <Link to="/app/platform/settings/vcs">Switch organization</Link>
      <Routes>
        <Route path="/app/:orgName/settings/vcs" element={<VcsIntegrations />} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(acmeSignal).not.toBeNull();
  });
  fireEvent.click(view.getByRole("link", { name: "Switch organization" }));
  expect(await view.findByText("Platform GitLab")).toBeTruthy();
  expect(acmeSignal!.aborted).toBeTrue();

  await act(async (): Promise<void> => {
    resolveAcmeInstallations(json({ data: [] }));
    await acmeInstallations;
  });

  expect(view.getByText("Platform GitLab")).toBeTruthy();
  expect(view.queryByText("Acme GitHub")).toBeNull();
});