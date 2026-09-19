/**
 * HA-3B: enforce expand -> migrate -> contract in database migrations.
 *
 * The rule this script exists to protect:
 *
 *   A migration shipped in N must never make an N-1 replica unsafe while N-1
 *   remains within the supported rolling-upgrade window.
 *
 * Expanding is safe — an old replica ignores a column it does not know about.
 * Contracting is not, because an old replica is still reading and writing the
 * surface being removed or narrowed. During a rolling upgrade both are live at
 * once, so a contraction that ships alongside its own expansion breaks HA even
 * though the database itself stays perfectly available.
 *
 * Only the PostgreSQL migrations are checked. HA requires PostgreSQL; SQLite is
 * a single-process backend where no second replica can observe the old shape,
 * and drizzle legitimately rebuilds SQLite tables (create/copy/drop/rename) for
 * changes that are not contractions at all.
 *
 * Usage: bun scripts/check-schema-compatibility.ts
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

type Contraction = Readonly<{
  migration: string;
  dialect?: string;
  surface?: string;
  expandedIn?: string;
  approvedFor?: string;
  owner?: string;
  justification?: string;
}>;

type Register = Readonly<{
  protocolVersion: number;
  enforcedFrom?: string;
  contractions: readonly Contraction[];
}>;

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const MIGRATIONS_DIR = join(REPO_ROOT, "backend", "drizzle", "pg");
const REGISTER_PATH = join(REPO_ROOT, "backend", "src", "data", "schema_contractions.json");

/**
 * Each pattern names a way to take a surface away from a replica that is still
 * using it. A `NOT NULL` addition and a `DROP DEFAULT` are contractions even
 * though nothing is deleted: an N-1 replica that inserts without the column
 * starts failing the moment the constraint lands.
 */
const CONTRACTING_PATTERNS: readonly Readonly<{ label: string; pattern: RegExp }>[] = [
  { label: "drop column", pattern: /\bDROP\s+COLUMN\b/i },
  { label: "drop table", pattern: /\bDROP\s+TABLE\b/i },
  { label: "rename column", pattern: /\bRENAME\s+COLUMN\b/i },
  { label: "rename table", pattern: /\bALTER\s+TABLE\b[\s\S]*\bRENAME\s+TO\b/i },
  { label: "add not-null constraint", pattern: /\bSET\s+NOT\s+NULL\b/i },
  { label: "drop default", pattern: /\bDROP\s+DEFAULT\b/i },
  { label: "drop constraint", pattern: /\bDROP\s+CONSTRAINT\b/i },
  { label: "narrow column type", pattern: /\bALTER\s+COLUMN\b[\s\S]*\b(?:SET\s+DATA\s+)?TYPE\b/i },
  // A unique index is a new rule an older writer never agreed to follow.
  { label: "add unique index", pattern: /\bCREATE\s+UNIQUE\s+INDEX\b/i },
];

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

function migrationStem(fileName: string): string {
  return fileName.replace(/\.sql$/i, "");
}

async function loadRegister(): Promise<Register> {
  const raw = await readFile(REGISTER_PATH, "utf8");
  const parsed = JSON.parse(raw) as Register;
  if (!Array.isArray(parsed.contractions)) {
    throw new Error(`${REGISTER_PATH} must define a "contractions" array`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const register = await loadRegister();
  const registered = new Set(register.contractions.map((entry): string => entry.migration));
  const enforcedFrom = register.enforcedFrom ?? "";

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name): boolean => name.endsWith(".sql"))
    .sort((left, right): number => left.localeCompare(right));

  const violations: string[] = [];
  let enforced = 0;

  for (const file of files) {
    const stem = migrationStem(file);
    // Migrations that predate this check are the existing schema, not a
    // proposed change; holding them to a rule introduced later would only
    // force a register full of retrospective entries nobody verified.
    if (enforcedFrom !== "" && stem.localeCompare(enforcedFrom) <= 0) continue;
    enforced += 1;
    if (registered.has(stem)) continue;

    const sql = stripComments(await readFile(join(MIGRATIONS_DIR, file), "utf8"));
    for (const { label, pattern } of CONTRACTING_PATTERNS) {
      if (pattern.test(sql)) {
        violations.push(`${file}: ${label}`);
      }
    }
  }

  // A register entry for a migration that no longer exists is stale and hides
  // the next real contraction behind a name that will never match again.
  const knownStems = new Set(files.map(migrationStem));
  for (const entry of register.contractions) {
    if (!knownStems.has(entry.migration)) {
      violations.push(`${entry.migration}: registered in schema_contractions.json but no such migration exists`);
    }
  }

  if (violations.length > 0) {
    console.error("Schema compatibility check failed (HA-3B expand/migrate/contract).\n");
    for (const violation of violations) console.error(`  - ${violation}`);
    console.error(
      "\nA contracting migration may only ship once no replica inside the supported\n" +
        "rolling-upgrade window still reads the surface. Expand first, migrate readers\n" +
        "in a later release, and register the contraction in\n" +
        "backend/src/data/schema_contractions.json with the release that expanded it,\n" +
        "the release it is approved for, an owner, and why the window has passed.",
    );
    process.exit(1);
  }

  console.log(
    `Schema compatibility OK: ${String(enforced)} PostgreSQL migration(s) checked, ` +
      `${String(register.contractions.length)} registered contraction(s), ` +
      `HA protocol ${String(register.protocolVersion)}.`,
  );
}

await main();
