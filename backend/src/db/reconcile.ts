import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "path";

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

export function readBundledMigrationJournal(folder: string): MigrationJournalEntry[] {
  const raw = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as { entries?: MigrationJournalEntry[] };
  return raw.entries ?? [];
}

const ADD_COLUMN_RE = /ALTER TABLE [`"`]?([\w-]+)[`"`]?\s+ADD\s+(?:COLUMN\s+)?[`"`]?([\w-]+)[`"`]?/i;

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
 *   - nothing present                      -> NOT planned; scanning STOPS so
 *     no later entry is ever stamped past an unapplied one (drizzle compares
 *     against max(created_at), which would permanently skip it).
 *
 * Statement classification covers what generated migrations emit: ADD COLUMN,
 * CREATE TABLE, CREATE [UNIQUE] INDEX. Anything else (data rewrites, DROPs)
 * always runs as-is; those remain the migrator's job for fully-absent
 * migrations, and for replays a plain rerun matches the old behavior.
 */
export function sparseJournalReconcilePlan(
  bundledFolder: string,
  entries: readonly MigrationJournalEntry[],
  // The facts object is consumed wholesale; the rule's structural check cannot
  // see through the ReadonlySet members, so mark it read-only by hand.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  facts: SparseJournalFacts,
): readonly SparseJournalPlanEntry[] {
  if (entries.length === 0 || facts.appliedRows.length === 0) return [];
  const newestAppliedAt = Math.max(...facts.appliedRows.map((row: { readonly createdAt: number }): number => row.createdAt));
  const appliedHashes = new Set(facts.appliedRows.map((row: { readonly hash: string }): string => row.hash));
  const plan: SparseJournalPlanEntry[] = [];

  for (const entry of entries) {
    // Only entries drizzle would REPLAY can need reconciling; entries whose
    // exact hash is already recorded are applied regardless of timestamp order.
    const sqlPath = join(bundledFolder, `${entry.tag}.sql`);
    const migrationSql = readFileSync(sqlPath, "utf8");
    // Drizzle journals sha256(migration file text); compute it identically.
    const hash = createHash("sha256").update(migrationSql).digest("hex");
    if (entry.when <= newestAppliedAt || appliedHashes.has(hash)) continue;

    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((sql: string): string => sql.trim())
      .filter((sql: string): boolean => sql !== "");
    const planned: PlannedMigrationStatement[] = [];
    let anyPresent = false;

    for (const sql of statements) {
      // ADD COLUMN: skip exactly when the live column already exists.
      const addColumn = ADD_COLUMN_RE.exec(sql);
      if (addColumn !== null) {
        const table = addColumn[1];
        const column = addColumn[2];
        const present = table !== undefined && column !== undefined && facts.columns.has(`${table}.${column}`);
        planned.push({ sql, skip: present });
        if (present) anyPresent = true;
        continue;
      }
      // CREATE TABLE: skip when the table already exists.
      const createTable = /CREATE TABLE (?:IF NOT EXISTS )?[`"`]?([\w-]+)[`"`]?\s*\(/.exec(sql);
      if (createTable?.[1] !== undefined) {
        const present = facts.tables.has(createTable[1]);
        planned.push({ sql, skip: present });
        if (present) anyPresent = true;
        continue;
      }
      // CREATE [UNIQUE] INDEX: skip when the named index already exists.
      const createIndex = /CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?[`"`]?([\w-]+)[`"`]?\s+ON/.exec(sql);
      if (createIndex?.[1] !== undefined) {
        const present = facts.indexes.has(createIndex[1]);
        planned.push({ sql, skip: present });
        if (present) anyPresent = true;
        continue;
      }
      // Anything else: cannot be classified, must run as-is.
      planned.push({ sql, skip: false });
    }

    // A migration with nothing present is left to drizzle entirely — including
    // its batch transactionality. STOP the scan here: drizzle replays by
    // max(created_at) comparison, so stamping any later entry would make it
    // consider this earlier one applied and skip it forever. Journal rows may
    // only advance contiguously.
    if (!anyPresent) break;
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
    columns: new Set(columnPairs.map((pair: { readonly table: string; readonly column: string }): string => `${pair.table}.${pair.column}`)),
  });
  for (const entry of plan) {
    for (const statement of entry.statements) {
      if (!statement.skip) await adapter.runStatement(statement.sql);
    }
    await adapter.markApplied(entry.hash, entry.when);
  }
  return plan.length;
}
