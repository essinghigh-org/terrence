import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { expireAuthSession, setAuthToken } from "../src/lib/api";
import type { JsonValue } from "../src/lib/json";
import { isString } from "../src/lib/type-guards";
import { VcsIntegrations } from "../src/views/VcsIntegrations";

const originalFetch = globalThis.fetch;
const testPat = "test-pat-never-show-this";
const testHookSecret = "test-hook-secret-never-show-this-either";
const client = {
  id: "oc-ado",
  type: "oauth-clients",
  attributes: {
    name: "Azure team",
    "service-provider": "ado_services",
    "http-url": "https://dev.azure.com",
    "api-url": "https://dev.azure.com",
    "ado-org-name": "acme-ado",
  },
};
const token = { id: "ot-stable", attributes: { "service-provider-user": "pat-user" } };

type Write = { url: string; init: RequestInit; attributes: Record<string, string> };
type FixtureOptions = Readonly<{
  existing?: boolean;
  configured?: boolean;
  organization?: string;
  onWrite?: (write: Write) => Promise<Response>;
}>;

function json(value: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/vnd.api+json" } });
}

function fixture({ existing = false, configured = false, organization = "acme-ado", onWrite }: FixtureOptions = {}): {
  writes: Write[];
  requests: string[];
  destinations: string[];
  view: ReturnType<typeof render>;
} {
  setAuthToken("spa-token");
  const writes: Write[] = [];
  const requests: string[] = [];
  const destinations: string[] = [];
  let stored = existing;
  let hasToken = configured;
  let org = organization;
  // SAFETY: the mock implements the fetch input and response contracts used by the view.
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = isString(input) ? input : input instanceof URL ? input.toString() : input.url;
    requests.push(url);
    if (init?.method === "POST" || init?.method === "PATCH") {
      // SAFETY: these requests are JSON:API mutation documents produced by the component.
      if (!isString(init.body)) throw new Error("Expected a JSON mutation body");
      const body = JSON.parse(init.body) as { data: { attributes: Record<string, string> } };
      const write = { url, init, attributes: body.data.attributes };
      writes.push(write);
      if (onWrite !== undefined) return onWrite(write);
      stored = true;
      hasToken = true;
      org = body.data.attributes["ado-org-name"] ?? org;
      return json(
        { data: { ...client, attributes: { ...client.attributes, "ado-org-name": org } } },
        init.method === "POST" ? 201 : 200,
      );
    }
    if (/^\/api\/v2\/organizations\/[^/]+$/.test(url)) {
      return json({ data: { attributes: { permissions: { "can-manage-vcs-settings": true } } } });
    }
    if (url.endsWith("/github-app/installations")) return json({ data: [] });
    if (url.endsWith("/oauth-clients")) {
      return json({ data: stored ? [{ ...client, attributes: { ...client.attributes, "ado-org-name": org } }] : [] });
    }
    if (url === "/api/v2/oauth-clients/oc-ado/oauth-tokens") return json({ data: hasToken ? [token] : [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings/vcs"]}>
      <Link to="/app/platform/settings/vcs">Switch organization</Link>
      <Link to="/app/acme/settings/vcs">Return to Acme</Link>
      <Routes>
        <Route
          path="/app/:orgName/settings/vcs"
          element={
            <VcsIntegrations
              navigateExternal={(url): void => {
                destinations.push(url);
              }}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { writes, requests, destinations, view };
}

async function openCreate(view: ReturnType<typeof render>): Promise<void> {
  fireEvent.click(await view.findByRole("button", { name: "Add VCS Provider" }));
  fireEvent.change(view.getByLabelText("VCS Type"), { target: { value: "ado_services" } });
}

function fillCredentials(
  view: ReturnType<typeof render>,
  org = "acme-ado",
  pat = testPat,
  secret = testHookSecret,
): void {
  fireEvent.input(view.getByLabelText("Azure DevOps organization"), { target: { value: org } });
  fireEvent.change(view.getByLabelText("Personal access token (PAT)"), { target: { value: pat } });
  fireEvent.change(view.getByLabelText(/webhook secret/i), { target: { value: secret } });
}

function input(view: ReturnType<typeof render>, label: string | RegExp): HTMLInputElement {
  // SAFETY: these labels are bound to HTML input controls in the credential form.
  return view.getByLabelText(label) as HTMLInputElement;
}

function assertNoCredentialText(view: ReturnType<typeof render>): void {
  expect(view.baseElement.innerHTML).not.toContain(testPat);
  expect(view.baseElement.innerHTML).not.toContain(testHookSecret);
  expect(localStorage.length).toBe(0);
}

afterEach((): void => {
  cleanup();
  expireAuthSession();
  localStorage.clear();
  globalThis.fetch = originalFetch;
});

test("creates an organization-scoped PAT connection through the authenticated backend without OAuth redirect", async () => {
  const { view, writes, requests, destinations } = fixture();
  await openCreate(view);
  fillCredentials(view, "Acme-ADO");
  expect(input(view, "Personal access token (PAT)").type).toBe("password");
  expect(input(view, "Webhook secret").type).toBe("password");
  expect(input(view, "HTTP URL").readOnly).toBeTrue();
  expect(input(view, "HTTP URL").value).toBe("https://dev.azure.com");
  expect(input(view, "API URL").value).toBe("https://dev.azure.com");
  expect(view.queryByLabelText("OAuth Application Client ID")).toBeNull();
  assertNoCredentialText(view);
  fireEvent.click(view.getByRole("button", { name: "Connect VCS Provider" }));
  await view.findByText("PAT configured");
  expect(view.getByText("Live access not verified.")).toBeTruthy();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.url).toBe("/api/v2/organizations/acme/oauth-clients");
  expect(new Headers(writes[0]?.init.headers).get("authorization")).toBe("Bearer spa-token");
  expect(writes[0]?.attributes).toEqual({
    name: "ADO_SERVICES Provider",
    "service-provider": "ado_services",
    "http-url": "https://dev.azure.com",
    "api-url": "https://dev.azure.com",
    "ado-org-name": "acme-ado",
    "oauth-token": testPat,
    secret: testHookSecret,
  });
  expect(destinations).toEqual([]);
  expect(
    requests.some(
      (url): boolean =>
        url.includes("/connect") ||
        url.includes(testPat) ||
        new URL(url, "http://terrence.test").origin !== "http://terrence.test",
    ),
  ).toBeFalse();
  expect(await view.findByRole("heading", { name: "Azure DevOps service hooks" })).toBeTruthy();
  expect(view.getByText("http://localhost/api/webhooks/azure-devops/oc-ado")).toBeTruthy();
  expect(view.getByText(/Basic authentication username/).textContent).toContain("oc-ado");
  assertNoCredentialText(view);
});

test.each([
  ["https://dev.azure.com/acme", testPat, testHookSecret, "Enter the Azure DevOps organization name"],
  ["", testPat, testHookSecret, "Enter the Azure DevOps organization name"],
  ["acme-ado", "", testHookSecret, "A personal access token is required"],
  ["acme-ado", testPat, "", "A separate webhook secret is required"],
])(
  "validates Azure PAT fields without sending incomplete credentials (%s)",
  async (org, pat, secret, expected): Promise<void> => {
    const { view, writes } = fixture();
    await openCreate(view);
    fillCredentials(view, org, pat, secret);
    fireEvent.click(view.getByRole("button", { name: "Connect VCS Provider" }));
    expect(view.getByRole("alert").textContent).toContain(expected);
    expect(writes).toHaveLength(0);
    expect(input(view, "Personal access token (PAT)").value).toBe("");
    expect(input(view, "Webhook secret").value).toBe("");
  },
);

test("clears credentials on provider changes, cancel, and reopening", async () => {
  const { view, writes } = fixture();
  await openCreate(view);
  fillCredentials(view);
  fireEvent.change(view.getByLabelText("VCS Type"), { target: { value: "github" } });
  expect(input(view, "OAuth Client Secret").value).toBe("");
  fireEvent.change(view.getByLabelText("VCS Type"), { target: { value: "ado_services" } });
  expect(input(view, "Personal access token (PAT)").value).toBe("");
  fillCredentials(view);
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  expect(view.queryByRole("dialog")).toBeNull();
  await openCreate(view);
  expect(input(view, "Personal access token (PAT)").value).toBe("");
  expect(input(view, "Webhook secret").value).toBe("");
  assertNoCredentialText(view);
  expect(writes).toHaveLength(0);
});

test("clears rejected credentials and hides backend error bodies before a safe retry", async () => {
  const { view, writes } = fixture({
    onWrite: async (): Promise<Response> =>
      json({ errors: [{ detail: `Rejected ${testPat} ${testHookSecret}` }] }, 422),
  });
  await openCreate(view);
  fillCredentials(view);
  fireEvent.click(view.getByRole("button", { name: "Connect VCS Provider" }));
  expect((await view.findByRole("alert")).textContent).toContain("Could not save the Azure DevOps credentials");
  expect(input(view, "Personal access token (PAT)").value).toBe("");
  expect(input(view, "Webhook secret").value).toBe("");
  assertNoCredentialText(view);
  fillCredentials(view, "acme-ado", "replacement-pat", "replacement-hook-secret");
  fireEvent.click(view.getByRole("button", { name: "Connect VCS Provider" }));
  await waitFor((): void => {
    expect(writes).toHaveLength(2);
  });
  expect(writes[1]?.attributes["oauth-token"]).toBe("replacement-pat");
});

test("existing compatibility-only clients show Not connected and can add a PAT", async () => {
  const { view, writes, destinations } = fixture({ existing: true, organization: "" });
  expect(await view.findByText("Not connected")).toBeTruthy();
  expect(view.queryByText("Repository integration unavailable")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Add PAT" }));
  expect(input(view, "Azure DevOps organization").readOnly).toBeFalse();
  fillCredentials(view);
  fireEvent.click(view.getByRole("button", { name: "Save PAT" }));
  await view.findByText("PAT configured");
  expect(writes[0]?.url).toBe("/api/v2/oauth-clients/oc-ado");
  expect(writes[0]?.init.method).toBe("PATCH");
  expect(writes[0]?.attributes["ado-org-name"]).toBe("acme-ado");
  expect(destinations).toEqual([]);
});

test("rotates PAT in place without changing organization or sending a blank webhook secret", async () => {
  const { view, writes, destinations } = fixture({ existing: true, configured: true });
  await view.findByText("PAT configured");
  expect(view.queryByText("Connected as pat-user")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Rotate PAT" }));
  expect(input(view, "Azure DevOps organization").readOnly).toBeTrue();
  fireEvent.change(input(view, "Personal access token (PAT)"), { target: { value: testPat } });
  fireEvent.click(view.getByRole("button", { name: "Save PAT" }));
  await waitFor((): void => {
    expect(view.queryByRole("dialog")).toBeNull();
  });
  await view.findByText("PAT configured");
  expect(writes).toHaveLength(1);
  expect(writes[0]?.attributes).toEqual({ "ado-org-name": "acme-ado", "oauth-token": testPat });
  expect(new Headers(writes[0]?.init.headers).get("authorization")).toBe("Bearer spa-token");
  expect(destinations).toEqual([]);
  fireEvent.click(view.getByRole("button", { name: "Rotate PAT" }));
  expect(input(view, "Personal access token (PAT)").value).toBe("");
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  expect(view.queryByRole("dialog")).toBeNull();
});

test.each(["create", "rotate"])(
  "ignores duplicate submissions and late %s responses after cancel",
  async (mode): Promise<void> => {
    let resolveWrite: (response: Response) => void = (): void => {
      throw new Error("Write has not started");
    };
    const pending = new Promise<Response>((resolve): void => {
      resolveWrite = resolve;
    });
    const { view, writes, destinations } = fixture({
      existing: mode === "rotate",
      configured: mode === "rotate",
      onWrite: async (): Promise<Response> => pending,
    });
    if (mode === "create") await openCreate(view);
    else fireEvent.click(await view.findByRole("button", { name: "Rotate PAT" }));
    fillCredentials(view);
    const form = input(view, "Personal access token (PAT)").closest("form");
    if (form === null) throw new Error("Expected a credential form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor((): void => {
      expect(writes).toHaveLength(1);
    });
    expect(input(view, "Personal access token (PAT)").value).toBe("");
    expect(input(view, /webhook secret/i).value).toBe("");
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(writes[0]?.init.signal?.aborted).toBeTrue();
    expect(view.queryByRole("dialog")).toBeNull();
    await act(async (): Promise<void> => {
      resolveWrite(json({ data: client }, 201));
      await pending;
    });
    expect(view.queryByRole("dialog")).toBeNull();
    expect(destinations).toEqual([]);
    if (mode === "create") await openCreate(view);
    else fireEvent.click(view.getByRole("button", { name: "Rotate PAT" }));
    expect(input(view, "Personal access token (PAT)").value).toBe("");
    assertNoCredentialText(view);
  },
);

test.each(["create", "rotate"])(
  "clears %s state when navigating away and ignores late responses after returning",
  async (mode): Promise<void> => {
    let resolveWrite: (response: Response) => void = (): void => {
      throw new Error("Write has not started");
    };
    const pending = new Promise<Response>((resolve): void => {
      resolveWrite = resolve;
    });
    const { view, writes, destinations } = fixture({
      existing: mode === "rotate",
      configured: mode === "rotate",
      onWrite: async (): Promise<Response> => pending,
    });
    if (mode === "create") await openCreate(view);
    else fireEvent.click(await view.findByRole("button", { name: "Rotate PAT" }));
    fillCredentials(view);
    fireEvent.click(view.getByRole("button", { name: mode === "create" ? "Connect VCS Provider" : "Save PAT" }));
    await waitFor((): void => {
      expect(writes).toHaveLength(1);
    });
    fireEvent.click(view.getByRole("link", { name: "Switch organization" }));
    await view.findByRole("button", { name: "Add VCS Provider" });
    expect(view.queryByRole("dialog")).toBeNull();
    expect(writes[0]?.init.signal?.aborted).toBeTrue();
    fireEvent.click(view.getByRole("link", { name: "Return to Acme" }));
    await view.findByRole("button", { name: "Add VCS Provider" });
    await act(async (): Promise<void> => {
      resolveWrite(json({ data: client }, 201));
      await pending;
    });
    expect(view.queryByRole("dialog")).toBeNull();
    expect(destinations).toEqual([]);
    assertNoCredentialText(view);
  },
);

test("service-hook instructions expose only the endpoint and username, not stored credentials", async () => {
  const { view, writes } = fixture({ existing: true, configured: true });
  fireEvent.click(await view.findByRole("button", { name: "Service hook setup" }));
  const dialog = view.getByRole("dialog");
  expect(within(dialog).getByText(/Code pushed, Pull request created and Pull request updated/)).toBeTruthy();
  expect(within(dialog).getByText(/Do not use your PAT/)).toBeTruthy();
  expect(within(dialog).getByText(/does not create subscriptions/)).toBeTruthy();
  expect(writes).toHaveLength(0);
  assertNoCredentialText(view);
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(view.queryByRole("dialog")).toBeNull();
});
