import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { organizations, workspaces } from "../../src/db/schema";

describe("TFE API v2 - Configuration Versions", () => {
  let workspaceId = "";

  beforeAll(async () => {
    // Clear and setup
    await db.delete(workspaces);
    await db.delete(organizations);

    await db.insert(organizations).values({ id: "org-cv", name: "homelab-cv" });
    const ws = await db.insert(workspaces).values({
      id: "ws-cv-test",
      name: "cv-workspace",
      orgId: "org-cv",
    }).returning();
    workspaceId = ws[0].id;
  });

  it("should create a configuration version and return an upload URL", async () => {
    const response = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/configuration-versions`, {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: {
            type: "configuration-versions",
            attributes: {
              "auto-queue": false
            }
          }
        }),
      })
    );

    expect(response.status).toBe(201);
    const data = await response.json();

    expect(data.data.type).toBe("configuration-versions");
    expect(data.data.attributes["upload-url"]).toBeDefined();
    expect(data.data.attributes.status).toBe("pending");
  });
});
