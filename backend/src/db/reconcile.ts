import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "path";
import { parseCreateTableSql } from "../lib/migration/ddl";

/**
 * Sparse-journal migration reconciliation (2026-08-23 prod incident).
 *
 * Drizzle's migrator applies any journal entry whose `when` timestamp is newer
 * than the newest `__drizzle_migrations` row, all-or-nothing per batch. When a
 * released image creates schema objects OUTSIDE the journal (idempotent boot
 * DDL) and the database's journal stops advancing — a crash loop keeps every
 * subsequent release from migrating past the same failure — the gap grows until
 * a newer migration re-applies over an object that already exists and the batch
 * aborts on the first collision. Prod ended up crash-looping exactly this way
 * on 0026's `ALTER TABLE api_tokens ADD legacy …`: the column was added by an
 * emergency boot repair while the journal sat at 0025.
 *
 * Reconciliation reconciles the JOURNAL with reality instead of guessing:
 * migrations drizzle would replay are planned statement-by-statement, existing
 * objects are skipped, genuinely missing statements still execute, and each
 * reconciled entry is stamped so drizzle never replays it again.
 *
 * This module is intentionally side-effect free (pure reads + explicit writes
 * through the adapter) so both driver boot paths and the test suite can drive
 * it without importing the database module itself.
 */

export type MigrationJournalEntry = { readonly idx: number; readonly tag: string; readonly when: number };
export type MigrationJournalRow = { readonly hash: string; readonly createdAt: number };

export function readBundledMigrationJournal(folder: string): MigrationJournalEntry[] {
  const raw = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as {
    entries?: MigrationJournalEntry[];
  };
  return raw.entries ?? [];
}

function migrationSqlHash(migrationSql: string): string {
  return createHash("sha256").update(migrationSql).digest("hex");
}

/** Return the exact hashes and timestamps a dialect's migrator records. */
export function readBundledMigrationJournalRows(folder: string): MigrationJournalRow[] {
  return readBundledMigrationJournal(folder).map((entry): MigrationJournalRow => {
    const migrationSql = readFileSync(join(folder, `${entry.tag}.sql`), "utf8");
    return {
      hash: migrationSqlHash(migrationSql),
      createdAt: entry.when,
    };
  });
}

const ADD_COLUMN_RE = /ALTER TABLE [`"`]?([\w-]+)[`"`]?\s+ADD\s+(?:COLUMN\s+)?[`"`]?([\w-]+)[`"`]?/i;
const DROP_TABLE_RE = /^DROP TABLE\s+(?:IF EXISTS\s+)?[`"`]?([\w-]+)[`"`]?/i;
const CREATE_INDEX_RE =
  /^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?[`"`]?([\w-]+)[`"`]?\s+ON\s+[`"`]?([\w-]+)[`"`]?/i;
const DROP_INDEX_RE = /^DROP INDEX\s+(?:IF EXISTS\s+)?[`"`]?([\w-]+)[`"`]?/i;
const RENAME_TABLE_RE = /^ALTER TABLE\s+[`"`]?([\w-]+)[`"`]?\s+RENAME TO\s+[`"`]?([\w-]+)[`"`]?/i;

type ProjectedSchemaFacts = Readonly<{
  tables: Set<string>;
  indexes: Set<string>;
  columns: Set<string>;
  indexTables: Map<string, string>;
}>;

function applyProjectedTableStatement(
  sql: string,
  // This private planning state is intentionally mutable; caller facts remain untouched.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  facts: ProjectedSchemaFacts,
): boolean {
  const dropped = DROP_TABLE_RE.exec(sql)?.[1];
  if (dropped !== undefined) {
    facts.tables.delete(dropped);
    for (const column of facts.columns) {
      if (column.startsWith(`${dropped}.`)) facts.columns.delete(column);
    }
    for (const [index, table] of facts.indexTables) {
      if (table === dropped) {
        facts.indexes.delete(index);
        facts.indexTables.delete(index);
      }
    }
    return true;
  }
  const renamed = RENAME_TABLE_RE.exec(sql);
  if (renamed?.[1] !== undefined && renamed[2] !== undefined) {
    const [oldName, newName] = [renamed[1], renamed[2]];
    facts.tables.delete(oldName);
    facts.tables.add(newName);
    for (const column of [...facts.columns]) {
      if (column.startsWith(`${oldName}.`)) {
        facts.columns.delete(column);
        facts.columns.add(`${newName}.${column.slice(oldName.length + 1)}`);
      }
    }
    for (const [index, table] of facts.indexTables) {
      if (table === oldName) facts.indexTables.set(index, newName);
    }
    return true;
  }
  return false;
}

