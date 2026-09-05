import { open, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { isNotNull } from "drizzle-orm";
import { db } from "../db";
import { configurationVersions, registryModuleVersions } from "../db/schema";
import { log } from "./log";

// Startup sweep for crash-stranded upload temps and orphaned archives
// (issue #619). Request-completion paths already clean up after themselves;
// only a crash between the write and the cleanup strands these files.
//
// Storage is single-owner by design (a multi-replica deployment is
// explicitly unsupported: the event bus, worker queue, and sandbox are
// in-process). Even so, the sweep only removes files whose mtime predates
// its own start, so a file being actively published while this instance
// boots is never touched: publication always writes newer bytes than the
// sweep start.

export type UploadSweepResult = Readonly<{
  stateUploads: number;
  cvTemps: number;
  unclaimedArchives: number;
  invalidExports: number;
  orphanedModuleArchives: number;
}>;

export type ExportValidity = "valid" | "invalid" | "unknown";

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry): boolean => entry.isFile()).map((entry): string => entry.name);
  } catch {
    return [];
  }
}

/** True when the file exists and was last modified at or before the sweep
 * started. Anything newer may still be written to; leave it for the next
 * boot. Unstatable files are skipped, never removed. */
async function predatesSweepStart(dir: string, name: string, startedAt: number): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(join(dir, name));
    return mtimeMs <= startedAt;
  } catch {
    return false;
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
 * magic, format versions, payload fractions, and text encoding must match
 * the spec, and the file size must equal page size times page count. A
 * crash-torn write almost always truncates the file, which fails the size
 * check; a fully-written export always passes it. A full integrity check
 * would reread multi-gigabyte exports at every boot, so it is deliberately
 * not part of this gate.
 *
 * Inspection failures (vanished file, I/O error) report "unknown": the
 * caller keeps the file and logs, so a transient error can never delete a
 * valid export. */
const SQLITE_MAGIC = "SQLite format 3" + String.fromCharCode(0);

/** Fixed header fields per the SQLite file format spec: magic, format
 * versions, payload fractions, and text encoding. */
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
function headerFieldsValid(header: Buffer): boolean {
  return header.length >= 100
    && header.subarray(0, 16).toString("latin1") === SQLITE_MAGIC
    && header[18] === 1
    && header[19] === 1
    && header[21] === 64
    && header[22] === 32
    && header[23] === 32
    && header.readUInt32BE(56) >= 1
    && header.readUInt32BE(56) <= 3;
}

/** Size rule for checkSqliteExport: the file must hold exactly page size
 * times page count bytes, which a crash-torn write breaks. */
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
function judgeSqliteHeader(header: Buffer, fileSize: number): "valid" | "invalid" {
  if (!headerFieldsValid(header)) return "invalid";
  let pageSize = header.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return "invalid";
  const pageCount = header.readUInt32BE(28);
  if (pageCount === 0) return "invalid";
  return fileSize === pageSize * pageCount ? "valid" : "invalid";
}
export async function checkSqliteExport(path: string): Promise<ExportValidity> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const header = Buffer.alloc(100);
    const { bytesRead } = await handle.read(header, 0, 100, 0);
    const { size } = await handle.stat();
    return bytesRead < 100 ? "invalid" : judgeSqliteHeader(header, size);
  } catch {
    return "unknown";
  } finally {
    await handle?.close().catch((): undefined => undefined);
  }
}

/** State-upload request bodies: every state-*.json is a request-scoped temp
 * that the handler deletes in a finally block. */
async function sweepStateUploads(dir: string, startedAt: number): Promise<number> {
  let removed = 0;
  for (const name of await listFiles(dir)) {
    if (!name.startsWith("state-") || !name.endsWith(".json")) continue;
    if (!(await predatesSweepStart(dir, name, startedAt))) continue;
    if (await removeLeftover(join(dir, name), "state-uploads", name)) removed += 1;
  }
  return removed;
}

/** Configuration-version and module upload temps: *.tmp while the body
 * streams, *.upload while a module archive ingests. */
async function sweepCvTemps(cvDir: string, startedAt: number): Promise<number> {
  let removed = 0;
  for (const name of await listFiles(cvDir)) {
    if (!name.endsWith(".tmp") && !name.endsWith(".upload")) continue;
    if (!(await predatesSweepStart(cvDir, name, startedAt))) continue;
    if (await removeLeftover(join(cvDir, name), "cv", name)) removed += 1;
  }
  return removed;
}

/** Finalized-but-unclaimed CV archives: a crash between the rename and the
 * row update strands a config-*.tar.gz no row references. */
async function sweepUnclaimedArchives(cvDir: string, startedAt: number): Promise<number> {
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
      if (!(await predatesSweepStart(cvDir, name, startedAt))) continue;
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
 * (jobs are in-memory). Drop files proven invalid; keep anything the
 * inspection could not decide on. */
async function sweepInvalidExports(exportsDir: string, startedAt: number): Promise<number> {
  let removed = 0;
  for (const name of await listFiles(exportsDir)) {
    if (!name.toLowerCase().endsWith(".db")) continue;
    if (!(await predatesSweepStart(exportsDir, name, startedAt))) continue;
    const full = join(exportsDir, name);
    const validity = await checkSqliteExport(full);
    if (validity === "valid" || validity === "unknown") {
      if (validity === "unknown") {
        log.warn("Upload sweep could not inspect export file; keeping it", { file: name });
      }
      continue;
    }
    if (await removeLeftover(full, "exports", name)) removed += 1;
  }
  return removed;
}

/** Module archives orphaned by cascade deletes that removed rows but not
 * files (org deletion before issue #619 collected them). */
async function sweepOrphanedModuleArchives(modulesDir: string, startedAt: number): Promise<number> {
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
      if (!(await predatesSweepStart(modulesDir, name, startedAt))) continue;
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
  const startedAt = Date.now();
  const cvDir = join(storageDir, "cv");
  const result: UploadSweepResult = {
    stateUploads: await sweepStateUploads(join(storageDir, "state-uploads"), startedAt),
    cvTemps: await sweepCvTemps(cvDir, startedAt),
    unclaimedArchives: await sweepUnclaimedArchives(cvDir, startedAt),
    invalidExports: await sweepInvalidExports(join(storageDir, "exports"), startedAt),
    orphanedModuleArchives: await sweepOrphanedModuleArchives(join(storageDir, "modules"), startedAt),
  };
  const total = result.stateUploads + result.cvTemps + result.unclaimedArchives + result.invalidExports + result.orphanedModuleArchives;
  if (total > 0) {
    log.info("Startup upload sweep removed leftover files", { ...result });
  }
  return result;
}
