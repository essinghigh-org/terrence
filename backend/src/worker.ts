import { db } from "./db";
import {
  runs,
  configurationVersions,
  noCodeModules,
  noCodeWorkspaceConfigurations,
  registryModules,
  registryModuleVersions,
  workspaces,
  workspaceVariables,
  logs,
  stateVersions,
  organizations,
  variableSets,
  variableSetWorkspaces,
  variableSetProjects,
  variableSetVariables,
  policySets,
  policySetWorkspaces,
  policySetProjects,
  policySetExclusions,
  policySetParameters,
  policies,
  policyChecks,
  runTasks,
  workspaceRunTasks,
  runTaskResults,
  assessmentResults,
  assessmentCheckResults,
  agentJobs,
  agentPools,
} from "./db/schema";
import { eq, desc, asc, and, inArray, notInArray, sql, isNotNull } from "drizzle-orm";
import { spawn } from "bun";
import { createHmac } from "node:crypto";
import { join } from "path";
import { tmpdir } from "os";
import { mkdir, rm, writeFile, readFile, exists, readdir, rename } from "fs/promises";
import { ensureBinary } from "./binaryManager";
import { workspaceExecutionDirectory } from "./workspace";
import { queueAssessmentNotification, queueRunNotification } from "./lib/notifications";
import { canTransitionRunStatus } from "./lib/run-status";
import { FINAL_RUN_STATUSES, signedApiURL, validateExternalUrl } from "./lib/utils";
import {
  emptyCostEstimate,
  parseInfracostOutput,
  writeCostEstimateArtifact,
  type CostEstimateTimestamps,
} from "./lib/cost-estimate";
import {
  planJsonResourceCounts,
  readPlanJsonArtifact,
  writePlanJsonArtifact,
  type PlanResourceCounts,
} from "./lib/plan-json";
import { refetchConfigurationVersion, reportRunVcsStatus } from "./lib/webhooks";
import { agentPoolAllowsWorkspace } from "./lib/agent-pool-scope";
import { recoverStaleAgentJobs } from "./lib/agent-jobs";
import { RunSandbox, removeSandboxWorkDir, runSandboxRequired } from "./lib/sandbox";
import { log } from "./lib/log";

type NoCodeUpgradeTarget = Readonly<{
  noCodeModuleId: string;
  moduleId: string;
  moduleVersionId: string;
  baseConfigurationVersionId: string;
}>;

type NoCodeUpgradeRunVariable = Readonly<{
  key: string;
  value: string;
  category?: string;
  hcl?: boolean;
  sensitive?: boolean;
  description?: string | null;
}>;

type NoCodeUpgradeRun = Readonly<{
  configurationVersionId: string | null;
  variables: readonly NoCodeUpgradeRunVariable[] | null;
}>;

type NoCodeUpgradeWorkspace = Readonly<{
  id: string;
  orgId: string;
}>;

function noCodeUpgradeTarget(source: string | null): NoCodeUpgradeTarget | undefined {
  const [kind, noCodeModuleId, moduleId, moduleVersionId, baseConfigurationVersionId, extra] = source?.split("|") ?? [];
  if (
    kind !== "tfe-no-code-upgrade"
    || noCodeModuleId === undefined
    || moduleId === undefined
    || moduleVersionId === undefined
    || baseConfigurationVersionId === undefined
    || extra !== undefined
    || [noCodeModuleId, moduleId, moduleVersionId, baseConfigurationVersionId].some((value): boolean => value === "")
  ) return undefined;
  return { noCodeModuleId, moduleId, moduleVersionId, baseConfigurationVersionId };
}

// --- Run sandbox (Landlock isolation for tofu/terraform) ---
// Terraform/OpenTofu runs are executed through landlock-runner, which applies
// a filesystem allow-list (workdir + binary dir + system libraries) to itself
// before exec. Provider plugins and local-exec provisioners inherit the
// restrictions, so they cannot see STORAGE_DIR (DB, encryption key, state
// archives) or other workspaces. Requires a Landlock-enabled kernel; disable
// with TERRENCE_RUN_SANDBOX=false.
const RUN_SANDBOX_REQUIRED = runSandboxRequired();
const runSandbox = RUN_SANDBOX_REQUIRED && RunSandbox.isUsable() ? new RunSandbox() : null;
if (RUN_SANDBOX_REQUIRED && runSandbox === null) {
  log.error(
    "Run sandbox is REQUIRED (TERRENCE_RUN_SANDBOX not set to false) but Landlock is unavailable. "
    + "Runs will FAIL until Landlock is enabled on the host kernel or TERRENCE_RUN_SANDBOX=false is set explicitly. "
    + "See https://docs.kernel.org/userspace-api/landlock.html",
  );
}

/**
 * Guard used by run/apply/assessment entry points: if the sandbox is required
 * but unavailable, refuse to execute anything rather than silently running
 * unsandboxed IaC. Throws an Error that surfaces as a failed run.
 */
function assertRunSandboxAvailable(): void {
  if (!RUN_SANDBOX_REQUIRED) return;
  if (runSandbox === null) {
    throw new Error(
      "Run sandbox unavailable: Landlock is not enabled on this host kernel. "
      + "Enable Landlock (Linux >= 5.13, CONFIG_SECURITY_LANDLOCK) or explicitly set TERRENCE_RUN_SANDBOX=false "
      + "to run without isolation. See https://docs.kernel.org/userspace-api/landlock.html",
    );
  }
}

/** Resolve the run workdir (tmpdir-based; the sandbox allow-lists it per run). */
function runWorkDir(runId: string): string {
  return runSandbox !== null ? runSandbox.workDirFor(runId) : join(tmpdir(), "terrence", "runs", runId);
}

async function writeLog(runId: string, phase: "plan" | "apply", outputText: string): Promise<void> {
  try {
    await db.insert(logs).values({
      id: crypto.randomUUID(),
      runId,
      phase,
      outputText,
      createdAt: Date.now(),
    });
  } catch {}
}

type RunStatusExtra = Readonly<Partial<Pick<
  typeof runs.$inferInsert,
  | "planResourceAdditions"
  | "planResourceChanges"
  | "planResourceDestructions"
  | "planResourceImports"
  | "applyResourceAdditions"
  | "applyResourceChanges"
  | "applyResourceDestructions"
  | "applyResourceImports"
>>>;

async function updateRunStatus(runId: string, status: string, extra?: RunStatusExtra): Promise<void> {
  const now = new Date().toISOString();
  const statusKey = status.replace(/_/g, "-") + "-at";
  try {
    const existing = await db.query.runs.findFirst({
      where: eq(runs.id, runId),
      columns: { statusTimestamps: true, status: true },
    });
    const existingTimestamps = typeof existing?.statusTimestamps === "object" && existing.statusTimestamps !== null
      ? existing.statusTimestamps
      : {};
    // State machine guard: warn loudly (never throw) when a transition is
    // not in the canonical table (lib/run-status.ts). Surfaces violations in
    // test runs and logs instead of silently corrupting run state.
    const currentStatus = existing?.status;
    if (currentStatus !== undefined && currentStatus !== status && !canTransitionRunStatus(currentStatus, status)) {
      log.error(`Illegal run status transition for ${runId}: ${currentStatus} -> ${status} (see lib/run-status.ts)`);
    }
    const timestamps = { ...existingTimestamps, [statusKey]: now };
    await db.update(runs).set({ status, statusTimestamps: timestamps, ...(extra ?? {}) }).where(eq(runs.id, runId));
  } catch (err: unknown) {
    log.error(`Failed to update run ${runId} status to ${status}`, { error: err instanceof Error ? err.message : String(err) });
    await db.update(runs).set({ status, ...(extra ?? {}) }).where(eq(runs.id, runId));
  }
  const trigger = status === "planning"
    ? "run:planning"
    : status === "applying"
      ? "run:applying"
      : status === "applied" || status === "planned_and_finished"
        ? "run:completed"
        : status === "errored"
          ? "run:errored"
          : status === "policy_soft_failed" || status === "planned_and_saved"
            ? "run:needs_attention"
            : undefined;
  if (trigger !== undefined) queueRunNotification(runId, trigger, status);
  void reportRunVcsStatus(runId, status);
}

/** Parse Terraform/OpenTofu plan and apply summaries into persisted resource counts. */
function parseResourceCounts(output: string): PlanResourceCounts {
  const plan = /(?:^|\n)Plan:\s*([^\n]+)/.exec(output)?.[1];
  const apply = /Apply complete!\s+Resources:\s*([^\n]+)/.exec(output)?.[1];
  const summary = plan ?? apply ?? "";
  const count = (pattern: RegExp): number =>
    Number.parseInt(pattern.exec(summary)?.[1] ?? "0", 10);
  return {
    additions: count(plan === undefined ? /(\d+)\s+added\b/ : /(\d+)\s+to add\b/),
    changes: count(plan === undefined ? /(\d+)\s+changed\b/ : /(\d+)\s+to change\b/),
    destructions: count(plan === undefined ? /(\d+)\s+destroyed\b/ : /(\d+)\s+to destroy\b/),
    imports: count(plan === undefined ? /(\d+)\s+imported\b/ : /(\d+)\s+to import\b/),
  };
}

type JsonObject = Readonly<Record<string, unknown>>;

type StoredCheckSummary = Readonly<{
  passed: number;
  failed: number;
  errored: number;
  unknown: number;
}>;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function checkStatus(value: unknown): "passed" | "failed" | "errored" | "unknown" {
  switch (value) {
    case "pass":
    case "passed":
      return "passed";
    case "fail":
    case "failed":
      return "failed";
    case "error":
    case "errored":
      return "errored";
    default:
      return "unknown";
  }
}

function checkAddress(check: JsonObject, index: number): { address: string; kind: string } {
  const address = asObject(check.address);
  const kind = typeof address?.kind === "string" ? address.kind : "check";
  if (typeof address?.to_display === "string") return { address: address.to_display, kind };
  const parts = [address?.type, address?.name].filter((part: unknown): part is string =>
    typeof part === "string" && part !== "");
  return { address: parts.length > 0 ? `${kind}.${parts.join(".")}` : `check.${String(index + 1)}`, kind };
}

function checkMessage(check: JsonObject): string | null {
  const messages = (Array.isArray(check.instances) ? check.instances : [])
    .flatMap((instance: unknown): unknown[] => {
      const value = asObject(instance);
      return Array.isArray(value?.problems) ? value.problems : [];
    })
    .map((problem: unknown): string | undefined => {
      const value = asObject(problem);
      return typeof value?.message === "string" ? value.message : undefined;
    })
    .filter((message: string | undefined): message is string => message !== undefined);
  return messages.length === 0 ? null : messages.join("\n");
}

async function storePlanCheckResults(
  workspaceId: string,
  planJson: JsonObject,
  association: Readonly<{ assessmentResultId?: string; runId?: string }>,
): Promise<StoredCheckSummary> {
  const rawChecks = Array.isArray(planJson.checks) ? planJson.checks : [];
  if (association.runId !== undefined) {
    await db.delete(assessmentCheckResults).where(eq(assessmentCheckResults.runId, association.runId));
  } else if (association.assessmentResultId !== undefined) {
    await db.delete(assessmentCheckResults)
      .where(eq(assessmentCheckResults.assessmentResultId, association.assessmentResultId));
  }

  const summary = { passed: 0, failed: 0, errored: 0, unknown: 0 };
  const rows: (typeof assessmentCheckResults.$inferInsert)[] = [];
  for (const [index, rawCheck] of rawChecks.entries()) {
    const check = asObject(rawCheck);
    if (check === undefined) continue;
    const normalizedStatus = checkStatus(check.status);
    summary[normalizedStatus] += 1;
    const address = checkAddress(check, index);
    rows.push({
      id: `checkrs-${crypto.randomUUID()}`,
      workspaceId,
      assessmentResultId: association.assessmentResultId ?? null,
      runId: association.runId ?? null,
      address: address.address,
      kind: address.kind,
      status: normalizedStatus,
      message: checkMessage(check),
      detail: check,
      createdAt: Date.now(),
    });
  }
  if (rows.length > 0) await db.insert(assessmentCheckResults).values(rows);
  return summary;
}

function parseJsonObject(raw: string): JsonObject {
  const parsed = JSON.parse(raw) as unknown;
  const value = asObject(parsed);
  if (value === undefined) throw new Error("Terraform returned invalid JSON output.");
  return value;
}

