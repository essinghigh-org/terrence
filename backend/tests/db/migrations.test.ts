import { expect, test } from "bun:test";
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
