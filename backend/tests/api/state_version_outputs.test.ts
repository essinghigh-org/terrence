import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, organizations, organizationMemberships, workspaces, stateVersions } from "../../src/db/schema";

describe("State Version Outputs & Temporal Upload API", () => {
  let token: string;
  let workspaceId: string;

  beforeAll(async () => {
    const userId = `usr-${crypto.randomUUID()}`;
    const tokenVal = `test-token-${crypto.randomUUID()}`;
    const orgName = `org-${crypto.randomUUID()}`;
    workspaceId = `ws-${crypto.randomUUID()}`;
    const orgId = `org-${crypto.randomUUID()}`;

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

    await db.insert(workspaces).values({
      id: workspaceId,
      name: "test-workspace-outputs",
      orgId,
      createdAt: Date.now(),
    });

    token = tokenVal;
  });

  test("POST /workspaces/:id/state-versions returns temporal upload URLs when state omitted", async () => {
    const lock = await app.handle(new Request(`http://localhost/api/v2/workspaces/${workspaceId}/actions/lock`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(lock.status).toBe(200);
    const res = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/state-versions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "state-versions",
            attributes: {
              serial: 1,
            },
          },
        }),
      })
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.attributes.status).toBe("pending");
    expect(json.data.attributes["hosted-state-upload-url"]).toBeDefined();
  });

  test("POST /state-versions/:id/actions/rollback creates new serial state version", async () => {
    const rawState = JSON.stringify({
      version: 4,
      serial: 2,
      lineage: "abc",
      resources: [],
      outputs: {
        api_url: { type: "string", value: "https://example.com" },
      },
    });

    const svId = `sv-${crypto.randomUUID()}`;
    await db.insert(stateVersions).values({
      id: svId,
      workspaceId,
      serial: 2,
      statePayload: rawState,
      jsonState: rawState,
      status: "finalized",
      createdAt: Date.now(),
    });

    const res = await app.handle(
      new Request(`http://localhost/api/v2/state-versions/${svId}/actions/rollback`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.attributes.serial).toBeGreaterThan(2);
    expect(json.data.attributes.status).toBe("finalized");
  });
});
