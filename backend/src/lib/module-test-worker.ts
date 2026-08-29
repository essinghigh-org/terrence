import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "bun";
import { db } from "../db";
import {
  moduleTestConfigurations,
  moduleTestConfigurationVersions,
  moduleTestRuns,
  organizations,
  registryModules,
  registryModuleVersions,
  type durableJobs,
} from "../db/schema";
import type { ModuleTestConfiguration, ModuleTestResult } from "./module-tests";
import { revokeWorkloadIdentityTokens, type CredentialProvider } from "./workload-identity";
import { enqueueDurableJob, type DurableJobContext } from "./durable-jobs";
import { log } from "./log";

type Job = Readonly<typeof durableJobs.$inferSelect>;
type ModuleTestRun = Readonly<typeof moduleTestRuns.$inferSelect>;

const MODULE_TEST_EXECUTION_DIR = join(
  process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"),
  "module-tests",
  "runs",
);
const SUPERVISOR_START_TIMEOUT_MS = 30_000;
const MODULE_TEST_EXECUTION_TIMEOUT_MS = 24 * 60 * 60_000;

type SupervisorMarker = Readonly<{ pid: number; startTime: string | null }>;

type SupervisorInput = Readonly<{
  runId: string;
  versionId: string;
  archivePath: string;
  resultPath: string;
  configuration: ModuleTestConfiguration;
  organizationId: string;
  organizationName: string;
  moduleName: string;
  ttlSeconds: number;
  oidcProvider: CredentialProvider | null;
  oidcValues: Record<string, unknown>;
}>;

function runIdFromJob(job: Job): string | undefined {
  const value = job.payload.runId;
  return typeof value === "string" && value !== "" ? value : undefined;
}

function testConfiguration(run: ModuleTestRun): ModuleTestConfiguration {
  return {
    verbose: run.verbose,
    filters: run.filters,
    testDirectory: run.testDirectory,
    variables: run.variables,
  };
}

function supervisorMarkerPath(directory: string): string {
  return join(directory, "supervisor.pid");
}

async function processStartTime(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "EPERM";
  }
}

async function readSupervisorMarker(directory: string): Promise<SupervisorMarker | undefined> {
  try {
    const value = JSON.parse(await readFile(supervisorMarkerPath(directory), "utf8")) as Record<string, unknown>;
    return typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0
      ? { pid: value.pid, startTime: typeof value.startTime === "string" ? value.startTime : null }
      : undefined;
  } catch {
    return undefined;
  }
}

async function processOwned(marker: SupervisorMarker): Promise<boolean> {
  if (!processAlive(marker.pid)) return false;
  if (marker.startTime === null) return true;
  return await processStartTime(marker.pid) === marker.startTime;
}

async function resultAt(path: string): Promise<ModuleTestResult | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as ModuleTestResult;
    return typeof value?.status === "string" && typeof value?.output === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function startSupervisor(input: SupervisorInput): Promise<number> {
  await mkdir(MODULE_TEST_EXECUTION_DIR, { recursive: true, mode: 0o700 });
  const executionDirectory = join(MODULE_TEST_EXECUTION_DIR, input.runId);
  await mkdir(executionDirectory, { recursive: true, mode: 0o700 });
  const inputPath = join(executionDirectory, "input.json");
  const logPath = join(executionDirectory, "supervisor.log");
  await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
  const logFile = await open(logPath, "a", 0o600);
  try {
    const child = spawn([process.execPath, join(import.meta.dir, "module-test-supervisor.ts"), inputPath], {
      detached: true,
      env: process.env,
      stdio: ["ignore", logFile.fd, logFile.fd],
    });
    child.unref();
    const pid = child.pid;
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("Unable to start the module test supervisor");
    await writeFile(supervisorMarkerPath(dirname(inputPath)), JSON.stringify({ pid, startTime: await processStartTime(pid) }), { mode: 0o600 });
    return pid;
  } finally {
    await logFile.close();
  }
}

async function stopSupervisor(marker: SupervisorMarker): Promise<void> {
  if (!(await processOwned(marker))) return;
  try { process.kill(-marker.pid, "SIGTERM"); } catch {
    try { process.kill(marker.pid, "SIGTERM"); } catch { /* already exited */ }
  }
}

async function resultAfterSupervisorExit(resultPath: string): Promise<ModuleTestResult> {
  const finalResult = await resultAt(resultPath);
  if (finalResult !== undefined) return finalResult;
  throw new Error("Module test supervisor exited before publishing its result");
}

