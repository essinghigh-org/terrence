// ---------------------------------------------------------------------------
// Shared database copy/verify engine (kanban 4.x: SQLite -> Postgres wizard
// forward path and Postgres -> SQLite export reverse path).
//
// The engine is driver-agnostic: a TransferSource streams rows from the
// source database, a TransferTarget accepts them, and transferDatabase()
// plus verifyTransfer() do the copy and the post-copy verification (row
// counts, unique-index invariants, foreign-key checks, critical sample
// hashes). Both the forward migration wizard and the reverse export use the
// same code; only the concrete source/target construction differs.
//
//   forward : createSqliteSource(...) -> createPgTarget(...)   (wizard, task 3)
//   reverse : createPgSource(...)     -> createSqliteTarget(...) (export, task 4)
//
// The schema contract is the Drizzle schema (backend/src/db/schema.ts): the
// table list, per-table column list, and column storage classes all come from
// it. A source missing a schema table is a hard error (fail fast), extra
// source columns are ignored.
// ---------------------------------------------------------------------------
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { Column } from "drizzle-orm";
// The SQLite table definitions are always the transfer contract: the export
// target is a SQLite file and the migration wizard's forward path reads a
// SQLite source. The dialect selector (db/schema.ts) is deliberately NOT
// used: it swaps in pg-core mirrors when the local backend is postgres, which
// would break SQLite target construction.
import * as schema from "../db/schema-sqlite";
// Canonical cell rendering shared with the forward migration wizard
// (migration/copy.ts) so digests are comparable across both directions.
import { canonicalCell } from "./migration/copy";
import type { ColumnMode } from "./migration/copy";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** A single target column's storage contract, derived from the Drizzle schema. */
export interface TransferColumn {
  /** SQL column name (snake_case in Terrence). */
  readonly name: string;
  /** Drizzle dataType: "string" | "number" | "boolean" | "json" | "date" | "buffer". */
  readonly dataType: string;
  /** Drizzle columnType class name (e.g. "SQLiteText", "SQLiteInteger"). */
  readonly columnType: string;
  /** True when the column is (part of) the primary key. */
  readonly primary: boolean;
  /** True when the column is NOT NULL. */
  readonly notNull: boolean;
  /** For date columns: "timestamp" (epoch seconds), "timestamp_ms", ... when set. */
  readonly mode: string | undefined;
}

export interface TransferTable {
  readonly name: string;
  readonly columns: readonly TransferColumn[];
}

/** One foreign-key edge used for topological table ordering. */
export interface ForeignKeyEdge {
  readonly child: string;
  readonly parent: string;
}

export interface UniqueIndex {
  readonly name: string;
  readonly table: string;
  readonly columns: readonly string[];
}

/**
 * Read side of a transfer. All methods are awaited; streamRows delivers
 * batches so large tables never materialize in memory at once.
 */
export interface TransferSource {
  /** Cheap connectivity probe (SELECT 1). */
  ping(): Promise<void>;
  /** True when the source exposes the given table. */
  hasTable(name: string): Promise<boolean>;
  /** SELECT COUNT(*) for a table. */
  count(name: string): Promise<number>;
  /** SELECT COUNT(*) with a WHERE condition (parameterized). */
  countWhere(name: string, condition: string, params: readonly (string | number | bigint | null)[]): Promise<number>;
  /** COUNT(DISTINCT columns) for unique-index invariant checks. */
  queryDistinctCount(name: string, columns: readonly string[]): Promise<number>;
  /**
   * Stream every row of a table in schema column order, in batches of at most
   * `batchSize` rows. The callback may be async; batches are delivered
   * sequentially. `onBatch` must not retain rows beyond the call.
   */
  streamRows(
    name: string,
    columns: readonly TransferColumn[],
    batchSize: number,
    onBatch: (rows: readonly (readonly unknown[])[]) => Promise<void> | void,
  ): Promise<void>;
  /** Read up to `limit` rows ordered by `orderColumns` (sample hashing). */
  readSampleRows(
    name: string,
    columns: readonly TransferColumn[],
    orderColumns: readonly string[],
    limit: number,
  ): Promise<readonly (readonly unknown[])[]>;
  /** Open a consistent snapshot (e.g. REPEATABLE READ READ ONLY on Postgres). */
  beginSnapshot(): Promise<void>;
  /** Close the snapshot and release the connection. */
  endSnapshot(): Promise<void>;
}

