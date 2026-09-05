/**
 * doctor.ts — self-host diagnostics (kanban 12.14).
 *
 * One-shot health sweep for a Terrence deployment: kernel/sandbox support,
 * storage, SQLite integrity, DNS, VCS/CA reachability, and config presence.
 * Values are never printed for secrets — only whether each known config
 * variable is set.
 *
 * Usage:
 *   bun run backend/scripts/doctor.ts
 *   bun run backend/scripts/doctor.ts --json   # machine-readable output
 *   bun run backend/scripts/doctor.ts --fail   # exit 1 when any check fails
 *
 * Exit codes: 0 = all checks pass, 1 = at least one check failed (or a
 * check could not be completed). Warnings do not change the exit code.
 */
import { Database } from "bun:sqlite";
import { existsSync, statSync, statfsSync, accessSync, constants } from "node:fs";
import { request } from "node:https";
import { connect } from "node:net";
import { platform, release, arch } from "node:os";
import { promises as dns } from "node:dns";
import { probeLandlockAbi, runSandboxRequired } from "../src/lib/sandbox";
// Issue #593: boolean flags and storage paths share the app's helpers
// instead of duplicating them. (The database target is resolved dynamically
// in main() so a broken DATABASE_URL becomes a clean config finding instead
// of an import-time crash — importing the driver module runs its resolver.)
import { envEnabled } from "../src/lib/env";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const failOnFinding = args.has("--fail");

type Status = "ok" | "warn" | "fail";

type Check = {
    name: string;
    status: Status;
    detail: string;
}

const checks: Check[] = [];

function record(name: string, status: Status, detail: string): void {
    checks.push({ name, status, detail });
}

type DatabaseTarget =
    | Readonly<{ kind: "sqlite-file"; dbPath: string }>
    | Readonly<{ kind: "memory" }>
    | Readonly<{ kind: "postgres"; host: string; port: number }>
    | Readonly<{ kind: "broken"; message: string }>;

