import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { extractValidatedModuleArchive, moduleRootPath } from "./registry-module-archive";

const MODULE_TEST_DIR = resolve(
  process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"),
  "module-tests",
);

export type ModuleTestConfiguration = Readonly<{
  verbose: boolean;
  filters: readonly string[];
  testDirectory: string;
  variables: readonly Readonly<{ key: string; value: string }>[];
}>;

export type ModuleTestEnvironmentFactory = (stagingDirectory: string) => Promise<Readonly<Record<string, string>>>;

export type ModuleTestResult = Readonly<{
  id: string;
  status: "passed" | "failed" | "errored";
  testsPassed: number;
  testsFailed: number;
  testsErrored: number;
  testsSkipped: number;
  configuration: ModuleTestConfiguration;
  output: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}>;

function safeRelativePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return normalized !== ""
    && !normalized.startsWith("/")
    && !normalized.split("/").includes("..");
}

export function moduleTestConfiguration(input: unknown): ModuleTestConfiguration | Readonly<{ error: string }> {
  const payload = input !== null && typeof input === "object" ? input as Record<string, unknown> : {};
  const rawData = payload.data;
  const data = rawData !== null && typeof rawData === "object" ? rawData as Record<string, unknown> : {};
  if (data.type !== undefined && data.type !== "module-tests" && data.type !== "test-runs") {
    return { error: "data.type must be module-tests or test-runs" };
  }
  const rawAttributes = data.attributes;
  const attributes = rawAttributes !== null && typeof rawAttributes === "object"
    ? rawAttributes as Record<string, unknown>
    : {};
  const verbose = attributes.verbose ?? false;
  const rawFilters = attributes.filters ?? [];
  const testDirectory = attributes["test-directory"] ?? "tests";
  const rawVariables = attributes.variables ?? [];
  if (typeof verbose !== "boolean") return { error: "verbose must be a boolean" };
  if (
    !Array.isArray(rawFilters)
    || rawFilters.length > 100
    || rawFilters.some((filter: unknown): boolean => typeof filter !== "string" || !safeRelativePath(filter))
  ) {
    return { error: "filters must contain at most 100 safe relative paths" };
  }
  if (typeof testDirectory !== "string" || !safeRelativePath(testDirectory)) {
    return { error: "test-directory must be a safe relative path" };
  }
  if (!Array.isArray(rawVariables)) return { error: "variables must be an array" };
  const variables: { key: string; value: string }[] = [];
  for (const rawVariable of rawVariables) {
    if (rawVariable === null || typeof rawVariable !== "object") return { error: "variables entries must be objects" };
    const variable = rawVariable as Record<string, unknown>;
    const key = variable.key;
    const rawValue = variable.value;
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { error: "variable keys must be valid Terraform identifiers" };
    }
    const value = typeof rawValue === "string"
      ? rawValue
      : typeof rawValue === "number" || typeof rawValue === "boolean"
        ? rawValue.toString()
        : undefined;
    if (value === undefined) return { error: `variable ${key} must have a string, number, or boolean value` };
    variables.push({ key, value });
  }
  return {
    verbose,
    filters: rawFilters as string[],
    testDirectory,
    variables,
  };
}

function summary(output: string): Readonly<{ passed: number; failed: number; errored: number; skipped: number }> {
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let skipped = 0;
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const rawSummary = event.test_summary;
      if (rawSummary !== null && typeof rawSummary === "object") {
        const testSummary = rawSummary as Record<string, unknown>;
        passed = typeof testSummary.passed === "number" ? testSummary.passed : passed;
        failed = typeof testSummary.failed === "number" ? testSummary.failed : failed;
        errored = typeof testSummary.errored === "number" ? testSummary.errored : errored;
        skipped = typeof testSummary.skipped === "number" ? testSummary.skipped : skipped;
      }
    } catch {
      // Non-JSON stderr and older CLI output are parsed below.
    }
  }
  const textSummary = /(\d+)\s+passed,\s*(\d+)\s+failed(?:,\s*(\d+)\s+errored)?(?:,\s*(\d+)\s+skipped)?/i.exec(output);
  if (textSummary !== null) {
    passed = Number(textSummary[1] ?? passed);
    failed = Number(textSummary[2] ?? failed);
    errored = Number(textSummary[3] ?? errored);
    skipped = Number(textSummary[4] ?? skipped);
  }
  return { passed, failed, errored, skipped };
}

function resultPath(versionId: string): string {
  return join(MODULE_TEST_DIR, `${versionId}.json`);
}