async function readPlanJson(
  executionDir: string,
  planBinaryPath?: string,
): Promise<JsonObject | undefined> {
  const tfplanPath = join(executionDir, "tfplan");
  if (!(await exists(tfplanPath))) return undefined;
  const binaries = [...new Set(
    [planBinaryPath, "tofu", "terraform"]
      .filter((binary: string | undefined): binary is string => typeof binary === "string" && binary !== ""),
  )];
  for (const binary of binaries) {
    try {
      const process = runSandbox !== null
        ? runSandbox.spawn([binary, "show", "-json", tfplanPath], {
            cwd: executionDir,
            env: { PATH: processEnv("PATH") },
          })
        : spawn([binary, "show", "-json", tfplanPath], {
            cwd: executionDir,
            env: { PATH: processEnv("PATH") },
            stdout: "pipe",
            stderr: "pipe",
          });
      const [exitCode, stdout] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      if (exitCode === 0) return parseJsonObject(stdout);
    } catch {}
  }
  return undefined;
}

function processEnv(key: string): string {
  return process.env[key] ?? "";
}

function infracostEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (key === "PATH" || key.startsWith("INFRACOST_"))) environment[key] = value;
  }
  if (process.env.INFRACOST_API_KEY !== undefined && process.env.INFRACOST_API_KEY !== "") {
    environment.INFRACOST_API_KEY = process.env.INFRACOST_API_KEY;
  }
  return environment;
}

async function executeCostEstimate(runId: string, executionDir: string): Promise<void> {
  const run = await db.query.runs.findFirst({
    where: eq(runs.id, runId),
    columns: { statusTimestamps: true },
  });
  const statusTimestamps = run?.statusTimestamps ?? {};
  const timestamps: CostEstimateTimestamps = {
    "queued-at": statusTimestamps["planned-at"] ?? null,
    "pending-at": statusTimestamps["cost-estimating-at"] ?? new Date().toISOString(),
    "finished-at": null,
  };

  if (process.env.INFRACOST_ENABLED !== "true") {
    await writeLog(runId, "plan", "[terrence] Cost estimation is disabled. Skipping.");
    const estimate = emptyCostEstimate("skipped", {
      ...timestamps,
      "finished-at": new Date().toISOString(),
    });
    await writeCostEstimateArtifact(runId, estimate);
    return;
  }

  const inputPath = join(executionDir, "terrence.infracost-plan.json");

  try {
    await writeCostEstimateArtifact(runId, emptyCostEstimate("pending", timestamps));
    const planJson = await readPlanJsonArtifact(runId);
    if (planJson === undefined) throw new Error("Persisted Terraform plan JSON is unavailable.");
    await writeFile(inputPath, JSON.stringify(planJson), { mode: 0o600 });

    const configuredValue = Reflect.get(process.env, "INFRACOST_BINARY") as unknown;
    const configuredBinary = typeof configuredValue === "string" ? configuredValue.trim() : undefined;
    const binary = configuredBinary === undefined || configuredBinary === "" ? "infracost" : configuredBinary;
    const costProcess = spawn(
      [binary, "breakdown", "--path", inputPath, "--format", "json", "--no-color"],
      {
        cwd: executionDir,
        env: infracostEnvironment(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      costProcess.exited,
      new Response(costProcess.stdout).text(),
      new Response(costProcess.stderr).text(),
    ]);
    if (exitCode !== 0) {
      const detail = stderr.trim().slice(0, 2_000);
      throw new Error(`Infracost exited with code ${exitCode}${detail === "" ? "" : `: ${detail}`}`);
    }

    const estimate = parseInfracostOutput(JSON.parse(stdout) as unknown, {
      ...timestamps,
      "finished-at": new Date().toISOString(),
    });
    await writeCostEstimateArtifact(runId, estimate);
    await writeLog(
      runId,
      "plan",
      `[terrence] Infracost estimated ${estimate["proposed-monthly-cost"]} per month across ${estimate["matched-resources-count"]} matched resources.`,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await writeCostEstimateArtifact(runId, emptyCostEstimate("errored", {
        ...timestamps,
        "finished-at": new Date().toISOString(),
      }, message));
    } catch (artifactError: unknown) {
      const artifactMessage = artifactError instanceof Error ? artifactError.message : String(artifactError);
      await writeLog(runId, "plan", `[terrence] Could not persist errored cost estimate: ${artifactMessage}`);
    }
    await writeLog(runId, "plan", `[terrence] Cost estimation errored: ${message}`);
  } finally {
    try {
      await rm(inputPath, { force: true });
    } catch {}
  }
}

function assessmentResourceCounts(planJson: JsonObject): { drifted: number; undrifted: number } {
  const resourceChanges = Array.isArray(planJson.resource_changes) ? planJson.resource_changes : [];
  let drifted = 0;
  let undrifted = 0;
  for (const rawChange of resourceChanges) {
    const change = asObject(rawChange);
    if (change?.mode === "data") continue;
    const detail = asObject(change?.change);
    const actions = Array.isArray(detail?.actions) ? detail.actions : [];
    if (actions.length === 0 || actions.every((action: unknown): boolean => action === "no-op" || action === "read")) {
      undrifted += 1;
    } else {
      drifted += 1;
    }
  }
  return { drifted, undrifted };
}

async function streamLog(
  runId: string,
  phase: "plan" | "apply",
  stream: Readonly<ReadableStream<Uint8Array>>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastFlush = Date.now();
  const flushIntervalMs = 50;
  const bufferThreshold = 1024;

  const flush = async (): Promise<void> => {
    if (buffer.length > 0) {
      const textToFlush = buffer;
      buffer = "";
      lastFlush = Date.now();
      await writeLog(runId, phase, textToFlush);
    }
  };

  while (buffer.length >= 0) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text !== "") {
      buffer += text;
      if (buffer.length >= bufferThreshold || Date.now() - lastFlush >= flushIntervalMs) {
        await flush();
      }
    }
  }
  const tail = decoder.decode();
  if (tail !== "") buffer += tail;
  await flush();
}

function buildSanitizedEnv(
  workspaceVars: readonly { readonly key: string; readonly value: string; readonly category: string }[],
  extraEnv?: Readonly<Record<string, string>>,
): Record<string, string> {
  const allowedKeys = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "LC_ALL", "SHELL"];
  const protectedKeys = ["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "TF_CLI_CONFIG_FILE", "DYLD_INSERT_LIBRARIES"];

  const env: Record<string, string> = {};
  for (const key of allowedKeys) {
    const val = process.env[key];
    if (typeof val === "string" && val !== "") env[key] = val;
  }

  for (const v of workspaceVars) {
    if (protectedKeys.includes(v.key.toUpperCase())) {
      log.warn("Blocked workspace variable targeting protected key", { key: v.key });
      continue;
    }
    if (v.category === "env") {
      env[v.key] = v.value;
    }
  }

  if (extraEnv !== undefined) {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (typeof v === "string") env[k] = v;
    }
  }

  return env;
}

type ExecutionVariable = {
  key: string;
  value: string;
  category: string;
  hcl: boolean;
  priority: boolean;
};

async function executionVariables(
  workspaceId: string,
  orgId: string,
  projectId: string | null,
  workspaceVariableOverrides?: readonly Readonly<Pick<ExecutionVariable, "key" | "value" | "category" | "hcl">>[],
): Promise<ExecutionVariable[]> {
  const [workspaceVars, workspaceLinks, projectLinks, orgVariableSets] = await Promise.all([
    workspaceVariableOverrides === undefined
      ? db.query.workspaceVariables.findMany({ where: eq(workspaceVariables.workspaceId, workspaceId) })
      : Promise.resolve(workspaceVariableOverrides),
    db.query.variableSetWorkspaces.findMany({ where: eq(variableSetWorkspaces.workspaceId, workspaceId) }),
    projectId === null
      ? Promise.resolve([])
      : db.query.variableSetProjects.findMany({ where: eq(variableSetProjects.projectId, projectId) }),
    db.query.variableSets.findMany({
      where: eq(variableSets.orgId, orgId),
      orderBy: [asc(variableSets.name), asc(variableSets.id)],
    }),
  ]);
  const attached = new Set([
    ...workspaceLinks.map((link: { readonly variableSetId: string }): string => link.variableSetId),
    ...projectLinks.map((link: { readonly variableSetId: string }): string => link.variableSetId),
  ]);
  const activeSets = orgVariableSets.filter((vs: { readonly global: boolean | null; readonly id: string }): boolean => vs.global === true || attached.has(vs.id));
  const activeSetIds = activeSets.map((vs: { readonly id: string }): string => vs.id);

  // Build priority lookup
  const prioritySetIds = new Set(activeSets.filter((vs: { readonly priority: boolean | null; readonly id: string }): boolean => vs.priority === true).map((vs: { readonly id: string }): string => vs.id));

  const setVars = activeSetIds.length === 0
    ? []
    : await db.query.variableSetVariables.findMany({
        where: inArray(variableSetVariables.variableSetId, activeSetIds),
        orderBy: [asc(variableSetVariables.id)],
      });

  const effective = new Map<string, ExecutionVariable>();

  // 1. Non-priority variable set variables first
  for (const variable of setVars) {
    if (!prioritySetIds.has(variable.variableSetId)) {
      effective.set(`${variable.category}:${variable.key}`, { ...variable, hcl: false, priority: false });
    }
  }

  // 2. Workspace variables override non-priority sets
  for (const variable of workspaceVars) {
    effective.set(`${variable.category}:${variable.key}`, { ...variable, hcl: variable.hcl === true, priority: false });
  }

  // 3. Priority variable set variables override everything
  for (const variable of setVars) {
    if (prioritySetIds.has(variable.variableSetId)) {
      effective.set(`${variable.category}:${variable.key}`, { ...variable, hcl: false, priority: true });
    }
  }

  return [...effective.values()];
}

/** True when a tar member name is dangerous to extract: absolute path or any
 * `..` substring (conservative — also rejects `a..b`-style names). Extracted
 * so the archive guard can be fuzz-tested directly (kanban 22.6). */
export function tarMemberPathUnsafe(member: string): boolean {
  return member.startsWith("/") || member.includes("..");
}

/** True when a tar verbose-listing type char denotes a link or special file
 * (l=link, h=hard link, c=char device, b=block device, p=fifo, s=sparse/
 * socket). Regular files (f/-/0) and directories (d) are allowed. Extracted
 * so the archive guard can be fuzz-tested directly (kanban 22.6). */
export function tarMemberIsForbiddenSpecial(firstChar: string): boolean {
  return firstChar === "l"
    || firstChar === "h"
    || firstChar === "c"
    || firstChar === "b"
    || firstChar === "p"
    || firstChar === "s";
}

async function extractTarArchive(
  archivePath: string,
  destDir: string,
  workingDirectory?: string | null,
): Promise<boolean> {
  try {
    const verboseProc = spawn(["tar", "-tvzf", archivePath]);
    const verboseText = await new Response(verboseProc.stdout).text();
    const verboseExitCode = await verboseProc.exited;
    if (verboseExitCode !== 0) return false;

    const verboseLines = verboseText.split("\n").map((s: string): string => s.trim()).filter((s: string): boolean => s !== "");
    for (const line of verboseLines) {
      if (tarMemberIsForbiddenSpecial(line.charAt(0))) {
        log.error("Security error: archive contains forbidden link/special member", { member: line });
        return false;
      }
      if (line.includes(" -> ") || line.includes(" link to ")) {
        log.error("Security error: archive contains link member", { member: line });
        return false;
      }
    }

    const listProc = spawn(["tar", "-tzf", archivePath]);
    const membersText = await new Response(listProc.stdout).text();
    const exitCode = await listProc.exited;
    if (exitCode !== 0) return false;

    const members = membersText.split("\n").map((s: string): string => s.trim()).filter((s: string): boolean => s !== "");
    for (const m of members) {
      if (tarMemberPathUnsafe(m)) {
        log.error("Security error: archive contains dangerous path", { path: m });
        return false;
      }
    }

    const extractProc = spawn(["tar", "-xzf", archivePath, "-C", destDir]);
    const ok = (await extractProc.exited) === 0;
    if (ok) {
      await unnestArchiveDirectory(destDir, workingDirectory);
    }
    return ok;
  } catch (err: unknown) {
    log.error("Tar extraction error", { error: err });
    return false;
  }
}

