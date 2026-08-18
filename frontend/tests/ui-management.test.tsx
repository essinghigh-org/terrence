import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

import { OrganizationSettings } from "../src/views/OrganizationSettings";
import { Projects } from "../src/views/Projects";
import { Workspaces } from "../src/views/Workspaces";
import { isString } from "../src/lib/type-guards";
import type { JsonValue } from "../src/lib/json";

const originalFetch = globalThis.fetch;
const json = (data: JsonValue, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
const urlOf = (input: string | URL | Request): string =>
  isString(input) ? input : input instanceof URL ? input.toString() : input.url;

afterEach((): void => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("edits and deletes projects through supported routes and reassigns a workspace", async () => {
  const projects = [
    { id: "project-default", attributes: { name: "Default Project", description: null } },
    { id: "project-app", attributes: { name: "Applications", description: "App workloads" } },
  ];
  const workspace = {
    id: "workspace-1",
    attributes: { name: "production" },
    relationships: { project: { data: { id: "project-default", type: "projects" } } },
  };
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme/projects") return json({ data: projects });
    if (url.startsWith("/api/v2/organizations/acme/workspaces?page%5Bsize%5D=100")) return json({ data: [workspace] });
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { permissions: { "can-manage-projects": true } } } });
    }
    if (url === "/api/v2/projects/project-app" && init?.method === "PATCH") return json({ data: projects[1] });
    if (url === "/api/v2/projects/project-app" && init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url === "/api/v2/workspaces/workspace-1" && init?.method === "PATCH") return json({ data: workspace });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/projects"]}>
      <Routes><Route path="/app/:orgName/projects" element={<Projects />} /></Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Applications")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Edit Applications" }));
  await act(async (): Promise<void> => {
    fireEvent.input(view.getByLabelText("Name"), { target: { value: "Platform" } });
  });
  await act(async (): Promise<void> => {
    const form = view.getByRole("button", { name: "Save project" }).closest("form");
    if (form !== null) fireEvent.submit(form);
  });
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/projects/project-app" && init?.method === "PATCH")).toBeTrue();
  });

  fireEvent.click(view.getByRole("button", { name: "Assign workspaces" }));
  fireEvent.change(view.getByLabelText("Project for production"), { target: { value: "project-app" } });
  await waitFor((): void => {
    const assignment = fetchMock.mock.calls.find(([input, init]): boolean =>
      urlOf(input) === "/api/v2/workspaces/workspace-1" && init?.method === "PATCH");
    expect(assignment).toBeDefined();
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
    expect(JSON.parse(assignment?.[1]?.body as string).data.relationships.project.data.id).toBe("project-app");
  });

  fireEvent.click(view.getByRole("button", { name: "Close" }));
  fireEvent.click(view.getByRole("button", { name: "Delete Applications" }));
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/projects/project-app" && init?.method === "DELETE")).toBeTrue();
  });
});

test("keeps projects read-only without project management permission", async () => {
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme/projects") {
      return json({ data: [{ id: "project-app", attributes: { name: "Applications" } }] });
    }
    if (url.startsWith("/api/v2/organizations/acme/workspaces?page%5Bsize%5D=100")) return json({ data: [] });
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { permissions: { "can-manage-projects": false } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/projects"]}>
      <Routes><Route path="/app/:orgName/projects" element={<Projects />} /></Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Applications")).toBeTruthy(); });
  expect(view.queryByRole("button", { name: "Create project" })).toBeNull();
  expect(view.queryByRole("button", { name: "Assign workspaces" })).toBeNull();
  expect(view.queryByRole("button", { name: "Edit Applications" })).toBeNull();
  expect(view.queryByRole("button", { name: "Delete Applications" })).toBeNull();
  expect(fetchMock.mock.calls.every(([, init]): boolean => init?.method === undefined)).toBeTrue();
});

