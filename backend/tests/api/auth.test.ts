import { describe, expect, it } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { hashAuthenticationToken } from "../../src/lib/token-service";

describe("the reference format API Authentication (Local Auth MVP)", () => {
  const testUser = `auth_user_${Date.now()}`;

  it("should register a new user successfully", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "users",
            attributes: {
              username: testUser,
              password: "securepassword",
            },
          },
        }),
      })
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.data.type).toBe("users");
    expect(data.data.attributes.username).toBe(testUser);
    expect(data.data.id).toBeDefined();

    const userInDb = await db.query.users.findFirst({
      where: eq(users.username, testUser),
    });
    expect(userInDb).toBeDefined();
    expect(userInDb?.passwordHash).toBeDefined();
  });

  it("should fail to register a duplicate user", async () => {
    const dupUser = `dup_user_${Date.now()}`;
    const firstRes = await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { type: "users", attributes: { username: dupUser, password: "securepassword" } },
        }),
      })
    );
    expect(firstRes.status).toBe(201);

    const secondRes = await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: { type: "users", attributes: { username: dupUser, password: "anotherpassword" } },
        }),
      })
    );

    expect(secondRes.status).toBe(409);
  });

  it("should fail to login with incorrect password", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            attributes: {
              username: testUser,
              password: "wrongpassword",
            },
          },
        }),
      })
    );

    expect(response.status).toBe(401);
  });

  it("should login and return an API token successfully", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            attributes: {
              username: testUser,
              password: "securepassword",
            },
          },
        }),
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data.type).toBe("tokens");
    expect(data.data.attributes.token).toBeDefined();

    // Token is stored hashed in DB; verify lookup works via auth plugin
    const rawToken = data.data.attributes.token;
    const tokenHash = hashAuthenticationToken(rawToken as string);
    const tokenInDb = await db.query.apiTokens.findFirst({
      where: eq(apiTokens.token, tokenHash),
    });
    expect(tokenInDb).toBeDefined();
  });

  it("does not issue credentials to suspended accounts", async () => {
    const blockedId = `auth-blocked-${crypto.randomUUID()}`;
    const blockedPassword = "blocked-password-123";
    const passwordHash = await Bun.password.hash(blockedPassword, { algorithm: "bcrypt", cost: 10 });
    await db.insert(users).values({ id: blockedId, username: blockedId, passwordHash, isSuspended: true });
    try {
      const response = await app.handle(new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({ data: { attributes: { username: blockedId, password: blockedPassword } } }),
      }));
      expect(response.status).toBe(401);
      expect((await db.query.apiTokens.findMany({ where: eq(apiTokens.userId, blockedId) })).length).toBe(0);
    } finally {
      await db.delete(users).where(eq(users.id, blockedId));
    }
  });
});
