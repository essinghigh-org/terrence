import { gzipSync, gunzipSync } from "node:zlib";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { logs } from "../db/schema";
import { isDiskFullError, markStorageDegraded } from "./storage-health";

export type StoredRunLog = Readonly<Pick<typeof logs.$inferSelect, "id" | "runId" | "phase" | "outputText" | "createdAt">>;

const storageDirectory = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"), "run-logs");

/** Canonical directory holding per-run log archives (id.json.gz). */
export { storageDirectory as runLogsDirectory };

export function runLogArchivePath(runId: string): string {
  return join(storageDirectory, `${runId}.json.gz`);
}

export async function archiveRunLogs(runId: string): Promise<boolean> {
  const runLogs = await db.query.logs.findMany({
    where: eq(logs.runId, runId),
    orderBy: [asc(logs.createdAt)],
  });
  if (runLogs.length === 0) return false;
  try {
    await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
    await writeFile(runLogArchivePath(runId), gzipSync(JSON.stringify(runLogs)), { mode: 0o600 });
  } catch (error: unknown) {
    if (isDiskFullError(error)) markStorageDegraded("run log archives are failing (disk full)");
    throw error;
  }
  return true;
}

export async function readRunLogs(runId: string, phase?: string): Promise<StoredRunLog[]> {
  const liveLogs = await db.query.logs.findMany({
    where: phase === undefined ? eq(logs.runId, runId) : and(eq(logs.runId, runId), eq(logs.phase, phase)),
    orderBy: [asc(logs.createdAt)],
  });
  if (liveLogs.length > 0) return liveLogs;

  try {
    const archived = JSON.parse(gunzipSync(await readFile(runLogArchivePath(runId))).toString()) as StoredRunLog[];
    return phase === undefined ? archived : archived.filter((log): boolean => log.phase === phase);
  } catch {
    return [];
  }
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
