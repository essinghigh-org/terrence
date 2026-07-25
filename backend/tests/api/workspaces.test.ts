import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { organizations, workspaces } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("TFE API v2 - Workspaces", () => {
  let userToken: string;

  beforeAll(async () => {
    // Need to clean up everything that references orgs/users to avoid FK constraint errors
    const { stateVersions, runs, workspaces: wsModel, workspaceVariables, organizationMemberships, apiTokens, users } = await import("../../src/db/schema");
    await db.delete(stateVersions);
    await db.delete(runs);
    await db.delete(workspaceVariables); await db.delete(wsModel);
    await db.delete(organizationMemberships);

    await db.delete(apiTokens);
    await db.delete(organizations);
    await db.delete(users);

    const res = await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { type: "users", attributes: { username: "ws-owner", password: "securepassword" } },
        }),
      })
    );
    expect(res.status).toBe(201);

    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username: "ws-owner", password: "securepassword" } },
        }),
      })
    );
    userToken = (await loginRes.json()).data.attributes.token;

    await db.insert(organizations).values({ id: "org-1", name: "homelab" });
  });

  it("should create a workspace", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v2/organizations/homelab/workspaces", {
        method: "POST",
        headers: {
           "Content-Type": "application/vnd.api+json",
           "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            attributes: {
              name: "my-test-workspace",
              "auto-apply": true,
            },
            type: "workspaces",
          },
        }),
      })
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.data.attributes.name).toBe("my-test-workspace");
    expect(data.data.attributes["auto-apply"]).toBe(true);

    const dbWorkspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.name, "my-test-workspace")
    });
    expect(dbWorkspace).toBeDefined();
    expect(dbWorkspace?.autoApply).toBe(true);
  });

  it("should read a workspace by name", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v2/organizations/homelab/workspaces/my-test-workspace", {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data.attributes.name).toBe("my-test-workspace");
  });
});
