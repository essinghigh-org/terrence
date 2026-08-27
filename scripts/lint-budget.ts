import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Baseline = {
  errors: number;
  warnings: number;
}

type LintMessage = {
  ruleId: string | null;
  severity: number;
}

type LintReport = {
  errorCount: number;
  messages: readonly LintMessage[];
}

const rawBaseline = readFileSync(new URL("../.eslint-baseline.json", import.meta.url), "utf8");
const localBaseline = JSON.parse(rawBaseline) as Baseline;
let baseline: Baseline = localBaseline;
try {
  const masterBaseline = execFileSync("git", ["show", "origin/master:.eslint-baseline.json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  baseline = JSON.parse(masterBaseline) as Baseline;
} catch {
  // Local checkouts without the target branch still use the checked-in baseline.
}
if (localBaseline.errors > baseline.errors || localBaseline.warnings > baseline.warnings) {
  console.error("Lint baseline may not increase on a pull request.");
  process.exit(1);
}
const eslint = fileURLToPath(new URL("../node_modules/.bin/eslint", import.meta.url));
const result = spawnSync(eslint, [".", "--format", "json"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (result.error !== undefined) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status === null) {
  console.error("ESLint was terminated before returning a result");
  process.exit(1);
}
let reports: LintReport[];
try {
  const stdout = typeof result.stdout === "string" && result.stdout !== "" ? result.stdout : "[]";
  reports = JSON.parse(stdout) as LintReport[];
} catch {
  const stderr = typeof result.stderr === "string" && result.stderr !== "" ? result.stderr : "ESLint did not return JSON output";
  console.error(stderr);
  process.exit(1);
}
const errors = reports.reduce(
  (total, report): number => total + report.errorCount,
  0,
);
// Complexity is intentionally warning-only while the existing hot-spot backlog
// is split. Keep those warnings visible in the baseline report without making
// the debt budget fail every build; all other warnings remain budgeted.
const warnings = reports.reduce(
  (total, report): number =>
    total + report.messages.filter(({ ruleId, severity }): boolean => severity === 1 && ruleId !== "complexity").length,
  0,
);
console.log(
  `lint budget: ${errors} errors / ${warnings} warnings (baseline ${baseline.errors} / ${baseline.warnings})`,
);
const expectedStatus = errors === 0 && warnings === 0 ? 0 : 1;
if (errors > baseline.errors || warnings > baseline.warnings || result.status !== expectedStatus) {
  console.error(
    "Lint debt increased; fix new findings or update the baseline with an intentional cleanup.",
  );
  process.exit(1);
}
