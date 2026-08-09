// Test setup: redirect database to an isolated temp directory so tests
// never touch the production database.
import { mkdtempSync } from "node:fs";
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

// Share one disk-backed binary cache (backend/storage is gitignored, real
// filesystem) instead of downloading tofu/terraform into every worker's
// tmpfs storage dir. /tmp is tmpfs, so per-worker downloads are charged to
// the cgroup's RAM and accumulate quickly under parallel workers. Spawned
// test backends inherit this via process.env, so they cache-hit instead of
// re-downloading into their own fresh storage dirs too.
process.env.TERRENCE_BINARY_CACHE_DIR ??= join(import.meta.dir, "..", "storage", "binaries");
