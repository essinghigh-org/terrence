import { Database } from 'bun:sqlite';
import { drizzle, SQLiteBunTransaction } from 'drizzle-orm/bun-sqlite';
import type { SQLiteBunSession } from 'drizzle-orm/bun-sqlite';
import type { SQLiteSession, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { mkdirSync, renameSync, statSync } from 'node:fs';
import { join, resolve } from 'path';
import * as schema from './schema';
import { planJsonDirectory } from '../lib/plan-json';
import { runLogsDirectory } from '../lib/run-logs';
import { BootConfigError, bootConfigPath, resolveDatabaseConfig } from '../lib/boot-config';

const storageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, '../../storage'));
// Deliberately synchronous: a top-level await here made this module a TLA
// module, and Bun's worker threads can resolve importers while the TLA is
// still pending (ReferenceError: Cannot access 'db' before initialization
// in every bun test worker). mkdirSync is behavior-identical.
mkdirSync(storageDir, { recursive: true });

// bun:sqlite is built into Bun and keeps a single stable native connection; the
// @libsql/client driver leaked native memory per query and churned a fresh native
// connection for every transaction (the source of terrence's multi-GB RSS growth).
// The active backend comes from the boot configuration file (storage/terrence.json)
// with DATABASE_URL taking precedence; see lib/boot-config.ts for the precedence
// rules and the in-app migration wizard's write path.
const resolvedDatabase = resolveDatabaseConfig(process.env, storageDir);
if (resolvedDatabase.driver === "postgres") {
  throw new BootConfigError(
    `PostgreSQL backend is not available in this build yet (configured via ${bootConfigPath(storageDir)} or DATABASE_URL)`,
  );
}
const dbUrl = resolvedDatabase.url;
const dbPath = dbUrl === ':memory:' ? ':memory:' : dbUrl.replace(/^file:/, '');
const client = new Database(dbUrl === ':memory:' ? ':memory:' : dbUrl.replace(/^file:/, ''), { create: true });
client.run('PRAGMA journal_mode = WAL;');
client.run('PRAGMA busy_timeout = 5000;');
// bun:sqlite defaults foreign_keys to OFF per-connection; enable enforcement
// explicitly so referential integrity holds (drizzle's migrate() does not set it).
client.run('PRAGMA foreign_keys = ON;');

// Opt-in SQL query instrumentation for the benchmark suite
// (TERRENCE_QUERY_COUNT=1). Drizzle routes every statement through
// client.prepare(), so counting prepares counts queries. Zero overhead when
// the env var is unset (the wrapper is never installed). Set
// TERRENCE_QUERY_LOG=1 alongside it to also capture the SQL text.
let queryCount = 0;
const queryLog: string[] = [];
let queryLogEnabled = process.env.TERRENCE_QUERY_LOG === "1";
if (process.env.TERRENCE_QUERY_COUNT === "1") {
  const originalPrepare = client.prepare.bind(client);
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types, @typescript-eslint/explicit-function-return-type -- mirrors bun:sqlite's generic prepare() signature that an explicit return type cannot widen.
  client.prepare = ((sql: string, ...params: unknown[]) => {
    queryCount += 1;
    if (queryLogEnabled) queryLog.push(sql);
    return originalPrepare(sql, ...(params as [never]));
  });
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
/** @public Used by the dynamically imported benchmark runner. */
export function setQueryLogging(enabled: boolean): void {
  queryLogEnabled = enabled;
  if (!enabled) queryLog.length = 0;
}

export const db = drizzle(client, { schema });

/**
 * Fold the WAL back into the main database file. Called on graceful
 * shutdown so backups and migrations see a single self-contained file
 * instead of a live -wal sidecar (kanban 4.17).
 */
export function checkpointWal(): void {
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
 * sidecar size, journal mode, and page geometry. Two cheap pragmas plus one
 * stat() call — safe to invoke per request (kanban 4.18).
 */
export function databaseMetrics(): Readonly<{
  sizeBytes: number;
  walSizeBytes: number | null;
  journalMode: string;
  pageSize: number;
  pageCount: number;
  path: string;
}> {
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
  return { sizeBytes, walSizeBytes, journalMode, pageSize, pageCount, path: dbPath };
}

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

migrate(db, { migrationsFolder: join(import.meta.dir, '../../drizzle') });

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


// ---------------------------------------------------------------------------
// Id-format migration: re-key persisted rows that predate the current ID
// scheme (e.g. workspaces `w-*` -> `ws-*`, users `u-*` -> `usr-*`, orgs `o-*`
// -> `org-*`, raw-UUID runs/state refs -> prefixed). Both the primary key and
// every column that foreign-keys to it are rewritten so relational integrity
// holds after upgrade. Runs additionally have filesystem sidecars keyed by id
// (plan-json/{id}.json, run-logs/{id}.json.gz); those are renamed alongside
// the row so artifact lookups stay consistent. Idempotent: rows already in
// the current shape are left untouched, so this is a no-op once the data is
// migrated.
// ---------------------------------------------------------------------------
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

  // 1. Compute old -> new id maps per entity.
  const rekeyMaps = new Map<string, Map<string, string>>();
  for (const fmt of ID_FORMATS) {
    const rows = client.prepare(`SELECT id FROM "${fmt.table}"`).all() as { id: string }[];
    const map = new Map<string, string>();
    for (const { id } of rows) {
      if (isNewId(id, fmt.prefix, fmt.fullUuidSuffix)) continue;
      const suffix = fmt.fullUuidSuffix
        ? crypto.randomUUID()
        : crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      map.set(id, `${fmt.prefix}${suffix}`);
    }
    if (map.size > 0) rekeyMaps.set(fmt.table, map);
  }
  if (rekeyMaps.size > 0) {
    // Build a table -> [{column, ref}] for every column that references each
    // entity, discovered from the live foreign_key metadata.
    const refs = new Map<string, Array<{ table: string; column: string }>>();
    const allTables = client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    for (const { name } of allTables) {
      const fks = client.prepare(`PRAGMA foreign_key_list("${name}")`).all() as { table: string; from: string }[];
      for (const fk of fks) {
        if (rekeyMaps.has(fk.table)) {
          if (!refs.has(fk.table)) refs.set(fk.table, []);
          refs.get(fk.table)?.push({ table: name, column: fk.from });
        }
      }
    }

    client.run("PRAGMA foreign_keys = OFF");
    try {
      for (const [parent, map] of rekeyMaps) {
        for (const { table, column } of refs.get(parent) ?? []) {
          const stmt = client.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`);
          for (const [old, next] of map) stmt.run(next, old);
        }
        const pkStmt = client.prepare(`UPDATE "${parent}" SET id = ? WHERE id = ?`);
        for (const [old, next] of map) pkStmt.run(next, old);
        if (parent === "runs") renameRunSidecars(map);
      }
    } finally {
      client.run("PRAGMA foreign_keys = ON");
    }
    const entityNames = [...rekeyMaps.keys()].join(", ");
    const total = [...rekeyMaps.values()].reduce((acc, m) => acc + m.size, 0);
    const sidecarSummary = sidecarsRenamed > 0 || sidecarRenameFailures > 0
      ? `; renamed ${sidecarsRenamed} run sidecar files${sidecarRenameFailures > 0 ? `, ${sidecarRenameFailures} failed` : ""}`
      : "";
    console.warn(`[terrence] Migrated ${total} ids to the current format (${entityNames})${sidecarSummary}.`);
  }
}
