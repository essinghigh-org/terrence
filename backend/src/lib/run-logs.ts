import { gzipSync, gunzipSync } from "node:zlib";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { isPostgres } from "../db/driver";
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

type RunLogArchiveEnvelope = Readonly<{
  version: 1;
  /** True when the run produced more rows than the archive keeps. */
  truncated: boolean;
  /** True row count at archive time (may exceed logs.length). */
  totalCount: number;
  logs: StoredRunLog[];
}>;

function isArchiveEnvelope(value: unknown): value is RunLogArchiveEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Record<string, unknown>;
  return envelope["version"] === 1 && Array.isArray(envelope["logs"]);
}

export async function archiveRunLogs(runId: string): Promise<boolean> {
  const [countRow] = await db.select({ total: count() }).from(logs).where(eq(logs.runId, runId));
  const totalCount = countRow?.total ?? 0;
  if (totalCount === 0) return false;
  const runLogs = await db.query.logs.findMany({
    where: eq(logs.runId, runId),
    orderBy: [asc(logs.createdAt), asc(logs.id)],
    limit: MAX_RUN_LOGS_PER_RUN,
  });
  // Issue #585: the archive keeps the first MAX_RUN_LOGS_PER_RUN rows, but
  // the envelope now says so explicitly instead of truncating silently.
  const envelope: RunLogArchiveEnvelope = {
    version: 1,
    truncated: totalCount > runLogs.length,
    totalCount,
    logs: runLogs,
  };
  let temporary: string | null = null;
  try {
    await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
    // Write to a temp name, then atomically promote: a partial archive (e.g.
    // ENOSPC mid-write) must never become the readable artifact.
    temporary = `${runLogArchivePath(runId)}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, gzipSync(JSON.stringify(envelope)), { mode: 0o600 });
    await rename(temporary, runLogArchivePath(runId));
    temporary = null;
  } catch (error: unknown) {
    if (temporary !== null) await rm(temporary, { force: true }).catch((): void => undefined);
    recordFailure("runLogWrites");
    if (isDiskFullError(error)) markStorageDegraded("run log archives are failing (disk full)");
    throw error;
  }
  return true;
}

async function readArchivedRunLogs(runId: string): Promise<RunLogArchiveEnvelope> {
  const empty: RunLogArchiveEnvelope = { version: 1, truncated: false, totalCount: 0, logs: [] };
  try {
    const parsed: unknown = JSON.parse(gunzipSync(await readFile(runLogArchivePath(runId))).toString());
    // Legacy archives (before the envelope) are bare arrays, silently capped
    // at MAX_RUN_LOGS_PER_RUN: treat a full house as truncated.
    if (Array.isArray(parsed)) {
      const logs = (parsed as StoredRunLog[]).slice(0, MAX_RUN_LOGS_PER_RUN);
      return {
        version: 1,
        truncated: (parsed as StoredRunLog[]).length >= MAX_RUN_LOGS_PER_RUN,
        totalCount: logs.length,
        logs,
      };
    }
    if (!isArchiveEnvelope(parsed)) return empty;
    const logs = parsed.logs.length > MAX_RUN_LOGS_PER_RUN ? parsed.logs.slice(0, MAX_RUN_LOGS_PER_RUN) : parsed.logs;
    return { version: 1, truncated: parsed.truncated, totalCount: parsed.totalCount, logs };
  } catch {
    return empty;
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
  return phase === undefined ? archived.logs : archived.logs.filter((log): boolean => log.phase === phase);
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
): Promise<Readonly<{ logs: StoredRunLog[]; totalCount: number; truncated: boolean }>> {
  const where = phase === undefined ? eq(logs.runId, runId) : and(eq(logs.runId, runId), eq(logs.phase, phase));
  const [countRow] = await db.select({ total: count() }).from(logs).where(where);
  const liveTotal = countRow?.total ?? 0;
  const liveOffset = pageOffset(page, liveTotal);
  if (liveTotal > 0) {
    if (liveOffset === null) return { logs: [], totalCount: liveTotal, truncated: false };
    const liveLogs = await db.query.logs.findMany({
      where,
      orderBy: [asc(logs.createdAt), asc(logs.id)],
      limit: page.size,
      offset: liveOffset,
    });
    return { logs: liveLogs, totalCount: liveTotal, truncated: false };
  }

  const archived = await readArchivedRunLogs(runId);
  const filtered = phase === undefined ? archived.logs : archived.logs.filter((log): boolean => log.phase === phase);
  const archiveOffset = pageOffset(page, filtered.length);
  return {
    logs: archiveOffset === null ? [] : filtered.slice(archiveOffset, archiveOffset + page.size),
    totalCount: archived.totalCount,
    truncated: archived.truncated,
  };
}

/** Query-string byte window for the raw log endpoints (the TFE log-read
 * protocol polls with `offset`/`limit`). Defaults serve the whole stream.
 */
export function parseLogSliceParams(request: Readonly<{ url: string }>): Readonly<{ offset: number; limit: number }> {
  const params = new URL(request.url).searchParams;
  const parsedOffset = Number.parseInt(params.get("offset") ?? "0", 10);
  const parsedLimit = Number.parseInt(params.get("limit") ?? "", 10);
  return {
    offset: Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0,
    limit: Number.isInteger(parsedLimit) && parsedLimit >= 0 ? parsedLimit : Number.POSITIVE_INFINITY,
  };
}

export type RunLogSlice = Readonly<{
  /** Exact bytes of the joined "<row>\n<row>…" stream in [offset, offset+limit). Kept as bytes (never decoded) so windows that split a multibyte character stay byte-exact for polling clients that stitch ranges. */
  bytes: Uint8Array;
  /** Total bytes of the whole stream (all rows joined). */
  totalBytes: number;
  /** True row count behind the stream. */
  totalCount: number;
  /** True when the stream does not cover every row ever written. */
  truncated: boolean;
}>;

type LogSizeRow = Readonly<{ id: string; length: number }>;
type LogWindow = Readonly<{
  rowStart: number;
  ids: readonly string[];
}>;

// Portable byte length: octet_length on PostgreSQL, blob length on SQLite
// (plain length() counts characters and would misplace multibyte windows).
const outputByteLength = isPostgres
  ? sql<number>`octet_length(${logs.outputText})`
  : sql<number>`length(cast(${logs.outputText} as blob))`;

/** Total bytes of the joined "<row>\n<row>…" stream for ordered sizes. */
function logStreamTotalBytes(sizes: readonly LogSizeRow[]): number {
  return sizes.reduce((sum, size, i): number => sum + (i > 0 ? 1 : 0) + size.length, 0);
}

/** Locate the rows covering [offsetBytes, endBytes) in the joined stream. */
function locateLogWindow(
  sizes: readonly LogSizeRow[],
  offsetBytes: number,
  endBytes: number,
): LogWindow | null {
  const totalBytes = logStreamTotalBytes(sizes);
  // Row i occupies [start, start+len), preceded by one separator byte when
  // i > 0. Find the first row intersecting the window.
  let rowIndex = sizes.length;
  let rowStart = totalBytes;
  let cursor = 0;
  for (let i = 0; i < sizes.length; i++) {
    const start = cursor + (i > 0 ? 1 : 0);
    const end = start + (sizes[i]?.length ?? 0);
    if (end > offsetBytes) {
      rowIndex = i;
      rowStart = start;
      break;
    }
    cursor = end;
  }
  if (rowIndex >= sizes.length || endBytes <= offsetBytes) return null;
  // Collect the ids covering the window; bounded by it. Only separators
  // between fetched rows count: the byte before the first row is either
  // outside the window or emitted as the prefix, never fetched.
  const ids: string[] = [];
  let covered = rowStart;
  for (let i = rowIndex; i < sizes.length && covered < endBytes; i++) {
    const size = sizes[i];
    if (size === undefined) break;
    ids.push(size.id);
    covered += (i > rowIndex ? 1 : 0) + size.length;
  }
  return { rowStart, ids };
}

/**
 * Read one byte window of a phase's raw log stream without loading the whole
 * log (issue #585). Row byte lengths come from SQL; only the rows covering
 * the window are fetched, so CLI offset polling costs O(window), not
 * O(log). Live streams are never truncated; archived streams report the
 * retention envelope's marker. Rows are append-only, so a polling window is
 * stable while the tail grows.
 */
export async function readRunLogSlice(
  runId: string,
  phase: string,
  offsetBytes: number,
  limitBytes: number,
): Promise<RunLogSlice> {
  const where = and(eq(logs.runId, runId), eq(logs.phase, phase));
  // One snapshot of (id, byte length) in stream order. Fetching by id below
  // (instead of LIMIT/OFFSET) keeps the window pinned even if the tail grows
  // between the two queries. If retention deletes a selected row in between,
  // retry once from a fresh snapshot; the second miss falls back to an
  // approximate window rather than failing a log tail.
  for (let attempt = 0; attempt < 2; attempt++) {
    const sizes = await db.select({ id: logs.id, length: outputByteLength }).from(logs).where(where)
      .orderBy(asc(logs.createdAt), asc(logs.id));
    if (sizes.length === 0) return readArchivedLogSlice(runId, phase, offsetBytes, limitBytes);

    const totalBytes = logStreamTotalBytes(sizes);
    const endBytes = Number.isFinite(limitBytes) ? offsetBytes + limitBytes : totalBytes;
    const window = locateLogWindow(sizes, offsetBytes, endBytes);
    if (window === null) {
      return { bytes: new Uint8Array(0), totalBytes, totalCount: sizes.length, truncated: false };
    }
    const rows = await db.select({ id: logs.id, outputText: logs.outputText }).from(logs)
      .where(and(where, inArray(logs.id, [...window.ids])));
    const textById = new Map(rows.map((row): readonly [string, string] => [row.id, row.outputText]));
    if (attempt === 0 && window.ids.some((id): boolean => !textById.has(id))) continue;
    const joined = Buffer.from(window.ids.map((id): string => textById.get(id) ?? "").join("\n"), "utf8");
    // Bytes in [offsetBytes, rowStart) are the single separator before the
    // first fetched row (empty unless the offset lands exactly on it).
    const prefix = offsetBytes < window.rowStart ? SEPARATOR_BYTE : EMPTY_BYTES;
    const from = Math.max(0, offsetBytes - window.rowStart);
    const take = Math.max(0, endBytes - Math.max(offsetBytes, window.rowStart));
    const body = joined.subarray(from, from + take);
    return {
      bytes: prefix.length === 0 ? body : Buffer.concat([prefix, body]),
      totalBytes,
      totalCount: sizes.length,
      truncated: false,
    };
  }
  throw new Error("Unreachable: slice retry loop always returns");
}

const SEPARATOR_BYTE = new Uint8Array([10]);
const EMPTY_BYTES = new Uint8Array(0);

async function readArchivedLogSlice(
  runId: string,
  phase: string,
  offsetBytes: number,
  limitBytes: number,
): Promise<RunLogSlice> {
  const archived = await readArchivedRunLogs(runId);
  const filtered = archived.logs.filter((log): boolean => log.phase === phase);
  const text = filtered.map((log): string => log.outputText).join("\n");
  const bytes = Buffer.from(text, "utf8");
  const end = Number.isFinite(limitBytes) ? Math.min(offsetBytes + limitBytes, bytes.length) : bytes.length;
  return {
    bytes: offsetBytes >= bytes.length ? new Uint8Array(0) : bytes.subarray(offsetBytes, Math.max(offsetBytes, end)),
    totalBytes: bytes.length,
    totalCount: archived.totalCount,
    truncated: archived.truncated,
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
