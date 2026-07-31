import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizations } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";

describe("TFE API Authentication - Tokens", () => {
  let userToken: string;
  let orgId: string;
  const username = `tokenuser_${Date.now()}`;
  const orgName = `token_org_${Date.now()}`;

  beforeAll(async () => {
    // Seed User
    const res = await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { type: "users", attributes: { username, password: "securepassword" } },
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
          data: { attributes: { username, password: "securepassword" } },
        }),
      })
    );
    expect(loginRes.status).toBe(200);
    const loginData = await loginRes.json();
    userToken = loginData.data.attributes.token;

    // Create Organization via API so ownership membership is established
    const orgRes = await app.handle(
      new Request("http://localhost/api/v2/organizations", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({
          data: { type: "organizations", attributes: { name: orgName } }
        })
      })
    );
    expect(orgRes.status).toBe(201);
    orgId = (await db.query.organizations.findFirst({ where: eq(organizations.name, orgName) }))?.id ?? "";
  });

  it("should block unauthenticated token creation", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v2/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: {
            type: "tokens",
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
            type: "tokens",
            attributes: { description: "CI Token" },
            relationships: { organization: { data: { id: orgId, type: "organizations" } } }
          }
        })
      })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.data.type).toBe("authentication-tokens");
    expect(data.data.attributes.token).toBeDefined();

    const tokenHash = createHash("sha256").update(data.data.attributes.token as string).digest("hex");
    const tokenInDb = await db.query.apiTokens.findFirst({
        where: eq(apiTokens.token, tokenHash)
    });
    expect(tokenInDb).toBeDefined();
    expect(tokenInDb?.description).toBe("CI Token");
  });
});
