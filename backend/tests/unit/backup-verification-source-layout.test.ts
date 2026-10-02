import { afterAll, describe, expect, it } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { randomBytes } from "node:crypto";
import { runBoundedProcess } from "../../src/lib/bounded-process";
import * as schema from "../../src/db/schema-sqlite";
import {
  BACKUP_MANIFEST_DIRECTORY,
  BACKUP_MANIFEST_FILE,
  createBackupManifestForSource,
  verifyBackupIntegrity,
} from "../../src/lib/backup-verification";

const roots: string[] = [];

const makeWork = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

/** Build a self-contained SQLite backup under `storage`. */
const seedBackupStorage = async (storage: string): Promise<void> => {
  await mkdir(storage, { recursive: true });
  await writeFile(join(storage, ".encryption-key"), randomBytes(32).toString("base64"), { mode: 0o600 });
  const sqlite = new Database(join(storage, "terrence.db"), { create: true });
  try {
    const fixture = drizzle(sqlite, { schema });
    migrate(fixture, { migrationsFolder: join(import.meta.dir, "../../drizzle") });
    await fixture.insert(schema.organizations).values({ id: "org-layout", name: "layout" });
  } finally {
    sqlite.close();
  }
};

const archive = async (source: string, destination: string): Promise<void> => {
  await runBoundedProcess(["tar", "-czf", destination, "-C", source, "."], { timeoutMs: 60_000 });
};

afterAll(async () => {
  await Promise.all(roots.map(async (root): Promise<void> => rm(root, { recursive: true, force: true })));
});

describe("backup source layout", () => {
  it("creates and verifies a nested-storage backup from the backup path alone", async () => {
    const work = await makeWork("terrence-backup-nested-");
    const backup = join(work, "backup");
    await seedBackupStorage(join(backup, "storage"));

    // No storage-path / database-path overrides: creation and verification must
    // agree on the same resolved storage root.
    const created = await createBackupManifestForSource({ sourcePath: backup });
    // Creation and verification resolve the same nested storage root.
    expect(created.path).toBe(join(backup, "storage", BACKUP_MANIFEST_DIRECTORY, BACKUP_MANIFEST_FILE));
    const report = await verifyBackupIntegrity({ sourcePath: backup });
    expect(report.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("persists an archive manifest beside the archive so the returned path survives", async () => {
    const work = await makeWork("terrence-backup-archive-");
    const staging = join(work, "staging");
    await seedBackupStorage(join(staging, "storage"));
    const archivePath = join(work, "backup.tar.gz");
    await archive(staging, archivePath);

    const created = await createBackupManifestForSource({ sourcePath: archivePath });
    expect(created.path).not.toBeNull();
    expect(existsSync(created.path ?? "")).toBe(true);
    // The returned file is a usable sidecar for the same archive.
    const report = await verifyBackupIntegrity({ sourcePath: archivePath });
    expect(report.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("keeps sibling archives in one directory on separate manifests", async () => {
    const work = await makeWork("terrence-backup-siblings-");
    const staging = join(work, "staging");
    await seedBackupStorage(join(staging, "storage"));
    const first = join(work, "backup-one.tar.gz");
    const second = join(work, "backup-two.tar.gz");
    await archive(staging, first);

    const firstManifest = await createBackupManifestForSource({ sourcePath: first });
    expect(firstManifest.path).not.toBeNull();

    // Change the source and manifest a second archive beside the first: it must
    // not overwrite the first one's sidecar, or verification of the first would
    // resolve the second's manifest and report digest mismatches.
    await writeFile(join(staging, "storage", "extra.bin"), "changed contents", { mode: 0o600 });
    await archive(staging, second);
    const secondManifest = await createBackupManifestForSource({ sourcePath: second });
    expect(secondManifest.path).not.toBe(firstManifest.path);

    const firstReport = await verifyBackupIntegrity({ sourcePath: first });
    expect(firstReport.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(firstReport.passed).toBe(true);
  });

  it("removes the extraction directory when source preparation fails", async () => {
    const work = await makeWork("terrence-backup-no-manifest-");
    const staging = join(work, "staging");
    await seedBackupStorage(staging);
    const archivePath = join(work, "no-manifest.tar.gz");
    await archive(staging, archivePath);

    const before = (await readdir(tmpdir())).filter((entry): boolean => entry.startsWith("terrence-backup-source-"));
    // Preparation fails after extraction: the archive carries no manifest.
    let rejectedMessage = "";
    try {
      await verifyBackupIntegrity({ sourcePath: archivePath });
    } catch (error: unknown) {
      rejectedMessage = error instanceof Error ? error.message : String(error);
    }
    expect(rejectedMessage).toContain("terrence-backup-manifest.json");
    const after = (await readdir(tmpdir())).filter((entry): boolean => entry.startsWith("terrence-backup-source-"));
    expect(after.length).toBe(before.length);
    // The operator's archive is untouched.
    const archiveInfo = await stat(archivePath);
    expect(archiveInfo.isFile()).toBe(true);
  });

  it("removes the extraction directory when database discovery fails", async () => {
    const work = await makeWork("terrence-backup-ambiguous-");
    const staging = join(work, "staging");
    await seedBackupStorage(staging);
    // A manifest exists, but the database selection is ambiguous: no
    // terrence.db to prefer, and two candidates to choose between.
    await createBackupManifestForSource({ sourcePath: staging });
    const primary = join(staging, "terrence.db");
    await mkdir(join(staging, "archive"), { recursive: true });
    await cp(primary, join(staging, "archive", "copy.sqlite"));
    await cp(primary, join(staging, "archive", "older.sqlite"));
    await rm(primary);
    const archivePath = join(work, "ambiguous.tar.gz");
    await archive(staging, archivePath);

    const before = (await readdir(tmpdir())).filter((entry): boolean => entry.startsWith("terrence-backup-source-"));
    let rejectedMessage = "";
    try {
      await verifyBackupIntegrity({ sourcePath: archivePath });
    } catch (error: unknown) {
      rejectedMessage = error instanceof Error ? error.message : String(error);
    }
    expect(rejectedMessage).toContain("more than one SQLite database");
    const after = (await readdir(tmpdir())).filter((entry): boolean => entry.startsWith("terrence-backup-source-"));
    expect(after.length).toBe(before.length);
  });
});
