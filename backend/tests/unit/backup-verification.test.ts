import { afterAll, describe, expect, it } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createCipheriv, randomBytes } from "node:crypto";
import * as schema from "../../src/db/schema-sqlite";
import { storageDir } from "../../src/db/driver";
import {
  BACKUP_STATUS_FILE,
  createBackupManifestForSource,
  readBackupStatus,
  runRestoreRehearsal,
  verifyBackupIntegrity,
} from "../../src/lib/backup-verification";

describe("backup verification and restore rehearsal", () => {
  let work: string | undefined;

  afterAll(async () => {
    if (work !== undefined) await rm(work, { recursive: true, force: true });
    await rm(join(storageDir, BACKUP_STATUS_FILE), { force: true });
  });

  it("creates a checksummed manifest and verifies a copied SQLite backup", async () => {
    work = await mkdtemp(join(tmpdir(), "terrence-backup-test-"));
    const backupStorage = join(work, "storage");
    await mkdir(backupStorage, { recursive: true });
    const backupDatabase = join(backupStorage, "terrence.db");
    // Build a complete SQLite fixture independently of the shared application
    // DB, which can be PostgreSQL and contains intentionally broken test data.
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update("backup-secret", "utf8"), cipher.final()]);
    const encrypted = ["enc", "v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
    await writeFile(join(backupStorage, ".encryption-key"), key.toString("base64"), { mode: 0o600 });
    const archivePath = join(backupStorage, "configuration.tar.gz");
    await writeFile(archivePath, "backup archive fixture", { mode: 0o600 });
    const sqlite = new Database(backupDatabase, { create: true });
    try {
      const fixture = drizzle(sqlite, { schema });
      migrate(fixture, { migrationsFolder: join(import.meta.dir, "../../drizzle") });
      await fixture.insert(schema.organizations).values({ id: "org-backup", name: "backup" });
      await fixture.insert(schema.workspaces).values({ id: "ws-backup", orgId: "org-backup", name: "backup" });
      await fixture.insert(schema.configurationVersions).values({ id: "cv-backup", workspaceId: "ws-backup", status: "uploaded", archivePath });
      await fixture.insert(schema.workspaceVariables).values({ id: "var-backup", workspaceId: "ws-backup", key: "secret", value: "", valueEncrypted: encrypted, sensitive: true });
    } finally {
      sqlite.close();
    }
    const created = await createBackupManifestForSource(
      { sourcePath: backupStorage, storagePath: backupStorage, databasePath: backupDatabase },
      { outputDirectory: work },
    );
    expect(created.manifest.version).toBe(1);
    expect(created.manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(created.manifest.database.driver).toBe("sqlite");
    expect(created.manifest.database.tables["users"]).toBeGreaterThanOrEqual(0);
    expect(created.manifest.storage.fileCount).toBeGreaterThan(0);
    expect(JSON.stringify(created.manifest)).not.toContain("ENCRYPTION_PASSWORD");

    const report = await verifyBackupIntegrity({ sourcePath: work });
    expect(report.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checks.find((check) => check.name === "database-integrity")?.status).toBe("pass");
    expect(report.checks.find((check) => check.name === "key-identifiers")?.status).toBe("pass");
    expect(report.checks.find((check) => check.name === "encrypted-records")?.detail).toBe("1 selected encrypted record(s) decrypted");
    expect(report.checks.find((check) => check.name === "artifact-references")?.detail).toBe("1 referenced artifact(s) are readable");

    // A colocated SQLite file is a supported source form as long as its
    // manifest is beside it.
    await cp(join(work, "terrence-backup-manifest.json"), join(backupStorage, "terrence-backup-manifest.json"));
    const fileReport = await verifyBackupIntegrity({ sourcePath: backupDatabase });
    expect(fileReport.passed).toBe(true);
  });

  it("runs the rehearsal on a disposable copy and records the verified restore date", async () => {
    if (work === undefined) throw new Error("backup fixture was not created");
    const rehearsal = await runRestoreRehearsal({
      source: { sourcePath: work },
      requireCli: false,
    });
    expect(rehearsal.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(rehearsal.passed).toBe(true);
    expect(rehearsal.checks.find((check) => check.name === "schema-migration")?.status).toBe("pass");
    expect(rehearsal.lastVerifiedRestoreAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const status = await readBackupStatus();
    expect(status.lastVerifiedRestoreAt).toBe(rehearsal.lastVerifiedRestoreAt);
    expect(status.lastRehearsalId).toBe(rehearsal.id);

    // Database and storage can be supplied as separate operator paths; the
    // rehearsal must copy both into its private staging directory.
    const externalRoot = await mkdtemp(join(tmpdir(), "terrence-backup-source-"));
    const externalStorage = join(externalRoot, "storage");
    const manifestRoot = join(externalRoot, "manifest");
    await cp(join(work, "storage"), externalStorage, { recursive: true, force: true, preserveTimestamps: true });
    await mkdir(manifestRoot, { recursive: true });
    await cp(join(work, "terrence-backup-manifest.json"), join(manifestRoot, "terrence-backup-manifest.json"));
    const separate = await runRestoreRehearsal({
      source: { sourcePath: manifestRoot, storagePath: externalStorage, databasePath: join(externalStorage, "terrence.db") },
      requireCli: false,
    });
    expect(separate.passed).toBe(true);
    await rm(externalRoot, { recursive: true, force: true });
  });

  it("rejects a changed artifact before rehearsal", async () => {
    if (work === undefined) throw new Error("backup fixture was not created");
    const manifest = JSON.parse(await readFile(join(work, "terrence-backup-manifest.json"), "utf8")) as { storage: { files: readonly { path: string }[] } };
    const first = manifest.storage.files[0];
    if (first === undefined) throw new Error("backup fixture has no files");
    await writeFile(join(work, "storage", first.path), "tampered", { mode: 0o600 });
    const report = await verifyBackupIntegrity({ sourcePath: work });
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.name === "storage-digests")?.status).toBe("fail");

    await writeFile(join(work, "storage", "terrence.db"), "tampered database", { mode: 0o600 });
    const databaseReport = await verifyBackupIntegrity({ sourcePath: work });
    expect(databaseReport.checks.find((check) => check.name === "database-digest")?.status).toBe("fail");
  });
});
