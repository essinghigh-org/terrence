import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

/**
 * Regression test for the production upgrade crash (review follow-up).
 *
 * Generated SQLite migrations rebuild tables with the dance
 *   CREATE __new_x -> copy rows -> DROP x -> ALTER __new_x RENAME TO x.
 * When `x` is referenced by a drizzle-generated FK-enforcement trigger that
 * lives on a *different* table (e.g. `github_app_installations_reference_
 * check_delete` references `policy_sets`), `DROP x` makes SQLite rewrite that
 * trigger's body to point at the now-missing table. The subsequent RENAME
 * then fails with "no such table: main.x". This broke real prod upgrades at
 * migration 0022 (policy_sets): prod had the schema applied out-of-band with
 * only 9 of 25 journal rows present, so the migrator replayed 0022 and
 * crashed.
 *
 * The fix in src/db/index.ts wraps the migrator in `PRAGMA legacy_alter_table
 * = ON`, which suppresses the trigger-body rewrite during ALTER. This test
 * pins that behavior so the regression cannot silently return.
 */
function buildProdShape(db: Database): void {
  db.run("PRAGMA foreign_keys = OFF;");
  db.run(`
    CREATE TABLE organizations (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE policy_sets (
      id text PRIMARY KEY NOT NULL,
      org_id text NOT NULL,
      name text NOT NULL,
      policy_update_patterns text DEFAULT '[]' NOT NULL,
      created_at integer NOT NULL,
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON UPDATE no action ON DELETE cascade
    );
  `);
  // A sibling table carrying drizzle's generated FK-enforcement trigger that
  // references policy_sets. This mirrors the real
  // `github_app_installations_reference_check_delete` trigger shape: it lives
  // on another table and reads policy_sets in its body.
  db.run(`
    CREATE TABLE github_app_installations (
      id text PRIMARY KEY NOT NULL,
      policy_set_id text,
      FOREIGN KEY (policy_set_id) REFERENCES policy_sets(id) ON DELETE set null
    );
  `);
  db.run(`
    CREATE TRIGGER github_app_installations_reference_check_delete
    AFTER DELETE ON github_app_installations
    BEGIN
      SELECT CASE WHEN (SELECT 1 FROM policy_sets WHERE id = old.policy_set_id) THEN
        RAISE(ABORT, 'fk violation') END;
    END;
  `);
  db.run("INSERT INTO organizations (id, name) VALUES ('o1', 'org')");
  db.run(
    "INSERT INTO policy_sets (id, org_id, name, policy_update_patterns, created_at) VALUES ('p1', 'o1', 'ps', '[]', 0)",
  );
  db.run("INSERT INTO github_app_installations (id, policy_set_id) VALUES ('g1', 'p1')");
  db.run("PRAGMA foreign_keys = ON;");
}

function rebuildPolicySets(db: Database): void {
  db.run(`
    CREATE TABLE __new_policy_sets (
      id text PRIMARY KEY NOT NULL,
      org_id text NOT NULL,
      name text NOT NULL,
      policy_update_patterns text DEFAULT '[]' NOT NULL,
      created_at integer NOT NULL,
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON UPDATE no action ON DELETE cascade
    );
  `);
  db.run(
    "INSERT INTO __new_policy_sets (id, org_id, name, policy_update_patterns, created_at) SELECT id, org_id, name, policy_update_patterns, created_at FROM policy_sets",
  );
  db.run("DROP TABLE policy_sets");
  db.run("ALTER TABLE __new_policy_sets RENAME TO policy_sets");
}

test("table-rebuild migration fails without legacy_alter_table (documents the bug)", () => {
  const db = new Database(":memory:");
  buildProdShape(db);
  db.run("PRAGMA foreign_keys = OFF;");
  // Without the pragma, the RENAME collides with the trigger-body rewrite.
  expect(() => { rebuildPolicySets(db); }).toThrow(/no such table/i);
});

test("table-rebuild migration succeeds with legacy_alter_table (the fix)", () => {
  const db = new Database(":memory:");
  buildProdShape(db);
  db.run("PRAGMA foreign_keys = OFF;");
  db.run("PRAGMA legacy_alter_table = ON;");
  expect(() => { rebuildPolicySets(db); }).not.toThrow();
  db.run("PRAGMA legacy_alter_table = OFF;");
  db.run("PRAGMA foreign_keys = ON;");
  // The sibling trigger survives and still references the rebuilt table.
  const triggers = db
    .query("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    .all() as { name: string }[];
  expect(
    triggers.some((t) => t.name === "github_app_installations_reference_check_delete"),
  ).toBe(true);
  const rows = db.query("SELECT id FROM policy_sets").all() as { id: string }[];
  expect(rows.map((r) => r.id)).toEqual(["p1"]);
});
