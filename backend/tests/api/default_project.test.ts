import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, organizationMemberships, organizations, projects, users, workspaces,
} from "../../src/db/schema";

/**
 * RBAC-008: Default project create/move/delete behavior.
 *
 * the reference format auto-provisions a "Default Project" for every organization and assigns
 * workspaces without an explicit project to it. Terrence mirrors this via
 * `ensureDefaultProject` (src/routes/projects.ts:203) called on org creation
 * (projects.ts:231,258) and on workspace creation when no project is supplied
 * (workspaces.ts:670). These tests pin that contract against a real CREATE
 * request so a refactor cannot silently drop the fallback.
 */
describe("Default Project assignment (RBAC-008)", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `default-project-${suffix}`;
  const token = `token-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));

  let explicitProjectId: string;

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `mem-${suffix}`, userId, orgId, role: "owner", status: "active",
    });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token, userId });
    explicitProjectId = `prj-${crypto.randomUUID()}`;
    await db.insert(projects).values({
      id: explicitProjectId, orgId, name: "explicit-project", isDefault: false,
      defaultExecutionMode: "remote",
    });
  });

  afterAll(async () => {
    await db.delete(projects).where(eq(projects.orgId, orgId));
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-${suffix}`));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("auto-creates a Default Project when the org is first queried", async () => {
    const listed = await request(`/api/v2/organizations/${orgName}/projects`);
    expect(listed.status).toBe(200);
    const projects = (await listed.json()).data as ReadonlyArray<{ attributes: { name: string } }>;
    expect(projects.find((p) => p.attributes.name === "Default Project")).toBeDefined();
  });

  it("assigns a workspace without a project relationship to the Default Project", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
      data: { type: "workspaces", attributes: { name: "no-project-ws" } },
    });
    expect(res.status).toBe(201);
    const body: { data: { relationships?: { project?: { data: { id: string; type: string } | null } } } } = await res.json();
    const rel = body.data.relationships?.project?.data;
    expect(rel).toBeDefined();
    expect(rel?.type).toBe("projects");
    expect(rel?.id.length).toBeGreaterThan(0);

    // The assigned project must BE the Default Project.
    const projRes = await request(`/api/v2/projects/${rel!.id}`);
    expect(projRes.status).toBe(200);
    expect((await projRes.json()).data.attributes.name).toBe("Default Project");
  });

  it("honors an explicitly-specified project and does not fall back to Default", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
      data: {
        type: "workspaces",
        attributes: { name: "explicit-project-ws" },
        relationships: { project: { data: { id: explicitProjectId, type: "projects" } } },
      },
    });
    expect(res.status).toBe(201);
    const body: { data: { relationships?: { project?: { data: { id: string } | null } } } } = await res.json();
    expect(body.data.relationships?.project?.data?.id).toBe(explicitProjectId);
  });
});