async function waitForSupervisor(
  run: ModuleTestRun,
  context: DurableJobContext,
): Promise<ModuleTestResult | undefined> {
  const pid = run.executionPid;
  const resultPath = run.executionResultPath;
  if (pid === null || resultPath === null) throw new Error("Module test execution checkpoint is incomplete");
  const directory = run.executionDirectory ?? dirname(resultPath);
  const marker = await readSupervisorMarker(directory);
  if (marker === undefined || marker.pid !== pid) throw new Error("Module test supervisor ownership checkpoint is missing");
  const deadline = (run.executionStartedAt ?? Date.now()) + MODULE_TEST_EXECUTION_TIMEOUT_MS;
  for (;;) {
    if (await context.canceled()) {
      const latest = await db.query.moduleTestRuns.findFirst({ where: eq(moduleTestRuns.id, run.id) });
      if (latest?.status === "canceled") await stopSupervisor(marker);
      return undefined;
    }
    if (Date.now() >= deadline) {
      await stopSupervisor(marker);
      throw new Error("Module test supervisor exceeded its execution deadline");
    }
    const result = await resultAt(resultPath);
    if (result !== undefined) return result;
    if (!(await processOwned(marker))) {
      return resultAfterSupervisorExit(resultPath);
    }
    if (!await context.heartbeat()) return undefined;
    await new Promise<void>((resolve): void => { setTimeout(resolve, 500); });
  }
}

function oidcInput(
  configuration: Readonly<typeof moduleTestConfigurations.$inferSelect> | undefined,
): Readonly<{ provider: CredentialProvider | null; values: Record<string, unknown> }> {
  if (configuration?.oidcEnabled !== true || configuration.oidcProvider === null || !["aws", "gcp", "azure", "vault"].includes(configuration.oidcProvider)) {
    return { provider: null, values: {} };
  }
  const rawValues = configuration.oidcConfiguration;
  return {
    provider: configuration.oidcProvider as CredentialProvider,
    values: rawValues !== null && typeof rawValues === "object" ? rawValues : {},
  };
}

