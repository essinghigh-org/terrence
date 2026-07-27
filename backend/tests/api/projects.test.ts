import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  users,
} from "../../src/db/schema";

describe("projects API contract", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `projects-org-${suffix}`;
  const token = `user-token-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, auth = token) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "unused" }]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
    ]);
    await db.insert(apiTokens).values([{ id: crypto.randomUUID(), token, userId }]);
  });

  afterAll(async () => {
    await db.delete(apiTokens).where(eq(apiTokens.token, token));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
  });

  it("lists, creates, patches, and deletes projects", async () => {
    // 1. Initial list auto-creates Default Project
    const listRes1 = await request(`/api/v2/organizations/${orgName}/projects`);
    expect(listRes1.status).toBe(200);
    const listBody1 = await listRes1.json();
    expect(listBody1.data.length).toBe(1);
    expect(listBody1.data[0].attributes.name).toBe("Default Project");

    // 2. Create custom project
    const createRes = await request(`/api/v2/organizations/${orgName}/projects`, "POST", {
      data: {
        attributes: {
          name: "Infrastructure",
          description: "Core infra resources",
          "default-execution-mode": "remote",
        },
      },
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    const projectId = createBody.data.id;
    expect(createBody.data.attributes.name).toBe("Infrastructure");

    // 3. Show project
    const showRes = await request(`/api/v2/projects/${projectId}`);
    expect(showRes.status).toBe(200);
    const showBody = await showRes.json();
    expect(showBody.data.attributes.description).toBe("Core infra resources");

    // 4. Update project
    const patchRes = await request(`/api/v2/projects/${projectId}`, "PATCH", {
      data: { attributes: { description: "Updated infra description" } },
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.data.attributes.description).toBe("Updated infra description");

    // 5. Delete project
    const deleteRes = await request(`/api/v2/projects/${projectId}`, "DELETE");
    expect(deleteRes.status).toBe(204);
  });
});
