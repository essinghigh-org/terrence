// Dialect-neutral JSON helpers for drizzle sql fragments.
//
// SQLite exposes json_extract/json_patch/json_object; PostgreSQL uses the
// jsonb path operators and jsonb_set. These helpers keep the small set of
// JSON-path queries in the codebase portable across backends.
import { sql, type SQL, type AnyColumn } from "drizzle-orm";
import { isPostgres } from "../db/driver";

/**
 * Persisted JSON is data at a trust boundary.  Drizzle's `$type` annotation
 * only informs TypeScript and does not inspect a value read from an imported
 * or older database.  Keep the failure structured so callers can report the
 * row/field without logging the value itself.
 */
export class PersistedJsonValidationError extends Error {
  public readonly code: "missing" | "null" | "type" | "field" | "version";
  public readonly field: string;
  public readonly rowId: string | undefined;
  public readonly schemaVersion: number | undefined;

  constructor(
    field: string,
    code: "missing" | "null" | "type" | "field" | "version",
    detail: string,
    context: Readonly<{ rowId?: string; schemaVersion?: number }> = {},
  ) {
    super(`Invalid persisted JSON in ${field}${context.rowId === undefined ? "" : ` for row ${context.rowId}`}: ${detail}`);
    this.name = "PersistedJsonValidationError";
    this.code = code;
    this.field = field;
    this.rowId = context.rowId;
    this.schemaVersion = context.schemaVersion;
  }
}

export const PERSISTED_JSON_SCHEMA_VERSION = 1;

export type VersionedJsonEnvelope<T> = Readonly<{
  schemaVersion: number;
  data: T;
  /** Extension data is retained for forward-compatible round trips. */
  extensions?: Readonly<Record<string, unknown>>;
}>;

function objectRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function validationError(
  field: string,
  code: PersistedJsonValidationError["code"],
  detail: string,
  context: Readonly<{ rowId?: string; schemaVersion?: number }>,
): never {
  throw new PersistedJsonValidationError(field, code, detail, context);
}

/** Encode new values without changing the shape of legacy values in memory. */
export function versionedJson<T>(data: T, extensions?: Readonly<Record<string, unknown>>): VersionedJsonEnvelope<T> {
  return {
    schemaVersion: PERSISTED_JSON_SCHEMA_VERSION,
    data,
    ...(extensions === undefined ? {} : { extensions }),
  };
}

/**
 * Read a versioned value while explicitly adapting the oldest raw form.  The
 * adapter is intentionally supplied by the domain schema; this helper never
 * guesses that an arbitrary object is safe to execute.
 */
export function readVersionedJson<T>(
  raw: unknown,
  field: string,
  adaptLegacy: (value: unknown, context: Readonly<{ field: string; rowId?: string }>) => T,
  options: Readonly<{ rowId?: string | undefined; nullable?: boolean }> = {},
): Readonly<{ value: T | null; schemaVersion: number; extensions: Readonly<Record<string, unknown>> }> {
  const context = { field, ...(options.rowId === undefined ? {} : { rowId: options.rowId }) };
  if (raw === undefined) validationError(field, "missing", "value is missing", context);
  if (raw === null) {
    if (options.nullable === true) return { value: null, schemaVersion: 0, extensions: {} };
    validationError(field, "null", "value is null", context);
  }

  const record = objectRecord(raw);
  if (record !== undefined && Object.hasOwn(record, "schemaVersion")) {
    const schemaVersion = record["schemaVersion"];
    if (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
      validationError(field, "version", "schemaVersion must be a positive integer", context);
    }
    if (schemaVersion !== PERSISTED_JSON_SCHEMA_VERSION) {
      validationError(field, "version", `unsupported schemaVersion ${schemaVersion}`, { ...context, schemaVersion });
    }
    if (!Object.hasOwn(record, "data")) validationError(field, "field", "versioned value is missing data", { ...context, schemaVersion });
    const declaredExtensions = record["extensions"];
    if (declaredExtensions !== undefined && objectRecord(declaredExtensions) === undefined) {
      validationError(field, "field", "extensions must be an object", { ...context, schemaVersion });
    }
    const envelopeExtensions = Object.fromEntries(
      Object.entries(record).filter(([key]) => !["schemaVersion", "data", "extensions"].includes(key)),
    );
    const extensions = {
      ...(declaredExtensions as Readonly<Record<string, unknown>> | undefined ?? {}),
      ...envelopeExtensions,
    };
    return {
      value: adaptLegacy(record["data"], context),
      schemaVersion,
      extensions,
    };
  }

  return {
    value: adaptLegacy(raw, context),
    schemaVersion: 0,
    extensions: {},
  };
}

/**
 * Extract a scalar at a JSON path: SQLite `json_extract(col, '$.a.b')`
 * becomes PostgreSQL `col #>> '{a,b}'` (both return text/scalars).
 * The path uses SQLite's `$.a.b` shape (leading `$.` optional).
 */
export function jsonExtract(column: SQL | AnyColumn, path: string): SQL {
  const parts = path
    .replace(/^\$\.?/, "")
    .split(".")
    .map((part): string => part.replace(/"/g, ""));
  if (isPostgres) {
    const arrayLiteral = `{${parts.join(",")}}`;
    return sql`${column} #>> ${arrayLiteral}::text[]`;
  }
  return sql`json_extract(${column}, ${path})`;
}

/**
 * Set a key on a JSON object: SQLite `json_patch(coalesce(col,'{}'),
 * json_object('k', v))` becomes PostgreSQL `jsonb_set(coalesce(col,'{}'),
 * '{k}', to_jsonb(v))`. The key is a single JSON path segment.
 */
export function jsonSet(column: SQL | AnyColumn, key: string, value: SQL | AnyColumn): SQL {
  const safeKey = key.replace(/"/g, "");
  if (isPostgres) {
    const arrayLiteral = `{${safeKey}}`;
    // ::text cast: to_jsonb cannot infer a polymorphic type from an
    // untyped parameter (42804 otherwise).
    return sql`jsonb_set(coalesce(${column}, '{}'::jsonb), ${arrayLiteral}::text[], to_jsonb(${value}::text))`;
  }
  return sql`json_patch(coalesce(${column}, '{}'), json_object(${safeKey}, ${value}))`;
}
