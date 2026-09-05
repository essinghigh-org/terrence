import { randomBytes } from "node:crypto";

// Preserve the compact formats exposed by these APIs. A UUID slice includes
// fixed version bits; random bytes give every suffix character full entropy.
const COMPACT_PREFIXES = new Set([
  "ws", "prj", "varset", "hyokcv", "sa", "stc", "st", "sst",
  "sds", "saj", "sdg", "sdr",
]);

/** Generate a new resource ID. Existing IDs remain opaque and are never rewritten. */
export function newResourceId(prefix: string): string {
  const bytes = prefix === "run" ? 7 : COMPACT_PREFIXES.has(prefix) ? 8 : null;
  const suffix = bytes === null ? crypto.randomUUID() : randomBytes(bytes).toString("hex");
  return `${prefix}-${suffix}`;
}
