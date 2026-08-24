// Postgres schema mirror builder.
//
// Terrence keeps ONE canonical schema definition (db/schema-sqlite.ts, the
// former db/schema.ts) and derives the PostgreSQL schema from it at runtime.
// Both dialects need real table objects at runtime (drizzle encodes the
// dialect into the query builder), so this module walks drizzle's table
// metadata and rebuilds every table with pg-core builders:
//
//   sqlite text                       -> pg text
//   sqlite integer (plain)            -> pg bigint (epoch-ms timestamps and
//                                        counters exceed int4 range)
//   sqlite integer { mode: "boolean"} -> pg boolean
//   sqlite integer { mode: "json" }   -> pg jsonb
//
// Column names, nullability, defaults, $defaultFn, primary keys, uniques,
// foreign keys (with cascade actions), indexes and partial-index predicates
// are reproduced exactly. Anything unexpected fails loudly instead of
// silently producing a divergent schema.
import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index as pgIndex,
  jsonb,
  pgTable,
  primaryKey as pgPrimaryKey,
  text as pgText,
  uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";

// drizzle-orm 0.45.2 ships a broken pg index builder: IndexBuilderOn.on()
// snapshots each column via JSON.parse(JSON.stringify(column.defaultConfig)),
// but 0.45.x columns have no defaultConfig property, so every .on() call
// throws ("undefined is not valid JSON"). The sqlite builder assigns
// directly instead. Workaround: give columns a serializable defaultConfig
// before the broken clone runs. The bundled drizzle-kit core carries its own
// (older, working) copy, so migration generation is unaffected. Patch once
// at module load; this module is the only pg-schema construction path.
{
  const proto = Object.getPrototypeOf(pgIndex("__terrence_pg_index_patch__"));
  const originalOn = (proto as { on?: unknown }).on;
  if (typeof originalOn === "function") {
    (proto as { on: (...columns: unknown[]) => unknown }).on = function (
      ...columns: unknown[]
    ): unknown {
      for (const column of columns) {
        if (column !== null && typeof column === "object" && !("defaultConfig" in column)) {
          try {
            Object.defineProperty(column, "defaultConfig", { value: {}, configurable: true });
          } catch {
            // Non-extensible column: let the original call fail naturally.
          }
        }
      }
      return (originalOn as (...cols: unknown[]) => unknown).apply(this, columns);
    };
  }
}

const COLS = Symbol.for("drizzle:Columns");
const EXTRA = Symbol.for("drizzle:ExtraConfigBuilder");
const FKS = Symbol.for("drizzle:SQLiteInlineForeignKeys");
const NAME = Symbol.for("drizzle:Name");

type AnyColumn = {
  name: string;
  table: unknown;
  [key: string]: unknown;
};

const columnTable = (column: AnyColumn): SqliteTable => {
  if (column.table === null || typeof column.table !== "object") {
    throw new Error("pg-convert: column is missing its table metadata");
  }
  return column.table as SqliteTable;
};

type SqliteTable = {
  [COLS]: Record<string, AnyColumn & { config: Record<string, unknown>; defaultFn?: unknown }>;
  [EXTRA]?: (table: unknown) => readonly unknown[];
  [FKS]?: readonly {
    reference: () => {
      columns: readonly AnyColumn[];
      foreignColumns: readonly AnyColumn[];
      onDelete?: string;
      onUpdate?: string;
    };
    onDelete?: string;
    onUpdate?: string;
  }[];
  [NAME]: string;
};

type IndexConfig = {
  name: string;
  columns: readonly AnyColumn[];
  unique?: boolean;
  where?: SQL & { text: string };
  type?: string;
};

type ResolvedFk = {
  localColumns: readonly string[];
  foreignTable: string;
  foreignColumns: readonly string[];
  onDelete?: string;
  onUpdate?: string;
};

/** Find a pg table column by its DATABASE name (pg tables key columns by
 * property name, e.g. `orgId`, while indexes/FKs reference `org_id`). */
function pgColumnByDbName(table: unknown, dbName: string): unknown {
  const columnsRecord = (table as Record<PropertyKey, unknown> | null | undefined)?.[
    Symbol.for("drizzle:Columns")
  ] as Record<string, { name: string }> | undefined;
  if (columnsRecord === undefined) return undefined;
  for (const column of Object.values(columnsRecord)) {
    if (column.name === dbName) return column;
  }
  return undefined;
}

const isIndexBuilder = (item: unknown): item is { config: IndexConfig } =>
  item !== null &&
  typeof item === "object" &&
  "config" in item &&
  (item as { config: IndexConfig }).config !== null &&
  typeof (item as { config: IndexConfig }).config === "object" &&
  "name" in (item as { config: IndexConfig }).config;

