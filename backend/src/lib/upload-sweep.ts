import { open, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { isNotNull } from "drizzle-orm";
import { db } from "../db";
import { configurationVersions, registryModuleVersions } from "../db/schema";
import { log } from "./log";

// Startup sweep for crash-stranded upload temps and orphaned archives
// (issue #619). Request-completion paths already clean up after themselves;
// only a crash between the write and the cleanup strands these files, so at
// boot (before traffic is served) anything matching is garbage by
// construction: no upload can be in flight yet.

export type UploadSweepResult = Readonly<{
  stateUploads: number;
  cvTemps: number;
  unclaimedArchives: number;
  invalidExports: number;
  orphanedModuleArchives: number;
}>;

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry): boolean => entry.isFile()).map((entry): string => entry.name);
  } catch {
    return [];
  }
}

async function removeLeftover(path: string, area: string, file: string): Promise<boolean> {
  try {
    await rm(path, { force: true });
    return true;
  } catch (error: unknown) {
    log.warn("Upload sweep could not remove leftover file", {
      area,
      file,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Basenames of every non-null archive path in a table query result. */
function referencedBasenames(rows: readonly Readonly<{ archivePath: string | null }>[]): Set<string> {
  return new Set(
    rows
      .map((row): string | null => row.archivePath)
      .filter((archivePath): archivePath is string => archivePath !== null)
      .map((archivePath): string => basename(archivePath)),
  );
}

/** Structural SQLite validity without reading the whole file: the header
 * magic must match and the file size must equal page size times page count.
 * A crash-torn write almost always truncates the file, which fails the size
 * check; a fully-written export always passes it. */
async function isCompleteSqliteFile(path: string): Promise<boolean> {
  const SQLITE_MAGIC = "SQLite format 3" + String.fromCharCode(0);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const header = Buffer.alloc(100);
    const { bytesRead } = await handle.read(header, 0, 100, 0);
    if (bytesRead < 100) return false;
    if (header.subarray(0, 16).toString("latin1") !== SQLITE_MAGIC) return false;
    let pageSize = header.readUInt16BE(16);
    if (pageSize === 1) pageSize = 65536;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return false;
    const pageCount = header.readUInt32BE(28);
    if (pageCount === 0) return false;
    const { size } = await handle.stat();
    return size === pageSize * pageCount;
  } catch {
    return false;
  } finally {
    await handle?.close().catch((): undefined => undefined);
  }
}

/** State-upload request bodies: every state-*.json is a request-scoped temp
 * that the handler deletes in a finally block. */
async function sweepStateUploads(dir: string): Promise<number> {
  let removed = 0;
  for (const name of await listFiles(dir)) {
    if (!name.startsWith("state-") || !name.endsWith(".json")) continue;
    if (await removeLeftover(join(dir, name), "state-uploads", name)) removed += 1;
  }
  return removed;
}

/** Configuration-version and module upload temps: *.tmp while the body
 * streams, *.upload while a module archive ingests. */
async function sweepCvTemps(cvDir: string): Promise<number> {
  let removed = 0;
  for (const name of await listFiles(cvDir)) {
    if (!name.endsWith(".tmp") && !name.endsWith(".upload")) continue;
    if (await removeLeftover(join(cvDir, name), "cv", name)) removed += 1;
  }
  return removed;
}

/** Finalized-but-unclaimed CV archives: a crash between the rename and the
 * row update strands a config-*.tar.gz no row references. */
async function sweepUnclaimedArchives(cvDir: string): Promise<number> {
  try {
    const rows = await db.query.configurationVersions.findMany({
      where: isNotNull(configurationVersions.archivePath),
      columns: { archivePath: true },
    });
    const claimed = referencedBasenames(rows);
    let removed = 0;
    for (const name of await listFiles(cvDir)) {
      if (!name.startsWith("config-") || !name.endsWith(".tar.gz")) continue;
      if (claimed.has(name)) continue;
      if (await removeLeftover(join(cvDir, name), "cv", name)) removed += 1;
    }
    return removed;
  } catch (error: unknown) {
    log.warn("Upload sweep could not check unclaimed configuration archives", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/** Exports: a crash mid-export strands a partial .db with no job record
 * (jobs are in-memory). Drop files that fail structural validation. */
async function sweepInvalidExports(exportsDir: string): Promise<number> {
  let removed = 0;
  for (const name of await listFiles(exportsDir)) {
    if (!name.toLowerCase().endsWith(".db")) continue;
    const full = join(exportsDir, name);
    if (await isCompleteSqliteFile(full)) continue;
    if (await removeLeftover(full, "exports", name)) removed += 1;
  }
  return removed;
}

/** Module archives orphaned by cascade deletes that removed rows but not
 * files (org deletion before issue #619 collected them). */
async function sweepOrphanedModuleArchives(modulesDir: string): Promise<number> {
  try {
    const rows = await db.query.registryModuleVersions.findMany({
      where: isNotNull(registryModuleVersions.archivePath),
      columns: { archivePath: true },
    });
    const referenced = referencedBasenames(rows);
    let removed = 0;
    for (const name of await listFiles(modulesDir)) {
      if (!name.endsWith(".tar.gz")) continue;
      if (referenced.has(name)) continue;
      if (await removeLeftover(join(modulesDir, name), "modules", name)) removed += 1;
    }
    return removed;
  } catch (error: unknown) {
    log.warn("Upload sweep could not check orphaned module archives", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Remove crash-stranded upload temps and orphaned archives under a storage
 * directory. Never throws: every step is best-effort so a boot-time hiccup
 * cannot take the instance down (the next boot retries).
 */
export async function sweepUploadTemps(storageDir: string): Promise<UploadSweepResult> {
  const cvDir = join(storageDir, "cv");
  const result: UploadSweepResult = {
    stateUploads: await sweepStateUploads(join(storageDir, "state-uploads")),
    cvTemps: await sweepCvTemps(cvDir),
    unclaimedArchives: await sweepUnclaimedArchives(cvDir),
    invalidExports: await sweepInvalidExports(join(storageDir, "exports")),
    orphanedModuleArchives: await sweepOrphanedModuleArchives(join(storageDir, "modules")),
  };
  const total = result.stateUploads + result.cvTemps + result.unclaimedArchives + result.invalidExports + result.orphanedModuleArchives;
  if (total > 0) {
    log.info("Startup upload sweep removed leftover files", { ...result });
  }
  return result;
}