async function unnestArchiveDirectory(
  destDir: string,
  workingDirectory?: string | null,
): Promise<void> {
  if (typeof workingDirectory === "string" && workingDirectory !== "" && workingDirectory !== ".") {
    return;
  }
  try {
    const entries = await readdir(destDir, { withFileTypes: true });
    const hasTfInRoot = entries.some(
      (e): boolean => e.isFile() && (e.name.endsWith(".tf") || e.name.endsWith(".tf.json")),
    );
    if (hasTfInRoot) return;

    const dirEntries = entries.filter((e): boolean => e.isDirectory());
    if (entries.length === 1 && dirEntries.length === 1 && dirEntries[0] !== undefined) {
      const subDir = join(destDir, dirEntries[0].name);
      const subFiles = await readdir(subDir);
      for (const file of subFiles) {
        await rename(join(subDir, file), join(destDir, file));
      }
      await rm(subDir, { recursive: true, force: true });
      log.info(`Un-nested archive directory '${dirEntries[0].name}' into working directory.`);
    }
  } catch (err: unknown) {
    log.warn("Could not unnest archive directory", { error: err });
  }
}

async function executeRunTasks(
  runId: string,
  workspace: Readonly<{ id: string; name: string; workingDirectory: string | null }>,
  orgName: string,
  stage: "pre_plan" | "post_plan",
): Promise<boolean> {
  const bindings = await db.query.workspaceRunTasks.findMany({
    where: and(eq(workspaceRunTasks.workspaceId, workspace.id), eq(workspaceRunTasks.stage, stage)),
    orderBy: [asc(workspaceRunTasks.id)],
  });
  if (bindings.length === 0) return true;

  const taskIds = bindings.map((binding: Readonly<{ runTaskId: string }>): string => binding.runTaskId);
  const configuredTasks = await db.query.runTasks.findMany({
    where: and(inArray(runTasks.id, taskIds), eq(runTasks.enabled, true)),
  });
  const tasksById = new Map(configuredTasks.map((task: Readonly<typeof runTasks.$inferSelect>): readonly [string, Readonly<typeof runTasks.$inferSelect>] => [task.id, task]));
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  let proceed = true;
  const configuredTimeout = Number(process.env.RUN_TASK_TIMEOUT_MS ?? 3_600_000);
  const timeoutMs = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 3_600_000;

  // Batch-insert all pending run-task results in one statement instead of
  // issuing one INSERT per binding inside the loop below.
  const entryList: Readonly<{
    binding: Readonly<(typeof bindings)[number]>;
    task: Readonly<typeof runTasks.$inferSelect>;
    resultId: string;
  }>[] = [];
  for (const binding of bindings) {
    const task = tasksById.get(binding.runTaskId);
    if (task === undefined) continue;
    entryList.push({ binding, task, resultId: `taskrs-${crypto.randomUUID()}` });
  }
  if (entryList.length > 0) {
    await db.insert(runTaskResults).values(
      entryList.map((entry): typeof runTaskResults.$inferInsert => ({
        id: entry.resultId,
        runId,
        runTaskId: entry.task.id,
        status: "pending",
        createdAt: Date.now(),
      })),
    );
  }

  for (const { binding, task, resultId } of entryList) {
    const port = process.env.PORT ?? "3000";
    const callbackBase = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
    const callbackPath = `/api/v2/task-results/${resultId}/callback`;
    const callbackUrl = signedApiURL(
      { url: callbackBase },
      callbackPath,
      "PATCH",
      Math.ceil(timeoutMs / 1000) + 60,
    );
    const payload = JSON.stringify({
      payload_version: 1,
      stage,
      capabilities: { outcomes: false },
      configuration_version_id: run?.configurationVersionId ?? null,
      is_speculative: run?.planOnly === true,
      organization_name: orgName,
      plan_json_api_url: `/api/v2/plans/plan-${runId}/json-output`,
      run_created_at: new Date(run?.createdAt ?? Date.now()).toISOString(),
      run_id: runId,
      run_message: run?.message ?? "",
      task_result_callback_url: callbackUrl,
      task_result_enforcement_level: binding.enforcementLevel,
      task_result_id: resultId,
      workspace_id: workspace.id,
      workspace_name: workspace.name,
      workspace_working_directory: workspace.workingDirectory ?? "",
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (typeof task.hmacKey === "string" && task.hmacKey !== "") {
      headers["X-Tfc-Task-Signature"] = createHmac("sha512", task.hmacKey).update(payload).digest("hex");
    }

    let status = "running";
    let message: string | null = null;
    let resultUrl: string | null = null;
    const urlError = validateExternalUrl(task.url, process.env.TERRENCE_ALLOW_PRIVATE_URLS === "true");
    if (urlError !== null) {
      status = "failed";
      message = urlError;
    } else try {
      const response = await fetch(task.url, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      const responseText = await response.text();
      status = response.ok ? "running" : "failed";
      message = response.ok ? null : `Run task returned HTTP ${response.status}`;
      if (responseText !== "") {
        try {
          const parsed = JSON.parse(responseText) as Record<string, unknown>;
          const rawData = parsed.data;
          const data = rawData !== null && typeof rawData === "object"
            ? rawData as Record<string, unknown>
            : parsed;
          const rawAttributes = data.attributes;
          const attributes = rawAttributes !== null && typeof rawAttributes === "object"
            ? rawAttributes as Record<string, unknown>
            : data;
          if (["running", "passed", "failed"].includes(String(attributes.status))) status = String(attributes.status);
          if (typeof attributes.message === "string") message = attributes.message;
          if (typeof attributes.url === "string") resultUrl = attributes.url;
        } catch {}
      }
    } catch (error: unknown) {
      status = "failed";
      message = error instanceof Error ? error.message : String(error);
    }

    const callbackResult = await db.query.runTaskResults.findFirst({ where: eq(runTaskResults.id, resultId) });
    if (callbackResult !== undefined && ["passed", "failed"].includes(callbackResult.status)) {
      status = callbackResult.status;
      message = callbackResult.message;
      resultUrl = callbackResult.url;
    } else {
      await db.update(runTaskResults).set({ status, message, url: resultUrl }).where(eq(runTaskResults.id, resultId));
    }
    if (status === "running") {
      const latest = await waitForTaskSettlement(resultId, timeoutMs);
      if (latest !== undefined && ["passed", "failed"].includes(latest.status)) {
        status = latest.status;
        message = latest.message;
        resultUrl = latest.url;
      } else {
        status = "failed";
        message = `Run task callback timed out after ${String(timeoutMs)}ms`;
        await db.update(runTaskResults).set({ status, message }).where(eq(runTaskResults.id, resultId));
      }
    }
    await writeLog(runId, "plan", `[terrence] ${stage} run task "${task.name}" ${status}.`);
    if (status === "failed" && (binding.enforcementLevel === "mandatory" || binding.enforcementLevel === "must_pass")) {
      proceed = false;
    }
  }

  return proceed;
}

const RUN_TASK_POLL_INTERVAL_MS = 100;

/**
 * Poll the run-task table until the caller (or a callback mechanism) records a
 * settled status. This worker has no pub/sub or Redis dependency, so a bounded
 * poll is the only signal source for an external task CLI that does not write
 * back via the REST callback. The loop is strictly bounded by `timeoutMs`, and
 * the poll interval starts at 100ms and backs off exponentially up to 5s so a
 * long-running task stops hammering the DB.
 */
async function waitForTaskSettlement(
  resultId: string,
  timeoutMs: number,
): Promise<Readonly<{ status: string; message: string | null; url: string | null }> | undefined> {
  const deadline = Date.now() + timeoutMs;
  // Exponential backoff: start at the poll base and double up to a cap so a
  // long-running task stops hammering the DB with a query every 100ms.
  let waitMs = RUN_TASK_POLL_INTERVAL_MS;
  const MAX_RUN_TASK_POLL_MS = 5_000;
  while (Date.now() < deadline) {
    const latest = await db.query.runTaskResults.findFirst({ where: eq(runTaskResults.id, resultId) });
    if (latest !== undefined && ["passed", "failed"].includes(latest.status)) return latest;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await Bun.sleep(Math.min(waitMs, remaining));
    waitMs = Math.min(waitMs * 2, MAX_RUN_TASK_POLL_MS);
  }
  return undefined;
}

const VCS_CONFIGURATION_SOURCES = ["github", "gitlab", "bitbucket"] as const;
type VcsConfigurationSource = typeof VCS_CONFIGURATION_SOURCES[number];

/** Bound for waiting on a push-webhook configuration download to settle. */
const VCS_CONFIGURATION_WAIT_MS = 60_000;
const VCS_CONFIGURATION_POLL_MS = 250;

/**
 * VCS push webhooks insert the run BEFORE the tarball download settles
 * (webhooks.ts queues the download after the run row is written). If the
 * worker claims such a run first, the archive is not on disk yet; planning
 * against the empty workdir would produce a destroy-everything plan. Wait
 * for the download (pending -> uploaded/errored) and fail the run loudly
 * when the download failed or produced no readable archive, instead of
 * planning against missing code.
 */
async function waitForVcsConfigurationDownload(
  runId: string,
  cv: Readonly<typeof configurationVersions.$inferSelect>,
): Promise<Readonly<typeof configurationVersions.$inferSelect>> {
  const archiveReady = async (c: Readonly<typeof configurationVersions.$inferSelect>): Promise<boolean> =>
    typeof c.archivePath === "string" && c.archivePath !== "" && (await exists(c.archivePath));

  // Observable signal for tests (regression suite polls for this marker
  // before settling a simulated download) and a useful live log line.
  await writeLog(runId, "plan", "[terrence] Waiting for VCS configuration download to complete...");

  const deadline = Date.now() + VCS_CONFIGURATION_WAIT_MS;
  let current = cv;
  // The webhook writes the tarball BEFORE flipping the status
  // (downloadAndSaveTarball: copyFile, then status = uploaded), so a
  // present archive must not be mistaken for a settled download: keep
  // polling until the status leaves "pending".
  while (current.status === "pending" && Date.now() < deadline) {
    await Bun.sleep(VCS_CONFIGURATION_POLL_MS);
    const latest = await db.query.configurationVersions.findFirst({
      where: eq(configurationVersions.id, current.id),
    });
    if (latest === undefined) {
      throw new Error(`Configuration version '${current.id}' disappeared while waiting for its download.`);
    }
    current = latest;
  }

  if (current.status === "errored") {
    throw new Error(`VCS configuration download failed: ${current.error ?? "unknown error"}`);
  }
  if (current.status === "pending") {
    throw new Error(
      `VCS configuration download for ${current.id} did not complete within ${VCS_CONFIGURATION_WAIT_MS / 1000}s.`,
    );
  }
  // "archived"/"backing_data_soft_deleted" configurations are allowed to
  // have no local archive: the refetch logic below restores it on demand.
  // Any other settled status must come with a readable archive, or the run
  // would plan against an empty workdir.
  if (
    current.status !== "archived"
    && current.status !== "backing_data_soft_deleted"
    && !(await archiveReady(current))
  ) {
    throw new Error(
      `VCS configuration download for ${current.id} completed without a readable archive (status ${current.status}).`,
    );
  }
  return current;
}

export async function executeRun(runId: string): Promise<void> {
  assertRunSandboxAvailable();
  const run = await db.query.runs.findFirst({
    where: eq(runs.id, runId),
  });

  if (run === undefined) return;

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, run.workspaceId),
  });

  if (workspace === undefined) return;

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, workspace.orgId),
  });

  const workDir = runWorkDir(runId);
  let keepPlan = false;

  try {
    await updateRunStatus(runId, "fetching");
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await writeLog(runId, "plan", `[terrence] Initializing run environment in ${workDir}`);

    if (run.configurationVersionId !== null) {
      let cv = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, run.configurationVersionId),
      });

      // Push webhooks can create the run before the tarball download settles
      // (see waitForVcsConfigurationDownload): wait for it rather than
      // planning against an empty workdir.
      if (cv !== undefined && VCS_CONFIGURATION_SOURCES.includes(cv.source as VcsConfigurationSource)) {
        cv = await waitForVcsConfigurationDownload(runId, cv);
      }

      if (
        cv !== undefined
        && ["github", "gitlab", "bitbucket"].includes(cv.source ?? "")
        && ["archived", "backing_data_soft_deleted"].includes(cv.status)
        && (
          typeof cv.archivePath !== "string"
          || cv.archivePath === ""
          || !(await exists(cv.archivePath))
        )
      ) {
        await writeLog(runId, "plan", `[terrence] Re-fetching archived VCS configuration ${cv.id}.`);
        if (!(await refetchConfigurationVersion(cv.id))) {
          throw new Error(`Unable to re-fetch archived VCS configuration '${cv.id}'.`);
        }
        cv = await db.query.configurationVersions.findFirst({
          where: eq(configurationVersions.id, run.configurationVersionId),
        });
      }

      if (cv !== undefined && typeof cv.archivePath === "string" && cv.archivePath !== "" && (await exists(cv.archivePath))) {
        await writeLog(runId, "plan", `[terrence] Extracting configuration archive ${cv.archivePath}`);
        const ok = await extractTarArchive(cv.archivePath, workDir, workspace.workingDirectory);
        if (!ok) {
          throw new Error("Configuration archive extraction failed or contained invalid path components.");
        }
      }
    } else if (workspace.source === "local") {
      const wsName = workspace.name;
      if (wsName.includes("..") || wsName.startsWith("/") || wsName.includes("\\")) {
        throw new Error(`Invalid workspace name: contains path traversal characters`);
      }
      const localPath = join("/app/backend/storage/local", org?.name ?? workspace.orgId, workspace.projectId ?? "default", wsName);
      
      await writeLog(runId, "plan", `[terrence] Using local source directory: ${localPath}`);
      if (!(await exists(localPath))) {
        throw new Error(`Local source directory does not exist: ${localPath}`);
      }
      
      // Copy files to workDir using cp
      const cpProc = spawn(["cp", "-r", localPath + "/.", workDir]);
      const cpExit = await cpProc.exited;
      if (cpExit !== 0) {
        throw new Error(`Failed to copy local source directory to working directory.`);
      }
    }

    await updateRunStatus(runId, "fetching_completed");
    await updateRunStatus(runId, "pre_plan_running");
    if (!(await executeRunTasks(runId, workspace, org?.name ?? workspace.orgId, "pre_plan"))) {
      throw new Error("Run blocked by mandatory pre-plan task failure.");
    }
    await updateRunStatus(runId, "pre_plan_completed");
    await updateRunStatus(runId, "queuing");
    await updateRunStatus(runId, "plan_queued");
    await updateRunStatus(runId, "planning");

    const executionDir = workspaceExecutionDirectory(workDir, workspace.workingDirectory);
    try {
      await readdir(executionDir);
    } catch {
      throw new Error(`Working directory '${workspace.workingDirectory ?? ""}' does not exist in the configuration.`);
    }
    await writeLog(runId, "plan", `[terrence] Executing from ${executionDir}`);
    await writeFile(
      join(executionDir, "terrence_backend_override.tf"),
      'terraform {\n  backend "local" {}\n}\n',
      { mode: 0o600 },
    );

    const latestState = await db.query.stateVersions.findFirst({
      where: and(
        eq(stateVersions.workspaceId, workspace.id),
        eq(stateVersions.status, "finalized"),
        eq(stateVersions.intermediate, false),
      ),
      orderBy: [desc(stateVersions.serial)],
    });
    if (latestState !== undefined && typeof latestState.statePayload === "string" && latestState.statePayload !== "") {
      await writeFile(join(executionDir, "terraform.tfstate"), latestState.statePayload, { mode: 0o600 });
      await writeLog(runId, "plan", `[terrence] Seeded workspace state serial #${latestState.serial}.`);
    }

    const configuration = run.configurationVersionId === null
      ? undefined
      : await db.query.configurationVersions.findFirst({
          where: eq(configurationVersions.id, run.configurationVersionId),
        });
    const upgradeTarget = noCodeUpgradeTarget(configuration?.source ?? null);
    const proposedWorkspaceVariables = upgradeTarget === undefined
      ? undefined
      : ((run.variables ?? []) as readonly NoCodeUpgradeRunVariable[]).map((variable): Readonly<Pick<ExecutionVariable, "key" | "value" | "category" | "hcl">> => ({
          key: variable.key,
          value: variable.value,
          category: variable.category === "env" ? "env" : "terraform",
          hcl: variable.hcl === true,
        }));
    const vars = await executionVariables(
      workspace.id,
      workspace.orgId,
      workspace.projectId,
      proposedWorkspaceVariables,
    );

    const envVars = buildSanitizedEnv(vars);
    if (run.debuggingMode) envVars.TF_LOG = "TRACE";
    const tfVarsLines = vars
      .filter((variable: { readonly category: string }): boolean => variable.category === "terraform")
      .map((variable: { readonly key: string; readonly hcl: boolean; readonly value: string }): string => `${variable.key} = ${variable.hcl ? variable.value : JSON.stringify(variable.value)}`);

    if (tfVarsLines.length > 0) {
      await writeFile(join(executionDir, "terrence.workspace.tfvars"), tfVarsLines.join("\n"), { mode: 0o600 });
      await writeLog(runId, "plan", `[terrence] Injected ${tfVarsLines.length} workspace Terraform variables.`);
    }

    const requestedTool = workspace.iacBinary ?? org?.defaultIacBinary ?? "tofu";
    const requestedVersion = run.terraformVersion ?? workspace.terraformVersion ?? org?.defaultTerraformVersion ?? "latest";

    const currentDirFiles = await readdir(executionDir);
    const hasTfFiles = currentDirFiles.some((f: string): boolean => f.endsWith(".tf") || f.endsWith(".tf.json"));

    const isSimulatedAllowed = process.env.SIMULATED_RUNS === "true" || Reflect.get(process.env, "NODE_ENV") === "test";
    if (!isSimulatedAllowed) {
      await writeLog(runId, "plan", `[terrence] Resolving binary for ${requestedTool} (version: ${requestedVersion})...`);
    }
    const resolved = isSimulatedAllowed ? null : await ensureBinary(requestedTool, requestedVersion);

    if (resolved !== null && hasTfFiles) {
      const binary = resolved.binaryPath;
      await writeLog(runId, "plan", `[terrence] Using ${resolved.tool} v${resolved.version} at ${binary}`);
      if (runSandbox !== null) await runSandbox.ensureTool(resolved.tool, resolved.version, binary);

      // 1. Run init
      await writeLog(runId, "plan", `\n--- Executing ${resolved.tool} init ---`);
      if (runSandbox !== null) await runSandbox.prepareWorkDir(runId);
      const initProc = runSandbox !== null
        ? runSandbox.spawn([binary, "init", "-reconfigure", "-no-color", "-input=false"], {
            cwd: executionDir,
            env: envVars,
          })
        : spawn([binary, "init", "-reconfigure", "-no-color", "-input=false"], {
            cwd: executionDir,
            env: envVars,
            stdout: "pipe",
            stderr: "pipe",
          });

      const [initExit] = await Promise.all([
        initProc.exited,
        streamLog(runId, "plan", initProc.stdout),
        streamLog(runId, "plan", initProc.stderr),
      ]);

      if (initExit !== 0) {
        throw new Error(`${resolved.tool} init failed with exit code ${initExit}`);
      }

      // 2. Run plan
      await writeLog(runId, "plan", `\n--- Executing ${resolved.tool} plan ---`);
      const planArgs = [binary, "plan", "-no-color", "-input=false"];
      if (!run.refresh) planArgs.push("-refresh=false");
      if (run.refreshOnly) planArgs.push("-refresh-only");
      if (run.isDestroy === true) planArgs.push("-destroy");
      for (const target of run.targetAddrs ?? []) planArgs.push(`-target=${target}`);
      for (const replacement of run.replaceAddrs ?? []) planArgs.push(`-replace=${replacement}`);
      if (tfVarsLines.length > 0) planArgs.push("-var-file=terrence.workspace.tfvars");
      if (upgradeTarget === undefined) {
        for (const variable of run.variables ?? []) planArgs.push(`-var=${variable.key}=${variable.value}`);
      }
      for (const variable of vars) {
        if (variable.category === "terraform" && variable.priority) {
          planArgs.push(`-var=${variable.key}=${variable.hcl ? variable.value : JSON.stringify(variable.value)}`);
        }
      }
      planArgs.push("-out=tfplan");

      const planProc = runSandbox !== null
        ? runSandbox.spawn(planArgs, {
            cwd: executionDir,
            env: envVars,
          })
        : spawn(planArgs, {
            cwd: executionDir,
            env: envVars,
            stdout: "pipe",
            stderr: "pipe",
          });

      const [planExit] = await Promise.all([
        planProc.exited,
        streamLog(runId, "plan", planProc.stdout),
        streamLog(runId, "plan", planProc.stderr),
      ]);

      if (planExit !== 0) {
        throw new Error(`${resolved.tool} plan failed with exit code ${planExit}`);
      }
    } else if (isSimulatedAllowed) {
      await writeLog(runId, "plan", `[terrence] Execution engine: Simulated plan completed successfully.`);
      await writeLog(runId, "plan", `Plan: 1 to add, 0 to change, 0 to destroy.`);
    } else if (resolved === null) {
      throw new Error(`Unable to resolve CLI binary '${requestedTool}' (version: ${requestedVersion}).`);
    } else {
      throw new Error(`No Terraform configuration (.tf or .tf.json) files were found in workspace directory '${executionDir}'.`);
    }

    const planJson = isSimulatedAllowed
      ? parseJsonObject(process.env.SIMULATED_PLAN_JSON ?? "{}")
      : await readPlanJson(executionDir, resolved?.binaryPath);
    if (planJson !== undefined) {
      await writePlanJsonArtifact(runId, planJson);
      const checks = await storePlanCheckResults(workspace.id, planJson, { runId });
      await writeLog(
        runId,
        "plan",
        `[terrence] Evaluated checks: ${String(checks.passed)} passed, ${String(checks.failed)} failed, ${String(checks.errored)} errored, ${String(checks.unknown)} unknown.`,
      );
    }

    // Parse resource counts from plan log output
    const planLogs = await db.query.logs.findMany({
      where: and(eq(logs.runId, runId), eq(logs.phase, "plan")),
      orderBy: [asc(logs.createdAt)],
    });
    const resourceCounts =
      (planJson === undefined ? undefined : planJsonResourceCounts(planJson))
      ?? parseResourceCounts(planLogs.map((log: Readonly<{ outputText: string }>): string => log.outputText).join("\n"));

    await updateRunStatus(runId, "planned", {
      planResourceAdditions: resourceCounts.additions,
      planResourceChanges: resourceCounts.changes,
      planResourceDestructions: resourceCounts.destructions,
      planResourceImports: resourceCounts.imports,
    });
    await writeLog(runId, "plan", `[terrence] Plan completed successfully.`);

    await updateRunStatus(runId, "cost_estimating");
    await executeCostEstimate(runId, executionDir);
    await updateRunStatus(runId, "cost_estimated");

    await updateRunStatus(runId, "policy_checking");
    const policyResult = await runPolicyChecks(
      runId,
      workspace.id,
      workspace.orgId,
      executionDir,
      resolved?.binaryPath,
      planJson,
    );
    if (!policyResult.proceed) {
      if (policyResult.hardFailed) {
        await updateRunStatus(runId, "errored");
        await writeLog(runId, "plan", `[terrence] Run blocked by hard-mandatory policy failure.`);
      } else if (policyResult.softFailed) {
        await updateRunStatus(runId, "policy_override");
        await updateRunStatus(runId, "policy_soft_failed");
        await writeLog(runId, "plan", `[terrence] Run requires policy override before apply.`);
      }
      keepPlan = true;
    } else {
      await updateRunStatus(runId, "policy_checked");
      await updateRunStatus(runId, "post_plan_running");
      if (!(await executeRunTasks(runId, workspace, org?.name ?? workspace.orgId, "post_plan"))) {
        throw new Error("Run blocked by mandatory post-plan task failure.");
      }
      await updateRunStatus(runId, "post_plan_completed");

      const hasNoResourceChanges = resourceCounts.additions === 0
        && resourceCounts.changes === 0
        && resourceCounts.destructions === 0;

      // Check if the plan has drift that needs to be applied to state
      const hasDrift = planJson !== undefined
        && Array.isArray((planJson as Record<string, unknown>).resource_drift)
        && ((planJson as Record<string, unknown>).resource_drift as unknown[]).length > 0;

      if (run.planOnly) {
        await updateRunStatus(runId, "planned_and_finished");
      } else if (run.savePlan) {
        await updateRunStatus(runId, "planned_and_saved");
        keepPlan = true;
      } else if (run.autoApply === true) {
        // Auto-apply must not bypass the site-wide apply gates: when an
        // approval workflow or a maintenance window blocks applies, fall
        // back to the needs-attention state instead of applying.
        const autoApplyBlockReason = await import("./lib/operations").then((mod): Promise<string | null> =>
          mod.applyGateBlockReason(new Date()),
        );
        if (autoApplyBlockReason !== null) {
          await writeLog(runId, "plan", `[terrence] Auto-apply blocked: ${autoApplyBlockReason}`);
          await updateRunStatus(runId, "planned");
          queueRunNotification(runId, "run:needs_attention", "planned");
          keepPlan = true;
        } else {
          await writeLog(
            runId,
            "plan",
            hasNoResourceChanges && !hasDrift
              ? `[terrence] Plan has no resource changes and no drift. Automatically applying to update workspace state.`
              : `[terrence] Cost estimate, policies, and run tasks passed. Proceeding to apply.`,
          );
          keepPlan = true;
          await executeApply(runId);
        }
      } else if (hasNoResourceChanges && !hasDrift && !run.allowEmptyApply) {
        await writeLog(runId, "plan", `[terrence] Plan has no resource changes or drift. Run finished.`);
        await updateRunStatus(runId, "planned_and_finished");
      } else {
        await updateRunStatus(runId, "planned");
        queueRunNotification(runId, "run:needs_attention", "planned");
        keepPlan = true;
      }
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error(`Run ${runId} planning failed`, { error: errMsg });
    await writeLog(runId, "plan", `[terrence ERROR] ${errMsg}`);
    await updateRunStatus(runId, "errored");
  } finally {
    if (!keepPlan) {
      try {
        if (runSandbox !== null) {
          await removeSandboxWorkDir(runId);
        } else {
          await rm(workDir, { recursive: true, force: true });
        }
      } catch {}
    }
  }
}

function noCodeInputValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

async function finalizeNoCodeUpgrade(
  run: NoCodeUpgradeRun,
  workspace: NoCodeUpgradeWorkspace,
): Promise<void> {
  if (run.configurationVersionId === null) return;
  const configuration = await db.query.configurationVersions.findFirst({
    where: eq(configurationVersions.id, run.configurationVersionId),
  });
  const target = noCodeUpgradeTarget(configuration?.source ?? null);
  if (configuration === undefined || target === undefined) return;

  const [noCode, mod, version, current] = await Promise.all([
    db.query.noCodeModules.findFirst({ where: eq(noCodeModules.id, target.noCodeModuleId) }),
    db.query.registryModules.findFirst({ where: eq(registryModules.id, target.moduleId) }),
    db.query.registryModuleVersions.findFirst({ where: eq(registryModuleVersions.id, target.moduleVersionId) }),
    db.query.noCodeWorkspaceConfigurations.findFirst({
      where: eq(noCodeWorkspaceConfigurations.workspaceId, workspace.id),
    }),
  ]);
  if (
    noCode === undefined
    || mod?.orgId !== workspace.orgId
    || version?.moduleId !== mod.id
    || current?.noCodeModuleId !== target.noCodeModuleId
    || current.configurationVersionId !== target.baseConfigurationVersionId
  ) throw new Error("The no-code workspace changed after this upgrade was confirmed.");

  const proposed = run.variables ?? [];
  const inputs = Object.fromEntries(proposed
    .filter((variable): boolean => variable.category !== "env")
    .map((variable): [string, unknown] => [variable.key, noCodeInputValue(variable.value)]));
  const moduleSource = `private/${mod.namespace}/${mod.name}/${mod.provider}/${version.version}`;

  await db.transaction(async (tx): Promise<void> => {
    const advanced = await tx.update(noCodeWorkspaceConfigurations).set({
      noCodeModuleId: target.noCodeModuleId,
      moduleId: target.moduleId,
      moduleVersionId: target.moduleVersionId,
      configurationVersionId: configuration.id,
      moduleSource,
      moduleVersion: version.version,
      inputs,
    }).where(and(
      eq(noCodeWorkspaceConfigurations.workspaceId, workspace.id),
      eq(noCodeWorkspaceConfigurations.noCodeModuleId, target.noCodeModuleId),
      eq(noCodeWorkspaceConfigurations.configurationVersionId, target.baseConfigurationVersionId),
    )).returning({ id: noCodeWorkspaceConfigurations.id });
    if (advanced.length !== 1) throw new Error("The no-code workspace changed while applying its upgrade.");

    await tx.delete(workspaceVariables).where(eq(workspaceVariables.workspaceId, workspace.id));
    if (proposed.length > 0) {
      await tx.insert(workspaceVariables).values(proposed.map((variable): typeof workspaceVariables.$inferInsert => ({
        id: `wsvar-${crypto.randomUUID()}`,
        workspaceId: workspace.id,
        key: variable.key,
        value: variable.value,
        category: variable.category === "env" ? "env" : "terraform",
        hcl: variable.hcl === true,
        sensitive: variable.sensitive === true,
        description: variable.description ?? null,
      })));
    }
  });
}

