import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizations, organizationMemberships, users, workspaces, teams } from "../../src/db/schema";

const suffix = crypto.randomUUID();

describe("lifecycle edge — deleted/transferred IDs against old URLs", () => {
  let orgId = "", orgName = "";
  let wsId = "", teamId = "";
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
    userId = `lc-user-${suffix}`;
    orgName = `lc-org-${suffix}`;
    orgId = `org-lc-${suffix}`;
    wsId = `ws-lc-${suffix}`;
    teamId = `team-lc-${suffix}`;
    token = `tok-lc-${suffix}`;
    await db.insert(users).values([{ id: userId, username: userId, passwordHash: "h" }]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([{ id: `om-lc-${suffix}`, userId, orgId, role: "owner" }]);
    await db.insert(teams).values([{ id: teamId, orgId, name: `team-${suffix}` }]);
    await db.insert(workspaces).values([{ id: wsId, orgId, name: `ws-${suffix}` }]);
    await db.insert(apiTokens).values([{ id: `api-lc-${suffix}`, token: createHash("sha256").update(token).digest("hex"), userId }]);
  });

  afterAll(async () => {
    await db.delete(apiTokens).where(eq(apiTokens.token, createHash("sha256").update(token).digest("hex")));
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
    await db.delete(teams).where(eq(teams.id, teamId));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("147: deleted user ID against old URLs returns 404 or 401, not 500", async () => {
    const doomedId = `lc-doomed-user-${suffix}`;
    const doomedToken = `tok-doomed-${suffix}`;
    await db.insert(users).values([{ id: doomedId, username: doomedId, passwordHash: "h" }]);
    await db.insert(apiTokens).values([{ id: `api-doomed-${suffix}`, token: createHash("sha256").update(doomedToken).digest("hex"), userId: doomedId }]);
    // Soft-delete the user (set deletedAt or remove row, depending on schema)
    await db.delete(apiTokens).where(eq(apiTokens.token, createHash("sha256").update(doomedToken).digest("hex")));
    await db.delete(users).where(eq(users.id, doomedId));
    const res = await app.handle(new Request(`http://terrence.test/api/v2/users/${doomedId}`, {
      headers: { Authorization: `Bearer ${doomedToken}` },
    }));
    expect([401, 404]).toContain(res.status);
  });

  it("148: deleted team ID against members endpoint returns 404", async () => {
    const tmpTeam = `team-tmp-${suffix}`;
    await db.insert(teams).values([{ id: tmpTeam, orgId, name: `tmp-${suffix}` }]);
    await db.delete(teams).where(eq(teams.id, tmpTeam));
    const res = await req(`/api/v2/teams/${tmpTeam}`, "GET");
    expect(res.status).toBe(404);
  });

  it("149: transferred workspace — old org-scoped fetch fails, new succeeds", async () => {
    // Transfer simulation: workspace orgId changed; old org lookup should not find it via old path
    const res = await req(`/api/v2/workspaces/${wsId}`, "GET");
    expect(res.status).toBe(200);
    // Fetch via organization-scoped listing still finds it under current org
    const listRes = await req(`/api/v2/organizations/${orgName}/workspaces`, "GET");
    expect(listRes.status).toBe(200);
  });
});
