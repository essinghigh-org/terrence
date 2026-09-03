import { describe, expect, it, afterAll } from "bun:test";
import { writeFile, readFile, mkdir, mkdtemp, rm } from "fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  RunSandbox,
  landlockAccessFlagsForAbi,
  probeLandlockAbi,
  probeLoopbackSupport,
  resetLandlockAbiCache,
  resetLoopbackSupportCache,
  runLoopbackDenyEnabled,
  runLoopbackPolicy,
  runNetDenyEnabled,
  runNetPolicy,
} from "../../src/lib/sandbox";

/**
 * Landlock ABI-version regression coverage (review item 2.10).
 *
 * The kernel rejects unknown access bits in both the ruleset attr and each
 * rule, so landlock-runner.c gates every right/scope at its introducing ABI.
 * We cannot recompile the kernel to test ABI 1/2 vs 6 here, so the suite:
 *
   *   1. pins the ABI rights truth table against the TS mirror of the
 *      C `abi_mask` (runs on ANY host — pure function),
 *   2. exercises the REAL runner's --probe/--version contract (skipped on
 *      hosts without the compiled helper — it is built at deploy time),
 *   3. proves fail-closed spawn behavior on an ABI-0 host using a fake
 *      runner script (real spawned process, any host).
 */

const defaultRunner = join(import.meta.dir, "../../bin/landlock-runner");
const runnerPath = process.env.TERRENCE_LANDLOCK_RUNNER ?? defaultRunner;
const hasRunner = RunSandbox.hasRunner();

// Preserve an externally supplied runner override across the suite; cleanup
// restores it instead of deleting it unconditionally.
const originalRunnerEnv = process.env.TERRENCE_LANDLOCK_RUNNER;

function restoreRunnerEnv(): void {
  if (originalRunnerEnv === undefined) delete process.env.TERRENCE_LANDLOCK_RUNNER;
  else process.env.TERRENCE_LANDLOCK_RUNNER = originalRunnerEnv;
}

afterAll(() => {
  restoreRunnerEnv();
  resetLandlockAbiCache();
  resetLoopbackSupportCache();
});

