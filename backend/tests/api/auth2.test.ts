import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, organizations, apiTokens, workspaces } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("TFE API Authentication - Tokens", () => {
  let userToken: string;
  let orgId: string;

  beforeAll(async () => {
    // Need to clean up everything that references orgs/users to avoid FK constraint errors
    const { runs, configurationVersions, stateVersions, workspaceVariables, workspaces: wsModel, organizationMemberships } = await import("../../src/db/schema");
    await db.delete(runs);
    await db.delete(configurationVersions);
    await db.delete(stateVersions);
    await db.delete(workspaceVariables); await db.delete(wsModel);
    await db.delete(organizationMemberships);

    await db.delete(apiTokens);
    await db.delete(organizations);
    await db.delete(users);

    // Seed User
    const res = await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { type: "users", attributes: { username: "tokenuser", password: "securepassword" } },
        }),
      })
    );
    expect(res.status).toBe(201);

    // Login to get user token
    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { attributes: { username: "tokenuser", password: "securepassword" } },
        }),
      })
    );
    expect(loginRes.status).toBe(201);
    const loginData = await loginRes.json();
    userToken = loginData.data.attributes.token;

    // Seed Org directly
    orgId = crypto.randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "token-org",
    });
  });

  it("should block unauthenticated token creation", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v2/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: {
            type: "api-tokens",
            relationships: { organization: { data: { id: orgId, type: "organizations" } } }
          }
        })
      })
    );
    expect(res.status).toBe(401);
  });

  it("should allow creating an org token when authenticated", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v2/tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: {
            type: "api-tokens",
            attributes: { description: "CI Token" },
            relationships: { organization: { data: { id: orgId, type: "organizations" } } }
          }
        })
      })
    );
    if (res.status !== 201) {
       console.log(await res.text());
    }
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.data.type).toBe("api-tokens");
    expect(data.data.attributes.token).toBeDefined();

    // Verify token exists in DB and belongs to org
    const tokenInDb = await db.query.apiTokens.findFirst({
        where: eq(apiTokens.token, data.data.attributes.token)
    });
    expect(tokenInDb).toBeDefined();
    expect(tokenInDb?.orgId).toBe(orgId);
    expect(tokenInDb?.description).toBe("CI Token");
  });
});
