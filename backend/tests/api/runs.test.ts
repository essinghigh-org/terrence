import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { organizations, workspaces, runs, stateVersions } from "../../src/db/schema";

describe("TFE API v2 - Runs", () => {
  let workspaceId = "";

  beforeAll(async () => {
    // Clear and setup
    await db.delete(runs);
    await db.delete(stateVersions);
    await db.delete(workspaces);
    await db.delete(organizations);

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
        headers: { "Content-Type": "application/vnd.api+json" },
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
  });
});
