#!/usr/bin/env bun
/**
 * Generate backend/src/db/schema-pg.ts — a static, self-contained pg-core
 * schema module derived from the canonical sqlite schema
 * (db/schema-sqlite.ts).
 *
 * Why static: drizzle-kit (migration generation) transpiles the schema entry
 * and rebinds its imports to the bundled drizzle core. A runtime-built
 * schema (db/pg-convert.ts) constructs columns from the INSTALLED drizzle-orm,
 * whose column internals differ from the bundled build — the bundled
 * IndexedColumn clone (JSON.parse(JSON.stringify(column.defaultConfig)))
 * fails on them. A static module the transpiler fully owns works, proven
 * with a probe before this script was written.
 *
 * The runtime converter (pg-convert.ts) remains the app's source of pg
 * tables; tests/db/schema-parity.test.ts asserts the two never drift.
 *
 * Regenerate with: bun run scripts/generate-pg-schema.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../src/db/schema-sqlite";

const OUT = join(import.meta.dir, "../src/db/schema-pg.ts");
const NAME = Symbol.for("drizzle:Name");
const COLUMNS = Symbol.for("drizzle:Columns");
const EXTRA = Symbol.for("drizzle:ExtraConfigBuilder");
const INLINE_FK = Symbol.for("drizzle:SQLiteInlineForeignKeys");

type Column = {
  name: string;
  dataType: string;
  columnType: string;
  notNull: boolean;
  primary: boolean;
  isUnique?: boolean;
  hasDefault?: boolean;
  default?: unknown;
  defaultFn?: (() => unknown) | null;
  mode?: string;
};

type Table = {
  [NAME]: string;
  [COLUMNS]: Record<string, Column>;
  [EXTRA]?: (table: Table) => unknown[];
  [INLINE_FK]?: Array<{
    onDelete?: string;
    onUpdate?: string;
    reference: () => { name?: string; columns: Column[]; foreignTable: Table; foreignColumns: Column[] };
  }>;
};

const tables = new Map<string, Table>();
for (const [key, value] of Object.entries(schema)) {
  if (value !== null && typeof value === "object" && (value as Record<PropertyKey, unknown>)[COLUMNS] !== undefined) {
    tables.set(key, value as Table);
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Tables and columns come from the sqlite schema module (a build-time input),
// but their names are interpolated into generated TypeScript identifiers.
// Reject anything that is not a safe identifier before emitting it.
function assertIdent(label: string, value: string): void {
  if (!IDENT.test(value)) {
    throw new Error(`Refusing to emit non-identifier ${label} "${value}" into generated schema`);
  }
}

const varFor = (table: Table): string => {
  for (const [key, candidate] of tables) {
    if (candidate === table) {
      assertIdent("table var", key);
      return key;
    }
  }
  throw new Error(`Table not found for ${String(table[NAME])}`);
};

const propByDbName = (table: Table): Map<string, string> => new Map(
  Object.entries(table[COLUMNS]).map(([prop, column]): [string, string] => [column.name, prop]),
);

function columnBuilder(
  column: Column,
  tableVar: string,
  props: Map<string, string>,
  fk: { targetVar: string; foreignProp: string; onDelete?: string; onUpdate?: string } | null,
): string {
  const dbName = JSON.stringify(column.name);
  let builder: string;
  switch (column.columnType) {
    case "SQLiteText":
      builder = `text(${dbName})`;
      break;
    case "SQLiteInteger":
      builder = `bigint(${dbName}, { mode: "number" })`;
      break;
    case "SQLiteBoolean":
      builder = `boolean(${dbName})`;
      break;
    case "SQLiteTextJson":
      builder = `jsonb(${dbName})`;
      break;
    default:
      throw new Error(`Unsupported column type ${column.columnType} on ${tableVar}.${props.get(column.name)}`);
  }
  const parts: string[] = [];
  if (column.notNull) parts.push(".notNull()");
  if (column.primary) parts.push(".primaryKey()");
  if (column.isUnique === true) parts.push(".unique()");
  if (column.hasDefault && column.default !== undefined) {
    parts.push(`.default(${JSON.stringify(column.default)})`);
  }
  if (column.defaultFn !== undefined && column.defaultFn !== null) {
    parts.push(`.$defaultFn(() => sqliteSchema.${tableVar}.${props.get(column.name)}.defaultFn!())`);
  }
  if (fk !== null) {
    // Column-level references are lazy (arrow function), so forward
    // references to later-declared tables are safe without ordering.
    const actions: string[] = [];
    if (fk.onDelete !== undefined) actions.push(`onDelete: ${JSON.stringify(fk.onDelete)}`);
    if (fk.onUpdate !== undefined) actions.push(`onUpdate: ${JSON.stringify(fk.onUpdate)}`);
    parts.push(`.references(() => ${fk.targetVar}.${fk.foreignProp}${actions.length > 0 ? `, { ${actions.join(", ")} }` : ""})`);
  }
  return builder + parts.join("");
}

/** Column dbName -> inline FK metadata for the table. */
function fksByColumn(table: Table): Map<string, { targetVar: string; foreignProp: string; onDelete?: string; onUpdate?: string }> {
  const map = new Map<string, { targetVar: string; foreignProp: string; onDelete?: string; onUpdate?: string }>();
  for (const fk of table[INLINE_FK] ?? []) {
    const ref = fk.reference();
    const local = ref.columns[0];
    const foreign = ref.foreignColumns[0];
    if (local === undefined || foreign === undefined) {
      throw new Error(`Composite or empty FK on ${String(table[NAME])}: the generator supports single-column FKs only`);
    }
    const targetVar = varFor(ref.foreignTable);
    const foreignProps = propByDbName(ref.foreignTable);
    const foreignProp = foreignProps.get(foreign.name) ?? foreign.name;
    assertIdent("foreign prop", foreignProp);
    map.set(local.name, {
      targetVar,
      foreignProp,
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
    });
  }
  return map;
}

