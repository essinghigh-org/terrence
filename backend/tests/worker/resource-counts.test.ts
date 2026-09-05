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
