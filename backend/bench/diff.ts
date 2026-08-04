// Compare two benchmark reports (before/after) and print the delta for latency
// and SQL query counts. Exits 1 if any scenario regressed on both metrics.
//
// Usage: bun run bench/diff.ts /tmp/before.json /tmp/after.json
import { readFileSync } from "node:fs";

interface Report {
  commit: string;
  iterations: number;
  results: { name: string; status: number; avgMs: number; p95Ms: number; reqPerSec: number; queriesPerReq: number }[];
}

function load(path: string): Report {
  return JSON.parse(readFileSync(path, "utf8")) as Report;
}

function pct(before: number, after: number): string {
  if (before === 0) return "—";
  const change = ((after - before) / before) * 100;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(1)}%`;
}

const [beforePath, afterPath] = process.argv.slice(2);
if (beforePath === undefined || afterPath === undefined) {
  console.error("Usage: bun run bench/diff.ts <before.json> <after.json>");
  process.exit(2);
}

const before = load(beforePath);
const after = load(afterPath);
const beforeByName = new Map(before.results.map((r): [string, typeof r] => [r.name, r]));
const afterByName = new Map(after.results.map((r): [string, typeof r] => [r.name, r]));
const names = [...new Set([...beforeByName.keys(), ...afterByName.keys()])].sort();

console.log(`before: ${before.commit}  after: ${after.commit}  (iterations ${after.iterations})\n`);
console.log(`${"scenario".padEnd(32)} ${"lat Δ%".padStart(8)} ${"avg b→a".padStart(14)} ${"p95 b→a".padStart(14)} ${"queries Δ%".padStart(10)} ${"sql b→a".padStart(14)}`);
console.log("-".repeat(96));

let regressed = false;
for (const name of names) {
  const b = beforeByName.get(name);
  const a = afterByName.get(name);
  if (b === undefined) {
    console.log(`${name.padEnd(32)} ${"new".padStart(8)}`);
    continue;
  }
  if (a === undefined) {
    console.log(`${name.padEnd(32)} ${"missing".padStart(8)}`);
    regressed = true;
    continue;
  }
  // A scenario whose status changed between runs must fail the comparison — a
  // 401/500 can look "faster" with fewer queries and mask a real problem.
  if (b.status !== a.status) {
    console.log(`${name.padEnd(32)} ${"status".padStart(8)} ${`${b.status}→${a.status}`.padStart(14)}`);
    regressed = true;
    continue;
  }
  const latencyDelta = pct(b.avgMs, a.avgMs);
  const queryDelta = pct(b.queriesPerReq, a.queriesPerReq);
  const flagged = a.avgMs > b.avgMs * 1.1 && a.queriesPerReq > b.queriesPerReq * 1.1;
  if (flagged) regressed = true;
  console.log(
    `${name.padEnd(32)} ${latencyDelta.padStart(8)} `
    + `${`${b.avgMs.toFixed(1)}→${a.avgMs.toFixed(1)}`.padStart(14)} `
    + `${`${b.p95Ms.toFixed(1)}→${a.p95Ms.toFixed(1)}`.padStart(14)} `
    + `${queryDelta.padStart(8)} ${`${b.queriesPerReq.toFixed(0)}→${a.queriesPerReq.toFixed(0)}`.padStart(14)} `
    + (flagged ? "  ← REGRESSION" : ""),
  );
}
console.log("-".repeat(96));
if (regressed) {
  console.error("⚠ One or more scenarios regressed on the fast path.");
  process.exit(1);
}