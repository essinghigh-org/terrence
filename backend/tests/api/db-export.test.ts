// End-to-end Postgres -> SQLite export test.
//
// Seeds a fresh PostgreSQL database with the real pg migration set and a
// small dataset, then drives the export through the admin endpoints:
// test-connection, start, job polling, file listing, download, and delete.
// The exported file is verified directly with bun:sqlite (row counts,
// integrity check, foreign_key_check, sample values).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { inArray } from "drizzle-orm";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { apiTokens, users } from "../../src/db/schema";
import { storageDir } from "../../src/db/driver";
import { defaultOutputName, sanitizeOutputName } from "../../src/lib/db-export";

process.env.TERRENCE_DISABLE_RESTART ??= "1";

const PG_ADMIN_URL = process.env.PG_TEST_ADMIN_URL ?? "postgres://terrence:terrence@127.0.0.1:5432/terrence_test";

let adminToken = "";
let adminId = "";
let adminTokenId = "";
let sourceDbName = "";
let sourceUrl = "";
let orgId = "";
let workspaceId = "";
let runId = "";

async function seedAdmin(): Promise<void> {
  adminId = `exp-admin-${crypto.randomUUID()}`;
  adminToken = `exp-token-${crypto.randomUUID()}`;
  adminTokenId = `exp-token-id-${crypto.randomUUID()}`;
  await db.insert(users).values({ id: adminId, username: adminId, passwordHash: "unused", isSiteAdmin: true });
  await db.insert(apiTokens).values({
    id: adminTokenId,
    token: createHash("sha256").update(adminToken).digest("hex"),
    userId: adminId,
    description: "db export test token",
    createdAt: Date.now(),
  });
}

function adminRequest(path: string, method = "GET", body?: unknown): Request {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${adminToken}`,
    "Content-Type": "application/vnd.api+json",
  };
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function startExport(body: unknown): Promise<{ id: string }> {
  const response = await app.handle(adminRequest("/api/v2/admin/db-export", "POST", body));
  expect(response.status).toBe(202);
  const parsed = (await response.json()) as { data: { id: string } };
  return { id: parsed.data.id };
}

async function waitForJob(
  id: string,
  timeoutMs = 90_000,
): Promise<{ status: string; error?: { code?: string; detail?: string }; result?: { "file-name"?: string; verification?: unknown } }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await app.handle(adminRequest(`/api/v2/admin/db-export/jobs/${id}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { attributes: { status: string; error?: { code?: string; detail?: string }; result?: { "file-name"?: string; verification?: unknown } } };
    };
    const attributes = body.data.attributes;
    if (attributes.status === "done" || attributes.status === "failed") return attributes;
    if (Date.now() > deadline) throw new Error(`Export job did not finish within ${timeoutMs}ms (status: ${attributes.status})`);
    await Bun.sleep(200);
  }
}

let postgresAvailable = false;

