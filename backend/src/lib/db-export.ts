// ---------------------------------------------------------------------------
// Postgres -> SQLite export orchestration (kanban task 4/4).
//
// Explicit conversion path: produce a self-contained SQLite database a fresh
// Terrence instance can boot against (full migration schema, WAL folded back
// into the main file, FK enforcement restored). This is NOT a substitute for
// the backup semantics of kanban 4.6/4.7/4.8 — it converts the database
// contents only; storage artifacts (state archives, run logs, binaries) are
// not part of the output and must be moved separately.
//
// Guard rails mirror the forward migration wizard:
//   - the source database is never written (read-only snapshot),
//   - the export refuses to run while runs are active in the source unless
//     the admin explicitly forces it,
//   - a failed export removes its partial output file,
//   - verification is identical to the forward path: row counts, unique
//     invariants, PRAGMA foreign_key_check, critical sample hashes.
// ---------------------------------------------------------------------------
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPgSource, createSqliteTarget, transferDatabase, verifyTransfer } from "./db-transfer";
import type { TransferSource } from "./db-transfer";
import type { TransferReport, VerificationReport } from "./db-transfer";

const storageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"));

/** Terminal run statuses (mirrors the run-duration baseline in routes/runs.ts). */
export const TERMINAL_RUN_STATUSES: readonly string[] = [
  "applied",
  "planned_and_finished",
  "planned_and_saved",
  "errored",
  "failed",
  "canceled",
];

export function exportsDirectory(storage: string = storageDir): string {
  const dir = join(storage, "exports");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Sanitize a user-supplied output file name: only a bare file name may be
 * used (no directories, no traversal), and it must end in .db.
 */
export function sanitizeOutputName(raw: string): string {
  const base = raw.trim().replace(/\\/g, "/").split("/").pop() ?? "";
  if (!/^[A-Za-z0-9._-]+$/.test(base)) {
    throw new Error("Output file name may only contain letters, digits, dots, dashes and underscores");
  }
  if (!base.toLowerCase().endsWith(".db")) {
    throw new Error("Output file name must end in .db");
  }
  return base;
}

export function defaultOutputName(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `terrence-export-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}.db`;
}

export interface ExportFileInfo {
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAt: number;
}

/** List completed export files, newest first. */
export function listExportFiles(storage: string = storageDir): ExportFileInfo[] {
  const dir = exportsDirectory(storage);
  const out: ExportFileInfo[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith(".db")) continue;
    const full = join(dir, name);
    try {
      const stat = statSync(full);
      if (stat.isFile()) out.push({ name, sizeBytes: stat.size, modifiedAt: stat.mtimeMs });
    } catch {
      // vanished between readdir and stat; skip
    }
  }
  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}

/** Resolve a file name inside the exports directory (traversal-safe). */
export function exportFilePath(name: string, storage: string = storageDir): string {
  const safe = sanitizeOutputName(name);
  return join(exportsDirectory(storage), safe);
}

/** Delete an export file. Returns false when it did not exist. */
export function deleteExportFile(name: string, storage: string = storageDir): boolean {
  const full = exportFilePath(name, storage);
  try {
    rmSync(full, { force: false });
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export class DbExportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DbExportError";
    this.code = code;
  }
}

export interface DbExportOptions {
  /** postgres:// or postgresql:// connection URL of the source. */
  readonly pgUrl: string;
  /** Optional output file name (defaults to a timestamped name). */
  readonly outputName?: string;
  /** Bypass the active-runs guard (may capture a mid-flight snapshot). */
  readonly force?: boolean;
  /** Test hook / forward-wizard reuse: override the source construction. */
  readonly sourceFactory?: (url: string) => TransferSource;
  readonly storageDirOverride?: string;
}

export interface DbExportProgress {
  readonly table: string;
  readonly rowsCopied: number;
}

export interface DbExportResult {
  readonly fileName: string;
  readonly filePath: string;
  readonly sizeBytes: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly activeRuns: number;
  readonly transfer: TransferReport;
  readonly verification: VerificationReport;
}

/**
 * Run one Postgres -> SQLite export. Throws DbExportError for expected
 * failures (bad URL, active runs without force, schema mismatch); any other
 * error is a real failure and the partial output file is removed.
 */
export async function runDbExport(
  options: DbExportOptions,
  onProgress?: (progress: DbExportProgress) => void,
): Promise<DbExportResult> {
  const url = options.pgUrl.trim();
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new DbExportError("invalid-url", "Source URL must be a postgres:// or postgresql:// connection URL");
  }
  const sourceFactory = options.sourceFactory ?? createPgSource;
  const storage = options.storageDirOverride ?? storageDir;
  const fileName = options.outputName !== undefined ? sanitizeOutputName(options.outputName) : defaultOutputName();
  const filePath = join(exportsDirectory(storage), fileName);
  if (listExportFiles(storage).some((f) => f.name === fileName)) {
    throw new DbExportError("exists", `An export file named "${fileName}" already exists; choose a different name`);
  }

  const source = sourceFactory(url);
  const startedAt = Date.now();
  let target: ReturnType<typeof createSqliteTarget> | null = null;
  try {
    await source.ping();

    // Drain-mode guard rail: refuse while runs are active in the source
    // database (the source is a live deployment being converted). The admin
    // can force an export; the read-only snapshot still makes it consistent.
    const placeholders = TERMINAL_RUN_STATUSES.map(() => "?").join(",");
    const activeRuns = await source.countWhere(
      "runs",
      `status NOT IN (${placeholders})`,
      TERMINAL_RUN_STATUSES,
    );
    if (activeRuns > 0 && options.force !== true) {
      throw new DbExportError(
        "active-runs",
        `${activeRuns} run(s) are still active in the source database; wait for them to finish or force the export`,
      );
    }

    target = createSqliteTarget(filePath);
    const transfer = await transferDatabase(
      source,
      target,
      onProgress === undefined ? {} : { onProgress: (progress) => onProgress(progress) },
    );
    const verification = await verifyTransfer(source, target);
    await target.finishAndClose();
    target = null;

    const sizeBytes = statSync(filePath).size;
    const finishedAt = Date.now();
    return {
      fileName,
      filePath,
      sizeBytes,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      activeRuns,
      transfer,
      verification,
    };
  } catch (error) {
    // A failed export must not leave a partial database behind.
    try {
      if (target !== null) await target.finishAndClose();
    } catch {
      // best-effort close of the failed target
    }
    try {
      rmSync(filePath, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}
