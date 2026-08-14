// Schema parity: the runtime pg mirror (pg-convert.buildPgSchema) and the
// static drizzle-kit schema module (schema-pg.ts) must never drift. Both are
// derived from the same canonical sqlite schema, but through different code
// paths; this test pins them to structural equality so a change to either
// derivation is caught immediately.
import { describe, expect, test } from "bun:test";
import * as sqliteSchema from "../../src/db/schema-sqlite";
import { buildPgSchema } from "../../src/db/pg-convert";
import * as staticPg from "../../src/db/schema-pg";

const NAME = Symbol.for("drizzle:Name");
const COLUMNS = Symbol.for("drizzle:Columns");
const EXTRA = Symbol.for("drizzle:ExtraConfigBuilder");

type Col = { name: string; columnType: string; notNull: boolean; primary: boolean };
type ExtraRow = { config?: { name?: string; unique?: boolean; columns?: Col[] } };

function dbName(table: object): string {
  return String((table as unknown as Record<PropertyKey, unknown>)[NAME]);
}

function columnFingerprint(table: object): Readonly<Record<string, Col>> {
  const out: Record<string, Col> = {};
  for (const column of Object.values((table as unknown as Record<PropertyKey, unknown>)[COLUMNS] as Record<string, Col>)) {
    out[column.name] = {
      name: column.name,
      columnType: column.columnType,
      notNull: column.notNull,
      primary: column.primary,
    };
  }
  return out;
}

function indexFingerprint(table: object): ReadonlyArray<{ name: string; unique: boolean; columns: string[] }> {
  const extra = (table as { [EXTRA]?: (t: object) => unknown[] })[EXTRA];
  if (extra === undefined) return [];
  const rows = extra(table) as ExtraRow[];
  return rows
    .filter((row): row is ExtraRow & { config: { name: string; unique?: boolean; columns?: Col[] } } =>
      row.config !== undefined && typeof row.config.name === "string")
    .map((row) => ({
      name: row.config.name as string,
      unique: row.config.unique === true,
      // Runtime-built IndexedColumns expose an opaque name; the static module
      // (generated from the same sqlite schema) carries the real column
      // names, so full column identity is compared there.
      columns: (row.config.columns ?? []).map((column): string => column.name ?? ""),
    }))
    .sort((left, right): number => left.name.localeCompare(right.name));
}

describe("pg schema parity", () => {
  test("runtime mirror and static schema expose the same tables", () => {
    const runtime = buildPgSchema(sqliteSchema);
    const runtimeNames = new Set(Object.keys(runtime));
    const staticNames = new Set(
      Object.entries(staticPg)
        .filter(([, value]) => value !== null && typeof value === "object" && (value as unknown as Record<PropertyKey, unknown>)[COLUMNS] !== undefined)
        .map(([name]) => dbName(staticPg[name as keyof typeof staticPg] as object)),
    );
    expect([...runtimeNames].sort()).toEqual([...staticNames].sort());
  });

  test("columns are identical per table", () => {
    const runtime = buildPgSchema(sqliteSchema);
    for (const [exportName, sqliteTable] of Object.entries(sqliteSchema)) {
      if (sqliteTable === null || typeof sqliteTable !== "object" || (sqliteTable as unknown as Record<PropertyKey, unknown>)[COLUMNS] === undefined) continue;
      const name = dbName(sqliteTable as object);
      const runtimeTable = runtime[name];
      const staticTable = staticPg[exportName as keyof typeof staticPg];
      expect(runtimeTable, `runtime mirror missing table ${name}`).toBeDefined();
      expect(staticTable, `static schema missing table ${name}`).toBeDefined();
      expect(columnFingerprint(runtimeTable as object)).toEqual(columnFingerprint(staticTable as object));
    }
  });

  test("indexes are identical per table", () => {
    const runtime = buildPgSchema(sqliteSchema);
    for (const [exportName, sqliteTable] of Object.entries(sqliteSchema)) {
      if (sqliteTable === null || typeof sqliteTable !== "object" || (sqliteTable as unknown as Record<PropertyKey, unknown>)[COLUMNS] === undefined) continue;
      const name = dbName(sqliteTable as object);
      const runtimeTable = runtime[name];
      const staticTable = staticPg[exportName as keyof typeof staticPg];
      const runtimeFp = indexFingerprint(runtimeTable as object).map(({ name: n, unique, columns }) => ({ name: n, unique, columnCount: columns.length }));
      const staticFp = indexFingerprint(staticTable as object);
      // Full identity (real column names) is checked against the sqlite
      // schema; runtime vs static compares name/unique/column-count because
      // runtime IndexedColumns are opaque.
      expect(runtimeFp).toEqual(staticFp.map(({ name: n, unique, columns }) => ({ name: n, unique, columnCount: columns.length })));
      const sqliteFp = indexFingerprint(sqliteTable as object);
      expect(staticFp).toEqual(sqliteFp);
    }
  });

  test("foreign key counts agree between both mirrors and the sqlite schema", () => {
    const runtime = buildPgSchema(sqliteSchema);
    const sqliteFKSymbol = Symbol.for("drizzle:SQLiteInlineForeignKeys");
    const pgFKSymbol = Symbol.for("drizzle:PgInlineForeignKeys");
    for (const [exportName, sqliteTable] of Object.entries(sqliteSchema)) {
      if (sqliteTable === null || typeof sqliteTable !== "object" || (sqliteTable as unknown as Record<PropertyKey, unknown>)[COLUMNS] === undefined) continue;
      const name = dbName(sqliteTable as object);
      const sqliteCount = ((sqliteTable as unknown as Record<PropertyKey, unknown>)[sqliteFKSymbol] as unknown[] | undefined)?.length ?? 0;
      const runtimeCount = ((runtime[name] as unknown as Record<PropertyKey, unknown>)[pgFKSymbol] as unknown[] | undefined)?.length ?? 0;
      const staticCount = ((staticPg[exportName as keyof typeof staticPg] as unknown as Record<PropertyKey, unknown>)[pgFKSymbol] as unknown[] | undefined)?.length ?? 0;
      expect(runtimeCount, `runtime FK count mismatch on ${name}`).toBe(sqliteCount);
      expect(staticCount, `static FK count mismatch on ${name}`).toBe(sqliteCount);
    }
  });
});
