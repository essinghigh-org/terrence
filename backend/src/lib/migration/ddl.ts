// SQLite → PostgreSQL schema translation for the in-app migration wizard.
//
// The wizard copies the LIVE source database, not the app's migration chain:
// the target schema is derived from `sqlite_master` so boot-guard columns and
// legacy islands are reproduced faithfully, with column modes (boolean / json)
// overlaid from the Drizzle schema definition so the target accepts the same
// parameter bindings the app will issue on PostgreSQL (booleans as real
// booleans, JSON as jsonb).
//
// Design notes:
//   - Every generated statement is idempotent (CREATE TABLE IF NOT EXISTS,
//     DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT ... NOT VALID) so an
//     interrupted migration can be resumed safely.
//   - Foreign keys are added in a separate pass, NOT VALID: new rows are
//     still enforced (the copy runs in topological order), and the final
//     verification step validates existing rows with VALIDATE CONSTRAINT.
//   - Triggers are reported, not translated (the app creates none of them
//     itself; PostgreSQL databases booted fresh never carry them either).
export type DrizzleColumnMode = "boolean" | "json";

export type ForeignKeyDef = Readonly<{
  columns: readonly string[];
  table: string;
  refColumns: readonly string[];
  onUpdate: string | null;
  onDelete: string | null;
}>;

export type ColumnDef = Readonly<{
  name: string;
  /** Normalized SQLite declared type (TEXT, INTEGER, SERIAL, REAL, NUMERIC, BLOB, BOOLEAN, DATETIME). */
  declaredType: string;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  /** Raw SQLite default expression, or null. */
  defaultExpr: string | null;
  /** True when the default could not be translated and was dropped. */
  defaultDropped: boolean;
  references: ForeignKeyDef | null;
  checksSkipped: number;
  collate: string | null;
}>;

export type TableDef = Readonly<{
  name: string;
  columns: readonly ColumnDef[];
  /** Table-level PRIMARY KEY (composite or non-column). */
  compositePk: readonly string[] | null;
  tableUniques: readonly (readonly string[])[];
  tableChecksSkipped: number;
  tableForeignKeys: readonly ForeignKeyDef[];
}>;

export type IndexDef = Readonly<{
  name: string;
  table: string;
  unique: boolean;
  /** Columns; COLLATE NOCASE columns are emitted as lower("col"). */
  columns: readonly string[];
  where: string | null;
  skipped: string | null;
}>;

export type SourceSchema = Readonly<{
  tables: readonly TableDef[];
  indexes: readonly IndexDef[];
  triggers: readonly { name: string; sql: string }[];
}>;

export type ColumnStorageMode = "boolean" | "json" | "integer" | "numeric" | "real" | "text" | "blob" | "datetime";

export type PostgresColumnType = Readonly<{
  sqlType: string;
  identity: boolean;
  mode: ColumnStorageMode;
}>;

