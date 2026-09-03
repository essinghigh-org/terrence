import { gzipSync, gunzipSync } from "node:zlib";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, asc, count, eq } from "drizzle-orm";
import { db } from "../db";
import { logs } from "../db/schema";
import { isDiskFullError, markStorageDegraded } from "./storage-health";
import { recordFailure } from "./process-metrics";

export type StoredRunLog = Readonly<Pick<typeof logs.$inferSelect, "id" | "runId" | "phase" | "outputText" | "createdAt">>;
export type RunLogPage = Readonly<{ number: number; size: number }>;

const storageDirectory = resolve(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"), "run-logs");

export function runLogArchivePath(runId: string): string {
  return join(storageDirectory, `${runId}.json.gz`);
}

const MAX_RUN_LOGS_PER_RUN = 10000;

export async function archiveRunLogs(runId: string): Promise<boolean> {
  const runLogs = await db.query.logs.findMany({
    where: eq(logs.runId, runId),
    orderBy: [asc(logs.createdAt), asc(logs.id)],
    limit: MAX_RUN_LOGS_PER_RUN,
  });
  if (runLogs.length === 0) return false;
  let temporary: string | null = null;
  try {
    await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
    // Write to a temp name, then atomically promote: a partial archive (e.g.
    // ENOSPC mid-write) must never become the readable artifact.
    temporary = `${runLogArchivePath(runId)}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, gzipSync(JSON.stringify(runLogs)), { mode: 0o600 });
    await rename(temporary, runLogArchivePath(runId));
    temporary = null;
  } catch (error: unknown) {
    if (temporary !== null) await rm(temporary, { force: true }).catch((): void => {});
    recordFailure("runLogWrites");
    if (isDiskFullError(error)) markStorageDegraded("run log archives are failing (disk full)");
    throw error;
  }
  return true;
}

async function readArchivedRunLogs(runId: string): Promise<StoredRunLog[]> {
  try {
    const archived = JSON.parse(gunzipSync(await readFile(runLogArchivePath(runId))).toString()) as StoredRunLog[];
    if (!Array.isArray(archived)) return [];
    return archived.length > MAX_RUN_LOGS_PER_RUN ? archived.slice(0, MAX_RUN_LOGS_PER_RUN) : archived;
  } catch {
    return [];
  }
}

export async function readRunLogs(runId: string, phase?: string): Promise<StoredRunLog[]> {
  const liveLogs = await db.query.logs.findMany({
    where: phase === undefined ? eq(logs.runId, runId) : and(eq(logs.runId, runId), eq(logs.phase, phase)),
    orderBy: [asc(logs.createdAt), asc(logs.id)],
    limit: MAX_RUN_LOGS_PER_RUN,
  });
  if (liveLogs.length > 0) return liveLogs;

  const archived = await readArchivedRunLogs(runId);
  return phase === undefined ? archived : archived.filter((log): boolean => log.phase === phase);
}

function pageOffset(page: RunLogPage, totalCount: number): number | null {
  const totalPages = Math.ceil(totalCount / page.size);
  return page.number <= totalPages ? (page.number - 1) * page.size : null;
}

/**
 * Read one bounded page of live logs, falling back to the immutable archive
 * only when the live table has no rows for the run. The archive format is a
 * compressed JSON array, so it must be decoded to determine its total, but the
 * route still receives only the requested page.
 */
export async function readRunLogsPage(
  runId: string,
  page: RunLogPage,
  phase?: string,
): Promise<Readonly<{ logs: StoredRunLog[]; totalCount: number }>> {
  const where = phase === undefined ? eq(logs.runId, runId) : and(eq(logs.runId, runId), eq(logs.phase, phase));
  const [countRow] = await db.select({ total: count() }).from(logs).where(where);
  const liveTotal = countRow?.total ?? 0;
  const liveOffset = pageOffset(page, liveTotal);
  if (liveTotal > 0) {
    if (liveOffset === null) return { logs: [], totalCount: liveTotal };
    const liveLogs = await db.query.logs.findMany({
      where,
      orderBy: [asc(logs.createdAt), asc(logs.id)],
      limit: page.size,
      offset: liveOffset,
    });
    return { logs: liveLogs, totalCount: liveTotal };
  }

  const archived = await readArchivedRunLogs(runId);
  const filtered = phase === undefined ? archived : archived.filter((log): boolean => log.phase === phase);
  const archiveOffset = pageOffset(page, filtered.length);
  return {
    logs: archiveOffset === null ? [] : filtered.slice(archiveOffset, archiveOffset + page.size),
    totalCount: filtered.length,
  };
}

export async function deleteRunLogArchive(runId: string): Promise<boolean> {
  const archivePath = runLogArchivePath(runId);
  let existed = true;
  try {
    await access(archivePath);
  } catch {
    existed = false;
  }
  await rm(archivePath, { force: true });
  return existed;
}