describe("landlock ABI rights calculation", () => {
  it("pins the ABI rights and scopes truth table", (): void => {
    // Mirrors landlock-runner.c abi_mask(); unknown bits must never leak into
    // handled_access_fs or a rule's allowed_access.
    expect(landlockAccessFlagsForAbi(1)).toEqual({ refer: false, truncate: false, ioctlDevice: false, scopedIpc: false, resolveUnix: false });
    expect(landlockAccessFlagsForAbi(3)).toEqual({ refer: true, truncate: true, ioctlDevice: false, scopedIpc: false, resolveUnix: false });
    expect(landlockAccessFlagsForAbi(5)).toEqual({ refer: true, truncate: true, ioctlDevice: true, scopedIpc: false, resolveUnix: false });
    expect(landlockAccessFlagsForAbi(6)).toEqual({ refer: true, truncate: true, ioctlDevice: true, scopedIpc: true, resolveUnix: false });
    expect(landlockAccessFlagsForAbi(9)).toEqual({ refer: true, truncate: true, ioctlDevice: true, scopedIpc: true, resolveUnix: true });
  });

  it("returns no rights for an unavailable (ABI 0) kernel", (): void => {
    expect(landlockAccessFlagsForAbi(0)).toEqual({ refer: false, truncate: false, ioctlDevice: false, scopedIpc: false, resolveUnix: false });
  });

  it("gates each capability at the exact ABI", (): void => {
    for (let abi = 0; abi <= 10; abi += 1) {
      const flags = landlockAccessFlagsForAbi(abi);
      expect(flags.refer).toBe(abi >= 2);
      expect(flags.truncate).toBe(abi >= 3);
      expect(flags.ioctlDevice).toBe(abi >= 5);
      expect(flags.scopedIpc).toBe(abi >= 6);
      expect(flags.resolveUnix).toBe(abi >= 9);
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
    // ABI 0 is valid: the helper exists but the host kernel lacks Landlock.
    expect(parsed).toBeGreaterThanOrEqual(0);
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

  it("reports loopback-deny support via --probe-loopback", (): void => {
    if (!hasRunner) return;
    const proc = Bun.spawnSync([runnerPath, "--probe-loopback"], { stdout: "pipe", stderr: "pipe" });
    // Exit 0 + "ok" on kernels with seccomp user-notify; exit 2 otherwise.
    // Either way the app-side probe must agree with the real runner.
    expect([0, 2]).toContain(proc.exitCode);
    if (proc.exitCode === 0) expect(proc.stdout.toString().trim()).toBe("ok");
    resetLoopbackSupportCache();
    expect(probeLoopbackSupport()).toBe(proc.exitCode === 0);
    resetLoopbackSupportCache();
  });
});

describe("landlock opt-in full network policy", () => {
  it("allows by default and passes --deny-net only on explicit deny", async (): Promise<void> => {
    const fakeDir = await mkdtemp(join(tmpdir(), "terrence-ll-net-"));
    const fakeRunner = join(fakeDir, "landlock-runner");
    const denyArgs = join(fakeDir, "deny-args");
    const allowArgs = join(fakeDir, "allow-args");
    const cwd = join(fakeDir, "work");
    const originalRunner = process.env.TERRENCE_LANDLOCK_RUNNER;
    const originalNetPolicy = process.env.TERRENCE_RUN_NET_POLICY;
    const originalLoopbackPolicy = process.env.TERRENCE_RUN_LOOPBACK_POLICY;
    await mkdir(cwd, { recursive: true });
    await writeFile(
      fakeRunner,
      [
        "#!/bin/sh",
        'if [ "$1" = "--probe" ]; then',
        "  echo 4",
        "  exit 0",
        "fi",
        'if [ "$1" = "--probe-loopback" ]; then',
        '  echo "ok"',
        "  exit 0",
        "fi",
        'printf "%s\\n" "$@" > "$RECORD_PATH"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    try {
      process.env.TERRENCE_LANDLOCK_RUNNER = fakeRunner;
      // Isolate the net-policy assertions from the loopback default-deny.
      process.env.TERRENCE_RUN_LOOPBACK_POLICY = "allow";
      resetLoopbackSupportCache();
      delete process.env.TERRENCE_RUN_NET_POLICY;
      resetLandlockAbiCache();
      const allowSandbox = new RunSandbox();
      const allowProc = allowSandbox.spawn(["/bin/true"], { cwd, env: { RECORD_PATH: allowArgs } });
      const [allowExitCode, , allowStderr] = await Promise.all([
        allowProc.exited,
        new Response(allowProc.stdout).text(),
        new Response(allowProc.stderr).text(),
      ]);
      expect(allowExitCode).toBe(0);
      expect(allowStderr).toBe("");
      expect((await readFile(allowArgs, "utf8")).split("\n")).not.toContain("--deny-net");
      expect(runNetPolicy()).toBe("allow");
      expect(runNetDenyEnabled()).toBe(false);

      process.env.TERRENCE_RUN_NET_POLICY = "deny";
      resetLandlockAbiCache();
      const denySandbox = new RunSandbox();
      const denyProc = denySandbox.spawn(["/bin/true"], { cwd, env: { RECORD_PATH: denyArgs } });
      const [denyExitCode, , denyStderr] = await Promise.all([
        denyProc.exited,
        new Response(denyProc.stdout).text(),
        new Response(denyProc.stderr).text(),
      ]);
      expect(denyExitCode).toBe(0);
      expect(denyStderr).toBe("");
      expect((await readFile(denyArgs, "utf8")).split("\n")).toContain("--deny-net");
      expect(runNetDenyEnabled()).toBe(true);

      process.env.TERRENCE_RUN_NET_POLICY = "unexpected-value";
      expect(runNetPolicy()).toBe("allow");
      expect(runNetDenyEnabled()).toBe(false);
    } finally {
      if (originalRunner === undefined) delete process.env.TERRENCE_LANDLOCK_RUNNER;
      else process.env.TERRENCE_LANDLOCK_RUNNER = originalRunner;
      if (originalNetPolicy === undefined) delete process.env.TERRENCE_RUN_NET_POLICY;
      else process.env.TERRENCE_RUN_NET_POLICY = originalNetPolicy;
      if (originalLoopbackPolicy === undefined) delete process.env.TERRENCE_RUN_LOOPBACK_POLICY;
      else process.env.TERRENCE_RUN_LOOPBACK_POLICY = originalLoopbackPolicy;
      resetLandlockAbiCache();
      resetLoopbackSupportCache();
      await rm(fakeDir, { recursive: true, force: true });
    }
  });
});

describe("landlock fail-closed loopback policy", () => {
  it("denies loopback by default and requires an explicit allow opt-out", async (): Promise<void> => {
    const fakeDir = await mkdtemp(join(tmpdir(), "terrence-ll-loop-"));
    const fakeRunner = join(fakeDir, "landlock-runner");
    const denyArgs = join(fakeDir, "deny-args");
    const allowArgs = join(fakeDir, "allow-args");
    const cwd = join(fakeDir, "work");
    const originalRunner = process.env.TERRENCE_LANDLOCK_RUNNER;
    const originalNetPolicy = process.env.TERRENCE_RUN_NET_POLICY;
    const originalLoopbackPolicy = process.env.TERRENCE_RUN_LOOPBACK_POLICY;
    await mkdir(cwd, { recursive: true });
    await writeFile(
      fakeRunner,
      [
        "#!/bin/sh",
        'if [ "$1" = "--probe" ]; then',
        "  echo 6",
        "  exit 0",
        "fi",
        'if [ "$1" = "--probe-loopback" ]; then',
        '  echo "ok"',
        "  exit 0",
        "fi",
        'printf "%s\\n" "$@" > "$RECORD_PATH"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    try {
      process.env.TERRENCE_LANDLOCK_RUNNER = fakeRunner;
      process.env.TERRENCE_RUN_NET_POLICY = "allow";
      resetLandlockAbiCache();
      delete process.env.TERRENCE_RUN_LOOPBACK_POLICY;
      resetLoopbackSupportCache();
      expect(probeLoopbackSupport()).toBe(true);
      const denySandbox = new RunSandbox();
      const denyProc = denySandbox.spawn(["/bin/true"], { cwd, env: { RECORD_PATH: denyArgs } });
      const [denyExitCode, , denyStderr] = await Promise.all([
        denyProc.exited,
        new Response(denyProc.stdout).text(),
        new Response(denyProc.stderr).text(),
      ]);
      expect(denyExitCode).toBe(0);
      expect(denyStderr).toBe("");
      expect((await readFile(denyArgs, "utf8")).split("\n")).toContain("--deny-loopback");
      expect(runLoopbackPolicy()).toBe("deny");
      expect(runLoopbackDenyEnabled()).toBe(true);

      process.env.TERRENCE_RUN_LOOPBACK_POLICY = "allow";
      resetLoopbackSupportCache();
      const allowSandbox = new RunSandbox();
      const allowProc = allowSandbox.spawn(["/bin/true"], { cwd, env: { RECORD_PATH: allowArgs } });
      await Promise.all([
        allowProc.exited,
        new Response(allowProc.stdout).text(),
        new Response(allowProc.stderr).text(),
      ]);
      expect((await readFile(allowArgs, "utf8")).split("\n")).not.toContain("--deny-loopback");
      expect(runLoopbackPolicy()).toBe("allow");

      process.env.TERRENCE_RUN_LOOPBACK_POLICY = "unexpected-value";
      expect(runLoopbackPolicy()).toBe("deny");
      expect(runLoopbackDenyEnabled()).toBe(true);
    } finally {
      if (originalRunner === undefined) delete process.env.TERRENCE_LANDLOCK_RUNNER;
      else process.env.TERRENCE_LANDLOCK_RUNNER = originalRunner;
      if (originalNetPolicy === undefined) delete process.env.TERRENCE_RUN_NET_POLICY;
      else process.env.TERRENCE_RUN_NET_POLICY = originalNetPolicy;
      if (originalLoopbackPolicy === undefined) delete process.env.TERRENCE_RUN_LOOPBACK_POLICY;
      else process.env.TERRENCE_RUN_LOOPBACK_POLICY = originalLoopbackPolicy;
      resetLandlockAbiCache();
      resetLoopbackSupportCache();
      await rm(fakeDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the runner lacks --deny-loopback support", (): void => {
    const originalRunner = process.env.TERRENCE_LANDLOCK_RUNNER;
    const originalLoopbackPolicy = process.env.TERRENCE_RUN_LOOPBACK_POLICY;
    const originalNetPolicy = process.env.TERRENCE_RUN_NET_POLICY;
    try {
      // Point at a binary that exists but does not answer --probe-loopback.
      process.env.TERRENCE_LANDLOCK_RUNNER = "/bin/true";
      process.env.TERRENCE_RUN_NET_POLICY = "allow";
      delete process.env.TERRENCE_RUN_LOOPBACK_POLICY;
      resetLandlockAbiCache();
      resetLoopbackSupportCache();
      expect(probeLoopbackSupport()).toBe(false);
      expect(() => new RunSandbox().spawn(["/bin/true"], { cwd: tmpdir(), env: {} })).toThrow(
        /loopback isolation requires/,
      );
    } finally {
      if (originalRunner === undefined) delete process.env.TERRENCE_LANDLOCK_RUNNER;
      else process.env.TERRENCE_LANDLOCK_RUNNER = originalRunner;
      if (originalNetPolicy === undefined) delete process.env.TERRENCE_RUN_NET_POLICY;
      else process.env.TERRENCE_RUN_NET_POLICY = originalNetPolicy;
      if (originalLoopbackPolicy === undefined) delete process.env.TERRENCE_RUN_LOOPBACK_POLICY;
      else process.env.TERRENCE_RUN_LOOPBACK_POLICY = originalLoopbackPolicy;
      resetLandlockAbiCache();
      resetLoopbackSupportCache();
    }
  });
});

describe("landlock fail-closed on ABI-0 hosts", () => {
  it("fails closed when the runner reports Landlock unsupported", async (): Promise<void> => {
    // Fake runner: probes as ABI 0, refuses real spawns exactly like the C
    // helper on a kernel without Landlock (exit 2, stderr message). A fresh
    // mkdtemp directory keeps parallel runs and repeated invocations isolated.
    const fakeDir = await mkdtemp(join(tmpdir(), "terrence-ll-fake-"));
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
    const originalNetPolicy = process.env.TERRENCE_RUN_NET_POLICY;
    const originalLoopbackPolicy = process.env.TERRENCE_RUN_LOOPBACK_POLICY;
    await mkdir(cwd, { recursive: true });
    try {
      process.env.TERRENCE_LANDLOCK_RUNNER = fakeRunner;
      // Exercise the ABI-0 path itself; isolate from the loopback
      // default-deny (the fake has no --probe-loopback handler).
      process.env.TERRENCE_RUN_NET_POLICY = "allow";
      process.env.TERRENCE_RUN_LOOPBACK_POLICY = "allow";
      resetLandlockAbiCache();
      resetLoopbackSupportCache();
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
      restoreRunnerEnv();
      if (originalNetPolicy === undefined) delete process.env.TERRENCE_RUN_NET_POLICY;
      else process.env.TERRENCE_RUN_NET_POLICY = originalNetPolicy;
      if (originalLoopbackPolicy === undefined) delete process.env.TERRENCE_RUN_LOOPBACK_POLICY;
      else process.env.TERRENCE_RUN_LOOPBACK_POLICY = originalLoopbackPolicy;
      resetLandlockAbiCache();
      resetLoopbackSupportCache();
    }
  });
});