test("ignores stale projects and permissions after changing organizations", async () => {
  let resolveAcmeProjects!: (response: Response) => void;
  const acmeProjects = new Promise<Response>((resolve): void => { resolveAcmeProjects = resolve; });
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme/projects") return acmeProjects;
    if (url === "/api/v2/organizations/platform/projects") {
      return json({ data: [{ id: "project-platform", attributes: { name: "Platform" } }] });
    }
    if (url.includes("/workspaces?page%5Bsize%5D=100")) return json({ data: [] });
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { permissions: { "can-manage-projects": true } } } });
    }
    if (url === "/api/v2/organizations/platform") {
      return json({ data: { attributes: { permissions: { "can-manage-projects": false } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/projects"]}>
      <Link to="/app/platform/projects">Switch organization</Link>
      <Routes><Route path="/app/:orgName/projects" element={<Projects />} /></Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input]): boolean =>
      urlOf(input) === "/api/v2/organizations/acme/projects")).toBeTrue();
  });
  fireEvent.click(view.getByRole("link", { name: "Switch organization" }));
  expect(await view.findByText("Platform")).toBeTruthy();

  await act(async (): Promise<void> => {
    resolveAcmeProjects(json({
      data: [{ id: "project-acme", attributes: { name: "Acme project" } }],
    }));
    await acmeProjects;
  });

  expect(view.queryByText("Acme project")).toBeNull();
  expect(view.queryByRole("button", { name: "Create project" })).toBeNull();
});

test("filters workspaces by run status and adds, updates, and removes tags", async () => {
  const tags: { id: string; attributes: { key: string; value: string } }[] = [];
  const workspace = () => ({
    id: "workspace-1",
    attributes: {
      name: "production",
      locked: false,
      permissions: { "can-update": true },
      "tag-names": tags.map((tag): string => tag.attributes.key),
      "vcs-repo": null,
    },
    relationships: { project: { data: { id: "project-default", type: "projects" } } },
  });
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url.startsWith("/api/v2/organizations/acme/workspaces?")) return json({ data: [workspace()] });
    if (url.startsWith("/api/v2/organizations/acme/projects?")) {
      return json({ data: [{ id: "project-default", attributes: { name: "Default Project" } }] });
    }
    if (url.startsWith("/api/v2/organizations/acme/runs?")) return json({ data: [] });
    if (url === "/api/v2/workspaces/workspace-1/tag-bindings" && init?.method === undefined) return json({ data: tags });
    if (url === "/api/v2/workspaces/workspace-1/tag-bindings" && init?.method === "PATCH") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      const payload = JSON.parse(init.body as string) as { data: { attributes: { key: string; value: string } }[] };
      for (const item of payload.data) {
        const existing = tags.find((tag): boolean => tag.attributes.key === item.attributes.key);
        if (existing === undefined) tags.push({ id: `tag-${tags.length + 1}`, attributes: item.attributes });
        else existing.attributes.value = item.attributes.value;
      }
      return json({ data: tags });
    }
    if (url === "/api/v2/workspaces/workspace-1/relationships/tags" && init?.method === "DELETE") {
      tags.splice(0);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Routes><Route path="/app/:orgName" element={<Workspaces />} /></Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("production")).toBeTruthy(); });
  fireEvent.change(view.getByLabelText("Status filter"), { target: { value: "errored" } });
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input]): boolean =>
      urlOf(input).includes("filter%5Bcurrent-run%5D%5Bstatus%5D=errored"))).toBeTrue();
  });
  fireEvent.change(view.getByLabelText("Status filter"), { target: { value: "completed" } });
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input]): boolean =>
      urlOf(input).includes("planned_and_finished"))).toBeTrue();
  });

  fireEvent.click(view.getByRole("button", { name: "Manage tags for production" }));
  await waitFor((): void => { expect(view.getByText("No direct tags.")).toBeTruthy(); });
  await act(async (): Promise<void> => {
    fireEvent.input(view.getByLabelText("Key"), { target: { value: "environment" } });
    fireEvent.input(view.getByLabelText("Value"), { target: { value: "production" } });
  });
  expect(view.getByLabelText("Key").value).toBe("environment");
  expect(view.getByLabelText("Value").value).toBe("production");
  const addTag = await waitFor((): HTMLButtonElement => {
    const button = view.getByRole("button", { name: "Add tag" });
    expect(button.disabled).toBeFalse();
    return button;
  });
  await act(async (): Promise<void> => {
    fireEvent.click(addTag);
  });
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/workspaces/workspace-1/tag-bindings" && init?.method === "PATCH")).toBeTrue();
  });
  const tagDialog = view.getByRole("dialog");
