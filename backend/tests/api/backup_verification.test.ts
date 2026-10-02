import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, backupRehearsalJobs, users } from "../../src/db/schema";
import * as schema from "../../src/db/schema-sqlite";
import { hashAuthenticationToken } from "../../src/lib/token-service";
import { createBackupManifestForSource } from "../../src/lib/backup-verification";

/** Minimal self-contained backup the rehearsal API can consume. */
const makeBackupSource = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "terrence-rehearsal-"));
  const storage = join(root, "storage");
  await mkdir(storage, { recursive: true });
  await writeFile(join(storage, ".encryption-key"), randomBytes(32).toString("base64"), { mode: 0o600 });
  const sqlite = new Database(join(storage, "terrence.db"), { create: true });
  try {
    const fixture = drizzle(sqlite, { schema });
    migrate(fixture, { migrationsFolder: join(import.meta.dir, "../../drizzle") });
    await fixture.insert(schema.organizations).values({ id: "org-rehearsal", name: "rehearsal" });
  } finally {
    sqlite.close();
  }
  await createBackupManifestForSource({ sourcePath: root });
  return root;
};

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

  const request = (path: string, token = adminToken, method = "GET", body?: unknown): Promise<Response> =>
    app.handle(
      new Request(`http://terrence.test${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/vnd.api+json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  test("creates an admin-only manifest without exposing key values and reports restore state", async () => {
    expect((await request("/api/v2/admin/backups/status", memberToken)).status).toBe(404);
    const created = await request("/api/v2/admin/backups/manifests", adminToken, "POST", {
      data: { attributes: { persist: false } },
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      data: {
        attributes: {
          manifest: { version: number; manifestSha256: string; keys: unknown };
          "manifest-path": string | null;
        };
      };
    };
    expect(body.data.attributes.manifest.version).toBe(1);
    expect(body.data.attributes.manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain(process.env["ENCRYPTION_PASSWORD"] ?? "definitely-not-a-password");
    expect(body.data.attributes["manifest-path"]).toBeNull();

    const status = await request("/api/v2/admin/backups/status");
    expect(status.status).toBe(200);
    expect((await status.json()).data.attributes["last-verified-restore-at"]).toBeNull();
  });

  test("does not expose a live restore endpoint and validates rehearsal input", async () => {
    expect(
      (await request("/api/v2/admin/backups/restore", adminToken, "POST", { data: { attributes: {} } })).status,
    ).toBe(404);
    const response = await request("/api/v2/admin/backups/restore-rehearsals", adminToken, "POST", {
      data: { attributes: {} },
    });
    expect(response.status).toBe(422);
  });

  test("rehearsal status and admission are shared durable state, not process-local", async () => {
    const source = await makeBackupSource();
    // A rehearsal accepted (and still owned) by another replica. The API must
    // refuse admission and answer status for it from shared storage.
    const foreignId = `rehearsal-foreign-${suffix}`;
    await db.insert(backupRehearsalJobs).values({
      id: foreignId,
      status: "running",
      startedAt: Date.now(),
    });
    try {
      const admission = await request("/api/v2/admin/backups/restore-rehearsals", adminToken, "POST", {
        data: { attributes: { "backup-path": source } },
      });
      expect(admission.status).toBe(409);

      const polled = await request(`/api/v2/admin/backups/restore-rehearsals/${foreignId}`);
      expect(polled.status).toBe(200);
      const polledBody = (await polled.json()) as { data: { attributes: { status: string } } };
      expect(polledBody.data.attributes.status).toBe("running");

      const missing = await request("/api/v2/admin/backups/restore-rehearsals/does-not-exist");
      expect(missing.status).toBe(404);

      // An abandoned running row is reaped as interrupted rather than blocking
      // admission forever after its owner process disappeared.
      await db
        .update(backupRehearsalJobs)
        .set({ startedAt: Date.now() - 2 * 60 * 60 * 1000 })
        .where(eq(backupRehearsalJobs.id, foreignId));
      const stale = await request(`/api/v2/admin/backups/restore-rehearsals/${foreignId}`);
      expect(stale.status).toBe(200);
      const staleBody = (await stale.json()) as { data: { attributes: { status: string } } };
      expect(staleBody.data.attributes.status).toBe("interrupted");

      const accepted = await request("/api/v2/admin/backups/restore-rehearsals", adminToken, "POST", {
        data: { attributes: { "backup-path": source } },
      });
      expect(accepted.status).toBe(202);
      const acceptedBody = (await accepted.json()) as { data: { id: string } };
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const row = await db.query.backupRehearsalJobs.findFirst({
          where: eq(backupRehearsalJobs.id, acceptedBody.data.id),
        });
        if (row?.status !== "running") break;
        await Bun.sleep(50);
      }
      const settled = await db.query.backupRehearsalJobs.findFirst({
        where: eq(backupRehearsalJobs.id, acceptedBody.data.id),
      });
      expect(settled?.status).not.toBe("running");
      await db.delete(backupRehearsalJobs).where(eq(backupRehearsalJobs.id, acceptedBody.data.id));
    } finally {
      await db.delete(backupRehearsalJobs).where(eq(backupRehearsalJobs.id, foreignId));
      await rm(source, { recursive: true, force: true });
    }
  });
});
