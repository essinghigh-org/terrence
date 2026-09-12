// Backup manifest, integrity verification, and isolated restore rehearsal.
//
// A backup is useful only when the database, durable files, and the key
// material that decrypts them are a single restorable set.  This module keeps
// that evidence in ordinary, mode-0600 files instead of adding a database
// table: the evidence must remain readable while the database is unavailable
// during a restore.
//
// Rehearsals never open the configured application database.  They copy or
// extract the operator-supplied backup into a private temporary directory,
// run all checks against that copy, and remove it before returning.  There is
// deliberately no restore or cutover operation here.

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, type Stats } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import * as schema from "../db/schema-sqlite";
import { databaseSchemaVersion, isPostgres, rawQueryAll } from "../db";
import { databaseUrl, storageDir as configuredStorageDir } from "../db/driver";
import { decryptSecretSync, isEncryptedSecret } from "./secrets";
import { runBoundedProcess } from "./bounded-process";
import { tarMemberIsForbiddenSpecial, tarMemberPathUnsafe } from "./archive";
import { schemaTables } from "./db-transfer";
import { sha256File } from "./file-hash";

export const BACKUP_MANIFEST_VERSION = 1;
export const BACKUP_MANIFEST_FILE = "terrence-backup-manifest.json";
export const BACKUP_STATUS_FILE = "backup-verification-status.json";
export const BACKUP_MANIFEST_DIRECTORY = "backup-manifests";

const MAX_MANIFEST_FILES = 200_000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 200_000;
const MAX_REHEARSAL_OUTPUT_BYTES = 128 * 1024;
const MAX_ENCRYPTED_SAMPLES_PER_COLUMN = 3;

type DriverName = "sqlite" | "postgres";

export type BackupFileDigest = Readonly<{
  path: string;
  sizeBytes: number;
  sha256: string;
}>;

export type BackupKeyIdentifier = Readonly<{
  present: boolean;
  sha256: string | null;
}>;

export type BackupManifest = Readonly<{
  kind: "terrence-backup";
  version: 1;
  createdAt: string;
  consistency: "sqlite-read-snapshot" | "postgres-read-snapshot" | "operator-quiesced";
  database: Readonly<{
    driver: DriverName;
    file: string | null;
    sha256: string | null;
    schemaVersion: string | null;
    schemaSha256: string;
    tables: Readonly<Record<string, number>>;
  }>;
  storage: Readonly<{
    fileCount: number;
    totalBytes: number;
    files: readonly BackupFileDigest[];
  }>;
  encryptedRecords: Readonly<Record<string, number>>;
  keys: Readonly<{
    encryptionKey: BackupKeyIdentifier;
    encryptionSalt: BackupKeyIdentifier;
    tokenHashSecret: BackupKeyIdentifier;
    signedUrlSecret: BackupKeyIdentifier;
    passwordConfigured: boolean;
  }>;
  manifestSha256: string;
}>;

export type BackupStatus = Readonly<{
  lastVerifiedRestoreAt: string | null;
  lastVerifiedManifestSha256: string | null;
  lastRehearsalId: string | null;
}>;

export type BackupCheck = Readonly<{
  name: string;
  status: "pass" | "warning" | "fail";
  detail?: string;
}>;

export type BackupIntegrityReport = Readonly<{
  passed: boolean;
  manifest: BackupManifest | null;
  checks: readonly BackupCheck[];
  lastVerifiedRestoreAt: string | null;
}>;

export type BackupRehearsalReport = Readonly<{
  id: string;
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  checks: readonly BackupCheck[];
  lastVerifiedRestoreAt: string | null;
}>;

export type BackupSourceOptions = Readonly<{
  /** Directory, manifest, SQLite file, or tar archive supplied by the operator. */
  sourcePath: string;
  /** Optional explicit storage directory when the database is separate. */
  storagePath?: string;
  /** Optional explicit SQLite database file when it is separate. */
  databasePath?: string;
}>;

export type CreateManifestOptions = Readonly<{
  storagePath?: string;
  databasePath?: string;
  persist?: boolean;
  outputDirectory?: string;
}>;

export type RestoreRehearsalOptions = Readonly<{
  source: BackupSourceOptions;
  cliPath?: string;
  requireCli?: boolean;
  id?: string;
}>;

export class BackupVerificationError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BackupVerificationError";
    this.code = code;
  }
}

type PreparedSource = Readonly<{
  root: string;
  storagePath: string;
  databasePath: string | null;
  manifest: BackupManifest;
  archivePath: string | null;
  cleanup: () => Promise<void>;
}>;

const ENCRYPTED_COLUMN_CANDIDATES: readonly Readonly<{ table: string; column: string }>[] = [
  { table: "workspace_variables", column: "value_encrypted" },
  { table: "variable_set_variables", column: "value_encrypted" },
  { table: "policy_set_parameters", column: "value_encrypted" },
  { table: "state_versions", column: "state_payload" },
  { table: "state_versions", column: "json_state" },
  { table: "state_versions", column: "json_state_outputs" },
  { table: "run_provenance_capsules", column: "execution_material" },
  { table: "user_2fa", column: "secret_encrypted" },
];

const KEY_FILES = {
  encryptionKey: ".encryption-key",
  encryptionSalt: ".encryption-salt",
  tokenHashSecret: ".token-hash-secret",
  signedUrlSecret: ".signed-url-secret",
} as const;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function defaultStoragePath(): string {
  return resolve(process.env["STORAGE_DIR"] ?? configuredStorageDir);
}

function defaultDatabasePath(): string | null {
  if (isPostgres || databaseUrl === ":memory:") return null;
  return resolve(databaseUrl.replace(/^file:/, ""));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key): string => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashManifestBody(manifest: Omit<BackupManifest, "manifestSha256">): string {
  return sha256Text(canonicalJson(manifest));
}

function normalizeManifest(manifest: Omit<BackupManifest, "manifestSha256">): BackupManifest {
  return { ...manifest, manifestSha256: hashManifestBody(manifest) };
}

