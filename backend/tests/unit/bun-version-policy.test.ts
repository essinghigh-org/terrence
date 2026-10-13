import { describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = Bun.version;
const workflow = `jobs:
  checks:
    steps:
      - uses: oven-sh/setup-bun@${"a".repeat(40)}
        with:
          bun-version: "${version}" # Keep all runtime pins aligned.
`;
const packageJson = { packageManager: `bun@${version}`, engines: { bun: version } };

function runCheck(replacement?: Readonly<{ file: string; content: string }>): Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "terrence-bun-version-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    copyFileSync(
      join(import.meta.dir, "../../../scripts/check-bun-version.ts"),
      join(root, "scripts/check-bun-version.ts"),
    );
    writeFileSync(join(root, "package.json"), JSON.stringify(packageJson));
    writeFileSync(join(root, "Dockerfile"), `FROM oven/bun:${version}@sha256:${"a".repeat(64)} AS builder\n`);
    writeFileSync(join(root, ".github/workflows/ci.yml"), workflow);
    writeFileSync(join(root, ".github/workflows/release.yaml"), workflow);
    if (replacement) writeFileSync(join(root, replacement.file), replacement.content);
    const result = Bun.spawnSync([process.execPath, "scripts/check-bun-version.ts"], { cwd: root });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Bun version policy CLI", (): void => {
  it("accepts matching runtime, engine, Docker, and quoted workflow pins", (): void => {
    const result = runCheck();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Bun version OK: ${version}`);
  });

  it.each([
    {
      label: "a different running Bun version",
      file: "package.json",
      content: JSON.stringify({ packageManager: "bun@0.0.0", engines: { bun: "0.0.0" } }),
      source: "the current runtime",
    },
    {
      label: "a split package engine update",
      file: "package.json",
      content: JSON.stringify({ ...packageJson, engines: { bun: "0.0.0" } }),
      source: "package.json engines.bun",
    },
    {
      label: "a split Docker update",
      file: "Dockerfile",
      content: `FROM oven/bun:0.0.0@sha256:${"a".repeat(64)} AS builder\n`,
      source: "Dockerfile",
    },
    {
      label: "a split CI update",
      file: ".github/workflows/ci.yml",
      content: workflow.replace(version, "0.0.0"),
      source: "ci.yml",
    },
    {
      label: "a split release-workflow update",
      file: ".github/workflows/release.yaml",
      content: workflow.replace(version, "0.0.0"),
      source: "release.yaml",
    },
    {
      label: "a missing workflow runtime pin",
      file: ".github/workflows/ci.yml",
      content: workflow.replace(/^.*bun-version:.*\n/m, ""),
      source: "ci.yml",
    },
  ])("rejects $label", (fixture): void => {
    const result = runCheck(fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Bun version mismatch");
    expect(result.stderr).toContain(fixture.source);
  });
});