// Partial-index WHERE clauses cannot be replayed generically: the sqlite
// fragment references sqlite column objects (`is_default = 1`, where the
// boolean column renders as integer 1). Each partial index gets an explicit
// pg-core equivalent, keyed by index name. An unlisted partial index throws
// at build time so the mirror can never silently diverge.
const PARTIAL_INDEX_WHERE: Readonly<Record<string, (table: Record<string, unknown>) => SQL>> = {
  projects_org_default_idx: (table): SQL => sql`${table.isDefault} = true`,
  organization_invitations_org_email_pending_idx: (table): SQL => sql`${table.status} = 'pending'`,
};

function tableName(table: SqliteTable): string {
  const name = table[NAME];
  if (typeof name !== "string" || name === "") {
    throw new Error("pg-convert: table is missing its drizzle name metadata");
  }
  return name;
}

function columnName(column: AnyColumn): string {
  const config = column.config as { name?: string };
  const name = typeof config?.name === "string" ? config.name : column.name;
  if (typeof name !== "string" || name === "") {
    throw new Error("pg-convert: column is missing its name metadata");
  }
  return name;
}

function buildColumn(column: AnyColumn): unknown {
  const config = column.config as {
    dataType?: string;
    mode?: string;
    notNull?: boolean;
    primaryKey?: boolean;
    isUnique?: boolean;
    hasDefault?: boolean;
    default?: unknown;
  };
  const name = columnName(column);

  let builder: unknown;
  switch (config.dataType) {
    case "string":
      builder = pgText(name);
      break;
    case "number":
      // sqlite integer is a dynamic 64-bit type; postgres int4 overflows at
      // 2^31-1, which epoch-ms timestamps exceed every day. bigint preserves
      // every value the sqlite backend can store.
      builder = bigint(name, { mode: "number" });
      break;
    case "boolean":
      builder = boolean(name);
      break;
    case "json":
      builder = jsonb(name);
      break;
    default:
      throw new Error(
        `pg-convert: unsupported column dataType "${String(config.dataType)}" on "${name}"`,
      );
  }

  const b = builder as {
    notNull(): unknown;
    primaryKey(): unknown;
    unique(): unknown;
    default(value: unknown): unknown;
    $defaultFn(fn: () => unknown): unknown;
  };

  if (config.notNull === true) b.notNull();
  if (config.primaryKey === true) b.primaryKey();
  if (config.isUnique === true) b.unique();
  if (typeof column.defaultFn === "function") {
    b.$defaultFn(column.defaultFn as () => unknown);
  } else if (config.hasDefault === true) {
    b.default(config.default);
  }
  return builder;
}