// SAFETY: the waited-for element is an HTMLElement in the rendered DOM.
  const tagRow = await waitFor((): HTMLElement =>
    within(tagDialog).getByText("environment").closest("tr") as HTMLElement,
  );
  expect(within(tagRow).getByText("production")).toBeTruthy();

  fireEvent.click(within(tagRow).getByRole("button", { name: "Edit tag environment" }));
  await act(async (): Promise<void> => {
    fireEvent.input(view.getByLabelText("Value"), { target: { value: "prod" } });
  });
  const updateTag = view.getByRole("button", { name: "Update tag" });
  await act(async (): Promise<void> => {
    fireEvent.click(updateTag);
  });
  await waitFor((): void => { expect(view.getByText("prod")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Delete tag environment" }));
  await waitFor((): void => { expect(view.getByText("No direct tags.")).toBeTruthy(); });
});

test("manages team organization access, invites a member, and removes them", async () => {
  const memberships = [{
    id: "membership-owner",
    attributes: { email: "owner@example.com", role: "owner", status: "active" },
  }];
  let team = {
    id: "team-1",
    attributes: {
      name: "Developers",
      visibility: "organization",
      "users-count": 1,
      "organization-access": {
        "manage-projects": false,
        "manage-workspaces": false,
        "manage-modules": false,
      },
    },
  };
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme" && init?.method === undefined) {
      return json({
        data: {
          id: "org-1",
          attributes: {
            name: "acme",
            permissions: {
              "can-update": true,
              "can-destroy": true,
              "can-create-team": true,
              "can-manage-users": true,
              "can-update-organization-access": true,
            },
          },
        },
      });
    }
    if (url === "/api/v2/organizations/acme/teams" && init?.method === undefined) return json({ data: [team] });
    if (url === "/api/v2/teams/team-1" && init?.method === "PATCH") {
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
      const payload = JSON.parse(init.body as string) as {
        data: { attributes: { "organization-access": Record<string, boolean> } };
      };
      team = {
        ...team,
        attributes: {
          ...team.attributes,
          "organization-access": payload.data.attributes["organization-access"],
        },
      };
      return json({ data: team });
    }
    if (url === "/api/v2/organizations/acme/organization-memberships" && init?.method === undefined) {
      return json({ data: memberships });
    }
    if (url === "/api/v2/organizations/acme/organization-memberships" && init?.method === "POST") {
      memberships.push({
        id: "membership-invite",
        attributes: { email: "new@example.com", role: "member", status: "invited" },
      });
      return json({ data: memberships[1] }, 201);
    }
    if (url === "/api/v2/organization-memberships/membership-invite" && init?.method === "DELETE") {
      memberships.splice(1);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings?tab=teams"]}>
      <Routes><Route path="/app/:orgName/settings" element={<OrganizationSettings />} /></Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Organization Settings")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Manage permissions for Developers" }));
  fireEvent.click(view.getByLabelText("Manage Projects"));
  fireEvent.click(view.getByLabelText("Manage Modules"));
  expect(view.getByLabelText("Manage Workspaces").getAttribute("aria-checked")).toBe("true");
  await act(async (): Promise<void> => {
    fireEvent.click(view.getByRole("button", { name: "Save permissions" }));
  });
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/teams/team-1" && init?.method === "PATCH")).toBeTrue();
  });
  const permissionCall = fetchMock.mock.calls.find(([input, init]): boolean =>
    urlOf(input) === "/api/v2/teams/team-1" && init?.method === "PATCH");
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
  const savedPermissions = JSON.parse(permissionCall?.[1]?.body as string).data.attributes["organization-access"];
  expect(savedPermissions).toMatchObject({
    "manage-projects": true,
    "manage-workspaces": true,
    "manage-modules": true,
  });

  await act(async (): Promise<void> => {
    fireEvent.input(view.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(view.getByLabelText("Team"), { target: { value: "team-1" } });
  });
  expect(view.getByLabelText("Email").value).toBe("new@example.com");
  const invite = await waitFor((): HTMLButtonElement => {
    const button = view.getByRole("button", { name: "Invite" });
    expect(button.disabled).toBeFalse();
    return button;
  });
  await act(async (): Promise<void> => {
    fireEvent.click(invite);
  });
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/organizations/acme/organization-memberships" && init?.method === "POST")).toBeTrue();
  });
  await waitFor((): void => { expect(view.getByText("new@example.com")).toBeTruthy(); });
  const inviteCall = fetchMock.mock.calls.find(([input, init]): boolean =>
    urlOf(input) === "/api/v2/organizations/acme/organization-memberships" && init?.method === "POST");
