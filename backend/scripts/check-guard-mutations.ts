import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const backend = resolve(import.meta.dir, "..");
const mutations = [
  {
    name: "state permission cannot become run permission",
    file: "src/routes/runs.ts",
    before: 'findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null, "state-read")',
    after: 'findAuthorizedRun(runId, user?.id, orgId ?? null, teamId ?? null, "run-read")',
    occurrences: 2,
    testFile: "tests/api/run_state_capabilities.test.ts",
    testName: "run-read alone cannot mint state capabilities",
  },
  {
    name: "public plan must retain its sensitivity mask",
    file: "src/lib/plan-json.ts",
    before: "      after_sensitive: afterMask,",
    after: "",
    occurrences: 1,
    testFile: "tests/unit/plan-json.test.ts",
    testName: "public plan version preserves absent/null values",
  },
  {
    name: "public plan must redact after values",
    file: "src/lib/plan-json.ts",
    before: 'after: redact(object["after"], afterMask)',
    after: 'after: object["after"]',
    occurrences: 1,
    testFile: "tests/unit/plan-json.test.ts",
    testName: "public projection excludes secrets in every raw representation",
  },
  {
    name: "lexically earlier variable set wins",
    file: "src/lib/variable-set-precedence.ts",
    before: "compareCodePoints(right.name, left.name)",
    after: "compareCodePoints(left.name, right.name)",
    occurrences: 1,
    testFile: "tests/unit/variable_precedence_matrix.test.ts",
    testName: "lexically earliest non-priority set wins ties",
  },
  {
    name: "run deletion requires a final state",
    file: "src/routes/runs.ts",
    before: ", inArray(runs.status, FINAL_RUN_STATUSES)",
    after: "",
    occurrences: 1,
    testFile: "tests/api/run_state_capabilities.test.ts",
    testName: "run deletion rejects every non-final status",
  },
] as const;

const temporary = mkdtempSync(join(tmpdir(), "terrence-mutations-"));
try {
  const copy = join(temporary, "backend");
  cpSync(backend, copy, {
    recursive: true,
    filter: (path): boolean => !["node_modules", "storage", "bin", "coverage", ".env", ".env.local"].includes(basename(path)),
  });
  symlinkSync(join(backend, "../node_modules"), join(temporary, "node_modules"), "dir");
  symlinkSync(join(backend, "node_modules"), join(copy, "node_modules"), "dir");
  const environment = { PATH: process.env["PATH"], HOME: temporary, NODE_ENV: "test", NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const mutation of mutations) {
    const path = join(copy, mutation.file);
    const original = readFileSync(path, "utf8");
    if (original.split(mutation.before).length - 1 !== mutation.occurrences) {
      throw new Error(`Mutation anchor changed: ${mutation.name}; review the guard and update its mutation`);
    }
    const run = (): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [
      "test", mutation.testFile, "--test-name-pattern", mutation.testName, "--max-concurrency=1", "--no-orphans",
    ], { cwd: copy, env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    const baseline = run();
    const baselineOutput = `${String(baseline.stdout)}${String(baseline.stderr)}`;
    if (baseline.error !== undefined || baseline.status !== 0 || !baselineOutput.includes(`(pass) ${mutation.testName}`) && !baselineOutput.split("\n").some((line) => line.includes("(pass)") && line.includes(mutation.testName))) {
      throw new Error(`Baseline failed or did not execute: ${mutation.name}\n${baselineOutput}`);
    }
    writeFileSync(path, original.replaceAll(mutation.before, mutation.after));
    const mutated = run();
    writeFileSync(path, original);
    const output = `${String(mutated.stdout)}${String(mutated.stderr)}`;
    // Syntax errors, startup failures, timeouts and output exhaustion are
    // infrastructure failures, never successful mutation detection.
    if (mutated.error !== undefined || mutated.signal !== null || mutated.status === 0
      || !output.includes("error: expect(")
      || !output.split("\n").some((line) => line.includes("(fail)") && line.includes(mutation.testName))) {
      throw new Error(`Mutation survived or failed outside the named assertion: ${mutation.name}\n${output}`);
    }
    console.log(`Detected: ${mutation.name} — ${mutation.testFile}: ${mutation.testName}`);
  }
  console.log(`All ${mutations.length} guard mutations detected by their named tests.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
