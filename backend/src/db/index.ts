import { Database } from 'bun:sqlite';
import { drizzle as sqliteDrizzle, SQLiteBunTransaction, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { SQLiteBunSession } from 'drizzle-orm/bun-sqlite';
import type { SQLiteSession, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { migrate as sqliteMigrate } from 'drizzle-orm/bun-sqlite/migrator';
import { drizzle as pgDrizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { type SQL } from 'drizzle-orm';
import { mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'path';
import * as schema from './schema';
import { planJsonDirectory } from '../lib/plan-json';
import { runLogsDirectory } from '../lib/run-logs';
import { databaseDriver, databaseUrl, isPostgres, storageDir } from './driver';

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
let queryLogEnabled = process.env.TERRENCE_QUERY_LOG === "1";
const installQueryInstrumentation = (enabled: boolean): void => {
  if (!enabled) return;
};

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

  if (process.env.TERRENCE_QUERY_COUNT === "1") {
    const originalPrepare = client.prepare.bind(client);
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types, @typescript-eslint/explicit-function-return-type -- mirrors bun:sqlite's generic prepare() signature that an explicit return type cannot widen.
    client.prepare = ((sqlText: string, ...params: unknown[]) => {
      queryCount += 1;
      if (queryLogEnabled) queryLog.push(sqlText);
      return originalPrepare(sqlText, ...(params as [never]));
    });
  }
  installQueryInstrumentation(process.env.TERRENCE_QUERY_COUNT === "1");
}

// ---------------------------------------------------------------------------
// PostgreSQL backend: postgres.js pooled client. Schema DDL comes from the
// generated drizzle-pg migrations, applied at boot (backend/index.ts) and in
// the test harness (tests/setup.ts) — never here, because the migrator is
// async and this module must stay synchronous for bun's worker threads.
// ---------------------------------------------------------------------------
let pgClient: postgres.Sql | null = null;
if (isPostgres) {
  pgClient = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    // The app surfaces database errors itself; postgres.js NOTICE noise
    // (e.g. "relation already exists" during idempotent DDL) is suppressed.
    onnotice: () => {},
  });
  if (process.env.TERRENCE_QUERY_COUNT === "1") {
    const originalUnsafe = pgClient.unsafe.bind(pgClient);
    pgClient.unsafe = ((queryText: string, ...params: unknown[]) => {
      queryCount += 1;
      if (queryLogEnabled) queryLog.push(queryText);
      return originalUnsafe(queryText, ...(params as [never]));
    }) as typeof pgClient.unsafe;
  }
  installQueryInstrumentation(true);
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
const pgDb = pgClient === null ? null : pgDrizzle(pgClient, { schema });
export const db = (isPostgres ? pgDb : sqliteDb) as unknown as AppDb;

// ---------------------------------------------------------------------------
// SQLite-only boot maintenance. All of it repairs legacy SQLite databases
// (pre-squash journal islands, pre-id-format rows) and is a no-op on fresh
// databases; the postgres backend always boots from the drizzle-pg
// migrations, so none of it applies there.
// ---------------------------------------------------------------------------
if (!isPostgres) {
  const client = sqliteClient as Database;

  // bun:sqlite's native transaction() rolls back only when its callback throws
  // synchronously; drizzle-orm/bun-sqlite delegates transaction() straight to it, so
  // an async callback that throws would silently COMMIT partial writes. Wrap it with
  // explicit BEGIN/COMMIT/ROLLBACK that awaits the callback instead.
  const session = (db as unknown as { session: SQLiteBunSession<Record<string, unknown>, never> }).session;
  (session as unknown as { transaction: unknown }).transaction = async function (
    // The callback signature mirrors drizzle's own session.transaction type.
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    fn: (tx: SQLiteBunTransaction<Record<string, unknown>, never>) => Promise<unknown>,
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    config?: { behavior?: 'deferred' | 'immediate' | 'exclusive' },
  ): Promise<unknown> {
    const sess = this as unknown as { dialect: SQLiteSyncDialect; schema: unknown };
    const tx = new SQLiteBunTransaction<Record<string, unknown>, never>(
      'sync',
      sess.dialect,
      this as unknown as SQLiteSession<'sync', void, Record<string, unknown>, never>,
      sess.schema as never,
    );
    const behavior = config?.behavior !== undefined ? ` ${config.behavior.toUpperCase()}` : '';
    client.run(`BEGIN${behavior}`);
    try {
      const result = await fn(tx);
      client.run('COMMIT');
      return result;
    } catch (err) {
      client.run('ROLLBACK');
      throw err;
    }
  };

  sqliteMigrate(db, { migrationsFolder: join(import.meta.dir, '../../drizzle') });

  // Drizzle orders migrations by journal timestamps. Databases created before
  // the migration squash can have a later legacy timestamp, which makes the
  // repair migration look applied even when this table is missing. Keep this
  // narrow guard idempotent so those databases are repaired at boot as well.
  client.run(`
    CREATE TABLE IF NOT EXISTS run_explanations (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      model TEXT NOT NULL,
      content TEXT NOT NULL,
      thinking TEXT,
      input_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  client.run(`
    CREATE INDEX IF NOT EXISTS run_explanations_run_kind_idx
      ON run_explanations (run_id, kind)
  `);

  // Hot-path query indexes (benchmarked: queue scan 200x, workspace run
  // lists 36x, calendar range 17x faster with these). Existing databases
  // predate the schema definitions, so create them idempotently at boot.
  client.run("CREATE INDEX IF NOT EXISTS runs_workspace_status_created_idx ON runs (workspace_id, status, created_at)");
  client.run("CREATE INDEX IF NOT EXISTS runs_status_created_idx ON runs (status, created_at)");
  client.run("CREATE INDEX IF NOT EXISTS configuration_versions_workspace_created_idx ON configuration_versions (workspace_id, created_at)");
  client.run("CREATE INDEX IF NOT EXISTS workspaces_org_idx ON workspaces (org_id)");

  // Column convergence guard (mirrors the run_explanations guard above):
  // databases whose migration journal never applied the scheduled_at column
  // (journal timestamp islands, pre-squash journals, or restored backups)
  // are repaired at boot. Idempotent: a no-op once the column exists, so
  // fresh databases and properly journaled upgrades are unaffected.
  {
    const runsColumns = (client.query("PRAGMA table_info(runs)").all() as ReadonlyArray<{ readonly name: string }>)
      .map((column): string => column.name);
    if (!runsColumns.includes("scheduled_at")) {
      try {
        client.run("ALTER TABLE runs ADD COLUMN scheduled_at integer");
      } catch (error: unknown) {
        // Another process may have added the column between the check and the
        // ALTER. Only swallow the failure when the column now exists; any
        // genuine ALTER failure must surface at boot.
        const updatedColumns = client.query("PRAGMA table_info(runs)").all() as ReadonlyArray<{ readonly name: string }>;
        if (!updatedColumns.some((column): boolean => column.name === "scheduled_at")) {
          throw error;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Id-format migration: re-key persisted rows that predate the current ID
  // scheme (e.g. workspaces `w-*` -> `ws-*`, users `u-*` -> `usr-*`, orgs `o-*`
  // -> `org-*`, raw-UUID runs/state refs -> prefixed). Both the primary key and
  // every column that foreign-keys to it are rewritten so relational integrity
  // holds after upgrade. Runs additionally have filesystem sidecars keyed by id
  // (plan-json/{id}.json, run-logs/{id}.json.gz); those are renamed alongside
  // the row so artifact lookups stay consistent. Idempotent: rows already in
  // the current shape are left untouched, so this is a no-op once the data is
  // migrated.
  // -------------------------------------------------------------------------
  {
    // Runs-keyed artifact directories, mirrored from plan-json.ts / run-logs.ts.
    const RUN_SIDECAR_DIRS: ReadonlyArray<Readonly<{ dir: string; suffix: string }>> = [
      { dir: planJsonDirectory, suffix: ".json" },
      { dir: runLogsDirectory, suffix: ".json.gz" },
    ];
    let sidecarsRenamed = 0;
    let sidecarRenameFailures = 0;
    const renameRunSidecars = (map: Map<string, string>): void => {
      for (const [oldId, newId] of map) {
        for (const { dir, suffix } of RUN_SIDECAR_DIRS) {
          try {
            renameSync(join(dir, `${oldId}${suffix}`), join(dir, `${newId}${suffix}`));
            sidecarsRenamed += 1;
          } catch (error: unknown) {
            if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
            sidecarRenameFailures += 1;
            console.warn(`[terrence] Failed to rename run sidecar ${oldId}${suffix}: ${String(error)}`);
          }
        }
      }
    };

    const ID_FORMATS: ReadonlyArray<Readonly<{ table: string; prefix: string; fullUuidSuffix: boolean }>> = [
      { table: "organizations", prefix: "org-", fullUuidSuffix: true },
      { table: "users", prefix: "usr-", fullUuidSuffix: true },
      { table: "workspaces", prefix: "ws-", fullUuidSuffix: false },
      { table: "projects", prefix: "prj-", fullUuidSuffix: false },
      { table: "runs", prefix: "run-", fullUuidSuffix: false },
    ];

    const isNewId = (id: string, prefix: string, fullUuidSuffix: boolean): boolean => {
      if (!id.startsWith(prefix)) return false;
      const suffix = id.slice(prefix.length);
      if (fullUuidSuffix) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(suffix);
      }
      return /^[0-9a-f]{16}$/.test(suffix);
    };

    // Journal: old -> new mappings are persisted BEFORE any mutation so an
    // interrupted migration resumes idempotently on the next boot instead of
    // orphaning referencing rows (kanban t_9ca58704). The journal also makes
    // the filesystem-sidecar phase restartable: file renames cannot live in
    // the database transaction, but the rename pass is a no-op for entries
    // whose files are already in place.
    const JOURNAL_TABLE = "_id_rekey_journal";
    client.run(
      `CREATE TABLE IF NOT EXISTS "${JOURNAL_TABLE}" (` +
        "entity TEXT NOT NULL, old_id TEXT NOT NULL, new_id TEXT NOT NULL, " +
        `PRIMARY KEY (entity, old_id))`,
    );

    // Build a table -> [{column, ref}] for every column that references each
    // entity, discovered from the live foreign_key metadata.
    const buildRefs = (entities: ReadonlySet<string>): Map<string, Array<{ table: string; column: string }>> => {
      const refs = new Map<string, Array<{ table: string; column: string }>>();
      const allTables = client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      for (const { name } of allTables) {
        const fks = client.prepare(`PRAGMA foreign_key_list("${name}")`).all() as { table: string; from: string }[];
        for (const fk of fks) {
          if (entities.has(fk.table)) {
            if (!refs.has(fk.table)) refs.set(fk.table, []);
            refs.get(fk.table)?.push({ table: name, column: fk.from });
          }
        }
      }
      return refs;
    };

    // Apply a rekey: referencing columns + primary keys in ONE transaction,
    // then the run sidecar renames as an idempotent post-commit phase. The
    // persisted journal makes the whole operation resumable after a crash.
    const applyRekey = (
      entityMaps: Map<string, Map<string, string>>,
      refs: Map<string, Array<{ table: string; column: string }>>,
    ): void => {
      client.run("PRAGMA foreign_keys = OFF");
      try {
        client.run("BEGIN");
        try {
          for (const [parent, map] of entityMaps) {
            for (const { table, column } of refs.get(parent) ?? []) {
              const stmt = client.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`);
              for (const [old, next] of map) stmt.run(next, old);
            }
            const pkStmt = client.prepare(`UPDATE "${parent}" SET id = ? WHERE id = ?`);
            for (const [old, next] of map) pkStmt.run(next, old);
          }
          client.run("COMMIT");
        } catch (error: unknown) {
          client.run("ROLLBACK");
          throw error;
        }
      } finally {
        client.run("PRAGMA foreign_keys = ON");
      }
      for (const [parent, map] of entityMaps) {
        if (parent === "runs") renameRunSidecars(map);
      }
    };

    // 0. Resume an interrupted migration from the persisted journal BEFORE
    // computing fresh maps: journaled rows may already be re-keyed (crash
    // after commit) or not (crash before commit); both resume idempotently.
    const pendingRows = client.prepare(`SELECT entity, old_id, new_id FROM "${JOURNAL_TABLE}" ORDER BY rowid`).all() as {
      entity: string;
      old_id: string;
      new_id: string;
    }[];
    const pendingMaps = new Map<string, Map<string, string>>();
    for (const entry of pendingRows) {
      const map = pendingMaps.get(entry.entity) ?? new Map<string, string>();
      map.set(entry.old_id, entry.new_id);
      pendingMaps.set(entry.entity, map);
    }

    // 1. Compute old -> new id maps per entity (rows still in the old format).
    // Old ids already covered by the journal are skipped: resume owns them.
    const journaledOldIds = new Set(pendingRows.map((entry): string => `${entry.entity}:${entry.old_id}`));
    const rekeyMaps = new Map<string, Map<string, string>>();
    for (const fmt of ID_FORMATS) {
      const rows = client.prepare(`SELECT id FROM "${fmt.table}"`).all() as { id: string }[];
      const map = new Map<string, string>();
      for (const { id } of rows) {
        if (journaledOldIds.has(`${fmt.table}:${id}`)) continue;
        if (isNewId(id, fmt.prefix, fmt.fullUuidSuffix)) continue;
        const suffix = fmt.fullUuidSuffix
          ? crypto.randomUUID()
          : crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        map.set(id, `${fmt.prefix}${suffix}`);
      }
      if (map.size > 0) rekeyMaps.set(fmt.table, map);
    }

    const entityNames = [...new Set([...pendingMaps.keys(), ...rekeyMaps.keys()])];
    if (entityNames.length > 0) {
      const refs = buildRefs(new Set(entityNames));
      if (pendingMaps.size > 0) applyRekey(pendingMaps, refs);
      if (rekeyMaps.size > 0) {
        // Journal BEFORE mutating so a crash can never lose the mapping.
        const journalStmt = client.prepare(
          `INSERT OR IGNORE INTO "${JOURNAL_TABLE}" (entity, old_id, new_id) VALUES (?, ?, ?)`,
        );
        for (const [entity, map] of rekeyMaps) {
          for (const [old, next] of map) journalStmt.run(entity, old, next);
        }
        applyRekey(rekeyMaps, refs);
        const total = [...rekeyMaps.values()].reduce((acc, m) => acc + m.size, 0);
        const sidecarSummary = sidecarsRenamed > 0 || sidecarRenameFailures > 0
          ? `; renamed ${sidecarsRenamed} run sidecar files${sidecarRenameFailures > 0 ? `, ${sidecarRenameFailures} failed` : ""}`
          : "";
        console.warn(`[terrence] Migrated ${total} ids to the current format (${[...rekeyMaps.keys()].join(", ")})${sidecarSummary}.`);
      }
      // 2. Enforce referential integrity after re-keying: a crash-safe
      // migration must never leave dangling references to re-keyed entities
      // (kanban t_9ca58704). Scoped to the entities this migration touched so
      // unrelated pre-existing violations do not block boot.
      const rekeyedParents = new Set(entityNames);
      const violations = (client.prepare("PRAGMA foreign_key_check").all() as {
        table: string;
        rowid: number;
        parent: string;
        fkid: number;
      }[]).filter((violation): boolean => rekeyedParents.has(violation.parent));
      if (violations.length > 0) {
        const first = violations[0];
        throw new Error(
          `ID migration left ${violations.length} foreign-key violations ` +
            `(first: ${first?.table ?? "?"} row ${String(first?.rowid)} -> ${first?.parent ?? "?"})`,
        );
      }
      // 3. Fully applied: drop the journal so the next boot starts clean.
      client.run(`DROP TABLE IF EXISTS "${JOURNAL_TABLE}"`);
    }
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
  const client = sqliteClient as Database;
  // wal_checkpoint(TRUNCATE) reports { busy, log, checkpointed }; a nonzero
  // busy count means frames could not be flushed (a concurrent writer or a
  // read transaction still holding the WAL), so the main DB file is not yet
  // complete. Fail loudly instead of discarding the result (kanban 4.17).
  interface WalCheckpointRow { busy: number; log: number; checkpointed: number; }
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
    const client = pgClient as postgres.Sql;
    const rows = await client.unsafe(
      "SELECT pg_database_size(current_database()) AS size, current_setting('block_size')::int AS \"blockSize\"",
    ) as unknown as ReadonlyArray<{ size: number | bigint; blockSize: number }>;
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
  const client = sqliteClient as Database;
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

// Re-export the active driver so consumers can branch on backend behavior
// (e.g. raw-SQL dialect shims) with a single import.
export { databaseDriver, isPostgres };

/**
 * Apply the PostgreSQL schema migrations (drizzle/pg). The sqlite migrator
 * runs synchronously at module load; the postgres migrator is async, so it
 * is invoked explicitly from the boot path (backend/index.ts) and the test
 * harness (tests/setup.ts). Memoized: safe to call from both.
 */
let pgMigrationsPromise: Promise<void> | null = null;
export function applyPgMigrations(): Promise<void> {
  if (!isPostgres) return Promise.resolve();
  if (pgMigrationsPromise !== null) return pgMigrationsPromise;
  pgMigrationsPromise = (async (): Promise<void> => {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const instance = pgDb;
    if (instance === null) throw new Error("postgres backend not initialized");
    await migrate(instance, { migrationsFolder: join(import.meta.dir, "../../drizzle/pg") });
  })();
  return pgMigrationsPromise;
}