/** Resolve storage and database targets through the app's own driver module. */
async function resolveTargets(): Promise<{ storageDir: string; db: DatabaseTarget }> {
    try {
        const driver = await import("../src/db/driver");
        const url = driver.databaseUrl;
        const storageDir: string = driver.storageDir;
        if (driver.isPostgres) {
            const parsed = new URL(url);
            const port = parsed.port === "" ? 5432 : Number(parsed.port);
            return { storageDir, db: { kind: "postgres", host: parsed.hostname, port } };
        }
        if (url === ":memory:") return { storageDir, db: { kind: "memory" } };
        return { storageDir, db: { kind: "sqlite-file", dbPath: url.replace(/^file:/, "") } };
    } catch (error) {
        const { resolve, join } = await import("node:path");
        return {
            storageDir: resolve(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../storage")),
            db: { kind: "broken", message: error instanceof Error ? error.message : String(error) },
        };
    }
}

/** Check storage: exists, writable, free/total bytes via statfs when the runtime supports it. */
function checkStorage(storageDir: string): void {
    if (!existsSync(storageDir)) {
        record("storage", "fail", `STORAGE_DIR does not exist: ${storageDir}`);
        return;
    }
    let writable = false;
    try {
        accessSync(storageDir, constants.W_OK);
        writable = true;
    } catch {
        // fall through
    }
    if (!writable) {
        record("storage", "fail", `${storageDir} exists but is not writable by this process`);
        return;
    }
    let detail = `${storageDir} (writable)`;
    try {
        const st = statfsSync(storageDir);
        detail += `, ${(st.bavail * st.bsize / 1024 / 1024 / 1024).toFixed(1)} GiB free of ${(st.blocks * st.bsize / 1024 / 1024 / 1024).toFixed(1)} GiB`;
    } catch {
        // statfs unsupported in this runtime — writability check already passed
    }
    record("storage", "ok", detail);
}

async function checkDatabase(db: DatabaseTarget): Promise<void> {
    if (db.kind === "broken") {
        record("database", "fail", `database configuration is invalid: ${db.message}`);
        return;
    }
    if (db.kind === "memory") {
        record("database", "warn", "DATABASE_URL is :memory: — data is lost on restart (dev-only configuration)");
        return;
    }
    if (db.kind === "postgres") {
        await checkPostgres(db.host, db.port);
        return;
    }
    const dbPath = db.dbPath;
    if (!existsSync(dbPath)) {
        record("database", "fail", `database file does not exist: ${dbPath}`);
        return;
    }
    try {
        const engine = new Database(dbPath, { readonly: true });
        const rows = engine.query("PRAGMA quick_check").all() as Record<string, unknown>[];
        const value = rows.length > 0 ? String(Object.values(rows[0])[0] ?? "") : "no rows";
        engine.close();
        if (value === "ok") {
            let detail = `quick_check ok (${dbPath})`;
            try {
                const st = statSync(dbPath);
                detail += `, ${(st.size / 1024 / 1024).toFixed(1)} MiB`;
                const wal = statSync(`${dbPath}-wal`);
                detail += `, WAL ${(wal.size / 1024 / 1024).toFixed(2)} MiB`;
            } catch {
                // size/WAL informational
            }
            record("database", "ok", detail);
        } else {
            record("database", "fail", `quick_check: ${value}`);
        }
    } catch (error) {
        record("database", "fail", `could not open database: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** TCP reachability for PostgreSQL backends (issue #593): previously any
 * non-sqlite DATABASE_URL failed the file-existence check, so every
 * Postgres instance misreported as FAIL. */
function checkPostgres(host: string, port: number): Promise<void> {
    return new Promise((resolvePromise) => {
        const target = host === "" ? "localhost" : host;
        let settled = false;
        const socket = connect(port, target);
        const done = (status: Status, detail: string): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            record("database", status, detail);
            resolvePromise();
        };
        const timer = setTimeout((): void => {
            done("fail", `PostgreSQL at ${target}:${port} did not accept a connection within 5s`);
        }, 5000);
        socket.on("connect", (): void => {
            done("ok", `PostgreSQL reachable at ${target}:${port} (TCP handshake ok; authentication not attempted)`);
        });
        socket.on("error", (error: Error): void => {
            done("fail", `PostgreSQL at ${target}:${port} unreachable: ${error.message}`);
        });
    });
}

/** Admin bootstrap (issue #593): ADMIN_PASSWORD is consumed (deleted) at
 * first boot, so requiring it flagged every correct post-boot instance.
 * Instead: set is fine, otherwise the sqlite users table proves bootstrap
 * completed; PostgreSQL cannot be inspected from here and stays a warning.
 */
function checkAdminBootstrap(db: DatabaseTarget): void {
    const password = process.env["ADMIN_PASSWORD"];
    if (typeof password === "string" && password !== "") {
        record("admin-bootstrap", "ok", "ADMIN_PASSWORD is set (consumed into the admin account at first boot)");
        return;
    }
    if (db.kind !== "sqlite-file") {
        record("admin-bootstrap", "warn", "ADMIN_PASSWORD is unset and the admin account cannot be verified on a non-sqlite database from here");
        return;
    }
    try {
        const engine = new Database(db.dbPath, { readonly: true });
        const rows = engine.query("SELECT COUNT(*) AS total FROM users").all() as { total: number }[];
        engine.close();
        const total = rows.length > 0 ? Number(rows[0]?.total ?? 0) : 0;
        if (total > 0) {
            record("admin-bootstrap", "ok", `${total} local user(s) present; bootstrap complete (ADMIN_PASSWORD unset, as expected after first boot)`);
        } else {
            record("admin-bootstrap", "warn", "no local users yet; set ADMIN_PASSWORD or enable local signup to bootstrap an admin");
        }
    } catch {
        record("admin-bootstrap", "warn", "ADMIN_PASSWORD is unset and the users table could not be read (fresh install or unreadable database)");
    }
}

async function checkDns(host: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            dns.resolve4(host),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => { reject(new Error("timeout")); }, 5000);
            }),
        ]);
        record(`dns:${host}`, "ok", `resolves to ${(result).join(", ")}`);
    } catch {
        record(`dns:${host}`, "fail", "could not resolve (network or DNS failure)");
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** HTTPS GET to the VCS API: proves DNS + CA trust + TLS + reachability end to end. */
async function checkVcsReachability(): Promise<void> {
    return new Promise((resolvePromise) => {
        const url = new URL("https://api.github.com/");
        const req = request(
            url,
            { method: "GET", headers: { "User-Agent": "terrence-doctor" }, timeout: 10_000 },
            (res) => {
                res.resume();
                const status = res.statusCode ?? 0;
                if (status >= 200 && status < 500) {
                    // 4xx (e.g. 401 without auth) still proves the TLS+network path works.
                    record("vcs-reachability", "ok", `api.github.com answered HTTP ${status} (TLS + CA trust + DNS ok)`);
                } else {
                    record("vcs-reachability", "fail", `api.github.com answered HTTP ${status}`);
                }
                resolvePromise();
            },
        );
        req.on("timeout", () => {
            req.destroy(new Error("timeout"));
        });
        req.on("error", (error: Error) => {
            const message = error.message;
            if (message.includes("certificate") || message.includes("CERT_")) {
                record("vcs-reachability", "fail", `TLS/CA trust failure: ${message}`);
            } else if (message.includes("ENOTFOUND") || message.includes("EAI_AGAIN")) {
                record("vcs-reachability", "fail", `DNS failure: ${message}`);
            } else if (message.includes("ECONNREFUSED") || message.includes("ETIMEDOUT")) {
                record("vcs-reachability", "fail", `connection failure: ${message}`);
            } else {
                record("vcs-reachability", "fail", `request failed: ${message}`);
            }
            resolvePromise();
        });
        req.end();
    });
}

function checkSandbox(): void {
    const abi = probeLandlockAbi();
    const required = runSandboxRequired();
    if (!required) {
        record("sandbox", "warn", "disabled via TERRENCE_DISABLE_SANDBOX (runs are unsandboxed)");
        return;
    }
    if (abi >= 1) {
        record("sandbox", "ok", `Landlock ABI v${abi} available`);
        return;
    }
    const runner = process.env.TERRENCE_LANDLOCK_RUNNER;
    record(
        "sandbox",
        "fail",
        runner !== undefined && runner !== ""
            ? `Landlock unavailable (ABI 0) and TERRENCE_LANDLOCK_RUNNER=${runner} — runs will fail to start`
            : "Landlock unavailable (ABI 0, kernel < 5.13 or CONFIG_SECURITY_LANDLOCK missing) — runs will fail to start",
    );
}

function checkConfig(): void {
    const known: [string, "required" | "optional"][] = [
        ["PORT", "optional"],
        ["STORAGE_DIR", "optional"],
        ["DATABASE_URL", "optional"],
        // Issue #593: ADMIN_PASSWORD is consumed at first boot, so it must
        // not be required here — the admin-bootstrap check verifies the
        // resulting admin account instead.
        ["ADMIN_PASSWORD", "optional"],
        ["TERRENCE_ENABLE_LOCAL_SIGNUP", "optional"],
        ["GITHUB_APP_ID", "optional"],
        ["TERRENCE_DISABLE_WORKER", "optional"],
        ["AUDIT_STRICT", "optional"],
        ["TERRENCE_TOKEN_HASH_SECRET", "optional"],
        ["TERRENCE_LANDLOCK_RUNNER", "optional"],
    ];
    const set = (name: string): boolean => {
        const v = process.env[name];
        return typeof v === "string" && v !== "";
    };
    for (const [name, kind] of known) {
        const present = set(name);
        if (kind === "required" && !present) {
            record(`config:${name}`, "fail", "not set — admin bootstrap will not work");
        } else {
            record(`config:${name}`, present ? "ok" : "warn", present ? "set" : "unset (defaults apply)");
        }
    }
}

function checkKernel(): void {
    const abi = probeLandlockAbi();
    record("kernel", "ok", `${platform()} ${release()} (${arch()}), Landlock ABI v${abi}`);
}

function checkWorker(): void {
    // Issue #593: TERRENCE_DISABLE_WORKER accepts "1" or "true" everywhere
    // (shared envEnabled helper); the old === "1" test reported drain-mode
    // instances with =true as healthy and enabled.
    const disabled = envEnabled(process.env["TERRENCE_DISABLE_WORKER"]);
    record(
        "worker",
        disabled ? "warn" : "ok",
        disabled ? "drain mode (TERRENCE_DISABLE_WORKER is set) — no runs will execute" : "enabled",
    );
}

function printHuman(storageDir: string, db: DatabaseTarget): void {
    console.log(`Terrence doctor — ${new Date().toISOString()}`);
    console.log(`storage dir: ${storageDir}`);
    console.log(`database:    ${describeDatabaseTarget(db)}`);
    console.log("");
    const maxNameWidth = checks.reduce((acc, c) => Math.max(acc, c.name.length), 0);
    for (const c of checks) {
        const label = c.name.padEnd(maxNameWidth);
        // Strip control characters and neutralise any leading markup so a
        // detail string (which may carry subprocess stderr or DB errors)
        // cannot forge log lines or inject terminal escape sequences.
        const cleanDetail = c.detail
            .replace(/[\r\n]/g, " ")
            .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
            .replace(/^</, "\\<");
        console.log(`  [${c.status === "ok" ? "ok" : c.status === "warn" ? "warn" : "FAIL"}] ${label}  ${cleanDetail}`);
    }
    const fails = checks.filter((c) => c.status === "fail").length;
    const warns = checks.filter((c) => c.status === "warn").length;
    console.log("");
    console.log(`${checks.length - fails - warns} ok, ${warns} warnings, ${fails} failed`);
}

function printJson(): void {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), checks }, null, 2));
}

function describeDatabaseTarget(db: DatabaseTarget): string {
    if (db.kind === "sqlite-file") return db.dbPath;
    if (db.kind === "postgres") return `postgres://${db.host}:${db.port} (credentials redacted)`;
    if (db.kind === "memory") return ":memory:";
    return `(unresolvable: ${db.message})`;
}

async function main(): Promise<void> {
    const { storageDir, db } = await resolveTargets();
    checkKernel();
    checkStorage(storageDir);
    await checkDatabase(db);
    checkAdminBootstrap(db);
    checkWorker();
    checkConfig();
    checkSandbox();
    await checkDns("github.com");
    await checkDns("releases.hashicorp.com");
    await checkVcsReachability();

    if (asJson) {
        printJson();
    } else {
        printHuman(storageDir, db);
    }
    // --fail is opt-in: without it, doctor only reports and always exits 0.
    if (failOnFinding && checks.some((c) => c.status === "fail")) process.exit(1);
    process.exit(0);
}

void main();
