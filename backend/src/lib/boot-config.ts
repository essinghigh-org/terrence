// Boot configuration file (storage/terrence.json).
//
// The in-app SQLite → PostgreSQL migration wizard needs to switch the
// database backend from inside the UI. A Docker deployment cannot
// permanently change an environment variable, so Terrence owns a tiny
// boot configuration file in storage that the wizard writes atomically:
//
//   {
//     "database": {
//       "driver": "postgres",
//       "url": "postgres://terrence:secret@db:5432/terrence"
//     }
//   }
//
// Precedence (highest wins):
//   1. DATABASE_URL environment variable (never written back to the file)
//   2. boot configuration file
//   3. default: sqlite at <storage>/terrence.db
//
// The driver is inferred from the DATABASE_URL scheme when the env var is
// set (postgres:// → postgres, file:/:memory: → sqlite). "urlSecret" is
// accepted as an alias for "url" (same semantics, kept for compatibility
// with early designs of this file).
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DatabaseDriver = "sqlite" | "postgres";

export type BootDatabaseConfig = Readonly<{
  driver: DatabaseDriver;
  /** Connection URL. For sqlite: `file:...`, `:memory:`, or a plain path. */
  url?: string;
}>;

export type BootConfig = Readonly<Record<string, unknown> & { database?: BootDatabaseConfig }>;

export type ResolvedDatabaseConfig = Readonly<{
  driver: DatabaseDriver;
  url: string;
}>;

export class BootConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootConfigError";
  }
}

export function bootConfigPath(storageDir: string): string {
  return join(storageDir, "terrence.json");
}

/** Parse and validate a raw boot configuration object. Unknown top-level
 * keys are preserved (the wizard writes only the database section). */
export function parseBootConfig(raw: unknown, source: string): BootConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BootConfigError(`Invalid boot configuration in ${source}: expected a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  const result: Record<string, unknown> = { ...record };
  if (record.database === undefined) return result as BootConfig;
  const db = record.database as Record<string, unknown> | null;
  if (db === null || typeof db !== "object" || Array.isArray(db)) {
    throw new BootConfigError(`Invalid boot configuration in ${source}: "database" must be an object`);
  }
  const driver = db.driver;
  if (driver !== "sqlite" && driver !== "postgres") {
    throw new BootConfigError(
      `Invalid boot configuration in ${source}: "database.driver" must be "sqlite" or "postgres", got ${String(driver)}`,
    );
  }
  const url = typeof db.url === "string" ? db.url : typeof db["urlSecret"] === "string" ? db["urlSecret"] : undefined;
  if (driver === "postgres") {
    if (url === undefined || url.trim() === "") {
      throw new BootConfigError(`Invalid boot configuration in ${source}: postgres driver requires "database.url"`);
    }
    validatePostgresUrl(url, source);
  } else if (url !== undefined) {
    validateSqliteUrl(url, source);
  }
  result.database = { driver, ...(url !== undefined ? { url } : {}) };
  return result as BootConfig;
}

function validatePostgresUrl(url: string, source: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BootConfigError(`Invalid boot configuration in ${source}: "${url}" is not a valid URL`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new BootConfigError(
      `Invalid boot configuration in ${source}: postgres URL must use postgres:// or postgresql://, got "${parsed.protocol}//"`,
    );
  }
  if (parsed.hostname === "") {
    throw new BootConfigError(`Invalid boot configuration in ${source}: postgres URL has no host`);
  }
}

function validateSqliteUrl(url: string, source: string): void {
  if (url === ":memory:") return;
  if (url.startsWith("file:")) return;
  // A bare path is accepted and treated as a file URL (bun:sqlite accepts it).
  if (url.trim() !== "" && !url.includes("\u0000")) return;
  throw new BootConfigError(`Invalid boot configuration in ${source}: invalid sqlite URL "${url}"`);
}

/** Read + validate the boot config file. Missing file → defaults. */
export function readBootConfigFile(storageDir: string): BootConfig {
  const path = bootConfigPath(storageDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw new BootConfigError(`Invalid boot configuration at ${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return parseBootConfig(parsed, path);
}

/**
 * Resolve the active database configuration with full precedence.
 * Exposed separately from the storage-dir wiring so tests can exercise
 * precedence without touching the filesystem.
 */
export function resolveDatabaseConfig(
  env: Readonly<Record<string, string | undefined>>,
  storageDir: string,
): ResolvedDatabaseConfig {
  const envUrl = env.DATABASE_URL;
  if (envUrl !== undefined && envUrl !== "") {
    if (/^postgres(ql)?:\/\//i.test(envUrl)) {
      validatePostgresUrl(envUrl, "DATABASE_URL");
      return { driver: "postgres", url: envUrl };
    }
    // file:, :memory:, or a bare path: bun:sqlite handles all of these.
    // Any other URL scheme (mysql://, mongodb://, ...) is a configuration
    // error that must not silently fall through to a sqlite file path.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(envUrl)) {
      throw new BootConfigError(`DATABASE_URL uses an unsupported scheme: "${envUrl.slice(0, envUrl.indexOf("://"))}://"`);
    }
    return { driver: "sqlite", url: envUrl };
  }
  const fileConfig = readBootConfigFile(storageDir);
  const db = fileConfig.database;
  if (db !== undefined) {
    if (db.driver === "postgres") {
      return { driver: "postgres", url: db.url ?? "" };
    }
    return { driver: "sqlite", url: db.url ?? defaultSqliteUrl(storageDir) };
  }
  return { driver: "sqlite", url: defaultSqliteUrl(storageDir) };
}

export function defaultSqliteUrl(storageDir: string): string {
  return `file:${join(storageDir, "terrence.db")}`;
}

/**
 * Atomically write the database section of the boot config (tmp + rename,
 * 0600 because the URL may embed credentials). Other top-level keys of an
 * existing file are preserved. Used by the in-app migration wizard to
 * switch backends; the environment always overrides the file at boot.
 */
export function writeBootDatabaseConfig(storageDir: string, database: BootDatabaseConfig): void {
  const path = bootConfigPath(storageDir);
  const existing = readBootConfigFile(storageDir);
  // parseBootConfig guarantees a database section when one is supplied.
  const validated = parseBootConfig({ database }, path).database as BootDatabaseConfig;
  const next: BootConfig = {
    ...existing,
    database: validated,
  };
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Best-effort on filesystems without chmod semantics.
  }
  renameSync(tmp, path);
}
