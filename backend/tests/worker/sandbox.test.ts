import { describe, expect, it } from "bun:test";
import { writeFile, mkdir, rm, symlink, mkdtemp } from "fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunSandbox, probeLandlockAbi } from "../../src/lib/sandbox";
import { ensureBinary } from "../../src/binaryManager";

const abi = probeLandlockAbi();
const usable = abi >= 1 && RunSandbox.isUsable();

/** Resolve a real tofu binary the same way the worker does. */
async function resolveTofu(): Promise<string | null> {
  if (!usable) return null;
  const resolved = await ensureBinary("tofu", "1.9.3");
  return resolved?.binaryPath ?? null;
}

/** Secret file created inside STORAGE_DIR that the sandbox MUST deny. */

describe("landlock run sandbox", () => {
  it("probes a usable Landlock ABI", (): void => {
    if (!usable) {
      console.warn("Skipping: Landlock unavailable (ABI " + abi + ")");
      return;
    }
    expect(abi).toBeGreaterThanOrEqual(1);
  });

  it("runs tofu version inside the sandbox", async (): Promise<void> => {
    const hostTofu = await resolveTofu();
    if (!usable || hostTofu === null) {
      console.warn("Skipping: Landlock unavailable or no tofu binary");
      return;
    }
    const sandbox = new RunSandbox();
    const workDir = await mkdtemp(join(tmpdir(), "terrence-sb-"));
    await mkdir(join(workDir, "tmp"), { recursive: true });
    try {
      const proc = sandbox.spawn([hostTofu, "version"], { cwd: workDir, env: {} });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OpenTofu");
      expect(stderr).not.toContain("permission denied");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("denies access to files outside the allow-list (host secret)", async (): Promise<void> => {
    const hostTofu = await resolveTofu();
    if (!usable || hostTofu === null) {
      console.warn("Skipping: Landlock unavailable or no tofu binary");
      return;
    }
    const sandbox = new RunSandbox();
    const testBase = await mkdtemp(join(tmpdir(), "terrence-sb-"));
    const workDir = join(testBase, "work");
    const secretDir = join(testBase, "storage");
    const secretPath = join(secretDir, "sandbox-test-secret.txt");
    await mkdir(join(workDir, "tmp"), { recursive: true });
    await mkdir(secretDir, { recursive: true });
    await writeFile(secretPath, "terrence-sandbox-test-secret\n", { mode: 0o600 });
    try {
      const probeScript = join(workDir, "probe.sh");
      await writeFile(
        probeScript,
        [
          "#!/bin/sh",
          "OUT=BLOCKED",
          `if cat ${secretPath} > /dev/null 2>&1; then OUT="SECRET_READABLE"; fi`,
          "if touch " + secretPath + ".written 2>/dev/null; then OUT=\"${OUT}_SECRET_WRITABLE\"; fi",
          "echo $OUT",
        ].join("\n"),
        { mode: 0o755 },
      );
      const proc = sandbox.spawn(["/bin/sh", probeScript], { cwd: workDir, env: {} });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("BLOCKED");
    } finally {
      await rm(testBase, { recursive: true, force: true });
    }
  });

  it("denies access to .encryption-key in the storage directory", async (): Promise<void> => {
    if (!usable) { console.warn("Skipping: Landlock unavailable"); return; }
    const sandbox = new RunSandbox();
    const testBase = await mkdtemp(join(tmpdir(), "terrence-sb-"));
    const workDir = join(testBase, "work");
    const storageDir = join(testBase, "storage");
    const keyFile = join(storageDir, ".encryption-key");
    await mkdir(join(workDir, "tmp"), { recursive: true });
    await mkdir(storageDir, { recursive: true });
    await writeFile(keyFile, "terrence-test-encryption-key\n", { mode: 0o600 });
    try {
      const script = join(workDir, "probe.sh");
      await writeFile(script, `#!/bin/sh\nif cat "${keyFile}" > /dev/null 2>&1; then echo "KEY_READABLE"; else echo "KEY_DENIED"; fi\n`, { mode: 0o755 });
      const proc = sandbox.spawn(["/bin/sh", script], { cwd: workDir, env: {} });
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("KEY_DENIED");
    } finally {
      await rm(testBase, { recursive: true, force: true });
    }
  });

  it("denies access to another run's work directory", async (): Promise<void> => {
    if (!usable) { console.warn("Skipping: Landlock unavailable"); return; }
    const sandbox = new RunSandbox();
    const testBase = await mkdtemp(join(tmpdir(), "terrence-sb-"));
    const workDir = join(testBase, "victim");
    const attackerDir = join(testBase, "attacker");
    const targetFile = join(workDir, "terraform.tfstate");
    await mkdir(join(workDir, "tmp"), { recursive: true });
    await mkdir(join(attackerDir, "tmp"), { recursive: true });
    await writeFile(targetFile, '{"version":1}\n');
    try {
      const script = join(attackerDir, "probe.sh");
      await writeFile(script, `#!/bin/sh\nif cat "${targetFile}" > /dev/null 2>&1; then echo "OTHER_RUN_READABLE"; else echo "OTHER_RUN_DENIED"; fi\n`, { mode: 0o755 });
      const proc = sandbox.spawn(["/bin/sh", script], { cwd: attackerDir, env: {} });
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("OTHER_RUN_DENIED");
    } finally {
      await rm(testBase, { recursive: true, force: true });
    }
  });

  it("denies access via symlink from workdir into storage", async (): Promise<void> => {
    if (!usable) { console.warn("Skipping: Landlock unavailable"); return; }
    const sandbox = new RunSandbox();
    const testBase = await mkdtemp(join(tmpdir(), "terrence-sb-"));
    const workDir = join(testBase, "work");
    const storageDir = join(testBase, "storage");
    const secretFile = join(storageDir, "symlink-secret.txt");
    const linkPath = join(workDir, "evil-link");
    await mkdir(join(workDir, "tmp"), { recursive: true });
    await mkdir(storageDir, { recursive: true });
    await writeFile(secretFile, "symlink-secret-content\n");
    await symlink(storageDir, linkPath);
    try {
      const script = join(workDir, "probe.sh");
      await writeFile(script, `#!/bin/sh\nif cat "${linkPath}/symlink-secret.txt" > /dev/null 2>&1; then echo "SYMLINK_READABLE"; else echo "SYMLINK_DENIED"; fi\n`, { mode: 0o755 });
      const proc = sandbox.spawn(["/bin/sh", script], { cwd: workDir, env: {} });
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("SYMLINK_DENIED");
    } finally {
      await rm(testBase, { recursive: true, force: true });
    }
  });

  it("denies reading /proc/<pid>/environ of another process", async (): Promise<void> => {
    if (!usable) { console.warn("Skipping: Landlock unavailable"); return; }
    const sandbox = new RunSandbox();
    const testBase = await mkdtemp(join(tmpdir(), "terrence-sb-"));
    const workDir = join(testBase, "work");
    await mkdir(join(workDir, "tmp"), { recursive: true });
    try {
      const ppid = process.pid;
      const script = join(workDir, "probe.sh");
      await writeFile(script, `#!/bin/sh\nif cat /proc/${ppid}/environ > /dev/null 2>&1; then echo "PROC_READABLE"; else echo "PROC_DENIED"; fi\n`, { mode: 0o755 });
      const proc = sandbox.spawn(["/bin/sh", script], { cwd: workDir, env: {} });
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("PROC_DENIED");
    } finally {
      await rm(testBase, { recursive: true, force: true });
    }
  });

  it("checks network connectivity under Landlock (documented: Landlock does not restrict network)", async (): Promise<void> => {
    if (!usable) { console.warn("Skipping: Landlock unavailable"); return; }
    const sandbox = new RunSandbox();
    const testBase = await mkdtemp(join(tmpdir(), "terrence-sb-"));
    const workDir = join(testBase, "work");
    await mkdir(join(workDir, "tmp"), { recursive: true });
    try {
      const script = join(workDir, "probe.sh");
      // Use a timeout /dev/tcp probe through the shell
      await writeFile(script, `#!/bin/sh\nif command -v nc > /dev/null 2>&1; then nc -w 2 127.0.0.1 3000 < /dev/null > /dev/null 2>&1 && echo "NET_REACHABLE" || echo "NET_DENIED"; else echo "NET_UNCHECKED_NC_MISSING"; fi\n`, { mode: 0o755 });
      const proc = sandbox.spawn(["/bin/sh", script], { cwd: workDir, env: {} });
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      expect(exitCode).toBe(0);
      const result = stdout.trim();
      // Landlock doesn't restrict network access, so this may be reachable.
      // We accept either result but at least we exercise the path.
      expect(["NET_DENIED", "NET_UNCHECKED_NC_MISSING"]).toContain(result);
    } finally {
      await rm(testBase, { recursive: true, force: true });
    }
  });

  it("denies signals to processes outside the sandbox on Landlock ABI 6+", async (): Promise<void> => {
    if (!usable) { console.warn("Skipping: Landlock unavailable"); return; }
    const sandbox = new RunSandbox();
    const testBase = await mkdtemp(join(tmpdir(), "terrence-sb-"));
    const workDir = join(testBase, "work");
    await mkdir(join(workDir, "tmp"), { recursive: true });
    try {
      const targetPid = process.pid;
      const script = join(workDir, "probe.sh");
      await writeFile(script, `#!/bin/sh\nif kill -0 ${targetPid} 2>/dev/null; then echo "SIGNAL_OK"; else echo "SIGNAL_DENIED"; fi\n`, { mode: 0o755 });
      const proc = sandbox.spawn(["/bin/sh", script], { cwd: workDir, env: {} });
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      expect(exitCode).toBe(0);
      const result = stdout.trim();
      if (abi >= 6) expect(result).toBe("SIGNAL_DENIED");
      else expect(["SIGNAL_OK", "SIGNAL_DENIED"]).toContain(result);
    } finally {
      await rm(testBase, { recursive: true, force: true });
    }
  });

  it("verifies the sandbox helper binary is present at the resolved path", (): void => {
    if (!usable) { console.warn("Skipping: Landlock unavailable"); return; }
    const runnerPath = process.env.TERRENCE_LANDLOCK_RUNNER ?? join(__dirname, "../../bin/landlock-runner");
    expect(existsSync(runnerPath)).toBe(true);
    expect(RunSandbox.isUsable()).toBe(true);
  });

  it("returns a numeric ABI version from probeLandlockAbi", (): void => {
    // Reports the kernel's Landlock ABI (or 0 if unavailable).  This is a
    // self-describing probe — it confirms the probe surface is callable
    // without crashing, and the return type is a number.
    expect(typeof probeLandlockAbi()).toBe("number");
  });
});
