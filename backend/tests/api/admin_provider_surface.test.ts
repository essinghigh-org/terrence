import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll, mock } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens } from "../../src/db/schema";

const originalFetch = globalThis.fetch;
const originalCacheFile = process.env.TERRENCE_VERSION_CACHE_FILE;

describe("admin provider surface (kanban 11.18)", () => {
  const suffix = Date.now().toString(36);
  const adminId = `surface-admin-${suffix}`;
  const userId = `surface-user-${suffix}`;
  const adminToken = `surface-admin-token-${suffix}`;

  const request = (token: string, method = "GET"): Promise<Response> =>
    app.handle(new Request("http://terrence.test/api/v2/admin/provider-surface", {
      method,
      headers: { Authorization: `Bearer ${token}` },
      body: null,
    }));

  beforeAll(async () => {
    // The freshness lookup is cached on disk; point it at a temp file and
    // stub the GitHub call so the response is deterministic in tests.
    process.env.TERRENCE_VERSION_CACHE_FILE = join(tmpdir(), `surface-cache-${suffix}.json`);
    globalThis.fetch = mock(async (): Promise<Response> =>
      new Response(JSON.stringify({ tag_name: "v0.80.0" }), { status: 200 })) as unknown as typeof fetch;

    await db.insert(users).values([
      { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
      { id: userId, username: userId, passwordHash: "unused", isSiteAdmin: false },
    ]);
    await db.insert(apiTokens).values([
      { id: crypto.randomUUID(), token: createHash("sha256").update(adminToken).digest("hex"), userId: adminId },
      { id: crypto.randomUUID(), token: createHash("sha256").update(`surface-user-token-${suffix}`).digest("hex"), userId },
    ]);
  });

  afterAll(async () => {
    await db.delete(apiTokens);
    await db.delete(users);
    globalThis.fetch = originalFetch;
    if (originalCacheFile === undefined) delete process.env.TERRENCE_VERSION_CACHE_FILE;
    else process.env.TERRENCE_VERSION_CACHE_FILE = originalCacheFile;
    rmSync(join(tmpdir(), `surface-cache-${suffix}.json`), { force: true });
  });

  it("serves the provider surface catalog to site admins", async () => {
    const res = await request(adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { provider?: string; resources?: unknown[]; resources_covered?: number; "latest-available"?: string | null } };
    expect(typeof body.data.provider).toBe("string");
    expect(Array.isArray(body.data.resources)).toBe(true);
    expect(body.data.resources_covered).toBeGreaterThan(0);
    expect(body.data["latest-available"]).toBe("0.80.0");
  });

  it("rejects non-admin users", async () => {
    const res = await request(`surface-user-token-${suffix}`);
    expect(res.status).toBe(403);
  });
});