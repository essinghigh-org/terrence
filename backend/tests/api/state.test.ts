import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { workspaceVariables } from "../../src/db/schema";
import { organizations, workspaces, stateVersions } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("TFE API v2 - State Versions & Locking", () => {
  let workspaceId = "";
  let userToken: string;

  beforeAll(async () => {
    // Clear and setup
    const { runs, configurationVersions, users, apiTokens } = await import("../../src/db/schema");
    await db.delete(runs);
    await db.delete(configurationVersions);
    await db.delete(stateVersions);
    await db.delete(workspaceVariables); await db.delete(workspaces);
    await db.delete(apiTokens);
    await db.delete(users);
    await db.delete(organizations);

    // Setup auth
    await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { type: "users", attributes: { username: "state-owner", password: "securepassword" } },
        }),
      })
    );

    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username: "state-owner", password: "securepassword" } },
        }),
      })
    );
    userToken = (await loginRes.json()).data.attributes.token;

    await db.insert(organizations).values({ id: "org-3", name: "homelab-state" });
    const ws = await db.insert(workspaces).values({
      id: "ws-state-test",
      name: "state-workspace",
      orgId: "org-3",
      locked: false
    }).returning();
    workspaceId = ws[0].id;
  });

  it("should lock a workspace", async () => {
    const response = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/actions/lock`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );

    expect(response.status).toBe(200);
    const dbWorkspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId)
    });
    expect(dbWorkspace?.locked).toBe(true);
  });

  it("should unlock a workspace", async () => {
    const response = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/actions/unlock`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );

    expect(response.status).toBe(200);
    const dbWorkspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId)
    });
    expect(dbWorkspace?.locked).toBe(false);
  });

  it("should fetch current state version (initially null/404 if not found depending on TFE standard, but let's say 404 for no state)", async () => {
    const response = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/current-state-version`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    // Standard TFE returns 404 when there is no state version yet.
    expect(response.status).toBe(404);
  });

  it("should create a state version", async () => {
    const statePayload = {
      version: 4,
      terraform_version: "1.9.0",
      serial: 1,
      lineage: "b3f...",
      outputs: {},
      resources: []
    };

    const response = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/state-versions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/vnd.api+json",
            "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            type: "state-versions",
            attributes: {
              serial: 1,
              state: Buffer.from(JSON.stringify(statePayload)).toString('base64')
            }
          }
        }),
      })
    );

    expect(response.status).toBe(201);
  });
});
