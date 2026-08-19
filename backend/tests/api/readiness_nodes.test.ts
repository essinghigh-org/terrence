import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { systemApiTokens } from "../../src/db/schema";
import { hashSystemApiToken } from "../../src/lib/system-api";

const createdTokenIds: string[] = [];

// The System API rate-limits at one request/second per token (matching the reference format), so
// each test seeds and uses its own system token to avoid 429s.
async function seedSystemToken(): Promise<string> {
  const systemToken = `tfe-system-${crypto.randomUUID()}`;
  const id = `sys-token-${crypto.randomUUID()}`;
  createdTokenIds.push(id);
  await db.insert(systemApiTokens).values({
    id,
    tokenHash: hashSystemApiToken(systemToken),
    description: "readiness parity test",
    expiresAt: Date.now() + 7_200_000,
  });
  return systemToken;
}

describe("Readiness & Nodes API (the reference format Parity)", () => {
  test("GET /api/v1/nodes returns bare string array in data", async () => {
    const systemToken = await seedSystemToken();
    const res = await app.handle(
      new Request("http://localhost/api/v1/nodes", {
        method: "GET",
        headers: { Authorization: `Bearer ${systemToken}` },
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.data)).toBe(true);
    expect(typeof json.data[0]).toBe("string");
    expect(json.data[0]).toBe("terrence-node-1");
  });

  test("GET /api/v1/health/readiness returns subsystem health status", async () => {
    const systemToken = await seedSystemToken();
    const res = await app.handle(
      new Request("http://localhost/api/v1/health/readiness", {
        method: "GET",
        headers: { Authorization: `Bearer ${systemToken}` },
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("OK");
    expect(Array.isArray(json.checks)).toBe(true);
  });

  afterAll(async () => {
    if (createdTokenIds.length > 0) {
      await db.delete(systemApiTokens).where(inArray(systemApiTokens.id, createdTokenIds));
    }
  });
});
