import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { apiTokens } from "../../src/db/schema";
import {
  cleanupSeed,
  expectCollection,
  expectErrorResponse,
  expectNoContent,
  expectSuccessResponse,
  jsonHeaders,
  persistSeed,
  request,
  seedTfeOrg,
} from "./tfe_contract_helpers";

describe("TFE authentication tokens contract", () => {
  const seed = seedTfeOrg("tok");
  const headers = jsonHeaders(seed.token);
  let tokenId = "";

  beforeAll(async () => {
    await persistSeed(seed);
  });

  afterAll(async () => {
    await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
    await cleanupSeed(seed);
  });

  it("creates a user token with the documented shape", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/users/${seed.userId}/authentication-tokens`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: {
            type: "authentication-tokens",
            attributes: { description: "contract test token" },
          },
        }),
      }),
      201,
      "authentication-tokens",
    );
    tokenId = resource.id;
    expect(resource.attributes.token).toBeTypeOf("string");
    expect(resource.attributes.token).not.toBeNull();
    expect(resource.attributes.description).toBe("contract test token");
    expect(resource.attributes["created-at"]).toBeTypeOf("string");
    expect(resource.relationships?.["created-by"]).toMatchObject({
      data: { id: seed.userId, type: "users" },
    });
  });

  it("lists user tokens", async () => {
    const response = await request(`/api/v2/users/${seed.userId}/authentication-tokens`, { headers });
    expect(response.status).toBe(200);
    const items = expectCollection(await response.json(), "authentication-tokens");
    expect(items.map((t) => t.id)).toContain(tokenId);
  });

  it("shows a token without exposing the secret", async () => {
    const resource = await expectSuccessResponse(
      await request(`/api/v2/authentication-tokens/${tokenId}`, { headers }),
      200,
      "authentication-tokens",
    );
    expect(resource.attributes.token).toBeNull();
    expect(resource.attributes["created-at"]).toBeTypeOf("string");
  });

  it("destroys a user token", async () => {
    await expectNoContent(await request(`/api/v2/authentication-tokens/${tokenId}`, { method: "DELETE", headers }));
    await expectErrorResponse(await request(`/api/v2/authentication-tokens/${tokenId}`, { headers }), 404);
  });

  it("creates and shows an organization token", async () => {
    const created = await expectSuccessResponse(
      await request(`/api/v2/organizations/${seed.orgName}/authentication-token`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          data: { type: "authentication-tokens" },
        }),
      }),
      201,
      "authentication-tokens",
    );
    expect(created.attributes.token).toBeTypeOf("string");
    expect(created.attributes.token).not.toBeNull();
    tokenId = created.id;

    const shown = await expectSuccessResponse(
      await request(`/api/v2/organizations/${seed.orgName}/authentication-token`, { headers }),
      200,
      "authentication-tokens",
    );
    expect(shown.attributes.token).toBeNull();
    expect(shown.attributes["created-at"]).toBeTypeOf("string");
  });

  it("deletes the organization token", async () => {
    await expectNoContent(await request(`/api/v2/organizations/${seed.orgName}/authentication-token`, { method: "DELETE", headers }));
    await expectErrorResponse(await request(`/api/v2/organizations/${seed.orgName}/authentication-token`, { headers }), 404);
  });
});
