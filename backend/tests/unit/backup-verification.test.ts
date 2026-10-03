import { afterAll, describe, expect, it } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createCipheriv, randomBytes } from "node:crypto";
import * as schema from "../../src/db/schema-sqlite";
import { storageDir } from "../../src/db/driver";
import { isPostgres } from "../../src/db";
import { drizzle as postgresDrizzle } from "drizzle-orm/bun-sql";
import { migrate as migratePostgres } from "drizzle-orm/bun-sql/migrator";

async function createTar(source: string, archive: string, members: readonly string[]): Promise<void> {
  const proc = Bun.spawn(["tar", "-cf", archive, "-C", source, ...members], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr || "tar failed");
}

function extractionDirectories(): Promise<string[]> {
  return readdir(tmpdir()).then((entries) =>
    entries.filter((entry) => entry.startsWith("terrence-backup-source-")).sort(),
  );
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

import {
  BACKUP_STATUS_FILE,
  createBackupManifestForSource,
  readBackupStatus,
  runRestoreRehearsal,
  verifyBackupIntegrity,
} from "../../src/lib/backup-verification";

const backupStatusPath = join(storageDir, BACKUP_STATUS_FILE);
const originalBackupStatus = (await Bun.file(backupStatusPath).exists()) ? await readFile(backupStatusPath) : null;

async function restoreBackupStatus(): Promise<void> {
  if (originalBackupStatus === null) await rm(backupStatusPath, { force: true });
  else await writeFile(backupStatusPath, originalBackupStatus, { mode: 0o600 });
}

describe("backup verification and restore rehearsal", () => {
  let work: string | undefined;

  afterAll(async () => {
    if (work !== undefined) await rm(work, { recursive: true, force: true });
    await restoreBackupStatus();
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
    const encrypted = [
      "enc",
      "v1",
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      ciphertext.toString("base64"),
    ].join(":");
    await writeFile(join(backupStorage, ".encryption-key"), key.toString("base64"), { mode: 0o600 });
    const archivePath = join(backupStorage, "configuration.tar.gz");
    await writeFile(archivePath, "backup archive fixture", { mode: 0o600 });
    const sqlite = new Database(backupDatabase, { create: true });
    try {
      const fixture = drizzle(sqlite, { schema });
      migrate(fixture, { migrationsFolder: join(import.meta.dir, "../../drizzle") });
      await fixture.insert(schema.organizations).values({ id: "org-backup", name: "backup" });
      await fixture.insert(schema.workspaces).values({ id: "ws-backup", orgId: "org-backup", name: "backup" });
      await fixture
        .insert(schema.configurationVersions)
        .values({ id: "cv-backup", workspaceId: "ws-backup", status: "uploaded", archivePath });
      await fixture.insert(schema.workspaceVariables).values({
        id: "var-backup",
        workspaceId: "ws-backup",
        key: "secret",
        value: "",
        valueEncrypted: encrypted,
        sensitive: true,
      });
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
    expect(report.checks.find((check) => check.name === "encrypted-records")?.detail).toBe(
      "1 selected encrypted record(s) decrypted",
    );
    expect(report.checks.find((check) => check.name === "artifact-references")?.detail).toBe(
      "1 referenced artifact(s) are readable",
    );

    // A colocated SQLite file is a supported source form as long as its
    // manifest is beside it.
    await cp(join(work, "terrence-backup-manifest.json"), join(backupStorage, "terrence-backup-manifest.json"));
    const fileReport = await verifyBackupIntegrity({ sourcePath: backupDatabase });
    expect(fileReport.passed).toBe(true);
  });

  it("uses the same nested storage layout for manifest creation and verification", async () => {
    if (work === undefined) throw new Error("backup fixture was not created");
    const nestedRoot = await mkdtemp(join(tmpdir(), "terrence-backup-nested-"));
    await cp(join(work, "storage"), join(nestedRoot, "storage"), { recursive: true });
    const created = await createBackupManifestForSource({ sourcePath: nestedRoot }, { outputDirectory: nestedRoot });
    expect(created.manifest.database.file).toBe("terrence.db");
    const report = await verifyBackupIntegrity({ sourcePath: nestedRoot });
    expect(report.passed).toBe(true);
    await rm(nestedRoot, { recursive: true, force: true });
  });

  it("persists archive manifests outside extraction scratch and cleans failed preparation", async () => {
    if (work === undefined) throw new Error("backup fixture was not created");
    const archiveRoot = await mkdtemp(join(tmpdir(), "terrence-backup-archive-test-"));
    const archiveSource = join(archiveRoot, "source");
    await cp(join(work, "storage"), join(archiveSource, "storage"), { recursive: true });
    await rm(join(archiveSource, "storage", "terrence-backup-manifest.json"), { force: true });
    const archive = join(archiveRoot, "backup.tar");
    await createTar(archiveSource, archive, ["storage"]);

    const before = await extractionDirectories();
    const created = await createBackupManifestForSource({ sourcePath: archive });
    expect(created.path).not.toBeNull();
    if (created.path === null) throw new Error("expected persisted archive manifest");
    expect(JSON.parse(await readFile(created.path, "utf8"))).toMatchObject({ kind: "terrence-backup" });
    expect(await extractionDirectories()).toEqual(before);

    expect(await rejectionOf(verifyBackupIntegrity({ sourcePath: archive }))).toMatchObject({
      code: "manifest-missing",
    });
    expect(await extractionDirectories()).toEqual(before);

    const ambiguousRoot = join(archiveRoot, "ambiguous");
    await mkdir(ambiguousRoot, { recursive: true });
    await writeFile(join(ambiguousRoot, "a.db"), "a");
    await writeFile(join(ambiguousRoot, "b.db"), "b");
    await writeFile(join(ambiguousRoot, "terrence-backup-manifest.json"), JSON.stringify(created.manifest));
    const ambiguousArchive = join(archiveRoot, "ambiguous.tar");
    await createTar(archiveRoot, ambiguousArchive, ["ambiguous"]);
    expect(await rejectionOf(verifyBackupIntegrity({ sourcePath: ambiguousArchive }))).toMatchObject({
      code: "database-ambiguous",
    });
    expect(await extractionDirectories()).toEqual(before);
    await rm(archiveRoot, { recursive: true, force: true });
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
    expect(status.lastVerifiedDatabaseDriver).toBe("sqlite");

    // Database and storage can be supplied as separate operator paths; the
    // rehearsal must copy both into its private staging directory.
    const externalRoot = await mkdtemp(join(tmpdir(), "terrence-backup-source-"));
    const externalStorage = join(externalRoot, "storage");
    const manifestRoot = join(externalRoot, "manifest");
    await cp(join(work, "storage"), externalStorage, { recursive: true, force: true, preserveTimestamps: true });
    await mkdir(manifestRoot, { recursive: true });
    await cp(join(work, "terrence-backup-manifest.json"), join(manifestRoot, "terrence-backup-manifest.json"));
    const separate = await runRestoreRehearsal({
      source: {
        sourcePath: manifestRoot,
        storagePath: externalStorage,
        databasePath: join(externalStorage, "terrence.db"),
      },
      requireCli: false,
    });
    expect(separate.passed).toBe(true);
    await rm(externalRoot, { recursive: true, force: true });
  });

  it("rejects a changed artifact before rehearsal", async () => {
    if (work === undefined) throw new Error("backup fixture was not created");
    const manifest = JSON.parse(await readFile(join(work, "terrence-backup-manifest.json"), "utf8")) as {
      storage: { files: readonly { path: string }[] };
    };
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

it.skipIf(!isPostgres)(
  "verifies an isolated PostgreSQL restore with SELECT-only credentials and retains evidence after failures",
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "terrence-backup-postgres-"));
    const databaseName = `backup_${crypto.randomUUID().replaceAll("-", "")}`;
    const roleName = `backup_reader_${crypto.randomUUID().replaceAll("-", "")}`;
    const password = crypto.randomUUID();
    const url = new URL(process.env["DATABASE_URL"] ?? "");
    const admin = new Bun.SQL(url.toString());
    let restored: Bun.SQL | undefined;
    let roleCreated = false;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      url.pathname = `/${databaseName}`;
      restored = new Bun.SQL(url.toString());
      await migratePostgres(postgresDrizzle(restored), { migrationsFolder: join(import.meta.dir, "../../drizzle/pg") });
      const backupStorage = join(folder, "storage");
      await mkdir(backupStorage);
      const key = randomBytes(32);
      await writeFile(join(backupStorage, ".encryption-key"), key.toString("base64"), { mode: 0o600 });
      const archivePath = join(backupStorage, "configuration.tar.gz");
      await writeFile(archivePath, "postgres archive fixture");
      // Retain the IV independently so the backup is an external crypto fixture.
      const iv = randomBytes(12);
      const encryptor = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([encryptor.update("restored secret", "utf8"), encryptor.final()]);
      const encrypted = [
        "enc",
        "v1",
        iv.toString("base64"),
        encryptor.getAuthTag().toString("base64"),
        ciphertext.toString("base64"),
      ].join(":");
      await restored.unsafe("INSERT INTO organizations (id, name) VALUES ($1, $2)", ["org-backup", "backup"]);
      await restored.unsafe("INSERT INTO workspaces (id, org_id, name, created_at) VALUES ($1, $2, $3, $4)", [
        "ws-backup",
        "org-backup",
        "backup",
        Date.now(),
      ]);
      await restored.unsafe(
        "INSERT INTO configuration_versions (id, workspace_id, status, archive_path, created_at) VALUES ($1, $2, $3, $4, $5)",
        ["cv-backup", "ws-backup", "uploaded", archivePath, Date.now()],
      );
      await restored.unsafe(
        "INSERT INTO workspace_variables (id, workspace_id, key, value, value_encrypted, sensitive) VALUES ($1, $2, $3, $4, $5, TRUE)",
        ["var-backup", "ws-backup", "secret", "", encrypted],
      );
      await admin.unsafe(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
      roleCreated = true;
      await restored.unsafe(`GRANT USAGE ON SCHEMA public, drizzle TO "${roleName}"`);
      await restored.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public, drizzle TO "${roleName}"`);
      url.username = roleName;
      url.password = password;
      const source = { sourcePath: folder, postgresTargetUrl: url.toString() };
      const created = await createBackupManifestForSource(source, { outputDirectory: folder });
      expect(created.manifest.database.driver).toBe("postgres");
      expect(JSON.stringify(created.manifest)).not.toContain(password);
      const success = await runRestoreRehearsal({ source });
      expect(success.checks.filter((check) => check.status === "fail")).toEqual([]);
      expect(success.passed).toBe(true);
      expect(success.databaseDriver).toBe("postgres");
      expect(success.checks.find((check) => check.name === "schema-migration")?.status).toBe("pass");
      expect(success.checks.find((check) => check.name === "encrypted-records")?.detail).toBe(
        "1 selected encrypted record(s) decrypted",
      );
      const status = await readBackupStatus();
      expect(status.lastVerifiedDatabaseDriver).toBe("postgres");
      expect(status.lastRehearsalId).toBe(success.id);
      expect(status.lastVerifiedRestoreAt).toBe(success.lastVerifiedRestoreAt);

      const failed = async (name: string): Promise<void> => {
        const report = await runRestoreRehearsal({ source });
        expect(report.passed).toBe(false);
        expect(report.checks.find((check) => check.name === name)?.status).toBe("fail");
        expect(await readBackupStatus()).toEqual(status);
      };
      await rm(archivePath);
      await failed("artifact-references");
      await writeFile(archivePath, "postgres archive fixture");
      await writeFile(join(backupStorage, ".encryption-key"), randomBytes(32).toString("base64"));
      await failed("encrypted-records");
      await writeFile(join(backupStorage, ".encryption-key"), key.toString("base64"));
      await restored.unsafe("DELETE FROM workspace_variables WHERE id = $1", ["var-backup"]);
      await failed("table-counts");
      await restored.unsafe(
        "INSERT INTO workspace_variables (id, workspace_id, key, value, value_encrypted, sensitive) VALUES ($1, $2, $3, $4, $5, TRUE)",
        ["var-backup", "ws-backup", "secret", "", encrypted],
      );
      await restored.unsafe(
        "UPDATE drizzle.__drizzle_migrations SET hash = $1 WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)",
        ["corrupt-fixture-migration"],
      );
      await failed("schema-migration");
      await restored.unsafe("DELETE FROM drizzle.__drizzle_migrations");
      const historyError = await rejectionOf(createBackupManifestForSource(source, { outputDirectory: folder }));
      expect(historyError).toMatchObject({
        code: "schema-migration",
        message: "The restored PostgreSQL database has no applied migration history",
      });
      expect(await readBackupStatus()).toEqual(status);
      await restored.unsafe("ALTER TABLE users ADD COLUMN fixture_drift text");
      await failed("schema");
      await restored.unsafe("DROP TABLE workspace_variables");
      await failed("schema-incompatible");
      const missing = await runRestoreRehearsal({ source: { sourcePath: folder } });
      expect(missing.passed).toBe(false);
      expect(missing.checks.find((check) => check.name === "database-input")?.status).toBe("fail");
      const live = await runRestoreRehearsal({
        source: { sourcePath: folder, postgresTargetUrl: process.env["DATABASE_URL"] ?? "" },
      });
      expect(live.checks.find((check) => check.name === "postgres-target-live")?.status).toBe("fail");
      expect(await readBackupStatus()).toEqual(status);
      const missingUrl = new URL(url);
      missingUrl.pathname = `/missing_${databaseName}`;
      const unavailable = await runRestoreRehearsal({
        source: { sourcePath: folder, postgresTargetUrl: missingUrl.toString() },
      });
      expect(unavailable.passed).toBe(false);
      expect(JSON.stringify(unavailable)).not.toContain(password);
      expect(unavailable.checks.find((check) => check.name === "postgres-target-unavailable")?.status).toBe("fail");
    } finally {
      await restored?.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      if (roleCreated) await admin.unsafe(`DROP ROLE "${roleName}"`);
      await admin.close();
      await rm(folder, { recursive: true, force: true });
      await restoreBackupStatus();
    }
  },
  60_000,
);
