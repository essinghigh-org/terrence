import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { createHash } from "node:crypto";
import { users, apiTokens, organizations, organizationMemberships } from "../../src/db/schema";

describe("VCS Events API", () => {
  let token: string;
  let orgName: string;

  beforeAll(async () => {
    const userId = `usr-${crypto.randomUUID()}`;
    const tokenVal = `test-token-${crypto.randomUUID()}`;
    orgName = `org-${crypto.randomUUID()}`;
    const orgId = `org-${crypto.randomUUID()}`;

    await db.insert(users).values({
      id: userId,
      username: `user_${Date.now()}`,
      passwordHash: "hash",
    });

    await db.insert(apiTokens).values({
      id: `tok-${crypto.randomUUID()}`,
      token: createHash("sha256").update(tokenVal).digest("hex"),
      userId,
      createdAt: Date.now(),
    });

    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
    });

    await db.insert(organizationMemberships).values({
      id: `om-${crypto.randomUUID()}`,
      userId,
      orgId,
      role: "member",
      status: "active",
    });

    token = tokenVal;
  });

  test("GET /organizations/:org_name/vcs-events returns VCS events list", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/vcs-events`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toBeDefined();
    expect(Array.isArray(json.data)).toBe(true);
  });
});
