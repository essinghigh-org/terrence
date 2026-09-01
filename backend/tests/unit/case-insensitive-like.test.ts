import { expect, test } from "bun:test";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { isPostgres } from "../../src/db/driver";
import { caseInsensitiveLike } from "../../src/lib/utils";
import { users as sqliteUsers } from "../../src/db/schema-sqlite";

function renderedSql(expression: Parameters<SQLiteSyncDialect["sqlToQuery"]>[0]): string {
  return new SQLiteSyncDialect().sqlToQuery(expression).sql.toLowerCase();
}

test("uses SQLite LIKE for case-insensitive search predicates", () => {
  if (isPostgres) return;
  expect(renderedSql(caseInsensitiveLike(sqliteUsers.username, "%Alice%"))).toContain(" like ");
  expect(renderedSql(caseInsensitiveLike(sqliteUsers.username, "%Alice%"))).not.toContain(" ilike ");
});

test("uses PostgreSQL ILIKE when the database driver is PostgreSQL", async () => {
  const script = `
    const { caseInsensitiveLike } = await import(${JSON.stringify(new URL("../../src/lib/utils.ts", import.meta.url).href)});
    const { users } = await import(${JSON.stringify(new URL("../../src/db/schema-pg.ts", import.meta.url).href)});
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const query = new PgDialect().sqlToQuery(caseInsensitiveLike(users.username, "%Alice%"));
    process.stdout.write(JSON.stringify(query));
  `;
  const child = Bun.spawn([Bun.which("bun")!, "-e", script], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: {
      ...Bun.env,
      DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
      TERRENCE_DISABLE_WORKER: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`PostgreSQL dialect probe failed: ${stderr}`);
  const query = JSON.parse(stdout) as { sql: string };
  expect(query.sql.toLowerCase()).toContain(" ilike ");
  expect(query.sql.toLowerCase()).not.toContain(" like ");
});
