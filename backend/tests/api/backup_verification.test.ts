import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, users } from "../../src/db/schema";
import { hashAuthenticationToken } from "../../src/lib/token-service";

describe("admin backup verification API", () => {
  const suffix = crypto.randomUUID();
  const adminId = `backup-admin-${suffix}`;
  const memberId = `backup-member-${suffix}`;
  const adminToken = `backup-admin-token-${suffix}`;
  const memberToken = `backup-member-token-${suffix}`;

  beforeAll(async () => {
    await db.insert(users).values([
      { id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true },
      { id: memberId, username: memberId, passwordHash: "unused", isSiteAdmin: false },
    ]);
    await db.insert(apiTokens).values([
      { id: `backup-at-${suffix}`, userId: adminId, token: hashAuthenticationToken(adminToken) },
      { id: `backup-mt-${suffix}`, userId: memberId, token: hashAuthenticationToken(memberToken) },
    ]);
  });

  afterAll(async () => {
    await db.delete(apiTokens).where(inArray(apiTokens.userId, [adminId, memberId]));
    await db.delete(users).where(inArray(users.id, [adminId, memberId]));
  });

  const request = (path: string, token = adminToken, method = "GET", body?: unknown): Promise<Response> => app.handle(new Request(`http://terrence.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

  test("creates an admin-only manifest without exposing key values and reports restore state", async () => {
    expect((await request("/api/v2/admin/backups/status", memberToken)).status).toBe(404);
    const created = await request("/api/v2/admin/backups/manifests", adminToken, "POST", {
      data: { attributes: { persist: false } },
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { data: { attributes: { manifest: { version: number; manifestSha256: string; keys: unknown }; "manifest-path": string | null } } };
    expect(body.data.attributes.manifest.version).toBe(1);
    expect(body.data.attributes.manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain(process.env["ENCRYPTION_PASSWORD"] ?? "definitely-not-a-password");
    expect(body.data.attributes["manifest-path"]).toBeNull();

    const status = await request("/api/v2/admin/backups/status");
    expect(status.status).toBe(200);
    expect((await status.json()).data.attributes["last-verified-restore-at"]).toBeNull();
  });

  test("does not expose a live restore endpoint and validates rehearsal input", async () => {
    expect((await request("/api/v2/admin/backups/restore", adminToken, "POST", { data: { attributes: {} } })).status).toBe(404);
    const response = await request("/api/v2/admin/backups/restore-rehearsals", adminToken, "POST", { data: { attributes: {} } });
    expect(response.status).toBe(422);
  });
});
