import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, users } from "../../src/db/schema";

describe("legacy API tokens require an explicit compatibility opt-in", () => {
  const suffix = crypto.randomUUID();
  const userId = `legacy-default-user-${suffix}`;
  const tokenId = `legacy-default-token-${suffix}`;
  const rawToken = `legacy-default-${suffix}`;
  const previous = process.env.TERRENCE_ALLOW_LEGACY_TOKENS;

  beforeAll(async () => {
    delete process.env.TERRENCE_ALLOW_LEGACY_TOKENS;
    await db.insert(users).values({
      id: userId,
      username: `legacy-default-${suffix}`,
      passwordHash: "test-password-hash",
    });
    await db.insert(apiTokens).values({ id: tokenId, token: rawToken, userId });
  });

  afterAll(async () => {
    await db.delete(apiTokens).where(eq(apiTokens.id, tokenId));
    await db.delete(users).where(eq(users.id, userId));
    if (previous === undefined) delete process.env.TERRENCE_ALLOW_LEGACY_TOKENS;
    else process.env.TERRENCE_ALLOW_LEGACY_TOKENS = previous;
  });

  it("rejects a plaintext token when the compatibility flag is unset", async () => {
    const response = await app.handle(new Request("http://terrence.test/api/v2/account/details", {
      headers: { Authorization: `Bearer ${rawToken}` },
    }));
    expect(response.status).toBe(401);
  });
});