// SAFETY: the request body was JSON.stringify'd by the caller before fetch.
  expect(JSON.parse(inviteCall?.[1]?.body as string).data.relationships.teams.data).toEqual([
    { id: "team-1", type: "teams" },
  ]);

  fireEvent.click(view.getByRole("button", { name: "Remove new@example.com" }));
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/organization-memberships/membership-invite" && init?.method === "DELETE")).toBeTrue();
  });
});

test("renders and saves the organization agent execution mode", async () => {
  let postedBody: string | undefined;
  const organization = {
    id: "org-1",
    attributes: {
      name: "acme",
      permissions: { "can-update": true },
      "default-execution-mode": "agent",
    },
  };
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme" && init?.method === "PATCH") {
      postedBody = init.body as string;
      return json({ data: organization });
    }
    if (url === "/api/v2/organizations/acme") return json({ data: organization });
    if (url === "/api/v2/organizations/acme/teams") return json({ data: [] });
    if (url === "/api/v2/organizations/acme/roles") return json({ data: [] });
    if (url === "/api/v2/organizations/acme/organization-memberships") return json({ data: [] });
    if (url === "/api/v2/organizations/acme/relationships/data-retention-policy") return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings"]}>
      <Routes><Route path="/app/:orgName/settings" element={<OrganizationSettings />} /></Routes>
    </MemoryRouter>,
  );

  const agentText = await view.findByText("Agent", { exact: true });
  const agentRadio = agentText.closest("label")?.querySelector<HTMLInputElement>("input[type=radio]");
  expect(agentRadio).not.toBeNull();
  expect(agentRadio?.checked).toBeTrue();
  const form = view.getByRole("button", { name: "Save settings" }).closest("form");
  expect(form).not.toBeNull();
  // SAFETY: the form is present because the preceding role query found its submit button.
  fireEvent.submit(form as HTMLFormElement);

  await waitFor((): void => { expect(postedBody).toBeDefined(); });
  if (postedBody === undefined) throw new Error("Expected a serialized organization PATCH body");
  // SAFETY: the request body is JSON.stringify'd by the component and has the JSON:API shape asserted below.
  const posted = JSON.parse(postedBody) as {
    data?: { attributes?: { "default-execution-mode"?: string } };
  };
  expect(posted.data?.attributes?.["default-execution-mode"]).toBe("agent");
});

test("fails closed for organization and team mutations without explicit permissions", async () => {
  const fetchMock = mock(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { id: "org-1", attributes: { name: "acme" } } });
    }
    if (url === "/api/v2/organizations/acme/teams") {
      return json({ data: [{ id: "team-1", attributes: { name: "Developers" } }] });
    }
    if (url === "/api/v2/organizations/acme/organization-memberships") {
      return json({
        data: [{
          id: "membership-1",
          attributes: { email: "member@example.com", role: "member", status: "active" },
        }],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const teamsView = render(
    <MemoryRouter initialEntries={["/app/acme/settings?tab=teams"]}>
      <Routes><Route path="/app/:orgName/settings" element={<OrganizationSettings />} /></Routes>
    </MemoryRouter>,
  );

  await teamsView.findByText("Manage access across the organization.");
  expect(teamsView.getByPlaceholderText("New team name").disabled).toBeTrue();
  expect(teamsView.getByRole("button", { name: "Manage permissions for Developers" }).disabled).toBeTrue();
  expect(teamsView.getByLabelText("Email").disabled).toBeTrue();
  expect(teamsView.getByRole("button", { name: "Invite" }).disabled).toBeTrue();
  expect(teamsView.getByRole("button", { name: "Remove member@example.com" }).disabled).toBeTrue();
  teamsView.unmount();

  const generalView = render(
    <MemoryRouter initialEntries={["/app/acme/settings"]}>
      <Routes><Route path="/app/:orgName/settings" element={<OrganizationSettings />} /></Routes>
    </MemoryRouter>,
  );

  await generalView.findByText("Organization owner access is required to change these settings.");
  expect(generalView.getByLabelText("Organization Name").disabled).toBeTrue();
  expect(generalView.getByRole("button", { name: "Save settings" }).disabled).toBeTrue();
  expect(generalView.getByRole("button", { name: "Delete Organization" }).disabled).toBeTrue();
  expect(fetchMock.mock.calls.every(([, init]): boolean => init?.method === undefined)).toBeTrue();
});

test("shows a retryable organization load error", async () => {
  let organizationRequests = 0;
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme") {
      organizationRequests += 1;
      if (organizationRequests === 1) {
        return json({ errors: [{ title: "Service unavailable" }] }, 503);
      }
      return json({ data: { id: "org-1", attributes: { name: "acme", permissions: {} } } });
    }
    if (
      url === "/api/v2/organizations/acme/teams"
      || url === "/api/v2/organizations/acme/organization-memberships"
    ) return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings"]}>
      <Routes><Route path="/app/:orgName/settings" element={<OrganizationSettings />} /></Routes>
    </MemoryRouter>,
  );

  await view.findByRole("alert");
  expect(view.getByText("Could not load organization settings")).toBeTruthy();
  expect(view.queryByText("Loading organization settings...")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  await view.findByText("Organization Settings");
  expect(organizationRequests).toBe(2);
});

