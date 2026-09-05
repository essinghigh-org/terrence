import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

const SCRIPT = join(import.meta.dir, "../../scripts/doctor.ts");

type DoctorCheck = {
    name: string;
    status: "ok" | "warn" | "fail";
    detail: string;
};

function runDoctor(env: Record<string, string | undefined>, ...args: string[]): { status: number; checks: DoctorCheck[] } {
    const overrides = new Map(Object.entries(env));
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (overrides.has(key) && overrides.get(key) === undefined) continue;
        childEnv[key] = value;
    }
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) childEnv[key] = value;
    }
    const result = spawnSync("bun", ["run", SCRIPT, "--json", ...args], {
        env: childEnv,
        encoding: "utf8",
        timeout: 60_000,
    });
    if (result.status === null) throw new Error(`doctor timed out or failed to spawn: ${result.error}`);
    return { status: result.status ?? -1, checks: (JSON.parse(result.stdout) as { checks: DoctorCheck[] }).checks };
}

function checkFor(checks: DoctorCheck[], name: string): DoctorCheck {
    const found = checks.find((c) => c.name === name);
    if (found === undefined) throw new Error(`missing check ${name}`);
    return found;
}

const tempDirs: string[] = [];

function freshStorage(): { dir: string; dbPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "terrence-doctor-"));
    tempDirs.push(dir);
    return { dir, dbPath: join(dir, "terrence.db") };
}

function baseEnv(dir: string, dbPath: string): Record<string, string | undefined> {
    return {
        STORAGE_DIR: dir,
        DATABASE_URL: `file:${dbPath}`,
        ADMIN_PASSWORD: undefined,
        TERRENCE_DISABLE_WORKER: undefined,
    };
}

function createUsersDb(dbPath: string, usernames: string[]): void {
    const engine = new Database(dbPath, { create: true });
    engine.run("CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT)");
    for (const [i, username] of usernames.entries()) {
        engine.run("INSERT INTO users VALUES (?, ?)", [`u${i}`, username]);
    }
    engine.close();
}

afterAll((): void => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("doctor self-diagnostics (issue #593)", () => {
    test("a bootstrapped instance without ADMIN_PASSWORD is not a failure", () => {
        const { dir, dbPath } = freshStorage();
        createUsersDb(dbPath, ["admin"]);
        const { status, checks } = runDoctor(baseEnv(dir, dbPath));
        expect(status).toBe(0);
        expect(checkFor(checks, "config:ADMIN_PASSWORD").status).not.toBe("fail");
        expect(checkFor(checks, "admin-bootstrap").status).toBe("ok");
        expect(checkFor(checks, "database").status).toBe("ok");
    });

    test("a fresh install without users warns instead of failing", () => {
        const { dir, dbPath } = freshStorage();
        createUsersDb(dbPath, []);
        const { checks } = runDoctor(baseEnv(dir, dbPath));
        expect(checkFor(checks, "config:ADMIN_PASSWORD").status).not.toBe("fail");
        expect(checkFor(checks, "admin-bootstrap").status).toBe("warn");
    });

    test("TERRENCE_DISABLE_WORKER=true reports drain mode like =1", () => {
        const { dir, dbPath } = freshStorage();
        createUsersDb(dbPath, ["admin"]);
        for (const value of ["1", "true"]) {
            const { checks } = runDoctor({ ...baseEnv(dir, dbPath), TERRENCE_DISABLE_WORKER: value });
            expect(checkFor(checks, "worker").status).toBe("warn");
        }
        const { checks } = runDoctor(baseEnv(dir, dbPath));
        expect(checkFor(checks, "worker").status).toBe("ok");
    });

    test("an unsupported DATABASE_URL scheme is a clean finding, not a crash", () => {
        const { dir, dbPath } = freshStorage();
        const { status, checks } = runDoctor({ ...baseEnv(dir, dbPath), DATABASE_URL: "mysql://example.invalid/db" }, "--fail");
        expect(status).toBe(1);
        expect(checkFor(checks, "database").status).toBe("fail");
    });
});
