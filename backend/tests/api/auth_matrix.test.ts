import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { hashAuthenticationToken, opaqueToken } from "../../src/lib/token-service";

const AUTHED_ROUTE = "/api/v2/organizations";
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

describe("7.4 Authentication test matrix", () => {
  const suffix = Date.now();
  let userId: string;
  let hashedToken: string;
  let rawHashedToken: string;
  let legacyTokenPlain: string;
  let legacyTokenId: string;

  beforeAll(async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({ data: { type: "users", attributes: { username: `authmx_${suffix}`, password: "Test12345!" } } }),
      }),
    );
    const body = await res.json() as { data: { id: string } };
    userId = body.data.id;

    rawHashedToken = opaqueToken(`user`);
    hashedToken = hashAuthenticationToken(rawHashedToken);
    await db.insert(apiTokens).values({ id: `authmx-hash-${suffix}`, token: hashedToken, userId, description: "auth-matrix hashed", createdAt: Date.now(), expiresAt: null } as never);

    legacyTokenPlain = `legacy-${suffix}-${randomBytes(8).toString("hex")}`;
    legacyTokenId = `authmx-legacy-${suffix}`;
    await db.insert(apiTokens).values({ id: legacyTokenId, token: legacyTokenPlain, userId, description: "auth-matrix legacy", createdAt: Date.now(), expiresAt: null } as never);
  });

  it("481 legacy UUID token still authenticates (and upgrades to hash)", async () => {
    const res = await app.handle(new Request(`http://localhost${AUTHED_ROUTE}`, { headers: auth(legacyTokenPlain) as never }));
    expect(res.status).not.toBe(401);
    const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, legacyTokenId) });
    expect(row?.token).toBe(createHash("sha256").update(legacyTokenPlain).digest("hex"));
  });

  it("482 new (hashed) token format authenticates", async () => {
    const res = await app.handle(new Request(`http://localhost${AUTHED_ROUTE}`, { headers: auth(rawHashedToken) as never }));
    expect(res.status).not.toBe(401);
  });

  it("483 malformed version marker (unknown prefix) rejected", async () => {
    const res = await app.handle(new Request(`http://localhost${AUTHED_ROUTE}`, { headers: auth("not-a-real-prefix-xyz123") as never }));
    expect(res.status).toBe(401);
  });

  it("484 enormous token rejected cheaply (>512 chars -> invalid without DB hit)", async () => {
    const enormous = "user-" + "x".repeat(600);
    const res = await app.handle(new Request(`http://localhost${AUTHED_ROUTE}`, { headers: auth(enormous) as never }));
    expect(res.status).toBe(401);
  });

  it("485 expired token rejected", async () => {
    const raw = opaqueToken("user");
    const hash = hashAuthenticationToken(raw);
    const id = `authmx-exp-${suffix}`;
    await db.insert(apiTokens).values({ id, token: hash, userId, description: "expired", createdAt: Date.now(), expiresAt: Date.now() - 1000 } as never);
    const res = await app.handle(new Request(`http://localhost${AUTHED_ROUTE}`, { headers: auth(raw) as never }));
    expect(res.status).toBe(401);
  });

  it("486 revoked token rejected (deleted row)", async () => {
    const raw = opaqueToken("user");
    const hash = hashAuthenticationToken(raw);
    const id = `authmx-del-${suffix}`;
    await db.insert(apiTokens).values({ id, token: hash, userId, description: "to-delete", createdAt: Date.now(), expiresAt: null } as never);
    // Valid first
    expect((await app.handle(new Request(`http://localhost${AUTHED_ROUTE}`, { headers: auth(raw) as never }))).status).not.toBe(401);
    // Delete then invalid
    await db.delete(apiTokens).where(eq(apiTokens.id, id));
    const res2 = await app.handle(new Request(`http://localhost${AUTHED_ROUTE}`, { headers: auth(raw) as never }));
    expect(res2.status).toBe(401);
  });
});
