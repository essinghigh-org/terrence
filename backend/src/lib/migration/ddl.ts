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

function isSerialType(cleaned: string): boolean {
  return cleaned === "SERIAL" || cleaned === "BIGSERIAL";
}

function isIntegerDeclaredType(cleaned: string): boolean {
  if (/^(?:UNSIGNED\s+)?(?:BIG\s+)?INT(?:EGER)?$/.test(cleaned)) return true;
  return cleaned === "SMALLINT" || cleaned === "TINYINT" || cleaned === "MEDIUMINT";
}

function isTextDeclaredType(cleaned: string): boolean {
  if (cleaned === "TEXT" || cleaned === "CLOB") return true;
  if (cleaned === "JSON" || cleaned === "JSONB") return true;
  if (cleaned === "UUID" || cleaned === "STRING") return true;
  return /^CHAR(?:ACTER)?(?: VARYING)?$/.test(cleaned);
}

function isRealDeclaredType(cleaned: string): boolean {
  return cleaned === "REAL" || cleaned === "FLOAT" || cleaned === "DOUBLE" || cleaned === "DOUBLE PRECISION";
}

function isNumericDeclaredType(cleaned: string): boolean {
  return cleaned === "NUMERIC" || cleaned === "DECIMAL" || cleaned === "DEC";
}

function isBlobDeclaredType(cleaned: string): boolean {
  return cleaned === "BLOB" || cleaned === "";
}

function isBooleanDeclaredType(cleaned: string): boolean {
  return cleaned === "BOOLEAN" || cleaned === "BOOL";
}

function isDateTimeDeclaredType(cleaned: string): boolean {
  return /^(?:DATETIME|TIMESTAMP|DATE|TIME)(?:\(.*\))?$/.test(cleaned);
}

function affinityFallback(cleaned: string): string | null {
  if (cleaned.includes('INT')) return "INTEGER";
  if (/CHAR|CLOB|TEXT/.test(cleaned)) return "TEXT";
  if (/REAL|FLOA|DOUB/.test(cleaned)) return "REAL";
  if (cleaned.includes('BLOB')) return "BLOB";
  return null;
}

function normalizeType(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/\s+/g, " ").trim().replace(/\(\d+(?:,\s*\d+)?\)/, "");
  if (isSerialType(cleaned)) return "SERIAL";
  if (isIntegerDeclaredType(cleaned)) return "INTEGER";
  if (isTextDeclaredType(cleaned)) return "TEXT";
  if (isRealDeclaredType(cleaned)) return "REAL";
  if (isNumericDeclaredType(cleaned)) return "NUMERIC";
  if (isBlobDeclaredType(cleaned)) return "BLOB";
  if (isBooleanDeclaredType(cleaned)) return "BOOLEAN";
  if (isDateTimeDeclaredType(cleaned)) return "DATETIME";
  const affinity = affinityFallback(cleaned);
  if (affinity !== null) return affinity;
  return "NUMERIC";
}

function isValidSingleQuotedLiteral(expr: string): boolean {
  let quote = false;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i] ?? "";
    if (ch === "'") {
      if (quote && expr[i + 1] === "'") {
        i += 1;
        continue;
      }
      quote = !quote;
    }
  }
  return !quote;
}

function translateDefaultLiteral(expr: string, upper: string): { sql: string | null; dropped: boolean } | null {
  if (expr === "") return { sql: null, dropped: false };
  if (upper === "NULL") return { sql: "NULL", dropped: false };
  if (upper === "CURRENT_TIMESTAMP" || upper === "CURRENT_DATE" || upper === "CURRENT_TIME") {
    return { sql: upper, dropped: false };
  }
  if (upper === "TRUE" || upper === "FALSE") return { sql: upper, dropped: false };
  if (/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(expr)) return { sql: expr, dropped: false };
  return null;
}