/** Advance the snapshot after each executed DDL statement, including across migrations. */
function advanceSchemaFacts(
  sql: string,
  // Mutation is confined to this private planning state.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  facts: ProjectedSchemaFacts,
): void {
  if (applyProjectedTableStatement(sql, facts)) return;
  const table = parseCreateTableSql(sql);
  if (table !== null) {
    facts.tables.add(table.name);
    for (const column of table.columns) facts.columns.add(`${table.name}.${column.name}`);
    return;
  }
  const addedColumn = ADD_COLUMN_RE.exec(sql);
  if (addedColumn?.[1] !== undefined && addedColumn[2] !== undefined) {
    facts.columns.add(`${addedColumn[1]}.${addedColumn[2]}`);
    return;
  }
  const createdIndex = CREATE_INDEX_RE.exec(sql);
  if (createdIndex?.[1] !== undefined && createdIndex[2] !== undefined) {
    facts.indexes.add(createdIndex[1]);
    facts.indexTables.set(createdIndex[1], createdIndex[2]);
    return;
  }
  const droppedIndex = DROP_INDEX_RE.exec(sql)?.[1];
  if (droppedIndex !== undefined) {
    facts.indexes.delete(droppedIndex);
    facts.indexTables.delete(droppedIndex);
  }
}

/** Live schema facts the planning decision needs (wholesale metadata reads per driver). */
export type SparseJournalFacts = {
  /** Rows already recorded in __drizzle_migrations. Empty means "never migrated" (fresh DB). */
  readonly appliedRows: readonly { hash: string; createdAt: number }[];
  /** Live table names visible to the session. */
  readonly tables: ReadonlySet<string>;
  /** Live index names visible to the session. */
  readonly indexes: ReadonlySet<string>;
  /** Every column visible to the session, keyed "table.column". */
  readonly columns: ReadonlySet<string>;
};

export type PlannedMigrationStatement = {
  readonly sql: string;
  /** True when the object this statement creates already exists outside the journal. */
  readonly skip: boolean;
};

export type SparseJournalPlanEntry = {
  readonly tag: string;
  readonly hash: string;
  readonly when: number;
  readonly statements: readonly PlannedMigrationStatement[];
};

/**
 * Decide how to reconcile a sparse journal before drizzle migrates. Pure and
 * synchronous so the sqlite boot path (which must stay free of top-level
 * await) can drive it directly.
 *
 * Only migrations drizzle would REPLAY are planned (newer than the newest
 * journal row, or recorded under a different hash):
 *   - every object/column already present  -> all statements marked skip;
 *     executing nothing, the caller just stamps the journal row,
 *   - partially present                    -> existing-object statements are
 *     marked skip, the rest still run (statement-level repair),
 *   - nothing present                      -> all statements run, then the
 *     row is stamped, exactly as drizzle would have done. The scan never
 *     stops early: stamping advances contiguously through the whole
 *     replayable window, so drizzle's max(created_at) comparison stays
 *     consistent and no later partial entry is ever stranded past an
 *     unapplied one (2026-09-06 prod incident: the scan used to stop at
 *     the first fully-absent entry, leaving 0062's pre-existing columns
 *     to crash drizzle's replay).
 *
 * Statement classification covers what generated migrations emit: ADD COLUMN,
 * CREATE TABLE, CREATE [UNIQUE] INDEX, and retired-table DROP TABLE. Anything
 * else (data rewrites, other DROPs) always runs as-is; those remain the
 * migrator's job for fully-absent migrations, and for replays a plain rerun
 * matches the old behavior.
 */
