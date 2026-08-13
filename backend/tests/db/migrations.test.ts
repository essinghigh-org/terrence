import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

test("migrates a fresh database on startup", async () => {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-migrations-"));
  const dbModule = pathToFileURL(join(import.meta.dir, "../../src/db/index.ts")).href;
  const script = `
    const { db } = await import(${JSON.stringify(dbModule)});
    const { sql } = await import("drizzle-orm");
    const tables = await db.all(sql.raw("select name from sqlite_master where type = 'table'"));
    const runColumns = await db.all(sql.raw("PRAGMA table_info(runs)"));
    const organizationColumns = await db.all(sql.raw("PRAGMA table_info(organizations)"));
    const oauthClientColumns = await db.all(sql.raw("PRAGMA table_info(oauth_clients)"));
    const foreignKeys = await db.all(sql.raw("PRAGMA foreign_keys"));
    console.log(JSON.stringify({
      tables: tables.map(row => row.name),
      runColumns: runColumns.map(row => row.name),
      organizationColumns: organizationColumns.map(row => row.name),
      oauthClientColumns: oauthClientColumns.map(row => row.name),
      foreignKeys: foreignKeys[0].foreign_keys,
    }));
  `;

  try {
    const process = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        DATABASE_URL: `file:${join(testDir, "terrence.db")}`,
        STORAGE_DIR: join(testDir, "storage"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    if (exitCode !== 0) {
      console.error(stderr);
    }
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      tables: expect.arrayContaining([
        "agent_pool_allowed_projects",
        "agent_pool_allowed_workspaces",
        "agent_jobs",
        "api_tokens",
        "refresh_sessions",
        "github_app_installations",
        "github_webhook_deliveries",
        "registry_gpg_keys",
        "saml_settings",
        "organization_memberships",
        "runs",
        "variable_sets",
      ]),
      runColumns: expect.arrayContaining([
        "agent_id",
        "agent_pool_id",
        "plan_resource_imports",
        "apply_resource_imports",
      ]),
      organizationColumns: expect.arrayContaining(["saml_enabled", "owners_team_saml_role_id"]),
      oauthClientColumns: expect.arrayContaining(["agent_pool_id"]),
      foreignKeys: 1,
    });
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("repairs the explainer table when a legacy journal skips the repair migration", async () => {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-legacy-migration-"));
  const databasePath = join(testDir, "terrence.db");
  const migrationFolder = join(import.meta.dir, "../../drizzle");
  try {
    const raw = new Database(databasePath);
    migrate(drizzle(raw), { migrationsFolder: migrationFolder });
    raw.run("DROP TABLE run_explanations");
    raw.run("DELETE FROM __drizzle_migrations");
    raw.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [
      "legacy-last-migration",
      1787055000000,
    ]);
    raw.close();

    const dbModule = pathToFileURL(join(import.meta.dir, "../../src/db/index.ts")).href;
    const script = `
      const { db } = await import(${JSON.stringify(dbModule)});
      const { sql } = await import("drizzle-orm");
      const rows = await db.all(sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_explanations'"));
      console.log(JSON.stringify(rows));
    `;
    const process = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        DATABASE_URL: `file:${databasePath}`,
        STORAGE_DIR: join(testDir, "storage"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) console.error(stderr);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([{ name: "run_explanations" }]);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("repairs the scheduled_at column when a legacy journal skips the column migration", async () => {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-legacy-column-"));

  // Start from a fully migrated database, then reproduce production's state:
  // the scheduled_at column is missing and the journal holds fabricated rows
  // whose timestamps are newer than every journaled migration in the repo.
  // Drizzle then skips 0002_add_runs_scheduled_at exactly as it does on
  // production, and only the boot guard can repair it.
  const databasePath = join(testDir, "terrence.db");
  const migrationFolder = join(import.meta.dir, "../../drizzle");
  const raw = new Database(databasePath);
  migrate(drizzle(raw), { migrationsFolder: migrationFolder });
  raw.run("ALTER TABLE runs DROP COLUMN scheduled_at");
  raw.run("DELETE FROM __drizzle_migrations");
  raw.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [
    "fabricated-legacy-row",
    1787064000000,
  ]);
  raw.close();

  const dbModule = pathToFileURL(join(import.meta.dir, "../../src/db/index.ts")).href;
  const script = `
    const { db } = await import(${JSON.stringify(dbModule)});
    const { sql } = await import("drizzle-orm");
    const columns = await db.all(sql.raw("PRAGMA table_info(runs)"));
    const journal = await db.all(sql.raw("SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1"));
    console.log(JSON.stringify({ hasScheduledAt: columns.some(row => row.name === "scheduled_at"), journal }));
  `;
  try {
    const process = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        DATABASE_URL: `file:${databasePath}`,
        STORAGE_DIR: join(testDir, "storage"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) console.error(stderr);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      hasScheduledAt: true,
      // The guard must not touch the journal: the fabricated row stays the
      // newest so future journaled migrations keep skipping on this database.
      journal: [{ created_at: 1787064000000 }],
    });
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});
