/** Stringify an unknown JSON-ish value for comparison or display. Primitives
 * keep their String() form and nullish becomes "", but objects serialize as
 * JSON instead of String()'s "[object Object]".
 *
 * Lives in its own leaf module (no imports) so low-level modules like
 * storage-health can use it without cycling back through lib/utils, which
 * itself depends on storage-health. */
export function toComparableString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[object Object]";
  }
}