function buildExtraConfig(
  table: SqliteTable,
  pg: Record<string, unknown>,
  tableColumns: Record<string, unknown>,
  columnsByDbName: Record<string, unknown>,
): unknown[] {
  const extra = table[EXTRA];
  if (typeof extra !== "function") return [];

  // Indexes/PKs may reference the table's OWN columns (not yet published to
  // `pg` during construction) or another table's columns.
  const resolveColumn = (c: AnyColumn): unknown => {
    const name = columnName(c);
    if (columnTable(c) === table) {
      const local = columnsByDbName[name];
      if (local === undefined) {
        throw new Error(`pg-convert: index/PK references unknown column "${name}" on "${tableName(table)}"`);
      }
      return local;
    }
    const target = pg[tableName(columnTable(c))];
    const column = pgColumnByDbName(target, name);
    if (column === undefined) {
      throw new Error(
        `pg-convert: index/PK references unknown column "${tableName(columnTable(c))}.${name}"`,
      );
    }
    return column;
  };

  const items: unknown[] = [];
  for (const item of extra(table)) {
    if (isIndexBuilder(item)) {
      const cfg = item.config;
      if (cfg.type !== undefined && cfg.type !== null) {
        throw new Error(`pg-convert: unsupported index type "${String(cfg.type)}" on "${cfg.name}"`);
      }
      const columns = cfg.columns.map(resolveColumn);
      const where = cfg.where !== undefined
        ? (() => {
            const override = PARTIAL_INDEX_WHERE[cfg.name];
            if (override === undefined) {
              throw new Error(
                `pg-convert: partial index "${cfg.name}" has no pg WHERE override; add one to PARTIAL_INDEX_WHERE`,
              );
            }
            return override(tableColumns);
          })()
        : undefined;
      const builder = cfg.unique === true ? pgUniqueIndex(cfg.name) : pgIndex(cfg.name);
      const built = builder.on(...(columns as [never, ...never[]]));
      if (where !== undefined) built.where(where);
      items.push(built);
    } else if (
      item !== null &&
      typeof item === "object" &&
      typeof (item as { reference?: unknown }).reference === "function"
    ) {
      // Composite foreign key expressed through the table's extra-config
      // callback (foreignKey({ ... })). Inline column-level foreign keys are
      // consumed separately from table[FKS]; the composite form only appears
      // here, so resolve it against the already-built pg tables.
      const ref = (item as {
        reference: () => {
          name?: string;
          columns: readonly AnyColumn[];
          foreignTable: unknown;
          foreignColumns: readonly AnyColumn[];
        };
        _onDelete?: string;
        _onUpdate?: string;
      }).reference();
      const local = ref.columns.map(resolveColumn);
      const foreignTable = tableName(ref.foreignTable as SqliteTable);
      const target = pg[foreignTable];
      if (target === undefined) {
        throw new Error(
          `pg-convert: composite FK on "${tableName(table)}" references unknown table "${foreignTable}"`,
        );
      }
      const foreign = ref.foreignColumns.map((c): unknown => {
        const column = pgColumnByDbName(target, columnName(c));
        if (column === undefined) {
          throw new Error(
            `pg-convert: composite FK column "${foreignTable}.${columnName(c)}" not found`,
          );
        }
        return column;
      });
      const fkBuilder = foreignKey({ columns: local as never, foreignColumns: foreign as never });
      const fkMeta = item as { _onDelete?: string; _onUpdate?: string };
      if (fkMeta._onDelete !== undefined) fkBuilder.onDelete(fkMeta._onDelete as never);
      if (fkMeta._onUpdate !== undefined) fkBuilder.onUpdate(fkMeta._onUpdate as never);
      items.push(fkBuilder);
    } else if (
      item !== null &&
      typeof item === "object" &&
      "columns" in item &&
      Array.isArray((item).columns)
    ) {
      // Composite primary key (PrimaryKeyBuilder).
      const columns = (item as { columns: readonly AnyColumn[] }).columns.map(resolveColumn);
      items.push(pgPrimaryKey({ columns: columns as never }));
    } else {
      throw new Error(
        `pg-convert: unsupported extra-config item ${String((item as { constructor?: { name?: string } })?.constructor?.name)}`,
      );
    }
  }
  return items;
}

