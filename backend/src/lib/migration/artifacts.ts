import type { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";

/** Durable archive files. Policy source paths are archive-relative metadata;
 * transient execution directories and files are not durable references. */
export const artifactReferenceInventory = [
  { table: "configuration_versions", column: "archive_path" },
  { table: "policy_set_versions", column: "archive_path" },
  { table: "registry_module_versions", column: "archive_path" },
  { table: "module_test_configuration_versions", column: "archive_path" },
] as const;

export type ArtifactReferenceCheck = Readonly<{
  table: string;
  column: string;
  checked: number;
  unavailable: number;
}>;

/** Verify references against the shared storage before permitting a switch.
 * Values, paths and artifact contents never enter the report. */
export async function verifyArtifactReferences(source: Readonly<Database>): Promise<readonly ArtifactReferenceCheck[]> {
  const checks: ArtifactReferenceCheck[] = [];
  for (const reference of artifactReferenceInventory) {
    const columns = source.query(`PRAGMA table_info("${reference.table}")`).all() as { name: string }[];
    if (!columns.some((column) => column.name === reference.column)) continue;
    let checked = 0;
    let unavailable = 0;
    const rows = source.query(`SELECT "${reference.column}" AS path FROM "${reference.table}" WHERE "${reference.column}" IS NOT NULL`).iterate();
    for (const row of rows) {
      checked += 1;
      const path = (row as { path: unknown }).path;
      if (typeof path !== "string" || path === "" || path.includes("\u0000")) {
        unavailable += 1;
        continue;
      }
      try {
        const info = await stat(path);
        if (!info.isFile()) unavailable += 1;
      } catch {
        unavailable += 1;
      }
    }
    checks.push({ table: reference.table, column: reference.column, checked, unavailable });
  }
  return checks;
}