export async function readModuleTestResult(versionId: string): Promise<ModuleTestResult | undefined> {
  const file = Bun.file(resultPath(versionId));
  if (!(await file.exists())) return undefined;
  try {
    return await file.json() as ModuleTestResult;
  } catch {
    return undefined;
  }
}

async function writeResult(versionId: string, result: ModuleTestResult): Promise<void> {
  await writeModuleTestResultFile(resultPath(versionId), result);
}

export async function writeModuleTestResultFile(path: string, result: ModuleTestResult): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
  await rename(temporary, path);
}

export async function runModuleTest(
  versionId: string,
  archivePath: string,
  configuration: ModuleTestConfiguration,
  signal?: AbortSignal,
  environmentFactory?: ModuleTestEnvironmentFactory,
): Promise<ModuleTestResult> {
  const createdAt = new Date().toISOString();
  const staging = await mkdtemp(join(tmpdir(), "terrence-module-test-"));
  let result: ModuleTestResult;
  try {
    await extractValidatedModuleArchive(archivePath, staging);
    const root = await moduleRootPath(staging);
    const binary = process.env.TERRAFORM_TEST_BINARY_PATH ?? "terraform";
    const args = [
      binary,
      "test",
      "-json",
      `-test-directory=${configuration.testDirectory}`,
      ...(configuration.verbose ? ["-verbose"] : []),
      ...configuration.filters.map((filter): string => `-filter=${filter}`),
      ...configuration.variables.map((variable): string => `-var=${variable.key}=${variable.value}`),
    ];
    if (signal?.aborted) throw new Error("Module test canceled");
    const inherited = Object.fromEntries(
      [
        "PATH", "HOME", "TMPDIR", "USER", "LANG", "LC_ALL", "SHELL",
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "TF_CLI_CONFIG_FILE", "TF_PLUGIN_CACHE_DIR",
      ]
        .flatMap((key): [string, string][] => typeof process.env[key] === "string" ? [[key, process.env[key]]] : []),
    );
    const environment = { ...inherited, ...(await environmentFactory?.(staging) ?? {}) };
    const processHandle = Bun.spawn(args, { cwd: root, env: environment, stdout: "pipe", stderr: "pipe" });
    const abort = (): void => { processHandle.kill(); };
    if (signal !== undefined) signal.addEventListener("abort", abort, { once: true });
    let exitCode: number;
    let stdout: string;
    let stderr: string;
    try {
      [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);
    } finally {
      if (processHandle.exitCode === null) processHandle.kill();
      signal?.removeEventListener("abort", abort);
    }
    if (signal?.aborted === true) throw new Error("Module test canceled");
    const output = [stdout.trim(), stderr.trim()]
      .filter((entry): boolean => entry !== "")
      .join("\n");
    const counts = summary(output);
    result = {
      id: `mtest-${versionId}`,
      status: exitCode === 0 ? "passed" : "failed",
      testsPassed: counts.passed,
      testsFailed: counts.failed,
      testsErrored: counts.errored,
      testsSkipped: counts.skipped,
      configuration,
      output,
      error: exitCode === 0 ? null : `terraform test exited with code ${String(exitCode)}`,
      createdAt,
      updatedAt: new Date().toISOString(),
    };
  } catch (error: unknown) {
    result = {
      id: `mtest-${versionId}`,
      status: "errored",
      testsPassed: 0,
      testsFailed: 0,
      testsErrored: 1,
      testsSkipped: 0,
      configuration,
      output: "",
      error: error instanceof Error ? error.message : "Unable to run module tests",
      createdAt,
      updatedAt: new Date().toISOString(),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await writeResult(versionId, result);
  return result;
}

export function moduleTestResource(
  result: ModuleTestResult,
  moduleId: string,
  version: string,
): Record<string, unknown> {
  return {
    id: result.id,
    type: "module-tests",
    attributes: {
      status: result.status === "errored" ? "errored" : "finished",
      "test-status": result.status === "passed" ? "pass" : result.status === "failed" ? "fail" : null,
      "tests-passed": result.testsPassed,
      "tests-failed": result.testsFailed,
      "tests-errored": result.testsErrored,
      "tests-skipped": result.testsSkipped,
      verbose: result.configuration.verbose,
      filters: result.configuration.filters,
      "test-directory": result.configuration.testDirectory,
      variables: result.configuration.variables,
      output: result.output,
      error: result.error,
      "created-at": result.createdAt,
      "updated-at": result.updatedAt,
    },
    relationships: {
      "registry-module": { data: { id: moduleId, type: "registry-modules" } },
      "module-version": { data: { id: version, type: "registry-module-versions" } },
    },
  };
}
