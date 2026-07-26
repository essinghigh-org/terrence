import { describe, expect, it, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens, organizationMemberships } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("TFE API Authentication (Local Auth MVP)", () => {
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

    const tokenInDb = await db.query.apiTokens.findFirst({
      where: eq(apiTokens.token, data.data.attributes.token),
    });
    expect(tokenInDb).toBeDefined();
  });
});
