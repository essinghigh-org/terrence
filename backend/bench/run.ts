// Benchmark runner: seeds a fresh temp database, then measures latency and SQL
// query counts for every scenario through the real Elysia app (app.handle).
//
// Usage:
//   bun run bench/run.ts                    # table output
//   bun run bench/run.ts --json /tmp/before.json --iterations 30
//   bun run bench/run.ts --query-breakdown run.detail
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

function parseArgs(): { iterations: number; warmup: number; jsonOut: string | null; filter: string | null; queryBreakdown: string | null; memory: boolean } {
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
    queryBreakdown: get("--query-breakdown"),
    memory: args.includes("--memory"),
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

/**
 * Normalize a SQL statement into a stable shape (strip literal values) so
 * repeated statements can be grouped regardless of the bound values. Table and
 * column names are preserved so the breakdown stays readable; only string
 * literals and bare numbers are masked (drizzle parameterizes its values, so
 * this only matters for inline constants like LIMIT offsets).
 */
function normalizeSql(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/g, "'?'")
    .replace(/\b[0-9]+\b/g, "?");
}

async function main(): Promise<void> {
  const { iterations, warmup, jsonOut, filter, queryBreakdown, memory } = parseArgs();
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

  // Per-request helper: build the request, run it, force body serialization.
  const runOne = async (scenario: (typeof scenarios)[number], iteration: number): Promise<{ status: number; ms: number; queries: number }> => {
    const token = tokenFor(ctx, scenario.token);
    const path = scenario.path(ctx, iteration);
    const method = scenario.method ?? "GET";
    const body = scenario.body?.(ctx, iteration);
    dbMod.resetQueryCount();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let init: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/vnd.api+json";
      init = JSON.stringify(body);
    }
    const request = new Request(`http://bench.local${path}`, { method, headers, body: init });
    const started = performance.now();
    const response = await app.handle(request);
    await response.text(); // force full body serialization
    const ms = performance.now() - started;
    return { status: response.status, ms, queries: dbMod.getQueryCount() };
  };

  // Query-log breakdown mode: run the scenario a handful of times with SQL
  // capture enabled and report the most-repeated statements.
  if (queryBreakdown !== null) {
    const target = scenarios.find((s): boolean => s.name === queryBreakdown);
    if (target === undefined) {
      throw new Error(`No scenario matches --query-breakdown ${queryBreakdown}`);
    }
    dbMod.setQueryLogging(true);
    const perStatement = new Map<string, number>();
    for (let i = 0; i < Math.max(iterations, 10); i += 1) {
      dbMod.resetQueryCount();
      const body = target.body?.(ctx, i);
      const request = new Request(`http://bench.local${target.path(ctx, i)}`, {
        method: target.method ?? "GET",
        headers: {
          Authorization: `Bearer ${tokenFor(ctx, target.token)}`,
          ...(body !== undefined ? { "Content-Type": "application/vnd.api+json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const response = await app.handle(request);
      await response.text();
      for (const sql of dbMod.getQueryLog()) {
        const key = normalizeSql(sql);
        perStatement.set(key, (perStatement.get(key) ?? 0) + 1);
      }
    }
    dbMod.setQueryLogging(false);
    const total = [...perStatement.values()].reduce((sum, value): number => sum + value, 0);
    console.log(`\nQuery breakdown for "${target.name}" (${total} statements over ${Math.max(iterations, 10)} runs)\n`);
    console.log(`${"count".padStart(6)} ${"sql"}`);
    console.log("-".repeat(120));
    const sorted = [...perStatement.entries()].sort((a, b): number => b[1] - a[1]);
    for (const [sql, count] of sorted) {
      console.log(`${String(count).padStart(6)} ${sql}`);
    }
    console.log(`\n${String(total).padStart(6)} total`);
    return;
  }

  const results: ScenarioResult[] = [];
  let peakRss = memory ? process.memoryUsage().rss : 0;
  for (const scenario of scenarios) {
    const path = scenario.path(ctx, 0);
    for (let i = 0; i < warmup; i += 1) {
      await runOne(scenario, i);
    }
    const latencies: number[] = [];
    const queryCounts: number[] = [];
    let status = 0;
    for (let i = 0; i < iterations; i += 1) {
      const outcome = await runOne(scenario, warmup + i);
      status = outcome.status;
      latencies.push(outcome.ms);
      queryCounts.push(outcome.queries);
      if (memory) {
        const rss = process.memoryUsage().rss;
        peakRss = Math.max(peakRss, rss);
      }
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
      ...(memory ? { peakRssMb: Math.round(peakRss / 1024 / 1024) } : {}),
      results: results.map(({ queryCounts, ...rest }): Omit<ScenarioResult, "queryCounts"> => rest),
    }, null, 2));
    console.log(`Wrote ${jsonOut}`);
  }

  const pad = (value: string, width: number): string => value.padEnd(width);
  console.log(`\n${"scenario".padEnd(36)} ${"m".padEnd(4)} ${"status".padEnd(6)} ${"avg ms".padStart(9)} ${"p50".padStart(9)} ${"p95".padStart(9)} ${"max".padStart(9)} ${"rps".padStart(8)} ${"sql/req".padStart(8)}`);
  console.log("-".repeat(110));
  for (const result of results) {
    console.log(
      `${pad(result.name, 36)} ${pad(scenarios.find((s): boolean => s.name === result.name)?.method ?? "GET", 4)} ${pad(String(result.status), 6)} ${pad(result.avgMs.toFixed(2), 9)} `
      + `${pad(result.p50Ms.toFixed(2), 9)} ${pad(result.p95Ms.toFixed(2), 9)} ${pad(result.maxMs.toFixed(2), 9)} `
      + `${pad(result.reqPerSec.toFixed(1), 8)} ${pad(result.queriesPerReq.toFixed(1), 8)}`,
    );
  }
  console.log("-".repeat(110));
  if (memory) console.log(`peak RSS: ${Math.round(peakRss / 1024 / 1024)} MiB`);
}

void main().catch((error: unknown): void => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});
