import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, organizations, teams, scimSettings, scimGroups } from "../../src/db/schema";

describe("Team SCIM Group Mapping API", () => {
  let adminToken: string;
  let teamId: string;
  let groupId: string;

  beforeAll(async () => {
    const userId = `usr-${crypto.randomUUID()}`;
    const tokenVal = `test-token-${crypto.randomUUID()}`;
    const orgId = `org-${crypto.randomUUID()}`;
    teamId = `team-${crypto.randomUUID()}`;
    groupId = `scimgroup-${crypto.randomUUID()}`;

    await db.insert(users).values({
      id: userId,
      username: `admin_${Date.now()}`,
      passwordHash: "hash",
      isSiteAdmin: true,
    });

    await db.insert(apiTokens).values({
      id: `tok-${crypto.randomUUID()}`,
      token: tokenVal,
      userId,
      createdAt: Date.now(),
    });

    await db.insert(organizations).values({
      id: orgId,
      name: `org-${crypto.randomUUID()}`,
    });

    await db.insert(teams).values({
      id: teamId,
      orgId,
      name: "devs",
    });

    await db.insert(scimSettings).values({
      id: "scim",
      enabled: true,
      paused: false,
      updatedAt: Date.now(),
    }).onConflictDoUpdate({
      target: scimSettings.id,
      set: { enabled: true, paused: false, updatedAt: Date.now() },
    });

    await db.insert(scimGroups).values({
      id: groupId,
      name: "Identity-Devs",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    adminToken = tokenVal;
  });

  test("POST /admin/teams/:id/scim-group-mapping maps group to team", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/admin/teams/${teamId}/scim-group-mapping`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "scim-group-mapping",
            attributes: {
              "scim-group-id": groupId,
            },
          },
        }),
      })
    );

    expect(res.status).toBe(204);
  });

  test("GET /admin/teams/:id/scim-group-mapping gets team mapping", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/admin/teams/${teamId}/scim-group-mapping`, {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.attributes["scim-group-id"]).toBe(groupId);
  });

  test("DELETE /admin/teams/:id/scim-group-mapping removes mapping", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/admin/teams/${teamId}/scim-group-mapping`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    );

    expect(res.status).toBe(204);
  });
});
