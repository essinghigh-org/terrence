import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BootConfigError,
  bootConfigPath,
  parseBootConfig,
  readBootConfigFile,
  resolveDatabaseConfig,
  resolveStorageSecret,
  storageSecretPath,
  writeBootDatabaseConfig,
  writeDatabaseUrlSecret,
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

/**
 * encryptSecret derives the encryption key from process.env.STORAGE_DIR,
 * so secret-store round-trips pin the env to the temp dir and restore it
 * afterwards (same pattern as tests/unit/secrets.test.ts).
 */
async function withStorageDir<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env["STORAGE_DIR"];
  process.env["STORAGE_DIR"] = testDir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env["STORAGE_DIR"];
    else process.env["STORAGE_DIR"] = previous;
  }
}

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
      env({ DATABASE_URL: "postgres://terrence:***@127.0.0.1:5432/terrence" }),
      testDir,
    );
    expect(resolved.driver).toBe("postgres");
    expect(resolved.url).toBe("postgres://terrence:***@127.0.0.1:5432/terrence");
  });

  it("rejects a postgres DATABASE_URL without a host", () => {
    expect(() => resolveDatabaseConfig(env({ DATABASE_URL: "postgres:///nodb" }), testDir))
      .toThrow(BootConfigError);
  });

  it("rejects a non-postgres scheme on a postgres-looking URL", () => {
    expect(() => resolveDatabaseConfig(env({ DATABASE_URL: "mysql://127.0.0.1/db" }), testDir))
      .toThrow(BootConfigError);
  });

  it("rejects an unsupported scheme in DATABASE_URL", () => {
    expect(() => resolveDatabaseConfig(env({ DATABASE_URL: "mongodb://127.0.0.1/db" }), testDir))
      .toThrow(/unsupported scheme/);
  });

  it("reads the boot config file when DATABASE_URL is unset", () => {
    writeFile("terrence.json", JSON.stringify({
      database: { driver: "postgres", url: "postgres://db.internal:5432/terrence" },
    }));
    const resolved = resolveDatabaseConfig(env(), testDir);
    expect(resolved).toEqual({ driver: "postgres", url: "postgres://db.internal:5432/terrence" });
  });

  it("resolves urlSecret from the storage secret store", async () => {
    await withStorageDir(() => writeDatabaseUrlSecret(testDir, "database-url", "postgres://s:***@h:5432/db"));
    writeFile("terrence.json", JSON.stringify({
      database: { driver: "postgres", urlSecret: "database-url" },
    }));
    const resolved = resolveDatabaseConfig(env(), testDir);
    expect(resolved).toEqual({ driver: "postgres", url: "postgres://s:***@h:5432/db" });
  });

  it("fails fast when the urlSecret blob is missing", () => {
    writeFile("terrence.json", JSON.stringify({
      database: { driver: "postgres", urlSecret: "no-such-secret" },
    }));
    expect(() => resolveDatabaseConfig(env(), testDir))
      .toThrow(/Missing storage secret "no-such-secret"/);
  });

  it("fails fast when the urlSecret blob cannot be decrypted", () => {
    writeFile("terrence.json", JSON.stringify({
      database: { driver: "postgres", urlSecret: "broken" },
    }));
    mkdirSync(join(testDir, "secrets"), { recursive: true });
    writeFileSync(join(testDir, "secrets", "broken"), "enc:v1:not-a-valid-blob");
    expect(() => resolveDatabaseConfig(env(), testDir))
      .toThrow(/Cannot decrypt storage secret "broken"/);
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

  it("throws when postgres is selected without a URL or urlSecret", () => {
    writeFile("terrence.json", JSON.stringify({ database: { driver: "postgres" } }));
    expect(() => resolveDatabaseConfig(env(), testDir)).toThrow(/requires/);
  });
});

