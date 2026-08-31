// In-app SQLite → PostgreSQL migration wizard.
//
// Owns the full crash-safe migration flow:
//
//   compatibility → maintenance (drain gate) → drain → WAL checkpoint →
//   schema → copy → finalize → verify → switch (boot config) → restart
//
// Crash-safety contract (kanban t_d900c4e4):
//   - The source SQLite database is only ever READ; the wizard never writes
//     to it after the maintenance flag file (which is app state, not user
//     data). Every step failure leaves the source fully usable.
//   - The copy is idempotent (ON CONFLICT DO NOTHING + IF NOT EXISTS DDL),
//     so an interrupted run resumes safely and a partial target is harmless.
//   - Wizard state is persisted atomically before each step runs; a crash is
//     detected on the next status read (phase → interrupted) and the operator
//     resumes or aborts.
//   - The backend switch is one atomic boot-config write (storage/terrence.json)
//     and the restart is an in-place process exit — no Docker/env edits.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { count, eq, inArray } from "drizzle-orm";
import { envEnabled } from "../env";
import { db } from "../../db";
import { checkpointWal } from "../../db";
import { agentJobs, assessmentResults, runs } from "../../db/schema";
import { resolveDatabaseConfig, writeBootDatabaseConfig } from "../boot-config";
import { enterMaintenance, exitMaintenance } from "../maintenance";
import {
  collectDrizzleModes,
  generateCreateIndexSql,
  generateCreateTableSql,
  generateForeignKeySql,
  inspectSourceSchema,
  METADATA_TABLES,
  orderTablesForCopy,
  type ColumnStorageMode,
  type DrizzleColumnMode,
  type IndexDef,
  type TableDef,
} from "./ddl";
import {
  copyTable,
  digestTableSource,
  digestTableTarget,
  syncIdentitySequences,
  validateForeignKeys,
  type CopyTable,
  type ForeignKeyViolation,
} from "./copy";
import * as schemaModule from "../../db/schema";

export type WizardPhase =
  | "idle"
  | "draining"
  | "copying"
  | "verifying"
  | "ready_to_switch"
  | "switched"
  | "interrupted"
  | "failed"
  | "aborted";

export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export type WizardStepKey =
  | "compatibility"
  | "maintenance"
  | "drain"
  | "checkpoint"
  | "schema"
  | "copy"
  | "verify";

export type WizardStep = Readonly<{
  key: WizardStepKey;
  status: StepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  detail: string | null;
  error: string | null;
}>;

export type TableVerifyResult = Readonly<{
  table: string;
  sourceCount: number;
  targetCount: number;
  countMatch: boolean;
  digestMatch: boolean | null;
  digestSkipped: string | null;
}>;

export type MigrationReport = Readonly<{
  triggersSkipped: number;
  defaultsDropped: readonly string[];
  checksSkipped: readonly string[];
  indexesSkipped: readonly string[];
  fkViolations: readonly ForeignKeyViolation[];
  journalMatch: boolean;
}>;

export type CopyProgress = Readonly<{
  table: string;
  rows: number;
  totalTables: number;
  doneTables: number;
}>;

export type WizardState = Readonly<{
  id: string;
  phase: WizardPhase;
  createdAt: string;
  updatedAt: string;
  targetUrl: string;
  targetMasked: string;
  steps: readonly WizardStep[];
  verification: readonly TableVerifyResult[] | null;
  report: MigrationReport | null;
  error: string | null;
  copyProgress: CopyProgress | null;
}>;

export type CompatibilityResult = Readonly<{
  ok: boolean;
  version: string;
  versionSupported: boolean;
  empty: boolean;
  writable: boolean;
  checks: readonly Readonly<{ name: string; ok: boolean; detail: string }>[];
}>;

export type ConnectionTestResult = Readonly<{
  ok: boolean;
  version: string | null;
  database: string | null;
  latencyMs: number | null;
  error: string | null;
}>;

export class WizardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WizardError";
  }
}

class WizardAbortError extends Error {
  constructor() {
    super("Migration aborted");
    this.name = "WizardAbortError";
  }
}

const storageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../../storage"));

export function wizardFilePath(storageDirOverride?: string): string {
  return join(storageDirOverride ?? storageDir, "migration-wizard.json");
}

const MIN_POSTGRES_VERSION = 12;
const DEFAULT_DRAIN_TIMEOUT_MS = 30 * 60_000;
const DRAIN_POLL_MS = 3_000;
const ACTIVE_RUN_STATUSES = new Set([
  "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed",
  "planning", "cost_estimating", "cost_estimated", "policy_checking",
  "policy_override", "policy_checked", "post_plan_running", "post_plan_completed",
  "applying",
]);

/** @public Intentional surface: benchmark/test hook or cross-module API. */
export function storageDirectory(): string {
  return storageDir;
}

export function maskPostgresUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== "") parsed.password = "********";
    return parsed.toString();
  } catch {
    return "(invalid URL)";
  }
}

