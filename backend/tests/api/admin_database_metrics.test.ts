import { createHash } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { users, apiTokens } from "../../src/db/schema";
import { inArray } from "drizzle-orm";

describe("admin database metrics (kanban 4.18)", () => {
  const suffix = Date.now().toString(36);
  const adminId = `dbm-admin-${suffix}`;
  const userId = `dbm-user-${suffix}`;
  const adminToken = `dbm-admin-token-${suffix}`;
  const userToken = `dbm-user-token-${suffix}`;
  const adminTokenId = crypto.randomUUID();
  const userTokenId = crypto.randomUUID();

  const request = (token: string): Promise<Response> =>
    app.handle(new Request("http://terrence.test/api/v2/admin/database-metrics", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      body: null,
    }));

  beforeAll(async () => {
    await db.insert(users).values([
      { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
      { id: userId, username: userId, passwordHash: "unused", isSiteAdmin: false },
    ]);
    await db.insert(apiTokens).values([
      { id: adminTokenId, token: createHash("sha256").update(adminToken).digest("hex"), userId: adminId },
      { id: userTokenId, token: createHash("sha256").update(userToken).digest("hex"), userId },
    ]);
  });

  afterAll(async () => {
    // Scoped teardown: only this suite's tokens/users, never shared tables.
    await db.delete(apiTokens).where(inArray(apiTokens.id, [adminTokenId, userTokenId]));
    await db.delete(users).where(inArray(users.id, [adminId, userId]));
  });

  it("serves database size metrics to site admins", async () => {
    const res = await request(adminToken);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { sizeBytes: number; walSizeBytes: number | null; journalMode: string; pageSize: number; pageCount: number } };
    expect(body.data.sizeBytes).toBeGreaterThan(0);
    // PostgreSQL has no WAL sidecar to fold (WAL is server-side), so
    // walSizeBytes is null there by design; SQLite reports the -wal size.
    if ((process.env.DATABASE_URL ?? "").startsWith("postgres")) {
      expect(body.data.walSizeBytes).toBeNull();
    } else {
      expect(typeof body.data.walSizeBytes).toBe("number");
    }
    expect(body.data.journalMode).toBe("wal");
    expect(body.data.pageSize).toBeGreaterThanOrEqual(512);
    expect(body.data.pageCount).toBeGreaterThan(0);
  });

  it("rejects non-admin users", async () => {
    const res = await request(userToken);
    expect(res.status).toBe(404);
  });
});