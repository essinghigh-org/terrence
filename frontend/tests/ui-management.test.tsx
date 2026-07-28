import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { OrganizationSettings } from "../src/views/OrganizationSettings";
import { Projects } from "../src/views/Projects";
import { Workspaces } from "../src/views/Workspaces";

const originalFetch = globalThis.fetch;
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

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
    if (url === "/api/v2/organizations/acme/workspaces?page%5Bsize%5D=100") return json({ data: [workspace] });
    if (url === "/api/v2/projects/project-app" && init?.method === "PATCH") return json({ data: projects[1] });
    if (url === "/api/v2/projects/project-app" && init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url === "/api/v2/workspaces/workspace-1" && init?.method === "PATCH") return json({ data: workspace });
    throw new Error(`Unexpected request: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;

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
    expect(JSON.parse(assignment?.[1]?.body as string).data.relationships.project.data.id).toBe("project-app");
  });

  fireEvent.click(view.getByRole("button", { name: "Close" }));
  fireEvent.click(view.getByRole("button", { name: "Delete Applications" }));
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/projects/project-app" && init?.method === "DELETE")).toBeTrue();
  });
});

test("filters workspaces by run status and adds, updates, and removes tags", async () => {
  const tags: { id: string; attributes: { key: string; value: string } }[] = [];
  const workspace = (): Record<string, unknown> => ({
    id: "workspace-1",
    attributes: {
      name: "production",
      locked: false,
      "tag-names": tags.map((tag): string => tag.attributes.key),
      "vcs-repo": null,
    },
    relationships: { project: { data: { id: "project-default", type: "projects" } } },
  });
  const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url.startsWith("/api/v2/organizations/acme/workspaces?")) return json({ data: [workspace()] });
    if (url === "/api/v2/organizations/acme/projects") {
      return json({ data: [{ id: "project-default", attributes: { name: "Default Project" } }] });
    }
    if (url === "/api/v2/workspaces/workspace-1/tag-bindings" && init?.method === undefined) return json({ data: tags });
    if (url === "/api/v2/workspaces/workspace-1/tag-bindings" && init?.method === "PATCH") {
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
  globalThis.fetch = fetchMock as typeof fetch;

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
      return json({ data: { id: "org-1", attributes: { name: "acme" } } });
    }
    if (url === "/api/v2/organizations/acme/teams" && init?.method === undefined) return json({ data: [team] });
    if (url === "/api/v2/teams/team-1" && init?.method === "PATCH") {
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
  globalThis.fetch = fetchMock as typeof fetch;

  const view = render(
    <MemoryRouter initialEntries={["/app/acme/settings"]}>
      <Routes><Route path="/app/:orgName/settings" element={<OrganizationSettings />} /></Routes>
    </MemoryRouter>,
  );

  await waitFor((): void => { expect(view.getByText("Organization Settings")).toBeTruthy(); });
  fireEvent.click(view.getByRole("button", { name: "Teams" }));
  fireEvent.click(view.getByRole("button", { name: "Manage permissions for Developers" }));
  fireEvent.click(view.getByLabelText("Manage Projects"));
  fireEvent.click(view.getByLabelText("Manage Modules"));
  expect(view.getByLabelText("Manage Workspaces").getAttribute("data-state")).toBe("checked");
  await act(async (): Promise<void> => {
    fireEvent.click(view.getByRole("button", { name: "Save permissions" }));
  });
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/teams/team-1" && init?.method === "PATCH")).toBeTrue();
  });
  const permissionCall = fetchMock.mock.calls.find(([input, init]): boolean =>
    urlOf(input) === "/api/v2/teams/team-1" && init?.method === "PATCH");
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
  expect(JSON.parse(inviteCall?.[1]?.body as string).data.relationships.teams.data).toEqual([
    { id: "team-1", type: "teams" },
  ]);

  fireEvent.click(view.getByRole("button", { name: "Remove new@example.com" }));
  await waitFor((): void => {
    expect(fetchMock.mock.calls.some(([input, init]): boolean =>
      urlOf(input) === "/api/v2/organization-memberships/membership-invite" && init?.method === "DELETE")).toBeTrue();
  });
});