/** Write side of a transfer. */
export interface TransferTarget {
  /** Table list + foreign keys + unique indexes of the target schema. */
  listForeignKeys(): Promise<readonly ForeignKeyEdge[]>;
  listUniqueIndexes(): Promise<readonly UniqueIndex[]>;
  /** Remove existing rows so a retried transfer re-copies cleanly. */
  beginTable(name: string): Promise<void>;
  /** Insert normalized rows (all in one transaction per table). */
  insertRows(
    name: string,
    columns: readonly TransferColumn[],
    rows: readonly (readonly unknown[])[],
  ): Promise<void>;
  /** Commit the table's transaction. */
  commitTable(name: string): Promise<void>;
  count(name: string): Promise<number>;
  queryDistinctCount(name: string, columns: readonly string[]): Promise<number>;
  streamRows(
    name: string,
    columns: readonly TransferColumn[],
    batchSize: number,
    onBatch: (rows: readonly (readonly unknown[])[]) => Promise<void> | void,
  ): Promise<void>;
  readSampleRows(
    name: string,
    columns: readonly TransferColumn[],
    orderColumns: readonly string[],
    limit: number,
  ): Promise<readonly (readonly unknown[])[]>;
  /** PRAGMA foreign_key_check rows (empty = no violations). */
  runForeignKeysCheck(): Promise<readonly { table: string; rowid: number | null; parent: string; fkid: number }[]>;
  /** Whether FK enforcement is currently ON for the connection. */
  foreignKeysEnabled(): Promise<boolean>;
  /** Fold the WAL into the main file and close (leaves a self-contained file). */
  finishAndClose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Drizzle schema introspection
// ---------------------------------------------------------------------------

/** All Drizzle tables of the Terrence schema, in definition order. */
const TABLE_NAME = Symbol.for("drizzle:Name");
const TABLE_COLUMNS = Symbol.for("drizzle:Columns");

export function schemaTables(): readonly TransferTable[] {
  const out: TransferTable[] = [];
  for (const value of Object.values(schema)) {
    if (value === null || typeof value !== "object") continue;
    const columnsRecord = (value as unknown as Record<PropertyKey, unknown>)[TABLE_COLUMNS];
    if (columnsRecord === undefined) continue;
    const name = String((value as unknown as Record<PropertyKey, unknown>)[TABLE_NAME]);
    const columns: TransferColumn[] = [];
    for (const column of Object.values(columnsRecord as Record<string, Column>)) {
      columns.push({
        name: column.name,
        dataType: column.dataType,
        columnType: column.columnType,
        primary: column.primary,
        notNull: column.notNull,
        mode: (column as { mode?: string }).mode,
      });
    }
    out.push({ name, columns });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Value normalization: driver-typed source values -> SQLite storage classes
// ---------------------------------------------------------------------------

/**
 * Normalize a source value for the target column. Idempotent for values that
 * already match the target storage class, so it is safe to apply on both
 * sides of a verification sample hash.
 */
export function normalizeValue(value: unknown, column: TransferColumn): unknown {
  if (value === null || value === undefined) return null;
  switch (column.dataType) {
    case "boolean":
      return value === true || value === 1 || value === "1" || value === "t" || value === "true" ? 1 : 0;
    case "json":
      return typeof value === "string" ? value : JSON.stringify(value);
    case "date": {
      const ms = value instanceof Date
        ? value.getTime()
        : typeof value === "number"
          ? value
          : typeof value === "string"
            ? Date.parse(value)
            : Number(value);
      if (!Number.isFinite(ms)) return null;
      // Drizzle SQLite date modes store epoch seconds except timestamp_ms.
      return column.mode === "timestamp_ms" ? ms : Math.floor(ms / 1000);
    }
    case "buffer":
      if (value instanceof Uint8Array) return value;
      if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      }
      if (typeof value === "string") return new TextEncoder().encode(value);
      return null;
    case "number": {
      if (value instanceof Date) return value.getTime();
      const n = typeof value === "bigint" ? Number(value) : Number(value);
      return Number.isFinite(n) ? n : null;
    }
    default: {
      // text columns
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "bigint") return String(value);
      if (typeof value === "boolean") return value ? "1" : "0";
      if (value instanceof Date) return value.toISOString();
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    }
  }
}

/** Minimal read surface shared by sources and targets (digest verification). */
interface Digestable {
  count(name: string): Promise<number>;
  streamRows(
    name: string,
    columns: readonly TransferColumn[],
    batchSize: number,
    onBatch: (rows: readonly (readonly unknown[])[]) => Promise<void> | void,
  ): Promise<void>;
  readSampleRows(
    name: string,
    columns: readonly TransferColumn[],
    orderColumns: readonly string[],
    limit: number,
  ): Promise<readonly (readonly unknown[])[]>;
}

export function toColumnMode(column: TransferColumn): ColumnMode {
  switch (column.dataType) {
    case "boolean":
      return "boolean";
    case "json":
      return "json";
    case "date":
      return "datetime";
    case "buffer":
      return "blob";
    case "number":
      return column.columnType === "SQLiteReal" ? "real" : "integer";
    default:
      return "text";
  }
}

/**
 * Streaming content digest of a table, ordered by its primary key when one
 * exists (mirrors the forward wizard's digestTableSource/digestTableTarget:
 * same canonical cell rendering, same JSON framing). Tables without a usable
 * PK are hashed as a sorted set of the first `sampleLimit` rows so both sides
 * agree regardless of physical row order.
 */
export async function digestTable(
  source: Digestable,
  table: TransferTable,
  options: { readonly fullDigestLimit?: number; readonly sampleLimit?: number } = {},
): Promise<{ readonly digest: string; readonly rows: number }> {
  const modes = table.columns.map(toColumnMode);
  const fullLimit = options.fullDigestLimit ?? 5000;
  const sampleLimit = options.sampleLimit ?? SAMPLE_LIMIT_DEFAULT;
  const orderColumns = table.columns.filter((c) => c.primary).map((c) => c.name);
  const count = await source.count(table.name);

  if (orderColumns.length > 0 && count <= fullLimit) {
    // Full digest: stream all rows in PK order and hash the canonical cell
    // frames, exactly like the forward path's digest verification.
    const hash = new Bun.CryptoHasher("sha256");
    let rows = 0;
    await source.streamRows(table.name, table.columns, 500, (batch) => {
      for (const row of batch) {
        const cells = row.map((value, i): string => canonicalCell(value, modes[i] ?? "text"));
        hash.update(JSON.stringify(cells));
        rows += 1;
      }
    });
    return { digest: hash.digest("hex"), rows };
  }

  // Sample digest: first rows by PK (or a sorted set for PK-less tables).
  const sampled = await source.readSampleRows(table.name, table.columns, orderColumns, sampleLimit);
  const frames = sampled.map((row) => JSON.stringify(row.map((value, i): string => canonicalCell(value, modes[i] ?? "text"))));
  if (orderColumns.length === 0) frames.sort();
  const digest = new Bun.CryptoHasher("sha256").update(frames.join("\n")).digest("hex");
  return { digest, rows: sampled.length };
}

// ---------------------------------------------------------------------------
// Topological ordering
// ---------------------------------------------------------------------------

/**
 * Order tables so parents come before children (Kahn's algorithm). Tables
 * involved in reference cycles (or unknown to the edge list) keep their
 * schema order at the end; FK enforcement is disabled during the copy, so
 * cycles only matter for the post-copy FK check, not for insertion.
 */
export function topologicalOrder(tables: readonly string[], edges: readonly ForeignKeyEdge[]): readonly string[] {
  const childrenOf = new Map<string, string[]>();
  const parentCount = new Map<string, number>();
  for (const name of tables) {
    childrenOf.set(name, []);
    parentCount.set(name, 0);
  }
  for (const edge of edges) {
    if (!parentCount.has(edge.child) || !parentCount.has(edge.parent)) continue;
    parentCount.set(edge.child, (parentCount.get(edge.child) ?? 0) + 1);
    childrenOf.get(edge.parent)?.push(edge.child);
  }
  const ready = tables.filter((name) => (parentCount.get(name) ?? 0) === 0);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const name = ready.shift() as string;
    ordered.push(name);
    for (const child of childrenOf.get(name) ?? []) {
      const remaining = (parentCount.get(child) ?? 0) - 1;
      parentCount.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
  }
  const visited = new Set(ordered);
  return [...ordered, ...tables.filter((name) => !visited.has(name))];
}

// ---------------------------------------------------------------------------
// SQLite target
// ---------------------------------------------------------------------------

export interface SqliteTargetOptions {
  /** Run the Drizzle migrations to create the schema (default true). */
  readonly createSchema?: boolean;
}

export class SqliteTransferTarget implements TransferTarget {
  readonly #client: Database;
  readonly #path: string;
  #finished = false;

