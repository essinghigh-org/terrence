import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, organizationMemberships, organizations, users } from "../../src/db/schema";
import { eq, or } from "drizzle-orm";
import { hashAuthenticationToken } from "../../src/lib/token-service";

describe("the reference format API Authentication - Tokens", () => {
  let userToken: string;
  let orgId: string;
  const userId = `token-user-${crypto.randomUUID()}`;
  const username = `tokenuser_${Date.now()}`;
  const orgName = `token_org_${Date.now()}`;

  beforeAll(async () => {
    userToken = `token-user-secret-${crypto.randomUUID()}`;
    orgId = `token-org-${crypto.randomUUID()}`;
    await db.insert(users).values({ id: userId, username, passwordHash: "unused" });
    await db.insert(organizations).values({ id: orgId, name: orgName });
    await db.insert(organizationMemberships).values({
      id: crypto.randomUUID(),
      userId,
      orgId,
      role: "owner",
      status: "active",
    });
    await db.insert(apiTokens).values({
      id: crypto.randomUUID(),
      token: hashAuthenticationToken(userToken),
      userId,
    });
  });

  afterAll(async () => {
    await db.delete(apiTokens).where(or(eq(apiTokens.userId, userId), eq(apiTokens.orgId, orgId)));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("should block unauthenticated token creation", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v2/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: {
            type: "tokens",
            relationships: { organization: { data: { id: orgId, type: "organizations" } } },
          },
        }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("should allow creating an org token when authenticated", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v2/tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          data: {
            type: "tokens",
            attributes: { description: "CI Token" },
            relationships: { organization: { data: { id: orgId, type: "organizations" } } },
          },
        }),
      }),
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.data.type).toBe("authentication-tokens");
    expect(data.data.attributes.token).toBeDefined();

    const tokenHash = hashAuthenticationToken(data.data.attributes.token as string);
    const tokenInDb = await db.query.apiTokens.findFirst({
      where: eq(apiTokens.token, tokenHash),
    });
    expect(tokenInDb).toBeDefined();
    expect(tokenInDb?.description).toBe("CI Token");
  });

  it("keeps modern organization tokens separate from the TFE compatibility credential", async () => {
    const compatibilityRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/authentication-token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ data: { type: "authentication-tokens", attributes: {} } }),
      }),
    );
    expect(compatibilityRes.status).toBe(201);
    const compatibilityToken = await compatibilityRes.json();
    const compatibilityId = compatibilityToken.data.id as string;

    const modernRes = await app.handle(
      new Request("http://localhost/api/v2/tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          data: {
            type: "tokens",
            attributes: {
              description: "Organization UI token",
              scopes: {
                version: 1,
                orgs: [orgId],
                permissions: { "workspaces:read": true },
              },
            },
            relationships: { organization: { data: { id: orgId, type: "organizations" } } },
          },
        }),
      }),
    );
    expect(modernRes.status).toBe(201);
    const modernToken = await modernRes.json();
    const modernId = modernToken.data.id as string;

    const listRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/authentication-tokens?page[size]=100`, {
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    expect(listRes.status).toBe(200);
    const listedIds = ((await listRes.json()).data as { id: string }[]).map((token) => token.id);
    expect(listedIds).toContain(modernId);
    expect(listedIds).not.toContain(compatibilityId);

    const compatibilityGet = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/authentication-token`, {
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    expect(compatibilityGet.status).toBe(200);
    expect((await compatibilityGet.json()).data.id).toBe(compatibilityId);

    const revokeModern = await app.handle(
      new Request(`http://localhost/api/v2/authentication-tokens/${modernId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    expect(revokeModern.status).toBe(204);

    const compatibilityStillExists = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/authentication-token`, {
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    expect(compatibilityStillExists.status).toBe(200);
    expect((await compatibilityStillExists.json()).data.id).toBe(compatibilityId);

    const deleteCompatibility = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/authentication-token`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    );
    expect(deleteCompatibility.status).toBe(204);
  });
});
