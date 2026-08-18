import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens, organizationMemberships, organizations, projects, users, workspaces,
} from "../../src/db/schema";

/**
 * ORG-011: Site -> org -> project -> workspace setting precedence.
 *
 * the reference format resolves inheritable settings by walking org defaults down to project
 * defaults down to an explicit workspace override. Terrence implements the
 * execution-mode portion of this chain in the workspace create handler
 * (src/routes/workspaces.ts:693-695): an explicit workspace execution-mode
 * wins; otherwise the project's default-execution-mode is used; otherwise the
 * org-level/implicit default of "remote" applies. These tests pin that
 * precedence so a refactor that drops the project layer is caught.
 */
describe("Execution-mode setting precedence (ORG-011)", () => {
  const suffix = crypto.randomUUID();
  const userId = `usr-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `prec-${suffix}`;
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

  let projectId = `prj-${suffix}`;

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, username: userId, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: `mem-${suffix}`, userId, orgId, role: "owner", status: "active",
    });
    await db.insert(apiTokens).values({ id: `tok-${suffix}`, token, userId });
    // Project with a non-default execution mode so inheritance is observable.
    // Use "local" (no agent pool required) so the project can be created without
    // standing up an agent pool; the workspace must still inherit it.
    const projRes = await request(`/api/v2/organizations/${orgName}/projects`, "POST", {
      data: { type: "projects", attributes: { name: "local-project", "default-execution-mode": "local" } },
    });
    expect(projRes.status).toBe(201);
    projectId = (await projRes.json()).data.id;
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId));
    await db.delete(projects).where(eq(projects.orgId, orgId));
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.id, `mem-${suffix}`));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("workspace without an override inherits the project default-execution-mode", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
      data: {
        type: "workspaces",
        attributes: { name: "inherited-ws" },
        relationships: { project: { data: { id: projectId, type: "projects" } } },
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // Project default is "local"; workspace must reflect it (not the org default "remote").
    expect(body.data.attributes["execution-mode"]).toBe("local");
    expect(body.data.attributes["setting-overwrites"]["execution-mode"]).toBe(false);
  });

  it("explicit workspace execution-mode override wins over the project default", async () => {
    const res = await request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
      data: {
        type: "workspaces",
        attributes: { name: "overridden-ws", "execution-mode": "remote" },
        relationships: { project: { data: { id: projectId, type: "projects" } } },
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.attributes["execution-mode"]).toBe("remote");
    expect(body.data.attributes["setting-overwrites"]["execution-mode"]).toBe(true);
  });

  it("workspace in a project with no default falls back to remote", async () => {
    const plainProjRes = await request(`/api/v2/organizations/${orgName}/projects`, "POST", {
      data: { type: "projects", attributes: { name: "plain-project" } },
    });
    expect(plainProjRes.status).toBe(201);
    const plainProjId = (await plainProjRes.json()).data.id;

    const res = await request(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
      data: {
        type: "workspaces",
        attributes: { name: "remote-fallback-ws" },
        relationships: { project: { data: { id: plainProjId, type: "projects" } } },
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.attributes["execution-mode"]).toBe("remote");
  });
});