  private constructor(client: Database, path: string) {
    this.#client = client;
    this.#path = path;
  }

  /**
   * Open (or create) a SQLite database at `path` with production-equivalent
   * pragmas and, by default, the full Drizzle migration schema so a fresh
   * Terrence instance can boot against the finished file.
   */
  static create(path: string, options: SqliteTargetOptions = {}): SqliteTransferTarget {
    const client = new Database(path, { create: true });
    client.run("PRAGMA journal_mode = WAL;");
    client.run("PRAGMA busy_timeout = 5000;");
    // FK enforcement is deferred until the copy finishes: the post-copy
    // PRAGMA foreign_key_check is the authoritative integrity gate, and
    // disabling enforcement during insert avoids per-row ordering costs.
    client.run("PRAGMA foreign_keys = OFF;");
    if (options.createSchema !== false) {
      const drizzleDb = drizzle(client, { schema });
      // src/lib → ../../drizzle (the sqlite migration set shared with the app).
      migrate(drizzleDb, { migrationsFolder: join(import.meta.dir, "../../drizzle") });
    }
    return new SqliteTransferTarget(client, path);
  }

  get path(): string {
    return this.#path;
  }

  async listForeignKeys(): Promise<readonly ForeignKeyEdge[]> {
    const tables = this.#client.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'",
    ).all() as { name: string }[];
    const edges: ForeignKeyEdge[] = [];
    for (const { name } of tables) {
      const fks = this.#client.query(`PRAGMA foreign_key_list("${name}")`).all() as { table: string }[];
      for (const fk of fks) edges.push({ child: name, parent: fk.table });
    }
    return edges;
  }