function assertManifestIdentity(candidate: Partial<BackupManifest> & { manifestSha256?: unknown }): Omit<BackupManifest, "manifestSha256"> {
  if (candidate.kind !== "terrence-backup" || candidate.version !== BACKUP_MANIFEST_VERSION) {
    throw new BackupVerificationError("manifest-incompatible", "Backup manifest version is not supported");
  }
  if (typeof candidate.createdAt !== "string" || typeof candidate.manifestSha256 !== "string") {
    throw new BackupVerificationError("manifest-invalid", "Backup manifest is missing its identity fields");
  }
  const body = Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== "manifestSha256"));
  const expected = hashManifestBody(body as Omit<BackupManifest, "manifestSha256">);
  if (candidate.manifestSha256 !== expected) throw new BackupVerificationError("manifest-tampered", "Backup manifest checksum does not match its contents");
  if (candidate.database === undefined || candidate.storage === undefined || candidate.keys === undefined) {
    throw new BackupVerificationError("manifest-invalid", "Backup manifest is missing database, storage, or key metadata");
  }
  return body as Omit<BackupManifest, "manifestSha256">;
}

function validDatabaseSection(database: unknown): boolean {
  if (database === null || typeof database !== "object" || Array.isArray(database)) return false;
  const section = database as { driver?: unknown; schemaSha256?: unknown };
  return (section.driver === "sqlite" || section.driver === "postgres")
    && typeof section.schemaSha256 === "string"
    && /^[a-f0-9]{64}$/.test(section.schemaSha256);
}

function validStorageSection(storage: unknown): boolean {
  if (storage === null || typeof storage !== "object" || Array.isArray(storage)) return false;
  return Array.isArray((storage as { files?: unknown }).files);
}

function invalidManifestFileEntry(file: unknown): boolean {
  if (file === null || typeof file !== "object" || Array.isArray(file)) return true;
  const item = file as { path?: unknown; sizeBytes?: unknown; sha256?: unknown };
  return typeof item.path !== "string" || !manifestPathSafe(item.path)
    || typeof item.sizeBytes !== "number" || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0
    || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256);
}

function assertStorageFileMetadata(storage: { fileCount?: unknown; totalBytes?: unknown; files: readonly unknown[] }): void {
  if (!Number.isSafeInteger(storage.fileCount)
    || !Number.isSafeInteger(storage.totalBytes)
    || storage.files.some(invalidManifestFileEntry)) {
    throw new BackupVerificationError("manifest-invalid", "Backup manifest has invalid storage file metadata");
  }
  if (storage.fileCount !== storage.files.length
    || storage.totalBytes !== storage.files.reduce((sum: number, file: unknown): number => sum + (file as { sizeBytes: number }).sizeBytes, 0)) {
    throw new BackupVerificationError("manifest-invalid", "Backup manifest storage totals do not match its file entries");
  }
}

function validKeyIdentifier(item: unknown): boolean {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
  const identifier = item as { present?: unknown; sha256?: unknown };
  if (typeof identifier.present !== "boolean") return false;
  return identifier.sha256 === null || typeof identifier.sha256 === "string" && /^[a-f0-9]{64}$/.test(identifier.sha256);
}

function validKeyMetadata(keys: unknown, keyNames: readonly string[]): boolean {
  if (keys === null || typeof keys !== "object" || Array.isArray(keys)) return false;
  if (typeof (keys as { passwordConfigured?: unknown }).passwordConfigured !== "boolean") return false;
  return keyNames.every((name): boolean => validKeyIdentifier((keys as Record<string, unknown>)[name]));
}

function parseManifest(raw: unknown): BackupManifest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new BackupVerificationError("manifest-invalid", "Backup manifest must be a JSON object");
  const candidate = raw as Partial<BackupManifest> & { manifestSha256?: unknown };
  assertManifestIdentity(candidate);
  const database = candidate.database;
  const storage = candidate.storage;
  if (!validDatabaseSection(database) || !validStorageSection(storage)) {
    throw new BackupVerificationError("manifest-invalid", "Backup manifest has invalid database or storage metadata");
  }
  assertStorageFileMetadata(storage as { fileCount?: unknown; totalBytes?: unknown; files: readonly unknown[] });
  const keys = candidate.keys;
  const keyNames = Object.keys(KEY_FILES) as readonly (keyof typeof KEY_FILES)[];
  if (!validKeyMetadata(keys, keyNames)) throw new BackupVerificationError("manifest-invalid", "Backup manifest has invalid key metadata");
  return candidate as BackupManifest;
}

function manifestPathSafe(path: string): boolean {
  if (path === "" || path.includes("\u0000") || path.includes("\\") || isAbsolute(path)) return false;
  const parts = path.split("/");
  return parts.every((part): boolean => part !== "" && part !== "." && part !== "..");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function digestFile(path: string): Promise<BackupFileDigest> {
  const info = await stat(path);
  if (!info.isFile()) throw new BackupVerificationError("storage-entry-invalid", "Backup storage contains a non-file entry");
  return { path: path, sizeBytes: info.size, sha256: await sha256File(path) };
}

async function collectFiles(root: string): Promise<readonly BackupFileDigest[]> {
  const entries: BackupFileDigest[] = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const names = await readdir(directory, { withFileTypes: true });
    for (const entry of names) {
      const full = join(directory, entry.name);
      if (entry.name === BACKUP_MANIFEST_DIRECTORY) continue;
      if (entry.name === BACKUP_MANIFEST_FILE || entry.name === "manifest.json") continue;
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!entry.isFile()) throw new BackupVerificationError("storage-entry-invalid", "Backup storage contains a link or special file");
      if (entries.length >= MAX_MANIFEST_FILES) throw new BackupVerificationError("storage-too-large", "Backup storage contains too many files");
      const info = await stat(full);
      totalBytes += info.size;
      if (totalBytes > MAX_MANIFEST_BYTES) throw new BackupVerificationError("storage-too-large", "Backup storage exceeds the manifest size limit");
      const digest = await digestFile(full);
      entries.push({ ...digest, path: relative(root, full).split(sep).join("/") });
    }
  };
  await visit(root);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

