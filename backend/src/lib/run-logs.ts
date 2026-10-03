import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { access, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, asc, desc, count, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { isPostgres } from "../db/driver";
import { logs } from "../db/schema";
import { isDiskFullError, markStorageDegraded } from "./storage-health";
import { recordFailure } from "./process-metrics";

export type StoredRunLog = Readonly<
  Pick<typeof logs.$inferSelect, "id" | "runId" | "phase" | "outputText" | "createdAt">
>;
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
  return (
    envelope["version"] === 1 &&
    Array.isArray(envelope["logs"]) &&
    typeof envelope["truncated"] === "boolean" &&
    Number.isSafeInteger(envelope["totalCount"]) &&
    (envelope["totalCount"] as number) >= envelope["logs"].length
  );
}

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const ARCHIVE_MAGIC = Buffer.from("TRL2");
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const CHUNK_ROWS = 32;
const CHUNK_BYTES = 256 * 1024;
const MAX_ROW_BYTES = 1024 * 1024;
const MAX_CHUNK_JSON_BYTES = 8 * 1024 * 1024;
type ArchiveRow = Readonly<{ id: string; phase: string; length: number }>;
type ArchiveChunk = Readonly<{ offset: number; length: number; rows: readonly ArchiveRow[] }>;
type ArchiveIndex = Readonly<{ version: 2; totalCount: number; truncated: boolean; chunks: ArchiveChunk[] }>;
type ArchiveSelection = (rows: readonly ArchiveRow[]) => readonly string[];
type ArchiveRead = RunLogArchiveEnvelope & Readonly<{ sizes: readonly ArchiveRow[] }>;

// ponytail: one archive operation at a time bounds compression/read buffers;
// increase concurrency only after measuring memory with the archive load check.
let archiveTail: Promise<unknown> = Promise.resolve();
let pendingArchives = 0;
async function withArchiveSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (pendingArchives >= 32) throw new Error("Run log archive queue is full");
  pendingArchives++;
  const result = archiveTail.then(operation);
  archiveTail = result.catch((): void => undefined);
  return result.finally((): void => {
    pendingArchives--;
  });
}

async function snapshotLogSizes(
  runId: string,
): Promise<{ totalCount: number; sizes: { id: string; phase: string; length: number }[] }> {
  const [countRow] = await db.select({ total: count() }).from(logs).where(eq(logs.runId, runId));
  const totalCount = countRow?.total ?? 0;
  if (totalCount === 0) return { totalCount, sizes: [] };
  const sizes = (
    await db
      .select({ id: logs.id, phase: logs.phase, length: outputByteLength })
      .from(logs)
      .where(eq(logs.runId, runId))
      .orderBy(desc(logs.createdAt), desc(logs.id))
      .limit(MAX_RUN_LOGS_PER_RUN)
  ).reverse();
  if (totalCount < sizes.length) throw new Error("Run logs changed during archival; live logs retained");
  if (
    sizes.some((row): boolean => row.length > MAX_ROW_BYTES) ||
    sizes.reduce((total, row): number => total + row.length, 0) > MAX_ARCHIVE_BYTES
  ) {
    throw new Error("Run log archive exceeds 64 MiB or a row exceeds 1 MiB; live logs retained");
  }
  return { totalCount, sizes };
}

function verifyArchivedRows(
  allRows: readonly Readonly<{ id: string; phase: string; outputText: string }>[],
  sizes: readonly ArchiveRow[],
): void {
  if (
    allRows.length !== sizes.length ||
    allRows.some(
      (row, i): boolean =>
        row.id !== sizes[i]?.id ||
        row.phase !== sizes[i]?.phase ||
        Buffer.byteLength(row.outputText) !== sizes[i]?.length,
    )
  ) {
    throw new Error("Run logs changed during archival; live logs retained");
  }
}

function nextChunkEnd(sizes: readonly Readonly<{ length: number }>[], start: number): number {
  let end = start;
  let chunkBytes = 0;
  while (end < sizes.length && end - start < CHUNK_ROWS) {
    const length = sizes[end]?.length ?? 0;
    if (end > start && chunkBytes + length > CHUNK_BYTES) break;
    chunkBytes += length;
    end++;
  }
  return end;
}

