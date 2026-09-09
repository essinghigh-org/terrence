import { expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// Issue #618: plan/apply resource counts must come from SQL-matched summary
// rows (or structured plan JSON), never from loading the whole phase log.
async function runWorkerScript(script: string, env: Record<string, string> = {}) {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-resource-counts-"));
  try {
    const child = Bun.spawn([Bun.which("bun")!, "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...Bun.env,
        TEST_DIR: testDir,
        DATABASE_URL: "file:" + join(testDir, "terrence.db"),
        STORAGE_DIR: join(testDir, "storage"),
        TERRENCE_BINARY_CACHE_DIR: join(testDir, "storage", "binaries"),
        TERRENCE_RUN_SANDBOX: "false",
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
    const trimmed = stdout.trim();
    return JSON.parse(trimmed.slice(trimmed.lastIndexOf(String.fromCharCode(10)) + 1));
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

test("plan counts fall back to the log summary line when plan JSON has no counts", async () => {
  const result = await runWorkerScript(`
    process.env.SIMULATED_PLAN_JSON = "{}";

    const { db } = await import("./src/db/index.ts");
    const { logs, organizations, runs, workspaces } = await import("./src/db/schema.ts");
    const { executeRun } = await import("./src/worker.ts");

    await db.insert(organizations).values({ id: "org", name: "org" });
    await db.insert(workspaces).values({ id: "workspace", name: "workspace", orgId: "org" });
    await db.insert(runs).values([
      { id: "run", workspaceId: "workspace", status: "pending", planOnly: true, createdAt: Date.now() },
    ]);
    // Volume: the old code loaded every one of these rows to run four
    // regexes; the summary match must ignore them.
    await db.insert(logs).values(
      Array.from({ length: 500 }, (_, index) => ({
        id: "junk-" + String(index),
        runId: "run",
        phase: "plan",
        outputText: "ordinary output line " + String(index),
        createdAt: Date.now(),
      })),
    );

    await executeRun("run");
    const completed = await db.query.runs.findFirst({ where: (row, { eq }) => eq(row.id, "run") });
    console.log(JSON.stringify({
      status: completed?.status,
      additions: completed?.planResourceAdditions,
      changes: completed?.planResourceChanges,
      destructions: completed?.planResourceDestructions,
      imports: completed?.planResourceImports,
    }));
  `, { NODE_ENV: "test", SIMULATED_RUNS: "true" });

  expect(result.status).toBe("planned_and_finished");
  expect(result).toMatchObject({ additions: 1, changes: 0, destructions: 0, imports: 0 });
});

for (const [name, exitCode, expectedStatus, change] of [
  ["observed drift with no planned changes", 0, "planned_and_finished", { actions: ["no-op"] }],
  ["output-only changes", 2, "planned", { actions: ["no-op"] }],
  ["import-only changes", 2, "planned", { actions: ["no-op"], importing: { id: "existing" } }],
] as const) {
  test(`plan completion respects the CLI change result for ${name}`, async () => {
    const planJson = {
      format_version: "1.2",
      resource_changes: [{ address: "test_resource.example", mode: "managed", change }],
      resource_drift: [{ address: "test_resource.example", change: { actions: ["update"] } }],
      output_changes: { value: { actions: [name === "output-only changes" ? "update" : "no-op"], before: "a", after: name === "output-only changes" ? "b" : "a" } },
    };
    const result = await runWorkerScript(`
      const { mkdir, writeFile, chmod } = await import("fs/promises");
      const { join } = await import("path");
      const { db } = await import("./src/db/index.ts");
      const { organizations, workspaces, configurationVersions, runs } = await import("./src/db/schema.ts");
      const { executeRun } = await import("./src/worker.ts");
      const binaryDir = join(process.env.STORAGE_DIR, "binaries", "tofu", "1.2.3");
      await mkdir(binaryDir, { recursive: true });
      const binary = join(binaryDir, "tofu");
      await writeFile(binary, process.env.TEST_BINARY);
      await chmod(binary, 0o755);
      const configDir = join(process.env.TEST_DIR, "config");
      await mkdir(configDir);
      await writeFile(join(configDir, "main.tf"), "terraform {}");
      const archive = join(process.env.TEST_DIR, "config.tar.gz");
      const tar = Bun.spawn(["tar", "-czf", archive, "-C", configDir, "."]);
      if (await tar.exited !== 0) throw new Error("tar failed");
      await db.insert(organizations).values({ id: "org", name: "org" });
      await db.insert(workspaces).values({ id: "ws", name: "ws", orgId: "org", iacBinary: "tofu" });
      await db.insert(configurationVersions).values({ id: "cv", workspaceId: "ws", status: "uploaded", archivePath: archive });
      await db.insert(runs).values({ id: "run", workspaceId: "ws", configurationVersionId: "cv", status: "pending", terraformVersion: "1.2.3", createdAt: Date.now() });
      await executeRun("run");
      const run = await db.query.runs.findFirst({ where: (row, { eq }) => eq(row.id, "run") });
      console.log(JSON.stringify({ status: run?.status }));
    `, {
      NODE_ENV: "production", SIMULATED_RUNS: "false",
      TEST_BINARY: `#!/bin/sh\ncase "$1" in\ninit) exit 0 ;;\nplan) case " $* " in *" -detailed-exitcode "*) : ;; *) exit 1 ;; esac; touch tfplan; exit ${exitCode} ;;\nshow) echo '${JSON.stringify(planJson)}' ;;\n*) exit 1 ;;\nesac\n`,
    });
    expect(result.status).toBe(expectedStatus);
  });
}