test("surfaces and retries team and member load errors", async () => {
  let teamRequests = 0;
  let membershipRequests = 0;
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { id: "org-1", attributes: { name: "acme", permissions: {} } } });
    }
    if (url === "/api/v2/organizations/acme/teams") {
      teamRequests += 1;
      return teamRequests === 1
        ? json({ errors: [{ title: "Teams unavailable" }] }, 503)
        : json({ data: [] });
    }
    if (url === "/api/v2/organizations/acme/organization-memberships") {
      membershipRequests += 1;
      return membershipRequests === 1
        ? json({ errors: [{ title: "Members unavailable" }] }, 503)
        : json({ data: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings?tab=teams"]}>
      <Routes><Route path="/app/:orgName/settings" element={<OrganizationSettings />} /></Routes>
    </MemoryRouter>,
  );

  await view.findByRole("button", { name: "Retry teams" });
  expect(view.getByRole("button", { name: "Retry members" })).toBeTruthy();
  expect(view.queryByText("No teams created yet.")).toBeNull();
  expect(view.queryByText("No organization members found.")).toBeNull();

  fireEvent.click(view.getByRole("button", { name: "Retry teams" }));
  fireEvent.click(view.getByRole("button", { name: "Retry members" }));
  await waitFor((): void => {
    expect(view.queryByRole("button", { name: "Retry teams" })).toBeNull();
    expect(view.queryByRole("button", { name: "Retry members" })).toBeNull();
  });
  expect(view.getByText("No teams created yet.")).toBeTruthy();
  expect(view.getByText("No organization members found.")).toBeTruthy();
  expect(teamRequests).toBe(2);
  expect(membershipRequests).toBe(2);
});

test("reloads organization settings at the renamed path", async () => {
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme" && init?.method === "PATCH") {
      return json({
        data: {
          id: "org-1",
          attributes: {
            name: "renamed-org",
            permissions: { "can-update": true, "can-destroy": true },
          },
        },
      });
    }
    if (url === "/api/v2/organizations/acme" || url === "/api/v2/organizations/renamed-org") {
      return json({
        data: {
          id: "org-1",
          attributes: {
            name: url.endsWith("renamed-org") ? "renamed-org" : "acme",
            permissions: { "can-update": true, "can-destroy": true },
          },
        },
      });
    }
    if (url.endsWith("/teams") || url.endsWith("/organization-memberships")) return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings"]}>
      <Routes><Route path="/app/:orgName/settings" element={<OrganizationSettings />} /></Routes>
    </MemoryRouter>,
  );

  const input = await view.findByLabelText("Organization Name");
  fireEvent.change(input, { target: { value: "renamed-org" } });
  fireEvent.click(view.getByRole("button", { name: "Save settings" }));
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([request, init]): boolean =>
      urlOf(request) === "/api/v2/organizations/renamed-org" && init?.method === undefined)).toBeTrue();
  });
});