  async listUniqueIndexes(): Promise<readonly UniqueIndex[]> {
    const indexes = this.#client.query(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND upper(sql) LIKE '%UNIQUE%'",
    ).all() as { name: string; tbl_name: string; sql: string }[];
    const out: UniqueIndex[] = [];
    for (const index of indexes) {
      const cols = this.#client.query(`PRAGMA index_info("${index.name}")`).all() as { name: string | null }[];
      const names = cols.map((c) => c.name).filter((c): c is string => c !== null);
      if (names.length > 0) out.push({ name: index.name, table: index.tbl_name, columns: names });
    }
    return out;
  }

  async beginTable(name: string): Promise<void> {
    // Idempotent retry: a re-run of a partially copied table starts clean.
    // Each insert batch runs in its own small transaction, so a failed batch
    // rolls back alone; a retried transfer wipes the table first via DELETE.
    this.#client.run(`DELETE FROM "${name}"`);
  }

  async insertRows(
    name: string,
    columns: readonly TransferColumn[],
    rows: readonly (readonly unknown[])[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const placeholders = columns.map(() => "?").join(",");
    const statement = this.#client.prepare(
      `INSERT INTO "${name}" (${columns.map((c) => `"${c.name}"`).join(",")}) VALUES (${placeholders})`,
    );
    this.#client.run("BEGIN");
    try {
      for (const row of rows) {
        statement.run(...(row.map((value, i) => normalizeValue(value, columns[i] as TransferColumn)) as never[]));
      }
      this.#client.run("COMMIT");
    } catch (error) {
      this.#client.run("ROLLBACK");
      throw error;
    }
  }

  async commitTable(_name: string): Promise<void> {
    // Per-batch transactions make a table-level commit a no-op.
  }

  async count(name: string): Promise<number> {
    const row = this.#client.query(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number } | null;
    return row?.n ?? 0;
  }

  async queryDistinctCount(name: string, columns: readonly string[]): Promise<number> {
    const quoted = columns.map((c) => `"${c}"`).join(",");
    const row = this.#client.query(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT ${quoted} FROM "${name}")`).get() as
      | { n: number }
      | null;
    return row?.n ?? 0;
  }

  async streamRows(
    name: string,
    columns: readonly TransferColumn[],
    batchSize: number,
    onBatch: (rows: readonly (readonly unknown[])[]) => Promise<void> | void,
  ): Promise<void> {
    await streamSqliteRows(this.#client, name, columns, batchSize, onBatch);
  }

  async readSampleRows(
    name: string,
    columns: readonly TransferColumn[],
    orderColumns: readonly string[],
    limit: number,
  ): Promise<readonly (readonly unknown[])[]> {
    const quotedCols = columns.map((c) => `"${c.name}"`).join(",");
    const order = orderColumns.length > 0 ? ` ORDER BY ${orderColumns.map((c) => `"${c}"`).join(",")}` : "";
    const rows = this.#client.query(`SELECT ${quotedCols} FROM "${name}"${order} LIMIT ${limit}`).all() as Record<
      string,
      unknown
    >[];
    return rows.map((row) => columns.map((c) => row[c.name]));
  }

  async runForeignKeysCheck(): Promise<
    readonly { table: string; rowid: number | null; parent: string; fkid: number }[]
  > {
    return this.#client.query("PRAGMA foreign_key_check").all() as {
      table: string;
      rowid: number | null;
      parent: string;
      fkid: number;
    }[];
  }

  async foreignKeysEnabled(): Promise<boolean> {
    const row = this.#client.query("PRAGMA foreign_keys").get() as { foreign_keys: number } | null;
    return row?.foreign_keys === 1;
  }

  async finishAndClose(): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    try {
      // Fold the WAL into the main file so the delivered .db is self-contained
      // (no -wal/-shm sidecars), then restore production FK enforcement and
      // assert the boot invariant from kanban 4.4.
      const checkpoint = this.#client.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
        busy: number;
        log: number;
        checkpointed: number;
      } | null;
      if (checkpoint !== null && checkpoint !== undefined && checkpoint.busy > 0) {
        throw new Error(`WAL checkpoint left ${checkpoint.busy} frame(s) busy; exported database may be incomplete`);
      }
      this.#client.run("PRAGMA foreign_keys = ON;");
      const fk = this.#client.query("PRAGMA foreign_keys").get() as { foreign_keys: number } | null;
      if (fk?.foreign_keys !== 1) {
        throw new Error("Failed to re-enable foreign key enforcement on the exported database");
      }
    } finally {
      // The handle is always released, even when checkpoint/FK validation fails.
      this.#client.close();
    }
  }
}

