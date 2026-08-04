import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import { app } from "../../src/app";
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
  it("shares the 30 requests/second bucket across a user's tokens", async () => {
    const user = seededUsers[0];
    expect(user).toBeDefined();
    for (let index = 0; index < 30; index += 1) {
      const response = await app.handle(authenticatedRequest("/api/v1/ping", user!.tokens[index % 2]!));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-ratelimit-limit")).toBe("30");
    }

    const throttled = await app.handle(authenticatedRequest("/api/v1/ping", user!.tokens[0]!));
    expect(throttled.status).toBe(429);
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
});
