import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { workspaceVariables } from "../../src/db/schema";
import { organizations, workspaces } from "../../src/db/schema";

describe("TFE API v2 - Configuration Versions", () => {
  let workspaceId = "";

  let userToken: string;
  beforeAll(async () => {
    // Clear and setup
    const { runs, configurationVersions, stateVersions, apiTokens, users } = await import("../../src/db/schema");
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
          data: { type: "users", attributes: { username: "cv-owner", password: "securepassword" } },
        }),
      })
    );

    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username: "cv-owner", password: "securepassword" } },
        }),
      })
    );
    userToken = (await loginRes.json()).data.attributes.token;

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
        headers: {
            "Content-Type": "application/vnd.api+json",
            "Authorization": `Bearer ${userToken}`
        },
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