export async function executeApply(runId: string): Promise<void> {
  assertRunSandboxAvailable();
  const run = await db.query.runs.findFirst({
    where: eq(runs.id, runId),
  });

  if (run === undefined) return;

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, run.workspaceId),
  });

  if (workspace === undefined) {
    log.error("Workspace missing for run", { runId });
    return;
  }

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, workspace.orgId),
  });

  if (!["confirmed", "apply_queued", "applying"].includes(run.status)) await updateRunStatus(runId, "confirmed");
  await updateRunStatus(runId, "apply_queued");
  await updateRunStatus(runId, "applying");
  const workDir = runWorkDir(runId);

  let applySuccess = false;

  try {
    const executionDir = workspaceExecutionDirectory(workDir, workspace.workingDirectory);
    await writeLog(runId, "apply", `[terrence] Starting apply phase for run ${runId}`);

    const requestedTool = workspace.iacBinary ?? org?.defaultIacBinary ?? "tofu";
    const requestedVersion = run.terraformVersion ?? workspace.terraformVersion ?? org?.defaultTerraformVersion ?? "latest";

    const dirFiles = (await exists(executionDir)) ? await readdir(executionDir) : [];
    const hasTfFiles = dirFiles.some((f: string): boolean => f.endsWith(".tf") || f.endsWith(".tf.json"));
    const isSimulatedAllowed = process.env.SIMULATED_RUNS === "true" || Reflect.get(process.env, "NODE_ENV") === "test";
    const resolved = isSimulatedAllowed ? null : await ensureBinary(requestedTool, requestedVersion);

    if (resolved !== null && (await exists(executionDir)) && hasTfFiles) {
      const binary = resolved.binaryPath;
      if (runSandbox !== null) await runSandbox.ensureTool(resolved.tool, resolved.version, binary);
      const vars = await executionVariables(workspace.id, workspace.orgId, workspace.projectId ?? null);
      const envVars = buildSanitizedEnv(vars);
      if (run.debuggingMode) envVars.TF_LOG = "TRACE";

      await writeLog(runId, "apply", `\n--- Executing ${resolved.tool} apply ---`);
      if (runSandbox !== null) await runSandbox.prepareWorkDir(runId);
      const hasPlanFile = await exists(join(executionDir, "tfplan"));
      if (!hasPlanFile) {
        throw new Error("Saved plan file 'tfplan' is missing; cannot apply run.");
      }
      const applyArgs = [binary, "apply", "-no-color", "-input=false", "tfplan"];

      const applyProc = runSandbox !== null
        ? runSandbox.spawn(applyArgs, {
            cwd: executionDir,
            env: envVars,
          })
        : spawn(applyArgs, {
            cwd: executionDir,
            env: envVars,
            stdout: "pipe",
            stderr: "pipe",
          });

      const [applyExit] = await Promise.all([
        applyProc.exited,
        streamLog(runId, "apply", applyProc.stdout),
        streamLog(runId, "apply", applyProc.stderr),
      ]);

      if (applyExit !== 0) {
        throw new Error(`${resolved.tool} apply failed with exit code ${applyExit}`);
      }

      const stateFilePath = join(executionDir, "terraform.tfstate");
      if (await exists(stateFilePath)) {
        const statePayload = await readFile(stateFilePath, "utf-8");

        // Derive the JSON state and outputs from the raw payload. The resources
        // list and outputs endpoints read jsonState/jsonStateOutputs, so a
        // state version without them renders as "no resources".
        let jsonState: string | null = statePayload;
        let jsonStateOutputs: string | null = null;
        try {
          const parsed = JSON.parse(statePayload) as Record<string, unknown>;
          jsonStateOutputs = parsed.outputs !== null && parsed.outputs !== undefined
            ? JSON.stringify(parsed.outputs)
            : null;
        } catch {
          jsonState = null;
        }

        const nextSerial = await db.transaction(async (tx: unknown): Promise<number> => {
          const t = tx as typeof db;
          const latestState = await t.query.stateVersions.findFirst({
            where: eq(stateVersions.workspaceId, workspace.id),
            orderBy: [desc(stateVersions.serial)],
          });
          const serial = (latestState?.serial ?? 0) + 1;
          await t.insert(stateVersions).values({
            id: crypto.randomUUID(),
            workspaceId: workspace.id,
            serial,
            statePayload,
            jsonState,
            jsonStateOutputs,
            runId,
          });
          return serial;
        });

        await writeLog(runId, "apply", `[terrence] Recorded state version serial #${nextSerial}`);

      }
    } else if (isSimulatedAllowed) {
      await writeLog(runId, "apply", `[terrence] Execution engine: Simulated apply completed successfully.`);
    } else {
      throw new Error(`Unable to resolve CLI binary '${requestedTool}' for apply phase.`);
    }

    // Parse resource counts from apply log output
    const applyLogs = await db.query.logs.findMany({
      where: and(eq(logs.runId, runId), eq(logs.phase, "apply")),
      orderBy: [asc(logs.createdAt)],
    });
    const applyResourceCounts = parseResourceCounts(applyLogs.map((log: Readonly<{ outputText: string }>): string => log.outputText).join("\n"));

    await finalizeNoCodeUpgrade(run, workspace);
    await updateRunStatus(runId, "applied", {
      applyResourceAdditions: applyResourceCounts.additions,
      applyResourceChanges: applyResourceCounts.changes,
      applyResourceDestructions: applyResourceCounts.destructions,
      applyResourceImports: applyResourceCounts.imports,
    });
    applySuccess = true;
    await writeLog(runId, "apply", `[terrence] Run status updated to 'applied'.`);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("Run apply failed", { runId, error });
    await writeLog(runId, "apply", `[terrence ERROR] ${errMsg}`);
    await updateRunStatus(runId, "errored");
  } finally {
    if (applySuccess) {
      try {
        if (runSandbox !== null) {
          await removeSandboxWorkDir(runId);
        } else {
          await rm(workDir, { recursive: true, force: true });
        }
      } catch {}
    } else {
      await writeLog(runId, "apply", `[terrence] Preserving work directory for debugging: ${workDir}`);
    }
  }
}

/**
 * Evaluate policies attached to a workspace after a plan completes.
 * Returns an object indicating whether the run should proceed to apply.
 */
