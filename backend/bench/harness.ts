/**
 * Minimal benchmark harness (this Bun build has no `bun bench` subcommand).
 *
 * Usage from a bench file:
 *   import { suite } from "./harness";
 *   suite("group-name", {
 *     "label": () => { ... },
 *   });
 *   // or with --json out.json: suite writes a machine-readable record
 *   // so before/after runs can be diffed.
 */
export type BenchFn = () => unknown | Promise<unknown>;

type SuiteResult = Readonly<{
  name: string;
  label: string;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  opsPerSec: number;
  iterations: number;
}>;

import { writeFileSync } from "node:fs";

const results: SuiteResult[] = [];
let suiteName = "";
const DEFAULT_ITERATIONS = 40;
const WARMUP_RUNS = 3;

export async function suite(
  name: string,
  fns: Readonly<Record<string, BenchFn>>,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<void> {
  suiteName = name;
  for (const [label, fn] of Object.entries(fns)) {
    // Warmup (also flushes lazy caches / JIT tiers). Async fns are awaited so
    // concurrent requests can never race each other inside the benchmark.
    for (let i = 0; i < WARMUP_RUNS; i += 1) await fn();
    const times: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const start = performance.now();
      await fn();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)] ?? 0;
    const p95 = times[Math.floor(times.length * 0.95)] ?? times[times.length - 1] ?? 0;
    const min = times[0] ?? 0;
    const avg = times.reduce((a, b) => a + b, 0) / Math.max(times.length, 1);
    results.push({
      name,
      label,
      medianMs: Number(median.toFixed(3)),
      p95Ms: Number(p95.toFixed(3)),
      minMs: Number(min.toFixed(3)),
      opsPerSec: Number((1000 / Math.max(avg, 0.001)).toFixed(1)),
      iterations,
    });
  }
}

/** Print the collected results. Returns them for programmatic use. */
export function report(jsonPath?: string): SuiteResult[] {
  // --json <path> works from any caller (explicit arg wins over argv).
  if (jsonPath === undefined) {
    const flag = process.argv.indexOf("--json");
    if (flag >= 0) jsonPath = process.argv[flag + 1];
  }
  const width = Math.max(...results.map((r) => r.name.length + r.label.length + 3), 30);
  console.log(`\n${"benchmark".padEnd(width)} median     p95      min    ops/s`);
  console.log("-".repeat(width + 44));
  for (const r of results) {
    const label = `${r.name} > ${r.label}`;
    console.log(
      `${label.padEnd(width)} ${String(r.medianMs).padStart(7)}ms ${String(r.p95Ms).padStart(7)}ms ${String(r.minMs).padStart(7)}ms ${String(r.opsPerSec).padStart(9)}`,
    );
  }
  if (jsonPath !== undefined) {
    writeFileSync(jsonPath, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    console.log(`\nresults written to ${jsonPath}`);
  }
  return results;
}

// Standalone invocation: `bun run bench/foo.ts [--json out.json]`
if (import.meta.main) {
  const jsonFlag = process.argv.indexOf("--json");
  const jsonPath = jsonFlag >= 0 ? process.argv[jsonFlag + 1] : undefined;
  report(jsonPath);
}
