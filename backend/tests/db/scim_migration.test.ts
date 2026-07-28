import { expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

test("creates the SCIM admin persistence tables on a fresh database", async () => {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-scim-migration-"));
  const dbModule = pathToFileURL(join(import.meta.dir, "../../src/db/index.ts")).href;
  const script = `
    const { db } = await import(${JSON.stringify(dbModule)});
    const { sql } = await import("drizzle-orm");
    const rows = await db.all(sql.raw("select name from sqlite_master where type = 'table'"));
    console.log(JSON.stringify(rows.map(row => row.name)));
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
    if (exitCode !== 0) console.error(stderr);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(expect.arrayContaining([
      "scim_group_memberships",
      "scim_groups",
      "scim_settings",
      "scim_tokens",
      "scim_user_identities",
      "team_scim_group_mappings",
    ]));
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});
