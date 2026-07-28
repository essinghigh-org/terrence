import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  agentPools,
  apiTokens,
  organizationMemberships,
  organizations,
  users,
} from "../../src/db/schema";

describe("project defaults and workspace inheritance", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `project-semantics-${suffix}`;
  const token = `token-${suffix}`;
  const poolId = `apool-${suffix}`;

  const request = (method: string, path: string, body?: unknown) => app.handle(new Request(`http://terrence.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `membership-${suffix}`,
      userId,
      orgId,
      role: "owner",
    });
    await db.insert(apiTokens).values({ id: `token-${suffix}`, token, userId });
    await db.insert(agentPools).values({
      id: poolId,
      orgId,
      name: "Project agents",
      organizationScoped: true,
      createdAt: Date.now(),
    });
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("validates project modes and preserves explicit workspace overrides", async () => {
    const listed = await request("GET", `/api/v2/organizations/${orgName}/projects`);
    expect(listed.status).toBe(200);
    const defaultProject = (await listed.json()).data.find(
      (project: Readonly<{ attributes: Readonly<{ name: string }> }>): boolean => project.attributes.name === "Default Project",
    );
    expect(defaultProject).toBeDefined();

    expect((await request("POST", `/api/v2/organizations/${orgName}/projects`, {
      data: { type: "projects", attributes: { name: "Invalid Mode", "default-execution-mode": "elsewhere" } },
    })).status).toBe(422);
    expect((await request("POST", `/api/v2/organizations/${orgName}/projects`, {
      data: { type: "projects", attributes: { name: "Missing Pool", "default-execution-mode": "agent" } },
    })).status).toBe(422);

    const createdProject = await request("POST", `/api/v2/organizations/${orgName}/projects`, {
      data: {
        type: "projects",
        attributes: {
          name: "Application",
          "default-execution-mode": "local",
          "auto-destroy-activity-duration": "14d",
        },
      },
    });
    expect(createdProject.status).toBe(201);
    const project = (await createdProject.json()).data;
    expect(project.attributes["setting-overwrites"]["execution-mode"]).toBe(true);

    const inheritedWorkspaceResponse = await request("POST", `/api/v2/organizations/${orgName}/workspaces`, {
      data: {
        type: "workspaces",
        attributes: { name: "inherited" },
        relationships: { project: { data: { id: project.id, type: "projects" } } },
      },
    });
    expect(inheritedWorkspaceResponse.status).toBe(201);
    const inheritedWorkspace = (await inheritedWorkspaceResponse.json()).data;
    expect(inheritedWorkspace.attributes["execution-mode"]).toBe("local");
    expect(inheritedWorkspace.attributes["auto-destroy-activity-duration"]).toBe("14d");
    expect(inheritedWorkspace.attributes["inherits-project-auto-destroy"]).toBe(true);
    expect(inheritedWorkspace.attributes["setting-overwrites"]["execution-mode"]).toBe(false);

    const defaultedWorkspaceResponse = await request("POST", `/api/v2/organizations/${orgName}/workspaces`, {
      data: { type: "workspaces", attributes: { name: "defaulted" } },
    });
    expect(defaultedWorkspaceResponse.status).toBe(201);
    const defaultedWorkspace = (await defaultedWorkspaceResponse.json()).data;
    expect(defaultedWorkspace.relationships.project.data.id).toBe(defaultProject.id);
    expect((await request("PATCH", `/api/v2/projects/${defaultProject.id}`, {
      data: { type: "projects", attributes: { name: "Renamed Default" } },
    })).status).toBe(200);
    expect((await request("DELETE", `/api/v2/projects/${defaultProject.id}`)).status).toBe(409);
    expect((await request("DELETE", `/api/v2/projects/${project.id}`)).status).toBe(409);

    const projectAgentUpdate = await request("PATCH", `/api/v2/projects/${project.id}`, {
      data: {
        type: "projects",
        attributes: {
          "default-execution-mode": "agent",
          "auto-destroy-activity-duration": "30d",
        },
        relationships: {
          "default-agent-pool": { data: { id: poolId, type: "agent-pools" } },
        },
      },
    });
    expect(projectAgentUpdate.status).toBe(200);
    const inheritedAfterProjectUpdate = (await (await request("GET", `/api/v2/workspaces/${inheritedWorkspace.id}`)).json()).data;
    expect(inheritedAfterProjectUpdate.attributes["execution-mode"]).toBe("agent");
    expect(inheritedAfterProjectUpdate.attributes["agent-pool-id"]).toBe(poolId);
    expect(inheritedAfterProjectUpdate.attributes["auto-destroy-activity-duration"]).toBe("30d");

    const moved = await request("PATCH", `/api/v2/workspaces/${defaultedWorkspace.id}`, {
      data: {
        type: "workspaces",
        relationships: { project: { data: { id: project.id, type: "projects" } } },
      },
    });
    expect(moved.status).toBe(200);
    const movedWorkspace = (await moved.json()).data;
    expect(movedWorkspace.attributes["execution-mode"]).toBe("agent");
    expect(movedWorkspace.attributes["agent-pool-id"]).toBe(poolId);
    expect(movedWorkspace.attributes["auto-destroy-activity-duration"]).toBe("30d");

    const overridden = await request("PATCH", `/api/v2/workspaces/${inheritedWorkspace.id}`, {
      data: {
        type: "workspaces",
        attributes: {
          "execution-mode": "remote",
          "setting-overwrites": { "execution-mode": true },
          "auto-destroy-activity-duration": null,
        },
      },
    });
    expect(overridden.status).toBe(200);
    expect((await overridden.json()).data.attributes["inherits-project-auto-destroy"]).toBe(false);

    expect((await request("PATCH", `/api/v2/projects/${project.id}`, {
      data: {
        type: "projects",
        attributes: {
          "default-execution-mode": "local",
          "auto-destroy-activity-duration": "7d",
        },
        relationships: { "default-agent-pool": { data: null } },
      },
    })).status).toBe(200);
    const retainedOverride = (await (await request("GET", `/api/v2/workspaces/${inheritedWorkspace.id}`)).json()).data;
    expect(retainedOverride.attributes["execution-mode"]).toBe("remote");
    expect(retainedOverride.attributes["auto-destroy-activity-duration"]).toBeNull();
    const inheritedAfterMove = (await (await request("GET", `/api/v2/workspaces/${defaultedWorkspace.id}`)).json()).data;
    expect(inheritedAfterMove.attributes["execution-mode"]).toBe("local");
    expect(inheritedAfterMove.attributes["auto-destroy-activity-duration"]).toBe("7d");

    expect((await request("DELETE", `/api/v2/workspaces/${inheritedWorkspace.id}`)).status).toBe(204);
    expect((await request("DELETE", `/api/v2/workspaces/${defaultedWorkspace.id}`)).status).toBe(204);
    expect((await request("DELETE", `/api/v2/projects/${project.id}`)).status).toBe(204);
  });
});
