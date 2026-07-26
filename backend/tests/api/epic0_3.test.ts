import { describe, expect, it, beforeEach } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, organizations, organizationMemberships, teams, apiTokens, teamMemberships } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("Epic 0-3 API Infrastructure, Authentication, Organizations, Users & Teams", () => {
  let userToken: string;
  let userId: string;
  let orgName: string;
  let orgId: string;

  beforeEach(async () => {
    // Cleanup tables
    await db.delete(apiTokens);
    await db.delete(teamMemberships);
    await db.delete(teams);
    await db.delete(organizationMemberships);
    await db.delete(organizations);
    await db.delete(users);

    userId = `usr-${crypto.randomUUID()}`;
    userToken = `test-user-token-${crypto.randomUUID()}`;
    orgName = `epic-org-${crypto.randomUUID().substring(0, 8)}`;
    orgId = `org-${crypto.randomUUID()}`;

    await db.insert(users).values({
      id: userId,
      username: "epic_owner",
      email: "owner@epic.local",
      passwordHash: "hashed",
    });

    await db.insert(apiTokens).values({
      id: `tok-${crypto.randomUUID()}`,
      token: userToken,
      userId,
      createdAt: Date.now(),
    });

    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
    });

    await db.insert(organizationMemberships).values({
      id: `orgmem-owner-${crypto.randomUUID()}`,
      orgId,
      userId,
      role: "owner",
      status: "active",
    });
  });

  it("returns avatar-url attribute on user details and account details", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v2/account/details", {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attributes["avatar-url"]).toContain("gravatar.com");
  });

  it("lists all users and supports username filtering", async () => {
    // Add second user within same organization
    const u2Id = `usr-${crypto.randomUUID()}`;
    await db.insert(users).values({
      id: u2Id,
      username: "alice_developer",
      email: "alice@epic.local",
      passwordHash: "hashed",
    });
    await db.insert(organizationMemberships).values({
      id: `orgmem-alice-${crypto.randomUUID()}`,
      orgId,
      userId: u2Id,
      role: "member",
      status: "active",
    });

    const res = await app.handle(
      new Request("http://localhost/api/v2/users?filter[username]=alice", {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].attributes.username).toBe("alice_developer");
  });

  it("updates user profile details and deletes user", async () => {
    const patchRes = await app.handle(
      new Request(`http://localhost/api/v2/users/${userId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            attributes: { email: "newemail@epic.local" },
          },
        }),
      })
    );
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.data.attributes.email).toBe("newemail@epic.local");

    const delRes = await app.handle(
      new Request(`http://localhost/api/v2/users/${userId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(delRes.status).toBe(204);

    const checkUser = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(checkUser).toBeUndefined();
  });

  it("supports organization membership creation, listing, showing with include=user, and deletion", async () => {
    const inviteRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/organization-memberships`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            attributes: {
              email: "member@epic.local",
              status: "invited",
            },
          },
        }),
      })
    );
    expect(inviteRes.status).toBe(201);
    const inviteBody = await inviteRes.json();
    expect(inviteBody.data.type).toBe("organization-memberships");
    expect(inviteBody.data.attributes.status).toBe("invited");
    const memId = inviteBody.data.id;

    // List organization memberships with include=user
    const listRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/organization-memberships?include=user`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.length).toBe(2); // owner + new invite
    expect(listBody.included).toBeDefined();
    expect(listBody.included.length).toBeGreaterThan(0);

    // Show single membership
    const showRes = await app.handle(
      new Request(`http://localhost/api/v2/organization-memberships/${memId}?include=user`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(showRes.status).toBe(200);
    const showBody = await showRes.json();
    expect(showBody.data.id).toBe(memId);

    // Delete membership
    const deleteRes = await app.handle(
      new Request(`http://localhost/api/v2/organization-memberships/${memId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${userToken}` },
      })
    );
    expect(deleteRes.status).toBe(204);
  });

  it("supports team memberships via organization-membership IDs and team token authentication with expiry", async () => {
    // Create team
    const teamRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/teams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            attributes: { name: "DevOps Team" },
          },
        }),
      })
    );
    expect(teamRes.status).toBe(201);
    const teamBody = await teamRes.json();
    const teamId = teamBody.data.id;

    // Create team token with expiration
    const tokenRes = await app.handle(
      new Request(`http://localhost/api/v2/teams/${teamId}/authentication-tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            attributes: {
              description: "CI/CD Team Token",
              "expired-at": new Date(Date.now() + 3600000).toISOString(),
            },
          },
        }),
      })
    );
    expect(tokenRes.status).toBe(201);
    const tokenBody = await tokenRes.json();
    const teamSecret = tokenBody.data.attributes.token;
    expect(teamSecret).toBeDefined();

    // Authenticate using team token
    const pingRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/teams`, {
        headers: { Authorization: `Bearer ${teamSecret}` },
      })
    );
    expect(pingRes.status).toBe(200);

    // Invite user and attach via organization-membership relationship
    const inviteRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/organization-memberships`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            attributes: { email: "bob@epic.local" },
          },
        }),
      })
    );
    const memId = (await inviteRes.json()).data.id;

    const relRes = await app.handle(
      new Request(`http://localhost/api/v2/teams/${teamId}/relationships/organization-memberships`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: [{ id: memId, type: "organization-memberships" }],
        }),
      })
    );
    expect(relRes.status).toBe(204);
  });

  it("returns 404 security-through-obscurity for unauthorized resources", async () => {
    // Create another user without org access
    const strangerId = `usr-stranger-${crypto.randomUUID()}`;
    const strangerToken = `stranger-tok-${crypto.randomUUID()}`;
    await db.insert(users).values({
      id: strangerId,
      username: `stranger-${crypto.randomUUID()}`,
      email: `stranger-${crypto.randomUUID()}@other.local`,
      passwordHash: "hashed",
    });
    await db.insert(apiTokens).values({
      id: `tok-stranger-${crypto.randomUUID()}`,
      token: strangerToken,
      userId: strangerId,
      createdAt: Date.now(),
    });

    const res = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}`, {
        headers: { Authorization: `Bearer ${strangerToken}` },
      })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.errors[0].status).toBe("404");
  });
});
