import { Database } from 'bun:sqlite';
import { drizzle as sqliteDrizzle, SQLiteBunTransaction, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { SQLiteBunSession } from 'drizzle-orm/bun-sqlite';
import type { SQLiteSession, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { migrate as sqliteMigrate } from 'drizzle-orm/bun-sqlite/migrator';
import { reconcileSparseMigrationJournal, sparseJournalReconcilePlan, readBundledMigrationJournal } from './reconcile';
import { SQL as BunSQL } from 'bun';
import { drizzle as pgDrizzle } from 'drizzle-orm/bun-sql';
import { type SQL } from 'drizzle-orm';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'path';
import * as schema from './schema';
import { envEnabled } from '../lib/env';
import { databaseUrl, isPostgres, storageDir } from './driver';
import { poolMetrics, poolQueryEnd, poolQueryStart, poolTransactionEnd, poolTransactionStart, recordSlowQuery } from '../lib/db-pool-metrics';

// Deliberately synchronous: a top-level await here made this module a TLA
// module, and Bun's worker threads can resolve importers while the TLA is
// still pending (ReferenceError: Cannot access 'db' before initialization
// in every bun test worker). mkdirSync is behavior-identical.
mkdirSync(storageDir, { recursive: true });

// Opt-in SQL query instrumentation for the benchmark suite
// (TERRENCE_QUERY_COUNT=1). On sqlite, drizzle routes every statement
// through client.prepare(), so counting prepares counts queries. On postgres
// every statement lands in client.unsafe(). Zero overhead when the env var
// is unset (the wrappers are never installed). Set TERRENCE_QUERY_LOG=1
// alongside it to also capture the SQL text.
let queryCount = 0;
const queryLog: string[] = [];
let queryLogEnabled = envEnabled(process.env.TERRENCE_QUERY_LOG);

// ---------------------------------------------------------------------------
// SQLite backend (default): bun:sqlite keeps a single stable native
// connection; the @libsql/client driver leaked native memory per query and
// churned a fresh native connection for every transaction (the source of
// terrence's multi-GB RSS growth).
// ---------------------------------------------------------------------------
let sqliteClient: Database | null = null;
if (!isPostgres) {
  const dbUrl = databaseUrl;
  sqliteClient = new Database(dbUrl === ':memory:' ? ':memory:' : dbUrl.replace(/^file:/, ''), { create: true });
  const client = sqliteClient;
  client.run('PRAGMA journal_mode = WAL;');
  client.run('PRAGMA busy_timeout = 5000;');
  // bun:sqlite defaults foreign_keys to OFF per-connection; enable enforcement
  // explicitly so referential integrity holds (drizzle's migrate() does not set it).
  client.run('PRAGMA foreign_keys = ON;');

  if (envEnabled(process.env.TERRENCE_QUERY_COUNT)) {
    const originalPrepare = client.prepare.bind(client);
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types, @typescript-eslint/explicit-function-return-type -- mirrors bun:sqlite's generic prepare() signature that an explicit return type cannot widen.
    client.prepare = ((sqlText: string, ...params: unknown[]) => {
      queryCount += 1;
      if (queryLogEnabled) queryLog.push(sqlText);
      return originalPrepare(sqlText, ...(params as [never]));
    });
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL backend: Bun.SQL pooled client. Schema DDL comes from the
// generated drizzle-pg migrations, applied at boot (backend/index.ts) and in
// the test harness (tests/setup.ts) — never here, because the migrator is
// async and this module must stay synchronous for bun's worker threads.
// ---------------------------------------------------------------------------
function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return fallback;
  // Clamp to 24h so a typo (e.g. seconds vs ms) cannot disable the guard.
  return Math.min(Math.round(n), 86_400_000);
}

const PG_QUERY_DERIVERS = ['execute', 'raw', 'simple', 'values'] as const;

/** Keep Bun.SQL's lazy Query object intact while recording one lifecycle. */
export function wrapPgQuery<T>(queryObj: T, queryText: string): T {
  const start = poolQueryStart(10);
  let settled = false;
  const attached = new WeakSet<object>();
  const finish = (): void => {
    if (settled) return;
    settled = true;
    const durationMs = poolQueryEnd(start);
    recordSlowQuery(queryText, durationMs);
  };
  const attach = (target: unknown): void => {
    if (target === null || typeof target !== 'object' || attached.has(target)) return;
    const query = target as Record<string, unknown>;
    if (typeof query.then !== 'function') {
      finish();
      return;
    }
    attached.add(target);

    const originalThen = query.then.bind(target) as (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (error: unknown) => unknown,
    ) => unknown;
    query.then = (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (error: unknown) => unknown,
    ): unknown => originalThen(
      (value: unknown): unknown => {
        finish();
        return onFulfilled === undefined ? value : onFulfilled(value);
      },
      (error: unknown): unknown => {
        finish();
        if (onRejected !== undefined) return onRejected(error);
        throw error;
      },
    );

    if (typeof query.catch === 'function') {
      const originalCatch = query.catch.bind(target) as (onRejected: (error: unknown) => unknown) => unknown;
      query.catch = (onRejected: (error: unknown) => unknown): unknown => originalCatch((error: unknown): unknown => {
        finish();
        return onRejected(error);
      });
    }

    for (const method of PG_QUERY_DERIVERS) {
      if (typeof query[method] !== 'function') continue;
      const original = query[method].bind(target) as (...args: unknown[]) => unknown;
      query[method] = (...args: unknown[]): unknown => {
        const derived = original(...args);
        attach(derived);
        return derived;
      };
    }
  };
  attach(queryObj);
  return queryObj;
}

let pgClient: BunSQL | null = null;
if (isPostgres) {
  const statementTimeoutMs = parseTimeoutMs(process.env.TERRENCE_DB_STATEMENT_TIMEOUT_MS, 30_000);
  const lockTimeoutMs = parseTimeoutMs(process.env.TERRENCE_DB_LOCK_TIMEOUT_MS, 10_000);
  const idleInTxTimeoutMs = parseTimeoutMs(process.env.TERRENCE_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS, 60_000);
  pgClient = new BunSQL({
    url: databaseUrl,
    max: 10,
    idleTimeout: 20,
    connectionTimeout: 10,
    // Fail-safe: a stuck query / contended lock / idle transaction is killed
    // server-side instead of holding a pool connection forever (todos 287/288).
    connection: {
      statement_timeout: statementTimeoutMs,
      lock_timeout: lockTimeoutMs,
      idle_in_transaction_session_timeout: idleInTxTimeoutMs,
    },
  });
  // Always-on lightweight pool observation (todos 289,290,291): pending + latency
  // samples are recorded for /metrics; zero branching in the hot path beyond
  // the counter bump. Wraps `unsafe` which is the underlying query path for
  // both drizzle and raw SQL on postgres.
  {
    const originalUnsafe = pgClient.unsafe.bind(pgClient);
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mirrors Bun.SQL's non-async unsafe() signature; the cast below is the type boundary.
    pgClient.unsafe = ((queryText: string, values?: unknown[] | Record<string, unknown>): ReturnType<BunSQL['unsafe']> => {
      const queryObj = originalUnsafe(queryText, values as never);
      return wrapPgQuery(queryObj, queryText);
    }) as typeof pgClient.unsafe;
  }
  if (envEnabled(process.env.TERRENCE_QUERY_COUNT)) {
    const originalUnsafe = pgClient.unsafe.bind(pgClient);
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- mirrors Bun.SQL's non-async unsafe() signature; the cast below is the type boundary.
    pgClient.unsafe = ((queryText: string, values?: unknown[] | Record<string, unknown>): ReturnType<BunSQL['unsafe']> => {
      queryCount += 1;
      if (queryLogEnabled) queryLog.push(queryText);
      return originalUnsafe(queryText, values as never);
    }) as typeof pgClient.unsafe;
  }
}

/** @public Used by the dynamically imported benchmark runner. */
export function resetQueryCount(): void {
  queryCount = 0;
  queryLog.length = 0;
}

/** @public Used by the dynamically imported benchmark runner. */
export function getQueryCount(): number {
  return queryCount;
}

/** @public Used by the dynamically imported benchmark runner. */
export function getQueryLog(): readonly string[] {
  return queryLog.slice();
}

/**
 * Toggle query-text capture at runtime (used by the benchmark runner's
 * --query-breakdown mode). Disabling clears the log so stale statements never
 * leak into a later breakdown. Zero cost while disabled: the hot path only
 * reads a boolean.
 */
/** @public Intentional surface: benchmark/test hook or cross-module API. */
export function setQueryLogging(enabled: boolean): void {
  queryLogEnabled = enabled;
  if (!enabled) queryLog.length = 0;
}

// The exported db is typed as the sqlite database: every call site compiles
// against the sqlite shapes (identical names and values on both backends).
// At runtime the instance matches the active driver. The schema generic is
// carried explicitly — ReturnType<typeof sqliteDrizzle> would instantiate
// with the default (empty) schema and type db.query as {}.
type AppDb = BunSQLiteDatabase<typeof schema>;
const sqliteDb = sqliteClient === null ? null : sqliteDrizzle(sqliteClient, { schema });
const pgDb = pgClient === null ? null : pgDrizzle({ client: pgClient, schema });
if (pgDb !== null) {
  // Drizzle exposes transactions on the database object rather than through
  // postgres.js's query hook, so instrument the boundary explicitly.
  const instrumented = pgDb as unknown as {
    transaction: (...args: never[]) => Promise<unknown>;
  };
  const originalTransaction = instrumented.transaction.bind(instrumented);
  instrumented.transaction = (async (callback: unknown, config?: unknown): Promise<unknown> => {
    const start = poolTransactionStart();
    try {
      return await originalTransaction(callback as never, config as never);
    } finally {
      poolTransactionEnd(start);
    }
  });
}
export const db = (isPostgres ? pgDb : sqliteDb) as unknown as AppDb;

// ---------------------------------------------------------------------------
// SQLite-only boot maintenance. All of it repairs legacy SQLite databases
// (pre-squash journal islands, pre-id-format rows) and is a no-op on fresh
// databases; the postgres backend always boots from the drizzle-pg
// migrations, so none of it applies there.
// ---------------------------------------------------------------------------
if (!isPostgres) {
  const client = sqliteClient!;

  // bun:sqlite's native transaction() rolls back only when its callback throws
  // synchronously; drizzle-orm/bun-sqlite delegates transaction() straight to it, so
  // an async callback that throws would silently COMMIT partial writes. Wrap it with
  // explicit BEGIN/COMMIT/ROLLBACK that awaits the callback instead. Queue callbacks
  // because every async transaction shares this one native connection.
  const session = (db as unknown as { session: SQLiteBunSession<Record<string, unknown>, never> }).session;
  let transactionTail = Promise.resolve();
  (session as unknown as { transaction: unknown }).transaction = async function (
    // The callback signature mirrors drizzle's own session.transaction type.
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    fn: (tx: SQLiteBunTransaction<Record<string, unknown>, never>) => Promise<unknown>,
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    config?: { behavior?: 'deferred' | 'immediate' | 'exclusive' },
  ): Promise<unknown> {
    const sess = this as unknown as { dialect: SQLiteSyncDialect; schema: unknown };
    const run = async (): Promise<unknown> => {
      const tx = new SQLiteBunTransaction<Record<string, unknown>, never>(
        'sync',
        sess.dialect,
        this as unknown as SQLiteSession<'sync', void, Record<string, unknown>, never>,
        sess.schema as never,
      );
      const behavior = config?.behavior !== undefined ? ` ${config.behavior.toUpperCase()}` : '';
      client.run(`BEGIN${behavior}`);
      const transactionStart = poolTransactionStart();
      try {
        const result = await fn(tx);
        client.run('COMMIT');
        return result;
      } catch (err) {
        client.run('ROLLBACK');
        throw err;
      } finally {
        poolTransactionEnd(transactionStart);
      }
    };
    const transaction = transactionTail.then(run, run);
    transactionTail = transaction.then((): undefined => undefined, (): undefined => undefined);
    return transaction;
  };

  // Run pending drizzle migrations. The PRAGMA dance mirrors the
  // historical table-rebuild migrations (0022/0023) that drop/recreate
  // parent tables while FK enforcement and trigger-body rewriting would
  // otherwise break the rebuild. Prod is already at 41/41 and fresh DBs
  // start from the squashed baseline, so this is now just the canonical
  // migrator call with the safety wrapper intact.
  client.run("PRAGMA foreign_keys = OFF;");
  client.run("PRAGMA legacy_alter_table = ON;");
  try {
    sqliteMigrate(db, { migrationsFolder: join(import.meta.dir, '../../drizzle') });
  } finally {
    client.run("PRAGMA legacy_alter_table = OFF;");
    client.run("PRAGMA foreign_keys = ON;");
  }

  // Reconcile a sparse/forward-dated journal before the app serves traffic
  // (2026-08-23 prod incident, sqlite parity with applyPgMigrations): stamp
  // journal rows and run any missing statements for migrations whose objects
  // already exist or were skipped. A journal whose newest row is newer than
  // every bundled migration (a corrupted/forward-dated journal) is treated as
  // unreliable so every bundled entry is reconsidered. The boot path is
  // synchronous, so drive sparseJournalReconcilePlan() directly with the
  // native client (the postgres path uses the async adapter instead).
  try {
    const bundledFolder = join(import.meta.dir, '../../drizzle');
    const entries = readBundledMigrationJournal(bundledFolder);
    const appliedRows = (client.query("SELECT hash, created_at FROM __drizzle_migrations").all() as Array<{ hash: string; created_at: number }>).map(
      (row): { readonly hash: string; readonly createdAt: number } => ({ hash: row.hash, createdAt: row.created_at }),
    );
    const tables = new Set(
      (client.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row): string => row.name),
    );
    const indexes = new Set(
      (client.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((row): string => row.name),
    );
    const columns = new Set(
      (client.query("PRAGMA table_info").all() as Array<{ tbl_name: string; name: string }>).map(
        (row): string => `${row.tbl_name}.${row.name}`,
      ),
    );
    const plan = sparseJournalReconcilePlan(bundledFolder, entries, { appliedRows, tables, indexes, columns });
    for (const entry of plan) {
      for (const statement of entry.statements) {
        if (!statement.skip) client.run(statement.sql);
      }
      client.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [entry.hash, entry.when]);
    }
    if (plan.length > 0) console.warn(`[terrence] sparse migration journal reconciled (sqlite): reconciled ${plan.length} migration(s) outside the migrator`);
  } catch (err) {
    // Reconciliation is a best-effort repair; a failure here must not abort
    // boot (the migrator already ran). Surface it for operators.
    console.error("[terrence] sqlite journal reconciliation failed:", err);
  }
}

/**
 * Fold the WAL back into the main database file. Called on graceful
 * shutdown so backups and migrations see a single self-contained file
 * instead of a live -wal sidecar (kanban 4.17). Postgres runs WAL
 * continuously server-side; there is no sidecar to fold, so this is a
 * deliberate no-op there.
 */
export function checkpointWal(): void {
  if (isPostgres) return;
  const client = sqliteClient!;
  // wal_checkpoint(TRUNCATE) reports { busy, log, checkpointed }; a nonzero
  // busy count means frames could not be flushed (a concurrent writer or a
  // read transaction still holding the WAL), so the main DB file is not yet
  // complete. Fail loudly instead of discarding the result (kanban 4.17).
  type WalCheckpointRow = { busy: number; log: number; checkpointed: number; }
  const row = client.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as WalCheckpointRow | null | undefined;
  if (row !== null && row !== undefined && row.busy > 0) {
    throw new Error(`WAL checkpoint left ${row.busy} frame(s) busy; main DB file may be incomplete`);
  }
}

/**
 * Live disk-pressure numbers for the admin dashboard: on-disk DB size, WAL
 * sidecar size, journal mode, and page geometry (kanban 4.18). Postgres
 * reports the same shape from pg_database_size + block_size settings.
 */
export async function databaseMetrics(): Promise<Readonly<{
  sizeBytes: number;
  walSizeBytes: number | null;
  journalMode: string;
  pageSize: number;
  pageCount: number;
  path: string;
  /**
   * SQLite page-cache budget in bytes (PRAGMA cache_size: positive = pages,
   * negative = KiB). Null on postgres, which manages its own shared buffers.
   */
  cacheSizeBytes: number | null;
  /**
   * Freelist pages in bytes: free pages not yet returned to the OS. A
   * steadily growing freelist indicates db bloat (churn + no VACUUM).
   * Null on postgres.
   */
  freelistBytes: number | null;
}>> {
  if (isPostgres) {
    const client = pgClient!;
    const rows = await client.unsafe(
      "SELECT pg_database_size(current_database()) AS size, current_setting('block_size')::int AS \"blockSize\"",
    ) as unknown as readonly { size: number | bigint; blockSize: number }[];
    const sizeBytes = Number(rows[0]?.size ?? 0);
    const pageSize = Number(rows[0]?.blockSize ?? 8192);
    // The URL may embed credentials; surface only host + database name.
    let path = "postgres";
    try {
      const parsed = new URL(databaseUrl);
      path = `postgres://${parsed.hostname}${parsed.pathname}`;
    } catch {
      // Unparseable URL: keep the bare label.
    }
    return {
      sizeBytes,
      walSizeBytes: null,
      // Postgres always journals via WAL; there is no mode switch.
      journalMode: "wal",
      pageSize,
      pageCount: pageSize > 0 ? Math.floor(sizeBytes / pageSize) : 0,
      path,
      cacheSizeBytes: null,
      freelistBytes: null,
    };
  }
  const client = sqliteClient!;
  const dbPath = databaseUrl === ':memory:' ? ':memory:' : databaseUrl.replace(/^file:/, '');
  const pageSize = (client.query("PRAGMA page_size").get() as { page_size: number } | null)?.page_size ?? 4096;
  const pageCount = (client.query("PRAGMA page_count").get() as { page_count: number } | null)?.page_count ?? 0;
  const journalMode = (client.query("PRAGMA journal_mode").get() as { journal_mode: string } | null)?.journal_mode ?? "unknown";
  let sizeBytes = 0;
  let walSizeBytes: number | null = null;
  if (dbPath !== ":memory:") {
    try {
      sizeBytes = statSync(dbPath).size;
    } catch {
      sizeBytes = 0;
    }
    try {
      walSizeBytes = statSync(`${dbPath}-wal`).size;
    } catch {
      walSizeBytes = 0;
    }
  }
  return { sizeBytes, walSizeBytes, journalMode, pageSize, pageCount, path: dbPath, cacheSizeBytes: sqliteCacheSizeBytes(client, pageSize), freelistBytes: sqliteFreelistBytes(client, pageSize) };
}

/** SQLite page-cache budget in bytes: PRAGMA cache_size is pages when positive, KiB when negative. */
function sqliteCacheSizeBytes(client: Database, pageSize: number): number {
  const raw = (client.query("PRAGMA cache_size").get() as { cache_size: number } | null)?.cache_size ?? 0;
  return raw > 0 ? raw * pageSize : -raw * 1024;
}

/** SQLite freelist footprint in bytes (free pages not yet returned to the OS). */
function sqliteFreelistBytes(client: Database, pageSize: number): number {
  const freelist = (client.query("PRAGMA freelist_count").get() as { freelist_count: number } | null)?.freelist_count ?? 0;
  return freelist * pageSize;
}

/**
 * Execute a raw SQL fragment and return all rows, portably across backends.
 * sqlite returns rows synchronously; postgres returns a promise — `await`
 * handles both.
 */
export function rawQueryAll<T>(fragment: SQL): Promise<T[]> | T[] {
  if (isPostgres) {
    const dbInstance = pgDb;
    if (dbInstance === null) throw new Error("postgres backend not initialized");
    return dbInstance.execute(fragment).then((result): T[] => Array.from(result) as T[]);
  }
  return db.all<T>(fragment);
}

// Re-export the active-driver flag so consumers can branch on backend
// behavior (e.g. raw-SQL dialect shims) with a single import.
// databaseDriver itself is not re-exported: nothing consumes it outside
// src/db/driver.ts (knip-verified).
export { isPostgres };

export function databasePoolMetrics(): ReturnType<typeof poolMetrics> {
  const max = isPostgres ? 10 : 1;
  const driver = isPostgres ? 'postgres' as const : 'sqlite' as const;
  return poolMetrics(driver, max);
}

/** @public Cleanly close the database connection/pool (application shutdown, tests). */
export async function closeDatabase(): Promise<void> {
  if (sqliteClient !== null) {
    sqliteClient.close();
  }
  if (pgClient !== null) {
    await pgClient.close();
  }
}

let cachedSchemaVersion: string | null | undefined;
/** Drizzle journal tag of the last migration bundled with this build (e.g. "0028_melodic_micromax").
 * This is the packaged *target* schema, not the DB-applied state — during a
 * rolling deploy the new image may report the new tag before the database has
 * been migrated. Callers that need the applied state should read the
 * `__drizzle_migrations` history table in the connected database.
 * Memoized: the journal is a build artifact that never changes at runtime.
 */
export function databaseSchemaVersion(): string | null {
  if (cachedSchemaVersion !== undefined) return cachedSchemaVersion;
  try {
    const journalPath = isPostgres
      ? fileURLToPath(new URL("../../drizzle/pg/meta/_journal.json", import.meta.url))
      : fileURLToPath(new URL("../../drizzle/meta/_journal.json", import.meta.url));
    const raw = readFileSync(journalPath, "utf8");
    const tag = (JSON.parse(raw) as { entries?: { tag?: string }[] }).entries?.slice(-1)[0]?.tag;
    cachedSchemaVersion = typeof tag === "string" && tag !== "" ? tag : null;
    return cachedSchemaVersion;
  } catch { cachedSchemaVersion = null; return null; }
}

// Wrappers for transaction latency (todo 291): callers in db-layer wrap
// transaction bodies with these helpers so wall time is captured.
// poolTransaction helpers are available from lib/db-pool-metrics directly when needed

/**
 * Apply the PostgreSQL schema migrations (drizzle/pg). The sqlite migrator
 * runs synchronously at module load; the postgres migrator is async, so it
 * is invoked explicitly from the boot path (backend/index.ts) and the test
 * harness (tests/setup.ts). Memoized: safe to call from both.
 */
let pgMigrationsPromise: Promise<void> | null = null;
export async function applyPgMigrations(): Promise<void> {
  if (!isPostgres) return Promise.resolve();
  if (pgMigrationsPromise !== null) return pgMigrationsPromise;
  pgMigrationsPromise = (async (): Promise<void> => {
    const instance = pgDb;
    if (instance === null) throw new Error("postgres backend not initialized");
    const pg = pgClient!;
    const durableJobsTable = await pg.unsafe<{ exists: boolean }[]>("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'durable_jobs') AS exists");
    if (durableJobsTable[0]?.exists === true) {
      await pg.unsafe(`
        WITH ranked AS (
          SELECT id, row_number() OVER (
            PARTITION BY kind, dedupe_key
            ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
              updated_at DESC, created_at DESC, id
          ) AS row_rank
          FROM durable_jobs
          WHERE dedupe_key IS NOT NULL
        )
        UPDATE durable_jobs
        SET dedupe_key = NULL
        FROM ranked
        WHERE durable_jobs.id = ranked.id AND ranked.row_rank > 1
      `);
    }
    const { migrate } = await import("drizzle-orm/bun-sql/migrator");
    // Reconcile a sparse journal before migrating (2026-08-23 prod incident,
    // sqlite parity): stamp journal rows for migrations whose objects already
    // exist outside the journal, so the migrator never replays them.
    // Fresh databases have no journal yet — mirror the migrator's own
    // bootstrap DDL (schema + table) so the reads below always succeed.
    await pg.unsafe('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await pg.unsafe(`CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`);
    // SQL result rows carry snake_case columns verbatim; quote the property
    // names so they satisfy the camelCase naming rule without renaming.
    const stampedPg = await reconcileSparseMigrationJournal({
      bundledFolder: join(import.meta.dir, "../../drizzle/pg"),
      appliedRows: async (): Promise<readonly { readonly hash: string; readonly createdAt: number }[]> =>
        // eslint-disable-next-line @typescript-eslint/naming-convention -- SQL row fields keep their wire names.
        (await pg.unsafe<{ hash: string; "created_at": string | number }[]>("SELECT hash, created_at FROM drizzle.__drizzle_migrations")).map(
          ({ hash, "created_at": createdAt }): { readonly hash: string; readonly createdAt: number } => ({ hash, createdAt: Number(createdAt) }),
        ),
      existingTables: async (): Promise<readonly string[]> =>
        (
          await pg.unsafe<{ "table_name": string }[]>( // eslint-disable-line @typescript-eslint/naming-convention -- SQL row fields keep their wire names.
            "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()",
          )
        ).map(({ "table_name": tableName }): string => tableName),
      existingIndexes: async (): Promise<readonly string[]> =>
        (await pg.unsafe<{ indexname: string }[]>("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()")).map(
          ({ indexname }): string => indexname,
        ),
      existingColumns: async (): Promise<readonly { readonly table: string; readonly column: string }[]> =>
        (
          // eslint-disable-next-line @typescript-eslint/naming-convention -- SQL row fields keep their wire names.
          await pg.unsafe<{ "table_name": string; "column_name": string }[]>(
            "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()",
          )
        ).map(({ "table_name": tableName, "column_name": columnName }): { readonly table: string; readonly column: string } => ({
          table: tableName,
          column: columnName,
        })),
      runStatement: async (sql: string): Promise<void> => {
        await pg.unsafe(sql);
      },
      markApplied: async (hash: string, createdAt: number): Promise<void> => {
        await pg.unsafe('INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES($1, $2)', [hash, createdAt]);
      },
    });
    if (stampedPg > 0) console.warn(`[terrence] sparse migration journal reconciled (pg): reconciled ${stampedPg} migration(s) outside the migrator`);
    await migrate(instance, { migrationsFolder: join(import.meta.dir, "../../drizzle/pg") });
    await pg.unsafe("UPDATE organizations SET default_iac_binary = 'terraform' WHERE default_iac_binary = 'tofu'");
    await pg.unsafe("UPDATE policy_sets SET overridable = false WHERE overridable = true");
    await pg.unsafe("UPDATE team_projects SET organization_id = projects.org_id FROM projects WHERE team_projects.organization_id IS NULL AND projects.id = team_projects.project_id");
    // Hot-path query indexes (benchmarked: queue scan 200x, workspace run
    // lists 36x, calendar range 17x faster). Fresh installs get them from the
    // schema; running deployments get an idempotent backfill here.
    await pg.unsafe("CREATE INDEX IF NOT EXISTS runs_workspace_status_created_idx ON runs (workspace_id, status, created_at)");
    await pg.unsafe("CREATE INDEX IF NOT EXISTS runs_status_created_idx ON runs (status, created_at)");
    await pg.unsafe("CREATE INDEX IF NOT EXISTS runs_status_scheduled_idx ON runs (status, scheduled_at)");
    // Configuration-version upload-claim lease (todo 278, see sqlite boot path).
    await pg.unsafe("ALTER TABLE configuration_versions ADD COLUMN IF NOT EXISTS upload_claim_expires_at bigint");
    // TOTP seed at-rest encryption (todo 110-112, see sqlite boot path).
    await pg.unsafe("ALTER TABLE user_2fa ADD COLUMN IF NOT EXISTS secret_encrypted text");
    // Refresh-session two-tab concurrency grace (todo 125-127, see sqlite boot path).
    await pg.unsafe("ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS successor_hash text");
    await pg.unsafe("ALTER TABLE refresh_sessions ADD COLUMN IF NOT EXISTS rotated_at_ms bigint");
    // Sensitive-variable at-rest encryption (todo 167-169, see sqlite boot path).
    await pg.unsafe("ALTER TABLE workspace_variables ADD COLUMN IF NOT EXISTS value_encrypted text");
    await pg.unsafe("ALTER TABLE variable_set_variables ADD COLUMN IF NOT EXISTS value_encrypted text");
    await pg.unsafe("CREATE INDEX IF NOT EXISTS configuration_versions_workspace_created_idx ON configuration_versions (workspace_id, created_at)");
    await pg.unsafe("CREATE INDEX IF NOT EXISTS workspaces_org_idx ON workspaces (org_id)");
    // Agent heartbeat sweep (recoverStaleAgentJobs) filters on lastPingAt/status
    // every poll; keep it off a full table scan as agent volume grows.
    await pg.unsafe("CREATE INDEX IF NOT EXISTS agents_last_ping_at_status_idx ON agents (last_ping_at, status)");
    // Team-token legacy discriminator (see sqlite boot path): the singular
    // legacy team-token endpoints must only see the team's legacy credential.
    await pg.unsafe("ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS legacy boolean NOT NULL DEFAULT false");
    // OAuth handshake state (see sqlite boot path): persisted so any replica
    // can read/consume it. Idempotent so a re-applied boot path is safe.
    await pg.unsafe(`
      CREATE TABLE IF NOT EXISTS oauth_handshake_states (
        id TEXT PRIMARY KEY NOT NULL,
        expires_at BIGINT NOT NULL,
        payload JSONB NOT NULL
      )
    `);
    await pg.unsafe("CREATE INDEX IF NOT EXISTS oauth_handshake_states_expires_idx ON oauth_handshake_states (expires_at)");
    // Registry module sync lease (see sqlite boot path).
    await pg.unsafe(`
      CREATE TABLE IF NOT EXISTS registry_sync_leases (
        key TEXT PRIMARY KEY NOT NULL,
        owner TEXT NOT NULL,
        expires_at BIGINT NOT NULL
      )
    `);
    await pg.unsafe("CREATE INDEX IF NOT EXISTS registry_sync_leases_expires_idx ON registry_sync_leases (expires_at)");
    // Generic cross-replica mutex (see sqlite boot path).
    await pg.unsafe(`
      CREATE TABLE IF NOT EXISTS locks (
        name TEXT PRIMARY KEY NOT NULL,
        owner TEXT NOT NULL,
        expires_at BIGINT NOT NULL
      )
    `);
    await pg.unsafe("CREATE INDEX IF NOT EXISTS locks_expires_idx ON locks (expires_at)");
    // VCS integration reference guard: workspaces/policy_sets store the OAuth
    // token/GitHub App reference inside a vcs_repo JSON column, so there is no
    // native FK to block a concurrent delete of the integration. The
    // application does a read-then-delete inside a transaction, but under
    // READ COMMITTED the concurrent workspace/policy_set insert can commit
    // first and the delete still succeeds, leaving a dangling vcs_repo
    // reference. The BEFORE INSERT OR UPDATE trigger enforces the same
    // invariant inside the database (covers direct DB inserts, the API path,
    // and any future writer) and surfaces the canonical
    // "VCS integration reference is still in use" message the app catch
    // already maps to 409. Kept idempotent via CREATE OR REPLACE so a sparse
    // drizzle journal never collides.
    await pg.unsafe(`
      CREATE OR REPLACE FUNCTION vcs_repo_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        token_id text;
        client_id text;
        install_id text;
      BEGIN
        token_id := NEW.vcs_repo->>'oauthTokenId';
        install_id := NEW.vcs_repo->>'githubAppInstallationId';
        IF token_id IS NOT NULL AND token_id <> '' THEN
          SELECT oauth_client_id INTO client_id FROM oauth_tokens WHERE id = token_id;
          IF client_id IS NULL THEN
            RAISE EXCEPTION 'VCS integration reference is still in use: oauth token % is not registered', token_id;
          END IF;
          PERFORM id FROM oauth_clients WHERE id = client_id FOR KEY SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'VCS integration reference is still in use: oauth token % is not registered', token_id;
          END IF;
          PERFORM id FROM oauth_tokens WHERE id = token_id AND oauth_client_id = client_id FOR KEY SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'VCS integration reference is still in use: oauth token % is not registered', token_id;
          END IF;
        END IF;
        IF install_id IS NOT NULL AND install_id <> '' THEN
          PERFORM id FROM github_app_installations WHERE id = install_id FOR KEY SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'VCS integration reference is still in use: github app installation % is not registered', install_id;
          END IF;
        END IF;
        RETURN NEW;
      END
      $$;
    `);
    await pg.unsafe(`DROP TRIGGER IF EXISTS workspaces_vcs_repo_guard ON workspaces`);
    await pg.unsafe(`CREATE TRIGGER workspaces_vcs_repo_guard BEFORE INSERT OR UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION vcs_repo_reference_guard()`);
    await pg.unsafe(`DROP TRIGGER IF EXISTS policy_sets_vcs_repo_guard ON policy_sets`);
    await pg.unsafe(`CREATE TRIGGER policy_sets_vcs_repo_guard BEFORE INSERT OR UPDATE ON policy_sets FOR EACH ROW EXECUTE FUNCTION vcs_repo_reference_guard()`);
    // Delete guard removed — the BEFORE INSERT/UPDATE guard on
    // workspaces/policy_sets already closes the TOCTOU window for the
    // concurrent workspace/policy_set insert. A BEFORE DELETE guard on
    // oauth_tokens/oauth_clients/github_app_installations would also fire
    // during the legitimate org cascade path (DELETE FROM organizations
    // cascades to those tables before the referencing workspaces are
    // removed on postgres, ordering is trigger-sensitive), breaking
    // afterAll/result cleanup. The app-level pre-delete usage check
    // (findVcsIntegrationUsage + 409) still covers the direct-delete
    // case; the race is covered by the insert guard rejecting the
    // concurrent writer.
    // Defensive: drop any previously-created delete guards from the
    // earlier fix iteration so upgraded databases do not retain them.
    await pg.unsafe(`DROP TRIGGER IF EXISTS oauth_tokens_delete_guard ON oauth_tokens`);
    await pg.unsafe(`DROP TRIGGER IF EXISTS oauth_clients_delete_guard ON oauth_clients`);
    await pg.unsafe(`DROP TRIGGER IF EXISTS github_app_installations_delete_guard ON github_app_installations`);
    await pg.unsafe(`DROP FUNCTION IF EXISTS vcs_integration_delete_guard()`);
  })();
  return pgMigrationsPromise;
}
