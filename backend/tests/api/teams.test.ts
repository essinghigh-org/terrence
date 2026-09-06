import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import {
  apiTokens,
  organizationMemberships,
  organizations,
  users,
  workspaces,
} from "../../src/db/schema";

describe("teams and team access API contract", () => {
  const suffix = crypto.randomUUID();
  const userId = `user-${suffix}`;
  const memberUserId = `member-user-${suffix}`;
  const orgId = `org-${suffix}`;
  const orgName = `teams-org-${suffix}`;
  const token = `user-token-${suffix}`;
  const memberToken = `member-token-${suffix}`;
  const workspaceId = `ws-teams-${suffix}`;

  const request = (path: string, method = "GET", body?: unknown, auth = token) =>
    app.handle(new Request(`http://terrence.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: userId, username: userId, passwordHash: "unused" },
      { id: memberUserId, username: memberUserId, passwordHash: "unused" },
    ]);
    await db.insert(organizations).values([{ id: orgId, name: orgName }]);
    await db.insert(organizationMemberships).values([
      { id: crypto.randomUUID(), userId, orgId, role: "owner" },
      { id: crypto.randomUUID(), userId: memberUserId, orgId, role: "member" },
    ]);
    await db.insert(apiTokens).values([
      { id: crypto.randomUUID(), token: createHash("sha256").update(token).digest("hex"), userId },
      { id: crypto.randomUUID(), token: createHash("sha256").update(memberToken).digest("hex"), userId: memberUserId },
    ]);
    await db.insert(workspaces).values([{ id: workspaceId, name: `ws-${suffix}`, orgId }]);
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(apiTokens).where(inArray(apiTokens.userId, [userId, memberUserId]));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.username, userId));
    await db.delete(users).where(eq(users.username, memberUserId));
  });

  it("creates, lists, updates, and deletes teams", async () => {
    // 1. Create team
    const createRes = await request(`/api/v2/organizations/${orgName}/teams`, "POST", {
      data: {
        attributes: {
          name: "developers",
          description: "Engineering team",
          visibility: "organization",
          "allow-member-token-management": true,
        },
      },
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    const teamId = createBody.data.id;
    expect(createBody.data.attributes.name).toBe("developers");
    expect(createBody.data.attributes["allow-member-token-management"]).toBe(true);
    for (const enabled of [false, true]) {
      const updated = await request(`/api/v2/teams/${teamId}`, "PATCH", { data: { attributes: { "allow-member-token-management": enabled } } });
      expect(updated.status).toBe(200);
      const refreshed = await request(`/api/v2/teams/${teamId}`);
      expect((await refreshed.json()).data.attributes["allow-member-token-management"]).toBe(enabled);
    }

    // 2. List teams
    const listRes = await request(`/api/v2/organizations/${orgName}/teams`);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.some((t: any) => t.id === teamId)).toBeTrue();

    // 3. Add team member
    const addMemberRes = await request(`/api/v2/teams/${teamId}/relationships/users`, "POST", {
      data: [{ id: memberUserId, type: "users" }],
    });
    expect(addMemberRes.status).toBe(204);

    // 4. Get team with included users
    const getRes = await request(`/api/v2/teams/${teamId}?include=users`);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.data.attributes["users-count"]).toBe(1);
    expect(getBody.included?.[0]?.id).toBe(memberUserId);
    expect((await request(`/api/v2/teams/${teamId}/relationships/users`, "POST", { data: [{ id: userId, type: "users" }] })).status).toBe(204);
    const membershipPath = `/api/v2/teams/${teamId}/relationships/organization-memberships?page[size]=1`;
    const firstPage = await request(membershipPath);
    expect(firstPage.status).toBe(200);
    const first = await firstPage.json();
    const second = await (await request(`${membershipPath}&page[number]=2`)).json();
    expect(first.data).toHaveLength(1);
    expect(second.data).toHaveLength(1);
    expect(first.data[0].id).not.toBe(second.data[0].id);
    expect(first.meta.pagination["total-count"]).toBe(2);
    expect(second.links.next).toBeNull();
    expect((await request(membershipPath, "GET", undefined, "invalid-token")).status).toBe(404);
    try {
      for (const canRead of [false, true]) {
        await db.update(apiTokens).set({ scopes: JSON.stringify({ version: 1, orgs: [orgId], permissions: { "teams:read": true, "members:read": canRead } }) }).where(eq(apiTokens.userId, userId));
        expect((await request(membershipPath)).status).toBe(canRead ? 200 : 404);
      }
    } finally {
      await db.update(apiTokens).set({ scopes: null }).where(eq(apiTokens.userId, userId));
    }
    expect((await request(`/api/v2/teams/${teamId}`, "PATCH", { data: { attributes: { "organization-access": { "manage-teams": true } } } })).status).toBe(200);
    expect((await request(`/api/v2/teams/${teamId}`, "PATCH", { data: { attributes: { name: "developers" } } }, memberToken)).status).toBe(200);
    const policy = { data: { attributes: { name: "forbidden-policy", "allow-member-token-management": false } } };
    expect((await request(`/api/v2/teams/${teamId}`, "PATCH", policy, memberToken)).status).toBe(404);
    expect((await request(`/api/v2/organizations/${orgName}/teams`, "POST", policy, memberToken)).status).toBe(404);




    // 5. Create team authentication token
    const createTokenRes = await request(`/api/v2/teams/${teamId}/authentication-tokens`, "POST", {
      data: { attributes: { description: "CI/CD Token" } },
    });
    expect(createTokenRes.status).toBe(201);
    const createTokenBody = await createTokenRes.json();
    const teamTokenSecret = createTokenBody.data.attributes.token;
    expect(teamTokenSecret).toBeDefined();

    // 6. List team tokens
    const listTokensRes = await request(`/api/v2/teams/${teamId}/authentication-tokens`);
    expect(listTokensRes.status).toBe(200);
    const listTokensBody = await listTokensRes.json();
    expect(listTokensBody.data.length).toBe(1);

    // 7. Create team workspace access
    const twRes = await request("/api/v2/team-workspaces", "POST", {
      data: {
        attributes: { access: "write" },
        relationships: {
          team: { data: { id: teamId, type: "teams" } },
          workspace: { data: { id: workspaceId, type: "workspaces" } },
        },
      },
    });
    expect(twRes.status).toBe(201);
    const twBody = await twRes.json();
    const twId = twBody.data.id;

    // 8. Filter team-workspaces by workspace ID
    const filterTwRes = await request(`/api/v2/team-workspaces?filter[workspace][id]=${workspaceId}`);
    expect(filterTwRes.status).toBe(200);
    const filterTwBody = await filterTwRes.json();
    expect(filterTwBody.data.some((tw: any) => tw.id === twId)).toBeTrue();

    // 9. Clean up team workspace access and team
    const deleteTwRes = await request(`/api/v2/team-workspaces/${twId}`, "DELETE");
    expect(deleteTwRes.status).toBe(204);

    const deleteTeamRes = await request(`/api/v2/teams/${teamId}`, "DELETE");
    expect(deleteTeamRes.status).toBe(204);
  });
});
