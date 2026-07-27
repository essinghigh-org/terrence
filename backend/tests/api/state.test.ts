import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { workspaceVariables, workspaces, stateVersions } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("TFE API v2 - State Versions & Locking", () => {
  let workspaceId = "";
  let userToken: string;

  beforeAll(async () => {
    // Clear and setup
    const { runs, configurationVersions, users, apiTokens, logs, workspaceTags, organizationMemberships } = await import("../../src/db/schema");
    await db.delete(logs);
    await db.delete(runs);
    await db.delete(configurationVersions);
    await db.delete(stateVersions);
    await db.delete(workspaceVariables);
    await db.delete(workspaceTags);
    await db.delete(workspaces);
    await db.delete(organizationMemberships);
    await db.delete(apiTokens);
    await db.delete(users).where(eq(users.username, "state-owner"));

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

    const orgRes = await app.handle(
      new Request("http://localhost/api/v2/organizations", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { type: "organizations", attributes: { name: `homelab-state-${Date.now()}` } }
        })
      })
    );
    expect(orgRes.status).toBe(201);
    const orgId = (await orgRes.json()).data.id;

    const ws = await db.insert(workspaces).values({
      id: "ws-state-test",
      name: "state-workspace",
      orgId: orgId,
      locked: false
    }).returning();
    workspaceId = ws[0].id;
  });

  it("should lock a workspace", async () => {
    const response = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/actions/lock`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${userToken}` },
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data.attributes.locked).toBe(true);
  });

  it("should unlock a workspace", async () => {
    const response = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/actions/unlock`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${userToken}` },
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data.attributes.locked).toBe(false);
  });

  it("should fetch current state version (initially null/404 if not found depending on TFE standard, but let's say 404 for no state)", async () => {
    const response = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/current-state-version`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` },
      })
    );

    expect(response.status).toBe(404);
  });

  it("should create a state version", async () => {
    const response = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/state-versions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            attributes: {
              serial: 1,
              state: JSON.stringify({ version: 4, terraform_version: "1.5.0" }),
            },
          },
        }),
      })
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.data.type).toBe("state-versions");
    expect(data.data.attributes.serial).toBe(1);

    const currentRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/current-state-version`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` },
      })
    );
    expect(currentRes.status).toBe(200);
    const currentData = await currentRes.json();
    expect(currentData.data.attributes.serial).toBe(1);
  });
});
