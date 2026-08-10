import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";

// The id-format compat block in db/index.ts runs at module import (every boot)
// and re-keys rows whose ids predate the current scheme (raw-UUID runs, run-*
// with a non-16-hex suffix). Regression: when a run is re-keyed, its
// filesystem sidecars (plan-json/{id}.json, run-logs/{id}.json.gz) must be
// renamed alongside the row, or artifact lookups 404 after the next deploy.

const BOOT_SCRIPT = `
  const { db } = await import("./src/db/index.ts");
  console.log("READY");
  process.exit(0);
`;

test("id-format migration renames run sidecar artifacts alongside re-keyed rows", async () => {
  const testDir = await mkdtemp(join(tmpdir(), "terrence-id-format-"));
  const storageDir = join(testDir, "storage");
  const dbPath = join(testDir, "terrence.db");
  const env = { ...process.env, STORAGE_DIR: storageDir, DATABASE_URL: `file:${dbPath}` };
  await mkdir(join(storageDir, "plan-json"), { recursive: true });
  await mkdir(join(storageDir, "run-logs"), { recursive: true });

  const bootOnce = async (): Promise<void> => {
    const child = Bun.spawn([Bun.which("bun")!, "-e", BOOT_SCRIPT], {
      cwd: join(import.meta.dir, "../.."),
      env,
      stdout: "pipe",
      stderr: "ignore",
    });
    const timedOut = await Promise.race([
      child.exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 30_000)),
    ]);
    expect(timedOut).toBe(false);
    const output = await new Response(child.stdout).text();
    expect(output).toContain("READY");
  };

  // Boot 1: migrations + compat block, no legacy rows yet -> no-op.
  await bootOnce();

  // Seed two legacy runs: a raw-UUID id (pre-prefix era) and a run-* with a
  // 14-hex suffix (old webhook template), each with a log row and sidecars.
  const sql = new Database(dbPath);
  sql.run("INSERT INTO organizations (id, name) VALUES ('org-1234567890abcdef', 'idfmt-org')");
  sql.run("INSERT INTO workspaces (id, name, org_id) VALUES ('ws-1234567890abcdef', 'idfmt-ws', 'org-1234567890abcdef')");
  sql.run("INSERT INTO runs (id, workspace_id, status, created_at) VALUES ('9e94c6d8-8c60-44a6-93e6-d9952866a20c', 'ws-1234567890abcdef', 'planned_and_finished', 1)");
  sql.run("INSERT INTO runs (id, workspace_id, status, created_at) VALUES ('run-abcdef01234567', 'ws-1234567890abcdef', 'planned_and_finished', 1)");
  sql.run("INSERT INTO logs (id, run_id, phase, output_text, created_at) VALUES ('log-uuid-1', '9e94c6d8-8c60-44a6-93e6-d9952866a20c', 'plan', 'boot 1', 1)");
  sql.run("INSERT INTO logs (id, run_id, phase, output_text, created_at) VALUES ('log-14hex-1', 'run-abcdef01234567', 'plan', 'boot 1', 1)");
  sql.close();
  await writeFile(join(storageDir, "plan-json", "9e94c6d8-8c60-44a6-93e6-d9952866a20c.json"), '{"legacy":"uuid"}');
  await writeFile(join(storageDir, "plan-json", "run-abcdef01234567.json"), '{"legacy":"14hex"}');
  await writeFile(join(storageDir, "run-logs", "9e94c6d8-8c60-44a6-93e6-d9952866a20c.json.gz"), "gz-uuid");
  await writeFile(join(storageDir, "run-logs", "run-abcdef01234567.json.gz"), "gz-14hex");

  // Boot 2: compat block re-keys both runs and renames the sidecars.
  await bootOnce();

  const check = new Database(dbPath);
  const ids = (check.prepare("SELECT id FROM runs ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  expect(ids).toHaveLength(2);
  for (const id of ids) expect(id).toMatch(/^run-[0-9a-f]{16}$/);
  expect(ids).not.toContain("9e94c6d8-8c60-44a6-93e6-d9952866a20c");
  expect(ids).not.toContain("run-abcdef01234567");

  // Log FK columns were rewritten to the new ids.
  const logRuns = (check.prepare("SELECT DISTINCT run_id FROM logs ORDER BY run_id").all() as { run_id: string }[]).map((r) => r.run_id);
  expect(logRuns.sort()).toEqual([...ids].sort());

  // Old sidecar files are gone; new ones exist with identical bytes.
  for (const oldName of ["9e94c6d8-8c60-44a6-93e6-d9952866a20c", "run-abcdef01234567"]) {
    await expect(readFile(join(storageDir, "plan-json", `${oldName}.json`), "utf8")).rejects.toThrow();
    await expect(readFile(join(storageDir, "run-logs", `${oldName}.json.gz`), "utf8")).rejects.toThrow();
  }
  const contents = new Set<string>();
  for (const id of ids) {
    contents.add(await readFile(join(storageDir, "plan-json", `${id}.json`), "utf8"));
    await expect(readFile(join(storageDir, "run-logs", `${id}.json.gz`), "utf8")).resolves.toBeTruthy();
  }
  expect(contents).toEqual(new Set(['{"legacy":"uuid"}', '{"legacy":"14hex"}']));
  check.close();

  await rm(testDir, { recursive: true, force: true });
});