async function keyIdentifier(storagePath: string, fileName: string): Promise<BackupKeyIdentifier> {
  const path = join(storagePath, fileName);
  try {
    const info = await stat(path);
    if (!info.isFile()) return { present: false, sha256: null };
    return { present: true, sha256: await sha256File(path) };
  } catch {
    return { present: false, sha256: null };
  }
}

async function queryTableCounts(): Promise<Readonly<Record<string, number>>> {
  const tables = schemaTables().map((table): string => table.name);
  const uniqueTables = [...new Set(tables)];
  if (uniqueTables.length === 0) return {};
  const query = uniqueTables.map((table): string => `SELECT ${quoteLiteral(table)} AS "tableName", COUNT(*) AS "rowCount" FROM ${quoteIdentifier(table)}`).join(" UNION ALL ");
  try {
    const rows = await rawQueryAll<{ tableName: string; rowCount: number | bigint }>(sql.raw(query));
    return Object.fromEntries(rows.map((row): [string, number] => [row.tableName, Number(row.rowCount)]));
  } catch (error) {
    throw new BackupVerificationError("schema-incompatible", `Unable to count the configured schema tables: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function queryEncryptedRecordCounts(): Promise<Readonly<Record<string, number>>> {
  const clauses = ENCRYPTED_COLUMN_CANDIDATES.map(({ table, column }): string =>
    `SELECT ${quoteLiteral(`${table}.${column}`)} AS "key", COUNT(*) AS "count" FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} LIKE 'enc:v1:%'`)
    .join(" UNION ALL ");
  try {
    const rows = await rawQueryAll<{ key: string; count: number | bigint }>(sql.raw(clauses));
    return Object.fromEntries(rows.map((row): [string, number] => [row.key, Number(row.count)]).filter(([, count]) => count > 0));
  } catch {
    // Older supported installations may not yet carry an optional encrypted
    // column.  The schema/table check remains authoritative; omit only the
    // optional coverage entry.
    return {};
  }
}

async function schemaDigestForLiveDatabase(): Promise<string> {
  try {
    const rows = await rawQueryAll<Record<string, unknown>>(sql.raw(
      isPostgres
        ? "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position"
        : "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
    ));
    return sha256Text(canonicalJson(rows));
  } catch (error) {
    throw new BackupVerificationError("schema-unavailable", `Unable to read the active database schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function schemaDigestForSqlite(database: Readonly<Database>): Promise<string> {
  const rows = database.query("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all() as readonly Record<string, unknown>[];
  return sha256Text(canonicalJson(rows));
}

function relativeDatabaseFile(storagePath: string, databasePath: string): string | null {
  const path = relative(storagePath, databasePath).split(sep).join("/");
  return path === "" || path.startsWith("../") || path === ".." ? null : path;
}

async function createLiveManifest(options: CreateManifestOptions = {}): Promise<BackupManifest> {
  const storage = resolve(options.storagePath ?? defaultStoragePath());
  const database = options.databasePath === undefined ? defaultDatabasePath() : resolve(options.databasePath);
  const files = await collectFiles(storage);
  const databaseDigest = database === null ? null : await pathExists(database) ? await sha256File(database) : null;
  const tables = await queryTableCounts();
  const body: Omit<BackupManifest, "manifestSha256"> = {
    kind: "terrence-backup",
    version: BACKUP_MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    consistency: isPostgres ? "postgres-read-snapshot" : "sqlite-read-snapshot",
    database: {
      driver: isPostgres ? "postgres" : "sqlite",
      file: database === null ? null : relativeDatabaseFile(storage, database),
      sha256: databaseDigest,
      schemaVersion: databaseSchemaVersion(),
      schemaSha256: await schemaDigestForLiveDatabase(),
      tables,
    },
    storage: {
      fileCount: files.length,
      totalBytes: files.reduce((sum, file): number => sum + file.sizeBytes, 0),
      files,
    },
    encryptedRecords: await queryEncryptedRecordCounts(),
    keys: {
      encryptionKey: await keyIdentifier(storage, KEY_FILES.encryptionKey),
      encryptionSalt: await keyIdentifier(storage, KEY_FILES.encryptionSalt),
      tokenHashSecret: await keyIdentifier(storage, KEY_FILES.tokenHashSecret),
      signedUrlSecret: await keyIdentifier(storage, KEY_FILES.signedUrlSecret),
      passwordConfigured: typeof process.env["ENCRYPTION_PASSWORD"] === "string" && process.env["ENCRYPTION_PASSWORD"] !== "",
    },
  };
  return normalizeManifest(body);
}

export async function createBackupManifest(options: CreateManifestOptions = {}): Promise<Readonly<{ manifest: BackupManifest; path: string | null }>> {
  const manifest = await createLiveManifest(options);
  if (options.persist === false) return { manifest, path: null };
  const directory = resolve(options.outputDirectory ?? join(options.storagePath ?? defaultStoragePath(), BACKUP_MANIFEST_DIRECTORY));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, BACKUP_MANIFEST_FILE);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { manifest, path };
}

/** Build a manifest from a stopped/quiesced SQLite backup directory.  This is
 * separate from createBackupManifest(), which describes the active instance
 * and uses one database read snapshot. */
// The source discovery deliberately keeps the archive/directory/schema paths
// together; the complexity is the validation matrix, not branching business
// logic spread across callers.
// eslint-disable-next-line complexity
export async function createBackupManifestForSource(
  source: BackupSourceOptions,
  options: Readonly<{ persist?: boolean; outputDirectory?: string }> = {},
): Promise<Readonly<{ manifest: BackupManifest; path: string | null }>> {
  const sourcePath = resolve(source.sourcePath);
  const sourceInfo = await stat(sourcePath).catch((): null => null);
  if (sourceInfo === null) throw new BackupVerificationError("source-missing", "Backup source does not exist");
  let root = sourceInfo.isDirectory() ? sourcePath : dirname(sourcePath);
  let temporaryRoot: string | null = null;
  if (!sourceInfo.isDirectory() && sourceInfo.isFile() && sourceLooksLikeArchive(sourcePath)) {
    await assertSafeBackupArchive(sourcePath);
    temporaryRoot = await mkdtemp(join(tmpdir(), "terrence-backup-manifest-"));
    try {
      await runBoundedProcess(["tar", "-xf", sourcePath, "-C", temporaryRoot], { timeoutMs: 60_000, maxStdoutBytes: MAX_REHEARSAL_OUTPUT_BYTES });
      root = temporaryRoot;
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true });
      throw new BackupVerificationError("archive-invalid", `Unable to extract backup archive: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (!sourceInfo.isDirectory() && sourceInfo.isFile() && [".db", ".sqlite", ".json"].includes(extname(sourcePath).toLowerCase())) {
    root = dirname(sourcePath);
  } else if (!sourceInfo.isDirectory()) {
    throw new BackupVerificationError("source-invalid", "Backup source must be a directory, manifest, SQLite file, or tar archive");
  }
  try {
    const storage = resolve(source.storagePath ?? root);
    const databasePath = await discoverDatabase(
      root,
      source.databasePath ?? (sourceInfo.isFile() && !sourceLooksLikeArchive(sourcePath) && extname(sourcePath).toLowerCase() !== ".json" ? sourcePath : undefined),
    );
    if (databasePath === null) throw new BackupVerificationError("database-input", "Backup does not contain a SQLite database file");
    const database = new Database(databasePath, { readonly: true });
    try {
      const expectedTables = Object.fromEntries(schemaTables().map((table): [string, number] => [table.name, 0]));
      const tables = sqliteTableCounts(database, expectedTables);
      const schemaSha256 = await schemaDigestForSqlite(database);
      const journal = database.query("SELECT hash FROM __drizzle_migrations ORDER BY id DESC LIMIT 1").get() as { hash?: unknown } | null;
      const files = await collectFiles(storage);
      const body: Omit<BackupManifest, "manifestSha256"> = {
        kind: "terrence-backup",
        version: BACKUP_MANIFEST_VERSION,
        createdAt: new Date().toISOString(),
        consistency: "operator-quiesced",
        database: {
          driver: "sqlite",
          file: relativeDatabaseFile(storage, resolve(databasePath)),
          sha256: await sha256File(databasePath),
          schemaVersion: typeof journal?.hash === "string" ? journal.hash : null,
          schemaSha256,
          tables,
        },
        storage: {
          fileCount: files.length,
          totalBytes: files.reduce((sum, file): number => sum + file.sizeBytes, 0),
          files,
        },
        encryptedRecords: sqliteEncryptedRecordCounts(database),
        keys: {
          encryptionKey: await keyIdentifier(storage, KEY_FILES.encryptionKey),
          encryptionSalt: await keyIdentifier(storage, KEY_FILES.encryptionSalt),
          tokenHashSecret: await keyIdentifier(storage, KEY_FILES.tokenHashSecret),
          signedUrlSecret: await keyIdentifier(storage, KEY_FILES.signedUrlSecret),
          passwordConfigured: typeof process.env["ENCRYPTION_PASSWORD"] === "string" && process.env["ENCRYPTION_PASSWORD"] !== "",
        },
      };
      const manifest = normalizeManifest(body);
      if (options.persist === false) return { manifest, path: null };
      const directory = resolve(options.outputDirectory ?? join(storage, BACKUP_MANIFEST_DIRECTORY));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, BACKUP_MANIFEST_FILE);
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      return { manifest, path };
    } finally {
      database.close();
    }
  } finally {
    if (temporaryRoot !== null) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function readBackupStatus(storagePath: string = defaultStoragePath()): Promise<BackupStatus> {
  try {
    const parsed = JSON.parse(await readFile(join(resolve(storagePath), BACKUP_STATUS_FILE), "utf8")) as Partial<BackupStatus>;
    return {
      lastVerifiedRestoreAt: typeof parsed.lastVerifiedRestoreAt === "string" ? parsed.lastVerifiedRestoreAt : null,
      lastVerifiedManifestSha256: typeof parsed.lastVerifiedManifestSha256 === "string" ? parsed.lastVerifiedManifestSha256 : null,
      lastRehearsalId: typeof parsed.lastRehearsalId === "string" ? parsed.lastRehearsalId : null,
    };
  } catch {
    return { lastVerifiedRestoreAt: null, lastVerifiedManifestSha256: null, lastRehearsalId: null };
  }
}

async function recordSuccessfulRestore(storagePath: string, manifest: BackupManifest, rehearsalId: string): Promise<BackupStatus> {
  const status: BackupStatus = {
    lastVerifiedRestoreAt: new Date().toISOString(),
    lastVerifiedManifestSha256: manifest.manifestSha256,
    lastRehearsalId: rehearsalId,
  };
  const path = join(resolve(storagePath), BACKUP_STATUS_FILE);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  const { rename } = await import("node:fs/promises");
  await rename(temporary, path);
  return status;
}

function sourceLooksLikeArchive(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2");
}

function safeArchiveMemberName(line: string): string | null {
  // `tar --numeric-owner -tvf` keeps owner/group fields free of spaces.  The
  // final capture is the member name, including spaces in a legitimate file.
  const match = /^(\S+)\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line);
  if (match === null) return null;
  const first = match[1]?.[0] ?? "";
  const member = match[3] ?? "";
  if (tarMemberIsForbiddenSpecial(first) || (first !== "-" && first !== "d")) return null;
  if (tarMemberPathUnsafe(member) || member.includes("\\") || member.startsWith("/") || /^[A-Za-z]:/.test(member)) return null;
  const size = Number(match[2]);
  if (!Number.isSafeInteger(size) || size > MAX_ARCHIVE_BYTES) return null;
  return member;
}

async function assertSafeBackupArchive(path: string): Promise<void> {
  const info = await stat(path).catch((): null => null);
  if (info === null || !info.isFile() || info.size === 0) throw new BackupVerificationError("archive-invalid", "Backup archive is missing or empty");
  if (info.size > MAX_ARCHIVE_BYTES) throw new BackupVerificationError("archive-too-large", "Backup archive exceeds the size limit");
  let listing: string;
  try {
    listing = (await runBoundedProcess(["tar", "--numeric-owner", "-tvf", path], { timeoutMs: 30_000, maxStdoutBytes: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    throw new BackupVerificationError("archive-invalid", `Unable to inspect backup archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  const members = listing.split("\n").filter((line): boolean => line !== "");
  if (members.length === 0) throw new BackupVerificationError("archive-invalid", "Backup archive contains no members");
  if (members.length > MAX_ARCHIVE_MEMBERS) throw new BackupVerificationError("archive-too-large", "Backup archive contains too many members");
  const seen = new Set<string>();
  let logicalBytes = 0;
  for (const line of members) {
    const member = safeArchiveMemberName(line);
    if (member === null) throw new BackupVerificationError("archive-unsafe", "Backup archive contains a link, special file, or unsafe path");
    const canonical = member.split("/").filter((part): boolean => part !== "" && part !== ".").join("/");
    if (seen.has(canonical)) throw new BackupVerificationError("archive-unsafe", "Backup archive contains duplicate members");
    seen.add(canonical);
    const sizeMatch = /^(\S+)\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line);
    logicalBytes += Number(sizeMatch?.[2] ?? 0);
    if (logicalBytes > MAX_ARCHIVE_BYTES) throw new BackupVerificationError("archive-too-large", "Backup archive expands beyond the size limit");
  }
}

async function findFile(root: string, names: readonly string[]): Promise<string | null> {
  const wanted = new Set(names);
  const queue: { path: string; level: number }[] = [{ path: root, level: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const entries = await readdir(current.path, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isFile() && wanted.has(entry.name)) return path;
      if (entry.isDirectory() && !entry.name.startsWith(".") && current.level < 5) queue.push({ path, level: current.level + 1 });
    }
  }
  return null;
}

async function discoverManifest(root: string): Promise<BackupManifest> {
  const manifestPath = await findFile(root, [BACKUP_MANIFEST_FILE, "manifest.json"]);
  if (manifestPath === null) throw new BackupVerificationError("manifest-missing", `Backup does not contain ${BACKUP_MANIFEST_FILE}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new BackupVerificationError("manifest-invalid", `Backup manifest cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseManifest(parsed);
}

async function discoverDatabase(root: string, explicit: string | undefined): Promise<string | null> {
  if (explicit !== undefined) {
    const candidate = resolve(explicit);
    return await pathExists(candidate) ? candidate : null;
  }
  const direct = await findFile(root, ["terrence.db"]);
  if (direct !== null) return direct;
  const dbFiles: string[] = [];
  const walk = async (directory: string, level: number): Promise<void> => {
    if (level > 4) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, level + 1);
      else if (entry.isFile() && (entry.name.endsWith(".db") || entry.name.endsWith(".sqlite"))) dbFiles.push(path);
    }
  };
  await walk(root, 0);
  if (dbFiles.length === 1) return dbFiles[0] ?? null;
  if (dbFiles.length > 1) throw new BackupVerificationError("database-ambiguous", "Backup contains more than one SQLite database; specify database-path");
  return null;
}

async function unpackArchiveSource(sourcePath: string): Promise<{ archivePath: string; temporaryRoot: string }> {
  await assertSafeBackupArchive(sourcePath);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "terrence-backup-source-"));
  try {
    await runBoundedProcess(["tar", "-xf", sourcePath, "-C", temporaryRoot], { timeoutMs: 60_000, maxStdoutBytes: MAX_REHEARSAL_OUTPUT_BYTES });
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw new BackupVerificationError("archive-invalid", `Unable to extract backup archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { archivePath: sourcePath, temporaryRoot };
}

function explicitDatabasePath(source: BackupSourceOptions, sourcePath: string, sourceInfo: Stats): string | undefined {
  if (source.databasePath !== undefined) return source.databasePath;
  if (sourceInfo.isFile() && !sourceLooksLikeArchive(sourcePath) && extname(sourcePath).toLowerCase() !== ".json") return sourcePath;
  return undefined;
}

async function resolveStoragePath(root: string, storagePath: string | undefined): Promise<string> {
  const nestedStorage = join(root, "storage");
  if (storagePath === undefined && await pathExists(nestedStorage)) return nestedStorage;
  return storagePath === undefined ? root : resolve(storagePath);
}

async function prepareSource(source: BackupSourceOptions): Promise<PreparedSource> {
  const sourcePath = resolve(source.sourcePath);
  const sourceInfo = await stat(sourcePath).catch((): null => null);
  if (sourceInfo === null) throw new BackupVerificationError("source-missing", "Backup source does not exist");
  if (!sourceInfo.isDirectory() && !sourceInfo.isFile()) {
    throw new BackupVerificationError("source-invalid", "Backup source must be a directory, manifest, SQLite file, or tar archive");
  }

  let root = sourceInfo.isDirectory() ? sourcePath : dirname(sourcePath);
  let archivePath: string | null = null;
  let temporaryRoot: string | null = null;
  if (!sourceInfo.isDirectory() && sourceInfo.isFile() && sourceLooksLikeArchive(sourcePath)) {
    ({ archivePath, temporaryRoot } = await unpackArchiveSource(sourcePath));
    root = temporaryRoot;
  }

  const database = await discoverDatabase(root, explicitDatabasePath(source, sourcePath, sourceInfo));
  const manifest = await discoverManifest(root);
  const storage = await resolveStoragePath(root, source.storagePath);
  const cleanup = async (): Promise<void> => {
    if (temporaryRoot !== null) await rm(temporaryRoot, { recursive: true, force: true });
  };
  return { root, storagePath: storage, databasePath: database, manifest, archivePath, cleanup };
}

function check(status: BackupCheck["status"], name: string, detail?: string): BackupCheck {
  return { name, status, ...(detail === undefined ? {} : { detail }) };
}

function recordManifestFiles(manifest: BackupManifest): Map<string, BackupFileDigest> {
  return new Map(manifest.storage.files.map((file): [string, BackupFileDigest] => [file.path, file]));
}

function storageFileCandidates(storagePath: string, relativePath: string): readonly string[] {
  return [join(storagePath, relativePath), join(storagePath, relativePath.replaceAll("/", sep))];
}

async function verifyStorageFiles(manifest: BackupManifest, storagePath: string): Promise<BackupCheck> {
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const file of manifest.storage.files) {
    let candidate: string | undefined;
    for (const path of storageFileCandidates(storagePath, file.path)) {
      if (await pathExists(path)) { candidate = path; break; }
    }
    if (candidate === undefined) {
      missing.push(file.path);
      continue;
    }
    try {
      const info = await stat(candidate);
      const digest = await sha256File(candidate);
      if (info.size !== file.sizeBytes || digest !== file.sha256) mismatched.push(file.path);
    } catch {
      mismatched.push(file.path);
    }
  }
  if (missing.length > 0) return check("fail", "storage-digests", `${missing.length} stored file(s) are missing`);
  if (mismatched.length > 0) return check("fail", "storage-digests", `${mismatched.length} stored file(s) have a size or digest mismatch`);
  return check("pass", "storage-digests", `${manifest.storage.fileCount} stored file(s) verified`);
}

function pathSuffixCandidates(path: string): string[] {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter((part): boolean => part !== "" && part !== ".");
  return parts.map((_, index): string => parts.slice(index).join("/"));
}

function resolveArtifactPath(path: string, storagePath: string, manifest: BackupManifest): string | null {
  if (path === "" || path.includes("\u0000")) return null;
  if (!isAbsolute(path)) return join(storagePath, path);
  const files = recordManifestFiles(manifest);
  for (const suffix of pathSuffixCandidates(path)) {
    if (!files.has(suffix)) continue;
    const candidate = join(storagePath, suffix);
    if (existsSync(candidate)) return candidate;
  }
  const base = basename(path);
  const matching = [...files.keys()].filter((file): boolean => basename(file) === base);
  if (matching.length === 1) {
    const matchingPath = matching[0];
    if (matchingPath === undefined) return null;
    const candidate = join(storagePath, matchingPath);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function verifyArtifactReferences(database: Readonly<Database>, storagePath: string, manifest: BackupManifest): Promise<BackupCheck> {
  const references = [
    { table: "configuration_versions", column: "archive_path" },
    { table: "policy_set_versions", column: "archive_path" },
    { table: "registry_module_versions", column: "archive_path" },
    { table: "module_test_configuration_versions", column: "archive_path" },
  ] as const;
  let checked = 0;
  let missing = 0;
  for (const reference of references) {
    const hasColumn = (database.query(`PRAGMA table_info(${quoteIdentifier(reference.table)})`).all() as readonly { name?: unknown }[]).some((column): boolean => column.name === reference.column);
    if (!hasColumn) continue;
    const rows = database.query(`SELECT ${quoteIdentifier(reference.column)} AS "path" FROM ${quoteIdentifier(reference.table)} WHERE ${quoteIdentifier(reference.column)} IS NOT NULL`).all() as readonly { path?: unknown }[];
    for (const row of rows) {
      checked += 1;
      if (typeof row.path !== "string" || resolveArtifactPath(row.path, storagePath, manifest) === null) missing += 1;
    }
  }
  return missing === 0
    ? check("pass", "artifact-references", `${checked} referenced artifact(s) are readable`)
    : check("fail", "artifact-references", `${missing} referenced artifact(s) are missing`);
}

function sqliteTableNames(database: Readonly<Database>): Set<string> {
  const rows = database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as readonly { name?: unknown }[];
  return new Set(rows.map((row): string | null => typeof row.name === "string" ? row.name : null).filter((name): name is string => name !== null));
}

function sqliteTableCounts(database: Readonly<Database>, expectedTables: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const available = sqliteTableNames(database);
  const missing = Object.keys(expectedTables).filter((name): boolean => !available.has(name));
  if (missing.length > 0) throw new BackupVerificationError("schema-incompatible", `Backup database is missing ${missing.length} required schema table(s)`);
  return Object.fromEntries(Object.keys(expectedTables).map((table): [string, number] => {
    const row = database.query(`SELECT COUNT(*) AS "count" FROM ${quoteIdentifier(table)}`).get() as { count?: number | bigint } | null;
    return [table, Number(row?.count ?? 0)];
  }));
}

function sqliteEncryptedRecordCounts(database: Readonly<Database>): Readonly<Record<string, number>> {
  const available = sqliteTableNames(database);
  const counts: Record<string, number> = {};
  for (const { table, column } of ENCRYPTED_COLUMN_CANDIDATES) {
    if (!available.has(table)) continue;
    const hasColumn = (database.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as readonly { name?: unknown }[]).some((row): boolean => row.name === column);
    if (!hasColumn) continue;
    const row = database.query(`SELECT COUNT(*) AS "count" FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} LIKE 'enc:v1:%'`).get() as { count?: number | bigint } | null;
    const count = Number(row?.count ?? 0);
    if (count > 0) counts[`${table}.${column}`] = count;
  }
  return counts;
}

async function checkKeyIdentifiers(storagePath: string, manifest: BackupManifest): Promise<BackupCheck> {
  const expected = manifest.keys;
  const mismatches: string[] = [];
  for (const [name, file] of Object.entries(KEY_FILES)) {
    const actual = await keyIdentifier(storagePath, file);
    const expectedKey = expected[name as keyof typeof expected] as BackupKeyIdentifier;
    if (actual.present !== expectedKey.present || actual.sha256 !== expectedKey.sha256) mismatches.push(file);
  }
  if (manifest.keys.passwordConfigured && process.env["ENCRYPTION_PASSWORD"] === undefined) {
    // The copied key file can still be sufficient, so this is advisory. A
    // failed decrypt check below remains fatal when encrypted records exist.
    return check(mismatches.length === 0 ? "warning" : "fail", "key-identifiers", mismatches.length === 0 ? "Key fingerprints match; ENCRYPTION_PASSWORD is not configured in this rehearsal process" : `${mismatches.length} key fingerprint(s) do not match`);
  }
  return mismatches.length === 0
    ? check("pass", "key-identifiers", "Key fingerprints match without exposing key values")
    : check("fail", "key-identifiers", `${mismatches.length} key fingerprint(s) do not match`);
}

async function decryptSelectedRecords(database: Readonly<Database>, storagePath: string, manifest: BackupManifest): Promise<BackupCheck> {
  const available = sqliteTableNames(database);
  const expectedCounts = manifest.encryptedRecords;
  const actualCounts = sqliteEncryptedRecordCounts(database);
  for (const [key, expected] of Object.entries(expectedCounts)) {
    if ((actualCounts[key] ?? 0) !== expected) return check("fail", "encrypted-records", `${key} count does not match the manifest`);
  }
  let selected = 0;
  try {
    for (const { table, column } of ENCRYPTED_COLUMN_CANDIDATES) {
      if (!available.has(table)) continue;
      const hasColumn = (database.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as readonly { name?: unknown }[]).some((row): boolean => row.name === column);
      if (!hasColumn) continue;
      const rows = database.query(`SELECT ${quoteIdentifier(column)} AS "value" FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} LIKE 'enc:v1:%' LIMIT ${String(MAX_ENCRYPTED_SAMPLES_PER_COLUMN)}`).all() as readonly { value?: unknown }[];
      for (const row of rows) {
        if (typeof row.value !== "string" || !isEncryptedSecret(row.value)) continue;
        decryptSecretSync(row.value, storagePath);
        selected += 1;
      }
    }
  } catch {
    return check("fail", "encrypted-records", "The backup key material could not decrypt a selected encrypted record");
  }
  return check("pass", "encrypted-records", selected === 0 ? "No encrypted records were present to sample" : `${selected} selected encrypted record(s) decrypted`);
}

async function verifySqliteDatabase(databasePath: string, storagePath: string, manifest: BackupManifest, decrypt: boolean): Promise<readonly BackupCheck[]> {
  const checks: BackupCheck[] = [];
  let database: Database | null = null;
  try {
    // Verification is always read-only, including decrypting selected rows.
    // `decrypt` controls checks, never database mutability.
    database = new Database(databasePath, { readonly: true });
    if (manifest.database.sha256 === null) {
      checks.push(check("fail", "database-digest", "The manifest does not contain a SQLite database digest"));
    } else {
      const digest = await sha256File(databasePath);
      checks.push(digest === manifest.database.sha256
        ? check("pass", "database-digest", "SQLite database digest matches the manifest")
        : check("fail", "database-digest", "SQLite database digest does not match the manifest"));
    }
    const quick = database.query("PRAGMA quick_check").get() as Record<string, unknown> | null;
    const quickRaw = quick === null ? undefined : Object.values(quick)[0];
    const quickValue = typeof quickRaw === "string" ? quickRaw : typeof quickRaw === "number" ? quickRaw.toString() : "";
    checks.push(quickValue === "ok" ? check("pass", "database-integrity", "SQLite quick_check passed") : check("fail", "database-integrity", "SQLite quick_check reported corruption"));
    const schemaDigest = await schemaDigestForSqlite(database);
    checks.push(schemaDigest === manifest.database.schemaSha256 ? check("pass", "schema", "Database schema digest matches the manifest") : check("fail", "schema", "Database schema digest does not match the manifest"));
    const actualCounts = sqliteTableCounts(database, manifest.database.tables);
    const countMismatch = Object.entries(manifest.database.tables).filter(([table, count]): boolean => actualCounts[table] !== count);
    checks.push(countMismatch.length === 0 ? check("pass", "table-counts", `${Object.keys(actualCounts).length} table count(s) match`) : check("fail", "table-counts", `${countMismatch.length} table count(s) do not match`));
    const actualEncrypted = sqliteEncryptedRecordCounts(database);
    const encryptedMismatch = Object.entries(manifest.encryptedRecords).filter(([key, count]): boolean => actualEncrypted[key] !== count);
    checks.push(encryptedMismatch.length === 0 ? check("pass", "encrypted-counts", "Encrypted-record counts match") : check("fail", "encrypted-counts", `${encryptedMismatch.length} encrypted-record count(s) do not match`));
    checks.push(await verifyArtifactReferences(database, storagePath, manifest));
    if (decrypt) checks.push(await decryptSelectedRecords(database, storagePath, manifest));
  } catch (error) {
    if (error instanceof BackupVerificationError) checks.push(check("fail", error.code, error.message));
    else checks.push(check("fail", "database-integrity", `Unable to inspect backup database: ${error instanceof Error ? error.message : String(error)}`));
  } finally {
    database?.close();
  }
  return checks;
}

async function verifyPrepared(prepared: PreparedSource, decrypt: boolean): Promise<BackupIntegrityReport> {
  const checks: BackupCheck[] = [];
  const manifest = prepared.manifest;
  if (manifest.database.driver !== "sqlite") {
    checks.push(check("warning", "database-driver", "PostgreSQL manifests require an operator-provided isolated PostgreSQL target for full rehearsal"));
    checks.push(prepared.databasePath === null ? check("fail", "database-input", "No isolated PostgreSQL database dump or target was supplied") : check("fail", "database-input", "This rehearsal endpoint accepts SQLite copies only; PostgreSQL restore must be provisioned separately"));
  } else if (prepared.databasePath === null) {
    checks.push(check("fail", "database-input", "Backup does not contain a SQLite database file"));
  } else {
    checks.push(...await verifySqliteDatabase(prepared.databasePath, prepared.storagePath, manifest, decrypt));
  }
  checks.push(await verifyStorageFiles(manifest, prepared.storagePath));
  checks.push(await checkKeyIdentifiers(prepared.storagePath, manifest));
  if (prepared.archivePath !== null) {
    try {
      const archiveDigest = await sha256File(prepared.archivePath);
      checks.push(check("pass", "archive", `Backup archive digest ${archiveDigest}`));
    } catch {
      checks.push(check("fail", "archive", "Backup archive could not be hashed"));
    }
  }
  const status = await readBackupStatus();
  return { passed: checks.every((item): boolean => item.status !== "fail"), manifest, checks, lastVerifiedRestoreAt: status.lastVerifiedRestoreAt };
}

export async function verifyBackupIntegrity(source: BackupSourceOptions): Promise<BackupIntegrityReport> {
  const prepared = await prepareSource(source);
  try {
    return await verifyPrepared(prepared, true);
  } finally {
    await prepared.cleanup();
  }
}

async function copyPreparedSource(prepared: PreparedSource): Promise<Readonly<{ root: string; storagePath: string; databasePath: string | null; cleanup: () => Promise<void> }>> {
  const destination = await mkdtemp(join(tmpdir(), "terrence-backup-rehearsal-"));
  try {
    await cp(prepared.root, destination, { recursive: true, force: true, preserveTimestamps: true });
    const storageRelative = relative(prepared.root, prepared.storagePath);
    const storageInsideSource = !storageRelative.startsWith("..") && !isAbsolute(storageRelative);
    const copiedStorage = storageInsideSource
      ? prepared.storagePath === prepared.root ? destination : join(destination, storageRelative)
      : join(destination, "storage");
    if (!storageInsideSource) await cp(prepared.storagePath, copiedStorage, { recursive: true, force: true, preserveTimestamps: true });
    const copiedDatabase = prepared.databasePath === null
      ? null
      : prepared.databasePath.startsWith(`${prepared.root}${sep}`) || prepared.databasePath === prepared.root
        ? join(destination, relative(prepared.root, prepared.databasePath))
        : join(destination, basename(prepared.databasePath));
    const sourceDatabase = prepared.databasePath;
    if (copiedDatabase !== null && !(await pathExists(copiedDatabase)) && sourceDatabase !== null) await cp(sourceDatabase, copiedDatabase, { force: true, preserveTimestamps: true });
    return {
      root: destination,
      storagePath: copiedStorage,
      databasePath: copiedDatabase,
      cleanup: async (): Promise<void> => { await rm(destination, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function runMigrationsOnCopy(databasePath: string): Promise<BackupCheck> {
  let database: Database | null = null;
  try {
    database = new Database(databasePath, { create: true });
    const migrationDb = drizzle(database, { schema });
    migrate(migrationDb, { migrationsFolder: join(import.meta.dir, "../../drizzle") });
    const quick = database.query("PRAGMA quick_check").get() as Record<string, unknown> | null;
    const quickRaw = Object.values(quick ?? {})[0];
    const quickValue = typeof quickRaw === "string" ? quickRaw : typeof quickRaw === "number" ? quickRaw.toString() : "";
    return quickValue === "ok"
      ? check("pass", "schema-migration", "Disposable restore copy accepted the bundled schema migrations")
      : check("fail", "schema-migration", "Disposable restore copy failed SQLite quick_check after migration");
  } catch (error) {
    return check("fail", "schema-migration", `Disposable restore copy could not apply the bundled schema: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    database?.close();
  }
}

