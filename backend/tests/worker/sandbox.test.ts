import { describe, expect, it } from "bun:test";
import { writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { RunSandbox, probeLandlockAbi } from "../../src/lib/sandbox";

const abi = probeLandlockAbi();
const usable = abi >= 1 && RunSandbox.isUsable();
const hostTofu = "/root/terrence/backend/storage/binaries/tofu/1.9.3/tofu";

describe("landlock run sandbox", () => {
  it("probes a usable Landlock ABI", (): void => {
    if (!usable) {
      console.warn("Skipping: Landlock unavailable (ABI " + abi + ")");
      return;
    }
    expect(abi).toBeGreaterThanOrEqual(1);
  });

  it("runs tofu version inside the sandbox", async (): Promise<void> => {
    if (!usable) {
      console.warn("Skipping: Landlock unavailable");
      return;
    }
    const sandbox = new RunSandbox();
    const workDir = join(tmpdir(), "terrence", "runs", "ll-test-1");
    await mkdir(workDir, { recursive: true });
    const proc = sandbox.spawn([hostTofu, "version"], { cwd: workDir, env: {} });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OpenTofu");
    expect(stderr).not.toContain("permission denied");
  });

  it("denies access to files outside the allow-list (host secret)", async (): Promise<void> => {
    if (!usable) {
      console.warn("Skipping: Landlock unavailable");
      return;
    }
    const sandbox = new RunSandbox();
    const workDir = join(tmpdir(), "terrence", "runs", "ll-test-2");
    await mkdir(workDir, { recursive: true });
    // Probe: try to read the DB and write a file to /tmp outside the workdir.
    const probeScript = join(workDir, "probe.sh");
    await writeFile(
      probeScript,
      [
        "#!/bin/sh",
        "OUT=BLOCKED",
        'if cat /root/terrence/backend/storage/terrence.db > /dev/null 2>&1; then OUT="DB_READABLE"; fi',
        'if cat /root/terrence/backend/storage/.encryption-key > /dev/null 2>&1; then OUT="${OUT}_KEY_READABLE"; fi',
        'if touch /tmp/ll-outside-write 2>/dev/null; then OUT="${OUT}_TMP_WRITABLE"; fi',
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
  });
});
