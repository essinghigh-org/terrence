import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { workspaceVariables } from "../../src/db/schema";
import { organizations, workspaces, runs, stateVersions } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("TFE API v2 - Runs", () => {
  let workspaceId = "";
  let userToken: string;

  beforeAll(async () => {
    // Clear and setup
    const { configurationVersions, users, apiTokens, logs, workspaceTags, organizationMemberships } = await import("../../src/db/schema");
    await db.delete(logs);
    await db.delete(runs);
    await db.delete(configurationVersions);
    await db.delete(stateVersions);
    await db.delete(workspaceVariables);
    await db.delete(workspaceTags);
    await db.delete(workspaces);
    await db.delete(organizationMemberships);
    await db.delete(apiTokens);
    await db.delete(users).where(eq(users.username, "run-owner"));

    await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { type: "users", attributes: { username: "run-owner", password: "securepassword" } },
        }),
      })
    );

    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username: "run-owner", password: "securepassword" } },
        }),
      })
    );
    userToken = (await loginRes.json()).data.attributes.token;

    // Create org via API so ownership membership is established
    const orgRes = await app.handle(
      new Request("http://localhost/api/v2/organizations", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { type: "organizations", attributes: { name: `homelab-runs-${Date.now()}` } }
        })
      })
    );
    expect(orgRes.status).toBe(201);
    const orgId = (await orgRes.json()).data.id;

    const ws = await db.insert(workspaces).values({
      id: "ws-run-test",
      name: "run-workspace",
      orgId: orgId,
      autoApply: false
    }).returning();
    workspaceId = ws[0].id;
  });

  it("should create a run", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v2/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            attributes: {
              message: "Custom run message",
            },
            relationships: {
              workspace: {
                data: {
                  id: workspaceId,
                  type: "workspaces",
                },
              },
            },
          },
        }),
      })
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.data.type).toBe("runs");
    expect(data.data.attributes.status).toBe("pending");
    expect(data.data.attributes.message).toBe("Custom run message");

    const runInDb = await db.query.runs.findFirst({
      where: eq(runs.id, data.data.id),
    });
    expect(runInDb).toBeDefined();
    expect(runInDb?.status).toBe("pending");
  });
});