// ---------------------------------------------------------------------------
// SQLite source
// ---------------------------------------------------------------------------

/** Stream rows from a bun:sqlite connection with keyset/offset pagination. */
async function streamSqliteRows(
  client: Database,
  name: string,
  columns: readonly TransferColumn[],
  batchSize: number,
  onBatch: (rows: readonly (readonly unknown[])[]) => Promise<void> | void,
): Promise<void> {
  const quotedCols = columns.map((c) => `"${c.name}"`).join(",");
  const primaryKey = columns.filter((c) => c.primary).map((c) => c.name);
  if (primaryKey.length === 1) {
    // Keyset pagination: stable for tables mutated during the copy and
    // memory-bounded regardless of table size.
    let last: unknown = null;
    let started = false;
    for (;;) {
      const rows = (started
        ? client.query(`SELECT ${quotedCols} FROM "${name}" WHERE "${primaryKey[0]}" > ? ORDER BY "${primaryKey[0]}" LIMIT ${batchSize}`)
        : client.query(`SELECT ${quotedCols} FROM "${name}" ORDER BY "${primaryKey[0]}" LIMIT ${batchSize}`))
        .all(...(started ? [last as string | number | bigint | null] : [])) as Record<string, unknown>[];
      if (rows.length === 0) return;
      await onBatch(rows.map((row) => columns.map((c) => row[c.name])));
      started = true;
      last = rows[rows.length - 1]?.[primaryKey[0] as string] ?? null;
    }
  }
  // No single-column PK: offset pagination (join tables are small).
  let offset = 0;
  for (;;) {
    const rows = client.query(
      `SELECT ${quotedCols} FROM "${name}" LIMIT ${batchSize} OFFSET ${offset}`,
    ).all() as Record<string, unknown>[];
    if (rows.length === 0) return;
    await onBatch(rows.map((row) => columns.map((c) => row[c.name])));
    offset += rows.length;
  }
}

export class SqliteTransferSource implements TransferSource {
  readonly #client: Database;

  constructor(path: string) {
    this.#client = new Database(path, { create: false, readonly: true });
  }

  async ping(): Promise<void> {
    this.#client.query("SELECT 1").get();
  }

  async hasTable(name: string): Promise<boolean> {
    const row = this.#client.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
      | Record<string, unknown>
      | null;
    return row !== null && row !== undefined;
  }

  async count(name: string): Promise<number> {
    const row = this.#client.query(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number } | null;
    return row?.n ?? 0;
  }

  async countWhere(name: string, condition: string, params: readonly (string | number | bigint | null)[]): Promise<number> {
    const row = this.#client.query(`SELECT COUNT(*) AS n FROM "${name}" WHERE ${condition}`).get(...params) as
      | { n: number }
      | null;
    return row?.n ?? 0;
  }

  async queryDistinctCount(name: string, columns: readonly string[]): Promise<number> {
    const quoted = columns.map((c) => `"${c}"`).join(",");
    const row = this.#client.query(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT ${quoted} FROM "${name}")`).get() as
      | { n: number }
      | null;
    return row?.n ?? 0;
  }