describe("parseBootConfig", () => {
  it("accepts urlSecret as a secret-store reference (not an inline URL)", () => {
    const config = parseBootConfig(
      { database: { driver: "postgres", urlSecret: "database-url" } },
      "test",
    );
    expect(config.database?.urlSecret).toBe("database-url");
    expect(config.database?.url).toBeUndefined();
  });

  it("rejects an inline URL in urlSecret", () => {
    expect(() => parseBootConfig(
      { database: { driver: "postgres", urlSecret: "postgres://s:p@h/db" } },
      "test",
    )).toThrow(/secret name/);
  });

  it("rejects url and urlSecret together", () => {
    expect(() => parseBootConfig(
      { database: { driver: "postgres", url: "postgres://h/db", urlSecret: "database-url" } },
      "test",
    )).toThrow(/mutually exclusive/);
  });

  it("rejects urlSecret on the sqlite driver", () => {
    expect(() => parseBootConfig(
      { database: { driver: "sqlite", urlSecret: "database-url" } },
      "test",
    )).toThrow(/only valid for the postgres driver/);
  });

  it("rejects path-traversal secret names", () => {
    expect(() => parseBootConfig(
      { database: { driver: "postgres", urlSecret: "../.encryption-key" } },
      "test",
    )).toThrow(/secret name/);
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

  it("preserves unknown top-level keys", () => {
    const config = parseBootConfig({ telemetry: { enabled: false } }, "test");
    expect(config["telemetry"]).toEqual({ enabled: false });
  });
});

describe("resolveStorageSecret", () => {
  it("round-trips an encrypted secret through the store", async () => {
    await withStorageDir(() => writeDatabaseUrlSecret(testDir, "roundtrip", "postgres://u:p@h:5432/db"));
    expect(resolveStorageSecret(testDir, "roundtrip")).toBe("postgres://u:p@h:5432/db");
  });

  it("writes the blob encrypted (never plaintext) with 0600", async () => {
    await withStorageDir(() => writeDatabaseUrlSecret(testDir, "cipher", "postgres://u:p@h:5432/db"));
    const blob = readFileSync(storageSecretPath(testDir, "cipher"), "utf8").trim();
    expect(blob.startsWith("enc:v1:")).toBe(true);
    expect(blob).not.toContain("postgres://");
    expect(blob).not.toContain("p@h");
    const mode = statSync(storageSecretPath(testDir, "cipher")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects a missing secret with a clear error", () => {
    expect(() => resolveStorageSecret(testDir, "missing-secret"))
      .toThrow(/Missing storage secret "missing-secret"/);
  });

  it("rejects an empty secret file", () => {
    mkdirSync(join(testDir, "secrets"), { recursive: true });
    writeFileSync(join(testDir, "secrets", "empty"), "");
    expect(() => resolveStorageSecret(testDir, "empty")).toThrow(/is empty/);
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

  it("writes a urlSecret reference for the wizard", async () => {
    rmSync(bootConfigPath(testDir), { force: true });
    await withStorageDir(() => writeDatabaseUrlSecret(testDir, "wizard-url", "postgres://u:p@h:5432/db"));
    writeBootDatabaseConfig(testDir, { driver: "postgres", urlSecret: "wizard-url" });

    const raw = readFileSync(bootConfigPath(testDir), "utf8");
    expect(JSON.parse(raw)).toEqual({
      database: { driver: "postgres", urlSecret: "wizard-url" },
    });
    expect(raw).not.toContain("postgres://");
    expect(resolveDatabaseConfig(env(), testDir)).toEqual({
      driver: "postgres",
      url: "postgres://u:p@h:5432/db",
    });
  });

  it("round-trips a sqlite backend", () => {
    writeBootDatabaseConfig(testDir, { driver: "sqlite", url: "file:/tmp/other.db" });
    expect(resolveDatabaseConfig(env(), testDir)).toEqual({ driver: "sqlite", url: "file:/tmp/other.db" });
  });

  it("rejects an invalid driver on write", () => {
    expect(() => { writeBootDatabaseConfig(testDir, { driver: "sqlite", url: "file:/x.db" }); })
      .not.toThrow();
    expect(() => { writeBootDatabaseConfig(testDir, { driver: "mysql" as never, url: "x" }); })
      .toThrow(BootConfigError);
  });

  it("leaves no leftover .tmp file", () => {
    writeBootDatabaseConfig(testDir, { driver: "sqlite" });
    expect(existsSync(`${bootConfigPath(testDir)}.tmp`)).toBe(false);
  });
});
