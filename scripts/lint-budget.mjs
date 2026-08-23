import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const baseline = JSON.parse(readFileSync(new URL("../.eslint-baseline.json", import.meta.url), "utf8"));
const eslint = fileURLToPath(new URL("../node_modules/.bin/eslint", import.meta.url));
const result = spawnSync(eslint, [".", "--format", "json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (result.error !== undefined) {
  console.error(result.error.message);
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
if (errors > baseline.errors || warnings > baseline.warnings || result.status !== 0 && errors === 0) {
  console.error("Lint debt increased; fix new findings or update the baseline with an intentional cleanup.");
  process.exit(1);
}
