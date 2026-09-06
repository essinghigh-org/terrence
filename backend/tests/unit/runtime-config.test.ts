import { describe, expect, test } from "bun:test";
import { throws } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { booleanConfiguration, integerConfiguration, parseRuntimeConfiguration } from "../../src/lib/runtime-config";
import { configurationReference } from "../../scripts/configuration-reference";
import { assertKnownEnvironmentNames } from "../../src/lib/environment-names";

describe("runtime deployment configuration", (): void => {
  test("rejects invalid explicit deployment secrets without echoing them", (): void => {
    for (const environment of [
      { SIGNED_URL_SECRET: "private-marker" },
      { TERRENCE_TOKEN_HASH_SECRET: "" },
      { ENCRYPTION_PASSWORD: "" },
      { ENCRYPTION_PASSWORD: "private-marker\u0000" },
    ]) throws((): void => { parseRuntimeConfiguration(environment); }, (error: unknown): boolean => error instanceof Error && !error.message.includes("private-marker"));
    expect(parseRuntimeConfiguration({}).SIGNED_URL_SECRET).toBeUndefined();
  });
  test("rejects ignored or storage-exposing sandbox write-path configurations", (): void => {
    throws((): void => { parseRuntimeConfiguration({ TERRENCE_SANDBOX_EXTRA_RW_PATHS: "/opt/cache" }); }, /requires TERRENCE_SANDBOX_EXTRA_RW_ALLOWED/);
    for (const path of ["relative", "", "/tmp", "/tmp/storage"]) {
      throws((): void => { parseRuntimeConfiguration({ STORAGE_DIR: "/tmp/storage", TERRENCE_SANDBOX_EXTRA_RW_ALLOWED: "true", TERRENCE_SANDBOX_EXTRA_RW_PATHS: path }); });
    }
    expect(parseRuntimeConfiguration({ STORAGE_DIR: "/tmp/storage", TERRENCE_SANDBOX_EXTRA_RW_ALLOWED: "true", TERRENCE_SANDBOX_EXTRA_RW_PATHS: "/opt/cache" }).TERRENCE_SANDBOX_EXTRA_RW_PATHS).toEqual(["/opt/cache"]);
  });
  test("requires a complete agent update and a supported node status", (): void => {
    for (const environment of [
      { TERRENCE_NODE_STATUS: "actve" },
      { TERRENCE_AGENT_UPDATE_VERSION: "1.0.0" },
      { TERRENCE_AGENT_UPDATE_VERSION: "1.0.0", TERRENCE_AGENT_UPDATE_URL: "https://example.com/agent", TERRENCE_AGENT_UPDATE_SHA256: "invalid" },
      { TERRENCE_AGENT_UPDATE_VERSION: "1.0.0", TERRENCE_AGENT_UPDATE_URL: "file:///private-marker", TERRENCE_AGENT_UPDATE_SHA256: "a".repeat(64) },
    ]) throws((): void => { parseRuntimeConfiguration(environment); }, (error: unknown): boolean => error instanceof Error && !error.message.includes("private-marker"));
    const config = parseRuntimeConfiguration({ TERRENCE_AGENT_UPDATE_VERSION: "1.0.0", TERRENCE_AGENT_UPDATE_URL: "https://example.com/agent?token=secret", TERRENCE_AGENT_UPDATE_SHA256: "A".repeat(64) });
    expect(config.TERRENCE_AGENT_UPDATE_SHA256).toBe("a".repeat(64));
    expect(config.TERRENCE_NODE_STATUS).toBe("active");
  });
  test("validates GitHub URLs while preserving explicit App override precedence", (): void => {
    for (const environment of [
      { GITHUB_API_URL: "" }, { GITHUB_APP_HTTP_URL: "ftp://example.com" },
      { GITHUB_APP_API_URL: "https://user:private-marker@example.com" },
    ]) throws((): void => { parseRuntimeConfiguration(environment); }, (error: unknown): boolean => error instanceof Error && !error.message.includes("private-marker"));
    expect(parseRuntimeConfiguration({ GITHUB_API_URL: "https://enterprise.example/api/v3" }).GITHUB_APP_API_URL).toBe("https://enterprise.example/api/v3");
    expect(parseRuntimeConfiguration({ GITHUB_API_URL: "https://general.example", GITHUB_APP_API_URL: "https://app.example" }).GITHUB_APP_API_URL).toBe("https://app.example");
    expect(parseRuntimeConfiguration({}).GITHUB_APP_HTTP_URL).toBeNull();
  });
  test("recognizes application-owned names used by current source consumers", (): void => {
    const directory = new URL("../../src/", import.meta.url).pathname;
    const parsed = parseRuntimeConfiguration({});
    for (const path of new Bun.Glob("**/*.ts").scanSync({ cwd: directory, absolute: true })) {
      const source = readFileSync(path, "utf8");
      const names = [...source.matchAll(/process\.env(?:\["([A-Z_0-9]+)"\]|\.([A-Z_0-9]+))/g)];
      for (const match of names) {
        const name = match[1] ?? match[2];
        if (name !== undefined) assertKnownEnvironmentNames({ [name]: "" }, parsed);
      }
    }
  });
  test("rejects misspelled application-owned names but allows unrelated process variables", (): void => {
    for (const name of ["TERRENCE_RUN_CONCURENCY", "SYSTEM_API_TLS_CRET", "RATE_LIMIT_MXA", "GITHUB_APP_PRIVATE_KYE"]) {
      throws((): void => { parseRuntimeConfiguration({ [name]: "private-marker" }); }, (error: unknown): boolean => error instanceof Error && error.message.startsWith("Unknown ") && !error.message.includes("private-marker"));
    }
    expect(parseRuntimeConfiguration({ HOME: "/tmp", PATH: "/usr/bin", CUSTOM_SERVICE_VALUE: "allowed", TERRENCE_NODE_ID: "node-1" }).PORT).toBe(3000);
  });
  test("rejects invalid network policies instead of ignoring entries", (): void => {
    for (const environment of [
      { TERRENCE_TRUSTED_PROXY_CIDRS: "10.0.0.0/33" },
      { TERRENCE_OUTBOUND_ALLOW_CIDRS: "::1/128" },
      { TERRENCE_OUTBOUND_ALLOW_CIDRS: "10.0.0.0/8," },
      { TERRENCE_OUTBOUND_ALLOW_HOSTS: "https://private-marker/path" },
    ]) throws((): void => { parseRuntimeConfiguration(environment); }, (error: unknown): boolean => error instanceof Error && !error.message.includes("private-marker"));
    const config = parseRuntimeConfiguration({ TERRENCE_TRUSTED_PROXY_CIDRS: "10.0.0.0/8,127.0.0.1", TERRENCE_OUTBOUND_ALLOW_HOSTS: "Example.COM." });
    expect(config.TERRENCE_TRUSTED_PROXY_CIDRS).toEqual(["10.0.0.0/8", "127.0.0.1"]);
    expect(config.TERRENCE_OUTBOUND_ALLOW_HOSTS).toEqual(["example.com"]);
  });
  test("validates listener TLS pairs and explicit storage paths", (): void => {
    for (const environment of [
      { STORAGE_DIR: "" }, { STORAGE_DIR: "invalid\u0000path" },
      { SYSTEM_API_HOST: "https://private-marker" },
      { SYSTEM_API_HOST: "admin.example.com" },
      { SYSTEM_API_TLS_CERT: "/tmp/private-marker" },
      { SYSTEM_API_TLS_CERT: "", SYSTEM_API_TLS_KEY: "/tmp/key" },
    ]) throws((): void => { parseRuntimeConfiguration(environment); }, (error: unknown): boolean => error instanceof Error && !error.message.includes("private-marker"));
    const config = parseRuntimeConfiguration({ SYSTEM_API_HOST: "admin.example.com", SYSTEM_API_TLS_CERT: "/tmp/cert", SYSTEM_API_TLS_KEY: "/tmp/key" });
    expect(config.SYSTEM_API_HOST).toBe("admin.example.com");
    expect(config.SYSTEM_API_TLS_CERT).toBe("/tmp/cert");
  });
  test("rejects invalid logging configuration and conflicting destination aliases", (): void => {
    for (const environment of [
      { LOG_LEVEL: "debg" }, { TERRENCE_SYSLOG_LEVEL: "" },
      { TERRENCE_SYSLOG_FORMAT: "private-marker" },
      { TERRENCE_SYSLOG_TARGETS: "udp://host:514,invalid" },
      { TERRENCE_SYSLOG_TARGET: "udp://user:private-marker@host:514" },
      { TERRENCE_SYSLOG_TARGET: "udp://one:514", TERRENCE_SYSLOG_TARGETS: "udp://two:514" },
    ]) throws((): void => { parseRuntimeConfiguration(environment); }, (error: unknown): boolean => error instanceof Error && !error.message.includes("private-marker"));
    const config = parseRuntimeConfiguration({ LOG_LEVEL: "DEBUG", TERRENCE_SYSLOG_TARGET: "udp://host:514" });
    expect(config.TERRENCE_SYSLOG_LEVEL).toBe("debug");
    expect(config.TERRENCE_SYSLOG_TARGETS).toEqual(["udp://host:514"]);
  });
  test("keeps the generated documentation and examples aligned with the schema", (): void => {
    expect(readFileSync(new URL("../../docs/configuration-contract.md", import.meta.url), "utf8")).toBe(configurationReference());
    throws((): void => { parseRuntimeConfiguration({ TERRENCE_RUN_CONCURENCY: "5" }, true); }, /Unsupported setting/);
  });
  test("uses explicit defaults only when absent", (): void => {
    const config = parseRuntimeConfiguration({});
    expect(config.PORT).toBe(3000);
    expect(config.RATE_LIMIT_MAX).toBe(60);
    expect(config.RATE_LIMIT_WORKSPACE_RUN_HISTORY_MAX).toBe(120);
    expect(Object.isFrozen(config)).toBe(true);
  });

  test("validates every numeric setting without exposing the input", (): void => {
    for (const [name, rule] of Object.entries(integerConfiguration)) {
      for (const raw of ["", " ", "garbage-secret", "NaN", "Infinity", "1e2", "0x10", "1.5", "-1", String(rule.max + 1)]) {
        throws((): void => { parseRuntimeConfiguration({ [name]: raw }); }, (error: unknown): boolean => {
          return error instanceof Error && error.message.startsWith(`${name} must be an integer between `)
            && !error.message.includes("garbage-secret");
        });
      }
      if (rule.min > 0) throws((): void => { parseRuntimeConfiguration({ [name]: "0" }); });
      expect(parseRuntimeConfiguration({ [name]: String(rule.min) })[name as keyof typeof integerConfiguration]).toBe(rule.min);
      expect(parseRuntimeConfiguration({ [name]: String(rule.max) })[name as keyof typeof integerConfiguration]).toBe(rule.max);
    }
  });

  test("rejects conflicting listeners", (): void => {
    throws((): void => { parseRuntimeConfiguration({ PORT: "8443" }); }, /must use different ports/);
  });

  test("rejects misspelled boolean security settings", (): void => {
    for (const name of Object.keys(booleanConfiguration)) {
      for (const raw of ["", "TRUE", "ture", "yes", "2"]) {
        throws((): void => { parseRuntimeConfiguration({ [name]: raw }); }, /must be true, false, 1, or 0/);
      }
      expect(parseRuntimeConfiguration({ [name]: "1" })[name as keyof typeof booleanConfiguration]).toBe(true);
      expect(parseRuntimeConfiguration({ [name]: "0" })[name as keyof typeof booleanConfiguration]).toBe(false);
    }
  });

  test("invalid startup configuration fails before creating storage", (): void => {
    const directory = mkdtempSync(join(tmpdir(), "terrence-config-startup-"));
    const storage = join(directory, "storage");
    try {
      const result = Bun.spawnSync([process.execPath, new URL("../../index.ts", import.meta.url).pathname], {
        cwd: directory,
        env: { ...process.env, STORAGE_DIR: storage, PORT: "private-invalid-port" },
        timeout: 10_000,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("PORT must be an integer");
      expect(result.stderr.toString()).not.toContain("private-invalid-port");
      expect(existsSync(storage)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("freezes the startup values and reports their origin without copying unrelated secrets", (): void => {
    const moduleUrl = new URL("../../src/lib/runtime-config.ts", import.meta.url).href;
    const script = `
      const { initializeRuntimeConfiguration, integerSetting, runtimeConfigurationReport } = await import(${JSON.stringify(moduleUrl)});
      initializeRuntimeConfiguration({ PORT: "4567", SIGNED_URL_SECRET: "private-marker-012345678901234567890123456789" });
      process.env.PORT = "5678";
      console.log(JSON.stringify({ port: integerSetting("PORT"), report: runtimeConfigurationReport() }));
    `;
    const result = Bun.spawnSync([process.execPath, "--eval", script]);
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).not.toContain("private-marker");
    const decoded = JSON.parse(output) as { port: number; report: { name: string; value: unknown; origin: string; restartRequired: boolean }[] };
    expect(decoded.port).toBe(4567);
    expect(decoded.report.find((entry): boolean => entry.name === "PORT")).toEqual({ name: "PORT", value: 4567, origin: "environment", restartRequired: true });
    expect(decoded.report.find((entry): boolean => entry.name === "SYSTEM_API_PORT")?.origin).toBe("default");
  });

  test("rejects invalid security URLs and policies without echoing secrets", (): void => {
    for (const environment of [
      { PUBLIC_URL: "https://user:secret@example.com" },
      { PUBLIC_URL: "javascript:secret" },
      { PUBLIC_URL: "https://example.com/?secret" },
      { PUBLIC_URL: "" },
      { CORS_ORIGIN: "*" },
      { CORS_ORIGIN: "https://example.com/path" },
      { CORS_ORIGIN: "https://user:secret@example.com" },
      { CORS_ORIGIN: "https://example.com," },
      { TERRENCE_RUN_SANDBOX: "ture" },
      { TERRENCE_SANDBOX_MIN_ABI: "0" },
      { TERRENCE_SANDBOX_MIN_ABI: "4junk" },
      { TERRENCE_SANDBOX_MIN_ABI: "256" },
      { TERRENCE_RUN_NET_POLICY: "alow" },
      { TERRENCE_RUN_SANDBOX: "false", TERRENCE_RUN_NET_POLICY: "deny" },
    ]) {
      throws((): void => { parseRuntimeConfiguration(environment); }, (error: unknown): boolean => {
        return error instanceof Error && !error.message.includes("secret");
      });
    }
    const values = parseRuntimeConfiguration({ PUBLIC_URL: "https://example.com", CORS_ORIGIN: "https://example.com, http://localhost:5173" });
    expect(values.PUBLIC_URL).toBe("https://example.com/");
    expect(values.CORS_ORIGIN).toEqual(["https://example.com", "http://localhost:5173"]);
    expect(Object.isFrozen(values.CORS_ORIGIN)).toBe(true);
  });
});