async function writeArchiveChunks(
  file: Readonly<Pick<Awaited<ReturnType<typeof open>>, "read" | "writeFile">>,
  sizes: readonly ArchiveRow[],
  allRows: readonly Readonly<{ id: string; phase: string; outputText: string }>[],
  totalCount: number,
): Promise<void> {
  const chunks: ArchiveChunk[] = [];
  let offset = 0;
  for (let start = 0; start < sizes.length; ) {
    const end = nextChunkEnd(sizes, start);
    const rows = sizes.slice(start, end);
    // allRows is verified 1:1 against sizes above, so the same window applies.
    const payload = allRows.slice(start, start + rows.length);
    start = end;
    const bytes = await compress(JSON.stringify(payload));
    await file.writeFile(bytes);
    chunks.push({ offset, length: bytes.length, rows });
    offset += bytes.length;
    if (offset > MAX_ARCHIVE_BYTES) throw new Error("Compressed run log archive exceeds limit; live logs retained");
  }
  const index = Buffer.from(
    JSON.stringify({ version: 2, totalCount, truncated: totalCount > sizes.length, chunks } satisfies ArchiveIndex),
  );
  if (index.length > MAX_INDEX_BYTES) throw new Error("Run log archive index exceeds limit");
  const footer = Buffer.alloc(8);
  footer.writeUInt32LE(index.length);
  ARCHIVE_MAGIC.copy(footer, 4);
  await file.writeFile(index);
  await file.writeFile(footer);
}

