// Idempotent, resumable SQLite → PostgreSQL data copy.
//
// The copy phase:
//   - Reads from a single read-only SQLite connection held in a long-lived
//     read transaction (WAL snapshot): every table sees one consistent
//     point-in-time view, and rows are paginated with rowid keysets so the
//     source is streamed, never loaded wholesale.
//   - Inserts into PostgreSQL with `ON CONFLICT DO NOTHING`, so re-running
//     the copy after an interruption only adds rows that are missing.
//   - Runs in foreign-key topological order (parents first) because the
//     NOT VALID constraints still enforce new inserts on PostgreSQL.
//   - Coerces values per column mode (boolean/json from the Drizzle schema,
//     everything else from the declared SQLite type).
import { createHash } from "node:crypto";
import type { SQLQueryBindings } from "bun:sqlite";

export type SqliteQueryable = Readonly<{
  query: (sql: string) => { all: (...params: SQLQueryBindings[]) => unknown[]; get: (...params: SQLQueryBindings[]) => unknown };
}>;

export type PostgresQueryable = {
  unsafe: <T = Record<string, unknown>>(sql: string, values?: unknown[]) => Promise<T[]>;
};

export type ColumnMode = "boolean" | "json" | "integer" | "numeric" | "real" | "text" | "blob" | "datetime";

export type CopyColumn = Readonly<{
  name: string;
  mode: ColumnMode;
}>;

export type CopyTable = Readonly<{
  name: string;
  columns: readonly CopyColumn[];
  /** PK columns in order; empty for tables without a usable primary key. */
  pkColumns: readonly string[];
}>;

export type CopyBatch = Readonly<{
  table: string;
  rowsCopied: number;
}>;

export type CopyOptions = Readonly<{
  batchSize?: number;
  onBatch?: (batch: CopyBatch) => void;
  isCancelled?: () => boolean;
}>;

const DEFAULT_BATCH_SIZE = 250;

function quoted(name: string): string {
  return `"${name.replace(/"/g, "\"\"")}"`;
}

function coerceBoolean(value: unknown): boolean {
  if (value === true) return true;
  if (value === false) return false;
  if (value === 1 || value === "1" || value === "t" || value === "true") return true;
  if (value === 0 || value === "0" || value === "f" || value === "false") return false;
  throw new Error(`Boolean column holds ${String(value)} (${typeof value}); refusing to guess`);
}

function coerceCell(value: unknown, mode: ColumnMode): unknown {
  if (value === null || value === undefined) return null;
  switch (mode) {
    case "boolean":
      return coerceBoolean(value);
    case "json":
      // SQLite stores JSON as text; jsonb parses the text on insert.
      return typeof value === "object" ? JSON.stringify(value) : value;
    case "blob":
      // bun:sqlite returns BLOB as Uint8Array; Bun.sql binds bytea from it.
      return value instanceof Uint8Array ? value : Buffer.from(String(value), "binary");
    default:
      return value;
  }
}

/** Pick the rowid alias for keyset pagination, or null when shadowed. */
function rowidColumn(columns: readonly CopyColumn[]): string | null {
  const names = new Set(columns.map((column): string => column.name));
  if (!names.has("rowid")) return "rowid";
  if (!names.has("_rowid_")) return "_rowid_";
  return null;
}

