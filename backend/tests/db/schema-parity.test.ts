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

type Col = { name: string; columnType: string; notNull: boolean; primary: boolean; isUnique?: boolean };
type ExtraRow = { config?: { name?: string; unique?: boolean; columns?: Col[] } };

const REQUIRED_INDEXES: Readonly<Record<string, readonly { name: string; unique: boolean; columns: readonly string[] }[]>> = {
  agents: [{ name: "agents_last_ping_at_status_idx", unique: false, columns: ["last_ping_at", "status"] }],
  auditLogs: [
    { name: "audit_logs_created_at_idx", unique: false, columns: ["created_at"] },
    { name: "audit_logs_org_created_at_idx", unique: false, columns: ["org_id", "created_at"] },
    { name: "audit_logs_resource_idx", unique: false, columns: ["resource_type", "resource_id", "created_at", "id"] },
  ],
  runComments: [{ name: "run_comments_run_created_idx", unique: false, columns: ["run_id", "created_at", "id"] }],
  workspaceVariables: [{ name: "workspace_variables_workspace_key_idx", unique: true, columns: ["workspace_id", "category", "key"] }],
};

function dbName(table: object): string {
  return String((table as unknown as Record<PropertyKey, unknown>)[NAME]);
}

function columnFingerprint(table: object): Readonly<Record<string, Col>> {
  const out: Record<string, Col> = {};
  for (const column of Object.values((table as unknown as Record<PropertyKey, unknown>)[COLUMNS] as Record<string, Col & { hasDefault?: boolean; default?: unknown; hasDefaultFn?: boolean; defaultFn?: unknown }>)) {
    out[column.name] = {
      name: column.name,
      columnType: column.columnType,
      notNull: column.notNull,
      primary: column.primary,
      ...(column.isUnique === true ? { isUnique: true } : {}),
      // Include default/defaultFn where present so drift in defaults is caught
      ...((column as unknown as Record<string, unknown>)["hasDefault"] === true ? { hasDefault: true as const, default: (column as unknown as Record<string, unknown>)["default"] } : {}),
      ...((column as unknown as Record<string, unknown>)["hasDefaultFn"] === true ? { hasDefaultFn: true as const } : {}),
    } as Col;
  }
  return out;
}

function indexFingerprint(table: object): readonly { name: string; unique: boolean; columns: string[] }[] {
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

  test("runtime jsonb columns pass objects directly to Bun.SQL", () => {
    const runtime = buildPgSchema(sqliteSchema);
    const workspaceColumns = (runtime["workspaces"] as unknown as Record<PropertyKey, unknown>)[COLUMNS] as Record<
      string,
      { mapToDriverValue(value: unknown): unknown }
    >;
    const value = { identifier: "hashicorp/terraform", branch: "main" };
    expect(workspaceColumns["vcsRepo"]?.mapToDriverValue(value)).toBe(value);
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
      expect(runtimeFp).toEqual(staticFp.map(({ name: n, unique, columns }) => ({ name: n, unique, columnCount: columns.length })));
      const sqliteFp = indexFingerprint(sqliteTable as object);
      expect(staticFp).toEqual(sqliteFp);
      // Strengthen: also ensure unique flag and column names are not silently weakened
      for (const idx of staticFp) {
        expect(idx.columns.length, `index ${idx.name} on ${name} has empty columns`).toBeGreaterThan(0);
      }
    }
  });

  test("declares the required hot-path indexes in the canonical schema", () => {
    for (const [exportName, expectedIndexes] of Object.entries(REQUIRED_INDEXES)) {
      const table = sqliteSchema[exportName as keyof typeof sqliteSchema];
      expect(table, `canonical schema missing ${exportName}`).toBeDefined();
      const actual = indexFingerprint(table as object);
      for (const expected of expectedIndexes) {
        expect(actual, `missing index ${expected.name}`).toContainEqual({ ...expected, columns: [...expected.columns] });
      }
    }
  });

  test("foreign key counts agree between both mirrors and the sqlite schema", () => {
    const runtime = buildPgSchema(sqliteSchema);
    const sqliteFKSymbol = Symbol.for("drizzle:SQLiteInlineForeignKeys");
    const pgFKSymbol = Symbol.for("drizzle:PgInlineForeignKeys");
    for (const [exportName, sqliteTable] of Object.entries(sqliteSchema)) {
      if (sqliteTable === null || typeof sqliteTable !== "object" || (sqliteTable as unknown as Record<PropertyKey, unknown>)[COLUMNS] === undefined) continue;
      const name = dbName(sqliteTable as object);
      const sqliteFks = ((sqliteTable as unknown as Record<PropertyKey, unknown>)[sqliteFKSymbol] as unknown[] | undefined) ?? [];
      const runtimeFks = ((runtime[name] as unknown as Record<PropertyKey, unknown>)[pgFKSymbol] as unknown[] | undefined) ?? [];
      const staticFks = ((staticPg[exportName as keyof typeof staticPg] as unknown as Record<PropertyKey, unknown>)[pgFKSymbol] as unknown[] | undefined) ?? [];
      expect(runtimeFks.length, `runtime FK count mismatch on ${name}`).toBe(sqliteFks.length);
      expect(staticFks.length, `static FK count mismatch on ${name}`).toBe(sqliteFks.length);
      const fkDetails = (fks: unknown[]): readonly { onDelete: string; onUpdate: string; columnCount: number }[] =>
        (fks as readonly Record<string, unknown>[]).map((fk) => ({
          onDelete: typeof fk["onDelete"] === "string" ? fk["onDelete"] : "no action",
          onUpdate: typeof fk["onUpdate"] === "string" ? fk["onUpdate"] : "no action",
          columnCount: Array.isArray((fk as Record<string, unknown>)["columns"]) ? ((fk as Record<string, unknown>)["columns"] as unknown[]).length : Array.isArray((fk as Record<string, unknown>)["foreignColumns"]) ? ((fk as Record<string, unknown>)["foreignColumns"] as unknown[]).length : 0,
        })).sort((a, b) => a.onDelete.localeCompare(b.onDelete));
      expect(fkDetails(runtimeFks), `runtime FK details mismatch on ${name}`).toEqual(fkDetails(sqliteFks));
      expect(fkDetails(staticFks), `static FK details mismatch on ${name}`).toEqual(fkDetails(sqliteFks));
    }
  });
});
