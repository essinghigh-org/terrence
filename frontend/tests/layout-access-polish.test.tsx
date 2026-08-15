import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Outlet, Route, Routes } from "react-router-dom";

import { Layout } from "../src/components/Layout";
import { AdminDashboard } from "../src/views/AdminDashboard";
import { AccountSettings } from "../src/views/AccountSettings";
import { OrganizationSettings } from "../src/views/OrganizationSettings";

const originalFetch = globalThis.fetch;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete): void => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("shows identity, organization switching, and site administration when authorized", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/v2/account/details") {
      return json({ data: { attributes: { username: "alice", "is-site-admin": true } } });
    }
    if (url === "/api/v2/organizations?page[size]=100") {
      return json({
        data: [
          { id: "org-acme", attributes: { name: "acme" } },
          { id: "org-platform", attributes: { name: "platform" } },
        ],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Routes>
        <Route path="/app/:orgName" element={<Layout />}>
          <Route index element={<p>Organization content</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("Organization content")).toBeTruthy();
  });
  fireEvent.click(view.getByRole("button", { name: "Account menu" }));
  await waitFor((): void => {
    expect(view.getByText("alice")).toBeTruthy();
    expect(view.getByText("Site administration")).toBeTruthy();
  });

  fireEvent.click(view.getByRole("button", { name: "Organization menu for acme" }));
  await waitFor((): void => {
    expect(view.getByText("Switch organization")).toBeTruthy();
    expect(view.getByText("platform")).toBeTruthy();
  });
});

test("redirects non-administrators before loading site data", async () => {
  const fetchMock = mock(async (): Promise<Response> => {
    throw new Error("Admin data must not be requested");
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route element={<Outlet context={{ accountLoaded: true, siteAdmin: false }} />}>
          <Route path="/admin" element={<AdminDashboard section="security" />} />
        </Route>
        <Route path="/app" element={<p>Organizations home</p>} />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("Organizations home")).toBeTruthy();
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("uses one contextual sidebar across organization settings", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/v2/account/details") {
      return json({ data: { attributes: { username: "alice", "is-site-admin": false } } });
    }
    if (url === "/api/v2/organizations?page[size]=100") {
      return json({ data: [{ id: "org-acme", attributes: { name: "acme" } }] });
    }
    if (url === "/api/v2/organizations/acme") {
      return json({
        data: {
          id: "org-acme",
          attributes: {
            name: "acme",
            "default-iac-binary": "tofu",
            "default-terraform-version": "latest",
            permissions: {
              "can-manage-agent-pools": true,
              "can-manage-projects": true,
              "can-manage-vcs-settings": true,
              "can-manage-workspaces": true,
              "can-read-projects": true,
            },
          },
        },
      });
    }
    if (
      url === "/api/v2/organizations/acme/teams"
      || url === "/api/v2/organizations/acme/organization-memberships"
    ) return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings?tab=teams"]}>
      <Routes>
        <Route path="/app/:orgName" element={<Layout />}>
          <Route path="settings" element={<OrganizationSettings />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("Manage access across the organization.")).toBeTruthy();
  });
  expect(view.getByRole("link", { name: "Teams" }).getAttribute("aria-current")).toBe("page");
  expect(view.getAllByRole("link", { name: "Variable sets" })).toHaveLength(1);
  expect(view.getByRole("link", { name: "VCS providers" }).getAttribute("href"))
    .toBe("/app/acme/settings/vcs");
  expect(view.getByRole("link", { name: "Agent pools" }).getAttribute("href"))
    .toBe("/app/acme/settings/agents");
});

test("keeps General visible and gates managed organization navigation independently", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/v2/account/details") {
      return json({ data: { attributes: { username: "alice", "is-site-admin": false } } });
    }
    if (url === "/api/v2/organizations?page[size]=100") {
      return json({ data: [{ id: "org-acme", attributes: { name: "acme" } }] });
    }
    if (url === "/api/v2/organizations/acme") {
      return json({
        data: {
          attributes: {
            permissions: {
              "can-manage-agent-pools": false,
              "can-manage-projects": false,
              "can-manage-vcs-settings": true,
              "can-manage-workspaces": false,
              "can-read-projects": false,
            },
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Routes>
        <Route path="/app/:orgName" element={<Layout />}>
          <Route index element={<p>Organization content</p>} />
          <Route path="settings" element={<p>Organization settings content</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input]): boolean =>
      (typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
        === "/api/v2/organizations/acme")).toBe(true);
  });
  expect(view.queryByRole("link", { name: "Projects" })).toBeNull();
  expect(view.queryByRole("link", { name: "No-code modules" })).toBeNull();

  fireEvent.click(view.getByRole("link", { name: "Settings" }));
  await waitFor((): void => {
    expect(view.getByText("Organization settings content")).toBeTruthy();
  });
  expect(view.getByRole("link", { name: "General" })).toBeTruthy();
  expect(view.queryByRole("link", { name: "Variable sets" })).toBeNull();
  expect(view.getByRole("link", { name: "VCS providers" })).toBeTruthy();
  expect(view.queryByRole("link", { name: "Agent pools" })).toBeNull();
});