export async function archiveRunLogs(runId: string): Promise<boolean> {
  return withArchiveSlot(async (): Promise<boolean> => {
    const { totalCount, sizes } = await snapshotLogSizes(runId);
    if (totalCount === 0) return false;
    // One round trip for the payload: per-chunk re-reads turn a 10k-row
    // archival into hundreds of sequential queries (multi-second on
    // Postgres). The sizes snapshot above still guards against concurrent
    // mutation — every fetched row must match it exactly. Same window as
    // the sizes query (newest-first, capped, then reversed): an
    // oldest-first fetch would grab a different slice of an over-cap run.
    const allRows = (
      await db
        .select()
        .from(logs)
        .where(eq(logs.runId, runId))
        .orderBy(desc(logs.createdAt), desc(logs.id))
        .limit(MAX_RUN_LOGS_PER_RUN)
    ).reverse();
    verifyArchivedRows(allRows, sizes);
    let temporary: string | null = null;
    try {
      await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
      temporary = `${runLogArchivePath(runId)}.${crypto.randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try {
        await writeArchiveChunks(file, sizes, allRows, totalCount);
      } finally {
        await file.close();
      }
      // Publish the index and every chunk together. Failure keeps the old
      // archive intact and prevents retention from deleting the live rows.
      await rename(temporary, runLogArchivePath(runId));
      temporary = null;
    } catch (error: unknown) {
      if (temporary !== null) await rm(temporary, { force: true }).catch((): void => undefined);
      recordFailure("runLogWrites");
      if (isDiskFullError(error)) markStorageDegraded("run log archives are failing (disk full)");
      throw error;
    }
    return true;
  });
}

function indexChunkTotals(
  chunk: ArchiveChunk,
  expectedOffset: number,
  ids: Readonly<Pick<Set<string>, "has" | "add">>,
): { offset: number; rowCount: number; bytes: number } {
  if (
    chunk.offset !== expectedOffset ||
    !Number.isSafeInteger(chunk.length) ||
    chunk.length <= 0 ||
    !Array.isArray(chunk.rows) ||
    chunk.rows.length === 0 ||
    chunk.rows.length > CHUNK_ROWS
  )
    throw new Error("Invalid run log archive format");
  let rowCount = 0;
  let bytes = 0;
  for (const row of chunk.rows as readonly ArchiveRow[]) {
    if (
      typeof row.id !== "string" ||
      ids.has(row.id) ||
      typeof row.phase !== "string" ||
      !Number.isSafeInteger(row.length) ||
      row.length < 0 ||
      row.length > MAX_ROW_BYTES
    )
      throw new Error("Invalid run log archive format");
    ids.add(row.id);
    rowCount++;
    bytes += row.length;
  }
  return { offset: expectedOffset + chunk.length, rowCount, bytes };
}

function parseArchiveIndex(value: unknown, dataLength: number): ArchiveIndex {
  const index = value as ArchiveIndex | null;
  if (
    index?.version !== 2 ||
    !Array.isArray(index.chunks) ||
    typeof index.truncated !== "boolean" ||
    !Number.isSafeInteger(index.totalCount) ||
    index.totalCount < 0
  )
    throw new Error("Invalid run log archive format");
  let offset = 0;
  let rowCount = 0;
  let bytes = 0;
  const ids = new Set<string>();
  for (const chunk of index.chunks) {
    const totals = indexChunkTotals(chunk, offset, ids);
    offset = totals.offset;
    rowCount += totals.rowCount;
    bytes += totals.bytes;
  }
  if (
    offset !== dataLength ||
    rowCount > MAX_RUN_LOGS_PER_RUN ||
    index.totalCount < rowCount ||
    bytes > MAX_ARCHIVE_BYTES
  ) {
    throw new Error("Invalid run log archive format");
  }
  return index;
}

async function readFileRange(
  file: Readonly<Pick<Awaited<ReturnType<typeof open>>, "read" | "writeFile">>,
  offset: number,
  length: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let consumed = 0;
  while (consumed < length) {
    const result = await file.read(bytes, consumed, length - consumed, offset + consumed);
    if (result.bytesRead === 0) throw new Error("Incomplete run log archive");
    consumed += result.bytesRead;
  }
  return bytes;
}

function decodeChunkRows(
  decoded: unknown,
  chunk: ArchiveChunk,
  runId: string,
  selected: Readonly<Pick<ReadonlySet<string>, "has">>,
): StoredRunLog[] {
  if (!Array.isArray(decoded) || decoded.length !== chunk.rows.length)
    throw new Error("Invalid run log archive format");
  const result: StoredRunLog[] = [];
  for (let i = 0; i < decoded.length; i++) {
    const row = decoded[i] as StoredRunLog;
    const meta = chunk.rows[i];
    if (
      row.id !== meta?.id ||
      row.phase !== meta.phase ||
      row.runId !== runId ||
      typeof row.outputText !== "string" ||
      Buffer.byteLength(row.outputText) !== meta.length
    )
      throw new Error("Invalid run log archive format");
    if (selected.has(row.id)) result.push(row);
  }
  return result;
}

async function readV2Archive(
  file: Readonly<Pick<Awaited<ReturnType<typeof open>>, "read" | "writeFile">>,
  size: number,
  runId: string,
  select: ArchiveSelection | undefined,
  indexLength: number,
): Promise<ArchiveRead> {
  if (indexLength > MAX_INDEX_BYTES || indexLength > size - 8) throw new Error("Invalid run log archive format");
  const index = parseArchiveIndex(
    JSON.parse((await readFileRange(file, size - 8 - indexLength, indexLength)).toString()),
    size - 8 - indexLength,
  );
  const sizes = index.chunks.flatMap((chunk): readonly ArchiveRow[] => chunk.rows);
  const selected = new Set(select?.(sizes) ?? sizes.map((row): string => row.id));
  const result: StoredRunLog[] = [];
  for (const chunk of index.chunks) {
    if (!chunk.rows.some((row): boolean => selected.has(row.id))) continue;
    const decoded: unknown = JSON.parse(
      (
        await decompress(await readFileRange(file, chunk.offset, chunk.length), {
          maxOutputLength: MAX_CHUNK_JSON_BYTES,
        })
      ).toString(),
    );
    result.push(...decodeChunkRows(decoded, chunk, runId, selected));
  }
  return { version: 1, totalCount: index.totalCount, truncated: index.truncated, logs: result, sizes };
}

async function readLegacyArchive(
  file: Readonly<Pick<Awaited<ReturnType<typeof open>>, "read" | "writeFile">>,
  size: number,
  select: ArchiveSelection | undefined,
): Promise<ArchiveRead> {
  // Existing v1 and bare-array archives remain readable. Their format
  // requires whole-document parsing, capped here rather than unbounded.
  const parsed: unknown = JSON.parse(
    (await decompress(await readFileRange(file, 0, size), { maxOutputLength: MAX_ARCHIVE_BYTES })).toString(),
  );
  if (!Array.isArray(parsed) && !isArchiveEnvelope(parsed)) throw new Error("Invalid run log archive format");
  const envelope: RunLogArchiveEnvelope = Array.isArray(parsed)
    ? {
        version: 1,
        truncated: parsed.length >= MAX_RUN_LOGS_PER_RUN,
        totalCount: Math.min(parsed.length, MAX_RUN_LOGS_PER_RUN),
        logs: (parsed as StoredRunLog[]).slice(0, MAX_RUN_LOGS_PER_RUN),
      }
    : parsed;
  const rows = envelope.logs.slice(0, MAX_RUN_LOGS_PER_RUN);
  const sizes = rows.map(
    (row): ArchiveRow => ({ id: row.id, phase: row.phase, length: Buffer.byteLength(row.outputText) }),
  );
  const selected = select === undefined ? null : new Set(select(sizes));
  return { ...envelope, logs: selected === null ? rows : rows.filter((row): boolean => selected.has(row.id)), sizes };
}

async function readArchivedRunLogs(runId: string, select?: ArchiveSelection): Promise<ArchiveRead> {
  return withArchiveSlot(async (): Promise<ArchiveRead> => {
    try {
      const file = await open(runLogArchivePath(runId), "r");
      try {
        const { size } = await file.stat();
        if (size > MAX_ARCHIVE_BYTES + MAX_INDEX_BYTES) throw new Error("Run log archive exceeds size limit");
        const footer = size >= 8 ? await readFileRange(file, size - 8, 8) : Buffer.alloc(0);
        // Await before returning: the finally below must not close the
        // handle while the branch reader is still using it.
        if (footer.subarray(4).equals(ARCHIVE_MAGIC)) {
          return await readV2Archive(file, size, runId, select, footer.readUInt32LE());
        }
        return await readLegacyArchive(file, size, select);
      } finally {
        await file.close();
      }
    } catch (error: unknown) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { version: 1, truncated: false, totalCount: 0, logs: [], sizes: [] };
      }
      throw error;
    }
  });
}

export async function readRunLogs(runId: string, phase?: string): Promise<StoredRunLog[]> {
  const liveLogs = await db.query.logs.findMany({
    where: phase === undefined ? eq(logs.runId, runId) : and(eq(logs.runId, runId), eq(logs.phase, phase)),
    orderBy: [desc(logs.createdAt), desc(logs.id)],
    limit: MAX_RUN_LOGS_PER_RUN,
  });
  if (liveLogs.length > 0) return liveLogs.reverse();

  const archived = await readArchivedRunLogs(runId, (sizes): readonly string[] =>
    sizes.filter((row): boolean => phase === undefined || row.phase === phase).map((row): string => row.id),
  );
  return phase === undefined ? archived.logs : archived.logs.filter((log): boolean => log.phase === phase);
}

function pageOffset(page: RunLogPage, totalCount: number): number | null {
  const totalPages = Math.ceil(totalCount / page.size);
  return page.number <= totalPages ? (page.number - 1) * page.size : null;
}

/**
 * Read one bounded page of live logs, falling back to the immutable archive
 * only when the live table has no rows for the run. Indexed archives decode
 * only the chunks containing the requested rows.
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

  const archived = await readArchivedRunLogs(runId, (sizes): readonly string[] => {
    const filtered = phase === undefined ? sizes : sizes.filter((row): boolean => row.phase === phase);
    const offset = pageOffset(page, filtered.length);
    return offset === null ? [] : filtered.slice(offset, offset + page.size).map((row): string => row.id);
  });
  return {
    logs: archived.logs,
    totalCount: archived.totalCount,
    truncated: archived.truncated,
  };
}

/** Query-string byte window for the raw log endpoints (the TFE log-read
 * protocol polls with `offset`/`limit`). Each response has a finite byte budget.
 */
const MAX_LOG_SLICE_BYTES = 1024 * 1024;
const MAX_LOG_SLICE_ROWS = 16_384;

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
function locateLogWindow(sizes: readonly LogSizeRow[], offsetBytes: number, endBytes: number): LogWindow | null {
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
 * Read one bounded byte window of a phase's raw log stream. SQL computes
 * offsets and slices payload bytes before returning them; the API materializes
 * at most 1 MiB and 16,384 row segments per response. Requests exceeding a
 * response budget report truncation, with the total size for offset polling.
 * Archived streams also report their retention envelope's marker.
 */
export async function readRunLogSlice(
  runId: string,
  phase: string,
  offsetBytes: number,
  limitBytes: number,
): Promise<RunLogSlice> {
  const limit = Number.isFinite(limitBytes)
    ? Math.min(Math.max(0, limitBytes), MAX_LOG_SLICE_BYTES)
    : MAX_LOG_SLICE_BYTES;
  const where = and(eq(logs.runId, runId), eq(logs.phase, phase));
  const [totals] = await db
    .select({ count: count(), bytes: sql<number>`coalesce(sum(${outputByteLength}), 0)`.mapWith(Number) })
    .from(logs)
    .where(where);
  const totalCount = totals?.count ?? 0;
  if (totalCount === 0) return readArchivedLogSlice(runId, phase, offsetBytes, limitBytes);
  const totalBytes = (totals?.bytes ?? 0) + totalCount - 1;
  if (limit === 0 || offsetBytes >= totalBytes) return { bytes: EMPTY_BYTES, totalBytes, totalCount, truncated: false };
  const windowEnd = Math.min(offsetBytes + limit, totalBytes);
  const order = sql`${logs.createdAt}, ${logs.id}`;
  const spans = db
    .select({
      id: logs.id,
      length: outputByteLength.as("byte_length"),
      first: sql<number>`row_number() over (order by ${order})`.as("row_number"),
      cursor:
        sql<number>`coalesce(sum(${outputByteLength} + 1) over (order by ${order} rows between unbounded preceding and 1 preceding), 0)`.as(
          "byte_cursor",
        ),
    })
    .from(logs)
    .where(where)
    .as("log_spans");
  // Each segment includes its preceding separator. SQL slices bytes before
  // returning payloads, so even one large row stays within the response budget.
  const start = sql<number>`case when ${spans.first} = 1 then 0 else ${spans.cursor} - 1 end`;
  const end = sql<number>`${spans.cursor} + ${spans.length}`;
  const prefix = sql`case when ${spans.first} = 1 then '' else char(10) end`;
  const segment = isPostgres
    ? sql`convert_to(case when ${spans.first} = 1 then '' else chr(10) end || ${logs.outputText}, 'UTF8')`
    : sql`cast(${prefix} || ${logs.outputText} as blob)`;
  const from = sql<number>`case when ${offsetBytes} > ${start} then ${offsetBytes} - ${start} else 0 end`;
  const take = sql<number>`case when ${windowEnd} < ${end} then ${windowEnd} else ${end} end - (${start} + ${from})`;
  const payload = isPostgres
    ? sql<Uint8Array>`substring(${segment} from cast(${from} + 1 as integer) for cast(${take} as integer))`
    : sql<Uint8Array>`substr(${segment}, ${from} + 1, ${take})`;
  const rows = await db
    .select({ bytes: payload })
    .from(spans)
    .innerJoin(logs, eq(logs.id, spans.id))
    .where(sql`${end} > ${offsetBytes} and ${start} < ${windowEnd}`)
    .orderBy(sql`${spans.first}`)
    .limit(MAX_LOG_SLICE_ROWS);
  const bytes = Buffer.concat(rows.map((row): Buffer => Buffer.from(row.bytes)));
  return { bytes, totalBytes, totalCount, truncated: bytes.length < Math.min(limitBytes, totalBytes - offsetBytes) };
}

const SEPARATOR_BYTE = new Uint8Array([10]);
const EMPTY_BYTES = new Uint8Array(0);

async function readArchivedLogSlice(
  runId: string,
  phase: string,
  offsetBytes: number,
  limitBytes: number,
): Promise<RunLogSlice> {
  const limit = Number.isFinite(limitBytes)
    ? Math.min(Math.max(0, limitBytes), MAX_LOG_SLICE_BYTES)
    : MAX_LOG_SLICE_BYTES;
  let totalBytes = 0;
  let rowStart = 0;
  const archived = await readArchivedRunLogs(runId, (sizes): readonly string[] => {
    const filtered = sizes.filter((row): boolean => row.phase === phase);
    totalBytes = logStreamTotalBytes(filtered);
    const window = locateLogWindow(filtered, offsetBytes, offsetBytes + limit);
    rowStart = window?.rowStart ?? offsetBytes;
    return window?.ids ?? [];
  });
  const joined = Buffer.from(archived.logs.map((log): string => log.outputText).join("\n"));
  const prefix = offsetBytes < rowStart ? SEPARATOR_BYTE : EMPTY_BYTES;
  const from = Math.max(0, offsetBytes - rowStart);
  const take = Math.max(0, Math.min(limit - prefix.length, totalBytes - Math.max(offsetBytes, rowStart)));
  const body = joined.subarray(from, from + take);
  return {
    bytes: prefix.length === 0 ? body : Buffer.concat([prefix, body]),
    totalBytes,
    totalCount: archived.totalCount,
    truncated: archived.truncated || prefix.length + body.length < Math.min(limitBytes, totalBytes - offsetBytes),
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
