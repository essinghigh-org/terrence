// Dialect-neutral JSON helpers for drizzle sql fragments.
//
// SQLite exposes json_extract/json_patch/json_object; PostgreSQL uses the
// jsonb path operators and jsonb_set. These helpers keep the small set of
// JSON-path queries in the codebase portable across backends.
import { sql, type SQL, type AnyColumn } from "drizzle-orm";
import { isPostgres } from "../db/driver";

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
