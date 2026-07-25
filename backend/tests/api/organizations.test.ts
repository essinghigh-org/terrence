import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { organizations, users, apiTokens } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("TFE API v2 - Organizations", () => {
  let userToken: string;

  beforeAll(async () => {
    // Need to clean up everything that references orgs/users
    const { stateVersions, runs, workspaces, organizationMemberships, workspaceVariables } = await import("../../src/db/schema");
    await db.delete(stateVersions);
    await db.delete(runs);
    await db.delete(workspaceVariables); await db.delete(workspaces);
    await db.delete(organizationMemberships);

    await db.delete(apiTokens);
    await db.delete(organizations);
    await db.delete(users);

    const res = await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { type: "users", attributes: { username: "org-owner", password: "securepassword" } },
        }),
      })
    );
    expect(res.status).toBe(201);

    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username: "org-owner", password: "securepassword" } },
        }),
      })
    );
    userToken = (await loginRes.json()).data.attributes.token;
  });

  it("should create an organization", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v2/organizations", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { type: "organizations", attributes: { name: "my-homelab", email: "admin@homelab.local" } }
        })
      })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.data.type).toBe("organizations");
    expect(data.data.attributes.name).toBe("my-homelab");
  });

  it("should get an organization by name", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v2/organizations/my-homelab", {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data.attributes.name).toBe("my-homelab");
  });

  it("should list organizations", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v2/organizations", {
        method: "GET",
        headers: { "Authorization": `Bearer ${userToken}` }
      })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.data.length).toBe(1);
    expect(data.data[0].attributes.name).toBe("my-homelab");
  });
});