test("ignores an organization response after navigating to another organization", async () => {
  let resolveAcme!: (response: Response) => void;
  const acmeResponse = new Promise<Response>((resolve): void => { resolveAcme = resolve; });
// SAFETY: the mock's handling mirrors the backend contract for this test.
  globalThis.fetch = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/organizations/acme") return acmeResponse;
    if (url === "/api/v2/organizations/platform") {
      return json({
        data: {
          id: "org-platform",
          attributes: { name: "platform", permissions: { "can-update": true } },
        },
      });
    }
    if (url.endsWith("/teams") || url.endsWith("/organization-memberships")) return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings"]}>
      <Link to="/app/platform/settings">Switch organization</Link>
      <Routes><Route path="/app/:orgName/settings" element={<OrganizationSettings />} /></Routes>
    </MemoryRouter>,
  );

  fireEvent.click(view.getByRole("link", { name: "Switch organization" }));
  expect(await view.findByDisplayValue("platform")).toBeTruthy();

  await act(async (): Promise<void> => {
    resolveAcme(json({
      data: {
        id: "org-acme",
        attributes: { name: "acme", permissions: { "can-update": true } },
      },
    }));
    await acmeResponse;
  });

  expect(view.getByDisplayValue("platform")).toBeTruthy();
  expect(view.queryByDisplayValue("acme")).toBeNull();
});

test("toggles dense table density and persists the preference", async () => {
  window.localStorage.removeItem("terrence-table-prefs:workspaces");
  const workspace = {
    id: "workspace-1",
    attributes: { name: "production", locked: false, "tag-names": [] },
    relationships: { project: { data: { id: "project-default", type: "projects" } } },
  };
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url.startsWith("/api/v2/organizations/acme/workspaces?page%5Bsize%5D=100")) return json({ data: [workspace] });
    if (url === "/api/v2/organizations/acme/projects?page%5Bsize%5D=100") return json({ data: [] });
    if (url === "/api/v2/organizations/acme/runs?page%5Bsize%5D=100") return json({ data: [] });
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { name: "acme", permissions: { "can-manage-workspaces": false } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Routes><Route path="/app/:orgName" element={<Workspaces />} /></Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("production")).toBeTruthy(); });
  // Default is comfortable.
  expect(view.getByRole("table").getAttribute("data-density")).toBe("comfortable");

  fireEvent.click(view.getByRole("button", { name: "Switch to dense table density" }));
  expect(view.getByRole("table").getAttribute("data-density")).toBe("dense");
// SAFETY: the captured call argument is a stringified JSON body.
  const stored = JSON.parse(window.localStorage.getItem("terrence-table-prefs:workspaces") as string);
  expect(stored.density).toBe("dense");

  fireEvent.click(view.getByRole("button", { name: "Switch to comfortable table density" }));
  expect(view.getByRole("table").getAttribute("data-density")).toBe("comfortable");
// SAFETY: the captured call argument is a stringified JSON body.
  expect(JSON.parse(window.localStorage.getItem("terrence-table-prefs:workspaces") as string).density)
    .toBe("comfortable");

  window.localStorage.removeItem("terrence-table-prefs:workspaces");
});

test("pins a workspace (star) and sorts it to the top", async () => {
  window.localStorage.removeItem("terrence-pinned-workspaces");
  const workspaces = [
    { id: "ws-1", attributes: { name: "alpha", locked: false, "tag-names": [] } },
    { id: "ws-2", attributes: { name: "beta", locked: false, "tag-names": [] } },
  ];
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url.startsWith("/api/v2/organizations/acme/workspaces?page%5Bsize%5D=100")) return json({ data: workspaces });
    if (url === "/api/v2/organizations/acme/projects?page%5Bsize%5D=100") return json({ data: [] });
    if (url === "/api/v2/organizations/acme/runs?page%5Bsize%5D=100") return json({ data: [] });
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { name: "acme", permissions: { "can-manage-workspaces": false } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Routes><Route path="/app/:orgName" element={<Workspaces />} /></Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("alpha")).toBeTruthy(); });

  // Initial order matches the API (alpha, beta).
  const rows = (): string[] =>
    Array.from(view.getAllByRole("row"))
      .map((row): string => row.textContent ?? "")
      .filter((text): boolean => text.includes("alpha") || text.includes("beta"));
  expect(rows()[0]).toContain("alpha");

  fireEvent.click(view.getByRole("button", { name: "Pin beta" }));
  // After pinning, beta floats to the top.
  await waitFor((): void => { expect(rows()[0]).toContain("beta"); });
  expect(view.getByRole("button", { name: "Unpin beta" })).toBeTruthy();
