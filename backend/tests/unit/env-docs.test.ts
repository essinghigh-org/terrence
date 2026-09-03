import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Issues #389/#390: every environment variable the server reads must be
// documented in backend/docs/configuration.md or .env.example, so the two
// cannot silently drift apart again.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SCAN_ROOTS = ["backend/src", "backend/scripts", "frontend/scripts"];
const SCAN_FILES = ["backend/index.ts", "backend/seed.ts"];
const CONFIG_DOC = join(REPO_ROOT, "backend/docs/configuration.md");
const ENV_EXAMPLE = join(REPO_ROOT, ".env.example");

// Runtime-provided or CI-provided names that are not Terrence configuration:
// OS/CI plumbing, test-only hooks, and dynamic lookups that are not static
// configuration surface.
const ALLOWLIST = new Set([
  "HOME", // OS home directory (binary cache fallback).
  "PATH", // OS executable search path (child process inheritance).
  "USER", // OS user (diagnostics only).
  "GH_TOKEN", // CI-provided token for the provider-surface refresh PR.
  "GITHUB_TOKEN", // CI-provided token for tofu release lookups.
  "TERRENCE_SETUP_RAN", // Test setup sentinel, not server configuration.
  "TERRENCE_E2E_CLI", // E2E harness CLI selector (terraform|tofu).
  "TERRENCE_LANDLOCK_RECORD_PATH", // Sandbox test hook recording runner args.
  "TERRENCE_QUERY_LOG_SLOW", // Set only by tests alongside TERRENCE_QUERY_LOG.
  "NODE_ENV", // Standard runtime mode flag (development/test/production).
]);

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules") walk(full);
      } else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry)) {
        files.push(full);
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  for (const file of SCAN_FILES) files.push(join(REPO_ROOT, file));
  return files;
}

function referencedEnvVars(): Set<string> {
  const pattern = /(?:process\.env|Bun\.env)\.([A-Z][A-Z0-9_]+)|(?:process\.env|Bun\.env)\[["']([A-Z][A-Z0-9_]+)["']\]|(?:readEnv|envFlag)\(["']([A-Z][A-Z0-9_]+)["']\)/g;
  const vars = new Set<string>();
  for (const file of sourceFiles()) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Dynamic computed lookups (prefix scans, reflective access) are not
    // static configuration names; they are covered by the INFRACOST_* family
    // documentation instead.
    for (const line of source.split("\n")) {
      if (/Object\.(keys|entries)\(process\.env\)/.test(line) || /Reflect\.get\(process\.env/.test(line)) continue;
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const name = match[1] ?? match[2] ?? match[3];
        if (name !== undefined && !ALLOWLIST.has(name)) vars.add(name);
      }
    }
  }
  return vars;
}

describe("env documentation coverage (389/390)", () => {
  it("every referenced env var is documented in configuration.md or .env.example", () => {
    const config = readFileSync(CONFIG_DOC, "utf8");
    const example = readFileSync(ENV_EXAMPLE, "utf8");
    const undocumented = [...referencedEnvVars()].filter((name) => !config.includes(name) && !example.includes(name));
    expect(`undocumented env vars: ${undocumented.sort().join(", ")}`).toBe("undocumented env vars: ");
  });
});