/** Translate a SQLite DEFAULT expression to PostgreSQL, or null when unsupported. */
export function translateDefault(raw: string): { sql: string | null; dropped: boolean } {
  const expr = raw.trim();
  const upper = expr.toUpperCase();
  const literal = translateDefaultLiteral(expr, upper);
  if (literal !== null) return literal;
  if (expr.startsWith("'")) {
    if (isValidSingleQuotedLiteral(expr)) return { sql: expr, dropped: false };
    return { sql: null, dropped: true };
  }
  if (/^x'[0-9a-fA-F]*'$/.test(expr)) return { sql: expr, dropped: false };
  return { sql: null, dropped: true };
}

function parseReferenceColumns(sql: string, open: number, close: number): string[] | null {
  const cols: string[] = [];
  for (const raw of sql.slice(open + 1, close).split(",")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const parsed = parseIdentifier(trimmed, 0);
    if (parsed === null || parsed.end !== trimmed.length) return null;
    cols.push(parsed.name);
  }
  return cols;
}

function buildReferenceColumns(cols: readonly string[]): string[] | null {
  const refColumns: string[] = [];
  for (const col of cols) {
    const parsed = parseIdentifier(col, 0);
    if (parsed === null || parsed.end !== col.length) return null;
    refColumns.push(parsed.name);
  }
  return refColumns;
}

function mapReferenceActionValue(value: string): string | null {
  if (value === "no action") return null;
  if (value === "cascade") return "CASCADE";
  if (value === "set null") return "SET NULL";
  if (value === "set default") return "SET DEFAULT";
  return "RESTRICT";
}

function parseReferenceActions(sql: string, start: number): { onUpdate: string | null; onDelete: string | null; end: number } {
  let pos = start;
  let onUpdate: string | null = null;
  let onDelete: string | null = null;
  for (;;) {
    while (pos < sql.length && /\s/.test(sql[pos] ?? "")) pos += 1;
    const action = /^ON\s+(UPDATE|DELETE)\s+(NO\s+ACTION|CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT)/i.exec(sql.slice(pos));
    if (action === null) break;
    const kind = action[1]?.toLowerCase() ?? "";
    const value = action[2]?.toLowerCase().replace(/\s+/g, " ") ?? "";
    const mapped = mapReferenceActionValue(value);
    if (kind === "update") onUpdate = mapped;
    else onDelete = mapped;
    pos += action[0].length;
    const matchClause = /^MATCH\s+\w+/i.exec(sql.slice(pos));
    if (matchClause !== null) pos += matchClause[0].length;
    const deferrable = /^(?:NOT\s+)?DEFERRABLE(?:\s+INITIALLY\s+(?:DEFERRED|IMMEDIATE))?/i.exec(sql.slice(pos));
    if (deferrable !== null) pos += deferrable[0].length;
  }
  return { onUpdate, onDelete, end: pos };
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
  const cols = parseReferenceColumns(sql, pos, close);
  if (cols === null) return null;
  const refColumns = buildReferenceColumns(cols);
  if (refColumns === null) return null;
  const actions = parseReferenceActions(sql, close + 1);
  return { fk: { columns: cols.map((c): string => c.trim()), table: table.name, refColumns, onUpdate: actions.onUpdate, onDelete: actions.onDelete }, end: actions.end };
}

