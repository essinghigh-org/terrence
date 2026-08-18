import { expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { probeLandlockAbi } from "../../src/lib/sandbox";

// P0 parity proof (RUN-008 / RUN-009): cancellation must terminate the
// underlying IaC subprocess and a canceled run must never be allowed to
// publish a success/apply terminal state.
const TEST_RUN_SANDBOX = probeLandlockAbi() >= 1 ? "true" : "false";

async function runCancellationScript(script: string, env: Record<string, string> = {}) {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-cancel-"));
  try {
    const child = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        TEST_DIR: testDir,
        DATABASE_URL: `file:${join(testDir, "terrence.db")}`,
        STORAGE_DIR: join(testDir, "storage"),
        TERRENCE_BINARY_CACHE_DIR: join(testDir, "storage", "binaries"),
        TERRENCE_SANDBOX_EXTRA_RW_PATHS: join(testDir, "record"),
        TERRENCE_SANDBOX_EXTRA_RW_ALLOWED: "true",
        TERRENCE_RUN_SANDBOX: TEST_RUN_SANDBOX,
        // Force REAL execution: NODE_ENV=test triggers the worker's simulated
        // run path (no subprocess), which would leave nothing to cancel.
        NODE_ENV: "production",
        SIMULATED_RUNS: "false",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr || stdout);
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("cancel terminates the IaC subprocess and the run cannot publish success", { timeout: 30000 }, async () => {
  const result = await runCancellationScript(`
    const { chmod, mkdir, writeFile, rm, exists, readFile } = await import("fs/promises");
    const { join } = await import("path");
    const pidAlive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
    const { db } = await import("./src/db/index.ts");
    const { eq } = await import("drizzle-orm");
    const { organizations, projects, workspaces, configurationVersions, runs } = await import("./src/db/schema.ts");
    const { executeRun, cancelRunExecution } = await import("./src/worker.ts");

    const testDir = process.env.TEST_DIR;
    const recordDir = join(testDir, "record");
    const binaryDir = join(process.env.STORAGE_DIR, "binaries", "tofu", "1.2.3");
    const binaryPath = join(binaryDir, "tofu");
    const pidFile = join(recordDir, "plan-pid");
    await mkdir(recordDir, { recursive: true });
    await mkdir(binaryDir, { recursive: true });

    // Fake tofu: a plan that records its PID and blocks until the sentinel is
    // removed. If cancel fails to terminate the subprocess, the PID stays
    // alive and the run cannot complete (the watchdog below catches that).
    await writeFile(binaryPath, [
      "#!/bin/sh",
      "record_dir=" + JSON.stringify(recordDir),
      "case \\"$1\\" in",
      '  init) : ;;',
      '  plan) sleep 30 & sleep_pid=$!; echo "$sleep_pid" > "' + pidFile + '"; wait "$sleep_pid"; echo "Plan: 0 to add, 0 to change, 0 to destroy."; : > tfplan ;;',
      '  show) echo "{}" ;;',
      '  apply) echo "Apply complete!"; : > "' + join(recordDir, "applied") + '" ;;',
      "  *) exit 2 ;;",
      "esac",
    ].join("\\n"));
    await chmod(binaryPath, 0o755);

    const configDir = join(testDir, "config");
    const archivePath = join(testDir, "config.tar.gz");
    await mkdir(configDir);
    await writeFile(join(configDir, "main.tf"), 'output "x" { value = "y" }');
    const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", configDir, "."]);
    if (await tar.exited !== 0) throw new Error("tar failed");

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(projects).values({ id: "project", orgId: "org", name: "project" });
    await db.insert(workspaces).values({
      id: "workspace", name: "workspace", orgId: "org", projectId: "project",
      iacBinary: "tofu", terraformVersion: "1.2.3", autoApply: true,
    });
    await db.insert(configurationVersions).values({
      id: "configuration", workspaceId: "workspace", status: "uploaded", archivePath,
    });
    await db.insert(runs).values({
      id: "run", workspaceId: "workspace", configurationVersionId: "configuration",
      status: "pending", autoApply: true, terraformVersion: "1.2.3", createdAt: Date.now(),
    });

    // Start the run without awaiting; poll until the plan subprocess has
    // actually started (it writes its PID file), so cancelRunExecution has a
    // tracked process to terminate. Canceling earlier would race the spawn.
    const runPromise = executeRun("run");
    let attempts = 0;
    while (attempts++ < 500) {
      if (await exists(pidFile)) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    // Mimic the API cancel action: mark the run canceled, then kill the
    // subprocess. Do NOT remove the sentinel here: a failed kill would leave
    // the plan process alive (the watchdog below proves it died).
    await db.update(runs).set({ status: "canceled" }).where(eq(runs.id, "run"));
    cancelRunExecution("run");

    // Watchdog: the subprocess group must die. The non-force cancel sends
    // SIGINT first (which backgrounded children ignore) then force-kills the
    // group at ~5s. Poll long enough to observe the escalation.
    let subprocessDead = false;
    for (let i = 0; i < 900; i++) {
      if (await exists(pidFile)) {
        const p = parseInt(await readFile(pidFile, "utf8"), 10);
        let alive = false;
        try { process.kill(p, 0); alive = true; } catch { alive = false; }
        if (!alive) { subprocessDead = true; break; }
      }
      await new Promise(r => setTimeout(r, 10));
    }

    await runPromise.catch(() => {});
    const final = await db.query.runs.findFirst({ where: eq(runs.id, "run"), columns: { status: true } });
    const applied = await exists(join(recordDir, "applied")).catch(() => false);
    process.stdout.write(JSON.stringify({ status: final?.status, applied, subprocessDead }) + "\\n");
  `);

  expect(result.subprocessDead).toBe(true);
  expect(result.status).toBe("canceled");
  expect(result.applied).toBe(false);
});