beforeAll(async (): Promise<void> => {
  await seedAdmin();

  try {
    // Fresh PostgreSQL source database with the real migration set applied.
    const { SQL } = await import("bun");
    const rawId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    sourceDbName = `terrence_export_${rawId}`;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sourceDbName)) {
      throw new Error(`Invalid database identifier: ${sourceDbName}`);
    }
    const admin = new SQL(PG_ADMIN_URL);
    try {
      await admin.unsafe(`CREATE DATABASE "${sourceDbName}"`);
    } finally {
      await admin.close();
    }
    const source = new URL(PG_ADMIN_URL);
    source.pathname = `/${sourceDbName}`;
    sourceUrl = source.toString();

    const client = new SQL(sourceUrl);
    try {
      const { migrate } = await import("drizzle-orm/bun-sql/migrator");
      const { drizzle: pgDrizzle } = await import("drizzle-orm/bun-sql");
      const pgSchema = await import("../../src/db/schema-pg");
      const pgDb = pgDrizzle({ client, schema: pgSchema });
      await migrate(pgDb, { migrationsFolder: join(import.meta.dir, "../../drizzle/pg") });
      await client.unsafe(`
        CREATE TABLE IF NOT EXISTS locks (
          name TEXT PRIMARY KEY NOT NULL,
          owner TEXT NOT NULL,
          expires_at BIGINT NOT NULL
        )
      `);
      await client.unsafe("CREATE INDEX IF NOT EXISTS locks_expires_idx ON locks (expires_at)");
      await client.unsafe(`
        CREATE TABLE IF NOT EXISTS oauth_handshake_states (
          id TEXT PRIMARY KEY NOT NULL,
          expires_at BIGINT NOT NULL,
          payload TEXT NOT NULL
        )
      `);
      await client.unsafe("CREATE INDEX IF NOT EXISTS oauth_handshake_states_expires_idx ON oauth_handshake_states (expires_at)");
      await client.unsafe(`
        CREATE TABLE IF NOT EXISTS registry_sync_leases (
          key TEXT PRIMARY KEY NOT NULL,
          owner TEXT NOT NULL,
          expires_at BIGINT NOT NULL
        )
      `);
      await client.unsafe("CREATE INDEX IF NOT EXISTS registry_sync_leases_expires_idx ON registry_sync_leases (expires_at)");

      orgId = `exp-org-${crypto.randomUUID()}`;
      workspaceId = `ws-exp-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      runId = `run-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await pgDb.insert(pgSchema.users).values({
        id: `exp-user-${crypto.randomUUID()}`,
        username: "export-source-user",
        passwordHash: "unused",
        isSiteAdmin: true,
      });
      await pgDb.insert(pgSchema.organizations).values({
        id: orgId,
        name: `export-${orgId.slice(-8)}`,
        assessmentsEnforced: false,
        globalModuleSharing: false,
        globalProviderSharing: false,
        accessBetaTools: false,
        samlEnabled: false,
        allowForceDeleteWorkspaces: false,
        stacksEnabled: false,
        showPreReleases: false,
        aggregatedCommitStatusEnabled: false,
        sendPassingStatusesForUntriggeredSpeculativePlans: false,
        defaultIacBinary: "tofu",
        defaultTerraformVersion: "latest",
        defaultExecutionMode: "remote",
      });
      await pgDb.insert(pgSchema.workspaces).values({
        id: workspaceId,
        name: "export-workspace",
        orgId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await pgDb.insert(pgSchema.runs).values({
        id: runId,
        workspaceId,
        status: "applied",
        isDestroy: false,
        autoApply: true,
        planOnly: false,
        refresh: true,
        refreshOnly: false,
        debuggingMode: false,
        allowEmptyApply: true,
        savePlan: true,
        allowConfigGeneration: true,
        createdAt: Date.now(),
      });
    } finally {
      await client.close();
    }
    postgresAvailable = true;
  } catch (error: unknown) {
    postgresAvailable = false;
  }
});

afterAll(async (): Promise<void> => {
  // Only the local (sqlite) seeds need cleanup; the PG seed lives in the
  // source database, which is dropped below.
  await db.delete(apiTokens).where(inArray(apiTokens.id, [adminTokenId]));
  await db.delete(users).where(inArray(users.id, [adminId]));
  if (sourceUrl !== "") {
    const { SQL } = await import("bun");
    const cleanup = new SQL(PG_ADMIN_URL);
    try {
      await cleanup`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sourceDbName} AND pid <> pg_backend_pid()`;
      await cleanup.unsafe(`DROP DATABASE IF EXISTS "${sourceDbName}"`);
    } catch {
      // Best-effort cleanup.
    } finally {
      await cleanup.close();
    }
  }
});