// SAFETY: the captured call argument is a stringified JSON body.
  const stored = JSON.parse(window.localStorage.getItem("terrence-pinned-workspaces") as string);
  expect(stored).toEqual([{ orgName: "acme", workspaceName: "beta", visitedAt: 0 }]);

  fireEvent.click(view.getByRole("button", { name: "Unpin beta" }));
  await waitFor((): void => { expect(rows()[0]).toContain("alpha"); });

  window.localStorage.removeItem("terrence-pinned-workspaces");
});

test("shows recent workspace shortcuts in the org sidebar", async () => {
  window.localStorage.removeItem("terrence-recent-workspaces");
  // Simulate a prior visit to the "cache" workspace.
  window.localStorage.setItem("terrence-recent-workspaces", JSON.stringify([
    { orgName: "acme", workspaceName: "cache", visitedAt: Date.now() },
  ]));

  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url === "/api/v2/account/details") {
      return json({ data: { attributes: { username: "tester", "is-site-admin": false } } });
    }
    if (url === "/api/v2/organizations?page[size]=100") return json({ data: [{ id: "org-acme", attributes: { name: "acme" } }] });
    if (url.startsWith("/api/v2/organizations/acme/workspaces?page%5Bsize%5D=100")) return json({ data: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const { Layout } = await import("../src/components/Layout");
  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Routes><Route path="/app/:orgName" element={<Layout><p>Workspaces page</p></Layout>} /></Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => {
    expect(view.getByRole("link", { name: "cache" })).toBeTruthy();
  });
  expect(view.getByRole("link", { name: "cache" }).getAttribute("href"))
    .toBe("/app/acme/workspaces/cache");

  window.localStorage.removeItem("terrence-recent-workspaces");
});