export function buildPgSchema(sqliteSchema: Record<string, unknown>): Record<string, unknown> {
  // 1. Inventory sqlite tables.
  const sqliteTables = new Map<string, SqliteTable>();
  for (const [key, value] of Object.entries(sqliteSchema)) {
    if (value !== null && typeof value === "object" && COLS in value) {
      sqliteTables.set(key, value as SqliteTable);
    }
  }

  // 2. Resolve foreign keys up front (the metadata callbacks are deferred,
  // so reading them needs no construction order).
  const fksByTable = new Map<string, readonly ResolvedFk[]>();
  for (const [key, table] of sqliteTables) {
    const raw = table[FKS];
    if (raw === undefined) {
      fksByTable.set(key, []);
      continue;
    }
    const resolved: ResolvedFk[] = [];
    for (const fk of raw) {
      const ref = fk.reference();
      const localColumns = ref.columns.map(columnName);
      const firstForeign = ref.foreignColumns[0];
      if (firstForeign === undefined) {
        throw new Error("pg-convert: foreign key without foreign columns");
      }
      const foreignTable = tableName(columnTable(firstForeign));
      const foreignColumns = ref.foreignColumns.map(columnName);
      const fkActions: ResolvedFk = { localColumns, foreignTable, foreignColumns };
      const onDelete = fk.onDelete ?? ref.onDelete;
      const onUpdate = fk.onUpdate ?? ref.onUpdate;
      if (onDelete !== undefined) fkActions.onDelete = onDelete;
      if (onUpdate !== undefined) fkActions.onUpdate = onUpdate;
      resolved.push(fkActions);
    }
    fksByTable.set(key, resolved);
  }

  // 3. Topologically order tables so referenced tables exist before
  // referencing tables are constructed (pg-core resolves .references() at
  // table construction time).
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      throw new Error(
        `pg-convert: foreign-key cycle involving "${key}" cannot be ordered; break the cycle in the sqlite schema`,
      );
    }
    visiting.add(key);
    for (const fk of fksByTable.get(key) ?? []) {
      const target = [...sqliteTables.keys()].find((k): boolean => tableName(sqliteTables.get(k)!) === fk.foreignTable);
      if (target !== undefined && target !== key) visit(target);
    }
    visiting.delete(key);
    visited.add(key);
    ordered.push(key);
  };
  for (const key of sqliteTables.keys()) visit(key);

  // 4. Build pg tables in dependency order.
  const pg: Record<string, unknown> = {};
  for (const key of ordered) {
    const sqliteTable = sqliteTables.get(key)!;
    if (sqliteTable === undefined) {
      throw new Error(`pg-convert: table "${key}" vanished during ordering`);
    }
    const name = tableName(sqliteTable);
    const columns: Record<string, unknown> = {};
    // Foreign keys resolve columns by their DATABASE name; property names
    // (camelCase) differ from DB names (snake_case), so keep both indexes.
    const columnsByDbName: Record<string, unknown> = {};
    for (const [columnKey, column] of Object.entries(sqliteTable[COLS])) {
      columns[columnKey] = buildColumn(column);
      columnsByDbName[columnName(column)] = columns[columnKey];
    }

    // Column-level foreign keys (1:1 column mapping).
    const fks = fksByTable.get(key) ?? [];
    const simpleFks = fks.filter((fk): boolean => fk.localColumns.length === 1 && fk.foreignColumns.length === 1);
    const compositeFks = fks.filter((fk): boolean => !(fk.localColumns.length === 1 && fk.foreignColumns.length === 1));
    for (const fk of simpleFks) {
      const localColumn = fk.localColumns[0]!;
      const column = columnsByDbName[localColumn] as {
        references?: (ref: () => unknown, actions?: { onDelete?: string; onUpdate?: string }) => unknown;
      };
      if (column === undefined || typeof column.references !== "function") {
        throw new Error(`pg-convert: foreign key on "${name}.${localColumn}" cannot be attached`);
      }
      const target = pg[fk.foreignTable];
      if (target === undefined) {
        throw new Error(`pg-convert: foreign key on "${name}" references unknown table "${fk.foreignTable}"`);
      }
      const foreignColumn = fk.foreignColumns[0]!;
      const targetColumn = (target as Record<string, unknown>)[foreignColumn];
      if (targetColumn === undefined) {
        throw new Error(
          `pg-convert: foreign key on "${name}.${localColumn}" references unknown column "${fk.foreignTable}.${foreignColumn}"`,
        );
      }
      const actions: { onDelete?: string; onUpdate?: string } = {};
      if (fk.onDelete !== undefined) actions.onDelete = fk.onDelete;
      if (fk.onUpdate !== undefined) actions.onUpdate = fk.onUpdate;
      column.references((): unknown => targetColumn, actions);
    }

    const extra: unknown[] = buildExtraConfig(sqliteTable, pg, columns, columnsByDbName);
    for (const fk of compositeFks) {
      const local = fk.localColumns.map((c): unknown => {
        const column = columnsByDbName[c];
        if (column === undefined) throw new Error(`pg-convert: composite FK column "${c}" not found on "${name}"`);
        return column;
      });
      const target = pg[fk.foreignTable] as Record<string, unknown> | undefined;
      if (target === undefined) {
        throw new Error(`pg-convert: composite FK on "${name}" references unknown table "${fk.foreignTable}"`);
      }
      const foreign = fk.foreignColumns.map((c): unknown => {
        const column = target[c];
        if (column === undefined) {
          throw new Error(`pg-convert: composite FK column "${fk.foreignTable}.${c}" not found`);
        }
        return column;
      });
      const builder = foreignKey({
        columns: local as never,
        foreignColumns: foreign as never,
      });
      if (fk.onDelete !== undefined) builder.onDelete(fk.onDelete as never);
      if (fk.onUpdate !== undefined) builder.onUpdate(fk.onUpdate as never);
      extra.push(builder);
    }

    const pgTableValue = pgTable(
      name,
      columns as never,
      extra.length > 0 ? ((): unknown[] => extra) as never : undefined,
    );
    // Drizzle's jsonb mapper stringifies values for drivers such as postgres.js.
    // Bun.SQL accepts objects directly and would stringify that string again,
    // storing a JSON string instead of a JSON object.
    const pgColumns = (pgTableValue as unknown as Record<PropertyKey, unknown>)[COLS] as Record<
      string,
      { columnType?: string; mapToDriverValue?: (value: unknown) => unknown }
    >;
    for (const column of Object.values(pgColumns)) {
      if (column.columnType === "PgJsonb") {
        column.mapToDriverValue = (value: unknown): unknown => value;
      }
    }
    pg[name] = pgTableValue;
  }

  return pg;
}