const PARTIAL_INDEX_OVERRIDES: Readonly<Record<string, (props: Map<string, string>) => string>> = {
  projects_org_default_idx: (props): string =>
    `sql\`\${table.${props.get("is_default")}} = true\``,
};

function renderExtras(table: Table, props: Map<string, string>): string[] {
  const entries: string[] = [];
  for (const item of table[EXTRA]?.(table) ?? []) {
    const reference = (item as {
      reference?: () => { name?: string; columns: Column[]; foreignTable: Table; foreignColumns: Column[] };
      _onDelete?: string;
      _onUpdate?: string;
    }).reference;
    if (typeof reference === "function") {
      const ref = reference();
      const localRefs = ref.columns.map((column): string => `table.${props.get(column.name)}`).join(", ");
      const foreignProps = propByDbName(ref.foreignTable);
      const foreignTable = varFor(ref.foreignTable);
      const foreignRefs = ref.foreignColumns
        .map((column): string => `${foreignTable}.${foreignProps.get(column.name)}`)
        .join(", ");
      const onDelete = (item as { _onDelete?: string })._onDelete;
      const onUpdate = (item as { _onUpdate?: string })._onUpdate;
      const actions = [
        onDelete === undefined ? "" : `, onDelete: ${JSON.stringify(onDelete)}`,
        onUpdate === undefined ? "" : `, onUpdate: ${JSON.stringify(onUpdate)}`,
      ].join("");
      entries.push(
        `foreignKey({ columns: [${localRefs}], foreignColumns: [${foreignRefs}], name: ${JSON.stringify(ref.name)}${actions} })`,
      );
      continue;
    }
    const config = (item as { config?: Record<string, unknown> }).config;
    if (config !== undefined && typeof config.name === "string") {
      // Index or unique index. Own-table columns use the callback's `table`
      // parameter: the export const is not yet initialized while pgTable()
      // evaluates the config callback.
      const columns = (config.columns as Column[] | undefined) ?? [];
      const refs = columns.map((column): string => `table.${props.get(column.name)}`).join(", ");
      const fn = config.unique === true ? "uniqueIndex" : "index";
      let line = `${fn}(${JSON.stringify(config.name)}).on(${refs})`;
      const where = config.where;
      if (where !== undefined) {
        const override = PARTIAL_INDEX_OVERRIDES[config.name];
        if (override === undefined) {
          throw new Error(`Partial index ${config.name} has no pg WHERE override`);
        }
        line += `.where(${override(props)})`;
      }
      entries.push(line);
      continue;
    }
    if (Array.isArray((item as { columns?: unknown }).columns)) {
      // Composite primary key.
      const columns = (item as { columns: Column[]; name?: string }).columns;
      const refs = columns.map((column): string => `table.${props.get(column.name)}`).join(", ");
      const name = (item as { name?: string }).name;
      entries.push(
        name !== undefined
          ? `primaryKey({ name: ${JSON.stringify(name)}, columns: [${refs}] })`
          : `primaryKey({ columns: [${refs}] })`,
      );
      continue;
    }
    throw new Error(`Unsupported extra config on ${String(table[NAME])}: ${String((item as { constructor?: { name?: string } }).constructor?.name)}`);
  }
  return entries;
}

const lines: string[] = [];
lines.push("/* eslint-disable */");
lines.push("// AUTO-GENERATED by scripts/generate-pg-schema.ts — DO NOT EDIT.");
lines.push("// Static pg-core mirror of ./schema-sqlite for drizzle-kit migration");
lines.push("// generation. The runtime mirror (db/pg-convert.ts) is the app's pg");
lines.push("// schema; tests/db/schema-parity.test.ts asserts the two never drift.");
lines.push("import { sql } from \"drizzle-orm\";");
lines.push("import {");
lines.push("  bigint,");
lines.push("  boolean,");
lines.push("  foreignKey,");
lines.push("  index,");
lines.push("  jsonb,");
lines.push("  pgTable,");
lines.push("  primaryKey,");
lines.push("  text,");
lines.push("  uniqueIndex,");
lines.push("} from \"drizzle-orm/pg-core\";");
lines.push("import * as sqliteSchema from \"./schema-sqlite\";");
lines.push("");

for (const [tableVar, table] of tables) {
  const props = propByDbName(table);
  const fks = fksByColumn(table);
  const columnLines = Object.entries(table[COLUMNS]).map(
    ([prop, column]): string => `    ${prop}: ${columnBuilder(column, tableVar, props, fks.get(column.name) ?? null)},`,
  );
  const extras = renderExtras(table, props);
  const configBlock = extras.length > 0 ? `, (table) => [\n    ${extras.join(",\n    ")},\n  ]` : "";
  lines.push(`export const ${tableVar} = pgTable(${JSON.stringify(table[NAME])}, {`);
  lines.push(...columnLines);
  lines.push(`}${configBlock});`);
  lines.push("");
}

mkdirSync(join(import.meta.dir, "../src/db"), { recursive: true });
writeFileSync(OUT, lines.join("\n"));
console.log(`Wrote ${OUT} (${tables.size} tables)`);