const IDENTIFIER = /^(?:"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|([A-Za-z_][A-Za-z0-9_]*))/;

/** Parse a quoted or bare SQL identifier; returns the unquoted name. */
function parseIdentifier(sql: string, start: number): { name: string; end: number } | null {
  const rest = sql.slice(start);
  const match = IDENTIFIER.exec(rest);
  if (match === null) return null;
  const name = match[1] ?? match[2] ?? match[3] ?? "";
  const raw = match[0];
  return { name, end: start + raw.length };
}

/** Scan to the matching close paren of the open paren at `openIndex`. */
function scanBalanced(sql: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < sql.length; i += 1) {
    const ch = sql[i] ?? "";
    if (quote !== null) {
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a CREATE TABLE body into top-level comma-separated segments. */
function splitTopLevel(body: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] ?? "";
    if (quote !== null) {
      if (ch === quote) {
        if (body[i + 1] === quote) {
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      segments.push(body.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(body.slice(start));
  return segments.map((segment): string => segment.trim());
}

const CONSTRAINT_WORDS = new Set([
  "PRIMARY", "NOT", "UNIQUE", "DEFAULT", "REFERENCES", "COLLATE", "CHECK",
  "CONSTRAINT", "AUTOINCREMENT", "GENERATED", "ON", "DEFERRABLE", "MATCH",
]);

function normalizeType(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/\s+/g, " ").trim().replace(/\(\d+(?:,\s*\d+)?\)/, "");
  if (cleaned === "SERIAL" || cleaned === "BIGSERIAL") return "SERIAL";
  if (/^(?:UNSIGNED\s+)?(?:BIG\s+)?INT(?:EGER)?$/.test(cleaned) || cleaned === "SMALLINT" || cleaned === "TINYINT" || cleaned === "MEDIUMINT") {
    return "INTEGER";
  }
  if (cleaned === "TEXT" || cleaned === "CLOB" || /^CHAR(?:ACTER)?(?: VARYING)?$/.test(cleaned) || cleaned === "JSON" || cleaned === "JSONB" || cleaned === "UUID" || cleaned === "STRING") {
    return "TEXT";
  }
  if (cleaned === "REAL" || cleaned === "FLOAT" || cleaned === "DOUBLE" || cleaned === "DOUBLE PRECISION") return "REAL";
  if (cleaned === "NUMERIC" || cleaned === "DECIMAL" || cleaned === "DEC") return "NUMERIC";
  if (cleaned === "BLOB" || cleaned === "") return "BLOB";
  if (cleaned === "BOOLEAN" || cleaned === "BOOL") return "BOOLEAN";
  if (/^(?:DATETIME|TIMESTAMP|DATE|TIME)(?:\(.*\))?$/.test(cleaned)) return "DATETIME";
  // SQLite affinity fallback for exotic declared types.
  if (cleaned.includes('INT')) return "INTEGER";
  if (/CHAR|CLOB|TEXT/.test(cleaned)) return "TEXT";
  if (/REAL|FLOA|DOUB/.test(cleaned)) return "REAL";
  if (cleaned.includes('BLOB')) return "BLOB";
  return "NUMERIC";
}

/** Translate a SQLite DEFAULT expression to PostgreSQL, or null when unsupported. */
export function translateDefault(raw: string): { sql: string | null; dropped: boolean } {
  const expr = raw.trim();
  if (expr === "") return { sql: null, dropped: false };
  const upper = expr.toUpperCase();
  if (upper === "NULL") return { sql: "NULL", dropped: false };
  if (upper === "CURRENT_TIMESTAMP" || upper === "CURRENT_DATE" || upper === "CURRENT_TIME") {
    return { sql: upper, dropped: false };
  }
  if (upper === "TRUE" || upper === "FALSE") return { sql: upper, dropped: false };
  if (/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(expr)) return { sql: expr, dropped: false };
  if (expr.startsWith("'")) {
    // Single-quoted literal: validate balanced quotes; both dialects escape with ''.
    let quote = false;
    for (let i = 0; i < expr.length; i += 1) {
      const ch = expr[i] ?? "";
      if (ch === "'") {
        if (expr[i + 1] === "'") {
          i += 1;
          quote = false;
          continue;
        }
        quote = !quote;
      }
    }
    if (!quote) return { sql: expr, dropped: false };
    return { sql: null, dropped: true };
  }
  if (/^x'[0-9a-fA-F]*'$/.test(expr)) return { sql: expr, dropped: false };
  return { sql: null, dropped: true };
}

function parseReferenceClause(sql: string, start: number): { fk: ForeignKeyDef; end: number } | null {
  let pos = start;
  while (pos < sql.length && /\s/.test(sql[pos] ?? "")) pos += 1;
  const match = /^REFERENCES\s+/i.exec(sql.slice(pos));
  if (match === null) return null;
  pos += match[0].length;
  const table = parseIdentifier(sql, pos);
  if (table === null) return null;
  pos = table.end;
  while (pos < sql.length && /\s/.test(sql[pos] ?? "")) pos += 1;
  if ((sql[pos] ?? "") !== "(") return null;
  const close = scanBalanced(sql, pos);
  if (close < 0) return null;
  const cols: string[] = [];
  for (const raw of sql.slice(pos + 1, close).split(",")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const parsed = parseIdentifier(trimmed, 0);
    if (parsed === null || parsed.end !== trimmed.length) return null;
    cols.push(parsed.name);
  }
  const refColumns: string[] = [];
  for (const col of cols) {
    const parsed = parseIdentifier(col, 0);
    if (parsed === null || parsed.end !== col.length) return null;
    refColumns.push(parsed.name);
  }
  pos = close + 1;
  let onUpdate: string | null = null;
  let onDelete: string | null = null;
  for (;;) {
    const action = /^ON\s+(UPDATE|DELETE)\s+(NO\s+ACTION|CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT)/i.exec(sql.slice(pos));
    if (action === null) break;
    const kind = action[1]?.toLowerCase() ?? "";
    const value = action[2]?.toLowerCase().replace(/\s+/g, " ") ?? "";
    const mapped = value === "no action" ? null : value === "cascade" ? "CASCADE" : value === "set null" ? "SET NULL" : value === "set default" ? "SET DEFAULT" : "RESTRICT";
    if (kind === "update") onUpdate = mapped;
    else onDelete = mapped;
    pos += action[0].length;
    // Skip MATCH / DEFERRABLE trailing clauses.
    const matchClause = /^MATCH\s+\w+/i.exec(sql.slice(pos));
    if (matchClause !== null) pos += matchClause[0].length;
    const deferrable = /^(?:NOT\s+)?DEFERRABLE(?:\s+INITIALLY\s+(?:DEFERRED|IMMEDIATE))?/i.exec(sql.slice(pos));
    if (deferrable !== null) pos += deferrable[0].length;
  }
  return { fk: { columns: cols.map((c): string => c.trim()), table: table.name, refColumns, onUpdate, onDelete }, end: pos };
}

function parseConstraintTail(sql: string, start: number): {
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  defaultExpr: string | null;
  defaultDropped: boolean;
  references: ForeignKeyDef | null;
  checksSkipped: number;
  collate: string | null;
} {
  let pos = start;
  const result = {
    notNull: false,
    primaryKey: false,
    unique: false,
    defaultExpr: null as string | null,
    defaultDropped: false,
    references: null as ForeignKeyDef | null,
    checksSkipped: 0,
    collate: null as string | null,
  };
  for (;;) {
    while (pos < sql.length && /\s/.test(sql[pos] ?? "")) pos += 1;
    if (pos >= sql.length) break;
    const rest = sql.slice(pos);
    const primary = /^PRIMARY\s+KEY(?:\s+(?:ASC|DESC))?/i.exec(rest);
    if (primary !== null) {
      result.primaryKey = true;
      pos += primary[0].length;
      continue;
    }
    const notNull = /^NOT\s+NULL/i.exec(rest);
    if (notNull !== null) {
      result.notNull = true;
      pos += notNull[0].length;
      continue;
    }
    const unique = /^UNIQUE/i.exec(rest);
    if (unique !== null) {
      result.unique = true;
      pos += unique[0].length;
      continue;
    }
    const autoincrement = /^AUTOINCREMENT/i.exec(rest);
    if (autoincrement !== null) {
      pos += autoincrement[0].length;
      continue;
    }
    const collate = /^COLLATE\s+/i.exec(rest);
    if (collate !== null) {
      const ident = parseIdentifier(sql, pos + collate[0].length);
      if (ident !== null) {
        result.collate = ident.name;
        pos = ident.end;
        continue;
      }
      pos += collate[0].length;
      continue;
    }
    const check = /^CHECK\s*\(/i.exec(rest);
    if (check !== null) {
      const close = scanBalanced(sql, pos + check[0].length - 1);
      if (close >= 0) {
        result.checksSkipped += 1;
        pos = close + 1;
        continue;
      }
    }
    const generated = /^GENERATED\s+ALWAYS\s+AS/i.exec(rest);
    if (generated !== null) {
      // Generated columns are skipped (reported via checksSkipped so the
      // migration report notes the difference).
      result.checksSkipped += 1;
      break;
    }
    const defaultMatch = /^DEFAULT\b/i.exec(rest);
    if (defaultMatch !== null) {
      pos += defaultMatch[0].length;
      // Consume the expression until a top-level constraint keyword.
      let depth = 0;
      let quote: string | null = null;
      let exprEnd = -1;
      for (let i = pos; i < sql.length; i += 1) {
        const ch = sql[i] ?? "";
        if (quote !== null) {
          if (ch === quote) {
            if (sql[i + 1] === quote) {
              i += 1;
            } else {
              quote = null;
            }
          }
          continue;
        }
        if (ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === "(") {
          depth += 1;
          continue;
        }
        if (ch === ")") {
          depth -= 1;
          if (depth < 0) {
            exprEnd = i;
            break;
          }
          continue;
        }
        if (depth === 0 && /[A-Za-z_]/.test(ch)) {
          const wordMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
          const word = wordMatch?.[0] ?? "";
          if (CONSTRAINT_WORDS.has(word.toUpperCase())) {
            exprEnd = i;
            break;
          }
        }
      }
      if (exprEnd < 0) exprEnd = sql.length;
      const rawExpr = sql.slice(pos, exprEnd).trim();
      const translated = translateDefault(rawExpr);
      result.defaultExpr = translated.sql;
      result.defaultDropped = translated.dropped;
      pos = exprEnd;
      continue;
    }
    const references = parseReferenceClause(sql, pos);
    if (references !== null) {
      result.references = references.fk;
      pos = references.end;
      continue;
    }
    const onConflict = /^ON\s+CONFLICT/i.exec(rest);
    if (onConflict !== null) {
      pos += onConflict[0].length;
      continue;
    }
    const constraintName = /^CONSTRAINT\s+/i.exec(rest);
    if (constraintName !== null) {
      const ident = parseIdentifier(sql, pos + constraintName[0].length);
      if (ident !== null) {
        pos = ident.end;
        continue;
      }
    }
    // Unknown trailing clause: stop (the rest of the segment is not a
    // constraint we can interpret).
    break;
  }
  return result;
}

function parseTableLevelConstraint(segment: string): { kind: "pk" | "unique" | "fk" | "check" | "skip"; data: unknown } {
  // sqlite_master DDL uses backtick identifiers; every column list here must
  // be unquoted through parseIdentifier before it reaches the generators.
  const parseColumnList = (body: string): string[] | null => {
    const cols: string[] = [];
    for (const raw of body.split(",")) {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      const parsed = parseIdentifier(trimmed, 0);
      if (parsed === null || parsed.end !== trimmed.length) return null;
      cols.push(parsed.name);
    }
    return cols;
  };
  const primary = /^PRIMARY\s+KEY\s*\(/i.exec(segment);
  if (primary !== null) {
    const close = scanBalanced(segment, primary[0].length - 1);
    if (close >= 0) {
      const cols = parseColumnList(segment.slice(primary[0].length, close));
      if (cols !== null) return { kind: "pk", data: cols };
    }
    return { kind: "skip", data: null };
  }
  const unique = /^UNIQUE\s*\(/i.exec(segment);
  if (unique !== null) {
    const close = scanBalanced(segment, unique[0].length - 1);
    if (close >= 0) {
      const cols = parseColumnList(segment.slice(unique[0].length, close));
      if (cols !== null) return { kind: "unique", data: cols };
    }
    return { kind: "skip", data: null };
  }
  // drizzle-generated sqlite DDL wraps table-level FKs in a named
  // CONSTRAINT clause; match both bare and named forms.
  const foreign = /^(?:CONSTRAINT\s+(?:"[^"]*"|\S+)\s+)?FOREIGN\s+KEY\s*\(/i.exec(segment);
  if (foreign !== null) {
    const close = scanBalanced(segment, foreign[0].length - 1);
    if (close < 0) return { kind: "skip", data: null };
    const cols: string[] = [];
    for (const raw of segment.slice(foreign[0].length, close).split(",")) {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      const parsed = parseIdentifier(trimmed, 0);
      if (parsed === null || parsed.end !== trimmed.length) return { kind: "skip", data: null };
      cols.push(parsed.name);
    }
    const ref = parseReferenceClause(segment, close + 1);
    if (ref === null) return { kind: "skip", data: null };
    return { kind: "fk", data: { ...ref.fk, columns: cols } };
  }
  if (/^CHECK\s*\(/i.test(segment)) return { kind: "check", data: null };
  return { kind: "skip", data: null };
}

function parseColumnSegment(segment: string): ColumnDef | null {
  const ident = parseIdentifier(segment, 0);
  if (ident === null) return null;
  let pos = ident.end;
  while (pos < segment.length && /\s/.test(segment[pos] ?? "")) pos += 1;
  // Declared type: one or two words (e.g. "DOUBLE PRECISION", "UNSIGNED BIG
  // INT") but never constraint keywords — a greedy multi-word match would
  // swallow "PRIMARY KEY" / "NOT NULL" into the type and lose the
  // constraints (the sqlite affinity fallback then silently erases them).
  const CONSTRAINT_LOOKAHEAD = "(?:PRIMARY|NOT|UNIQUE|DEFAULT|REFERENCES|COLLATE|CHECK|CONSTRAINT|AUTOINCREMENT|GENERATED|ON|DEFERRABLE|MATCH)\\b";
  const typeMatch = new RegExp(
    `^[A-Za-z]+(?:\\s+(?!${CONSTRAINT_LOOKAHEAD})[A-Za-z]+){0,2}(?:\\(\\d+(?:,\\s*\\d+)?\\))?`,
  ).exec(segment.slice(pos));
  const declaredRaw = typeMatch?.[0] ?? "";
  if (declaredRaw === "") return null;
  const declaredType = normalizeType(declaredRaw);
  pos += declaredRaw.length;
  const constraints = parseConstraintTail(segment, pos);
  return {
    name: ident.name,
    declaredType,
    notNull: constraints.notNull,
    primaryKey: constraints.primaryKey,
    unique: constraints.unique,
    defaultExpr: constraints.defaultExpr,
    defaultDropped: constraints.defaultDropped,
    references: constraints.references,
    checksSkipped: constraints.checksSkipped,
    collate: constraints.collate,
  };
}

/** Parse a single CREATE TABLE statement from sqlite_master. */
export function parseCreateTableSql(sql: string): TableDef | null {
  const header = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(sql);
  if (header === null) return null;
  const ident = parseIdentifier(sql, header[0].length);
  if (ident === null) return null;
  let pos = ident.end;
  while (pos < sql.length && /\s/.test(sql[pos] ?? "")) pos += 1;
  if ((sql[pos] ?? "") !== "(") return null;
  const close = scanBalanced(sql, pos);
  if (close < 0) return null;
  const body = sql.slice(pos + 1, close);
  const segments = splitTopLevel(body);

  const columns: ColumnDef[] = [];
  let compositePk: string[] | null = null;
  const tableUniques: string[][] = [];
  const tableForeignKeys: ForeignKeyDef[] = [];
  let tableChecksSkipped = 0;
  for (const segment of segments) {
    const tableLevel = parseTableLevelConstraint(segment);
    if (tableLevel.kind === "pk") {
      compositePk = tableLevel.data as string[];
      continue;
    }
    if (tableLevel.kind === "unique") {
      tableUniques.push(tableLevel.data as string[]);
      continue;
    }
    if (tableLevel.kind === "fk") {
      tableForeignKeys.push(tableLevel.data as ForeignKeyDef);
      continue;
    }
    if (tableLevel.kind === "check") {
      tableChecksSkipped += 1;
      continue;
    }
    const column = parseColumnSegment(segment);
    if (column !== null) {
      columns.push(column);
      continue;
    }
    // Unparseable segment: leave a marker column so the migration report can
    // surface it instead of silently dropping data-bearing DDL.
    columns.push({
      name: `__unparsed_${columns.length}`,
      declaredType: "TEXT",
      notNull: false,
      primaryKey: false,
      unique: false,
      defaultExpr: null,
      defaultDropped: false,
      references: null,
      checksSkipped: 1,
      collate: null,
    });
  }
  return { name: ident.name, columns, compositePk, tableUniques, tableChecksSkipped, tableForeignKeys };
}

/** Map a SQLite declared type (+ drizzle mode) to a PostgreSQL column type. */
export function postgresColumnType(def: ColumnDef, drizzleMode: DrizzleColumnMode | undefined): PostgresColumnType {
  if (drizzleMode === "boolean") return { sqlType: "boolean", identity: false, mode: "boolean" };
  if (drizzleMode === "json") return { sqlType: "jsonb", identity: false, mode: "json" };
  switch (def.declaredType) {
    case "SERIAL":
      return { sqlType: "bigint", identity: true, mode: "integer" };
    case "INTEGER":
      return { sqlType: "bigint", identity: def.primaryKey, mode: "integer" };
    case "REAL":
      return { sqlType: "double precision", identity: false, mode: "real" };
    case "NUMERIC":
      return { sqlType: "numeric", identity: false, mode: "numeric" };
    case "BLOB":
      return { sqlType: "bytea", identity: false, mode: "blob" };
    case "BOOLEAN":
      return { sqlType: "boolean", identity: false, mode: "boolean" };
    case "DATETIME":
      return { sqlType: "timestamp", identity: false, mode: "datetime" };
    default:
      return { sqlType: "text", identity: false, mode: "text" };
  }
}

/** Generate the idempotent CREATE TABLE statement for PostgreSQL. */
export function generateCreateTableSql(table: TableDef, modes: ReadonlyMap<string, DrizzleColumnMode>): string {
  const columnLines: string[] = [];
  for (const column of table.columns) {
    const pg = postgresColumnType(column, modes.get(column.name));
    const parts: string[] = [`"${column.name}"`, pg.sqlType];
    if (pg.identity) parts.push("GENERATED BY DEFAULT AS IDENTITY");
    if (column.primaryKey && table.compositePk === null) parts.push("PRIMARY KEY");
    if (column.notNull) parts.push("NOT NULL");
    if (column.unique && !column.primaryKey) parts.push("UNIQUE");
    if (column.defaultExpr !== null && !pg.identity) {
      // SQLite stores booleans as 1/0 even when the drizzle mode says
      // boolean; PostgreSQL needs true/false literals.
      let defaultSql = column.defaultExpr;
      if (pg.mode === "boolean" && (defaultSql === "1" || defaultSql === "0")) {
        defaultSql = defaultSql === "1" ? "true" : "false";
      }
      parts.push(`DEFAULT ${defaultSql}`);
    }
    columnLines.push(parts.join(" "));
  }
  if (table.compositePk !== null && table.compositePk.length > 0) {
    columnLines.push(`CONSTRAINT "pk_${table.name}" PRIMARY KEY (${table.compositePk.map((c): string => `"${c}"`).join(", ")})`);
  }
  table.tableUniques.forEach((cols, index): void => {
    columnLines.push(`CONSTRAINT "uq_${table.name}_${index}" UNIQUE (${cols.map((c): string => `"${c}"`).join(", ")})`);
  });
  return `CREATE TABLE IF NOT EXISTS "${table.name}" (\n  ${columnLines.join(",\n  ")}\n)`;
}

/** Generate idempotent ALTER statements that add a table's foreign keys NOT VALID. */
export function generateForeignKeySql(table: TableDef): string[] {
  const all: ForeignKeyDef[] = [
    ...table.columns.flatMap((column): ForeignKeyDef[] => column.references === null ? [] : [column.references]),
    ...table.tableForeignKeys,
  ];
  const statements: string[] = [];
  all.forEach((fk, index): void => {
    const name = `fk_${table.name}_${index}`;
    const onUpdate = fk.onUpdate === null ? "" : ` ON UPDATE ${fk.onUpdate}`;
    const onDelete = fk.onDelete === null ? "" : ` ON DELETE ${fk.onDelete}`;
    statements.push(
      `ALTER TABLE "${table.name}" DROP CONSTRAINT IF EXISTS "${name}";`,
      `ALTER TABLE "${table.name}" ADD CONSTRAINT "${name}" FOREIGN KEY (${fk.columns.map((c): string => `"${c}"`).join(", ")}) REFERENCES "${fk.table}" (${fk.refColumns.map((c): string => `"${c}"`).join(", ")})${onUpdate}${onDelete} NOT VALID;`,
    );
  });
  return statements;
}

/** Parse a CREATE INDEX statement from sqlite_master. */
export function parseCreateIndexSql(sql: string): IndexDef {
  // sqlite_master DDL uses backtick identifiers; normalize to double quotes so
  // the quoted-identifier patterns below (and the emitted PG DDL) see one form.
  const normalized = sql.replace(/`/g, "\"");
  const match = /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(normalized);
  if (match === null) {
    return { name: "", table: "", unique: false, columns: [], where: null, skipped: "unparseable index statement" };
  }
  const unique = match[1] !== undefined;
  let pos = match[0].length;
  const name = parseIdentifier(normalized, pos);
  if (name === null) return { name: "", table: "", unique, columns: [], where: null, skipped: "unparseable index name" };
  pos = name.end;
  const on = /^\s+ON\s+/i.exec(normalized.slice(pos));
  if (on === null) return { name: name.name, table: "", unique, columns: [], where: null, skipped: "missing ON clause" };
  pos += on[0].length;
  const table = parseIdentifier(normalized, pos);
  if (table === null) return { name: name.name, table: "", unique, columns: [], where: null, skipped: "missing index table" };
  pos = table.end;
  while (pos < normalized.length && /\s/.test(normalized[pos] ?? "")) pos += 1;
  if ((normalized[pos] ?? "") !== "(") return { name: name.name, table: table.name, unique, columns: [], where: null, skipped: "missing column list" };
  const close = scanBalanced(normalized, pos);
  if (close < 0) return { name: name.name, table: table.name, unique, columns: [], where: null, skipped: "unbalanced column list" };
  const rawColumns = normalized.slice(pos + 1, close).split(",").map((c): string => c.trim()).filter((c): boolean => c !== "");
  const columns: string[] = [];
  for (const raw of rawColumns) {
    const colMatch = /^"((?:[^"]|"")*)"(?:\s+COLLATE\s+(\w+))?$/i.exec(raw);
    if (colMatch !== null) {
      const colName = colMatch[1] ?? "";
      const collate = colMatch[2];
      // COLLATE NOCASE: preserve case-insensitive uniqueness semantics on PG
      // via lower(); for other collations fall back to the plain column.
      columns.push(collate !== undefined && collate.toUpperCase() === "NOCASE" ? `lower("${colName}")` : `"${colName}"`);
      continue;
    }
    const bare = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+COLLATE\s+(\w+))?$/i.exec(raw);
    if (bare !== null) {
      const colName = bare[1] ?? "";
      const collate = bare[2];
      columns.push(collate !== undefined && collate.toUpperCase() === "NOCASE" ? `lower("${colName}")` : `"${colName}"`);
      continue;
    }
    // Expression or unsupported form: keep verbatim (PG accepts most of the
    // same expression syntax).
    columns.push(raw);
  }
  let where: string | null = null;
  const whereMatch = /^\s+WHERE\s+(.+)$/is.exec(normalized.slice(close + 1));
  if (whereMatch !== null) where = whereMatch[1]?.trim() ?? null;
  return { name: name.name, table: table.name, unique, columns, where, skipped: null };
}

/**
 * Generate the idempotent CREATE INDEX statement for PostgreSQL.
 *
 * SQLite stores drizzle boolean columns as INTEGER, so partial-index WHERE
 * clauses written against them use `= 1` / `= 0` literals; PostgreSQL boolean
 * columns reject those, so the literals are rewritten to true/false for the
 * boolean columns of the index's table.
 */
export function generateCreateIndexSql(index: IndexDef, booleanColumns?: ReadonlySet<string>): string {
  const unique = index.unique ? "UNIQUE " : "";
  let where = index.where ?? "";
  if (where !== "" && booleanColumns !== undefined) {
    for (const column of booleanColumns) {
      const quotedCol = `"${column.replace(/"/g, "\"\"")}"`;
      // Matches `"col" = 1`, `"t"."col" = 1`, `1 = "col"`, and != / <> forms.
      // (?!\w) avoids rewriting `= 10` or `= 1x`; the column name is matched
      // verbatim so qualified references rewrite through their suffix.
      where = where.replace(
        new RegExp(`("(?:[^"]|"")*"\\.)?${quotedCol}\\s*(!=|<>|=)\\s*([01])(?!\\w)`, "g"),
        (_match, _prefix: string, op: string, value: string): string =>
          `${quotedCol} ${op} ${value === "1" ? "true" : "false"}`,
      );
      where = where.replace(
        new RegExp(`([01])(?!\\w)\\s*(!=|<>|=)\\s*${quotedCol}`, "g"),
        (_match, value: string, op: string): string => `${value === "1" ? "true" : "false"} ${op} ${quotedCol}`,
      );
    }
  }
  return `CREATE ${unique}INDEX IF NOT EXISTS "${index.name}" ON "${index.table}" (${index.columns.join(", ")})${where === "" ? "" : ` WHERE ${where}`}`;
}

/** Read the full schema (tables, indexes, triggers) from a SQLite connection. */
export function inspectSourceSchema(client: { query: (sql: string) => { all: () => unknown[] } }): SourceSchema {
  const rows = client.query(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
  ).all() as readonly { type: string; name: string; sql: string }[];
  const tables: TableDef[] = [];
  const indexes: IndexDef[] = [];
  const triggers: { name: string; sql: string }[] = [];
  for (const row of rows) {
    if (row.type === "table") {
      const parsed = parseCreateTableSql(row.sql);
      if (parsed !== null) tables.push(parsed);
    } else if (row.type === "index" && !row.name.startsWith("sqlite_autoindex_")) {
      indexes.push(parseCreateIndexSql(row.sql));
    } else if (row.type === "trigger") {
      triggers.push({ name: row.name, sql: row.sql });
    }
  }
  return { tables, indexes, triggers };
}

/** Collect boolean/json column modes from the Drizzle schema definitions.
 * Keyed by DATABASE names (table and column): the DDL path works with
 * sqlite_master names, which never match the camelCase export/property
 * names of the schema module. */
export function collectDrizzleModes(
  schemaModule: Readonly<Record<string, unknown>>,
): Map<string, Map<string, DrizzleColumnMode>> {
  const result = new Map<string, Map<string, DrizzleColumnMode>>();
  const columnsSymbol = Symbol.for("drizzle:Columns");
  const nameSymbol = Symbol.for("drizzle:Name");
  for (const [exportName, value] of Object.entries(schemaModule)) {
    const columns = (value as Record<PropertyKey, unknown> | null | undefined)?.[columnsSymbol];
    if (columns === null || columns === undefined || typeof columns !== "object") continue;
    const tableDbName = String((value as Record<PropertyKey, unknown>)[nameSymbol] ?? exportName);
    const modes = new Map<string, DrizzleColumnMode>();
    for (const column of Object.values(columns as Record<string, { name?: string; mode?: unknown }>)) {
      const mode = column.mode;
      if ((mode === "boolean" || mode === "json") && typeof column.name === "string") {
        modes.set(column.name, mode);
      }
    }
    if (modes.size > 0) result.set(tableDbName, modes);
  }
  return result;
}

/** Deterministic FK topological order (parents first) for the copy phase. */
export function orderTablesForCopy(tables: readonly TableDef[]): { ordered: readonly string[]; cycle: readonly string[] } {
  const names = new Set(tables.map((table): string => table.name));
  const edges = new Map<string, Set<string>>();
  for (const table of tables) {
    const targets = new Set<string>();
    for (const column of table.columns) {
      if (column.references !== null && names.has(column.references.table)) targets.add(column.references.table);
    }
    for (const fk of table.tableForeignKeys) {
      if (names.has(fk.table)) targets.add(fk.table);
    }
    edges.set(table.name, targets);
  }
  // indegree[name] = number of DISTINCT parent tables `name` references.
  // Self-references are excluded so they neither block ordering nor count as
  // cycles (a table referencing itself is ordered with the acyclic tables).
  const indegree = new Map<string, number>();
  for (const [name, targets] of edges) {
    let degree = 0;
    for (const target of targets) {
      if (target !== name) degree += 1;
    }
    indegree.set(name, degree);
  }
  const queue = [...names].filter((name): boolean => (indegree.get(name) ?? 0) === 0).sort();
  const ordered: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift() ?? "";
    ordered.push(name);
    for (const dependent of [...edges.entries()]
      .filter(([, targets]): boolean => targets.has(name))
      .map(([dependentName]): string => dependentName)) {
      if (dependent === name) continue;
      indegree.set(dependent, (indegree.get(dependent) ?? 0) - 1);
      if ((indegree.get(dependent) ?? 0) === 0) queue.push(dependent);
    }
    queue.sort();
  }
  const cycle = [...names].filter((name): boolean => (indegree.get(name) ?? 0) > 0);
  return { ordered, cycle };
}

/** Names never copied as regular tables (migration metadata, sequence bookkeeping). */
export const METADATA_TABLES: ReadonlySet<string> = new Set(["__drizzle_migrations", "sqlite_sequence"]);
