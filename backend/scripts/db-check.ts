/**
 * db-check.ts — SQLite integrity diagnostics (kanban 4.5, 4.17).
 *
 * Runs PRAGMA quick_check by default (routine) or the deeper, slower
 * integrity_check with --full (maintenance). With --checkpoint the WAL is
 * truncated first, which also serves the 4.17 "appropriate checkpointing"
 * goal for backups taken around maintenance windows.
 *
 * Usage:
 *   bun run backend/scripts/db-check.ts
 *   bun run backend/scripts/db-check.ts --full       # deep integrity_check
 *   bun run backend/scripts/db-check.ts --checkpoint # wal_checkpoint(TRUNCATE) first
 *   bun run backend/scripts/db-check.ts --json       # machine-readable output
 *   bun run backend/scripts/db-check.ts --fail       # exit 1 on any finding
 *
 * Honors DATABASE_URL the same way src/db/index.ts does (default
 * file:<backend>/storage/terrence.db). The database is opened read-only so
 * a routine check can never mutate the live DB — only --checkpoint writes.
 */
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const args = new Set(process.argv.slice(2));
const full = args.has("--full");
const checkpoint = args.has("--checkpoint");
const asJson = args.has("--json");
const failOnFinding = args.has("--fail");

const storageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../storage"));
const dbUrl = process.env.DATABASE_URL ?? `file:${join(storageDir, "terrence.db")}`;
const dbPath = dbUrl === ":memory:" ? ":memory:" : dbUrl.replace(/^file:/, "");

interface CheckResult {
    database: string;
    mode: "quick_check" | "integrity_check";
    result: "ok" | "error";
    detail: string[];
    wal: Readonly<{ checkpoint: "NOOP" | "PASSIVE" | "TRUNCATE"; busy: number; log: number; checkpointed: number; walSizeBytes: number | null }>;
    dbSizeBytes: number | null;
}

function walStats(engine: Database, mode: "NOOP" | "PASSIVE" | "TRUNCATE"): CheckResult["wal"] {
    let busy = -1;
    let log = -1;
    let checkpointed = -1;
    try {
        const row = engine.query(`PRAGMA wal_checkpoint(${mode})`).get() as { busy: number; log: number; checkpointed: number } | null;
        if (row !== null && row !== undefined) {
            busy = row.busy;
            log = row.log;
            checkpointed = row.checkpointed;
        }
    } catch {
        // :memory: or non-WAL databases report "not in WAL mode"; stats stay -1.
    }
    let walSizeBytes: number | null = null;
    if (dbPath !== ":memory:") {
        try {
            walSizeBytes = statSync(`${dbPath}-wal`).size;
        } catch {
            walSizeBytes = 0;
        }
    }
    return { checkpoint: mode, busy, log, checkpointed, walSizeBytes };
}

function fileSize(): number | null {
    if (dbPath === ":memory:") return null;
    try {
        return statSync(dbPath).size;
    } catch {
        return null;
    }
}

function run(): void {
    if (!existsSync(dbPath)) {
        throw new Error(`database file does not exist: ${dbPath}`);
    }
    const engine = checkpoint
        ? new Database(dbPath)
        : new Database(dbPath, { readonly: true });
    // With --checkpoint the WAL is truncated immediately after opening the
    // writable connection, BEFORE any integrity pragma, so quick_check /
    // integrity_check run against the fully-checkpointed main DB file.
    let checkpointBusy = 0;
    if (checkpoint) {
        try {
            const row = engine.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | null;
            checkpointBusy = row !== null && row !== undefined ? row.busy : 0;
        } catch {
            // Non-WAL database: nothing to checkpoint.
        }
    }
    const pragma = full ? "integrity_check" : "quick_check";
    const rows = engine.query(`PRAGMA ${pragma}`).all() as ({ quick_check?: string; integrity_check?: string } | Record<string, unknown>)[];
    const detail = rows.map((row): string => {
        const value = "quick_check" in row ? String(row.quick_check) : "integrity_check" in row ? String(row.integrity_check) : String(Object.values(row)[0] ?? "");
        return value;
    });
    const baseOk = detail.length > 0 && detail.every((value): boolean => value === "ok");
    // Statistics use the non-mutating NOOP mode so a routine (non --checkpoint)
    // run never writes to the database, exactly as the read-only open promises.
    const wal = walStats(engine, "NOOP");
    // A checkpoint that could not flush everything (busy count > 0) means the
    // DB file is not complete; report it as a failure instead of claiming OK.
    const busy = checkpoint && checkpointBusy > 0 ? checkpointBusy : 0;
    const ok = baseOk && busy === 0;
    const result: CheckResult = {
        database: dbPath,
        mode: full ? "integrity_check" : "quick_check",
        result: ok ? "ok" : "error",
        detail: busy > 0 ? [...detail, `wal_checkpoint busy: ${busy} frames could not be flushed`] : detail,
        wal: { ...wal, checkpoint: checkpoint ? "TRUNCATE" : "NOOP" },
        dbSizeBytes: fileSize(),
    };
    engine.close();
    if (asJson) {
        console.log(JSON.stringify(result, null, 2));
    } else if (ok) {
        console.log(`db-check: ${result.mode} OK (${dbPath}, ${result.dbSizeBytes ?? -1} bytes, wal ${result.wal.walSizeBytes ?? -1} bytes)`);
    } else {
        for (const line of detail) console.error(`db-check: ${line}`);
    }
    if (!ok || (failOnFinding && detail.length === 0)) process.exitCode = 1;
}

try {
    run();
} catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (asJson) {
        console.log(JSON.stringify({ database: dbPath, mode: full ? "integrity_check" : "quick_check", result: "error", detail: [message], wal: { checkpoint: checkpoint ? "TRUNCATE" : "PASSIVE", busy: -1, log: -1, checkpointed: -1, walSizeBytes: null }, dbSizeBytes: fileSize() }, null, 2));
    } else {
        console.error(`db-check: ${message}`);
    }
    process.exitCode = 1;
}