test("saves, applies, and deletes a named workspace view", async () => {
  window.localStorage.removeItem("terrence-saved-views:acme");
  const workspaces = [
    { id: "ws-1", attributes: { name: "alpha", locked: false, "tag-names": [] } },
    { id: "ws-2", attributes: { name: "beta", locked: false, "tag-names": [] } },
  ];
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url.startsWith("/api/v2/organizations/acme/workspaces?page%5Bsize%5D=100")) return json({ data: workspaces });
    if (url === "/api/v2/organizations/acme/projects?page%5Bsize%5D=100") return json({ data: [] });
    if (url === "/api/v2/organizations/acme/runs?page%5Bsize%5D=100") return json({ data: [] });
    if (url === "/api/v2/organizations/acme") {
      return json({ data: { attributes: { name: "acme", permissions: { "can-manage-workspaces": false } } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Routes><Route path="/app/:orgName" element={<Workspaces />} /></Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("alpha")).toBeTruthy(); });

  // Filter to a state worth saving, then open the save dialog.
  fireEvent.change(view.getByLabelText("Status filter"), { target: { value: "errored" } });
  fireEvent.click(view.getByRole("button", { name: "Save current filters as a view" }));
  const dialog = view.getByRole("dialog");
  await act(async (): Promise<void> => {
    fireEvent.input(view.getByLabelText("View name"), { target: { value: "Errored only" } });
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save view" }));

  await waitFor((): void => {
    expect(view.getByRole("button", { name: "Errored only" })).toBeTruthy();
  });
  expect(window.localStorage.getItem("terrence-saved-views:acme")).not.toBeNull();
// SAFETY: the captured call argument is a stringified JSON body.
  const stored = JSON.parse(window.localStorage.getItem("terrence-saved-views:acme") as string);
  expect(stored).toEqual([{ name: "Errored only", search: "", statusFilter: "errored", projectFilter: "" }]);

  // Apply the view from the chip (resets filters to the saved state).
  await act(async (): Promise<void> => {
    fireEvent.input(view.getByLabelText("Search workspaces"), { target: { value: "zzz" } });
  });
  await act(async (): Promise<void> => { fireEvent.click(view.getByRole("button", { name: "Errored only" })); });
  await waitFor((): void => {
// SAFETY: the component renders this element type for the queried role/label.
    expect((view.getByLabelText("Search workspaces") as HTMLInputElement).value).toBe("");
// SAFETY: the component renders this element type for the queried role/label.
    expect((view.getByLabelText("Status filter") as HTMLSelectElement).value).toBe("errored");
  });
  expect(view.getByRole("button", { name: "Errored only" }).getAttribute("aria-pressed")).toBe("true");

  // Deleting the view removes the chip and clears the active state.
  fireEvent.click(view.getByRole("button", { name: "Delete saved view Errored only" }));
  await waitFor((): void => {
    expect(view.queryByRole("button", { name: "Errored only" })).toBeNull();
  });
  expect(window.localStorage.getItem("terrence-saved-views:acme")).toBe("[]");

  window.localStorage.removeItem("terrence-saved-views:acme");
});

test("column chooser hides and restores table columns with persistence", async () => {
  window.localStorage.removeItem("terrence-table-prefs:workspaces");
  const workspace = {
    id: "workspace-1",
    attributes: { name: "production", locked: false, "tag-names": [], "vcs-repo": { identifier: "acme/terraform-aws" } },
    relationships: { project: { data: { id: "project-default", type: "projects" } } },
  };
  const fetchMock = mock(async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    if (url.includes("/workspaces?page%5Bsize%5D=100")) return json({ data: [workspace] });
    if (url.includes("/projects?")) return json({ data: [] });
    if (url.includes("/runs?")) return json({ data: [] });
    if (url.endsWith("/api/v2/organizations/acme")) {
      return json({ data: { attributes: { name: "acme", permissions: {} } } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme"]}>
      <Routes><Route path="/app/:orgName" element={<Workspaces />} /></Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("production")).toBeTruthy(); });
  // All columns visible by default.
  expect(view.getByRole("columnheader", { name: "Repository" })).toBeTruthy();
  expect(view.getByRole("columnheader", { name: "Status" })).toBeTruthy();
  expect(view.getByText("acme/terraform-aws")).toBeTruthy();

  await act(async (): Promise<void> => {
    fireEvent.mouseDown(view.getByRole("button", { name: "Choose visible columns" }));
    fireEvent.click(view.getByRole("button", { name: "Choose visible columns" }));
  });
  // Toggle Repository + Status off. jsdom does not compute the accessible
  // name for base-ui checkbox items, so match by text content.
  const menuItem = (columnName: string): HTMLElement | undefined =>
    view.getAllByRole("menuitemcheckbox").find((item): boolean => item.textContent === columnName);
  await waitFor((): void => { expect(menuItem("Repository")).toBeTruthy(); });
  await act(async (): Promise<void> => {
    fireEvent.click(menuItem("Repository"));
    fireEvent.click(menuItem("Status"));
  });

  await waitFor((): void => {
    expect(view.queryByRole("columnheader", { name: "Repository" })).toBeNull();
    expect(view.queryByRole("columnheader", { name: "Status" })).toBeNull();
    expect(view.queryByText("acme/terraform-aws")).toBeNull();
  });
// SAFETY: the captured call argument is a stringified JSON body.
  const stored = JSON.parse(window.localStorage.getItem("terrence-table-prefs:workspaces") as string);
  expect(stored.visibleColumns).not.toContain("repository");
  expect(stored.visibleColumns).not.toContain("status");
  expect(stored.visibleColumns).toContain("project");

  // Workspace + Manage stay visible; re-enable restores.
  expect(view.getByRole("columnheader", { name: "Workspace" })).toBeTruthy();
  const columnsButton = (): HTMLElement => view.getByRole("button", { name: "Choose visible columns" });
  if (columnsButton().getAttribute("aria-expanded") !== "true") {
    await act(async (): Promise<void> => {
      fireEvent.mouseDown(columnsButton());
      fireEvent.click(columnsButton());
    });
    await waitFor((): void => { expect(columnsButton().getAttribute("aria-expanded")).toBe("true"); });
  }
  await act(async (): Promise<void> => {
    fireEvent.click(menuItem("Repository")!);
  });
  await waitFor((): void => {
    expect(view.getByRole("columnheader", { name: "Repository" })).toBeTruthy();
  });

  window.localStorage.removeItem("terrence-table-prefs:workspaces");
});