function readCopyBatch(
  source: SqliteQueryable,
  table: CopyTable,
  rowid: string | null,
  batchSize: number,
  total: number,
  cursor: number,
): readonly Readonly<Record<string, unknown>>[] {
  const sql = rowid === null
    ? `SELECT * FROM ${quoted(table.name)} LIMIT ? OFFSET ?`
    : `SELECT ${rowid} AS "_terrence_rowid", * FROM ${quoted(table.name)} WHERE ${rowid} > ? ORDER BY ${rowid} LIMIT ?`;
  try {
    const rows = rowid === null
      ? source.query(sql).all(batchSize, total)
      : source.query(sql).all(cursor, batchSize);
    return rows as readonly Readonly<Record<string, unknown>>[];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Copy source read failed on table "${table.name}" (${sql}): ${message}`);
  }
}

/**
 * Copy one table from source to target. Idempotent: rows already present in
 * the target are skipped via ON CONFLICT DO NOTHING. Returns rows copied.
 */
export async function copyTable(
  source: SqliteQueryable,
  target: PostgresQueryable,
  table: CopyTable,
  options: CopyOptions = {},
): Promise<number> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const rowid = rowidColumn(table.columns);
  const columnList = table.columns.map((column): string => quoted(column.name)).join(", ");
  const insertPrefix = `INSERT INTO ${quoted(table.name)} (${columnList}) VALUES `;

  let total = 0;
  // rowid values are always integers (SQLite rowid / _rowid_ columns).
  let cursor = 0;
  for (;;) {
    if (options.isCancelled?.() === true) break;
    const rows = readCopyBatch(source, table, rowid, batchSize, total, cursor);
    if (rows.length === 0) break;

    const params: unknown[] = [];
    const valueGroups: string[] = [];
    for (const row of rows) {
      const values: unknown[] = [];
      for (const column of table.columns) {
        values.push(coerceCell(row[column.name], column.mode));
      }
      params.push(...values);
      valueGroups.push(`(${values.map((_, index): string => `$${params.length - values.length + index + 1}`).join(", ")})`);
    }
    await target.unsafe(`${insertPrefix}${valueGroups.join(", ")} ON CONFLICT DO NOTHING`, params).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Copy failed on table "${table.name}" (batch of ${String(rows.length)} rows): ${message}`);
    });
    total += rows.length;
    if (rowid !== null) {
      const lastRow = rows[rows.length - 1]!;
      const last = lastRow._terrence_rowid;
      if (typeof last !== "number") break; // no usable keyset cursor; stop rather than loop forever
      cursor = last;
    }
    options.onBatch?.({ table: table.name, rowsCopied: total });
  }
  return total;
}

/** Canonical JSON serialization with sorted keys (jsonb normalizes key order). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key): string => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/**
 * Canonical cell rendering for digest comparison. Both sides (SQLite row
 * values and PostgreSQL row values) render through the same function so type
 * differences (bigint-as-string, jsonb re-serialization, boolean true vs 1)
 * collapse to identical output.
 */
export function canonicalCell(value: unknown, mode: ColumnMode): string {
  if (value === null || value === undefined) return "n";
  switch (mode) {
    case "boolean": {
      const truthy = value === true || value === 1 || value === "1" || value === "t" || value === "true";
      return truthy ? "b1" : "b0";
    }
    case "json": {
      if (typeof value === "string") {
        try {
          return `j${canonicalJson(JSON.parse(value))}`;
        } catch {
          return `s${value}`;
        }
      }
      if (typeof value === "object") return `j${canonicalJson(value)}`;
      return `s${String(value)}`;
    }
    case "integer": {
      if (typeof value === "bigint") return `i${value.toString()}`;
      if (typeof value === "number") return Number.isInteger(value) ? `i${value.toString()}` : `f${value.toString()}`;
      if (typeof value === "string") return /^-?\d+$/.test(value) ? `i${value}` : `s${value}`;
      return `s${String(value)}`;
    }
    case "numeric": {
      if (typeof value === "number" || typeof value === "bigint") return `n${value.toString()}`;
      return `n${String(value)}`;
    }
    case "real": {
      return typeof value === "number" ? `f${value.toString()}` : `f${String(value)}`;
    }
    case "blob": {
      if (value instanceof Uint8Array) return `x${Buffer.from(value).toString("hex")}`;
      return `x${Buffer.from(String(value), "binary").toString("hex")}`;
    }
    default:
      return `s${String(value)}`;
  }
}

export type TableDigestResult = Readonly<{
  digest: string;
  rows: number;
}>;

