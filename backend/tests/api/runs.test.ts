import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { workspaceVariables } from "../../src/db/schema";
import { organizations, workspaces, runs, stateVersions } from "../../src/db/schema";

describe("TFE API v2 - Runs", () => {
  let workspaceId = "";

  let userToken: string;
  beforeAll(async () => {
    // Clear and setup
    const { configurationVersions, users, apiTokens } = await import("../../src/db/schema");
    await db.delete(runs);
    await db.delete(configurationVersions);
    await db.delete(stateVersions);
    await db.delete(workspaceVariables); await db.delete(workspaces);
    await db.delete(apiTokens);
    await db.delete(users);
    await db.delete(organizations);

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

    await db.insert(organizations).values({ id: "org-2", name: "homelab-runs" });
    const ws = await db.insert(workspaces).values({
      id: "ws-run-test",
      name: "run-workspace",
      orgId: "org-2",
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
              message: "Test Run",
            },
            relationships: {
              workspace: {
                data: {
                  type: "workspaces",
                  id: workspaceId
                }
              }
            },
            type: "runs",
          },
        }),
      })
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.data.attributes.message).toBe("Test Run");
    expect(data.data.attributes.status).toBe("pending");

    const runId = data.data.id;

    // Test get run
    const getResponse = await app.handle(
      new Request(`http://localhost/api/v2/runs/${runId}`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(getResponse.status).toBe(200);

    // Test apply run
    const applyResponse = await app.handle(
      new Request(`http://localhost/api/v2/runs/${runId}/actions/apply`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(applyResponse.status).toBe(200);

    // Test discard run
    const discardResponse = await app.handle(
      new Request(`http://localhost/api/v2/runs/${runId}/actions/discard`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(discardResponse.status).toBe(200);

    // Test cancel run
    const cancelResponse = await app.handle(
      new Request(`http://localhost/api/v2/runs/${runId}/actions/cancel`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(cancelResponse.status).toBe(200);
  });
});
