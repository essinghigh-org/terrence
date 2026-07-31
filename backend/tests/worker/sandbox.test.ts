import { describe, expect, it } from "bun:test";
import { writeFile, mkdir, rm } from "fs/promises";
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
    const workDir = join(tmpdir(), "terrence", "runs", "ll-test-1");
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
    const workDir = join(tmpdir(), "terrence", "runs", "ll-test-2");
    const secretDir = join(process.cwd(), "..", "storage");
    const secretPath = join(secretDir, "sandbox-test-secret.txt");
    await mkdir(join(workDir, "tmp"), { recursive: true });
    // Ensure the secret exists BEFORE the probe so ENOENT cannot mask a
    // failed denial (a read that succeeds would then be observable).
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
      const [exitCode, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("BLOCKED");
    } finally {
      await rm(workDir, { recursive: true, force: true });
      await rm(secretPath, { recursive: true, force: true });
      await rm(secretPath + ".written", { recursive: true, force: true });
    }
  });
});
