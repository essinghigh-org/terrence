import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { cp, mkdtemp, rm } from "fs/promises";
import { readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * DB migration fixtures (review item 22.10), post-squash.
 *
 * The migration history was squashed to a baseline, with small repair
 * migrations added when a released baseline was missing a table. Properties
 * still pinned here:
 *   - the complete migration history applies cleanly to a fresh DB and
 *     records one applied row per migration,
 *   - the baseline is the COMPLETE schema (not a subset): the tables that
 *     later migrations + the runtime convergence path added are all present,
 *   - re-running the migrator on an already-migrated DB is a no-op,
 *   - any DROP TABLE in the baseline targets a table created within it
 *     (nothing drops tables it did not make),
 *   - journal `when` timestamps stay strictly ascending so a future
 *     multi-entry history cannot regress into upgrade-skip islands.
 */
const DRIZZLE_DIR = join(import.meta.dir, "../../drizzle");

/** Tables created by the runtime convergence path in src/db/index.ts (not by the baseline). */
const RUNTIME_TABLES = [
  "test_variables",
  "stacks",
  "hyok_customer_key_versions",
  "policy_set_tag_selectors",
  "admin_terraform_versions",
  "admin_sentinel_versions",
  "admin_opa_versions",
  "provider_sets",
  "agents",
  "github_app_installations",
  "org_token_ttl_policies",
  "oidc_configs",
  "hyok_configurations",
  "github_webhook_deliveries",
  "admin_settings",
  "workspace_transfers",
  "plan_exports",
  "cidr_range_lists",
  "cidr_ranges",
  "query_runs",
  "team_projects",
  "admin_general_settings",
  "site_data_retention_policies",
  "support_bundle_requests",
  "oauth_device_codes",
  "user_2fa",
  "task_stages",
  "policy_evaluations",
  "policy_set_outcomes",
];

function pragmaTables(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map((row) => row.name)
    .filter((name) => name !== "__drizzle_migrations");
}

function pragmaColumns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
}

/** Apply the whole (single-entry) baseline to a fresh in-memory DB. */
async function applyBaseline(folder: string): Promise<{ tables: string[]; columns: Map<string, string[]>; journalCount: number }> {
  const raw = new Database(":memory:");
  try {
    const db = drizzle(raw);
    migrate(db, { migrationsFolder: folder });
    const tables = pragmaTables(raw);
    const columns = new Map<string, string[]>();
    for (const table of tables) columns.set(table, pragmaColumns(raw, table));
    const journalCount = (raw.query("SELECT COUNT(*) AS c FROM __drizzle_migrations").get() as { c: number }).c;
    return { tables, columns, journalCount };
  } finally {
    raw.close();
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
      const createTable = /CREATE TABLE (?:IF NOT EXISTS )?`?([\w-]+)`?/.exec(stmt)?.[1];
      if (createTable !== undefined) {
        existing.add(createTable);
        continue;
      }
      const rename = /ALTER TABLE `?([\w-]+)`? RENAME TO `?([\w-]+)`?/.exec(stmt);
      const renamedFrom = rename?.[1];
      const renamedTo = rename?.[2];
      if (renamedFrom !== undefined && renamedTo !== undefined) {
        existing.delete(renamedFrom);
        existing.add(renamedTo);
        continue;
      }
      const drop = /DROP TABLE (IF EXISTS )?`?([\w-]+)`?/.exec(stmt);
      const target = drop?.[2];
      if (target !== undefined) {
        const guarded = drop?.[1] !== undefined;
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
    entries: readonly { idx: number; tag: string; when: number }[];
  };
  const violations: string[] = [];
  for (let i = 1; i < journal.entries.length; i += 1) {
    const prev = journal.entries[i - 1];
    const cur = journal.entries[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur.when <= prev.when) {
      violations.push(`journal entry ${cur.idx} (${cur.tag}) when=${cur.when} is not > entry ${prev.idx} when=${prev.when}`);
    }
  }
  return violations;
}

test("migration history applies cleanly to a fresh DB", async () => {
  const folder = await mkdtemp(join(tmpdir(), "terrence-mig-baseline-"));
  try {
    await cp(DRIZZLE_DIR, folder, { recursive: true });
    const { journalCount, tables } = await applyBaseline(folder);
    expect(journalCount).toBe(2);
    // The baseline must be substantial (it replaces 60 migrations), not a stub.
    expect(tables.length).toBeGreaterThan(90);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}, 60_000);

test("repairs run_explanations on a database with the baseline already applied", async () => {
  const folder = await mkdtemp(join(tmpdir(), "terrence-mig-repair-"));
  try {
    await cp(DRIZZLE_DIR, folder, { recursive: true });
    const raw = new Database(":memory:");
    try {
      const db = drizzle(raw);
      migrate(db, { migrationsFolder: folder });
      raw.run("DROP TABLE run_explanations");
      const latest = raw.query("SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1").get() as { hash: string };
      raw.run("DELETE FROM __drizzle_migrations WHERE hash = ?", [latest.hash]);
      migrate(db, { migrationsFolder: folder });
      expect(pragmaTables(raw)).toContain("run_explanations");
      expect(pragmaColumns(raw, "run_explanations")).toEqual([
        "id", "run_id", "kind", "model", "content", "thinking", "input_hash", "created_at",
      ]);
    } finally {
      raw.close();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}, 60_000);

test("baseline table set supersedes the runtime convergence tables (complete schema)", async () => {
  const folder = await mkdtemp(join(tmpdir(), "terrence-mig-complete-"));
  try {
    await cp(DRIZZLE_DIR, folder, { recursive: true });
    const { tables } = await applyBaseline(folder);
    // Every table the runtime convergence path in db/index.ts would create
    // (guarded CREATE TABLE IF NOT EXISTS) must already be present from the
    // baseline, proving the baseline is the complete schema — not a subset
    // that the app quietly patches up at boot.
    const missing = RUNTIME_TABLES.filter((t) => !tables.includes(t));
    expect(missing).toEqual([]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}, 60_000);

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
      expect(count).toBe(2);
    } finally {
      raw.close();
    }
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
  // ordering so the landmine cannot regress when the history grows again.
  expect(journalOrderViolations()).toEqual([]);
});
