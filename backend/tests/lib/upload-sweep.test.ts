import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import {
  configurationVersions,
  organizations,
  registryModules,
  registryModuleVersions,
  workspaces,
} from "../../src/db/schema";
import { checkSqliteExport, sweepUploadTemps } from "../../src/lib/upload-sweep";

// Issue #619: the boot sweep removes crash-stranded upload temps and
// orphaned archives while keeping referenced files and valid exports.
describe("sweepUploadTemps", (): void => {
  const suffix = crypto.randomUUID();
  const orgId = "sweep-org-" + suffix;
  const workspaceId = "sweep-ws-" + suffix;
  const cvId = "sweep-cv-" + suffix;
  const moduleId = "sweep-mod-" + suffix;
  const versionId = "sweep-ver-" + suffix;
  let root = "";

  afterAll(async (): Promise<void> => {
    await db.delete(registryModuleVersions).where(eq(registryModuleVersions.id, versionId));
    await db.delete(registryModules).where(eq(registryModules.id, moduleId));
    await db.delete(configurationVersions).where(eq(configurationVersions.id, cvId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  test("removes temps, unclaimed archives, partial exports, and orphans", async (): Promise<void> => {
    root = await mkdtemp(join(tmpdir(), "terrence-upload-sweep-"));
    const stateUploadsDir = join(root, "state-uploads");
    const cvDir = join(root, "cv");
    const exportsDir = join(root, "exports");
    const modulesDir = join(root, "modules");
    for (const dir of [stateUploadsDir, cvDir, exportsDir, modulesDir]) {
      await mkdir(dir, { recursive: true });
    }

    // Referenced files the sweep must keep.
    const keptCvArchive = join(cvDir, "config-kept.tar.gz");
    const keptModuleArchive = join(modulesDir, "kept.tar.gz");
    await db.insert(organizations).values({ id: orgId, name: orgId });
    await db.insert(workspaces).values({ id: workspaceId, name: workspaceId, orgId });
    await db.insert(configurationVersions).values({ id: cvId, workspaceId, status: "uploaded", archivePath: keptCvArchive });
    await db.insert(registryModules).values({ id: moduleId, orgId, namespace: orgId, name: "kept", provider: "aws" });
    await db.insert(registryModuleVersions).values({ id: versionId, moduleId, version: "1.0.0", archivePath: keptModuleArchive });

    // Crash leftovers the sweep must remove.
    const stateTemp = join(stateUploadsDir, "state-abc123.json");
    const cvTmp = join(cvDir, "config-cv1-token.tar.gz.tmp");
    const moduleUpload = join(cvDir, "registry-module-ver1.uuid.upload");
    const orphanCvArchive = join(cvDir, "config-orphan.tar.gz");
    const orphanModuleArchive = join(modulesDir, "orphan.tar.gz");
    const partialExport = join(exportsDir, "partial.db");
    const garbageExport = join(exportsDir, "garbage.db");
    await writeFile(stateTemp, "{}");
    await writeFile(cvTmp, "partial body");
    await writeFile(moduleUpload, "partial ingest");
    await writeFile(orphanCvArchive, "stranded archive");
    await writeFile(orphanModuleArchive, "stranded archive");
    await writeFile(garbageExport, "not a database file");

    // Genuine exports: a complete database is kept, a truncated one is not.
    const genuine = new Database(join(exportsDir, "valid.db"), { create: true });
    genuine.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1);");
    genuine.close();
    const genuineBytes = await readFile(join(exportsDir, "valid.db"));
    await writeFile(partialExport, genuineBytes.subarray(0, 100));

    // Files the sweep must keep.
    const stateKeep = join(stateUploadsDir, "README.txt");
    const cvKeep = join(cvDir, "notes.txt");
    const validExport = join(exportsDir, "valid.db");
    await writeFile(stateKeep, "not a temp");
    await writeFile(cvKeep, "not a temp");
    await writeFile(keptCvArchive, "referenced archive");
    await writeFile(keptModuleArchive, "referenced archive");

    const result = await sweepUploadTemps(root);

    expect(result).toEqual({
      stateUploads: 1,
      cvTemps: 2,
      unclaimedArchives: 1,
      invalidExports: 2,
      orphanedModuleArchives: 1,
    });
    for (const gone of [stateTemp, cvTmp, moduleUpload, orphanCvArchive, orphanModuleArchive, partialExport, garbageExport]) {
      expect(await Bun.file(gone).exists()).toBe(false);
    }
    for (const kept of [stateKeep, cvKeep, keptCvArchive, keptModuleArchive, validExport]) {
      expect(await Bun.file(kept).exists()).toBe(true);
    }
  });
});

describe("checkSqliteExport", (): void => {
  test("separates valid, invalid, and uninspectable files", async (): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "terrence-export-check-"));
    try {
      const valid = join(dir, "valid.db");
      const genuine = new Database(valid, { create: true });
      genuine.exec("CREATE TABLE t(x);");
      genuine.close();
      expect(await checkSqliteExport(valid)).toBe("valid");

      const truncated = join(dir, "truncated.db");
      const full = await readFile(valid);
      await writeFile(truncated, full.subarray(0, 100));
      expect(await checkSqliteExport(truncated)).toBe("invalid");

      const garbage = join(dir, "garbage.db");
      await writeFile(garbage, "plain text, not sqlite");
      expect(await checkSqliteExport(garbage)).toBe("invalid");

      expect(await checkSqliteExport(join(dir, "missing.db"))).toBe("unknown");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