  async streamRows(
    name: string,
    columns: readonly TransferColumn[],
    batchSize: number,
    onBatch: (rows: readonly (readonly unknown[])[]) => Promise<void> | void,
  ): Promise<void> {
    await streamSqliteRows(this.#client, name, columns, batchSize, onBatch);
  }

  async readSampleRows(
    name: string,
    columns: readonly TransferColumn[],
    orderColumns: readonly string[],
    limit: number,
  ): Promise<readonly (readonly unknown[])[]> {
    const quotedCols = columns.map((c) => `"${c.name}"`).join(",");
    const order = orderColumns.length > 0 ? ` ORDER BY ${orderColumns.map((c) => `"${c}"`).join(",")}` : "";
    const rows = this.#client.query(`SELECT ${quotedCols} FROM "${name}"${order} LIMIT ${limit}`).all() as Record<
      string,
      unknown
    >[];
    return rows.map((row) => columns.map((c) => row[c.name]));
  }

  async beginSnapshot(): Promise<void> {
    // Read-only connection; no explicit snapshot needed.
  }

  async endSnapshot(): Promise<void> {
    this.#client.close();
  }
}

// ---------------------------------------------------------------------------
// Postgres source (via Bun's built-in sql client; zero extra dependencies)
// ---------------------------------------------------------------------------

/** Minimal structural typing for the Bun.SQL client (bun-types covers the module). */
export interface BunSqlConnection {
  unsafe<T = unknown>(query: string, values?: readonly unknown[]): Promise<readonly T[]>;
  end(options?: { timeout?: number }): Promise<void>;
}

interface BunSqlClientConstructor {
  new (options: { url: string; max?: number }): BunSqlConnection;
}

const SqlClient = (Bun as unknown as { SQL: BunSqlClientConstructor }).SQL;

export class PgTransferSource implements TransferSource {
  readonly #connection: BunSqlConnection;
  readonly #url: string;

  constructor(url: string) {
    this.#url = url;
    // max: 1 so the read-only snapshot (BEGIN ... READ ONLY) is legal: Bun's
    // sql client only permits manual transaction control on a single connection.
    this.#connection = new SqlClient({ url, max: 1 });
  }

  get url(): string {
    return this.#url;
  }

  async ping(): Promise<void> {
    await this.#connection.unsafe("SELECT 1");
  }

  async hasTable(name: string): Promise<boolean> {
    const rows = await this.#connection.unsafe<{ exists: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [name],
    );
    return rows[0]?.exists === true;
  }

  async count(name: string): Promise<number> {
    const rows = await this.#connection.unsafe<{ n: string | number }>(`SELECT COUNT(*) AS n FROM "${name}"`);
    return Number(rows[0]?.n ?? 0);
  }

