// Benchmark runner: seeds a fresh temp database, then measures latency and SQL
// query counts for every scenario through the real Elysia app (app.handle).
//
// Usage:
//   bun run bench/run.ts                    # table output
//   bun run bench/run.ts --json /tmp/before.json --iterations 30
//
// The environment is set BEFORE the app/db modules load (they read env at
// import time). The worker poll loop is disabled so no background queries
// leak into measurements.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

process.env.NODE_ENV = "bench";
process.env.TERRENCE_DISABLE_WORKER = "1";
process.env.TERRENCE_QUERY_COUNT = "1";
process.env.RATE_LIMIT_MAX = "1000000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "1000000";
process.env.RATE_LIMIT_SSO_GET_MAX = "1000000";
const benchDir = mkdtempSync(join(tmpdir(), "terrence-bench-"));
process.env.DATABASE_URL = `file:${join(benchDir, "bench.db")}`;
process.env.STORAGE_DIR = join(benchDir, "storage");

function parseArgs(): { iterations: number; warmup: number; jsonOut: string | null; filter: string | null } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const index = args.indexOf(flag);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
  };
  const getCount = (flag: string, fallback: string, minimum: number): number => {
    const value = Number(get(flag) ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`${flag} must be an integer greater than or equal to ${minimum}`);
    }
    return value;
  };
  return {
    iterations: getCount("--iterations", "30", 1),
    warmup: getCount("--warmup", "5", 0),
    jsonOut: get("--json"),
    filter: get("--scenario"),
  };
}

interface ScenarioResult {
  name: string;
  path: string;
  status: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  reqPerSec: number;
  queriesPerReq: number;
  queryCounts: number[];
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function main(): Promise<void> {
  const { iterations, warmup, jsonOut, filter } = parseArgs();
  const [{ app }, dbMod, { seedBenchmark }, { buildScenarios, tokenFor }] = await Promise.all([
    import("../src/app"),
    import("../src/db"),
    import("./seed"),
    import("./scenarios"),
  ]);
  const scenarios = buildScenarios().filter((s): boolean => filter === null || s.name === filter);
  if (scenarios.length === 0) {
    throw new Error(filter === null
      ? "No benchmark scenarios are defined"
      : `No benchmark scenario matches "${filter}"`);
  }
  const ctx = await seedBenchmark();

  const runOne = async (path: string, token: string): Promise<{ status: number; ms: number; queries: number }> => {
    dbMod.resetQueryCount();
    const request = new Request(`http://bench.local${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const started = performance.now();
    const response = await app.handle(request);
    await response.text(); // force full body serialization
    const ms = performance.now() - started;
    return { status: response.status, ms, queries: dbMod.getQueryCount() };
  };

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const path = scenario.path(ctx);
    const token = tokenFor(ctx, scenario.token);
    for (let i = 0; i < warmup; i += 1) {
      await runOne(path, token);
    }
    const latencies: number[] = [];
    const queryCounts: number[] = [];
    let status = 0;
    for (let i = 0; i < iterations; i += 1) {
      const outcome = await runOne(path, token);
      status = outcome.status;
      latencies.push(outcome.ms);
      queryCounts.push(outcome.queries);
    }
    latencies.sort((a, b): number => a - b);
    const avgMs = latencies.reduce((sum, value): number => sum + value, 0) / latencies.length;
    results.push({
      name: scenario.name,
      path,
      status,
      avgMs,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      maxMs: latencies[latencies.length - 1] ?? 0,
      reqPerSec: 1000 / avgMs,
      queriesPerReq: queryCounts.reduce((sum, value): number => sum + value, 0) / queryCounts.length,
      queryCounts,
    });
  }

  // Machine-readable report (before/after comparison consumes this).
  if (jsonOut !== null) {
    const { writeFile } = await import("node:fs/promises");
    const git = await import("node:child_process");
    const commit = git.execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
    await writeFile(jsonOut, JSON.stringify({
      commit,
      timestamp: new Date().toISOString(),
      iterations,
      results: results.map(({ queryCounts, ...rest }): Omit<ScenarioResult, "queryCounts"> => rest),
    }, null, 2));
    console.log(`Wrote ${jsonOut}`);
  }

  const pad = (value: string, width: number): string => value.padEnd(width);
  console.log(`\n${"scenario".padEnd(32)} ${"status".padEnd(6)} ${"avg ms".padStart(9)} ${"p50".padStart(9)} ${"p95".padStart(9)} ${"max".padStart(9)} ${"rps".padStart(8)} ${"sql/req".padStart(8)}`);
  console.log("-".repeat(100));
  for (const result of results) {
    console.log(
      `${pad(result.name, 32)} ${pad(String(result.status), 6)} ${pad(result.avgMs.toFixed(2), 9)} `
      + `${pad(result.p50Ms.toFixed(2), 9)} ${pad(result.p95Ms.toFixed(2), 9)} ${pad(result.maxMs.toFixed(2), 9)} `
      + `${pad(result.reqPerSec.toFixed(1), 8)} ${pad(result.queriesPerReq.toFixed(1), 8)}`,
    );
  }
  console.log("-".repeat(100));
}

void main().catch((error: unknown): void => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});
