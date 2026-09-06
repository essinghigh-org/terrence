import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createOperationalTestDirectory,
  managedCommand,
  normalizeOperationalTestSeed,
  operationalFixtureSuffix,
  operationalTestProfileNames,
  operationalTestProfiles,
  parseOperationalTestProfile,
  redactOperationalDiagnostic,
  redactOperationalEnvironment,
  terminateManagedProcess,
} from "../../src/lib/operational-test-profile";

const createdDirectories: string[] = [];

afterAll(async (): Promise<void> => {
  await Promise.all(createdDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("operational test profiles", () => {
  test("exposes the five named profiles with explicit execution modes", () => {
    expect(operationalTestProfileNames).toEqual(["unit-api", "sqlite-cli", "postgres-cli", "sandbox", "browser"]);
    expect(operationalTestProfiles["unit-api"].mode).toBe("simulated");
    expect(operationalTestProfiles["sqlite-cli"].mode).toBe("real-cli");
    expect(operationalTestProfiles["postgres-cli"].database).toBe("postgres");
    expect(operationalTestProfiles.sandbox.sandbox).toBe("required");
    expect(operationalTestProfiles.browser.mode).toBe("browser");
    expect(parseOperationalTestProfile("sqlite-cli")).toBe(operationalTestProfiles["sqlite-cli"]);
  });

  test("rejects unknown profiles and unsafe fixture seeds", () => {
    expect(() => parseOperationalTestProfile("production" as never)).toThrow("Unknown operational test profile");
    expect(() => normalizeOperationalTestSeed("bad seed")).toThrow("Operational test seed");
    expect(normalizeOperationalTestSeed(" ENG21_Local ")).toBe("eng21_local");
  });

  test("derives repeatable bounded fixture names", () => {
    expect(operationalFixtureSuffix("eng21", "terraform")).toBe("eng21-terraform");
    expect(operationalFixtureSuffix("a".repeat(32), "terraform").length).toBeLessThanOrEqual(30);
    expect(`pe2e-proj-${operationalFixtureSuffix("eng21-terraform-current", "terraform")}`.length).toBeLessThanOrEqual(40);
    expect(operationalFixtureSuffix("a".repeat(32), "terraform")).not.toBe(operationalFixtureSuffix("a".repeat(31) + "b", "terraform"));
    expect(operationalFixtureSuffix("a".repeat(32), "terraform")).toBe(operationalFixtureSuffix("a".repeat(32), "terraform"));
  });

  test("redacts credentials from environments and diagnostics", () => {
    expect(redactOperationalEnvironment({ TOKEN: "secret-token", SAFE: "value", DATABASE_URL: "postgres://u:p@localhost/db" })).toEqual({
      TOKEN: "[redacted]",
      SAFE: "value",
      DATABASE_URL: "postgres://u:[redacted]@localhost/db",
    });
    expect(redactOperationalDiagnostic("Authorization: Bearer abc password=topsecret")).toBe("Authorization: Bearer [redacted] password=[redacted]");
  });

  test("creates isolated directories and process groups", async () => {
    const directory = createOperationalTestDirectory("terrence-profile-test-", tmpdir());
    createdDirectories.push(directory);
    expect(directory.startsWith(tmpdir())).toBe(true);
    if (process.platform !== "linux") return;
    const child = Bun.spawn(managedCommand(["bun", "-e", "setTimeout(() => {}, 60000)"]), { stdout: "ignore", stderr: "ignore" });
    await terminateManagedProcess(child, 100);
    expect(await child.exited).not.toBe(0);
  }, 10_000);
});