async function runPolicyChecks(
  runId: string,
  workspaceId: string,
  orgId: string,
  executionDir?: string,
  planBinaryPath?: string,
  preloadedPlanJson?: JsonObject,
): Promise<{ proceed: boolean; hardFailed: boolean; softFailed: boolean }> {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { projectId: true },
  });
  const [attached, projectAttached, orgPolicySets, exclusions] = await Promise.all([
    db.query.policySetWorkspaces.findMany({ where: eq(policySetWorkspaces.workspaceId, workspaceId) }),
    workspace?.projectId === null || workspace?.projectId === undefined
      ? Promise.resolve([])
      : db.query.policySetProjects.findMany({ where: eq(policySetProjects.projectId, workspace.projectId) }),
    db.query.policySets.findMany({ where: and(eq(policySets.orgId, orgId), eq(policySets.global, true)) }),
    db.query.policySetExclusions.findMany({ where: eq(policySetExclusions.workspaceId, workspaceId) }),
  ]);
  const excludedSetIds = new Set(exclusions.map((exclusion: Readonly<{ policySetId: string }>): string => exclusion.policySetId));
  const allSetIds = [...new Set([
    ...attached.map((link: Readonly<{ policySetId: string }>): string => link.policySetId),
    ...projectAttached.map((link: Readonly<{ policySetId: string }>): string => link.policySetId),
    ...orgPolicySets.map((policySet: Readonly<{ id: string }>): string => policySet.id),
  ])].filter((policySetId: string): boolean => !excludedSetIds.has(policySetId));
  if (allSetIds.length === 0) return { proceed: true, hardFailed: false, softFailed: false };

  const [allPolicies, effectivePolicySets, setParameters] = await Promise.all([
    db.query.policies.findMany({ where: inArray(policies.policySetId, allSetIds) }),
    db.query.policySets.findMany({ where: inArray(policySets.id, allSetIds) }),
    db.query.policySetParameters.findMany({ where: inArray(policySetParameters.policySetId, allSetIds) }),
  ]);
  if (allPolicies.length === 0) return { proceed: true, hardFailed: false, softFailed: false };
  const policySetsById = new Map(effectivePolicySets.map((policySet: Readonly<{ id: string; kind: string }>): readonly [string, Readonly<{ kind: string }>] => [policySet.id, { kind: policySet.kind }]));
  const parametersBySet = new Map<string, (typeof policySetParameters.$inferSelect)[]>();
  for (const parameter of setParameters) {
    const current = parametersBySet.get(parameter.policySetId) ?? [];
    current.push(parameter);
    parametersBySet.set(parameter.policySetId, current);
  }

  const generatedPlanJson = preloadedPlanJson ?? (
    executionDir === undefined || executionDir === ""
      ? undefined
      : await readPlanJson(executionDir, planBinaryPath)
  );
  let planJsonPayload = generatedPlanJson === undefined ? null : JSON.stringify(generatedPlanJson);

  // Fallback to stored state version if plan JSON generation failed
  if (planJsonPayload === null || planJsonPayload === "") {
    const latestState = await db.query.stateVersions.findFirst({
      where: and(
        eq(stateVersions.workspaceId, workspaceId),
        eq(stateVersions.status, "finalized"),
        eq(stateVersions.intermediate, false),
      ),
      orderBy: [desc(stateVersions.serial)],
    });
    planJsonPayload = latestState?.statePayload ?? null;
  }

  await writeLog(runId, "plan", `[terrence] Evaluating ${allPolicies.length} policies across ${allSetIds.length} policy sets...`);

  let hardFailed = false;
  let softFailed = false;
  const checkBatch: (typeof policyChecks.$inferInsert)[] = [];

  for (const policy of allPolicies) {
    const checkId = `pchk-${crypto.randomUUID()}`;
    let checkStatus = "unreachable";
    let checkResult: Record<string, unknown> = {};

    try {
      // For OPA policies, attempt to run opa eval
      const policySet = policy.policySetId !== null ? policySetsById.get(policy.policySetId) : undefined;
      const isOpa = policySet?.kind === "opa";
      const isSentinel = policySet?.kind === "sentinel";
      const policySource = typeof policy.source === "string" && policy.source !== ""
        ? policy.source
        : policy.query;

      if (isOpa && typeof policySource === "string" && policySource !== "" && planJsonPayload !== null && planJsonPayload !== "") {
        // Try to evaluate with OPA
        const workDir = join(tmpdir(), "terrence", "opa", runId);
        try {
          await mkdir(workDir, { recursive: true });
        } catch {}
        const policyPath = join(workDir, "policy.rego");
        const dataPath = join(workDir, "input.json");
        await writeFile(policyPath, policySource);
        await writeFile(dataPath, planJsonPayload);
        const opaQuery = typeof policy.source === "string" && typeof policy.query === "string" && policy.query !== ""
          ? policy.query
          : "data";
        // Validate OPA query to prevent argument injection — only allow safe query syntax
        const opaQuerySafe = /^[a-zA-Z0-9_.]+$/.test(opaQuery) ? opaQuery : "data";
        const opaProc = spawn(["opa", "eval", "--data", policyPath, "--input", dataPath, opaQuerySafe], {
          cwd: workDir,
          env: { PATH: process.env.PATH ?? "" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [opaExit, opaStdout] = await Promise.all([
          opaProc.exited,
          new Response(opaProc.stdout).text(),
          new Response(opaProc.stderr).text().catch((): string => ""),
        ]);
        if (opaExit === 0) {
          checkResult = JSON.parse(opaStdout !== "" ? opaStdout : "{}") as Record<string, unknown>;
          const resultList = checkResult.result as Record<string, unknown>[] | undefined;
          const exprList = resultList?.[0]?.expressions as Record<string, unknown>[] | undefined;
          const valObj = exprList?.[0]?.value as Record<string, unknown> | undefined;
          const violated = valObj?.violations;
          if (violated !== undefined && Array.isArray(violated) && violated.length > 0) {
            checkStatus = "failed";
          } else {
            checkStatus = "passed";
          }
        } else {
          checkStatus = "errored";
          checkResult = { error: "OPA evaluation failed" };
        }
        try {
          await rm(workDir, { recursive: true, force: true });
        } catch {}
      } else if (isSentinel && typeof policySource === "string" && policySource !== "") {
        const workDir = join(tmpdir(), "terrence", "sentinel", runId, policy.id);
        await mkdir(workDir, { recursive: true });
        const policyPath = join(workDir, "policy.sentinel");
        await writeFile(policyPath, policySource, { mode: 0o600 });
        const args = [
          process.env.SENTINEL_BINARY_PATH ?? "sentinel",
          "apply",
          "-json",
          "-timeout=30s",
          "-global",
          `tfplan=${planJsonPayload ?? "{}"}`,
        ];
        for (const parameter of (policy.policySetId !== null ? parametersBySet.get(policy.policySetId) ?? [] : [])) {
          args.push(
            "-param",
            `${parameter.key}=${parameter.hcl === true ? parameter.value : JSON.stringify(parameter.value)}`,
          );
        }
        args.push(policyPath);

        // Use the Landlock sandbox if available for policy evaluation.
// In simulated mode (tests) or when disabled, run unsandboxed.
        const isSimulatedAllowed = process.env.SIMULATED_RUNS === "true";
        const sandboxRequired = !isSimulatedAllowed && runSandboxRequired();
        if (sandboxRequired && (!RunSandbox.isUsable() || !RunSandbox.hasRunner())) {
          throw new Error("Landlock sandbox is required but unavailable for policy evaluation");
        }
        const runSandbox = sandboxRequired ? new RunSandbox() : null;
        const sentinelProc = runSandbox !== null
          ? runSandbox.spawnGeneric(args, {
              cwd: workDir,
              env: { PATH: process.env.PATH ?? "" },
            })
          : spawn(args, {
              cwd: workDir,
              env: { PATH: process.env.PATH ?? "" },
              stdout: "pipe",
              stderr: "pipe",
            });
        const [sentinelExit, sentinelStdout, sentinelStderr] = await Promise.all([
          sentinelProc.exited,
          new Response(sentinelProc.stdout).text(),
          new Response(sentinelProc.stderr).text(),
        ]);
        let sentinel: Record<string, unknown>;
        try {
          const parsed = JSON.parse(sentinelStdout) as unknown;
          sentinel = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : { output: sentinelStdout };
        } catch {
          sentinel = { output: sentinelStdout };
        }
        if (sentinelStderr !== "") sentinel.stderr = sentinelStderr;
        if (sentinelExit === 0 || sentinelExit === 1 || sentinelExit === 2) {
          const passed = sentinelExit === 0;
          checkStatus = passed ? "passed" : "failed";
          checkResult = {
            result: passed,
            passed: passed ? 1 : 0,
            "total-failed": passed ? 0 : 1,
            "hard-failed": !passed && policy.enforcementLevel === "hard-mandatory" ? 1 : 0,
            "soft-failed": !passed && policy.enforcementLevel === "soft-mandatory" ? 1 : 0,
            "advisory-failed": !passed && policy.enforcementLevel === "advisory" ? 1 : 0,
            "duration-ms": typeof sentinel.duration === "number" ? sentinel.duration : 0,
            sentinel,
          };
        } else {
          checkStatus = "errored";
          checkResult = { error: `Sentinel evaluation exited with code ${String(sentinelExit)}`, sentinel };
        }
        try {
          await rm(workDir, { recursive: true, force: true });
        } catch {}
      } else if (!isOpa && !isSentinel) {
        checkStatus = "unreachable";
        checkResult = { error: `Policy kind '${policySet?.kind ?? "unknown"}' is not supported` };
      } else {
        checkStatus = "errored";
        checkResult = { error: "Missing policy query or plan data for evaluation" };
      }

      const storedStatus = checkStatus === "failed" && policy.enforcementLevel === "soft-mandatory"
        ? "soft_failed"
        : checkStatus;
      checkBatch.push({
        id: checkId,
        runId,
        policyId: policy.id,
        policySetId: policy.policySetId,
        status: storedStatus,
        result: checkResult,
        createdAt: Date.now(),
      });

      if (checkStatus === "failed") {
        if (policy.enforcementLevel === "hard-mandatory") {
          hardFailed = true;
          await writeLog(runId, "plan", `[terrence] Policy "${policy.name}" HARD-FAILED (hard-mandatory). Blocking apply.`);
        } else if (policy.enforcementLevel === "soft-mandatory") {
          softFailed = true;
          await writeLog(runId, "plan", `[terrence] Policy "${policy.name}" SOFT-FAILED (soft-mandatory). Override required.`);
        } else {
          await writeLog(runId, "plan", `[terrence] Policy "${policy.name}" FAILED (advisory — not blocking).`);
        }
      } else if (checkStatus === "passed") {
        await writeLog(runId, "plan", `[terrence] Policy "${policy.name}" PASSED.`);
      } else if (checkStatus === "errored" || checkStatus === "unreachable") {
        if (policy.enforcementLevel === "hard-mandatory") hardFailed = true;
        if (policy.enforcementLevel === "soft-mandatory") softFailed = true;
        await writeLog(runId, "plan", `[terrence] Policy "${policy.name}" ${checkStatus}: ${JSON.stringify(checkResult)}`);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      checkBatch.push({
        id: checkId,
        runId,
        policyId: policy.id,
        policySetId: policy.policySetId,
        status: "errored",
        result: { error: errMsg },
        createdAt: Date.now(),
      });
      if (policy.enforcementLevel === "hard-mandatory") hardFailed = true;
      if (policy.enforcementLevel === "soft-mandatory") softFailed = true;
      await writeLog(runId, "plan", `[terrence] Policy "${policy.name}" evaluation error: ${errMsg}`);
    }
  }

  if (checkBatch.length > 0) await db.insert(policyChecks).values(checkBatch);

  // Both hard and soft failures block apply
  const proceed = !hardFailed && !softFailed;
  return { proceed, hardFailed, softFailed };
}

type CapturedProcess = Readonly<{ exitCode: number; output: string; stdout: string }>;

async function captureProcess(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<CapturedProcess> {
  const child = runSandbox !== null
    ? runSandbox.spawn([...args], { cwd, env })
    : spawn([...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}${stderr}`, stdout };
}

function assessmentIntervalMs(): number {
  const configured = Number(process.env.HEALTH_ASSESSMENT_INTERVAL_MS ?? 86_400_000);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 86_400_000;
}

function autoDestroyDurationMs(value: string | null): number | undefined {
  const match = /^([1-9]\d{0,3})([dh])$/.exec(value ?? "");
  if (match === null) return undefined;
  const amount = Number(match[1]);
  return amount * (match[2] === "d" ? 86_400_000 : 3_600_000);
}

export async function enqueueDueAutoDestroyRuns(now = Date.now()): Promise<string[]> {
  const [allWorkspaces, allRuns, finalizedStates, configurations] = await Promise.all([
    db.query.workspaces.findMany({ orderBy: [asc(workspaces.createdAt), asc(workspaces.id)] }),
    db.query.runs.findMany({ orderBy: [desc(runs.createdAt)] }),
    db.query.stateVersions.findMany({
      where: and(eq(stateVersions.status, "finalized"), eq(stateVersions.intermediate, false)),
      orderBy: [desc(stateVersions.createdAt)],
    }),
    db.query.configurationVersions.findMany({ orderBy: [desc(configurationVersions.createdAt)] }),
  ]);
  const latestStateAt = new Map<string, number>();
  for (const state of finalizedStates) {
    if (!latestStateAt.has(state.workspaceId)) latestStateAt.set(state.workspaceId, state.createdAt);
  }
  const latestConfigurationId = new Map<string, string>();
  for (const configuration of configurations) {
    if (!latestConfigurationId.has(configuration.workspaceId)) {
      latestConfigurationId.set(configuration.workspaceId, configuration.id);
    }
  }
  const workspaceRuns = new Map<string, (typeof runs.$inferSelect)[]>();
  for (const run of allRuns) {
    const current = workspaceRuns.get(run.workspaceId) ?? [];
    current.push(run);
    workspaceRuns.set(run.workspaceId, current);
  }

  const created: string[] = [];
  for (const workspace of allWorkspaces) {
    if (workspace.locked === true) continue;
    const runsForWorkspace = workspaceRuns.get(workspace.id) ?? [];
    if (runsForWorkspace.some((run): boolean => !FINAL_RUN_STATUSES.includes(run.status))) continue;

    const scheduledAt = workspace.autoDestroyAt === null ? Number.NaN : Date.parse(workspace.autoDestroyAt);
    const scheduled = Number.isFinite(scheduledAt) && scheduledAt <= now;
    const duration = autoDestroyDurationMs(workspace.autoDestroyActivityDuration);
    const lastAttemptAt = runsForWorkspace.find((run): boolean =>
      run.isDestroy === true && run.message?.startsWith("[auto-destroy]") === true)?.createdAt;
    const activityAt = Math.max(
      workspace.createdAt,
      latestStateAt.get(workspace.id) ?? 0,
      lastAttemptAt ?? 0,
    );
    const inactive = duration !== undefined && activityAt + duration <= now;
    if (!scheduled && !inactive) continue;

    const runId = `run-${crypto.randomUUID()}`;
    await db.transaction(async (tx): Promise<void> => {
      await tx.insert(runs).values({
        id: runId,
        workspaceId: workspace.id,
        configurationVersionId: latestConfigurationId.get(workspace.id) ?? null,
        status: "pending",
        message: scheduled
          ? "[auto-destroy] Scheduled workspace destruction"
          : "[auto-destroy] Inactivity workspace destruction",
        isDestroy: true,
        autoApply: true,
        statusTimestamps: { "pending-at": new Date(now).toISOString() },
        createdAt: now,
      });
      if (scheduled) {
        await tx.update(workspaces).set({ autoDestroyAt: null }).where(eq(workspaces.id, workspace.id));
      }
    });
    created.push(runId);
  }
  return created;
}

export async function enqueueDueAssessments(now = Date.now()): Promise<string[]> {
  // ponytail: a per-workspace scan is sufficient for a homelab scheduler; use one ranked SQL query if scale demands it.
  const [allWorkspaces, allOrganizations] = await Promise.all([
    db.query.workspaces.findMany({ orderBy: [asc(workspaces.createdAt), asc(workspaces.id)] }),
    db.query.organizations.findMany(),
  ]);
  const organizationsById = new Map(
    allOrganizations.map((organization: Readonly<typeof organizations.$inferSelect>): readonly [
      string,
      Readonly<typeof organizations.$inferSelect>,
    ] => [organization.id, organization]),
  );
  const cutoff = now - assessmentIntervalMs();

  // Filter candidate workspaces first
  const candidateWorkspaces = allWorkspaces.filter((workspace): boolean => {
    const organization = organizationsById.get(workspace.orgId);
    return workspace.assessmentsEnabled === true || organization?.assessmentsEnforced === true;
  });
  if (candidateWorkspaces.length === 0) return [];

  const candidateIds = candidateWorkspaces.map((ws): string => ws.id);

  // Batch fetch only the latest + active assessment results and runs, capped
  const batchLimit = Math.max(candidateIds.length * 5, 20);
  const [allAssessments, allRuns] = await Promise.all([
    db.query.assessmentResults.findMany({
      where: inArray(assessmentResults.workspaceId, candidateIds),
      orderBy: [desc(assessmentResults.createdAt)],
      limit: batchLimit,
    }),
    db.query.runs.findMany({
      where: inArray(runs.workspaceId, candidateIds),
      orderBy: [desc(runs.createdAt)],
      limit: batchLimit,
    }),
  ]);

  // Group by workspace ID
  const assessmentsByWorkspace = new Map<string, typeof allAssessments>();
  const runsByWorkspace = new Map<string, typeof allRuns>();
  for (const a of allAssessments) {
    const list = assessmentsByWorkspace.get(a.workspaceId);
    if (list === undefined) assessmentsByWorkspace.set(a.workspaceId, [a]);
    else list.push(a);
  }
  for (const r of allRuns) {
    const list = runsByWorkspace.get(r.workspaceId);
    if (list === undefined) runsByWorkspace.set(r.workspaceId, [r]);
    else list.push(r);
  }
  const enqueued: string[] = [];
  const batch: (typeof assessmentResults.$inferInsert)[] = [];

  for (const workspace of candidateWorkspaces) {
    const wsAssessments = assessmentsByWorkspace.get(workspace.id) ?? [];
    const wsRuns = runsByWorkspace.get(workspace.id) ?? [];

    // latestResult is the first assessment (sorted desc)
    const latestResult = wsAssessments.length > 0 ? wsAssessments[0] : undefined;
    // activeResult is any pending/running
    const activeResult = wsAssessments.find((a): boolean => ["pending", "running"].includes(a.status));
    // latestRun is the first run (sorted desc)
    const latestRun = wsRuns.length > 0 ? wsRuns[0] : undefined;
    // latestAppliedRun is the first applied run with CV
    const latestAppliedRun = wsRuns.find((r): boolean => r.status === "applied" && r.configurationVersionId !== null);
    // activeRun is any run not in final statuses
    const activeRun = wsRuns.find((r): boolean => !FINAL_RUN_STATUSES.includes(r.status));

    if (
      activeResult !== undefined
      || activeRun !== undefined
      || latestAppliedRun === undefined
      || latestRun === undefined
      || !["applied", "planned_and_finished"].includes(latestRun.status)
      || (latestResult !== undefined && latestResult.createdAt > cutoff)
    ) continue;

    const id = `asmtres-${crypto.randomUUID()}`;
    batch.push({
      id,
      workspaceId: workspace.id,
      status: "pending" as const,
      createdAt: now,
    });
    enqueued.push(id);
  }
  if (batch.length > 0) await db.insert(assessmentResults).values(batch);
  return enqueued;
}

async function executeAssessment(assessmentResultId: string): Promise<void> {
  assertRunSandboxAvailable();
  const assessment = await db.query.assessmentResults.findFirst({
    where: eq(assessmentResults.id, assessmentResultId),
  });
  if (assessment === undefined || ["completed", "errored", "canceled"].includes(assessment.status)) return;

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, assessment.workspaceId),
  });
  if (workspace === undefined) return;
  const organization = await db.query.organizations.findFirst({
    where: eq(organizations.id, workspace.orgId),
  });
  if (workspace.assessmentsEnabled !== true && organization?.assessmentsEnforced !== true) {
    await db.update(assessmentResults)
      .set({ status: "canceled", succeeded: false, errorMessage: "Health assessments are disabled", completedAt: Date.now() })
      .where(eq(assessmentResults.id, assessmentResultId));
    return;
  }

  await db.update(assessmentResults).set({ status: "running" })
    .where(eq(assessmentResults.id, assessmentResultId));
  const workDir = runSandbox !== null
    ? runSandbox.workDirFor(`assessment-${assessmentResultId}`)
    : join(tmpdir(), "terrence", "assessments", assessmentResultId);
  const output: string[] = [];
  const appendOutput = (text: string): void => {
    if (text !== "") output.push(text.trimEnd());
  };

  try {
    const appliedRun = await db.query.runs.findFirst({
      where: and(
        eq(runs.workspaceId, workspace.id),
        eq(runs.status, "applied"),
        isNotNull(runs.configurationVersionId),
      ),
      orderBy: [desc(runs.createdAt)],
    });
    if (appliedRun?.configurationVersionId === null || appliedRun?.configurationVersionId === undefined) {
      throw new Error("No successfully applied configuration is available for assessment.");
    }

    const simulated = process.env.SIMULATED_RUNS === "true" || Reflect.get(process.env, "NODE_ENV") === "test";
    let planJson: JsonObject;
    let providerSchema: JsonObject = {};

    if (simulated) {
      planJson = parseJsonObject(process.env.SIMULATED_ASSESSMENT_JSON ?? '{"resource_changes":[],"checks":[]}');
      providerSchema = parseJsonObject(process.env.SIMULATED_ASSESSMENT_SCHEMA ?? "{}");
      appendOutput("[terrence] Simulated health assessment completed.");
    } else {
      const configuration = await db.query.configurationVersions.findFirst({
        where: eq(configurationVersions.id, appliedRun.configurationVersionId),
      });
      if (
        configuration === undefined
        || typeof configuration.archivePath !== "string"
        || configuration.archivePath === ""
        || !(await exists(configuration.archivePath))
      ) throw new Error("Applied configuration archive is unavailable.");

      await mkdir(workDir, { recursive: true, mode: 0o700 });
      if (!(await extractTarArchive(configuration.archivePath, workDir))) {
        throw new Error("Configuration archive extraction failed or contained invalid path components.");
      }
      const executionDir = workspaceExecutionDirectory(workDir, workspace.workingDirectory);
      const dirFiles = await readdir(executionDir);
      if (!dirFiles.some((file: string): boolean => file.endsWith(".tf") || file.endsWith(".tf.json"))) {
        throw new Error("No Terraform configuration files were found for assessment.");
      }
      await writeFile(
        join(executionDir, "terrence_backend_override.tf"),
        'terraform {\n  backend "local" {}\n}\n',
        { mode: 0o600 },
      );

      const latestState = await db.query.stateVersions.findFirst({
        where: and(
          eq(stateVersions.workspaceId, workspace.id),
          eq(stateVersions.status, "finalized"),
          eq(stateVersions.intermediate, false),
        ),
        orderBy: [desc(stateVersions.serial)],
      });
      if (typeof latestState?.statePayload !== "string" || latestState.statePayload === "") {
        throw new Error("No finalized workspace state is available for assessment.");
      }
      await writeFile(join(executionDir, "terraform.tfstate"), latestState.statePayload, { mode: 0o600 });

      const variables = await executionVariables(workspace.id, workspace.orgId, workspace.projectId ?? null);
      const environment = buildSanitizedEnv(variables);
      const terraformVariables = variables
        .filter((variable: Readonly<{ category: string }>): boolean => variable.category === "terraform")
        .map((variable: Readonly<{ key: string; hcl: boolean; value: string }>): string =>
          `${variable.key} = ${variable.hcl ? variable.value : JSON.stringify(variable.value)}`);
      if (terraformVariables.length > 0) {
        await writeFile(
          join(executionDir, "terrence.workspace.tfvars"),
          terraformVariables.join("\n"),
          { mode: 0o600 },
        );
      }

      const requestedTool = workspace.iacBinary ?? organization?.defaultIacBinary ?? "tofu";
      const requestedVersion = appliedRun.terraformVersion
        ?? workspace.terraformVersion
        ?? organization?.defaultTerraformVersion
        ?? "latest";
      const resolved = await ensureBinary(requestedTool, requestedVersion);
      if (resolved === null) throw new Error(`Unable to resolve CLI binary '${requestedTool}' for assessment.`);
      if (runSandbox !== null) {
        await runSandbox.ensureTool(resolved.tool, resolved.version, resolved.binaryPath);
        await runSandbox.prepareWorkDir(`assessment-${assessmentResultId}`);
      }
      const init = await captureProcess(
        [resolved.binaryPath, "init", "-reconfigure", "-no-color", "-input=false"],
        executionDir,
        environment,
      );
      appendOutput(init.output);
      if (init.exitCode !== 0) throw new Error(`${resolved.tool} init failed with exit code ${String(init.exitCode)}`);

      const planArgs = [
        resolved.binaryPath,
        "plan",
        "-no-color",
        "-input=false",
        "-detailed-exitcode",
        "-out=tfplan",
      ];
      if (terraformVariables.length > 0) planArgs.push("-var-file=terrence.workspace.tfvars");
      for (const variable of appliedRun.variables ?? []) planArgs.push(`-var=${variable.key}=${variable.value}`);
      for (const variable of variables) {
        if (variable.category === "terraform" && variable.priority) {
          planArgs.push(`-var=${variable.key}=${variable.hcl ? variable.value : JSON.stringify(variable.value)}`);
        }
      }
      const plan = await captureProcess(planArgs, executionDir, environment);
      appendOutput(plan.output);
      if (plan.exitCode !== 0 && plan.exitCode !== 2) {
        throw new Error(`${resolved.tool} assessment plan failed with exit code ${String(plan.exitCode)}`);
      }

      const generatedPlan = await readPlanJson(executionDir, resolved.binaryPath);
      if (generatedPlan === undefined) throw new Error("Unable to read assessment plan JSON.");
      planJson = generatedPlan;

      const schema = await captureProcess(
        [resolved.binaryPath, "providers", "schema", "-json"],
        executionDir,
        environment,
      );
      if (schema.exitCode === 0) providerSchema = parseJsonObject(schema.stdout);
      else appendOutput(`[terrence] Provider schema unavailable: ${schema.output}`);
    }

    const activeRun = await db.query.runs.findFirst({
      where: and(
        eq(runs.workspaceId, workspace.id),
        notInArray(runs.status, FINAL_RUN_STATUSES),
      ),
    });
    if (activeRun !== undefined) {
      await db.update(assessmentResults).set({
        status: "canceled",
        succeeded: false,
        errorMessage: "Canceled because an ordinary run started",
        logOutput: output.join("\n"),
        completedAt: Date.now(),
      }).where(eq(assessmentResults.id, assessmentResultId));
      return;
    }

    const [resources, checks] = await Promise.all([
      Promise.resolve(assessmentResourceCounts(planJson)),
      storePlanCheckResults(workspace.id, planJson, { assessmentResultId }),
    ]);
    const allChecksSucceeded = checks.failed === 0 && checks.errored === 0 && checks.unknown === 0;
    await db.update(assessmentResults).set({
      status: "completed",
      succeeded: true,
      drifted: resources.drifted > 0,
      errorMessage: null,
      resourcesDrifted: resources.drifted,
      resourcesUndrifted: resources.undrifted,
      allChecksSucceeded,
      checksPassed: checks.passed,
      checksFailed: checks.failed,
      checksErrored: checks.errored,
      checksUnknown: checks.unknown,
      jsonOutput: planJson,
      jsonSchema: providerSchema,
      logOutput: output.join("\n"),
      completedAt: Date.now(),
    }).where(eq(assessmentResults.id, assessmentResultId));
    if (resources.drifted > 0) queueAssessmentNotification(assessmentResultId, "assessment:drifted");
    if (!allChecksSucceeded) queueAssessmentNotification(assessmentResultId, "assessment:check_failure");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    appendOutput(`[terrence ERROR] ${message}`);
    await db.update(assessmentResults).set({
      status: "errored",
      succeeded: false,
      drifted: null,
      errorMessage: message,
      logOutput: output.join("\n"),
      completedAt: Date.now(),
    }).where(eq(assessmentResults.id, assessmentResultId));
    queueAssessmentNotification(assessmentResultId, "assessment:failed");
  } finally {
    try {
      if (runSandbox !== null) {
        await removeSandboxWorkDir(`assessment-${assessmentResultId}`);
      } else {
        await rm(workDir, { recursive: true, force: true });
      }
    } catch {}
  }
}

/**
 * Queue-poll gates: serialize each queue's passes independently so concurrent
 * callers (tests, a second worker instance in the same process) cannot nest
 * SQLite transactions. The agent-claim path runs db.transaction() with an
 * awaiting callback; two overlapping pollers of the same queue would
 * otherwise hit "cannot start a transaction within a transaction" and
 * silently drop claims (22.11). The assessment and run queues get separate
 * gates so one queue never blocks the other.
 *
 * Cross-process concurrency (two worker instances) is not supported for the
 * in-process SQLite worker; deployments split the worker with
 * TERRENCE_DISABLE_WORKER instead. The CAS claim conditions remain the
 * correctness backstop should a future deployment run overlapping pollers.
 */
let assessmentPollGate: Promise<void> = Promise.resolve();
let workerPollGate: Promise<void> = Promise.resolve();
function withQueueGate<T>(gate: "assessment" | "worker", fn: () => Promise<T>): Promise<T> {
  const prior = gate === "assessment" ? assessmentPollGate : workerPollGate;
  const run = prior.then(fn);
  const next = run.then(
    () => undefined,
    () => undefined,
  );
  if (gate === "assessment") assessmentPollGate = next;
  else workerPollGate = next;
  return run;
}

export async function pollAssessmentQueue(): Promise<string[]> {
  return withQueueGate("assessment", async (): Promise<string[]> => {
  const configured = Number(process.env.HEALTH_ASSESSMENT_CONCURRENCY ?? 2);
  const maximum = Number.isSafeInteger(configured) && configured > 0 ? configured : 2;
  const running = await db.query.assessmentResults.findMany({
    where: eq(assessmentResults.status, "running"),
    columns: { id: true },
  });
  const available = Math.max(0, maximum - running.length);
  if (available === 0) return [];
  const pending = await db.query.assessmentResults.findMany({
    where: eq(assessmentResults.status, "pending"),
    orderBy: [asc(assessmentResults.createdAt)],
    limit: available,
  });
  const claimed: string[] = [];
  for (const assessment of pending) {
    const updated = await db.update(assessmentResults)
      .set({ status: "running" })
      .where(and(
        eq(assessmentResults.id, assessment.id),
        eq(assessmentResults.status, "pending"),
      ))
      .returning({ id: assessmentResults.id });
    if (updated.length === 0) continue;
    claimed.push(assessment.id);
    executeAssessment(assessment.id).catch((error: unknown): void => {
      log.error("Assessment failed", { assessmentId: assessment.id, error });
    });
  }
  return claimed;
  });
}

let isWorkerLoopRunning = false;

export async function pollWorkerQueue(): Promise<string[]> {
  return withQueueGate("worker", async (): Promise<string[]> => {
  await recoverStaleAgentJobs();
  // ponytail: scan the pending queue in-process; replace with a grouped SQL claim if queue volume matters.
  const pendingRuns = await db.query.runs.findMany({
    where: eq(runs.status, "pending"),
    orderBy: [asc(runs.createdAt)],
    limit: 50,
  });
  const claimedRunIds: string[] = [];
  const claimedWorkspaceIds = new Set<string>();

  // Pre-fetch workspaces to avoid N+1 inside the loop
  const workspaceIds = [...new Set(pendingRuns.map((run): string => run.workspaceId))];
  const workspacesById = workspaceIds.length === 0
    ? new Map<string, typeof workspaces.$inferSelect>()
    : new Map(
        (await db.query.workspaces.findMany({
          where: inArray(workspaces.id, workspaceIds),
        })).map((ws): [string, typeof workspaces.$inferSelect] => [ws.id, ws]),
      );

  for (const run of pendingRuns) {
    if (claimedRunIds.length === 5) break;
    if (claimedWorkspaceIds.has(run.workspaceId)) continue;

    const workspace = workspacesById.get(run.workspaceId);
    if (workspace === undefined || workspace.locked === true) continue;

    // Atomic conditional claim: only claim if no planning/applying run exists for this workspace,
    // and the run is still pending.
    // Speculative/plan-only runs do NOT block the queue — they can run alongside other runs.
    const blockerStatuses = run.planOnly || run.savePlan
      ? []
      : [
          "fetching", "fetching_completed", "pre_plan_running", "pre_plan_completed",
          "queuing", "plan_queued", "planning", "planned", "cost_estimating",
          "cost_estimated", "policy_checking", "policy_override", "policy_checked",
          "post_plan_running", "post_plan_completed", "policy_soft_failed",
          "confirmed", "apply_queued", "applying",
        ];

    const claimWhere = and(
        eq(runs.id, run.id),
        eq(runs.status, "pending"),
        blockerStatuses.length > 0
          ? notInArray(
              runs.workspaceId,
              db.select({ workspaceId: runs.workspaceId }).from(runs).where(
                and(
                  eq(runs.workspaceId, run.workspaceId),
                  inArray(runs.status, blockerStatuses),
                  eq(runs.planOnly, false),
                  eq(runs.savePlan, false),
                ),
              ),
            )
          : sql`1=1`,
      );

    if (workspace.executionMode === "agent") {
      const pool = workspace.agentPoolId === null
        ? undefined
        : await db.query.agentPools.findFirst({
            where: eq(agentPools.id, workspace.agentPoolId),
          });
      if (
        pool?.orgId !== workspace.orgId
        || !(await agentPoolAllowsWorkspace(pool, workspace.id, workspace.projectId))
      ) {
        const unreachable = await db.update(runs).set({
          status: "unreachable",
          statusTimestamps: {
            ...(run.statusTimestamps ?? {}),
            "unreachable-at": new Date().toISOString(),
          },
        }).where(claimWhere).returning({ id: runs.id });
        if (unreachable.length > 0) {
          claimedRunIds.push(run.id);
          claimedWorkspaceIds.add(run.workspaceId);
          await writeLog(run.id, "plan", "[terrence ERROR] The configured agent pool is missing or is not allowed to execute this workspace.");
          queueRunNotification(run.id, "run:errored", "unreachable");
          void reportRunVcsStatus(run.id, "unreachable");
        }
        continue;
      }

      const queued = await db.transaction(async (transaction): Promise<boolean> => {
        const tx = transaction as unknown as typeof db;
        const claimed = await tx.update(runs).set({
          agentPoolId: pool.id,
          status: "plan_queued",
          statusTimestamps: {
            ...(run.statusTimestamps ?? {}),
            "plan-queued-at": new Date().toISOString(),
          },
        }).where(claimWhere).returning({ id: runs.id });
        if (claimed.length === 0) return false;
        await tx.insert(agentJobs).values({
          id: `ajob-${crypto.randomUUID()}`,
          runId: run.id,
          agentPoolId: pool.id,
          phase: "plan",
          status: "queued",
          createdAt: Date.now(),
        });
        return true;
      });
      if (queued) {
        claimedRunIds.push(run.id);
        claimedWorkspaceIds.add(run.workspaceId);
        void reportRunVcsStatus(run.id, "plan_queued");
      }
      continue;
    }

    // Claim local and remote runs atomically by moving them into the first execution stage.
    const claimed = await db.update(runs)
      .set({ status: "fetching" })
      .where(claimWhere)
      .returning({ id: runs.id });

    if (claimed.length > 0) {
      claimedRunIds.push(run.id);
      claimedWorkspaceIds.add(run.workspaceId);
      // Advance through plan_queued then dispatch to planning
      executeRun(run.id).catch((err: unknown): void => { log.error("Worker error on run", { runId: run.id, error: err }); });
    }
  }

  return claimedRunIds;
  });
}

/**
 * Worker queue poll interval. The queue loop (startWorkerQueue) claims
 * pending runs and drains assessment/auto-destroy queues on this cadence.
 * Configurable for low-power homelab installs that want a gentler query
 * load; invalid, empty, or sub-100ms values fall back to 1500ms so a
 * misconfiguration cannot hot-loop the DB (kanban 3.7).
 */
const WORKER_POLL_INTERVAL_MS = ((): number => {
  const raw = process.env.TERRENCE_WORKER_POLL_MS;
  if (raw === undefined || raw === "") return 1500;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 100 ? parsed : 1500;
})();

export function startWorkerQueue(): void {
  // Off switch for benchmarks/tests that must run in a process with no
  // background DB activity (the polling loop otherwise injects queries
  // and CPU into measurements).
  if (process.env.TERRENCE_DISABLE_WORKER === "1") return;
  if (isWorkerLoopRunning) return;
  isWorkerLoopRunning = true;

  const poll = async (): Promise<void> => {
    try {
      await Promise.all([
        pollWorkerQueue(),
        enqueueDueAutoDestroyRuns(),
        enqueueDueAssessments().then(async (): Promise<void> => {
          await pollAssessmentQueue();
        }),
      ]);
    } catch (err: unknown) {
      log.error("Queue error", { error: err });
    } finally {
      setTimeout((): void => { void poll(); }, WORKER_POLL_INTERVAL_MS);
    }
  };

  void poll();
}
