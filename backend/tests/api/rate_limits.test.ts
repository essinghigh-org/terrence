import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { COMPATIBILITY_VERSION } from "../../src/lib/constants";
import { db } from "../../src/db";
import { apiTokens, users } from "../../src/db/schema";

type SeededUser = Readonly<{
  id: string;
  password: string;
  tokens: readonly string[];
  username: string;
}>;

const seededUsers: SeededUser[] = [];

async function seedUser(tokenCount: number): Promise<SeededUser> {
  const id = `rate-user-${crypto.randomUUID()}`;
  const username = `rate-user-${crypto.randomUUID()}`;
  const password = "rate-limit-password";
  const tokens = Array.from({ length: tokenCount }, (): string => `user-${crypto.randomUUID()}`);
  await db.insert(users).values({
    id,
    username,
    passwordHash: await Bun.password.hash(password, { algorithm: "bcrypt", cost: 4 }),
  });
  if (tokens.length > 0) {
    await db.insert(apiTokens).values(tokens.map((token: string, index: number) => ({
      id: `rate-token-${crypto.randomUUID()}`,
      token: createHash("sha256").update(token).digest("hex"),
      userId: id,
      description: `Rate limit token ${String(index + 1)}`,
      createdAt: Date.now(),
    })));
  }
  const seeded = { id, password, tokens, username };
  seededUsers.push(seeded);
  return seeded;
}

function authenticatedRequest(path: string, token: string, method = "GET"): Request {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/vnd.api+json",
  };
  if (method !== "POST") return new Request(`http://localhost${path}`, { method, headers });
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: JSON.stringify({ data: { type: "tokens", attributes: { description: "rate-limit-test" } } }),
  });
}

beforeAll(async () => {
  await seedUser(2);
  await seedUser(2);
  await seedUser(0);
});

afterAll(async () => {
  const userIds = seededUsers.map(({ id }): string => id);
  if (userIds.length === 0) return;
  await db.delete(apiTokens).where(inArray(apiTokens.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

describe("rate limiting", () => {
  it("does not count static asset or SPA shell requests against the API bucket", async () => {
    // A page load fetches 30-40 hashed chunks in parallel; those requests must
    // never consume the per-IP API bucket or every cold cache trips a 429.
    // Same client IP for the asset burst and the ping, so the ping would 429
    // if assets were counted (40 > 30/s sliding window).
    const client = (path: string): Request => new Request(`http://localhost${path}`, {
      headers: { "X-Forwarded-For": "192.0.2.77" },
    });
    for (let index = 0; index < 40; index += 1) {
      const response = await app.handle(client(`/assets/chunk-${String(index)}.js`));
      // 404 when frontend/dist is absent from the unit env, 200 in prod;
      // the assertion that matters is that the burst is never throttled.
      expect(response.status).not.toBe(429);
    }
    // ping requires auth (401 when unauthenticated); the property under test
    // is that the asset burst never throttles it.
    expect((await app.handle(client("/api/v1/ping"))).status).not.toBe(429);
  });

  it("shares the 60 requests/second bucket across a user's tokens", async () => {
    const user = seededUsers[0];
    expect(user).toBeDefined();
    for (let index = 0; index < 60; index += 1) {
      const response = await app.handle(authenticatedRequest("/api/v2/account/details", user!.tokens[index % 2]!));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-ratelimit-limit")).toBe("60");
    }

    const throttled = await app.handle(authenticatedRequest("/api/v2/account/details", user!.tokens[0]!));
    expect(throttled.status).toBe(429);

    const discovery = await app.handle(authenticatedRequest("/api/v2/ping", user!.tokens[0]!));
    expect(discovery.status).toBe(200);
    expect(discovery.headers.get("X-TFE-Current-Version")).toBe(COMPATIBILITY_VERSION);
  });

  it("applies a lower shared-principal limit to token creation", async () => {
    const user = seededUsers[1];
    expect(user).toBeDefined();
    for (let index = 0; index < 5; index += 1) {
      const response = await app.handle(authenticatedRequest("/api/v2/tokens", user!.tokens[index % 2]!, "POST"));
      expect(response.status).toBe(201);
      expect(response.headers.get("x-ratelimit-limit")).toBe("5");
    }

    const throttled = await app.handle(authenticatedRequest("/api/v2/tokens", user!.tokens[0]!, "POST"));
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("x-ratelimit-limit")).toBe("5");
    expect((await throttled.json()).errors[0].title).toBe("Too Many Requests");
  });

  it("applies the lower unauthenticated limit to login and bootstrap independently", async () => {
    const user = seededUsers[2];
    expect(user).toBeDefined();
    const loginRequest = (): Request => new Request("http://localhost/api/v2/users/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.api+json",
        "X-Forwarded-For": "192.0.2.10",
      },
      body: JSON.stringify({
        data: { attributes: { username: user!.username, password: user!.password } },
      }),
    });
    for (let index = 0; index < 5; index += 1) {
      expect((await app.handle(loginRequest())).status).toBe(200);
    }
    const throttledLogin = await app.handle(loginRequest());
    expect(throttledLogin.status).toBe(429);
    expect(throttledLogin.headers.get("x-ratelimit-limit")).toBe("5");

    const bootstrapRequest = (): Request => new Request("http://localhost/admin/initial-admin-user?token=invalid", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "192.0.2.10",
      },
      body: "{}",
    });
    for (let index = 0; index < 5; index += 1) {
      expect((await app.handle(bootstrapRequest())).status).toBe(404);
    }
    expect((await app.handle(bootstrapRequest())).status).toBe(429);
  });

  it("applies the sensitive bucket to OAuth GET and MFA verification/removal endpoints", async () => {
    for (const [index, path] of ["/oauth/authorization", "/oauth/authorization/complete"].entries()) {
      const request = (): Request => new Request(`http://localhost${path}`, {
        headers: { "X-Forwarded-For": `198.51.100.${String(index + 10)}` },
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await app.handle(request())).status).toBe(400);
      }
      const throttled = await app.handle(request());
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get("ratelimit-limit")).toBe("5");
    }

    const user = await seedUser(1);
    const token = user.tokens[0];
    expect(token).toBeDefined();
    const mfaRequest = (method: "POST" | "DELETE", path: string): Request => new Request(`http://localhost${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/vnd.api+json",
      },
      body: JSON.stringify({ data: { type: "mfa", attributes: { code: "000000" } } }),
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await app.handle(mfaRequest("POST", "/api/v2/account/mfa/verify"))).status).toBe(401);
    }
    const throttledVerify = await app.handle(mfaRequest("POST", "/api/v2/account/mfa/verify"));
    expect(throttledVerify.status).toBe(429);
    expect(throttledVerify.headers.get("ratelimit-limit")).toBe("5");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await app.handle(mfaRequest("DELETE", "/api/v2/account/mfa"))).status).toBe(404);
    }
    const throttledRemove = await app.handle(mfaRequest("DELETE", "/api/v2/account/mfa"));
    expect(throttledRemove.status).toBe(429);
    expect(throttledRemove.headers.get("ratelimit-limit")).toBe("5");
  });
});