/**
 * Streaming content digest of one table, ordered by its primary key.
 * Both source and target must order by the same key; Terrence primary keys
 * are ASCII so SQLite BINARY and PostgreSQL locale collation agree.
 */
export function digestTableSource(
  source: SqliteQueryable,
  table: CopyTable,
): TableDigestResult {
  if (table.pkColumns.length === 0) {
    throw new Error(`Table ${table.name} has no primary key; digest requires one`);
  }
  const order = table.pkColumns.map(quoted).join(", ");
  const hash = createHash("sha256");
  let rows = 0;
  const statement = source.query(`SELECT * FROM ${quoted(table.name)} ORDER BY ${order}`);
  // `all()` streams through bun:sqlite's internal cursor in one pass; rows
  // are materialized per-table which is acceptable for digest verification.
  const all = statement.all() as readonly Readonly<Record<string, unknown>>[];
  for (const row of all) {
    const cells = table.columns.map((column): string => canonicalCell(row[column.name], column.mode));
    hash.update(JSON.stringify(cells));
    rows += 1;
  }
  return { digest: hash.digest("hex"), rows };
}

export async function digestTableTarget(
  target: PostgresQueryable,
  table: CopyTable,
): Promise<TableDigestResult> {
  if (table.pkColumns.length === 0) {
    throw new Error(`Table ${table.name} has no primary key; digest requires one`);
  }
  const order = table.pkColumns.map(quoted).join(", ");
  const hash = createHash("sha256");
  let rows = 0;
  // OFFSET pagination: simple, and correct at homelab scale. The source side
  // streams in one pass; both sides order by the same PK so row digests line
  // up regardless of the pagination strategy.
  const pageSize = 2000;
  for (let offset = 0; ; offset += pageSize) {
    const page = await target.unsafe(
      `SELECT * FROM ${quoted(table.name)} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${offset}`,
    );
    if (page.length === 0) break;
    for (const row of page) {
      const cells = table.columns.map((column): string => canonicalCell(row[column.name], column.mode));
      hash.update(JSON.stringify(cells));
      rows += 1;
    }
  }
  return { digest: hash.digest("hex"), rows };
}

/** Advance identity sequences to the copied max so future inserts do not collide. */
export async function syncIdentitySequences(target: PostgresQueryable, tables: readonly CopyTable[]): Promise<void> {
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.mode !== "integer") continue;
      // Only identity-capable single-column PKs carry a sequence; probe
      // pg_get_serial_sequence for every integer PK column.
      if (!table.pkColumns.includes(column.name)) continue;
      const sequenceRow = await target.unsafe(
        `SELECT pg_get_serial_sequence($1, $2) AS seq`,
        [table.name, column.name],
      );
      const sequence = sequenceRow[0]?.seq;
      if (typeof sequence !== "string" || sequence === "") continue;
      await target.unsafe(
        `SELECT setval($1::regclass, COALESCE((SELECT MAX(${quoted(column.name)}) FROM ${quoted(table.name)}), 1), (SELECT MAX(${quoted(column.name)}) FROM ${quoted(table.name)}) IS NOT NULL)`,
        [sequence],
      );
    }
  }
}

export type ForeignKeyViolation = Readonly<{
  table: string;
  constraint: string;
  error: string;
}>;

/** Validate every translated foreign key on the target (idempotent). */
export async function validateForeignKeys(
  target: PostgresQueryable,
  tables: readonly CopyTable[],
  fkNames: ReadonlyMap<string, readonly string[]>,
): Promise<readonly ForeignKeyViolation[]> {
  const violations: ForeignKeyViolation[] = [];
  for (const table of tables) {
    for (const name of fkNames.get(table.name) ?? []) {
      try {
        await target.unsafe(`ALTER TABLE ${quoted(table.name)} VALIDATE CONSTRAINT ${quoted(name)}`);
      } catch (error: unknown) {
        violations.push({
          table: table.name,
          constraint: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return violations;
}
