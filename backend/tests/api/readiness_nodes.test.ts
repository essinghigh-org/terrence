import { describe, expect, test, beforeAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens } from "../../src/db/schema";

describe("Readiness & Nodes API (TFE Parity)", () => {
  let adminToken: string;

  beforeAll(async () => {
    const userId = `usr-${crypto.randomUUID()}`;
    const tokenVal = `test-token-${crypto.randomUUID()}`;

    await db.insert(users).values({
      id: userId,
      username: `admin_${Date.now()}`,
      passwordHash: "hash",
      isSiteAdmin: true,
    });

    await db.insert(apiTokens).values({
      id: `tok-${crypto.randomUUID()}`,
      token: tokenVal,
      userId,
      createdAt: Date.now(),
    });

    adminToken = tokenVal;
  });

  test("GET /api/v1/nodes returns bare string array in data", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/nodes", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.data)).toBe(true);
    expect(typeof json.data[0]).toBe("string");
    expect(json.data[0]).toBe("terrence-node-1");
  });

  test("GET /api/v1/health/readiness returns subsystem health status", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/health/readiness", {
        method: "GET",
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("OK");
    expect(Array.isArray(json.checks)).toBe(true);
  });
});