function scanDefaultExprEnd(sql: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < sql.length; i += 1) {
    const ch = sql[i] ?? "";
    if (quote !== null) {
      if (ch === quote) {
        if (sql[i + 1] === quote) i += 1;
        else quote = null;
      }
      continue;
    }
    if (ch === "'") { quote = ch; continue; }
    if (ch === "(") { depth += 1; continue; }
    if (ch === ")") {
      depth -= 1;
      if (depth < 0) return i;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      const wordMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i));
      const word = wordMatch?.[0] ?? "";
      if (CONSTRAINT_WORDS.has(word.toUpperCase())) return i;
    }
  }
  return sql.length;
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- parser state is intentionally mutated as constraints are recognized
function tryParsePrimaryKey(rest: string, result: { primaryKey: boolean }): boolean {
  const primary = /^PRIMARY\s+KEY(?:\s+(?:ASC|DESC))?/i.exec(rest);
  if (primary === null) return false;
  result.primaryKey = true;
  return true;
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- parser state is intentionally mutated as constraints are recognized
function tryParseNotNull(rest: string, result: { notNull: boolean }): boolean {
  if (/^NOT\s+NULL/i.exec(rest) === null) return false;
  result.notNull = true;
  return true;
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- parser state is intentionally mutated as constraints are recognized
function tryParseUnique(rest: string, result: { unique: boolean }): boolean {
  if (/^UNIQUE/i.exec(rest) === null) return false;
  result.unique = true;
  return true;
}

function tryParseAutoincrement(rest: string): boolean {
  return /^AUTOINCREMENT/i.exec(rest) !== null;
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- parser state is intentionally mutated as constraints are recognized
function tryParseCollate(sql: string, pos: number, result: { collate: string | null }): number | null {
  const collate = /^COLLATE\s+/i.exec(sql.slice(pos));
  if (collate === null) return null;
  const ident = parseIdentifier(sql, pos + collate[0].length);
  if (ident !== null) {
    result.collate = ident.name;
    return ident.end;
  }
  return pos + collate[0].length;
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- parser state is intentionally mutated as constraints are recognized
function tryParseCheck(sql: string, pos: number, rest: string, result: { checksSkipped: number }): number | null {
  if (/^CHECK\s*\(/i.exec(rest) === null) return null;
  const close = scanBalanced(sql, pos + (/^CHECK\s*\(/i.exec(rest)?.[0].length ?? 0) - 1);
  if (close < 0) return null;
  result.checksSkipped += 1;
  return close + 1;
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- parser state is intentionally mutated as constraints are recognized
function tryParseGenerated(rest: string, result: { checksSkipped: number }): boolean {
  if (/^GENERATED\s+ALWAYS\s+AS/i.exec(rest) === null) return false;
  result.checksSkipped += 1;
  return true;
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- parser state is intentionally mutated as constraints are recognized
function tryParseDefault(sql: string, pos: number, result: { defaultExpr: string | null; defaultDropped: boolean }): number | null {
  if (/^DEFAULT\b/i.exec(sql.slice(pos)) === null) return null;
  const defLen = /^DEFAULT\b/i.exec(sql.slice(pos))?.[0].length ?? 0;
  const exprStart = pos + defLen;
  const exprEnd = scanDefaultExprEnd(sql, exprStart);
  const rawExpr = sql.slice(exprStart, exprEnd).trim();
  const translated = translateDefault(rawExpr);
  result.defaultExpr = translated.sql;
  result.defaultDropped = translated.dropped;
  return exprEnd;
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- parser state is intentionally mutated as constraints are recognized
function tryParseReferences(sql: string, pos: number, result: { references: ForeignKeyDef | null }): number | null {
  const references = parseReferenceClause(sql, pos);
  if (references === null) return null;
  result.references = references.fk;
  return references.end;
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- parser state is intentionally mutated as constraints are recognized
function tryParsePrimaryKeyStep(pos: number, rest: string, result: { primaryKey: boolean }): number | null {
  if (!tryParsePrimaryKey(rest, result)) return null;
  return pos + (/^PRIMARY\s+KEY(?:\s+(?:ASC|DESC))?/i.exec(rest)?.[0].length ?? 0);
}
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- parser state is intentionally mutated as constraints are recognized
function tryParseNotNullStep(pos: number, rest: string, result: { notNull: boolean }): number | null {
  if (!tryParseNotNull(rest, result)) return null;
  return pos + (/^NOT\s+NULL/i.exec(rest)?.[0].length ?? 0);
}
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- parser state is intentionally mutated as constraints are recognized
function tryParseUniqueStep(pos: number, rest: string, result: { unique: boolean }): number | null {
  if (!tryParseUnique(rest, result)) return null;
  return pos + (/^UNIQUE/i.exec(rest)?.[0].length ?? 0);
}
function tryParseAutoincrementStep(pos: number, rest: string): number | null {
  if (!tryParseAutoincrement(rest)) return null;
  return pos + (/^AUTOINCREMENT/i.exec(rest)?.[0].length ?? 0);
}
function tryParseConstraintStep(sql: string, pos: number, rest: string): number | null {
  if (/^CONSTRAINT\s+/i.exec(rest) === null) return null;
  const ident = parseIdentifier(sql, pos + (/^CONSTRAINT\s+/i.exec(rest)?.[0].length ?? 0));
  if (ident === null) return null;
  return ident.end;
}
function tryParseOnConflictStep(pos: number, rest: string): number | null {
  if (/^ON\s+CONFLICT/i.exec(rest) === null) return null;
  return pos + (/^ON\s+CONFLICT/i.exec(rest)?.[0].length ?? 0);
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- parser state is intentionally mutated as constraints are recognized
function parseConstraintTailStep(sql: string, pos: number, result: { notNull: boolean; primaryKey: boolean; unique: boolean; defaultExpr: string | null; defaultDropped: boolean; references: ForeignKeyDef | null; checksSkipped: number; collate: string | null }): { nextPos: number; shouldBreak: boolean } | null {
  const rest = sql.slice(pos);
  const primary = tryParsePrimaryKeyStep(pos, rest, result);
  if (primary !== null) return { nextPos: primary, shouldBreak: false };
  const notNull = tryParseNotNullStep(pos, rest, result);
  if (notNull !== null) return { nextPos: notNull, shouldBreak: false };
  const unique = tryParseUniqueStep(pos, rest, result);
  if (unique !== null) return { nextPos: unique, shouldBreak: false };
  const auto = tryParseAutoincrementStep(pos, rest);
  if (auto !== null) return { nextPos: auto, shouldBreak: false };
  const collateEnd = tryParseCollate(sql, pos, result);
  if (collateEnd !== null) return { nextPos: collateEnd, shouldBreak: false };
  const checkEnd = tryParseCheck(sql, pos, rest, result);
  if (checkEnd !== null) return { nextPos: checkEnd, shouldBreak: false };
  if (tryParseGenerated(rest, result)) return { nextPos: pos, shouldBreak: true };
  const defEnd = tryParseDefault(sql, pos, result);
  if (defEnd !== null) return { nextPos: defEnd, shouldBreak: false };
  const refEnd = tryParseReferences(sql, pos, result);
  if (refEnd !== null) return { nextPos: refEnd, shouldBreak: false };
  const conflict = tryParseOnConflictStep(pos, rest);
  if (conflict !== null) return { nextPos: conflict, shouldBreak: false };
  const constraint = tryParseConstraintStep(sql, pos, rest);
  if (constraint !== null) return { nextPos: constraint, shouldBreak: false };
  return null;
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
    const step = parseConstraintTailStep(sql, pos, result);
    if (step === null) break;
    if (step.shouldBreak) break;
    pos = step.nextPos;
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
function buildColumnLine(column: ColumnDef, pg: PostgresColumnType, table: TableDef): string {
  const parts: string[] = [`"${column.name}"`, pg.sqlType];
  if (pg.identity) parts.push("GENERATED BY DEFAULT AS IDENTITY");
  if (column.primaryKey && table.compositePk === null) parts.push("PRIMARY KEY");
  if (column.notNull) parts.push("NOT NULL");
  if (column.unique && !column.primaryKey) parts.push("UNIQUE");
  if (column.defaultExpr !== null && !pg.identity) {
    let defaultSql = column.defaultExpr;
    if (pg.mode === "boolean" && (defaultSql === "1" || defaultSql === "0")) {
      defaultSql = defaultSql === "1" ? "true" : "false";
    }
    parts.push(`DEFAULT ${defaultSql}`);
  }
  return parts.join(" ");
}

function buildTableConstraints(table: TableDef): string[] {
  const lines: string[] = [];
  if (table.compositePk !== null && table.compositePk.length > 0) {
    lines.push(`CONSTRAINT "pk_${table.name}" PRIMARY KEY (${table.compositePk.map((c): string => `"${c}"`).join(", ")})`);
  }
  table.tableUniques.forEach((cols, index): void => {
    lines.push(`CONSTRAINT "uq_${table.name}_${index}" UNIQUE (${cols.map((c): string => `"${c}"`).join(", ")})`);
  });
  return lines;
}

export function generateCreateTableSql(table: TableDef, modes: Readonly<ReadonlyMap<string, DrizzleColumnMode>>): string {
  const columnLines: string[] = [];
  for (const column of table.columns) {
    const pg = postgresColumnType(column, modes.get(column.name));
    columnLines.push(buildColumnLine(column, pg, table));
  }
  columnLines.push(...buildTableConstraints(table));
  return `CREATE TABLE IF NOT EXISTS "${table.name}" (
  ${columnLines.join(",\n  ")}
)`;
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
function parseIndexHeader(normalized: string): { unique: boolean; pos: number } | null {
  const match = /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(normalized);
  if (match === null) return null;
  const unique = match[1] !== undefined;
  return { unique, pos: match[0].length };
}

function parseIndexName(normalized: string, pos: number, unique: boolean): { name: string; pos: number } | { error: IndexDef } {
  const name = parseIdentifier(normalized, pos);
  if (name === null) return { error: { name: "", table: "", unique, columns: [], where: null, skipped: "unparseable index name" } };
  return { name: name.name, pos: name.end };
}

function parseIndexTable(normalized: string, pos: number, name: string, unique: boolean): { table: string; pos: number } | { error: IndexDef } {
  const on = /^\s+ON\s+/i.exec(normalized.slice(pos));
  if (on === null) return { error: { name, table: "", unique, columns: [], where: null, skipped: "missing ON clause" } };
  const nextPos = pos + on[0].length;
  const table = parseIdentifier(normalized, nextPos);
  if (table === null) return { error: { name, table: "", unique, columns: [], where: null, skipped: "missing index table" } };
  return { table: table.name, pos: table.end };
}

function parseIndexColumnQuoted(raw: string): string | null {
  const colMatch = /^"((?:[^"]|"")*)"(?:\s+COLLATE\s+(\w+))?$/i.exec(raw);
  if (colMatch === null) return null;
  const colName = colMatch[1] ?? "";
  const collate = colMatch[2];
  return collate !== undefined && collate.toUpperCase() === "NOCASE" ? `lower("${colName}")` : `"${colName}"`;
}

function parseIndexColumnBare(raw: string): string | null {
  const bare = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+COLLATE\s+(\w+))?$/i.exec(raw);
  if (bare === null) return null;
  const colName = bare[1] ?? "";
  const collate = bare[2];
  return collate !== undefined && collate.toUpperCase() === "NOCASE" ? `lower("${colName}")` : `"${colName}"`;
}

function parseIndexColumns(normalized: string, pos: number, name: string, table: string, unique: boolean): { columns: string[]; pos: number } | { error: IndexDef } {
  let p = pos;
  while (p < normalized.length && /\s/.test(normalized[p] ?? "")) p += 1;
  if ((normalized[p] ?? "") !== "(") return { error: { name, table, unique, columns: [], where: null, skipped: "missing column list" } };
  const close = scanBalanced(normalized, p);
  if (close < 0) return { error: { name, table, unique, columns: [], where: null, skipped: "unbalanced column list" } };
  const rawColumns = normalized.slice(p + 1, close).split(",").map((c): string => c.trim()).filter((c): boolean => c !== "");
  const columns: string[] = [];
  for (const raw of rawColumns) {
    const quoted = parseIndexColumnQuoted(raw);
    if (quoted !== null) { columns.push(quoted); continue; }
    const bare = parseIndexColumnBare(raw);
    if (bare !== null) { columns.push(bare); continue; }
    columns.push(raw);
  }
  return { columns, pos: close };
}

export function parseCreateIndexSql(sql: string): IndexDef {
  const normalized = sql.replace(/`/g, "\"");
  const header = parseIndexHeader(normalized);
  if (header === null) {
    return { name: "", table: "", unique: false, columns: [], where: null, skipped: "unparseable index statement" };
  }
  const nameRes = parseIndexName(normalized, header.pos, header.unique);
  if ("error" in nameRes) return nameRes.error;
  const tableRes = parseIndexTable(normalized, nameRes.pos, nameRes.name, header.unique);
  if ("error" in tableRes) return tableRes.error;
  const colRes = parseIndexColumns(normalized, tableRes.pos, nameRes.name, tableRes.table, header.unique);
  if ("error" in colRes) return colRes.error;
  const whereMatch = /^\s+WHERE\s+(.+)$/is.exec(normalized.slice(colRes.pos + 1));
  const where = whereMatch !== null ? (whereMatch[1]?.trim() ?? null) : null;
  return { name: nameRes.name, table: tableRes.table, unique: header.unique, columns: colRes.columns, where, skipped: null };
}

/**
 * Generate the idempotent CREATE INDEX statement for PostgreSQL.
 *
 * SQLite stores drizzle boolean columns as INTEGER, so partial-index WHERE
 * clauses written against them use `= 1` / `= 0` literals; PostgreSQL boolean
 * columns reject those, so the literals are rewritten to true/false for the
 * boolean columns of the index's table.
 */
export function generateCreateIndexSql(index: IndexDef, booleanColumns?: Readonly<ReadonlySet<string>>): string {
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
export function inspectSourceSchema(client: Readonly<{ query: (sql: string) => { all: () => unknown[] } }>): SourceSchema {
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
    const rawTableName = (value as Record<PropertyKey, unknown>)[nameSymbol];
    const tableDbName = typeof rawTableName === "string" ? rawTableName : exportName;
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
function buildDependencyEdges(tables: readonly TableDef[], names: Readonly<ReadonlySet<string>>): Map<string, Set<string>> {
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
  return edges;
}

function computeIndegrees(edges: Readonly<ReadonlyMap<string, Readonly<ReadonlySet<string>>>>): Map<string, number> {
  const indegree = new Map<string, number>();
  for (const [name, targets] of edges) {
    let degree = 0;
    for (const target of targets) {
      if (target !== name) degree += 1;
    }
    indegree.set(name, degree);
  }
  return indegree;
}

function topologicalSort(names: Readonly<ReadonlySet<string>>, edges: Readonly<ReadonlyMap<string, Readonly<ReadonlySet<string>>>>, initialIndegree: Readonly<ReadonlyMap<string, number>>): string[] {
  const indegree = new Map(initialIndegree);
  const queue = [...names].filter((name): boolean => (indegree.get(name) ?? 0) === 0).sort();
  const ordered: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift() ?? "";
    ordered.push(name);
    for (const dependent of [...edges.entries()].filter(([, targets]): boolean => targets.has(name)).map(([dependentName]): string => dependentName)) {
      if (dependent === name) continue;
      indegree.set(dependent, (indegree.get(dependent) ?? 0) - 1);
      if ((indegree.get(dependent) ?? 0) === 0) queue.push(dependent);
    }
    queue.sort();
  }
  return ordered;
}

export function orderTablesForCopy(tables: readonly TableDef[]): { ordered: readonly string[]; cycle: readonly string[] } {
  const names = new Set(tables.map((table): string => table.name));
  const edges = buildDependencyEdges(tables, names);
  const indegree = computeIndegrees(edges);
  const ordered = topologicalSort(names, edges, indegree);
  const cycle = [...names].filter((name): boolean => (indegree.get(name) ?? 0) > 0);
  return { ordered, cycle };
} 

/** Names never copied as regular tables (migration metadata, sequence bookkeeping). */
export const METADATA_TABLES: ReadonlySet<string> = new Set(["__drizzle_migrations", "sqlite_sequence"]);
