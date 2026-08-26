import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  projects,
  users,
  workspaces,
} from "../../src/db/schema";

describe("agent pool workspace and project scoping", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `agent-scope-${suffix}`;
  const foreignOrgId = `org-foreign-${suffix}`;
  const token = `token-${suffix}`;
  const allowedProjectId = `prj-allowed-${suffix}`;
  const otherProjectId = `prj-other-${suffix}`;
  const foreignProjectId = `prj-foreign-${suffix}`;
  const explicitWorkspaceId = `ws-explicit-${suffix}`;
  const projectWorkspaceId = `ws-project-${suffix}`;
  const deniedWorkspaceId = `ws-denied-${suffix}`;
  const foreignWorkspaceId = `ws-foreign-${suffix}`;

  const request = (method: string, path: string, body?: unknown): Promise<Response> => app.handle(new Request(`http://terrence.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values([
      { id: orgId, name: orgName },
      { id: foreignOrgId, name: `agent-scope-foreign-${suffix}` },
    ]);
    await db.insert(organizationMemberships).values({
      id: `membership-${suffix}`,
      userId,
      orgId,
      role: "owner",
    });
    await db.insert(apiTokens).values({ id: `api-token-${suffix}`, token: hashAuthenticationToken(token), userId });
    await db.insert(projects).values([
      { id: allowedProjectId, orgId, name: "Allowed project" },
      { id: otherProjectId, orgId, name: "Other project" },
      { id: foreignProjectId, orgId: foreignOrgId, name: "Foreign project" },
    ]);
    await db.insert(workspaces).values([
      { id: explicitWorkspaceId, orgId, projectId: otherProjectId, name: "explicit-workspace" },
      { id: projectWorkspaceId, orgId, projectId: allowedProjectId, name: "project-workspace" },
      { id: deniedWorkspaceId, orgId, projectId: otherProjectId, name: "denied-workspace" },
      { id: foreignWorkspaceId, orgId: foreignOrgId, projectId: foreignProjectId, name: "foreign-workspace" },
    ]);
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, foreignOrgId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(users).where(eq(users.id, userId));
  });

  test("persists scope relationships and enforces their union for assignments", async () => {
    const created = await request("POST", `/api/v2/organizations/${orgName}/agent-pools`, {
      data: {
        type: "agent-pools",
        attributes: {
          name: "scoped-pool",
          "organization-scoped": false,
        },
        relationships: {
          "allowed-workspaces": {
            data: [{ id: explicitWorkspaceId, type: "workspaces" }],
          },
          "allowed-projects": {
            data: [{ id: allowedProjectId, type: "projects" }],
          },
        },
      },
    });
    expect(created.status).toBe(201);
    const pool = (await created.json()).data;
    const poolId = pool.id as string;
    expect(pool.relationships["allowed-workspaces"].data).toEqual([
      { id: explicitWorkspaceId, type: "workspaces" },
    ]);
    expect(pool.relationships["allowed-projects"].data).toEqual([
      { id: allowedProjectId, type: "projects" },
    ]);

    const malformed = await request("PATCH", `/api/v2/agent-pools/${poolId}`, {
      data: {
        type: "agent-pools",
        relationships: {
          "allowed-workspaces": {
            data: { id: explicitWorkspaceId, type: "workspaces" },
          },
        },
      },
    });
    expect(malformed.status).toBe(422);

    const crossOrganization = await request("PATCH", `/api/v2/agent-pools/${poolId}`, {
      data: {
        type: "agent-pools",
        relationships: {
          "allowed-workspaces": {
            data: [{ id: foreignWorkspaceId, type: "workspaces" }],
          },
        },
      },
    });
    expect(crossOrganization.status).toBe(422);

    const projectDefault = await request("PATCH", `/api/v2/projects/${allowedProjectId}`, {
      data: {
        type: "projects",
        attributes: { "default-execution-mode": "agent" },
        relationships: {
          "default-agent-pool": {
            data: { id: poolId, type: "agent-pools" },
          },
        },
      },
    });
    expect(projectDefault.status).toBe(200);
    const inheritedWorkspace = await request("GET", `/api/v2/workspaces/${projectWorkspaceId}`);
    expect(inheritedWorkspace.status).toBe(200);
    expect((await inheritedWorkspace.json()).data.attributes["agent-pool-id"]).toBe(poolId);

    const explicitAssignment = await request("PATCH", `/api/v2/workspaces/${explicitWorkspaceId}`, {
      data: {
        type: "workspaces",
        attributes: {
          "execution-mode": "agent",
          "agent-pool-id": poolId,
        },
      },
    });
    expect(explicitAssignment.status).toBe(200);

    const deniedAssignment = await request("PATCH", `/api/v2/workspaces/${deniedWorkspaceId}`, {
      data: {
        type: "workspaces",
        attributes: {
          "execution-mode": "agent",
          "agent-pool-id": poolId,
        },
      },
    });
    expect(deniedAssignment.status).toBe(422);

    const deniedProjectDefault = await request("PATCH", `/api/v2/projects/${otherProjectId}`, {
      data: {
        type: "projects",
        attributes: { "default-execution-mode": "agent" },
        relationships: {
          "default-agent-pool": {
            data: { id: poolId, type: "agent-pools" },
          },
        },
      },
    });
    expect(deniedProjectDefault.status).toBe(422);

    const unsafeScopeRemoval = await request("PATCH", `/api/v2/agent-pools/${poolId}`, {
      data: {
        type: "agent-pools",
        relationships: {
          "allowed-workspaces": { data: [] },
          "allowed-projects": { data: [] },
        },
      },
    });
    expect(unsafeScopeRemoval.status).toBe(422);

    const organizationScoped = await request("PATCH", `/api/v2/agent-pools/${poolId}`, {
      data: {
        type: "agent-pools",
        attributes: { "organization-scoped": true },
        relationships: {
          "allowed-workspaces": { data: [] },
          "allowed-projects": { data: [] },
        },
      },
    });
    expect(organizationScoped.status).toBe(200);
    const organizationPool = (await organizationScoped.json()).data;
    expect(organizationPool.relationships["allowed-workspaces"].data).toEqual([]);
    expect(organizationPool.relationships["allowed-projects"].data).toEqual([]);

    const newlyAllowedAssignment = await request("PATCH", `/api/v2/workspaces/${deniedWorkspaceId}`, {
      data: {
        type: "workspaces",
        attributes: {
          "execution-mode": "agent",
          "agent-pool-id": poolId,
        },
      },
    });
    expect(newlyAllowedAssignment.status).toBe(200);

    const invalidRescope = await request("PATCH", `/api/v2/agent-pools/${poolId}`, {
      data: {
        type: "agent-pools",
        attributes: { "organization-scoped": false },
      },
    });
    expect(invalidRescope.status).toBe(422);
  });
});