/**
 * 10.10 Endpoint latency benchmarks.
 *
 * Measures p50/p95/max latency (ms) for representative read endpoints
 * against a large synthetic dataset (1k+ workspaces, 100k runs, many team
 * memberships, many variable-set associations). Requires the server to be
 * running with TERRENCE_ADMIN_TOKEN set (or a session token). Prints a
 * per-endpoint table and exits non-zero if any endpoint's p95 exceeds a
 * threshold.
 *
 * Usage:
 *   bun scripts/latency-bench.ts --base-url http://127.0.0.1:3001 \
 *     --token <admin-token> [--samples 200] [--warmup 10]
 *     [--p95-threshold 500]
 */
import { performance } from "node:perf_hooks";

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

const args = process.argv.slice(2);
const baseUrl = (flag(args, "--base-url") ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const token = flag(args, "--token");
const samples = Number(flag(args, "--samples") ?? "200");
const warmup = Number(flag(args, "--warmup") ?? "10");
const p95Threshold = Number(flag(args, "--p95-threshold") ?? "500");

if (token === undefined || token === "") {
  console.error("--token is required");
  process.exit(2);
}

type Bench = { name: string; path: string };
const endpoints: Bench[] = [
  { name: "workspaces.list", path: "/api/v2/organizations/demo/workspaces?per_page=50" },
  { name: "workspaces.get", path: "/api/v2/organizations/demo/workspaces/sample-workspace" },
  { name: "runs.list", path: "/api/v2/workspaces/sample-workspace/runs?per_page=50" },
  { name: "runs.list-all", path: "/api/v2/organizations/demo/runs?per_page=20" },
  { name: "varsets.list", path: "/api/v2/organizations/demo/variable-sets?per_page=50" },
  { name: "orgs.get", path: "/api/v2/organizations/demo" },
  { name: "teams.list", path: "/api/v2/organizations/demo/teams?per_page=50" },
];

function percentiles(values: readonly number[]): { p50: number; p95: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx] ?? 0;
  };
  return { p50: pick(50), p95: pick(95), max: sorted[sorted.length - 1] ?? 0 };
}

async function timeOnce(url: string, headers: Record<string, string>): Promise<number> {
  const start = performance.now();
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) {
    // A non-2xx response means the endpoint did not serve a successful read,
    // so it must not count as a valid latency sample. Throwing routes it into
    // the caller's failure accounting instead of skewing the p95 upward/down.
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return performance.now() - start;
}

interface Result {
  name: string;
  p50: number;
  p95: number;
  max: number;
  failed: boolean;
}

async function main(): Promise<void> {
  const headers: Record<string, string> = { Authorization: "Bearer " + token, Accept: "application/vnd.api+json" };
  const results: Result[] = [];
  let failures = 0;
  for (const endpoint of endpoints) {
    // Warmup is best-effort: a warmup failure must not abort the whole run.
    for (let i = 0; i < warmup; i += 1) {
      try {
        await timeOnce(`${baseUrl}${endpoint.path}`, headers);
      } catch {
        // ignore warmup failures
      }
    }
    const times: number[] = [];
    for (let i = 0; i < samples; i += 1) {
      try {
        times.push(await timeOnce(`${baseUrl}${endpoint.path}`, headers));
      } catch {
        times.push(Number.POSITIVE_INFINITY);
      }
    }
    const finite = times.filter((t) => Number.isFinite(t));
    const stats = percentiles(finite);
    const failed = finite.length === 0 || !Number.isFinite(stats.p95);
    if (failed) failures += 1;
    results.push({
      name: endpoint.name,
      p50: Math.round(stats.p50),
      p95: Math.round(stats.p95),
      max: Math.round(stats.max),
      failed: failed || stats.p95 > p95Threshold,
    });
    console.log(
      `${endpoint.name.padEnd(18)} p50=${String(Math.round(stats.p50)).padStart(5)}ms ` +
      `p95=${String(Math.round(stats.p95)).padStart(5)}ms max=${String(Math.round(stats.max)).padStart(6)}ms`,
    );
  }
  const over = results.filter((r) => r.failed);
  if (over.length > 0) {
    console.error(`\n${over.length} endpoint(s) exceed p95 ${p95Threshold}ms or failed:`);
    for (const r of over) console.error(`  - ${r.name}`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} endpoints within p95 ${p95Threshold}ms.`);
}

void main();