async function runCliWorkflow(cliPath: string | undefined, requireCli: boolean, rehearsalRoot: string): Promise<BackupCheck> {
  const selected = cliPath ?? Bun.which("tofu") ?? Bun.which("terraform") ?? undefined;
  if (selected === undefined || selected === "") {
    return requireCli
      ? check("fail", "cli-workflow", "No tofu or terraform executable is available for the isolated workflow")
      : check("warning", "cli-workflow", "No tofu or terraform executable is configured; isolated database and artifact checks still completed");
  }
  const work = await mkdtemp(join(rehearsalRoot, "cli-"));
  try {
    await writeFile(join(work, "main.tf"), "terraform { required_version = \">= 0.0.0\" }\nvariable \"rehearsal_marker\" { type = string }\n", { mode: 0o600 });
    await runBoundedProcess([selected, "-chdir=" + work, "version"], {
      timeoutMs: 30_000,
      maxStdoutBytes: MAX_REHEARSAL_OUTPUT_BYTES,
      maxStderrBytes: MAX_REHEARSAL_OUTPUT_BYTES,
      env: { HOME: work, TF_DATA_DIR: join(work, ".terraform") },
    });
    return check("pass", "cli-workflow", "Isolated tofu/terraform version workflow completed");
  } catch (error) {
    return check("fail", "cli-workflow", `Isolated CLI workflow failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function runRestoreRehearsal(options: RestoreRehearsalOptions): Promise<BackupRehearsalReport> {
  const id = options.id ?? crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const prepared = await prepareSource(options.source);
  let copied: Readonly<{ root: string; storagePath: string; databasePath: string | null; cleanup: () => Promise<void> }> | null = null;
  try {
    copied = await copyPreparedSource(prepared);
    const report = await verifyPrepared({ ...prepared, root: copied.root, storagePath: copied.storagePath, databasePath: copied.databasePath, cleanup: copied.cleanup }, true);
    const checks: BackupCheck[] = [...report.checks];
    if (copied.databasePath !== null && prepared.manifest.database.driver === "sqlite") {
      checks.push(await runMigrationsOnCopy(copied.databasePath));
    }
    checks.push(await runCliWorkflow(options.cliPath, options.requireCli === true, copied.root));
    const passed = checks.every((item): boolean => item.status !== "fail");
    let lastVerifiedRestoreAt = report.lastVerifiedRestoreAt;
    if (passed) {
      const status = await recordSuccessfulRestore(defaultStoragePath(), prepared.manifest, id);
      lastVerifiedRestoreAt = status.lastVerifiedRestoreAt;
    }
    return { id, passed, startedAt, finishedAt: new Date().toISOString(), checks, lastVerifiedRestoreAt };
  } finally {
    if (copied !== null) await copied.cleanup();
    await prepared.cleanup();
  }
}
