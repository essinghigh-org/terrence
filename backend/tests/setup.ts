// Test setup: redirect database to an isolated temp directory so tests
// never touch the production database.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV ??= "test";
process.env.TERRENCE_ENABLE_LOCAL_SIGNUP ??= "true";
// app.ts boots the worker queue at import time via a dynamic import; in Bun
// the first poll can fire before the top-level-await ./db module finishes
// evaluating (TDZ ReferenceError, cascading 500s across API test files).
// Tests drive the queue explicitly (pollWorkerQueue/executeRun) or spawn
// dedicated processes, so the background loop must stay off here. Spawns
// that need it opt back in with TERRENCE_DISABLE_WORKER=0.
process.env.TERRENCE_DISABLE_WORKER ??= "1";
process.env.TERRENCE_SETUP_RAN = "yes";

const testDir = mkdtempSync(join(tmpdir(), "terrence-test-"));
process.env.DATABASE_URL ??= `file:${join(testDir, "terrence.db")}`;
process.env.STORAGE_DIR ??= join(testDir, "storage");

// Each test file's run of this preload creates a fresh tmpfs-backed temp dir
// under /tmp (mkdtempSync above). tmpfs pages count toward the LXC cgroup's
// memory limit, so if these dirs are never removed the box accumulates
// gigabytes of stale SQLite DBs/WALs/binaries across runs and OOM-kills the
// gateway. afterAll (from bun:test) is the per-file teardown hook — unlike
// process.on("exit"), bun test fires it when this file's tests complete even
// though the worker process is reused. Only this file's own testDir is
// removed; dirs created by individual tests (which set their own STORAGE_DIR)
// are left to those tests to clean.
afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Best-effort: a failed unlink must never mask test results.
  }
});

// Share one disk-backed binary cache (backend/storage is gitignored, real
// filesystem) instead of downloading tofu/terraform into every worker's
// tmpfs storage dir. /tmp is tmpfs, so per-worker downloads are charged to
// the cgroup's RAM and accumulate quickly under parallel workers. Spawned
// test backends inherit this via process.env, so they cache-hit instead of
// re-downloading into their own fresh storage dirs too.
process.env.TERRENCE_BINARY_CACHE_DIR ??= join(import.meta.dir, "..", "storage", "binaries");
