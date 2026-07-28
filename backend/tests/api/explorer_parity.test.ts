import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, organizations, organizationMemberships, projects, workspaces } from "../../src/db/schema";

describe("Explorer API (TFE Parity)", () => {
  let token: string;
  let orgName: string;

  beforeAll(async () => {
    const userId = `usr-${crypto.randomUUID()}`;
    const tokenVal = `test-token-${crypto.randomUUID()}`;
    orgName = `org-${crypto.randomUUID()}`;
    const orgId = `org-${crypto.randomUUID()}`;
    const projId = `prj-${crypto.randomUUID()}`;
    const wsId = `ws-${crypto.randomUUID()}`;

    await db.insert(users).values({
      id: userId,
      username: `user_${Date.now()}`,
      passwordHash: "hash",
    });

    await db.insert(apiTokens).values({
      id: `tok-${crypto.randomUUID()}`,
      token: tokenVal,
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
      role: "owner",
      status: "active",
    });

    await db.insert(projects).values({
      id: projId,
      orgId,
      name: "Default Project",
    });

    await db.insert(workspaces).values({
      id: wsId,
      orgId,
      projectId: projId,
      name: "explorer-ws",
      terraformVersion: "1.5.7",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    token = tokenVal;
  });

  test("GET /organizations/:org_name/explorer returns type 'workspaces' and TFE attributes", async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/explorer?type=workspaces`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    if (res.status !== 200) {
      console.log("Error status:", res.status, await res.json());
    }
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBeGreaterThan(0);
    expect(json.data[0].type).toBe("workspaces");
    expect(json.data[0].attributes.organization_name).toBe(orgName);
    expect(json.data[0].attributes.workspace_name).toBe("explorer-ws");
  });
});
