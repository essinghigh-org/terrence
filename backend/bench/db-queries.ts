/**
 * DB query benchmark: runs-table access patterns vs index coverage.
 *
 * Replicates the runs queries that drive queue, workspace-list, and
 * scheduled-apply work with the real table shape:
 *   1. pollWorkerQueue:      WHERE status='pending' ORDER BY created_at LIMIT 50
 *   2. runs list endpoint:   WHERE workspace_id=? ORDER BY created_at DESC LIMIT 20
 *   3. scheduled apply:      WHERE status='confirmed' AND plan_only=0
 *                            AND scheduled_at <= ?
 *
 * Seeds 60k runs, measures each query BEFORE any index, then creates the
 * proposed indexes and measures again. Run: bun run bench/db-queries.ts
 */
import { Database } from "bun:sqlite";

const RUNS = 60_000;
const WORKSPACES = 200;
const STATUSES = ["pending", "planned", "confirmed", "applied", "errored", "canceled"];

const db = new Database(":memory:");
db.run("PRAGMA journal_mode = WAL");
db.run(`CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  scheduled_at INTEGER,
  plan_only INTEGER NOT NULL DEFAULT 0,
  status_timestamps TEXT
)`);

const insert = db.prepare("INSERT INTO runs (id, workspace_id, status, created_at, scheduled_at, plan_only, status_timestamps) VALUES (?, ?, ?, ?, ?, ?, ?)");
const now = Date.now();
db.transaction(() => {
  for (let i = 0; i < RUNS; i += 1) {
    const ws = `ws-${i % WORKSPACES}`;
    const status = STATUSES[i % STATUSES.length];
    const created = now - (RUNS - i) * 60_000;
    // Confirmed rows get schedules distributed around NOW so the scheduled
    // apply predicate exercises both due and not-yet-due rows.
    const scheduledAt = status === "confirmed" ? now - 3_600_000 + (i % 7) * 3_600_000 : null;
    // applyDueScheduledRuns excludes plan-only runs, so seed both kinds to
    // ensure the benchmark measures the production predicate.
    const planOnly = status === "confirmed" && Math.floor(i / STATUSES.length) % 2 === 0;
    insert.run(`run-${i}`, ws, status, created, scheduledAt, planOnly ? 1 : 0, JSON.stringify({ "confirmed-at": new Date(created).toISOString() }));
  }
})();

function measure(label: string, fn: () => unknown, iterations = 30): void {
  // Warmup
  fn();
  const times: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`${label.padEnd(52)} median ${median.toFixed(2).padStart(8)}ms   p95 ${p95.toFixed(2).padStart(8)}ms`);
}

const pendingScan = (): void => {
  db.query("SELECT id FROM runs WHERE status = 'pending' ORDER BY created_at LIMIT 50").all();
};
const workspaceList = (): void => {
  db.query("SELECT id FROM runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20").all("ws-42");
};
const confirmedDue = (): void => {
  db.query("SELECT id FROM runs WHERE status = 'confirmed' AND plan_only = 0 AND scheduled_at IS NOT NULL AND scheduled_at <= ? LIMIT 50").all(now);
};

console.log(`\nRuns table: ${RUNS} rows, ${WORKSPACES} workspaces (${db.query("SELECT COUNT(*) FROM runs").get() as object})\n`);
console.log("=== BASELINE (no indexes) ===");
measure("pending queue scan (pollWorkerQueue)", pendingScan);
measure("workspace run list", workspaceList);
measure("confirmed+scheduled due (applyDueScheduledRuns)", confirmedDue);

console.log("\n=== AFTER INDEXES ===");
db.run("CREATE INDEX runs_workspace_status_created_idx ON runs (workspace_id, status, created_at)");
db.run("CREATE INDEX runs_status_created_idx ON runs (status, created_at)");
db.run("CREATE INDEX runs_status_scheduled_idx ON runs (status, scheduled_at)");
measure("pending queue scan (pollWorkerQueue)", pendingScan);
measure("workspace run list", workspaceList);
measure("confirmed+scheduled due (applyDueScheduledRuns)", confirmedDue);

console.log("\n=== WITH ALL THREE (drop status_created, keep status_scheduled) ===");
db.run("DROP INDEX runs_status_created_idx");
measure("pending queue scan (pollWorkerQueue)", pendingScan);
measure("workspace run list", workspaceList);
measure("confirmed+scheduled due (applyDueScheduledRuns)", confirmedDue);