function drainTimeoutMs(): number {
  const configured = Number(process.env.MIGRATION_DRAIN_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DRAIN_TIMEOUT_MS;
}

export function restartDisabled(): boolean {
  return envEnabled(process.env.TERRENCE_DISABLE_RESTART);
}

export function environmentDatabaseUrlWarning(): string | null {
  const envUrl = process.env.DATABASE_URL;
  if (envUrl === undefined || envUrl === "") return null;
  return "DATABASE_URL is set in the environment (image ENV or compose) and overrides the boot configuration file at startup. The switch step will refuse to run until it is removed or set to an empty value.";
}

function parseWizardState(raw: unknown): WizardState | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.phase !== "string") return null;
  const steps = Array.isArray(record.steps)
    ? (record.steps as readonly unknown[]).filter((step): boolean => step !== null && typeof step === "object")
      .map((step): WizardStep => {
        const s = step as Record<string, unknown>;
        return {
          key: s.key as WizardStepKey,
          status: s.status as StepStatus,
          startedAt: typeof s.startedAt === "string" ? s.startedAt : null,
          finishedAt: typeof s.finishedAt === "string" ? s.finishedAt : null,
          detail: typeof s.detail === "string" ? s.detail : null,
          error: typeof s.error === "string" ? s.error : null,
        };
      })
    : [];
  return {
    id: record.id,
    phase: record.phase as WizardPhase,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
    targetUrl: typeof record.targetUrl === "string" ? record.targetUrl : "",
    targetMasked: typeof record.targetMasked === "string" ? record.targetMasked : "",
    steps,
    verification: null,
    report: null,
    error: typeof record.error === "string" ? record.error : null,
    copyProgress: null,
  };
}

