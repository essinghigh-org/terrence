import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BootConfigError,
  bootConfigPath,
  parseBootConfig,
  readBootConfigFile,
  resolveDatabaseConfig,
  writeBootDatabaseConfig,
} from "../../src/lib/boot-config";

const testDir = mkdtempSync(join(tmpdir(), "boot-config-test-"));
const env = (values: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({ ...values });

afterAll((): void => {
  rmSync(testDir, { recursive: true, force: true });
});

const writeFile = (name: string, content: string): void => {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, name), content);
};

describe("resolveDatabaseConfig", () => {
  it("defaults to sqlite at <storage>/terrence.db", () => {
    const resolved = resolveDatabaseConfig(env(), testDir);
    expect(resolved.driver).toBe("sqlite");
    expect(resolved.url).toBe(`file:${join(testDir, "terrence.db")}`);
  });

  it("honors DATABASE_URL for sqlite", () => {
    const resolved = resolveDatabaseConfig(env({ DATABASE_URL: "file:/tmp/custom.db" }), testDir);
    expect(resolved).toEqual({ driver: "sqlite", url: "file:/tmp/custom.db" });
  });

  it("honors DATABASE_URL for postgres and infers the driver from the scheme", () => {
    const resolved = resolveDatabaseConfig(
      env({ DATABASE_URL: "postgres://terrence:secret@127.0.0.1:5432/terrence" }),
      testDir,
    );
    expect(resolved.driver).toBe("postgres");
    expect(resolved.url).toBe("postgres://terrence:secret@127.0.0.1:5432/terrence");
  });

  it("rejects a postgres DATABASE_URL without a host", () => {
    expect(() => resolveDatabaseConfig(env({ DATABASE_URL: "postgres:///nodb" }), testDir))
      .toThrow(BootConfigError);
  });

  it("rejects a non-postgres scheme on a postgres-looking URL", () => {
    expect(() => resolveDatabaseConfig(env({ DATABASE_URL: "mysql://127.0.0.1/db" }), testDir))
      .toThrow(BootConfigError);
  });

  it("reads the boot config file when DATABASE_URL is unset", () => {
    writeFile("terrence.json", JSON.stringify({
      database: { driver: "postgres", url: "postgres://db.internal:5432/terrence" },
    }));
    const resolved = resolveDatabaseConfig(env(), testDir);
    expect(resolved).toEqual({ driver: "postgres", url: "postgres://db.internal:5432/terrence" });
  });

  it("lets DATABASE_URL override the config file", () => {
    const resolved = resolveDatabaseConfig(
      env({ DATABASE_URL: "file:/tmp/env-wins.db" }),
      testDir,
    );
    expect(resolved).toEqual({ driver: "sqlite", url: "file:/tmp/env-wins.db" });
  });

  it("throws on a malformed config file", () => {
    writeFile("terrence.json", "{ not json");
    expect(() => resolveDatabaseConfig(env(), testDir)).toThrow(BootConfigError);
  });

  it("throws on an unknown driver", () => {
    writeFile("terrence.json", JSON.stringify({ database: { driver: "mongodb" } }));
    expect(() => resolveDatabaseConfig(env(), testDir)).toThrow(/driver/);
  });

  it("throws when postgres is selected without a URL", () => {
    writeFile("terrence.json", JSON.stringify({ database: { driver: "postgres" } }));
    expect(() => resolveDatabaseConfig(env(), testDir)).toThrow(/requires/);
  });
});

describe("parseBootConfig", () => {
  it("accepts urlSecret as an alias for url", () => {
    const config = parseBootConfig(
      { database: { driver: "postgres", urlSecret: "postgres://s:secret@h/db" } },
      "test",
    );
    expect(config.database?.url).toBe("postgres://s:secret@h/db");
  });

  it("accepts an empty file (no database key)", () => {
    expect(parseBootConfig({}, "test")).toEqual({});
  });

  it("rejects an http URL for postgres", () => {
    expect(() => parseBootConfig(
      { database: { driver: "postgres", url: "http://host/db" } },
      "test",
    )).toThrow(/postgres:\/\//);
  });
});

describe("writeBootDatabaseConfig", () => {
  it("writes atomically with 0600 and preserves other top-level keys", () => {
    writeFile("terrence.json", JSON.stringify({ other: { keep: true } }));
    writeBootDatabaseConfig(testDir, { driver: "postgres", url: "postgres://u:p@h:5432/db" });

    const raw = readFileSync(bootConfigPath(testDir), "utf8");
    expect(JSON.parse(raw)).toEqual({
      other: { keep: true },
      database: { driver: "postgres", url: "postgres://u:p@h:5432/db" },
    });
    const mode = statSync(bootConfigPath(testDir)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readBootConfigFile(testDir).database?.driver).toBe("postgres");
    expect(resolveDatabaseConfig(env(), testDir).driver).toBe("postgres");
  });

  it("round-trips a sqlite backend", () => {
    writeBootDatabaseConfig(testDir, { driver: "sqlite", url: "file:/tmp/other.db" });
    expect(resolveDatabaseConfig(env(), testDir)).toEqual({ driver: "sqlite", url: "file:/tmp/other.db" });
  });

  it("rejects an invalid driver on write", () => {
    expect(() => writeBootDatabaseConfig(testDir, { driver: "sqlite", url: "file:/x.db" }))
      .not.toThrow();
    expect(() => writeBootDatabaseConfig(testDir, { driver: "mysql" as never, url: "x" }))
      .toThrow(BootConfigError);
  });
});
