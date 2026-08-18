// Regenerate src/db/pg-schema.ts (the export list) from the canonical sqlite
// schema. Run after adding/removing tables:
//   bun run scripts/regenerate-pg-schema-exports.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../src/db/schema-sqlite";

const names = Object.keys(schema).filter(
  (key): boolean =>
    schema[key] !== null &&
    typeof schema[key] === "object" &&
    Symbol.for("drizzle:Columns") in schema[key],
);

const header = [
  "// PostgreSQL schema mirror, derived at runtime from the canonical sqlite",
  "// schema (db/schema-sqlite.ts). Both backends therefore share one source of",
  "// truth: adding a column to the sqlite definition automatically mirrors it",
  "// here, and the drift check in tests/db/schema-parity.test.ts guards the",
  "// mapping.",
  "//",
  "// drizzle encodes the dialect into table/column objects, so the active",
  "// backend needs real pg-core tables (sqlite boolean columns map booleans to",
  "// 0/1 at expression-build time, which postgres rejects). db/schema.ts",
  "// re-exports this module's tables (cast to the sqlite types routes are",
  "// compiled against) when the postgres driver is active.",
  "//",
  "// AUTO-GENERATED export list; regenerate with:",
  "//   bun run scripts/regenerate-pg-schema-exports.ts",
  "import * as sqliteSchema from \"./schema-sqlite\";",
  "import { buildPgSchema } from \"./pg-convert\";",
  "",
  "const pg = buildPgSchema(sqliteSchema);",
  "",
  `const dbNameOf = (table: object): string =>`,
  `  String((table as Record<PropertyKey, unknown>)[Symbol.for("drizzle:Name")]);`,
  "",
  ...names.map((name): string => `export const ${name} = pg[dbNameOf(sqliteSchema.${name})];`),
  "",
];

writeFileSync(join(import.meta.dir, "../src/db/pg-schema.ts"), header.join("\n"));
console.log(`wrote ${names.length} table exports to src/db/pg-schema.ts`);
