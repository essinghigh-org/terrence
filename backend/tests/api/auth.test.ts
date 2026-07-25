import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("TFE API Authentication (Local Auth MVP)", () => {
  beforeAll(async () => {
    // Cannot delete users if there are tokens tied via foreign key, so delete tokens first (or use ON DELETE CASCADE, but for tests just manual clear).
    // In our schema apiTokens references users.id.
    const { apiTokens } = await import("../../src/db/schema");
    await db.delete(apiTokens);
    await db.delete(users);
  });

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
              username: "testuser",
              password: "securepassword",
            },
          },
        }),
      })
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.data.type).toBe("users");
    expect(data.data.attributes.username).toBe("testuser");
    expect(data.data.id).toBeDefined();

    // Verify in DB
    const userInDb = await db.query.users.findFirst({
      where: eq(users.username, "testuser"),
    });
    expect(userInDb).toBeDefined();
    expect(userInDb?.passwordHash).toBeDefined();
    expect(userInDb?.passwordHash).not.toBe("securepassword"); // Should be hashed
  });

  it("should fail to register a duplicate user", async () => {
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
              username: "testuser",
              password: "anotherpassword",
            },
          },
        }),
      })
    );

    expect(response.status).toBe(409); // Conflict
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
              username: "testuser",
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
              username: "testuser",
              password: "securepassword",
            },
          },
        }),
      })
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.data.type).toBe("api-tokens");
    expect(data.data.attributes.token).toBeDefined();

    // The token should work for an authenticated request
    const authResponse = await app.handle(
      new Request("http://localhost/api/v2/account/details", {
        headers: {
          "Authorization": `Bearer ${data.data.attributes.token}`,
        },
      })
    );

    expect(authResponse.status).toBe(200);
    const authData = await authResponse.json();
    expect(authData.data.attributes.username).toBe("testuser");
  });
});