  async countWhere(name: string, condition: string, params: readonly (string | number | bigint | null)[]): Promise<number> {
    // Bun's sql client does not support `?` placeholders (it rejects them with
    // a server-side syntax error); rewrite them to $1..$n positionally. The
    // condition itself comes from callers written against the sqlite dialect.
    let index = 0;
    const pgCondition = condition.replace(/\?/g, (): string => { index += 1; return `$${index}`; });
    const rows = await this.#connection.unsafe<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM "${name}" WHERE ${pgCondition}`,
      [...params],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async queryDistinctCount(name: string, columns: readonly string[]): Promise<number> {
    const quoted = columns.map((c) => `"${c}"`).join(",");
    const rows = await this.#connection.unsafe<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM (SELECT DISTINCT ${quoted} FROM "${name}") AS distinct_rows`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  async streamRows(
    name: string,
    columns: readonly TransferColumn[],
    batchSize: number,
    onBatch: (rows: readonly (readonly unknown[])[]) => Promise<void> | void,
  ): Promise<void> {
    const quotedCols = columns.map((c) => `"${c.name}"`).join(",");
    const primaryKey = columns.filter((c) => c.primary).map((c) => c.name);
    if (primaryKey.length === 1) {
      let last: unknown = null;
      let started = false;
      for (;;) {
        const sql = started
          ? `SELECT ${quotedCols} FROM "${name}" WHERE "${primaryKey[0]}" > $1 ORDER BY "${primaryKey[0]}" LIMIT $2`
          : `SELECT ${quotedCols} FROM "${name}" ORDER BY "${primaryKey[0]}" LIMIT $1`;
        let rows: readonly Record<string, unknown>[];
        try {
          rows = await this.#connection.unsafe<Record<string, unknown>>(
            sql,
            started ? [last, batchSize] : [batchSize],
          );
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`PgTransferSource.streamRows failed on table "${name}" (${sql}): ${message}`);
        }
        if (rows.length === 0) return;
        await onBatch(rows.map((row) => columns.map((c) => row[c.name])));
        started = true;
        last = rows[rows.length - 1]?.[primaryKey[0] as string] ?? null;
      }
    }
    let offset = 0;
    for (;;) {
      const rows = await this.#connection.unsafe<Record<string, unknown>>(
        `SELECT ${quotedCols} FROM "${name}" LIMIT $1 OFFSET $2`,
        [batchSize, offset],
      );
      if (rows.length === 0) return;
      await onBatch(rows.map((row) => columns.map((c) => row[c.name])));
      offset += rows.length;
    }
  }

  async readSampleRows(
    name: string,
    columns: readonly TransferColumn[],
    orderColumns: readonly string[],
    limit: number,
  ): Promise<readonly (readonly unknown[])[]> {
    const quotedCols = columns.map((c) => `"${c.name}"`).join(",");
    const order = orderColumns.length > 0 ? ` ORDER BY ${orderColumns.map((c) => `"${c}"`).join(",")}` : "";
    const rows = await this.#connection.unsafe<Record<string, unknown>>(
      `SELECT ${quotedCols} FROM "${name}"${order} LIMIT $1`,
      [limit],
    );
    return rows.map((row) => columns.map((c) => row[c.name]));
  }

  async beginSnapshot(): Promise<void> {
    // One consistent snapshot for the whole copy: concurrent writers cannot
    // leak into the export, and the source database is never modified.
    await this.#connection.unsafe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  }

  async endSnapshot(): Promise<void> {
    try {
      await this.#connection.unsafe("COMMIT");
    } catch {
      try {
        await this.#connection.unsafe("ROLLBACK");
      } catch {
        // connection is gone; nothing left to release
      }
    }
    await this.#connection.end({ timeout: 1 });
  }
}

// ---------------------------------------------------------------------------
// Transfer + verification
// ---------------------------------------------------------------------------

export interface TransferProgress {
  readonly table: string;
  readonly rowsCopied: number;
}

export interface TransferTableReport {
  readonly name: string;
  readonly rowsCopied: number;
}

export interface TransferReport {
  readonly tables: readonly TransferTableReport[];
  readonly totalRows: number;
}

export interface TransferOptions {
  readonly batchSize?: number;
  readonly onProgress?: (progress: TransferProgress) => void;
  /**
   * Keep the source snapshot open after the copy so the caller can still read
   * the source (e.g. verification against the same snapshot). The caller is
   * then responsible for calling source.endSnapshot().
   */
  readonly keepSnapshotOpen?: boolean;
}

/** Copy every schema table from source to target, parents before children. */
export async function transferDatabase(
  source: TransferSource,
  target: TransferTarget,
  options: TransferOptions = {},
): Promise<TransferReport> {
  const tables = schemaTables();
  const edges = await target.listForeignKeys();
  const ordered = topologicalOrder(tables.map((t) => t.name), edges);
  const byName = new Map(tables.map((t) => [t.name, t]));

  await source.ping();
  for (const table of tables) {
    if (!(await source.hasTable(table.name))) {
      throw new Error(
        `Source database is missing table "${table.name}"; the Postgres schema does not match this Terrence version`,
      );
    }
  }

  const batchSize = options.batchSize ?? 200;
  const report: TransferTableReport[] = [];
  let totalRows = 0;

  await source.beginSnapshot();
  try {
    for (const name of ordered) {
      const table = byName.get(name);
      if (table === undefined) continue;
      await target.beginTable(name);
      let copied = 0;
      try {
        await source.streamRows(table.name, table.columns, batchSize, async (rows) => {
          await target.insertRows(table.name, table.columns, rows);
          copied += rows.length;
          options.onProgress?.({ table: table.name, rowsCopied: copied });
        });
      } catch (error) {
        // The failed batch already rolled back; earlier tables stay
        // committed so a retried transfer resumes from this table.
        throw error;
      }
      await target.commitTable(name);
      report.push({ name: table.name, rowsCopied: copied });
      totalRows += copied;
    }
  } finally {
    if (options.keepSnapshotOpen !== true) {
      await source.endSnapshot();
    }
  }
  return { tables: report, totalRows };
}

// ---------------------------------------------------------------------------
// Verification (mirrors the forward path: counts, invariants, FKs, hashes)
// ---------------------------------------------------------------------------

