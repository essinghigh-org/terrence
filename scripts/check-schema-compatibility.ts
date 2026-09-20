/**
 * Enforce PostgreSQL expand/migrate/contract rules for the supported rolling-upgrade window.
 * SQLite is single-process and is not part of HA compatibility.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HA_PROTOCOL_VERSION } from "../backend/src/lib/ha-protocol";

type Dialect = "sqlite" | "pg" | "both";

type Contraction = Readonly<{
  migration: string;
  dialect: Dialect;
  surface: string;
  expandedIn: string;
  approvedFor: string;
  owner: string;
  justification: string;
}>;

type Register = Readonly<{
  protocolVersion: number;
  enforcedFrom: string;
  contractions: readonly Contraction[];
}>;

type Finding = Readonly<{
  label: string;
  surface: string;
}>;

type ParsedRegister = Readonly<{
  register: Register;
  errors: readonly string[];
}>;

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const MIGRATIONS_DIR = join(REPO_ROOT, "backend", "drizzle", "pg");
const REGISTER_PATH = join(REPO_ROOT, "backend", "src", "data", "schema_contractions.json");
const PACKAGE_PATH = join(REPO_ROOT, "package.json");
const RELEASE_PATTERN = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function stripComments(sqlText: string): string {
  return sqlText.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

function migrationStem(fileName: string): string {
  return fileName.replace(/\.sql$/i, "");
}

function statements(sqlText: string): string[] {
  return stripComments(sqlText)
    .split(";")
    .map((statement): string => statement.trim())
    .filter((statement): boolean => statement !== "");
}

function identifier(match: readonly string[] | null, index = 1): string | null {
  const value = match?.[index];
  return typeof value === "string" && value !== "" ? value : null;
}

function tableFromAlter(statement: string): string | null {
  return identifier(
    /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:(?:\"?[A-Za-z_][A-Za-z0-9_]*\"?\.)?)\"?([A-Za-z_][A-Za-z0-9_]*)\"?/i.exec(
      statement,
    ),
  );
}

function detectStandaloneContractions(statement: string): Finding[] {
  const findings: Finding[] = [];
  const dropTable = identifier(
    /\bDROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:(?:\"?[A-Za-z_][A-Za-z0-9_]*\"?\.)?)\"?([A-Za-z_][A-Za-z0-9_]*)\"?/i.exec(
      statement,
    ),
  );
  if (dropTable !== null) findings.push({ label: "drop table", surface: `table:${dropTable}` });

  const uniqueIndex = identifier(
    /\bCREATE\s+UNIQUE\s+(?:NULLS\s+(?:NOT\s+)?DISTINCT\s+)?INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:(?:\"?[A-Za-z_][A-Za-z0-9_]*\"?\.)?)\"?([A-Za-z_][A-Za-z0-9_]*)\"?/i.exec(
      statement,
    ),
  );
  if (uniqueIndex !== null) findings.push({ label: "add unique index", surface: `index:${uniqueIndex}` });
  return findings;
}

function detectAlteredColumn(statement: string, table: string): Finding[] {
  const column = identifier(/\bALTER\s+COLUMN\s+\"?([A-Za-z_][A-Za-z0-9_]*)\"?/i.exec(statement));
  if (column === null) return [];

  const findings: Finding[] = [];
  if (/\bSET\s+NOT\s+NULL\b/i.test(statement)) {
    findings.push({ label: "add not-null constraint", surface: `${table}.${column}` });
  }
  if (/\bDROP\s+DEFAULT\b/i.test(statement)) {
    findings.push({ label: "drop default", surface: `${table}.${column}` });
  }
  if (/\b(?:SET\s+DATA\s+)?TYPE\b/i.test(statement)) {
    findings.push({ label: "change column type", surface: `${table}.${column}` });
  }
  return findings;
}

function detectNamedConstraint(statement: string, table: string): Finding[] {
  const constraint = identifier(/\bADD\s+CONSTRAINT\s+\"?([A-Za-z_][A-Za-z0-9_]*)\"?/i.exec(statement));
  if (constraint === null) return [];

  const surface = `constraint:${table}.${constraint}`;
  if (/\bUNIQUE\b/i.test(statement)) return [{ label: "add unique constraint", surface }];
  if (/\bFOREIGN\s+KEY\b/i.test(statement)) return [{ label: "add foreign-key constraint", surface }];
  if (/\bCHECK\s*\(/i.test(statement)) return [{ label: "add check constraint", surface }];
  if (/\bPRIMARY\s+KEY\b/i.test(statement)) return [{ label: "add primary-key constraint", surface }];
  return [];
}

function detectUnnamedConstraint(statement: string, table: string): Finding[] {
  if (/\bADD\s+CONSTRAINT\b/i.test(statement)) return [];
  const prefix = `constraint:${table}:unnamed-`;
  if (/\bADD\s+UNIQUE\b/i.test(statement)) return [{ label: "add unique constraint", surface: `${prefix}unique` }];
  if (/\bADD\s+FOREIGN\s+KEY\b/i.test(statement)) {
    return [{ label: "add foreign-key constraint", surface: `${prefix}foreign-key` }];
  }
  if (/\bADD\s+CHECK\s*\(/i.test(statement)) return [{ label: "add check constraint", surface: `${prefix}check` }];
  if (/\bADD\s+PRIMARY\s+KEY\b/i.test(statement)) {
    return [{ label: "add primary-key constraint", surface: `${prefix}primary-key` }];
  }
  return [];
}

function detectAlterTableContractions(statement: string, table: string): Finding[] {
  const findings: Finding[] = [];

  const dropColumn = identifier(/\bDROP\s+COLUMN(?:\s+IF\s+EXISTS)?\s+\"?([A-Za-z_][A-Za-z0-9_]*)\"?/i.exec(statement));
  if (dropColumn !== null) findings.push({ label: "drop column", surface: `${table}.${dropColumn}` });

  const renameColumn = identifier(/\bRENAME\s+COLUMN\s+\"?([A-Za-z_][A-Za-z0-9_]*)\"?\s+TO\b/i.exec(statement));
  if (renameColumn !== null) findings.push({ label: "rename column", surface: `${table}.${renameColumn}` });
  if (renameColumn === null && /\bRENAME\s+TO\b/i.test(statement)) {
    findings.push({ label: "rename table", surface: `table:${table}` });
  }

  const addedColumn = identifier(/\bADD\s+COLUMN\s+\"?([A-Za-z_][A-Za-z0-9_]*)\"?/i.exec(statement));
  if (addedColumn !== null && /\bNOT\s+NULL\b/i.test(statement) && !/\bDEFAULT\b/i.test(statement)) {
    findings.push({ label: "add required column without default", surface: `${table}.${addedColumn}` });
  }

  const droppedConstraint = identifier(
    /\bDROP\s+CONSTRAINT(?:\s+IF\s+EXISTS)?\s+\"?([A-Za-z_][A-Za-z0-9_]*)\"?/i.exec(statement),
  );
  if (droppedConstraint !== null) {
    findings.push({ label: "drop constraint", surface: `constraint:${table}.${droppedConstraint}` });
  }

  findings.push(...detectAlteredColumn(statement, table));
  findings.push(...detectNamedConstraint(statement, table));
  findings.push(...detectUnnamedConstraint(statement, table));
  return findings;
}

function detectContractions(statement: string): Finding[] {
  const findings = detectStandaloneContractions(statement);
  const table = tableFromAlter(statement);
  return table === null ? findings : [...findings, ...detectAlterTableContractions(statement, table)];
}

function parseRelease(value: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareRelease(left: string, right: string): number {
  const a = parseRelease(left);
  const b = parseRelease(right);
  if (a === null || b === null) return 0;
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function parseDialect(value: unknown): Dialect | null {
  return value === "sqlite" || value === "pg" || value === "both" ? value : null;
}

type FieldResult<T> = Readonly<{ value: T | null; errors: readonly string[] }>;

function requiredStringField(
  source: Readonly<Record<string, unknown>>,
  field: keyof Contraction,
  prefix: string,
): FieldResult<string> {
  const value = nonEmptyString(source[field]);
  return value === null ? { value: null, errors: [`${prefix}.${field} is required`] } : { value, errors: [] };
}

function requiredDialectField(source: Readonly<Record<string, unknown>>, prefix: string): FieldResult<Dialect> {
  const value = parseDialect(source["dialect"]);
  return value === null
    ? { value: null, errors: [`${prefix}.dialect must be sqlite, pg, or both`] }
    : { value, errors: [] };
}

function releaseSyntaxErrors(value: string | null, field: "expandedIn" | "approvedFor", prefix: string): string[] {
  if (value === null || RELEASE_PATTERN.test(value)) return [];
  return [`${prefix}.${field} must be a release version`];
}

function releaseWindowErrors(
  expandedIn: string,
  approvedFor: string,
  currentRelease: string,
  prefix: string,
): string[] {
  if (compareRelease(approvedFor, expandedIn) <= 0) {
    return [`${prefix}.approvedFor must be later than expandedIn`];
  }

  const errors: string[] = [];
  const expanded = parseRelease(expandedIn);
  const approved = parseRelease(approvedFor);
  if (expanded !== null && approved !== null && approved[0] === expanded[0] && approved[1] < expanded[1] + 2) {
    errors.push(`${prefix}.approvedFor must be at least two minor releases after expandedIn for N/N-1 skew`);
  }
  if (compareRelease(approvedFor, currentRelease) > 0) {
    errors.push(`${prefix}.approvedFor ${approvedFor} is later than the current release ${currentRelease}`);
  }
  return errors;
}

function releaseFieldErrors(
  expandedIn: string | null,
  approvedFor: string | null,
  currentRelease: string,
  prefix: string,
): string[] {
  const syntaxErrors = [
    ...releaseSyntaxErrors(expandedIn, "expandedIn", prefix),
    ...releaseSyntaxErrors(approvedFor, "approvedFor", prefix),
  ];
  if (expandedIn === null || approvedFor === null || syntaxErrors.length > 0) return syntaxErrors;
  return [...syntaxErrors, ...releaseWindowErrors(expandedIn, approvedFor, currentRelease, prefix)];
}

function parseContraction(
  value: unknown,
  index: number,
  currentRelease: string,
): Readonly<{
  entry: Contraction | null;
  errors: readonly string[];
}> {
  const prefix = `contractions[${String(index)}]`;
  const source = record(value);
  if (source === null) return { entry: null, errors: [`${prefix} must be an object`] };

  const migration = requiredStringField(source, "migration", prefix);
  const dialect = requiredDialectField(source, prefix);
  const surface = requiredStringField(source, "surface", prefix);
  const expandedIn = requiredStringField(source, "expandedIn", prefix);
  const approvedFor = requiredStringField(source, "approvedFor", prefix);
  const owner = requiredStringField(source, "owner", prefix);
  const justification = requiredStringField(source, "justification", prefix);

  const errors = [
    ...migration.errors,
    ...dialect.errors,
    ...surface.errors,
    ...expandedIn.errors,
    ...approvedFor.errors,
    ...owner.errors,
    ...justification.errors,
    ...releaseFieldErrors(expandedIn.value, approvedFor.value, currentRelease, prefix),
  ];
  if (justification.value !== null && justification.value.length < 20) {
    errors.push(`${prefix}.justification must explain why the skew window has passed`);
  }

  if (
    migration.value === null ||
    dialect.value === null ||
    surface.value === null ||
    expandedIn.value === null ||
    approvedFor.value === null ||
    owner.value === null ||
    justification.value === null
  ) {
    return { entry: null, errors };
  }

  return {
    entry: {
      migration: migration.value,
      dialect: dialect.value,
      surface: surface.value,
      expandedIn: expandedIn.value,
      approvedFor: approvedFor.value,
      owner: owner.value,
      justification: justification.value,
    },
    errors,
  };
}

function parseRegister(value: unknown, currentRelease: string): ParsedRegister {
  const source = record(value);
  if (source === null) {
    return {
      register: { protocolVersion: -1, enforcedFrom: "", contractions: [] },
      errors: ["schema_contractions.json must contain an object"],
    };
  }

  const errors: string[] = [];
  const protocolVersion = source["protocolVersion"];
  if (!Number.isSafeInteger(protocolVersion))
    errors.push("schema_contractions.json protocolVersion must be an integer");
  else if (protocolVersion !== HA_PROTOCOL_VERSION) {
    errors.push(
      `schema_contractions.json protocolVersion ${String(protocolVersion)} does not match HA_PROTOCOL_VERSION ${String(HA_PROTOCOL_VERSION)}`,
    );
  }

  const enforcedFromValue = source["enforcedFrom"];
  const enforcedFrom = enforcedFromValue === undefined ? "" : nonEmptyString(enforcedFromValue);
  if (enforcedFromValue !== undefined && enforcedFrom === null) {
    errors.push("schema_contractions.json enforcedFrom must be a non-empty string");
  }

  const rawContractions = source["contractions"];
  if (!Array.isArray(rawContractions)) {
    errors.push('schema_contractions.json must define a "contractions" array');
  }

  const contractions: Contraction[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of (Array.isArray(rawContractions) ? rawContractions : []).entries()) {
    const parsed = parseContraction(raw, index, currentRelease);
    errors.push(...parsed.errors);
    if (parsed.entry === null) continue;
    const key = `${parsed.entry.migration}|${parsed.entry.dialect}|${parsed.entry.surface}`;
    if (seen.has(key))
      errors.push(`contractions[${String(index)}] duplicates ${parsed.entry.migration} ${parsed.entry.surface}`);
    else seen.add(key);
    contractions.push(parsed.entry);
  }

  return {
    register: {
      protocolVersion: Number.isSafeInteger(protocolVersion) ? Number(protocolVersion) : -1,
      enforcedFrom: enforcedFrom ?? "",
      contractions,
    },
    errors,
  };
}

async function loadCurrentRelease(): Promise<string> {
  const source = record(JSON.parse(await readFile(PACKAGE_PATH, "utf8")) as unknown);
  const version = nonEmptyString(source?.["version"]);
  if (version === null || !RELEASE_PATTERN.test(version)) {
    throw new Error(`${PACKAGE_PATH} must contain a semantic release version`);
  }
  return version;
}

async function loadRegister(currentRelease: string): Promise<ParsedRegister> {
  return parseRegister(JSON.parse(await readFile(REGISTER_PATH, "utf8")) as unknown, currentRelease);
}

type StringMembership = Readonly<{ has: (value: string) => boolean }>;

async function scanMigrations(
  files: readonly string[],
  register: Register,
): Promise<Readonly<{ enforced: number; observed: ReadonlySet<string>; violations: readonly string[] }>> {
  const approvals = new Set(
    register.contractions
      .filter((entry): boolean => entry.dialect === "pg" || entry.dialect === "both")
      .map((entry): string => `${entry.migration}|${entry.surface}`),
  );
  const observed = new Set<string>();
  const violations: string[] = [];
  let enforced = 0;

  for (const file of files) {
    const stem = migrationStem(file);
    if (register.enforcedFrom !== "" && stem.localeCompare(register.enforcedFrom) <= 0) continue;
    enforced += 1;
    for (const statement of statements(await readFile(join(MIGRATIONS_DIR, file), "utf8"))) {
      for (const finding of detectContractions(statement)) {
        const key = `${stem}|${finding.surface}`;
        observed.add(key);
        if (!approvals.has(key)) violations.push(`${file}: ${finding.label} (${finding.surface})`);
      }
    }
  }

  return { enforced, observed, violations };
}

function validateRegisteredSurfaces(
  register: Register,
  knownStems: StringMembership,
  observed: StringMembership,
): string[] {
  const violations: string[] = [];
  for (const entry of register.contractions) {
    if (entry.dialect !== "pg" && entry.dialect !== "both") continue;
    if (!knownStems.has(entry.migration)) {
      violations.push(`${entry.migration}: registered PostgreSQL contraction refers to a missing migration`);
      continue;
    }
    const insideEnforcedWindow =
      register.enforcedFrom === "" || entry.migration.localeCompare(register.enforcedFrom) > 0;
    if (insideEnforcedWindow && !observed.has(`${entry.migration}|${entry.surface}`)) {
      violations.push(`${entry.migration}: approval for ${entry.surface} does not match a detected contraction`);
    }
  }
  return violations;
}

async function main(): Promise<void> {
  const currentRelease = await loadCurrentRelease();
  const parsed = await loadRegister(currentRelease);
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name): boolean => name.endsWith(".sql"))
    .sort((left, right): number => left.localeCompare(right));
  const scan = await scanMigrations(files, parsed.register);
  const violations = [
    ...parsed.errors,
    ...scan.violations,
    ...validateRegisteredSurfaces(parsed.register, new Set(files.map(migrationStem)), scan.observed),
  ];

  if (violations.length > 0) {
    console.error("Schema compatibility check failed.\n");
    for (const violation of violations) console.error(`  - ${violation}`);
    console.error(
      "\nPostgreSQL migrations used during a rolling upgrade must remain compatible with the previous release. " +
        "Expand first; contract only after the old surface is outside the supported window and register that exact surface.",
    );
    process.exit(1);
  }

  console.log(
    `Schema compatibility OK: ${String(scan.enforced)} PostgreSQL migration(s) checked, ` +
      `${String(parsed.register.contractions.length)} registered contraction(s), HA protocol ${String(HA_PROTOCOL_VERSION)}.`,
  );
}

await main();
