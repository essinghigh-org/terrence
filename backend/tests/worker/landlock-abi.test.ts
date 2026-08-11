import { describe, expect, it, afterAll } from "bun:test";
import { writeFile, mkdir, rm } from "fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  RunSandbox,
  landlockAccessFlagsForAbi,
  probeLandlockAbi,
  resetLandlockAbiCache,
} from "../../src/lib/sandbox";

/**
 * Landlock ABI-version regression coverage (review item 2.10).
 *
 * The kernel rejects unknown access bits in both the ruleset attr and each
 * rule, so landlock-runner.c masks REFER at ABI < 2 and TRUNCATE at ABI < 3.
 * We cannot recompile the kernel to test ABI 1/2 vs 6 here, so the suite:
 *
 *   1. pins the ABI 1/2/3+ rights truth table against the TS mirror of the
 *      C `abi_mask` (runs on ANY host — pure function),
 *   2. exercises the REAL runner's --probe/--version contract (skipped on
 *      hosts without the compiled helper — it is built at deploy time),
 *   3. proves fail-closed spawn behavior on an ABI-0 host using a fake
 *      runner script (real spawned process, any host).
 */

const defaultRunner = join(import.meta.dir, "../../bin/landlock-runner");
const runnerPath = process.env.TERRENCE_LANDLOCK_RUNNER ?? defaultRunner;
const hasRunner = RunSandbox.hasRunner();

afterAll(() => {
  delete process.env.TERRENCE_LANDLOCK_RUNNER;
  resetLandlockAbiCache();
});

describe("landlock ABI rights calculation", () => {
  it("pins the ABI 1 / 2 / 3+ truth table (REFER >= 2, TRUNCATE >= 3)", (): void => {
    // Mirrors landlock-runner.c abi_mask(); unknown bits must never leak into
    // handled_access_fs or a rule's allowed_access.
    expect(landlockAccessFlagsForAbi(0)).toEqual({ refer: false, truncate: false });
    expect(landlockAccessFlagsForAbi(1)).toEqual({ refer: false, truncate: false });
    expect(landlockAccessFlagsForAbi(2)).toEqual({ refer: true, truncate: false });
    expect(landlockAccessFlagsForAbi(3)).toEqual({ refer: true, truncate: true });
    expect(landlockAccessFlagsForAbi(4)).toEqual({ refer: true, truncate: true });
    expect(landlockAccessFlagsForAbi(6)).toEqual({ refer: true, truncate: true });
    expect(landlockAccessFlagsForAbi(1000)).toEqual({ refer: true, truncate: true });
  });

  it("returns no rights for an unavailable (ABI 0) kernel", (): void => {
    expect(landlockAccessFlagsForAbi(0)).toEqual({ refer: false, truncate: false });
  });

  it("gates REFER exactly at ABI 2 and TRUNCATE exactly at ABI 3", (): void => {
    for (let abi = 0; abi <= 8; abi += 1) {
      const flags = landlockAccessFlagsForAbi(abi);
      expect(flags.refer).toBe(abi >= 2);
      expect(flags.truncate).toBe(abi >= 3);
    }
  });
});

describe("landlock runner probe contract", () => {
  it("skips silently when the helper binary is absent (deploy-time build)", (): void => {
    if (hasRunner) {
      expect(existsSync(runnerPath)).toBe(true);
      return;
    }
    expect(existsSync(runnerPath)).toBe(false);
    console.warn("Skipping: landlock-runner not built on this host (deploy-time build)");
  });

  it("reports the ABI via --probe with exit 0", (): void => {
    if (!hasRunner) return;
    const proc = Bun.spawnSync([runnerPath, "--probe"], { stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    const parsed = Number.parseInt(proc.stdout.toString().trim(), 10);
    expect(Number.isSafeInteger(parsed)).toBe(true);
    expect(parsed).toBeGreaterThanOrEqual(1);
    // The app-side cache must agree with the real runner's report.
    resetLandlockAbiCache();
    expect(probeLandlockAbi()).toBe(parsed);
  });

  it("prints a stable version string via --version", (): void => {
    if (!hasRunner) return;
    const proc = Bun.spawnSync([runnerPath, "--version"], { stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toMatch(/^landlock-runner \d+\.\d+\.\d+ \(Landlock ABI \d+\)\s*$/);
  });
});

describe("landlock fail-closed on ABI-0 hosts", () => {
  it("fails closed when the runner reports Landlock unsupported", async (): Promise<void> => {
    // Fake runner: probes as ABI 0, refuses real spawns exactly like the C
    // helper on a kernel without Landlock (exit 2, stderr message).
    const fakeDir = join(tmpdir(), "terrence", "ll-fake-runner");
    await mkdir(fakeDir, { recursive: true });
    const fakeRunner = join(fakeDir, "landlock-runner");
    await writeFile(
      fakeRunner,
      [
        "#!/bin/sh",
        'if [ "$1" = "--probe" ]; then',
        "  echo 0",
        "  exit 0",
        "fi",
        'echo "landlock-runner: Landlock not supported (ABI 0)" >&2',
        "exit 2",
      ].join("\n"),
      { mode: 0o755 },
    );
    const cwd = join(fakeDir, "work");
    await mkdir(cwd, { recursive: true });
    try {
      process.env.TERRENCE_LANDLOCK_RUNNER = fakeRunner;
      resetLandlockAbiCache();
      expect(probeLandlockAbi()).toBe(0);

      const sandbox = new RunSandbox();
      const proc = sandbox.spawn(["/bin/true"], { cwd, env: {} });
      const [exitCode, , stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("not supported");
    } finally {
      await rm(fakeDir, { recursive: true, force: true });
      delete process.env.TERRENCE_LANDLOCK_RUNNER;
      resetLandlockAbiCache();
    }
  });
});