export interface UniqueCheckResult {
  readonly index: string;
  readonly columns: readonly string[];
  readonly source: number;
  readonly target: number;
  readonly match: boolean;
}

export interface TableVerification {
  readonly table: string;
  readonly sourceCount: number;
  readonly targetCount: number;
  readonly countMatch: boolean;
  readonly uniqueChecks: readonly UniqueCheckResult[];
  readonly sampleHash: {
    readonly source: string;
    readonly target: string;
    readonly match: boolean;
    readonly rowsHashed: number;
  };
}

export interface VerificationReport {
  readonly tables: readonly TableVerification[];
  readonly foreignKeyViolations: readonly { table: string; rowid: number | null; parent: string; fkid: number }[];
  readonly foreignKeysEnabled: boolean;
  readonly allPassed: boolean;
  readonly totalRowsSource: number;
  readonly totalRowsTarget: number;
}

export interface VerifyOptions {
  /** Max rows hashed per table (sample hash). */
  readonly sampleLimit?: number;
}

const SAMPLE_LIMIT_DEFAULT = 1000;

/**
 * Verify the copy end to end. All checks must pass for the report to be
 * `allPassed`; failures are reported per table so the UI can show exactly
 * which invariant broke.
 */
export async function verifyTransfer(
  source: TransferSource,
  target: TransferTarget,
  options: VerifyOptions = {},
): Promise<VerificationReport> {
  const tables = schemaTables();
  const uniqueIndexes = await target.listUniqueIndexes();
  const byIndexTable = new Map<string, UniqueIndex[]>();
  for (const index of uniqueIndexes) {
    const list = byIndexTable.get(index.table) ?? [];
    list.push(index);
    byIndexTable.set(index.table, list);
  }

  const perTable: TableVerification[] = [];
  let totalRowsSource = 0;
  let totalRowsTarget = 0;
  for (const table of tables) {
    const sourceCount = await source.count(table.name);
    const targetCount = await target.count(table.name);
    totalRowsSource += sourceCount;
    totalRowsTarget += targetCount;

    const uniqueChecks: UniqueCheckResult[] = [];
    for (const index of byIndexTable.get(table.name) ?? []) {
      const [sourceDistinct, targetDistinct] = await Promise.all([
        source.queryDistinctCount(table.name, index.columns),
        target.queryDistinctCount(table.name, index.columns),
      ]);
      uniqueChecks.push({
        index: index.name,
        columns: index.columns,
        source: sourceDistinct,
        target: targetDistinct,
        match: sourceDistinct === targetDistinct,
      });
    }

    const [sourceDigest, targetDigest] = await Promise.all([
      digestTable(source, table, options),
      digestTable(target, table, options),
    ]);

    perTable.push({
      table: table.name,
      sourceCount,
      targetCount,
      countMatch: sourceCount === targetCount,
      uniqueChecks,
      sampleHash: {
        source: sourceDigest.digest,
        target: targetDigest.digest,
        match: sourceDigest.digest === targetDigest.digest,
        rowsHashed: sourceDigest.rows,
      },
    });
  }

  const foreignKeyViolations = await target.runForeignKeysCheck();
  const foreignKeysEnabled = await target.foreignKeysEnabled();
  // foreign_key_check works regardless of enforcement and is the integrity
  // gate here. `foreignKeysEnabled` is reported for context but is NOT part
  // of allPassed: the SQLite target deliberately copies with enforcement OFF
  // (it is restored and validated by finishAndClose, which throws on failure).
  const allPassed = foreignKeyViolations.length === 0
    && perTable.every((t) => t.countMatch
      && t.uniqueChecks.every((u) => u.match)
      && t.sampleHash.match);
  return {
    tables: perTable,
    foreignKeyViolations,
    foreignKeysEnabled,
    allPassed,
    totalRowsSource,
    totalRowsTarget,
  };
}

// ---------------------------------------------------------------------------
// Concrete source/target factories (shared by wizard + export)
// ---------------------------------------------------------------------------

/** Fresh SQLite database with the full Terrence schema (migrations). */
export function createSqliteTarget(path: string, options: SqliteTargetOptions = {}): SqliteTransferTarget {
  return SqliteTransferTarget.create(path, options);
}

/** Read-only SQLite source (tests, and the wizard's forward direction). */
export function createSqliteSource(path: string): SqliteTransferSource {
  return new SqliteTransferSource(path);
}

/** Postgres source over Bun's built-in sql client. */
export function createPgSource(url: string): PgTransferSource {
  return new PgTransferSource(url);
}
