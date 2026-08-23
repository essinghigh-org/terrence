import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const localBaseline = JSON.parse(readFileSync(new URL("../.eslint-baseline.json", import.meta.url), "utf8"));
let baseline = localBaseline;
try {
  baseline = JSON.parse(execFileSync("git", ["show", "origin/master:.eslint-baseline.json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }));
} catch {
  // Local checkouts without the target branch still use the checked-in baseline.
}
if (localBaseline.errors > baseline.errors || localBaseline.warnings > baseline.warnings) {
  console.error("Lint baseline may not increase on a pull request.");
  process.exit(1);
}
const eslint = fileURLToPath(new URL("../node_modules/.bin/eslint", import.meta.url));
const result = spawnSync(eslint, [".", "--format", "json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (result.error !== undefined) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status === null) {
  console.error("ESLint was terminated before returning a result");
  process.exit(1);
}
let reports;
try {
  reports = JSON.parse(result.stdout || "[]");
} catch {
  console.error(result.stderr || "ESLint did not return JSON output");
  process.exit(1);
}
const errors = reports.reduce((total, report) => total + report.errorCount, 0);
const warnings = reports.reduce((total, report) => total + report.warningCount, 0);
console.log(`lint budget: ${errors} errors / ${warnings} warnings (baseline ${baseline.errors} / ${baseline.warnings})`);
const expectedStatus = errors === 0 && warnings === 0 ? 0 : 1;
if (errors > baseline.errors || warnings > baseline.warnings || result.status !== expectedStatus) {
  console.error("Lint debt increased; fix new findings or update the baseline with an intentional cleanup.");
  process.exit(1);
}
