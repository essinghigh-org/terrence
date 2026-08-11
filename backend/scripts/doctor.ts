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
import { join, resolve } from "node:path";
import { platform, release, arch } from "node:os";
import { promises as dns } from "node:dns";
import { request } from "node:https";
import { probeLandlockAbi, runSandboxRequired } from "../src/lib/sandbox";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const failOnFinding = args.has("--fail");

type Status = "ok" | "warn" | "fail";

interface Check {
    name: string;
    status: Status;
    detail: string;
}

const checks: Check[] = [];

function record(name: string, status: Status, detail: string): void {
    checks.push({ name, status, detail });
}

const storageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../storage"));
const dbUrl = process.env.DATABASE_URL ?? `file:${join(storageDir, "terrence.db")}`;
const dbPath = dbUrl === ":memory:" ? ":memory:" : dbUrl.replace(/^file:/, "");

/** Check storage: exists, writable, free/total bytes via statfs when the runtime supports it. */
function checkStorage(): void {
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

function checkDatabase(): void {
    if (dbPath === ":memory:") {
        record("database", "warn", "DATABASE_URL is :memory: — data is lost on restart (dev-only configuration)");
        return;
    }
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

async function checkDns(host: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            dns.resolve4(host),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("timeout")), 5000);
            }),
        ]);
        record(`dns:${host}`, "ok", `resolves to ${(result as string[]).join(", ")}`);
    } catch {
        record(`dns:${host}`, "fail", "could not resolve (network or DNS failure)");
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** HTTPS GET to the VCS API: proves DNS + CA trust + TLS + reachability end to end. */
function checkVcsReachability(): Promise<void> {
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
    const known: Array<[string, "required" | "optional"]> = [
        ["PORT", "optional"],
        ["STORAGE_DIR", "optional"],
        ["DATABASE_URL", "optional"],
        ["ADMIN_PASSWORD", "required"],
        ["TERRENCE_ENABLE_LOCAL_SIGNUP", "optional"],
        ["GITHUB_APP_ID", "optional"],
        ["TERRENCE_DISABLE_WORKER", "optional"],
        ["AUDIT_STRICT", "optional"],
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
    const disabled = process.env.TERRENCE_DISABLE_WORKER === "1";
    record(
        "worker",
        disabled ? "warn" : "ok",
        disabled ? "drain mode (TERRENCE_DISABLE_WORKER=1) — no runs will execute" : "enabled",
    );
}

function printHuman(): void {
    console.log(`Terrence doctor — ${new Date().toISOString()}`);
    console.log(`storage dir: ${storageDir}`);
    console.log(`database:    ${dbPath}`);
    console.log("");
    const maxNameWidth = checks.reduce((acc, c) => Math.max(acc, c.name.length), 0);
    for (const c of checks) {
        const label = c.name.padEnd(maxNameWidth);
        console.log(`  [${c.status === "ok" ? "ok" : c.status === "warn" ? "warn" : "FAIL"}] ${label}  ${c.detail}`);
    }
    const fails = checks.filter((c) => c.status === "fail").length;
    const warns = checks.filter((c) => c.status === "warn").length;
    console.log("");
    console.log(`${checks.length - fails - warns} ok, ${warns} warnings, ${fails} failed`);
}

function printJson(): void {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), checks }, null, 2));
}

async function main(): Promise<void> {
    checkKernel();
    checkStorage();
    checkDatabase();
    checkWorker();
    checkConfig();
    checkSandbox();
    await checkDns("github.com");
    await checkDns("releases.hashicorp.com");
    await checkVcsReachability();

    if (asJson) {
        printJson();
    } else {
        printHuman();
    }
    // --fail is opt-in: without it, doctor only reports and always exits 0.
    if (failOnFinding && checks.some((c) => c.status === "fail")) process.exit(1);
    process.exit(0);
}

void main();
