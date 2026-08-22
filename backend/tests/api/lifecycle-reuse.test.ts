import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizations, organizationMemberships, users, workspaces } from "../../src/db/schema";

const suffix = crypto.randomUUID();

describe("lifecycle — reused names/slugs after deletion", () => {
  let orgId = "", orgName = "";
  let userId = "", token = "";

  const req = (path: string, method = "GET", body?: unknown) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/vnd.api+json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }));

  beforeAll(async () => {
    userId = `reuse-user-${suffix}`;
    orgName = `reuse-org-${suffix}`;
    orgId = `org-reuse-${suffix}`;
    token = `tok-reuse-${suffix}`;
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "h" }]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([{ id: `om-reuse-${suffix}`, userId, orgId, role: "owner" }]);
    await db.insert(apiTokens).values([{ id: `api-reuse-${suffix}`, token: createHash("sha256").update(token).digest("hex"), userId }]);
  });

  afterAll(async () => {
    await db.delete(apiTokens).where(eq(apiTokens.token, createHash("sha256").update(token).digest("hex")));
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("150: recreating a workspace with a previously-deleted name succeeds", async () => {
    const name = `reused-ws-${suffix}`;
    const create = await req(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
      data: { type: "workspaces", attributes: { name } },
    });
    expect(create.status).toBe(201);
    const wsId = (await create.json() as { data: { id: string } }).data.id;

    // Delete
    const del = await req(`/api/v2/workspaces/${wsId}`, "DELETE");
    expect([200, 204]).toContain(del.status);

    // Recreate with same name
    const recreate = await req(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
      data: { type: "workspaces", attributes: { name } },
    });
    expect(recreate.status).toBe(201);
    const newId = (await recreate.json() as { data: { id: string } }).data.id;
    expect(newId).not.toBe(wsId);
  });

  it("150: the old ID is no longer resolvable after deletion", async () => {
    const name = `oldid-ws-${suffix}`;
    const create = await req(`/api/v2/organizations/${orgName}/workspaces`, "POST", {
      data: { type: "workspaces", attributes: { name } },
    });
    const wsId = (await create.json() as { data: { id: string } }).data.id;
    await req(`/api/v2/workspaces/${wsId}`, "DELETE");
    const fetchOld = await req(`/api/v2/workspaces/${wsId}`, "GET");
    expect(fetchOld.status).toBe(404);
  });
});
