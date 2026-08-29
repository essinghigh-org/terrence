/**
 * JSON value contract for decoded payloads.
 *
 * JSON:API responses and localStorage documents arrive as JSON. These types
 * name that contract so dictionaries carry a concrete value union instead of
 * `unknown`, and callers decode individual fields with the type guards.
 */

/** Any value JSON can represent. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A JSON object (string-keyed, JSON values). */
export type JsonObject = Readonly<Record<string, JsonValue>>;
