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
    const foreignKeys = await db.all(sql.raw("PRAGMA foreign_keys"));
    console.log(JSON.stringify({ tables: tables.map(row => row.name), foreignKeys: foreignKeys[0].foreign_keys }));
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
      tables: expect.arrayContaining(["api_tokens", "github_app_installations", "github_webhook_deliveries", "organization_memberships", "runs", "variable_sets"]),
      foreignKeys: 1,
    });
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});