test("fails closed while organization permissions change or fail to load", async () => {
  const acmePermissions = deferred<Response>();
  let acmeSignal: AbortSignal | null = null;
  const fetchMock = mock(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/v2/account/details") {
      return json({ data: { attributes: { username: "alice", "is-site-admin": false } } });
    }
    if (url === "/api/v2/organizations?page[size]=100") {
      return json({
        data: [
          { id: "org-acme", attributes: { name: "acme" } },
          { id: "org-platform", attributes: { name: "platform" } },
        ],
      });
    }
    if (url === "/api/v2/organizations/acme") {
      acmeSignal = init?.signal ?? null;
      return acmePermissions.promise;
    }
    if (url === "/api/v2/organizations/platform") {
      throw new Error("Permission lookup failed");
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Link to="/app/platform">Open platform</Link>
      <Routes>
        <Route
          path="/app/:orgName"
          element={<Layout><p>Organization content</p></Layout>}
        />
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(acmeSignal).not.toBeNull();
  });
  expect(view.queryByRole("link", { name: "No-code modules" })).toBeNull();

  fireEvent.click(view.getByRole("link", { name: "Open platform" }));
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input]): boolean =>
      (typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
        === "/api/v2/organizations/platform")).toBe(true);
    expect(acmeSignal?.aborted).toBe(true);
  });

  await act(async (): Promise<void> => {
    acmePermissions.resolve(json({
      data: {
        attributes: {
          permissions: {
            "can-manage-agent-pools": true,
            "can-manage-vcs-settings": true,
            "can-manage-workspaces": true,
          },
        },
      },
    }));
    await new Promise<void>((resolve): void => {
      window.setTimeout(resolve, 0);
    });
  });
  expect(view.queryByRole("link", { name: "No-code modules" })).toBeNull();
});

test("uses contextual account navigation", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/v2/account/details") {
      return json({ data: { attributes: { username: "alice", "is-site-admin": false } } });
    }
    if (url === "/api/v2/organizations?page[size]=100") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/account"]}>
      <Routes>
        <Route path="/app" element={<Layout />}>
          <Route path="account" element={<p>Account content</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByText("Account content")).toBeTruthy();
  });
  expect(view.getByRole("link", { name: "Profile" }).getAttribute("aria-current")).toBe("page");
  expect(view.getByRole("link", { name: "Sessions" }).getAttribute("href"))
    .toBe("/app/account#sessions");
  expect(view.getByRole("link", { name: "Password" }).getAttribute("href"))
    .toBe("/app/account#password");
  expect(view.getByRole("link", { name: "API tokens" }).getAttribute("href"))
    .toBe("/app/account#api-tokens");
});

test("only shows password navigation while a password change is required", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/v2/account/details") {
      return json({
        data: {
          attributes: {
            username: "admin",
            "is-site-admin": true,
            "must-change-password": true,
          },
        },
      });
    }
    if (url === "/api/v2/organizations?page[size]=100") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/account"]}>
      <Routes>
        <Route path="/app" element={<Layout />}>
          <Route path="account" element={<p>Password content</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("link", { name: "Password" }).getAttribute("aria-current")).toBe("page");
  });
  expect(view.queryByRole("link", { name: "Profile" })).toBeNull();
  expect(view.queryByRole("link", { name: "Sessions" })).toBeNull();
  expect(view.queryByRole("link", { name: "API tokens" })).toBeNull();
});

test("scrolls contextual account links after account data loads", async () => {
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/v2/account/details") {
      return json({
        data: {
          id: "user-1",
          attributes: { username: "alice", email: "alice@example.com", "is-site-admin": false },
        },
      });
    }
    if (url === "/api/v2/users/user-1/authentication-tokens") return json({ data: [] });
    if (url === "/api/v2/organizations?page[size]=100") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/account"]}>
      <Routes>
        <Route path="/app" element={<Layout />}>
          <Route path="account" element={<AccountSettings />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  await view.findByRole("button", { name: "Save Profile" });
  const tokenHeading = (await view.findAllByText("API Tokens")).find((el) => el.closest("#api-tokens") !== null)!;
// SAFETY: closest() resolves to the row element that contains the queried text.
  const tokenCard = tokenHeading.closest("#api-tokens") as HTMLElement;
  const scrollIntoView = mock((): void => undefined);
  tokenCard.scrollIntoView = scrollIntoView;

  fireEvent.click(view.getByRole("link", { name: "API tokens" }));
  await waitFor((): void => {
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
  expect(view.getByRole("link", { name: "API tokens" }).getAttribute("aria-current")).toBe("page");
});

test("keeps failed account details read-only until retry succeeds", async () => {
  let detailsRequests = 0;
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/v2/account/details") {
      detailsRequests += 1;
      if (detailsRequests === 1) {
        return json({ errors: [{ title: "Service unavailable" }] }, 503);
      }
      return json({
        data: {
          id: "user-1",
          attributes: { username: "alice", email: "alice@example.com" },
        },
      });
    }
    if (url === "/api/v2/users/user-1/authentication-tokens") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/account"]}>
      <AccountSettings />
    </MemoryRouter>,
  );

  await view.findByText("Could not load account settings");
  expect(view.queryByRole("button", { name: "Save Profile" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  await view.findByDisplayValue("alice");
  expect(detailsRequests).toBe(2);
});
