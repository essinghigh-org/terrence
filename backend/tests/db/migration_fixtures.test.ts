import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { cp, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * DB migration fixtures from historical releases (review item 22.10).
 *
 * The drizzle journal (drizzle/meta/_journal.json) records 60 migrations.
 * Each prefix 0..N is a "release fixture": the schema a fresh install had at
 * that point in history. Properties asserted:
 *   - every release prefix applies cleanly to a fresh DB,
 *   - continuing a release-prefix DB to head yields EXACTLY the same table
 *     set as a fresh head apply (the upgrade-path invariant; the strongest
 *     guarantee a migration set can make),
 *   - re-running the migrator on an already-migrated DB is a no-op,
 *   - milestone tables exist at the release point that introduced them,
 *   - any DROP TABLE in a migration targets a table created by an earlier
 *     migration (nothing drops tables it did not make).
 */

const DRIZZLE_DIR = join(import.meta.dir, "../../drizzle");

interface MigratedDb {
  tables: string[];
  journalCount: number;
  /** Column names per table, for milestone checks. */
  columns: Map<string, string[]>;
}

function pragmaTables(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map((row) => row.name)
    .filter((name) => name !== "__drizzle_migrations");
}

function pragmaColumns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
}

/** Apply journal entries [0..prefix] (or all when prefix is null) to a fresh in-memory DB. Restores the journal afterwards. */
async function applyPrefix(folder: string, prefix: number | null): Promise<MigratedDb> {
  const journalPath = join(folder, "meta/_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<Record<string, unknown>> };
  const original = await readFile(journalPath, "utf8");
  const entries = prefix === null ? journal.entries : journal.entries.slice(0, prefix + 1);
  await writeFile(journalPath, JSON.stringify({ ...journal, entries }));

  const raw = new Database(":memory:");
  try {
    const db = drizzle(raw);
    migrate(db, { migrationsFolder: folder });
    const tables = pragmaTables(raw);
    const columns = new Map<string, string[]>();
    for (const table of tables) columns.set(table, pragmaColumns(raw, table));
    const journalCount = (raw.query("SELECT COUNT(*) AS c FROM __drizzle_migrations").get() as { c: number }).c;
    return { tables, journalCount, columns };
  } finally {
    raw.close();
    await writeFile(journalPath, original);
  }
}

/** Apply [0..prefix], then continue the SAME database to head with the full journal. */
async function applyPrefixThenHead(folder: string, prefix: number, fullJournal: { entries: Array<Record<string, unknown>> }): Promise<{
  stage: MigratedDb;
  continued: MigratedDb;
}> {
  const journalPath = join(folder, "meta/_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<Record<string, unknown>> };
  const entries = journal.entries.slice(0, prefix + 1);
  await writeFile(journalPath, JSON.stringify({ ...journal, entries }));

  const raw = new Database(":memory:");
  try {
    const db = drizzle(raw);
    migrate(db, { migrationsFolder: folder });
    const stage = {
      tables: pragmaTables(raw),
      journalCount: (raw.query("SELECT COUNT(*) AS c FROM __drizzle_migrations").get() as { c: number }).c,
      columns: new Map<string, string[]>(),
    };
    // Continue on the SAME connection: the migrator only runs entries after
    // the last applied one, so this exercises the historical-release upgrade
    // path (fixture at prefix N → head), not a second fresh install.
    await writeFile(journalPath, JSON.stringify(fullJournal));
    migrate(db, { migrationsFolder: folder });
    const continued = {
      tables: pragmaTables(raw),
      journalCount: (raw.query("SELECT COUNT(*) AS c FROM __drizzle_migrations").get() as { c: number }).c,
      columns: new Map<string, string[]>(),
    };
    return { stage, continued };
  } finally {
    raw.close();
    // Restore the full journal even when a migrate call throws, so the temp
    // fixture folder is never left in a truncated state.
    await writeFile(journalPath, JSON.stringify(fullJournal));
  }
}

/**
 * Statement-order simulation of table existence across migration files.
 * CREATE adds, ALTER ... RENAME TO swaps, DROP (without IF EXISTS) requires
 * existence. Validates that no migration drops a table it did not create
 * (or inherit via rename) earlier.
 */
function validateDropTargets(): string[] {
  const files = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith(".sql")).sort();
  const existing = new Set<string>();
  const violations: string[] = [];
  for (const file of files) {
    const sql = readFileSync(join(DRIZZLE_DIR, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const create = stmt.match(/CREATE TABLE (?:IF NOT EXISTS )?`?([\w-]+)`?/);
      if (create !== null) {
        existing.add(create[1] as string);
        continue;
      }
      const rename = stmt.match(/ALTER TABLE `?([\w-]+)`? RENAME TO `?([\w-]+)`?/);
      if (rename !== null) {
        existing.delete(rename[1] as string);
        existing.add(rename[2] as string);
        continue;
      }
      // The IF EXISTS guard comes from the DROP statement itself, never from
      // other clauses in the same statement (e.g. a CREATE TABLE IF NOT
      // EXISTS in a multi-statement chunk).
      const drop = stmt.match(/DROP TABLE (IF EXISTS )?`?([\w-]+)`?/);
      if (drop !== null) {
        const guarded = drop[1] !== undefined;
        const target = drop[2] as string;
        if (!guarded && !existing.has(target)) {
          violations.push(`${file} drops ${target} which no earlier statement created`);
        }
        existing.delete(target);
      }
    }
  }
  return violations;
}

/** Journal `when` timestamps must be strictly ascending (drizzle compares against the last-applied row on upgrade). */
function journalOrderViolations(): string[] {
  const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const violations: string[] = [];
  for (let i = 1; i < journal.entries.length; i += 1) {
    const prev = journal.entries[i - 1] as { idx: number; tag: string; when: number };
    const cur = journal.entries[i] as { idx: number; tag: string; when: number };
    if (cur.when <= prev.when) {
      violations.push(`journal entry ${cur.idx} (${cur.tag}) when=${cur.when} is not > entry ${prev.idx} when=${prev.when}`);
    }
  }
  return violations;
}

test("every release prefix applies cleanly and continues to an identical head schema", async () => {
  const folder = await mkdtemp(join(tmpdir(), "terrence-mig-fixtures-"));
  try {
    await cp(DRIZZLE_DIR, folder, { recursive: true });
    const fullJournal = JSON.parse(await readFile(join(folder, "meta/_journal.json"), "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    const total = fullJournal.entries.length;
    expect(total).toBeGreaterThanOrEqual(59);

    const head = await applyPrefix(folder, null);
    expect(head.journalCount).toBe(total);

    for (let prefix = 0; prefix < total; prefix += 1) {
      const { stage, continued } = await applyPrefixThenHead(folder, prefix, fullJournal);
      expect(stage.journalCount, `prefix ${prefix} journal count`).toBe(prefix + 1);
      expect(continued.journalCount, `prefix ${prefix} continued journal count`).toBe(total);
      expect(continued.tables, `prefix ${prefix} continued table set`).toEqual(head.tables);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}, 120_000);

test("re-running the migrator on an already-migrated DB is a no-op", async () => {
  const folder = await mkdtemp(join(tmpdir(), "terrence-mig-idempotent-"));
  try {
    await cp(DRIZZLE_DIR, folder, { recursive: true });
    const raw = new Database(":memory:");
    try {
      const db = drizzle(raw);
      migrate(db, { migrationsFolder: folder });
      const first = pragmaTables(raw);
      migrate(db, { migrationsFolder: folder }); // must not throw, must not duplicate
      const second = pragmaTables(raw);
      const count = (raw.query("SELECT COUNT(*) AS c FROM __drizzle_migrations").get() as { c: number }).c;
      expect(second).toEqual(first);
      expect(count).toBeGreaterThanOrEqual(59);
    } finally {
      raw.close();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("milestone tables exist at the release point that introduced them", async () => {
  const folder = await mkdtemp(join(tmpdir(), "terrence-mig-milestones-"));
  try {
    await cp(DRIZZLE_DIR, folder, { recursive: true });
    const milestones: Array<[number, string, string[]]> = [
      [25, "assessment_results", ["check_results"]], // health assessments
      [35, "registry_gpg_keys", []],
      [37, "agent_jobs", []],
      [39, "saml_settings", []],
    ];
    for (const [prefix, table, siblings] of milestones) {
      const stage = await applyPrefix(folder, prefix);
      expect(stage.tables, `prefix ${prefix}`).toContain(table);
      for (const s of siblings) expect(stage.tables, `prefix ${prefix}`).toContain(s);
    }
    // 0050_fine_grained_token_scopes: ALTER-only — scopes column lands on api_tokens.
    const scoped = await applyPrefix(folder, 50);
    expect(scoped.columns.get("api_tokens")).toContain("scopes");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("every DROP TABLE targets a table created by an earlier statement", () => {
  expect(validateDropTargets()).toEqual([]);
});

test("journal when timestamps are strictly ascending (no upgrade-skip islands)", () => {
  // drizzle's migrator skips any journal entry whose `when` is not newer than
  // the last-applied row's created_at; an out-of-order island silently skips
  // those migrations on upgrade and later migrations then fail. This pins the
  // ordering so the landmine cannot regress.
  expect(journalOrderViolations()).toEqual([]);
});
