/**
 * coverage-report.ts — run the backend suite under coverage and report
 * per-directory rollups, flagging modules below a threshold (kanban 22.3).
 *
 * Bun's coverage output only lists files that were actually imported during
 * the test run, so a source module that no test exercises never appears in
 * the lcov output at all. This script therefore reports two classes of
 * exposure:
 *
 *   1. covered files below the threshold (partial coverage), and
 *   2. source files completely absent from the coverage run (zero coverage —
 *      never imported by any test).
 *
 * Usage (from the backend directory):
 *   bun run scripts/coverage-report.ts              # text report, exit 0
 *   bun run scripts/coverage-report.ts --json       # machine-readable
 *   bun run scripts/coverage-report.ts --fail       # exit 1 on any exposure
 *   bun run scripts/coverage-report.ts --threshold=50 --fail
 *
 * Options:
 *   --json               emit one JSON document instead of the text report
 *   --fail               exit 1 when any tracked module is below threshold
 *   --threshold=<pct>    coverage floor (default 60; env COVERAGE_THRESHOLD)
 *   --include=<dir>      only report files under this src subdirectory
 *                        (repeatable; default: whole backend/src)
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";

const BACKEND_DIR = import.meta.dir.includes("/backend/")
  ? import.meta.dir.slice(0, import.meta.dir.indexOf("/backend/") + "/backend".length)
  : import.meta.dir;
const SRC_DIR = join(BACKEND_DIR, "src");

const jsonOutput = process.argv.includes("--json");
const failOnExposure = process.argv.includes("--fail");
const thresholdArg = process.argv.find((arg) => arg.startsWith("--threshold="));
const includeDirs = process.argv
  .filter((arg) => arg.startsWith("--include="))
  .map((arg) => arg.slice("--include=".length));
const threshold = Number(
  thresholdArg?.slice("--threshold=".length)
    ?? process.env.COVERAGE_THRESHOLD
    ?? 60,
);

if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
  console.error(`Invalid threshold: ${threshold}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 1. Run the suite under coverage into a throwaway directory.
// ---------------------------------------------------------------------------
const coverageDir = mkdtempSync(join(tmpdir(), "terrence-cov-"));
const testDirs = ["tests/unit/", "tests/db/", "tests/api/", "tests/worker/"];
const run = spawnSync(
  "bun",
  ["test", "--coverage", "--coverage-reporter=lcov", "--coverage-dir", coverageDir, ...testDirs],
  { cwd: BACKEND_DIR, encoding: "utf8", timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
);

if (run.status !== 0) {
  console.error(`Coverage run failed (exit ${run.status}):\n${run.stderr ?? run.stdout}`);
  rmSync(coverageDir, { recursive: true, force: true });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Parse lcov records (SF/LF/LH).
// ---------------------------------------------------------------------------
interface LcovRecord {
  file: string;
  lf: number;
  lh: number;
}

function parseLcov(text: string): LcovRecord[] {
  const records: LcovRecord[] = [];
  let current: LcovRecord | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = { file: line.slice(3), lf: 0, lh: 0 };
      records.push(current);
    } else if (line.startsWith("LF:") && current !== null) {
      current.lf = Number(line.slice(3));
    } else if (line.startsWith("LH:") && current !== null) {
      current.lh = Number(line.slice(3));
    }
  }
  return records;
}

const lcovPath = join(coverageDir, "lcov.info");
const records = parseLcov(readFileSync(lcovPath, "utf8"))
  .filter((record) => record.file.startsWith("src/"))
  .map((record) => ({
    ...record,
    pct: record.lf === 0 ? 100 : (record.lh / record.lf) * 100,
  }))
  .sort((a, b) => a.pct - b.pct || a.file.localeCompare(b.file));

// ---------------------------------------------------------------------------
// 3. Enumerate the tracked source tree to find never-imported modules.
// ---------------------------------------------------------------------------
function walkSrc(dir: string): string[] {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules") continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkSrc(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const coveredFiles = new Set(records.map((record) => record.file));
const uncovered = walkSrc(SRC_DIR)
  .map((path) => relative(BACKEND_DIR, path))
  .filter((path) => !coveredFiles.has(path))
  .sort();

const tracked = (file: string): boolean =>
  includeDirs.length === 0 || includeDirs.some((dir) => file.startsWith(`src/${dir}/`));

const belowThreshold = records.filter((record) => tracked(record.file) && record.pct < threshold);
const uncoveredTracked = uncovered.filter((file) => tracked(file));

const rollups = new Map<string, { lf: number; lh: number }>();
for (const record of records) {
  const parts = relative(SRC_DIR, record.file).split(sep);
  const group = parts.length > 1 ? parts[0] : "(root)";
  const entry = rollups.get(group) ?? { lf: 0, lh: 0 };
  entry.lf += record.lf;
  entry.lh += record.lh;
  rollups.set(group, entry);
}

rmSync(coverageDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 4. Report.
// ---------------------------------------------------------------------------
interface ReportShape {
  threshold: number;
  totalFiles: number;
  coveredFiles: number;
  uncoveredFiles: number;
  totalLines: number;
  coveredLines: number;
  lineCoveragePct: number;
  belowThreshold: Array<{ file: string; pct: number; lf: number; lh: number }>;
  uncovered: string[];
  rollups: Array<{ dir: string; pct: number; lf: number; lh: number }>;
}

const totalLf = records.reduce((sum, record) => sum + record.lf, 0);
const totalLh = records.reduce((sum, record) => sum + record.lh, 0);
const report: ReportShape = {
  threshold,
  totalFiles: records.length,
  coveredFiles: records.length,
  uncoveredFiles: uncovered.length,
  totalLines: totalLf,
  coveredLines: totalLh,
  lineCoveragePct: totalLf === 0 ? 100 : (totalLh / totalLf) * 100,
  belowThreshold: belowThreshold.map((record) => ({
    file: record.file,
    pct: Math.round(record.pct * 10) / 10,
    lf: record.lf,
    lh: record.lh,
  })),
  uncovered,
  rollups: [...rollups.entries()]
    .map(([dir, { lf, lh }]) => ({
      dir,
      pct: lf === 0 ? 100 : Math.round(((lh / lf) * 100) * 10) / 10,
      lf,
      lh,
    }))
    .sort((a, b) => a.pct - b.pct),
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Line coverage: ${report.lineCoveragePct.toFixed(1)}% (${report.coveredLines}/${report.totalLines}) across ${report.totalFiles} imported files`);
  console.log(`Threshold: ${threshold}% — ${report.belowThreshold.length} file(s) below, ${report.uncovered.length} file(s) never imported by any test\n`);
  console.log("Per-directory rollups (worst first):");
  for (const rollup of report.rollups) {
    console.log(`  ${rollup.dir.padEnd(14)} ${rollup.pct.toFixed(1).padStart(6)}%  (${rollup.lh}/${rollup.lf})`);
  }
  if (belowThreshold.length > 0) {
    console.log("\nBelow threshold:");
    for (const file of belowThreshold) {
      console.log(`  ${file.pct.toFixed(1).padStart(6)}%  ${file.file} (${file.lh}/${file.lf})`);
    }
  }
  if (uncoveredTracked.length > 0) {
    console.log("\nNever imported (zero coverage):");
    for (const file of uncoveredTracked) {
      console.log(`    0.0%  ${file}`);
    }
  }
}

process.exit(failOnExposure && (belowThreshold.length > 0 || uncoveredTracked.length > 0) ? 1 : 0);