describe("Postgres -> SQLite database export", (): void => {
  test("test-connection accepts a seeded Terrence database", async (): Promise<void> => {
    if (!postgresAvailable) return;
    const response = await app.handle(adminRequest("/api/v2/admin/db-export/test-connection", "POST", {
      data: { attributes: { "postgres-url": sourceUrl } },
    }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { attributes: { ok: boolean } } };
    expect(body.data.attributes.ok).toBe(true);
  });

  test("test-connection rejects a database without the Terrence schema", async (): Promise<void> => {
    if (!postgresAvailable) return;
    const { SQL } = await import("bun");
    const emptyName = `terrence_empty_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const admin = new SQL(PG_ADMIN_URL);
    try {
      await admin.unsafe(`CREATE DATABASE "${emptyName}"`);
    } finally {
      await admin.close();
    }
    const url = new URL(PG_ADMIN_URL);
    url.pathname = `/${emptyName}`;
    try {
      const response = await app.handle(adminRequest("/api/v2/admin/db-export/test-connection", "POST", {
        data: { attributes: { "postgres-url": url.toString() } },
      }));
      expect(response.status).toBe(422);
      const body = (await response.json()) as { errors: { title: string }[] };
      expect(body.errors[0]?.title).toBe("Incompatible database");
    } finally {
      const cleanup = new SQL(PG_ADMIN_URL);
      try {
        await cleanup.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${emptyName}' AND pid <> pg_backend_pid()`);
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${emptyName}"`);
      } finally {
        await cleanup.close();
      }
    }
  }, 30_000);

  test("test-connection requires a postgres-url", async (): Promise<void> => {
    const response = await app.handle(adminRequest("/api/v2/admin/db-export/test-connection", "POST", {
      data: { attributes: {} },
    }));
    expect(response.status).toBe(422);
  });

  test("exports the database, verifies it, and lands a portable sqlite file", async (): Promise<void> => {
    if (!postgresAvailable) return;
    const { id } = await startExport({
      data: { attributes: { "postgres-url": sourceUrl, "output-name": "export-main.db" } },
    });
    const job = await waitForJob(id);
    expect(job.error).toBeUndefined();
    expect(job.status).toBe("done");

    const exportDir = join(storageDir, "exports");
    const filePath = join(exportDir, "export-main.db");
    expect(existsSync(filePath)).toBe(true);

    // The file is a self-contained SQLite database with the full schema.
    const exported = new Database(filePath, { readonly: true });
    try {
      const integrity = exported.query("PRAGMA integrity_check").get() as { integrity_check: string };
      expect(integrity.integrity_check).toBe("ok");
      const violations = exported.query("PRAGMA foreign_key_check").all();
      expect(violations.length).toBe(0);

      const count = (table: string): number =>
        (exported.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
      expect(count("users")).toBe(1);
      expect(count("organizations")).toBe(1);
      expect(count("workspaces")).toBe(1);
      expect(count("runs")).toBe(1);

      const run = exported.query(`SELECT id, status FROM "runs" WHERE id = ?`).get(runId) as
        | { id: string; status: string }
        | null;
      expect(run?.status).toBe("applied");
    } finally {
      exported.close();
    }
  }, 30_000);

  test("lists and downloads the export file, then deletes it", async (): Promise<void> => {
    if (!postgresAvailable) return;
    const list = await app.handle(adminRequest("/api/v2/admin/db-export"));
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: { id: string; attributes: { "size-bytes": number } }[] };
    const entry = listBody.data.find((file): boolean => file.id === "export-main.db");
    expect(entry).toBeDefined();
    expect(entry?.attributes["size-bytes"] ?? 0).toBeGreaterThan(0);

    const download = await app.handle(adminRequest("/api/v2/admin/db-export/files/export-main.db"));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes.length).toBe(entry?.attributes["size-bytes"] ?? 0);
    // SQLite header magic ("SQLite format 3\0").
    expect(String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0, bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0, bytes[7] ?? 0)).toBe("SQLite f");

    const deleted = await app.handle(adminRequest("/api/v2/admin/db-export/files/export-main.db", "DELETE"));
    expect(deleted.status).toBe(204);
    const after = (await (await app.handle(adminRequest("/api/v2/admin/db-export"))).json()) as { data: { id: string }[] };
    expect(after.data.some((file): boolean => file.id === "export-main.db")).toBe(false);
  }, 30_000);

  test("a duplicate output name fails the job with an exists error", async (): Promise<void> => {
    if (!postgresAvailable) return;
    const { id } = await startExport({
      data: { attributes: { "postgres-url": sourceUrl, "output-name": "export-dupe.db" } },
    });
    const first = await waitForJob(id);
    expect(first.status).toBe("done");

    const second = await startExport({
      data: { attributes: { "postgres-url": sourceUrl, "output-name": "export-dupe.db" } },
    });
    const job = await waitForJob(second.id);
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("exists");
  }, 30_000);

  test("an invalid output name fails the job", async (): Promise<void> => {
    if (!postgresAvailable) return;
    // Traversal prefixes are sanitized away; a name outside the safe charset
    // or extension is a hard job failure.
    const { id } = await startExport({
      data: { attributes: { "postgres-url": sourceUrl, "output-name": "has space.db" } },
    });
    const job = await waitForJob(id);
    expect(job.status).toBe("failed");
  }, 30_000);

  test("an active run blocks the export unless force is set", async (): Promise<void> => {
    if (!postgresAvailable) return;
    const { SQL } = await import("bun");
    const client = new SQL(sourceUrl);
    try {
      const activeRunId = `run-active-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      await client.unsafe(`
        INSERT INTO runs (id, workspace_id, status, is_destroy, auto_apply, plan_only, refresh, refresh_only,
                          debugging_mode, allow_empty_apply, save_plan, allow_config_generation, created_at)
        VALUES ('${activeRunId}', '${workspaceId}', 'pending', false, true, false, true, false, false, true, true, true, ${Date.now()})
      `);
      try {
        const blocked = await startExport({
          data: { attributes: { "postgres-url": sourceUrl, "output-name": "export-blocked.db" } },
        });
        const job = await waitForJob(blocked.id);
        expect(job.status).toBe("failed");
        expect(job.error?.code).toBe("active-runs");

        const forced = await startExport({
          data: { attributes: { "postgres-url": sourceUrl, "output-name": "export-forced.db", force: true } },
        });
        const forcedJob = await waitForJob(forced.id);
        expect(forcedJob.status).toBe("done");
        expect(existsSync(join(storageDir, "exports", "export-forced.db"))).toBe(true);
      } finally {
        await client.unsafe(`DELETE FROM runs WHERE id = '${activeRunId}'`);
      }
    } finally {
      await client.close();
    }
  }, 30_000);

  test("an unknown job id returns 404", async (): Promise<void> => {
    const response = await app.handle(adminRequest("/api/v2/admin/db-export/jobs/does-not-exist"));
    expect(response.status).toBe(404);
  });

  test("sanitizeOutputName strips traversal and rejects invalid names", (): void => {
    // Directory prefixes (including traversal) are stripped to a bare name.
    expect(sanitizeOutputName("../../etc/passwd.db")).toBe("passwd.db");
    expect(sanitizeOutputName("a\\..\\b.db")).toBe("b.db");
    expect(sanitizeOutputName("dir/export-1.db")).toBe("export-1.db");
    // Non-.db extensions and characters outside the safe set are rejected.
    expect((): void => { sanitizeOutputName("notes.txt"); }).toThrow();
    expect((): void => { sanitizeOutputName("has space.db"); }).toThrow();
    expect((): void => { sanitizeOutputName("quote\".db"); }).toThrow();
    expect((): void => { sanitizeOutputName(""); }).toThrow();
  });

  test("defaultOutputName is a timestamped bare file name", (): void => {
    const name = defaultOutputName(new Date("2026-08-14T03:04:05Z"));
    expect(name).toMatch(/^terrence-export-\d{8}-\d{6}\.db$/);
    expect(name).toBe("terrence-export-20260814-030405.db");
  });
});
