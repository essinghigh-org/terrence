import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, organizationMemberships, organizations, projects, users, workspaces,
} from "../../src/db/schema";

/**
 * RBAC-008: Default project create/move/delete behavior.
 *
 * The reference format auto-provisions a "Default Project" for every organization and assigns
 * workspaces without an explicit project to it. Terrence creates the project transactionally
 * with the organization and retains `ensureDefaultProject` for legacy organizations and
 * workspace creation. These tests pin that contract against real API requests so a refactor
 * cannot silently drop the fallback.
 */
describe("Default Project assignment (RBAC-008)", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-${suffix}`;
  let orgId: string;
  const orgName = `default-project-${suffix}`;
  const readOnlyOrgId = `org-read-only-${suffix}`;
  const readOnlyOrgName = `default-project-read-only-${suffix}`;
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
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token: hashAuthenticationToken(token), userId });
    const created = await request("/api/v2/organizations", "POST", {
      data: { type: "organizations", attributes: { name: orgName } },
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { data: { attributes: { "external-id": string } } };
    orgId = createdBody.data.attributes["external-id"];
    await db.insert(organizations).values({ id: readOnlyOrgId, name: readOnlyOrgName });
    await db.insert(organizationMemberships).values({
      id: `mem-read-only-${suffix}`, userId, orgId: readOnlyOrgId, role: "owner", status: "active",
    });
    explicitProjectId = `prj-${crypto.randomUUID()}`;
    await db.insert(projects).values({
      id: explicitProjectId, orgId, name: "explicit-project", isDefault: false,
      defaultExecutionMode: "remote",
    });
  });

  afterAll(async () => {
    await db.delete(projects).where(eq(projects.orgId, orgId));
    await db.delete(projects).where(eq(projects.orgId, readOnlyOrgId));
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId));
    await db.delete(workspaces).where(eq(workspaces.orgId, readOnlyOrgId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-read-only-${suffix}`));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, readOnlyOrgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("lists the pre-provisioned Default Project without writing during GET", async () => {
    const before = await db.query.projects.findMany({ where: eq(projects.orgId, orgId) });
    expect(before.some((project) => project.isDefault)).toBe(true);
    const listed = await request(`/api/v2/organizations/${orgName}/projects`);
    expect(listed.status).toBe(200);
    const listedProjects = (await listed.json()).data as readonly { attributes: { name: string } }[];
    expect(listedProjects.find((project) => project.attributes.name === "Default Project")).toBeDefined();
    const after = await db.query.projects.findMany({ where: eq(projects.orgId, orgId) });
    expect(after.map((project) => project.id).sort()).toEqual(before.map((project) => project.id).sort());
  });

  it("does not create a Default Project for an existing organization while listing", async () => {
    const before = await db.query.projects.findMany({ where: eq(projects.orgId, readOnlyOrgId) });
    expect(before).toHaveLength(0);
    const listed = await request(`/api/v2/organizations/${readOnlyOrgName}/projects`);
    expect(listed.status).toBe(200);
    expect((await listed.json()).data).toHaveLength(0);
    const after = await db.query.projects.findMany({ where: eq(projects.orgId, readOnlyOrgId) });
    expect(after).toHaveLength(0);
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