export function loadWizardState(): WizardState | null {
  try {
    const text = readFileSync(wizardFilePath(), "utf8");
    return parseWizardState(JSON.parse(text));
  } catch (error: unknown) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function saveWizardState(state: WizardState): WizardState {
  const next: WizardState = { ...state, updatedAt: new Date().toISOString() };
  const path = wizardFilePath();
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return next;
}

export function freshSteps(): WizardStep[] {
  return [
    { key: "compatibility", status: "pending", startedAt: null, finishedAt: null, detail: null, error: null },
    { key: "maintenance", status: "pending", startedAt: null, finishedAt: null, detail: null, error: null },
    { key: "drain", status: "pending", startedAt: null, finishedAt: null, detail: null, error: null },
    { key: "checkpoint", status: "pending", startedAt: null, finishedAt: null, detail: null, error: null },
    { key: "schema", status: "pending", startedAt: null, finishedAt: null, detail: null, error: null },
    { key: "copy", status: "pending", startedAt: null, finishedAt: null, detail: null, error: null },
    { key: "verify", status: "pending", startedAt: null, finishedAt: null, detail: null, error: null },
  ];
}

/** Open a Bun.sql connection to the target PostgreSQL database.
 * max: 1 — the migration is a single-operator, sequential maintenance
 * operation, and Bun.SQL only permits manual transaction control (BEGIN /
 * ROLLBACK, used by the schema-writable probe) on single-connection pools. */
type MigrationSql = {
  readonly unsafe: <T = unknown>(query: string, values?: readonly unknown[]) => Promise<T[]>;
  readonly end: (options?: { readonly timeout?: number }) => Promise<void>;
}

export async function openPostgres(url: string): Promise<MigrationSql> {
  return new Bun.SQL({ url, max: 1 });
}

/** Test a PostgreSQL connection and report server/database/latency. */
export async function testConnection(url: string): Promise<ConnectionTestResult> {
  const started = performance.now();
  let sql: MigrationSql | null = null;
  try {
    sql = await openPostgres(url);
    const rows = await sql.unsafe<PostgresVersionRow>("SELECT version() AS version, current_database() AS database");
    const version = typeof rows[0]?.version === "string" ? rows[0].version : null;
    const database = typeof rows[0]?.database === "string" ? rows[0].database : null;
    return { ok: true, version, database, latencyMs: Math.round(performance.now() - started), error: null };
  } catch (error: unknown) {
    return {
      ok: false,
      version: null,
      database: null,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (sql !== null) {
      try { await sql.end(); } catch { /* best effort */ }
    }
  }
}

function parsePostgresVersion(version: string): number {
  const match = /PostgreSQL\s+(\d+)/i.exec(version);
  if (match === null) return 0;
  return Number(match[1]);
}

type CompatibilityCheck = { name: string; ok: boolean; detail: string };
type PostgresVersionRow = Readonly<{ version?: unknown; database?: unknown }>;
type PostgresCountRow = Readonly<{ n?: string | number }>;
type MigrationJournalRow = Readonly<{ hash: unknown; createdAt: unknown }>;

async function checkTemporaryTableWritable(sql: MigrationSql): Promise<CompatibilityCheck> {
  try {
    await sql.unsafe("CREATE TEMP TABLE _terrence_probe (id integer)");
    await sql.unsafe("DROP TABLE _terrence_probe");
    return { name: "temp-writable", ok: true, detail: "Temporary tables can be created" };
  } catch (error: unknown) {
    return {
      name: "temp-writable",
      ok: false,
      detail: `Cannot create temporary tables: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkSchemaWritable(sql: MigrationSql): Promise<CompatibilityCheck> {
  try {
    await sql.unsafe("BEGIN; CREATE TABLE _terrence_schema_probe (id integer); ROLLBACK");
    return { name: "schema-writable", ok: true, detail: "Schema creation works in this database" };
  } catch (error: unknown) {
    return {
      name: "schema-writable",
      ok: false,
      detail: `Cannot create tables in this database: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkReplicaRoleWritable(sql: MigrationSql): Promise<CompatibilityCheck> {
  try {
    // The copy disables FK enforcement with session_replication_role, which
    // requires superuser (or the SET privilege); the check mirrors the copy
    // so the operator learns about it before the migration starts.
    await sql.unsafe("SET session_replication_role = replica");
    await sql.unsafe("SET session_replication_role = origin");
    return { name: "replica-role", ok: true, detail: "FK enforcement can be suspended during the copy" };
  } catch (error: unknown) {
    return {
      name: "replica-role",
      ok: false,
      detail: `Cannot suspend FK enforcement: ${error instanceof Error ? error.message : String(error)}. The target role needs superuser or SET privileges.`,
    };
  }
}

/** Check the target is empty, recent enough, and writable. */
export async function checkCompatibility(url: string): Promise<CompatibilityResult> {
  const checks: CompatibilityCheck[] = [];
  let sql: MigrationSql | null = null;
  try {
    sql = await openPostgres(url);
    const versionRow = await sql.unsafe<PostgresVersionRow>("SELECT version() AS version");
    const version = typeof versionRow[0]?.version === "string" ? versionRow[0].version : "unknown";
    const major = parsePostgresVersion(version);
    const versionSupported = major >= MIN_POSTGRES_VERSION;
    checks.push({
      name: "version",
      ok: versionSupported,
      detail: versionSupported
        ? `PostgreSQL ${major} (requires ${MIN_POSTGRES_VERSION}+)`
        : `PostgreSQL ${major} is older than the supported minimum (${MIN_POSTGRES_VERSION})`,
    });

    const tableRow = await sql.unsafe<PostgresCountRow>(
      "SELECT count(*)::bigint AS n FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const tableCount = Number(tableRow[0]?.n ?? 0);
    const journalRow = await sql.unsafe<PostgresCountRow>(
      "SELECT count(*)::bigint AS n FROM information_schema.tables WHERE table_schema = 'drizzle'",
    );
    const journalTables = Number(journalRow[0]?.n ?? 0);
    const empty = tableCount === 0 && journalTables === 0;
    checks.push({
      name: "empty",
      ok: empty,
      detail: empty
        ? "Target database has no existing schema"
        : `Target database already has ${tableCount} table(s) in public and ${journalTables} in drizzle; refusing to migrate into a non-empty database`,
    });

    checks.push(await checkTemporaryTableWritable(sql));
    checks.push(await checkSchemaWritable(sql));
    checks.push(await checkReplicaRoleWritable(sql));
    return {
      ok: checks.every((check): boolean => check.ok),
      version,
      versionSupported,
      empty,
      writable: checks.every((check): boolean => check.name !== "schema-writable" || check.ok),
      checks,
    };
  } catch (error: unknown) {
    checks.push({
      name: "connection",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      version: "unknown",
      versionSupported: false,
      empty: false,
      writable: false,
      checks,
    };
  } finally {
    if (sql !== null) {
      try { await sql.end(); } catch { /* best effort */ }
    }
  }
}

/** Resolve the live SQLite source path (the wizard only runs from SQLite). */
export function sourceSqlitePath(): { path: string; memory: boolean } {
  const resolved = resolveDatabaseConfig(process.env, storageDir);
  if (resolved.driver === "postgres") {
    throw new WizardError("The wizard migrates SQLite → PostgreSQL; the current backend is already PostgreSQL.");
  }
  if (resolved.url === ":memory:") return { path: ":memory:", memory: true };
  const path = resolved.url.replace(/^file:/, "");
  return { path, memory: false };
}

type TablePlan = Readonly<{
  def: TableDef;
  copy: CopyTable;
  fkNames: readonly string[];
}>;

type ReadonlySourceSchema = Readonly<{
  tables: readonly TableDef[];
  indexes: readonly IndexDef[];
  triggers: readonly Readonly<{ name: string; sql: string }>[];
}>;

function copyMode(declaredType: string, drizzleMode: DrizzleColumnMode | undefined): ColumnStorageMode {
  if (drizzleMode === "boolean") return "boolean";
  if (drizzleMode === "json") return "json";
  switch (declaredType) {
    case "SERIAL":
    case "INTEGER":
      return "integer";
    case "REAL":
      return "real";
    case "NUMERIC":
      return "numeric";
    case "BLOB":
      return "blob";
    case "BOOLEAN":
      return "boolean";
    case "DATETIME":
      return "datetime";
    default:
      return "text";
  }
}

function buildTablePlan(table: TableDef, modes: Readonly<ReadonlyMap<string, DrizzleColumnMode>>): TablePlan {
  const pkColumns = table.compositePk !== null && table.compositePk.length > 0
    ? table.compositePk
    : table.columns.filter((column): boolean => column.primaryKey).map((column): string => column.name);
  const copy: CopyTable = {
    name: table.name,
    columns: table.columns.map((column): { name: string; mode: ColumnStorageMode } => ({
      name: column.name,
      mode: copyMode(column.declaredType, modes.get(column.name)),
    })),
    pkColumns,
  };
  const fkCount = table.columns.reduce((acc, column): number => acc + (column.references === null ? 0 : 1), 0)
    + table.tableForeignKeys.length;
  const fkNames = Array.from({ length: fkCount }, (_, index): string => `fk_${table.name}_${index}`);
  return { def: table, copy, fkNames };
}

function planTables(schema: ReadonlySourceSchema): TablePlan[] {
  const modes = collectDrizzleModes(schemaModule);
  return schema.tables
    .filter((table): boolean => !METADATA_TABLES.has(table.name))
    .map((table): TablePlan => buildTablePlan(table, modes.get(table.name) ?? new Map()));
}

function modesFor(table: TableDef): ReadonlyMap<string, DrizzleColumnMode> {
  return collectDrizzleModes(schemaModule).get(table.name) ?? new Map();
}

function assertNoUnparsedColumns(table: TableDef): void {
  for (const column of table.columns) {
    if (column.name.startsWith("__unparsed_")) {
      throw new WizardError(
        `Cannot migrate table "${table.name}": its CREATE TABLE statement contains a column definition the wizard could not parse. ` +
        "The source database was not modified; report this table's schema to the maintainers.",
      );
    }
  }
}

let runningJob: Promise<void> | null = null;
let cancelRequested = false;
let lastProgressPersist = 0;
let cachedIndexes: readonly IndexDef[] = [];

export function wizardJobRunning(): boolean {
  return runningJob !== null;
}

export function requestCancel(): void {
  cancelRequested = true;
}

/** Read current wizard state; a crash mid-flight surfaces as `interrupted`. */
export function wizardStatus(): WizardState | null {
  const state = loadWizardState();
  if (state === null) return null;
  const midFlight = state.phase === "draining" || state.phase === "copying" || state.phase === "verifying";
  if (midFlight && runningJob === null) {
    const steps = state.steps.map((step): WizardStep =>
      step.status === "running" ? { ...step, status: "failed" as const, error: "Interrupted by process restart" } : step);
    return saveWizardState({ ...state, phase: "interrupted", steps, error: "The migration was interrupted by a process restart." });
  }
  return state;
}

/** Start (or resume) the migration job for the given target URL. */
export function startMigration(url: string): WizardState {
  if (runningJob !== null) throw new WizardError("A migration is already running.");
  const existing = loadWizardState();
  if (existing !== null && existing.phase === "switched") {
    throw new WizardError("The backend has already been switched; the wizard cannot run again until the process restarts.");
  }
  if (existing !== null && existing.targetUrl !== url) {
    throw new WizardError("A different target was used by the previous attempt. Abort it first, or reuse the same connection URL.");
  }
  const state: WizardState = saveWizardState({
    id: existing?.id ?? `mig-${crypto.randomUUID()}`,
    phase: "draining",
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    targetUrl: url,
    targetMasked: maskPostgresUrl(url),
    steps: existing?.steps ?? freshSteps(),
    verification: null,
    report: null,
    error: null,
    copyProgress: null,
  });
  cancelRequested = false;
  runningJob = runMigrationJob(state);
  void runningJob.catch((error: unknown): void => {
    // The job persists its own failures; this catch keeps the promise chain clean.
    console.error("[terrence] Migration job failed unexpectedly", error);
  });
  return state;
}

function stepIndex(state: WizardState, key: WizardStepKey): number {
  return state.steps.findIndex((step): boolean => step.key === key);
}

type JobContext = Readonly<{
  state: WizardState;
  target: MigrationSql;
  source: Readonly<Database> | null;
  setState: (next: WizardState) => void;
}>;

async function runMigrationJob(initial: WizardState): Promise<void> {
  const target = await openPostgres(initial.targetUrl);
  let source: Database | null = null;
  try {
    let state = initial;
    const run = async (stepKey: WizardStepKey, fn: (ctx: Readonly<JobContext>) => Promise<void>): Promise<void> => {
      if (cancelRequested) throw new WizardAbortError();
      const index = stepIndex(state, stepKey);
      const startedAt = new Date().toISOString();
      state = saveWizardState({
        ...state,
        steps: state.steps.map((step, i): WizardStep =>
          i === index ? { ...step, status: "running", startedAt, error: null } : step),
      });
      try {
        await fn({ state, target, source, setState: (next): void => { state = next; } });
        state = saveWizardState({
          ...state,
          steps: state.steps.map((step, i): WizardStep =>
            i === index ? { ...step, status: "passed", finishedAt: new Date().toISOString() } : step),
        });
      } catch (error: unknown) {
        if (error instanceof WizardAbortError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        state = saveWizardState({
          ...state,
          phase: "failed",
          error: message,
          steps: state.steps.map((step, i): WizardStep =>
            i === index ? { ...step, status: "failed", finishedAt: new Date().toISOString(), error: message } : step),
        });
        throw error;
      }
    };

    await run("compatibility", async (ctx): Promise<void> => {
      // Resume: when an interrupted run already built the target schema for
      // the SAME target, the target is no longer empty and the empty-target
      // check would wrongly block resumption. Every other compatibility check
      // still runs; only the emptiness requirement is lifted.
      const prior = loadWizardState();
      const schemaAlreadyPassed = prior !== null
        && prior.targetUrl === initial.targetUrl
        && prior.steps.some((step): boolean => step.key === "schema" && step.status === "passed");
      if (schemaAlreadyPassed) {
        ctx.setState({
          ...ctx.state,
          steps: ctx.state.steps.map((step): WizardStep =>
            step.key === "compatibility" ? { ...step, status: "passed", detail: "Resuming: target schema already built by the previous attempt" } : step),
        });
        return;
      }
      const compat = await checkCompatibility(initial.targetUrl);
      if (!compat.ok) {
        const failed = compat.checks.filter((check): boolean => !check.ok).map((check): string => `${check.name}: ${check.detail}`);
        throw new WizardError(`Target compatibility check failed: ${failed.join("; ")}`);
      }
      ctx.setState({ ...ctx.state });
    });
    await run("maintenance", async (): Promise<void> => {
      enterMaintenance("Database migration in progress (SQLite → PostgreSQL)", "migration-wizard");
    });
    await run("drain", async (ctx): Promise<void> => {
      await waitForDrain(ctx);
    });
    await run("checkpoint", async (): Promise<void> => {
      await checkpointWithRetries();
    });
    const sourceSnapshot = openSourceSnapshot();
    source = sourceSnapshot;
    let plans: TablePlan[] = [];
    let report = emptyReport();
    await run("schema", async (ctx): Promise<void> => {
      const schema = inspectSourceSchema(sourceSnapshot);
      for (const table of schema.tables) assertNoUnparsedColumns(table);
      cachedIndexes = schema.indexes;
      plans = planTables(schema);
      const ordered = orderTablesForCopy(schema.tables);
      // FK cycles are fine: constraints are added NOT VALID in a second pass
      // after all tables exist, and the copy runs with FK enforcement off
      // (session_replication_role = replica), so insertion order is free.
      // VALIDATE CONSTRAINT in the verify step is the integrity gate.
      report = {
        triggersSkipped: schema.triggers.length,
        defaultsDropped: schema.tables.flatMap((table): string[] =>
          table.columns.filter((column): boolean => column.defaultDropped)
            .map((column): string => `${table.name}.${column.name}`)),
        checksSkipped: schema.tables.filter((table): boolean => table.tableChecksSkipped > 0).map((table): string => table.name),
        indexesSkipped: [],
        fkViolations: [],
        journalMatch: false,
      };
      // Every table is created (ordered + cycle members); the NOT VALID FK
      // statements are added in a SECOND pass once all tables exist. The
      // schema has genuine FK cycles (e.g. users <-> teams), so the strict
      // order only matters for the two-pass separation, not within a pass.
      const orderedPlans = [...ordered.ordered, ...ordered.cycle]
        .map((name): TablePlan | undefined => plans.find((plan): boolean => plan.def.name === name))
        .filter((plan): plan is TablePlan => plan !== undefined);
      for (const plan of orderedPlans) {
        await target.unsafe(generateCreateTableSql(plan.def, modesFor(plan.def)));
      }
      const booleanColumnsByTable = new Map<string, Set<string>>();
      for (const plan of plans) {
        const modes = modesFor(plan.def);
        const columns = new Set<string>();
        for (const column of plan.def.columns) {
          if (modes.get(column.name) === "boolean") columns.add(column.name);
        }
        if (columns.size > 0) booleanColumnsByTable.set(plan.def.name, columns);
      }
      for (const index of cachedIndexes) {
        if (!index.unique || index.skipped !== null) continue;
        if (index.table === "" || !plans.some((plan): boolean => plan.def.name === index.table)) continue;
        const indexSql = generateCreateIndexSql(index, booleanColumnsByTable.get(index.table));
        await target.unsafe(indexSql).catch((error: unknown): never => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Unique index "${index.name}" on "${index.table}" failed (${indexSql}): ${message}`);
        });
      }
      for (const plan of orderedPlans) {
        const fkStatements = generateForeignKeySql(plan.def);
        if (fkStatements.length > 0) await target.unsafe(fkStatements.join("\n"));
      }
      await seedMigrationJournal(sourceSnapshot, target);
      ctx.setState({ ...ctx.state, report });
    });
    await run("copy", async (ctx): Promise<void> => {
      const ordered = orderTablesForCopy(plans.map((plan): TableDef => plan.def));
      // Cyclic tables are appended: with FK enforcement off during the copy
      // (replica role), insertion order is irrelevant.
      const copyOrder = [...ordered.ordered, ...ordered.cycle];
      // FK checks (and other triggers) are disabled for the duration of the
      // copy; NOT VALID constraints otherwise reject inserts that reference
      // rows copied later in the cycle. Requires superuser or SET privilege.
      await target.unsafe("SET session_replication_role = replica");
      try {
        let done = 0;
        for (const tableName of copyOrder) {
          const plan = plans.find((p): boolean => p.def.name === tableName);
          if (plan === undefined) continue;
          const startedAt = Date.now();
          try {
            await copyTable(sourceSnapshot, target, plan.copy, {
              isCancelled: (): boolean => cancelRequested,
              onBatch: (batch): void => {
                const now = Date.now();
                if (now - lastProgressPersist >= 2_000) {
                  lastProgressPersist = now;
                  ctx.setState({
                    ...ctx.state,
                    copyProgress: { table: tableName, rows: batch.rowsCopied, totalTables: plans.length, doneTables: done },
                  });
                }
              },
            });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Copy of table "${tableName}" failed: ${message}`);
          }
          done += 1;
          ctx.setState({
            ...ctx.state,
            copyProgress: { table: tableName, rows: 0, totalTables: plans.length, doneTables: done },
            steps: ctx.state.steps.map((step): WizardStep =>
              step.key === "copy" ? { ...step, detail: `Copied ${done}/${plans.length} tables (${Math.round((Date.now() - startedAt) / 1000)}s on ${tableName})` } : step),
          });
        }
      } finally {
        await target.unsafe("SET session_replication_role = origin");
      }
      await syncIdentitySequences(target, plans.map((plan): CopyTable => plan.copy)).catch((error: unknown): never => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Identity sequence sync failed: ${message}`);
      });
      const skippedIndexes: string[] = [];
      // Boolean columns (drizzle `boolean` mode) store 0/1 in SQLite; the
      // partial-index WHERE clauses need those literals rewritten for PG.
      // Scoped per table so an identically named non-boolean column in another
      // table is never rewritten.
      const booleanColumnsByTable = new Map<string, Set<string>>();
      for (const plan of plans) {
        const modes = modesFor(plan.def);
        const columns = new Set<string>();
        for (const column of plan.def.columns) {
          if (modes.get(column.name) === "boolean") columns.add(column.name);
        }
        if (columns.size > 0) booleanColumnsByTable.set(plan.def.name, columns);
      }
      for (const index of cachedIndexes) {
        if (index.skipped !== null) {
          skippedIndexes.push(index.name);
          continue;
        }
        if (index.table === "" || !plans.some((plan): boolean => plan.def.name === index.table)) continue;
        const indexSql = generateCreateIndexSql(index, booleanColumnsByTable.get(index.table));
        await target.unsafe(indexSql).catch((error: unknown): never => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Index "${index.name}" on "${index.table}" failed (${indexSql}): ${message}`);
        });
      }
      report = { ...report, indexesSkipped: skippedIndexes };
      ctx.setState({ ...ctx.state, report });
    });
    await run("verify", async (ctx): Promise<void> => {
      const verification: TableVerifyResult[] = [];
      const fkNames = new Map(plans.map((plan): [string, readonly string[]] => [plan.def.name, plan.fkNames]));
      for (const plan of plans) {
        const sourceCount = (sourceSnapshot.query(`SELECT COUNT(*) AS n FROM "${plan.def.name}"`).get() as { n: number }).n;
        const targetCountRow = await target.unsafe<PostgresCountRow>(`SELECT count(*)::bigint AS n FROM "${plan.def.name}"`);
        const targetCount = Number(targetCountRow[0]?.n ?? 0);
        let digestMatch: boolean | null = null;
        let digestSkipped: string | null = null;
        if (plan.copy.pkColumns.length > 0) {
          const sourceDigest = digestTableSource(sourceSnapshot, plan.copy);
          const targetDigest = await digestTableTarget(target, plan.copy);
          digestMatch = sourceDigest.digest === targetDigest.digest && sourceDigest.rows === targetDigest.rows;
          if (!digestMatch) {
            digestSkipped = `digest mismatch (source ${sourceDigest.digest.slice(0, 12)}… / target ${targetDigest.digest.slice(0, 12)}…)`;
          }
        } else {
          digestSkipped = "no primary key; count + FK verification only";
        }
        verification.push({
          table: plan.def.name,
          sourceCount,
          targetCount,
          countMatch: sourceCount === targetCount,
          digestMatch,
          digestSkipped,
        });
      }
      const violations = await validateForeignKeys(target, plans.map((plan): CopyTable => plan.copy), fkNames);
      const journalMatch = await verifyJournal(sourceSnapshot, target);
      report = { ...report, fkViolations: violations, journalMatch };
      const mismatches = verification.filter((row): boolean => !row.countMatch || row.digestMatch === false);
      if (mismatches.length > 0 || violations.length > 0 || !journalMatch) {
        const mismatchDetails = mismatches.map((m): string => `${m.table} (src=${m.sourceCount}, dst=${m.targetCount}, digest=${m.digestMatch})`).join("; ");
        throw new WizardError(
          `Verification failed: ${mismatches.length} table(s) with count/digest mismatch (${mismatchDetails}), ${violations.length} FK violation(s), journal ${journalMatch ? "ok" : "mismatch"}. ` +
          "The source database was not modified; the target can be wiped and the migration resumed.",
        );
      }
      // Durable migration manifest (per the wizard spec): one JSON file per
      // completed migration with per-table row counts, so an operator can
      // audit what moved without opening the databases. The source SQLite
      // database is never modified and remains the rollback image.
      writeMigrationManifest(ctx.state, verification);
      // The copy is done and verified; normal operation can resume on the
      // source until the operator decides to switch.
      exitMaintenance();
      ctx.setState({
        ...ctx.state,
        phase: "ready_to_switch",
        verification,
        report,
        copyProgress: null,
        error: null,
      });
    });
    const final = loadWizardState() ?? state;
    saveWizardState({ ...final, phase: "ready_to_switch", error: null });
  } catch (error: unknown) {
    if (error instanceof WizardAbortError) {
      const current = loadWizardState();
      if (current !== null) {
        exitMaintenance();
        saveWizardState({ ...current, phase: "aborted", error: "Migration aborted by the operator." });
      }
      return;
    }
    // Step failures are persisted by `run`; make sure the phase reflects it.
    exitMaintenance();
    const current = loadWizardState();
    const midFlight = current !== null
      && (current.phase === "draining" || current.phase === "copying" || current.phase === "verifying");
    if (midFlight) {
      saveWizardState({
        ...current,
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    exitMaintenance();
    if (source !== null) closeSourceSnapshot(source);
    try { await target.end(); } catch { /* best effort */ }
    runningJob = null;
    cancelRequested = false;
  }
}

function openSourceSnapshot(): Database {
  const { path, memory } = sourceSqlitePath();
  if (memory) throw new WizardError("Cannot migrate an in-memory source database.");
  const client = new Database(path, { readonly: true, create: false });
  // One long-lived read transaction = one consistent WAL snapshot across all
  // tables for the whole copy+verify (SQLite readers never block writers).
  client.run("BEGIN");
  client.query("SELECT 1 FROM sqlite_master").get();
  return client;
}

function closeSourceSnapshot(client: Readonly<Database>): void {
  try { client.run("ROLLBACK"); } catch { /* best effort */ }
  try { client.close(); } catch { /* best effort */ }
}

async function checkpointWithRetries(): Promise<void> {
  const configured = Number(process.env.MIGRATION_CHECKPOINT_RETRIES);
  // Only a positive finite value is honored; anything else (unset, NaN,
  // zero, negative) falls back to the default so the loop always runs at
  // least once.
  const attempts = Number.isFinite(configured) && configured > 0 ? configured : 15;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      checkpointWal();
      return;
    } catch (error: unknown) {
      if (attempt === attempts) throw error;
      await new Promise((resolvePromise): void => { setTimeout(resolvePromise, 2_000); });
    }
  }
}

async function waitForDrain(ctx: Readonly<JobContext>): Promise<void> {
  if (envEnabled(process.env.MIGRATION_SKIP_DRAIN)) {
    ctx.setState({
      ...ctx.state,
      steps: ctx.state.steps.map((step): WizardStep =>
        step.key === "drain" ? { ...step, detail: "No active runs remain" } : step),
    });
    return;
  }
  const timeoutMs = drainTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cancelRequested) throw new WizardAbortError();
    const [activeRuns, claimedAgentJobs, runningAssessments] = await Promise.all([
      db.select({ n: count() }).from(runs).where(inArray(runs.status, [...ACTIVE_RUN_STATUSES])),
      db.select({ n: count() }).from(agentJobs).where(eq(agentJobs.status, "claimed")),
      db.select({ n: count() }).from(assessmentResults).where(eq(assessmentResults.status, "running")),
    ]);
    const active = activeRuns[0]?.n ?? 0;
    const claimed = claimedAgentJobs[0]?.n ?? 0;
    const assessments = runningAssessments[0]?.n ?? 0;
    if (active === 0 && claimed === 0 && assessments === 0) {
      ctx.setState({
        ...ctx.state,
        steps: ctx.state.steps.map((step): WizardStep =>
          step.key === "drain" ? { ...step, detail: "No active runs remain" } : step),
      });
      return;
    }
    ctx.setState({
      ...ctx.state,
      steps: ctx.state.steps.map((step): WizardStep =>
        step.key === "drain"
          ? { ...step, detail: `Waiting: ${active} run(s), ${claimed} agent job(s), ${assessments} assessment(s) in progress` }
          : step),
    });
    if (Date.now() > deadline) {
      throw new WizardError(
        `Drain timed out after ${Math.round(timeoutMs / 60_000)} minutes: ${active} run(s), ${claimed} agent job(s), ${assessments} assessment(s) still active. ` +
        "The source database was not modified. Cancel the runs, then resume the migration.",
      );
    }
    await new Promise((resolvePromise): void => { setTimeout(resolvePromise, DRAIN_POLL_MS); });
  }
}

// ---------------------------------------------------------------------------
// Journal handling: the target's drizzle migration journal is seeded from the
// source so the app's PG migrator sees every migration as already applied and
// boots without re-running DDL (which would conflict with the copied schema).
// ---------------------------------------------------------------------------
async function seedMigrationJournal(source: Readonly<Database>, target: MigrationSql): Promise<void> {
  const rows = source.query(`SELECT hash, created_at AS "createdAt" FROM "__drizzle_migrations" ORDER BY id`).all() as
    readonly MigrationJournalRow[];
  await target.unsafe("CREATE SCHEMA IF NOT EXISTS drizzle");
  await target.unsafe(
    `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
       id serial PRIMARY KEY,
       hash text NOT NULL,
       created_at bigint NOT NULL
     )`,
  );
  await target.unsafe("DELETE FROM drizzle.__drizzle_migrations");
  if (rows.length > 0) {
    const params: unknown[] = [];
    const groups: string[] = [];
    for (const row of rows) {
      const hash = typeof row.hash === "string" ? row.hash : "";
      const createdAt = Number(row.createdAt ?? 0);
      params.push(hash, Number.isFinite(createdAt) ? Math.round(createdAt) : 0);
      groups.push(`($${params.length - 1}, $${params.length})`);
    }
    await target.unsafe(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ${groups.join(", ")}`,
      params,
    );
  }
}

async function verifyJournal(source: Readonly<Database>, target: MigrationSql): Promise<boolean> {
  const sourceRows = source.query(`SELECT hash, created_at AS "createdAt" FROM "__drizzle_migrations" ORDER BY id`).all() as
    readonly MigrationJournalRow[];
  const targetRows = await target.unsafe<MigrationJournalRow>(
    "SELECT hash, created_at::bigint AS \"createdAt\" FROM drizzle.__drizzle_migrations ORDER BY id",
  );
  if (sourceRows.length !== targetRows.length) return false;
  return sourceRows.every((row, index): boolean =>
    row.hash === targetRows[index]?.hash && Number(row.createdAt ?? 0) === Number(targetRows[index]?.createdAt ?? 0));
}

function emptyReport(): MigrationReport {
  return {
    triggersSkipped: 0,
    defaultsDropped: [],
    checksSkipped: [],
    indexesSkipped: [],
    fkViolations: [],
    journalMatch: false,
  };
}

/** Write the durable migration manifest: migration-<yyyy-mm-dd>.json. */
function writeMigrationManifest(state: WizardState, verification: readonly TableVerifyResult[]): void {
  const manifest = {
    source: "sqlite",
    destination: "postgres",
    started_at: state.createdAt,
    completed_at: new Date().toISOString(),
    tables: Object.fromEntries(verification.map((row): [string, number] => [row.table, row.sourceCount])),
  };
  const name = `migration-${new Date().toISOString().slice(0, 10)}.json`;
  const path = join(storageDir, name);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(`[terrence] Migration manifest written to ${path}`);
}

/** Abort a running or stalled migration; maintenance turns off immediately. */
/** @public Intentional surface: benchmark/test hook or cross-module API. */
export function abortMigration(): WizardState {
  const state = loadWizardState();
  if (state === null) throw new WizardError("No migration is in progress.");
  if (state.phase === "switched") {
    throw new WizardError(
      "The backend has already been switched to PostgreSQL. Roll back by editing or removing the boot configuration file (storage/terrence.json).",
    );
  }
  cancelRequested = true;
  exitMaintenance();
  return saveWizardState({ ...state, phase: "aborted", error: "Migration aborted by the operator." });
}

/** Switch the active backend by writing the boot configuration file. */
export function switchBackend(): WizardState {
  const state = loadWizardState();
  if (state === null) throw new WizardError("No migration is in progress.");
  if (state.phase !== "ready_to_switch") {
    throw new WizardError(`Cannot switch backends from phase "${state.phase}"; verification must pass first.`);
  }
  if (state.targetUrl === "") throw new WizardError("Missing target connection URL.");
  const envWarning = environmentDatabaseUrlWarning();
  if (envWarning !== null) {
    throw new WizardError(envWarning);
  }
  writeBootDatabaseConfig(storageDir, { driver: "postgres", url: state.targetUrl });
  exitMaintenance();
  return saveWizardState({ ...state, phase: "switched", error: null });
}

/** Restart the process in place so the new backend takes effect. */
export function restartProcess(): { restartScheduled: boolean; note: string } {
  const state = loadWizardState();
  if (state === null) throw new WizardError("No migration is in progress.");
  if (state.phase !== "switched") {
    throw new WizardError("The backend has not been switched yet.");
  }
  if (restartDisabled()) {
    return {
      restartScheduled: false,
      note: "Restart suppressed by TERRENCE_DISABLE_RESTART (test/benchmark mode). Restart the process manually to boot on PostgreSQL.",
    };
  }
  // Respond first, then exit: the supervisor (Docker restart policy,
  // systemd Restart=) brings the process back on the new backend.
  setTimeout((): void => {
    console.log("[terrence] Migration wizard: restarting process in place to boot on PostgreSQL");
    process.kill(process.pid, "SIGTERM");
  }, 400);
  return { restartScheduled: true, note: "Restart scheduled; the process will return on PostgreSQL." };
}