function planOneStatement(
  sql: string,
  // Same rule limitation as sparseJournalReconcilePlan below.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  facts: SparseJournalFacts,
): PlannedMigrationStatement {
  // DROP TABLE is the one destructive migration emitted for a retired
  // table. It is safe to skip when an older repair already removed it,
  // while an existing table must be dropped before the journal advances.
  const dropTable = DROP_TABLE_RE.exec(sql);
  if (dropTable?.[1] !== undefined) {
    const present = facts.tables.has(dropTable[1]);
    return { sql, skip: !present };
  }
  // ADD COLUMN: skip exactly when the live column already exists.
  const addColumn = ADD_COLUMN_RE.exec(sql);
  if (addColumn !== null) {
    const table = addColumn[1];
    const column = addColumn[2];
    const present = table !== undefined && column !== undefined && facts.columns.has(`${table}.${column}`);
    return { sql, skip: present };
  }
  // CREATE TABLE: skip when the table already exists.
  const createTable = /CREATE TABLE (?:IF NOT EXISTS )?[`"`]?([\w-]+)[`"`]?\s*\(/.exec(sql);
  if (createTable?.[1] !== undefined) {
    const present = facts.tables.has(createTable[1]);
    return { sql, skip: present };
  }
  // CREATE [UNIQUE] INDEX: skip when the named index already exists.
  const createIndex = CREATE_INDEX_RE.exec(sql);
  if (createIndex?.[1] !== undefined) {
    const present = facts.indexes.has(createIndex[1]);
    return { sql, skip: present };
  }
  // Anything else: cannot be classified, must run as-is.
  return { sql, skip: false };
}

export function sparseJournalReconcilePlan(
  bundledFolder: string,
  entries: readonly MigrationJournalEntry[],
  // The facts object is consumed wholesale; the rule's structural check cannot
  // see through the ReadonlySet members, so mark it read-only by hand.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  facts: SparseJournalFacts,
): readonly SparseJournalPlanEntry[] {
  if (entries.length === 0 || facts.appliedRows.length === 0) return [];
  const newestAppliedAt = Math.max(
    ...facts.appliedRows.map((row: { readonly createdAt: number }): number => row.createdAt),
  );
  const appliedHashes = new Set(facts.appliedRows.map((row: { readonly hash: string }): string => row.hash));
  const bundledMaxWhen = entries.reduce((max, entry): number => (entry.when > max ? entry.when : max), 0);
  // A journal whose newest row is NEWER than every bundled migration is
  // corrupted/forward-dated (the 2026-08-23 prod incident reproduced by the
  // migration tests). Drizzle would treat all bundled migrations as already
  // applied and replay nothing, so the timestamp guard below cannot fire.
  // Treat the journal as unreliable and reconcile EVERY bundled entry; the
  // per-statement `skip` checks still protect objects that already exist.
  const journalForwardDated = newestAppliedAt > bundledMaxWhen;
  const plan: SparseJournalPlanEntry[] = [];

  const bundled = entries.map(
    (entry): Readonly<{ entry: MigrationJournalEntry; hash: string; statements: readonly string[] }> => {
      const migrationSql = readFileSync(join(bundledFolder, `${entry.tag}.sql`), "utf8");
      return {
        entry,
        hash: migrationSqlHash(migrationSql),
        statements: migrationSql
          .split("--> statement-breakpoint")
          .map((sql): string => sql.trim())
          .filter((sql): boolean => sql !== ""),
      };
    },
  );
  const projected: ProjectedSchemaFacts = {
    tables: new Set(facts.tables),
    indexes: new Set(facts.indexes),
    columns: new Set(facts.columns),
    indexTables: new Map(),
  };
  // Bundled index declarations identify which snapshot indexes a table drop destroys.
  for (const { statements } of bundled) {
    for (const sql of statements) {
      const index = CREATE_INDEX_RE.exec(sql);
      if (index?.[1] !== undefined && index[2] !== undefined && projected.indexes.has(index[1])) {
        projected.indexTables.set(index[1], index[2]);
      }
    }
  }

  for (const { entry, hash, statements } of bundled) {
    // Only entries drizzle would REPLAY can need reconciling; entries whose
    // exact hash is already recorded are applied regardless of timestamp order.
    if (!journalForwardDated && (entry.when <= newestAppliedAt || appliedHashes.has(hash))) continue;

    const planned = statements.map((sql): PlannedMigrationStatement => {
      const statement = planOneStatement(sql, { ...facts, ...projected });
      if (!statement.skip) advanceSchemaFacts(sql, projected);
      return statement;
    });

    // Every replayable entry is planned — including fully-absent ones, whose
    // statements run exactly as drizzle would have run them. Stamps advance
    // contiguously through the replayable window, so drizzle's
    // max(created_at) comparison stays consistent. Stopping at the first
    // fully-absent entry strands later partial entries past an unstamped
    // gap, and drizzle replays those stranded entries natively and crashes
    // on their pre-existing objects.
    plan.push({ tag: entry.tag, hash, when: entry.when, statements: planned });
  }
  return plan;
}

export type SparseJournalAdapter = {
  /** Folder holding meta/_journal.json plus the tagged .sql files. */
  readonly bundledFolder: string;
  appliedRows(): Promise<readonly { hash: string; createdAt: number }[]>;
  existingTables(): Promise<readonly string[]>;
  existingIndexes(): Promise<readonly string[]>;
  existingColumns(): Promise<readonly { table: string; column: string }[]>;
  /** Execute one migration statement that the plan did not mark as skip. */
  runStatement(sql: string): Promise<void>;
  /** Insert a journal row exactly as drizzle's migrator would have. */
  markApplied(hash: string, createdAt: number): Promise<void>;
};

/**
 * Async wrapper used by the postgres boot path (applyPgMigrations), where every
 * metadata read is awaited. Executes planned statements and stamps their rows.
 * The sqlite boot path drives sparseJournalReconcilePlan() directly.
 */
export async function reconcileSparseMigrationJournal(
  // Same rule limitation as sparseJournalReconcilePlan above.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  adapter: SparseJournalAdapter,
): Promise<number> {
  const [entries, appliedRows, tables, indexes, columnPairs] = await Promise.all([
    Promise.resolve(readBundledMigrationJournal(adapter.bundledFolder)),
    adapter.appliedRows(),
    adapter.existingTables(),
    adapter.existingIndexes(),
    adapter.existingColumns(),
  ]);
  const plan = sparseJournalReconcilePlan(adapter.bundledFolder, entries, {
    appliedRows,
    tables: new Set(tables),
    indexes: new Set(indexes),
    columns: new Set(
      columnPairs.map(
        (pair: { readonly table: string; readonly column: string }): string => `${pair.table}.${pair.column}`,
      ),
    ),
  });
  for (const entry of plan) {
    for (const statement of entry.statements) {
      if (!statement.skip) await adapter.runStatement(statement.sql);
    }
    await adapter.markApplied(entry.hash, entry.when);
  }
  return plan.length;
}
