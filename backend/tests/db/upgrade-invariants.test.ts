import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle as sqliteDrizzle } from "drizzle-orm/bun-sqlite";
import { migrate as migrateSqlite } from "drizzle-orm/bun-sqlite/migrator";
import { drizzle as pgDrizzle } from "drizzle-orm/bun-sql";
import { migrate as migratePostgres } from "drizzle-orm/bun-sql/migrator";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseConstraint } from "../../src/lib/database-errors";

const postgres = process.env["DATABASE_URL"]?.startsWith("postgres") === true;
const bundled = join(import.meta.dir, postgres ? "../../drizzle/pg" : "../../drizzle");
const journal = JSON.parse(await readFile(join(bundled, "meta/_journal.json"), "utf8")) as { entries: unknown[] };

for (const count of new Set([1, Math.max(1, journal.entries.length - 1)])) {
  test(`${postgres ? "PostgreSQL" : "SQLite"} upgrade from ${count} bundled migration(s) preserves identity and uniqueness`, async () => {
    const folder = await mkdtemp(join(tmpdir(), "terrence-upgrade-"));
    let sqlite: Database | undefined;
    let client: Bun.SQL | undefined;
    let admin: Bun.SQL | undefined;
    const databaseName = `upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await cp(bundled, folder, { recursive: true });
      await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }));
      let execute: (query: string, parameters?: readonly (string | number)[]) => Promise<unknown[]>;
      let migrate: (path: string) => Promise<void>;
      if (postgres) {
        const url = new URL(process.env["DATABASE_URL"] ?? "");
        admin = new Bun.SQL(url.toString());
        await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
        url.pathname = `/${databaseName}`;
        const connection = new Bun.SQL(url.toString());
        client = connection;
        execute = async (query, parameters = []) => connection.unsafe(query, [...parameters]);
        migrate = async (path) => { await migratePostgres(pgDrizzle(connection), { migrationsFolder: path }); };
      } else {
        const connection = new Database(":memory:");
        sqlite = connection;
        execute = async (query, parameters = []) => connection.query(query.replace(/\$\d+/g, "?")).all(...parameters);
        migrate = async (path) => { migrateSqlite(sqliteDrizzle(connection), { migrationsFolder: path }); };
      }
      await migrate(folder);
      await execute("INSERT INTO users (id, username, password_hash, is_site_admin) VALUES ($1, $2, $3, FALSE)", ["prior-user", "prior-username", "retained-hash"]);
      await migrate(bundled);
      await migrate(bundled);
      const rows = await execute("SELECT id, username, password_hash, is_site_admin FROM users WHERE id = $1", ["prior-user"]);
      expect(rows).toEqual([{ id: "prior-user", username: "prior-username", password_hash: "retained-hash", is_site_admin: postgres ? false : 0 }]);
      let conflict: unknown;
      try { await execute("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)", ["duplicate-user", "prior-username", "unused"]); } catch (error: unknown) { conflict = error; }
      expect(databaseConstraint(conflict)).toBe("unique");
      const applied = await execute(`SELECT COUNT(*) AS n FROM ${postgres ? "drizzle." : ""}__drizzle_migrations`);
      expect(Number((applied[0] as { n: unknown }).n)).toBe(journal.entries.length);
    } finally {
      sqlite?.close();
      await client?.close();
      if (admin !== undefined) {
        try { await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`); } finally { await admin.close(); }
      }
      await rm(folder, { recursive: true, force: true });
    }
  }, 30_000);
}