export async function runModuleTestJob(job: Job, context: DurableJobContext): Promise<void> {
  const runId = runIdFromJob(job);
  if (runId === undefined) throw new Error("module-test job is missing runId");
  const initial = await db.query.moduleTestRuns.findFirst({ where: eq(moduleTestRuns.id, runId) });
  if (initial === undefined || await context.canceled()) return;
  if (initial.status === "running" && initial.executionPid === null && initial.executionResultPath === null) {
    await db.update(moduleTestRuns).set({
      status: "errored",
      error: "The module test worker restarted after its subprocess checkpoint was lost",
      updatedAt: Date.now(),
    }).where(eq(moduleTestRuns.id, initial.id));
    return;
  }
  if (initial.status === "running" && initial.executionPid === null && initial.executionStage === "starting" && (initial.executionStartedAt ?? 0) < Date.now() - SUPERVISOR_START_TIMEOUT_MS) {
    const marker = initial.executionDirectory === null ? undefined : await readSupervisorMarker(initial.executionDirectory);
    if (marker !== undefined) await stopSupervisor(marker);
    await db.update(moduleTestRuns).set({ status: "errored", error: "The module test supervisor did not checkpoint its process", executionStage: "failed", updatedAt: Date.now() }).where(eq(moduleTestRuns.id, initial.id));
    return;
  }
  if (initial.status === "running" && initial.executionPid === null && initial.executionStage === "starting") {
    await enqueueDurableJob("module-test", { runId: initial.id }, { dedupeKey: initial.id, runAfter: Date.now() + SUPERVISOR_START_TIMEOUT_MS, rescheduleRunning: true });
    return;
  }
  const started = await db.update(moduleTestRuns).set({ status: "running", updatedAt: Date.now() }).where(and(
    eq(moduleTestRuns.id, initial.id),
    inArray(moduleTestRuns.status, ["queued", "pending", "running"]),
  )).returning({ id: moduleTestRuns.id });
  if (started.length === 0) return;

  let module: Readonly<typeof registryModules.$inferSelect> | undefined;
  let version: Readonly<typeof registryModuleVersions.$inferSelect> | undefined;
  let organization: Readonly<typeof organizations.$inferSelect> | undefined;
  let oidcConfiguration: Readonly<typeof moduleTestConfigurations.$inferSelect> | undefined;
  let archivePath: string | null = null;
  try {
    [module, version, oidcConfiguration] = await Promise.all([
      db.query.registryModules.findFirst({ where: eq(registryModules.id, initial.moduleId) }),
      db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, initial.versionId) }),
      db.query.moduleTestConfigurations.findFirst({ where: eq(moduleTestConfigurations.moduleId, initial.moduleId) }),
    ]);
    organization = module === undefined ? undefined : await db.query.organizations.findFirst({ where: eq(organizations.id, module.orgId) });
    if (module === undefined || version === undefined || organization === undefined) throw new Error("Module test inputs are no longer available");
    archivePath = version.archivePath;
    if (initial.configurationVersionId !== null) {
      const configurationVersion = await db.query.moduleTestConfigurationVersions.findFirst({ where: and(eq(moduleTestConfigurationVersions.id, initial.configurationVersionId), eq(moduleTestConfigurationVersions.moduleId, initial.moduleId)) });
      if (configurationVersion?.status === "uploaded" && configurationVersion.archivePath !== null) archivePath = configurationVersion.archivePath;
    }
    if (archivePath === null || !(await Bun.file(archivePath).exists())) throw new Error("The module test archive is no longer available");
  } catch (error: unknown) {
    if (!(await context.canceled())) {
      await db.update(moduleTestRuns).set({ status: "errored", error: error instanceof Error ? error.message : "Unable to load module test inputs", updatedAt: Date.now() }).where(eq(moduleTestRuns.id, initial.id));
    }
    throw error;
  }

  const executionDirectory = join(MODULE_TEST_EXECUTION_DIR, initial.id);
  const resultPath = initial.executionResultPath ?? join(executionDirectory, "result.json");
  const oidc = oidcInput(oidcConfiguration);
  const input: SupervisorInput = {
    runId: initial.id,
    versionId: version.id,
    archivePath,
    resultPath,
    configuration: testConfiguration(initial),
    organizationId: organization.id,
    organizationName: organization.name,
    moduleName: module.name,
    ttlSeconds: organization.moduleTestTokenTtl,
    oidcProvider: oidc.provider,
    oidcValues: oidc.values,
  };
  let current = await db.query.moduleTestRuns.findFirst({ where: eq(moduleTestRuns.id, initial.id) });
  if (current === undefined) return;
  if (current.executionPid === null) {
    if (current.executionStage === "starting") return;
    if (!await context.heartbeat()) return;
    const executionClaim = await db.update(moduleTestRuns).set({
      executionStartedAt: Date.now(),
      executionStage: "starting",
      executionDirectory,
      executionResultPath: resultPath,
      updatedAt: Date.now(),
    }).where(and(
      eq(moduleTestRuns.id, initial.id),
      eq(moduleTestRuns.status, "running"),
      isNull(moduleTestRuns.executionPid),
      or(isNull(moduleTestRuns.executionStage), inArray(moduleTestRuns.executionStage, ["queued", "preparing"])),
    )).returning({ id: moduleTestRuns.id });
    if (executionClaim.length === 0) return;
    const pid = await startSupervisor(input);
    if (!await context.heartbeat()) {
      const latest = await db.query.moduleTestRuns.findFirst({ where: eq(moduleTestRuns.id, initial.id) });
      if (latest?.status === "canceled") {
        const marker = await readSupervisorMarker(executionDirectory);
        if (marker !== undefined) await stopSupervisor(marker);
      }
      return;
    }
    const claimed = await db.update(moduleTestRuns).set({
      executionPid: pid,
      executionStage: "subprocess",
      updatedAt: Date.now(),
    }).where(and(eq(moduleTestRuns.id, initial.id), eq(moduleTestRuns.status, "running"), isNull(moduleTestRuns.executionPid), eq(moduleTestRuns.executionStage, "starting"))).returning({ id: moduleTestRuns.id });
    if (claimed.length === 0) {
      const owner = await db.query.moduleTestRuns.findFirst({ where: eq(moduleTestRuns.id, initial.id) });
      if (owner?.executionPid !== pid) {
        if (owner?.status === "canceled") {
          const marker = await readSupervisorMarker(executionDirectory);
          if (marker !== undefined) await stopSupervisor(marker);
        }
        return;
      }
      current = owner;
    } else {
      current = await db.query.moduleTestRuns.findFirst({ where: eq(moduleTestRuns.id, initial.id) });
    }
  }
  if (current === undefined) return;

  try {
    const result = await waitForSupervisor(current, context);
    if (result === undefined) return;
    const executionPid = current.executionPid;
    if (executionPid === null) throw new Error("Module test execution checkpoint is incomplete");
    const latest = await db.query.moduleTestRuns.findFirst({ where: eq(moduleTestRuns.id, initial.id) });
    if (latest?.status === "canceled" || await context.canceled()) return;
    await db.update(moduleTestRuns).set({
      status: result.status === "errored" ? "errored" : "finished",
      testStatus: result.status === "passed" ? "pass" : result.status === "failed" ? "fail" : null,
      testsPassed: result.testsPassed,
      testsFailed: result.testsFailed,
      testsErrored: result.testsErrored,
      testsSkipped: result.testsSkipped,
      output: result.output,
      error: result.error,
      executionPid: null,
      executionStage: "finished",
      updatedAt: Date.now(),
    }).where(and(eq(moduleTestRuns.id, initial.id), eq(moduleTestRuns.executionPid, executionPid), inArray(moduleTestRuns.status, ["running", "queued"])));
    await rm(supervisorMarkerPath(current.executionDirectory ?? dirname(resultPath)), { force: true });
  } catch (error: unknown) {
    const latest = await db.query.moduleTestRuns.findFirst({ where: eq(moduleTestRuns.id, initial.id) });
    if (latest?.status !== "canceled" && !(await context.canceled())) {
      await db.update(moduleTestRuns).set({
        status: "errored",
        error: error instanceof Error ? error.message : "Unable to run module test",
        executionPid: null,
        executionStage: "failed",
        updatedAt: Date.now(),
      }).where(eq(moduleTestRuns.id, initial.id));
    }
    throw error;
  } finally {
    const latest = await db.query.moduleTestRuns.findFirst({ where: eq(moduleTestRuns.id, initial.id) });
    const ownershipLost = latest?.status === "running" && await context.canceled();
    if (!ownershipLost) {
      await revokeWorkloadIdentityTokens(initial.id).catch((error: unknown): void => {
        log.error("Failed to revoke workload identity tokens", { runId: initial.id, error: String(error) });
      });
    }
  }
}
