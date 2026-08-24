import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { checkpointWal } from "../../src/db";

const SCRIPT = join(import.meta.dir, "../../scripts/db-check.ts");

type RunResult = {
    status: number;
    stdout: string;
    stderr: string;
}

function runCheck(dbUrl: string, ...args: string[]): RunResult {
    const result = spawnSync("bun", ["run", SCRIPT, ...args], {
        env: { ...process.env, DATABASE_URL: dbUrl },
        encoding: "utf8",
        timeout: 30_000,
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const tempDirs: string[] = [];

function tempDb(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "terrence-db-check-"));
    tempDirs.push(dir);
    return join(dir, name);
}

function createDb(dbPath: string): void {
    const engine = new Database(dbPath, { create: true });
    engine.run("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");
    engine.close();
}

afterAll((): void => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("db-check script (kanban 4.5 / 4.17)", () => {
    test("fresh database passes quick_check", () => {
        const dbPath = tempDb("ok.sqlite");
        createDb(dbPath);
        const { status, stdout } = runCheck(`file:${dbPath}`, "--json");
        expect(status).toBe(0);
        const parsed = JSON.parse(stdout) as { mode: string; result: string; detail: string[] };
        expect(parsed.mode).toBe("quick_check");
        expect(parsed.result).toBe("ok");
        expect(parsed.detail).toEqual(["ok"]);
    });

    test("missing database file exits non-zero without --checkpoint", () => {
        const dbPath = tempDb("missing.sqlite");
        const { status, stderr, stdout } = runCheck(`file:${dbPath}`, "--json");
        expect(status).not.toBe(0);
        expect(stdout).toContain("does not exist");
        expect(stderr).toBe("");
    });

    test("--full runs the deeper integrity_check", () => {
        const dbPath = tempDb("full.sqlite");
        createDb(dbPath);
        const { status, stdout } = runCheck(`file:${dbPath}`, "--full", "--json");
        expect(status).toBe(0);
        const parsed = JSON.parse(stdout) as { mode: string; result: string };
        expect(parsed.mode).toBe("integrity_check");
        expect(parsed.result).toBe("ok");
    });

    test("json output carries wal stats and db size", () => {
        const dbPath = tempDb("stats.sqlite");
        createDb(dbPath);
        const { status, stdout } = runCheck(`file:${dbPath}`, "--json");
        expect(status).toBe(0);
        const parsed = JSON.parse(stdout) as { wal: { busy: number; log: number; checkpointed: number; walSizeBytes: number | null }; dbSizeBytes: number | null };
        expect(parsed.dbSizeBytes).toBeGreaterThanOrEqual(0);
        expect(typeof parsed.wal.busy).toBe("number");
        expect(typeof parsed.wal.walSizeBytes).toBe("number");
    });

    test("--checkpoint with --json reports TRUNCATE mode", () => {
        const dbPath = tempDb("cp.sqlite");
        createDb(dbPath);
        const { status, stdout } = runCheck(`file:${dbPath}`, "--checkpoint", "--json");
        expect(status).toBe(0);
        const parsed = JSON.parse(stdout) as { wal: { checkpoint: string } };
        expect(parsed.wal.checkpoint).toBe("TRUNCATE");
    });

    test("corrupt database file exits non-zero", () => {
        const dbPath = tempDb("corrupt.sqlite");
        writeFileSync(dbPath, "x".repeat(4096));
        const { status } = runCheck(`file:${dbPath}`, "--json");
        expect(status).not.toBe(0);
    });
});

describe("checkpointWal (kanban 4.17)", () => {
    test("does not throw against the live test database", () => {
        expect((): void => { checkpointWal(); }).not.toThrow();
    });
});