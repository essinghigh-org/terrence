import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeLandlockAbi } from "../../src/lib/sandbox";

const TEST_RUN_SANDBOX = probeLandlockAbi() >= 1 ? "true" : "false";

async function runWorkerScript(script: string): Promise<Record<string, unknown>> {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-apply-exception-"));
  try {
    const child = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        TEST_DIR: testDir,
        DATABASE_URL: "file:" + join(testDir, "terrence.db"),
        STORAGE_DIR: join(testDir, "storage"),
        TERRENCE_BINARY_CACHE_DIR: join(testDir, "storage", "binaries"),
        TERRENCE_SANDBOX_EXTRA_RW_PATHS: join(testDir, "record"),
        TERRENCE_SANDBOX_EXTRA_RW_ALLOWED: "true",
        TERRENCE_RUN_SANDBOX: TEST_RUN_SANDBOX,
        NODE_ENV: "production",
        SIMULATED_RUNS: "false",
        TERRENCE_TEST_APPLY_TIMEOUT_MS: "50",
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
    return JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

test("exceptional local apply preserves the only state copy when persistence and recovery capture fail (#925)", async () => {
  const result = await runWorkerScript(`
    const { chmod, exists, mkdir, readFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { sql } = await import("drizzle-orm");
    const { db } = await import("./src/db/index.ts");
    const { configurationVersions, organizations, projects, runs, stateVersions, workspaces } =
      await import("./src/db/schema.ts");
    const { executeRun, runWorkDir } = await import("./src/worker.ts");
    const { decodeStatePayload } = await import("./src/lib/validation.ts");

    const testDir = process.env.TEST_DIR;
    const storageDir = process.env.STORAGE_DIR;
    const recordDir = join(testDir, "record");
    const binaryDir = join(storageDir, "binaries", "tofu", "1.2.3");
    const binaryPath = join(binaryDir, "tofu");
    await mkdir(recordDir, { recursive: true });
    await mkdir(binaryDir, { recursive: true });

    const showJson = JSON.stringify({
      format_version: "1.2",
      terraform_version: "1.2.3",
      resource_changes: [{ address: "test_resource.example", mode: "managed", change: { actions: ["create"] } }],
    });
    const stateJson = JSON.stringify({
      version: 4,
      serial: 2,
      lineage: "lineage",
      resources: [{ type: "test_resource" }],
    });
    await writeFile(binaryPath, [
      "#!/bin/sh",
      'case "$1" in',
      "  init) exit 0 ;;",
      '  plan) echo "Plan: 1 to add, 0 to change, 0 to destroy."; : > tfplan; exit 0 ;;',
      "  show) echo " + JSON.stringify(showJson) + " ;;",
      "  apply) echo " + JSON.stringify(stateJson) + " > terraform.tfstate; sleep 2; exit 0 ;;",
      "  *) exit 2 ;;",
      "esac",
    ].join("\\n"));
    await chmod(binaryPath, 0o755);

    const configDir = join(testDir, "config");
    const archivePath = join(testDir, "config.tar.gz");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "main.tf"), "terraform {}");
    const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", configDir, "."]);
    if (await tar.exited !== 0) throw new Error("tar failed");

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(projects).values({ id: "project", orgId: "org", name: "project" });
    await db.insert(workspaces).values({
      id: "workspace",
      orgId: "org",
      projectId: "project",
      name: "workspace",
      iacBinary: "tofu",
      terraformVersion: "1.2.3",
      autoApply: true,
    });
    await db.insert(stateVersions).values({
      id: "state-1",
      workspaceId: "workspace",
      serial: 1,
      statePayload: JSON.stringify({ version: 4, serial: 1, lineage: "lineage", resources: [] }),
      status: "finalized",
    });
    await db.insert(configurationVersions).values({
      id: "configuration",
      workspaceId: "workspace",
      status: "uploaded",
      archivePath,
    });
    await db.insert(runs).values({
      id: "run",
      workspaceId: "workspace",
      configurationVersionId: "configuration",
      status: "pending",
      autoApply: true,
      terraformVersion: "1.2.3",
      createdAt: Date.now(),
    });

    await db.run(sql.raw(
      "CREATE TRIGGER fail_run_state BEFORE INSERT ON state_versions " +
      "WHEN NEW.run_id = 'run' BEGIN SELECT RAISE(FAIL, 'forced state persistence failure'); END"
    ));

    // Force the durable recovery path to fail independently of the run work
    // directory: recovery/ is a file, so recovery/run cannot be created.
    await mkdir(storageDir, { recursive: true });
    await writeFile(join(storageDir, "recovery"), "blocked");

    await executeRun("run");

    const run = await db.query.runs.findFirst({ where: (row, { eq }) => eq(row.id, "run") });
    const states = await db.query.stateVersions.findMany({
      where: (row, { eq }) => eq(row.workspaceId, "workspace"),
      orderBy: (row, { asc }) => [asc(row.serial)],
    });
    const workDir = runWorkDir("run");
    const statePath = join(workDir, "terraform.tfstate");
    const sourceStillExists = await exists(statePath);
    const sourceState = sourceStillExists ? JSON.parse(await readFile(statePath, "utf8")) : null;
    console.log(JSON.stringify({
      runStatus: run?.status,
      stateSerials: states.map((state) => state.serial),
      durableState: decodeStatePayload(states.at(-1)?.statePayload ?? "null"),
      sourceStillExists,
      sourceState,
    }));
  `);

  expect(result).toEqual({
    runStatus: "errored",
    stateSerials: [1],
    durableState: JSON.stringify({ version: 4, serial: 1, lineage: "lineage", resources: [] }),
    sourceStillExists: true,
    sourceState: {
      version: 4,
      serial: 2,
      lineage: "lineage",
      resources: [{ type: "test_resource" }],
    },
  });
}, 30_000);
