import { envEnabled } from "./lib/env";
import { db } from "./db";
import {
  runs,
  configurationVersions,
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
  agentPoolAllowedProjects,
  agentPoolAllowedWorkspaces,
  adminGeneralSettings,
  projects,
} from "./db/schema";
import { eq, desc, asc, and, gt, lt, like, inArray, notInArray, or, sql, isNotNull, isNull } from "drizzle-orm";
import { spawn } from "bun";
import { createHash, createHmac } from "node:crypto";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { mkdir, mkdtemp, rm, writeFile, readFile, exists, readdir, rename, stat } from "fs/promises";
import { ensureBinary } from "./binaryManager";
import { resolveInfracostBinary } from "./lib/infracost-bin";
import { recordFailure, workerPollerFinished, workerPollFinished, workerPollStarted } from "./lib/process-metrics";
import {
  captureProcessOutput,
  processOutputPreview,
  type CapturedProcessOutput,
} from "./lib/process-output";
import { isStorageDegraded, isDiskFullError, markStorageDegraded } from "./lib/storage-health";
import { workspaceExecutionDirectory } from "./workspace";
import { queueAssessmentNotification, queueRunNotification } from "./lib/notifications";
import { canTransitionRunStatus, isTerminalRunStatus } from "./lib/run-status";
import { FINAL_RUN_STATUSES, WORKSPACE_BLOCKING_RUN_STATUSES, apiURL, signedApiURL, decodeStatePayload } from "./lib/utils";
import { fetchResolvedExternalUrl, resolveExternalUrl } from "./lib/url-safety";
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
  writePlanJsonArtifactFromFile,
  type PlanResourceCounts,
} from "./lib/plan-json";
import { refetchConfigurationVersion, reportRunVcsStatus } from "./lib/webhooks";
import { agentPoolAllowsWorkspace } from "./lib/agent-pool-scope";
import { insertAgentApplyJobTx, recoverStaleAgentJobs, type AgentJob } from "./lib/agent-jobs";
import { mintRunToken, revokeRunTokens, writeRunCliConfig } from "./lib/run-token";
import { applyGateBlockReason } from "./lib/operations";
import { isMaintenanceActive } from "./lib/maintenance";
import { publish } from "./lib/event-bus";
import { probeLandlockAbi, RunSandbox, removeSandboxWorkDir, runNetDenyEnabled, runSandboxRequired } from "./lib/sandbox";
import { createRunCgroup, destroyRunCgroup, killRunCgroup } from "./lib/run-cgroup";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./lib/secrets";
import { variableValueForRead } from "./lib/variable-crypto";
import { encryptStatePayload } from "./lib/validation";
import { log, safeJsonStringify } from "./lib/log";
export type { ExecutionPhase } from "./worker/phases";
export { executorBackendFromEnv, type ExecutorBackend, EXECUTOR_BACKENDS } from "./worker/executor-policy";
import {
  assertArchiveExpandedSize,
  assertArchiveLogicalSize,
  assertArchiveMemberCount,
  tarMemberIsForbiddenSpecial,
  tarMemberPathUnsafe,
} from "./lib/archive";
export { tarMemberIsForbiddenSpecial, tarMemberPathUnsafe } from "./lib/archive";
import { startDurableJobWorker } from "./lib/durable-jobs";
import { handleVcsWebhookJob } from "./lib/webhook-jobs";
import { runModuleTestJob } from "./lib/module-test-worker";
import { runStackConfigurationJob, runStackDeploymentJob } from "./lib/stack-worker";
import { runPlanExplanationJob } from "./lib/plan-explainer-worker";
import { purgeExpiredForwardedRequests } from "./lib/agent-forwarding";
import { newRunId } from "./lib/run-id";
import { runExplorerCatalogJob, runExplorerInventoryJob, scheduleExplorerInventory } from "./lib/explorer-inventory";
import { revokeWorkloadIdentityTokens, workspaceIdentityEnvironment } from "./lib/workload-identity";
import { costEstimationEnabledForOrganization, getSettings } from "./lib/settings";
import { storageDir } from "./db/driver";
import { insertStateVersionWithSerialRetry } from "./lib/state-serial";
import { jitteredPollDelay } from "./lib/poll-jitter";


// --- Run sandbox (Landlock isolation for tofu/terraform) ---
// Terraform/OpenTofu runs are executed through landlock-runner, which applies
// a filesystem allow-list (workdir + binary dir + system libraries) to itself
// before exec. Provider plugins and local-exec provisioners inherit the
// restrictions, so they cannot see STORAGE_DIR (DB, encryption key, state
// archives) or other workspaces. The sandbox is required by default
// (TERRENCE_RUN_SANDBOX unset means sandboxed); disable it explicitly with
// TERRENCE_RUN_SANDBOX=false.
const RUN_SANDBOX_REQUIRED = runSandboxRequired();
const runSandbox = RUN_SANDBOX_REQUIRED && RunSandbox.isUsable() ? new RunSandbox() : null;
const POLICY_EVALUATION_TIMEOUT_MS = 30_000;
if (RUN_SANDBOX_REQUIRED && runSandbox === null) {
  log.error(
    "Run sandbox is required (the default) but Landlock is unavailable. "
    + "Runs will FAIL until Landlock is enabled on the host kernel or the sandbox is disabled. "
    + "Set TERRENCE_RUN_SANDBOX=false, or use `docker compose -f docker-compose.yml -f docker-compose.unsandboxed.yml up -d`. "
    + "See https://docs.kernel.org/userspace-api/landlock.html",
  );
}
// Prominent warning whenever unsandboxed execution is explicitly enabled
// (todo 89): the opt-out is insecure by definition, so it must be impossible
// to miss in the logs.
if (!RUN_SANDBOX_REQUIRED) {
  log.warn(
    "!!! RUN SANDBOX DISABLED (TERRENCE_RUN_SANDBOX=false) — IaC runs execute "
    + "WITHOUT filesystem isolation. Provider plugins and local-exec provisioners "
    + "run with this process's service identity and can read STORAGE_DIR, the "
    + "database, and encryption keys. This mode is only intended for hosts whose "
    + "kernel cannot provide Landlock (Linux >= 5.13, CONFIG_SECURITY_LANDLOCK).",
  );
}

/**
 * Guard used by run/apply/assessment entry points: if the sandbox is required
 * but unavailable, refuse to execute anything rather than silently running
 * unsandboxed IaC. Throws an Error that surfaces as a failed run.
 */
function assertRunSandboxAvailable(): void {
  if (!RUN_SANDBOX_REQUIRED) return;
  if (runNetDenyEnabled() && probeLandlockAbi() < 4) {
    throw new Error(
      "Run network isolation requires Landlock ABI >= 4 (TERRENCE_RUN_NET_POLICY=deny). "
        + `Host ABI is ${probeLandlockAbi()}. Upgrade the kernel or set TERRENCE_RUN_NET_POLICY=allow.`,
    );
  }
  if (runSandbox === null) {
    throw new Error(
      "Run sandbox unavailable: Landlock is not enabled on this host kernel. "
      + "Enable Landlock (Linux >= 5.13, CONFIG_SECURITY_LANDLOCK) or set TERRENCE_RUN_SANDBOX=false "
      + "to run without isolation. See https://docs.kernel.org/userspace-api/landlock.html",
    );
  }
}

/**
 * Policy engines execute administrator-supplied policy source and must use
 * the same isolation boundary as IaC runs. Tests and the explicit insecure
 * opt-out may run without Landlock; production's default is fail-closed.
 */
function policyEvaluationSandbox(): RunSandbox | null {
  if (envEnabled(process.env["SIMULATED_RUNS"]) || !runSandboxRequired()) return null;
  if (!RunSandbox.isUsable() || !RunSandbox.hasRunner()) {
    throw new Error("Landlock sandbox is required but unavailable for policy evaluation");
  }
  return new RunSandbox();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function isMissingFileError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isExpectedProcessTerminationError(error: unknown): boolean {
  if (["ENOENT", "ESRCH"].includes(errorCode(error) ?? "")) return true;
  return /(?:already exited|no such process|not running)/i.test(errorMessage(error));
}

function logBestEffortFailure(
  message: string,
  context: Readonly<Record<string, unknown>>,
  error: unknown,
): void {
  log.warn(message, { ...context, error: errorMessage(error) });
}

function logProcessTerminationFailure(
  error: unknown,
  context: Readonly<Record<string, unknown>>,
): void {
  if (!isExpectedProcessTerminationError(error)) {
    logBestEffortFailure("Failed to terminate run process", context, error);
  }
}

/** Executor policy check (36-39): returns an error message when local execution is forbidden. */
export function executorPolicyAllowsLocal(
  workspace: Readonly<{ trustedExecution?: boolean | null; executionMode?: string | null }>,
  project: Readonly<{ allowedExecutionModes?: string | null }> | null,
  organization: Readonly<{ requireHardIsolation?: boolean | null }> | null,
): string | null {
  // Per-workspace: untrusted workspaces must not run locally.
  if (workspace.trustedExecution === false) return "Workspace is marked untrusted: local execution is refused. Use an isolated executor (agent/container).";
  // Per-project: if allowedExecutionModes is set, local "remote" must be listed.
  if (project?.allowedExecutionModes !== null && project?.allowedExecutionModes !== undefined) {
    const allowed = project.allowedExecutionModes.split(",").map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes("remote") && !allowed.includes("local")) {
      return `Project restricts execution to [${allowed.join(", ")}]; local execution is not allowed.`;
    }
  }
  // Per-organization: require hard isolation means no local Landlock.
  if (organization?.requireHardIsolation === true) return "Organization requires hard isolation: local execution is disabled.";
  return null;
}

/** Resolve the run workdir (tmpdir-based; the sandbox allow-lists it per run). */
export function runWorkDir(runId: string): string {
  return runSandbox !== null ? runSandbox.workDirFor(runId) : join(tmpdir(), "terrence", "runs", runId);
}

const LOCAL_BACKEND_OVERRIDE = 'terraform {\n  backend "local" {}\n}\n';

async function writeLocalBackendOverride(executionDir: string): Promise<void> {
  await writeFile(join(executionDir, "terrence_backend_override.tf"), LOCAL_BACKEND_OVERRIDE, { mode: 0o600 });
}

type SavedPlanMetadata = Readonly<{
  sha256: string;
  stateId: string | null;
  stateSerial: number;
  configurationVersionId: string | null;
}>;

class SavedPlanIntegrityError extends Error {
  constructor() {
    super("Saved plan integrity check failed.");
    this.name = "SavedPlanIntegrityError";
  }
}

function savedPlanDirectory(runId: string): string {
  return join(storageDir, "saved-plans", runId);
}

export async function cleanupSavedPlan(runId: string): Promise<void> {
  await rm(savedPlanDirectory(runId), { recursive: true, force: true });
}

export async function cleanupRunWorkDir(runId: string): Promise<void> {
  if (runSandbox !== null) await removeSandboxWorkDir(runId);
  else await rm(runWorkDir(runId), { recursive: true, force: true });
}

export function scheduleRunWorkDirCleanup(runId: string, delayMs = 6_000): void {
  const timer = setTimeout((): void => {
    void cleanupRunWorkDir(runId).catch((error: unknown): void => {
      logBestEffortFailure("Scheduled run workdir cleanup failed", { runId }, error);
    });
  }, delayMs);
  timer.unref?.();
}

function savedPlanFile(runId: string): string {
  return join(savedPlanDirectory(runId), "tfplan");
}

function savedPlanMetadataFile(runId: string): string {
  return join(savedPlanDirectory(runId), "metadata.json");
}

async function persistSavedPlan(
  runId: string,
  executionDir: string,
  state: Readonly<{ id: string | null; serial: number }>,
  configurationVersionId: string | null,
  simulated: boolean,
): Promise<SavedPlanMetadata> {
  const source = join(executionDir, "tfplan");
  const directory = savedPlanDirectory(runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPlan = join(directory, `.tfplan-${crypto.randomUUID()}`);
  const bytes = await (await exists(source)
    ? readFile(source)
    : simulated
      ? Promise.resolve(Buffer.from("terrence-simulated-plan\n"))
      : Promise.reject(new Error("Terraform did not produce a saved plan file.")));
  const metadata: SavedPlanMetadata = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    stateId: state.id,
    stateSerial: state.serial,
    configurationVersionId,
  };
  await writeFile(temporaryPlan, await encryptSecret(bytes.toString("base64")), { mode: 0o600 });
  await rename(temporaryPlan, savedPlanFile(runId));
  const temporaryMetadata = join(directory, `.metadata-${crypto.randomUUID()}`);
  await writeFile(temporaryMetadata, JSON.stringify(metadata), { mode: 0o600 });
  await rename(temporaryMetadata, savedPlanMetadataFile(runId));
  return metadata;
}

async function readSavedPlanMetadata(runId: string): Promise<SavedPlanMetadata | undefined> {
  const path = savedPlanMetadataFile(runId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) return undefined;
    throw new Error(`Could not read saved plan metadata for run ${runId}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new Error(`Saved plan metadata for run ${runId} is invalid JSON: ${errorMessage(error)}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Saved plan metadata for run ${runId} has an invalid shape.`);
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value["sha256"] !== "string" || typeof value["stateSerial"] !== "number") {
    throw new Error(`Saved plan metadata for run ${runId} has an invalid shape.`);
  }
  const stateId = value["stateId"];
  const configurationVersionId = value["configurationVersionId"];
  if (
    !Object.hasOwn(value, "stateId")
    || !Object.hasOwn(value, "configurationVersionId")
    || (stateId !== null && typeof stateId !== "string")
    || (configurationVersionId !== null && typeof configurationVersionId !== "string")
  ) {
    throw new Error(`Saved plan metadata for run ${runId} has an invalid shape.`);
  }
  return {
    sha256: value["sha256"],
    stateId: stateId as string | null,
    stateSerial: value["stateSerial"],
    configurationVersionId: configurationVersionId as string | null,
  };
}

async function restoreSavedPlan(runId: string, executionDir: string): Promise<SavedPlanMetadata | undefined> {
  const metadata = await readSavedPlanMetadata(runId);
  if (metadata === undefined || !(await exists(savedPlanFile(runId)))) return undefined;
  const stored = await readFile(savedPlanFile(runId));
  const storedText = stored.toString("utf8");
  const bytes = isEncryptedSecret(storedText)
    ? Buffer.from(await decryptSecret(storedText), "base64")
    : stored;
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== metadata.sha256) throw new SavedPlanIntegrityError();
  await mkdir(executionDir, { recursive: true, mode: 0o700 });
  await writeFile(join(executionDir, "tfplan"), bytes, { mode: 0o600 });
  return metadata;
}

async function recordPlanInput(
  runId: string,
  state: Readonly<{ id: string | null; serial: number }>,
  savedPlan: SavedPlanMetadata | undefined,
): Promise<void> {
  const current = await db.query.runs.findFirst({ where: eq(runs.id, runId), columns: { status: true, statusTimestamps: true } });
  if (current === undefined) throw new Error(`Run ${runId} disappeared while recording its plan input.`);
  const timestamps = {
    ...(current.statusTimestamps ?? {}),
    ...(state.id === null ? {} : { "input-state-version-id": state.id }),
    "input-state-serial": String(state.serial),
    ...(savedPlan === undefined ? {} : { "saved-plan-sha256": savedPlan.sha256 }),
  };
  const updated = await db.update(runs).set({ statusTimestamps: timestamps }).where(and(eq(runs.id, runId), eq(runs.status, current.status))).returning({ id: runs.id });
  if (updated.length === 0) throw new Error(`Run ${runId} changed while recording its plan input.`);
}

// Warn once per (run, phase) so a burst of log writes cannot flood the log
// output, while the failure counter still tracks every lost write.
const MAX_WARNED_RUN_LOG_FAILURES = 1000;
const warnedRunLogFailures = new Set<string>();

function pruneWarnedRunLogFailuresIfNeeded(): void {
  if (warnedRunLogFailures.size <= MAX_WARNED_RUN_LOG_FAILURES) return;
  const targetSize = Math.floor(MAX_WARNED_RUN_LOG_FAILURES / 2);
  const toDelete = warnedRunLogFailures.size - targetSize;
  let deleted = 0;
  for (const key of warnedRunLogFailures) {
    warnedRunLogFailures.delete(key);
    deleted++;
    if (deleted >= toDelete) break;
  }
}

export function warnedRunLogFailuresSizeForTests(): number {
  return warnedRunLogFailures.size;
}

export function clearWarnedRunLogFailuresForTests(): void {
  warnedRunLogFailures.clear();
}

export function addWarnedRunLogFailureForTests(key: string): void {
  warnedRunLogFailures.add(key);
  pruneWarnedRunLogFailuresIfNeeded();
}

type TrackedRunProcess = Readonly<{
  pid: number | null;
  kill: (signal?: string | number) => void;
  exited: Promise<number>;
  stdout?: Readonly<ReadableStream<Uint8Array>>;
  stderr?: Readonly<ReadableStream<Uint8Array>>;
}>;

function killTrackedProcess(
  child: TrackedRunProcess,
  signal: "SIGINT" | "SIGKILL",
  runId: string,
  phase: string,
): void {
  try {
    child.kill(signal);
  } catch (error: unknown) {
    logProcessTerminationFailure(error, { runId, phase, pid: child.pid, signal });
  }
}

const activeRunProcesses = new Map<string, Set<TrackedRunProcess>>();
/** Per-run cgroup paths (kanban 8/9). Empty when cgroups are unavailable. */
const activeRunCgroups = new Map<string, string>();
type CancellationEscalationTimer = ReturnType<typeof setTimeout>;
const cancellationEscalationTimers = new Map<string, Map<number | null, CancellationEscalationTimer>>();

function clearCancellationEscalationTimers(runId: string): void {
  const timers = cancellationEscalationTimers.get(runId);
  if (timers === undefined) return;
  for (const timer of timers.values()) clearTimeout(timer);
  cancellationEscalationTimers.delete(runId);
}

/**
 * Keep the process-group grace period alive independently of the tracked leader
 * and release the timer when it fires. A per-run/process-group key prevents
 * repeated cancellation requests from accumulating identical timers.
 */
function scheduleCancellationEscalation(runId: string, pgid: number | null): void {
  const timers = cancellationEscalationTimers.get(runId) ?? new Map<number | null, CancellationEscalationTimer>();
  if (timers.has(pgid)) return;
  const timer = setTimeout((): void => {
    const current = cancellationEscalationTimers.get(runId);
    current?.delete(pgid);
    if (current?.size === 0) cancellationEscalationTimers.delete(runId);
    terminateProcessGroup(pgid, "SIGKILL");
    // Cgroup backstop: after grace, hard-kill any straggler the group
    // signals missed (daemonizers, setpgid escapes).
    if (activeRunCgroups.get(runId) !== undefined) killRunCgroup(runId);
  }, 5_000);
  timer.unref?.();
  timers.set(pgid, timer);
  cancellationEscalationTimers.set(runId, timers);
}

/** Test-only visibility for cancellation timer lifecycle assertions. */
export function cancellationEscalationTimerCountForTests(runId: string): number {
  return cancellationEscalationTimers.get(runId)?.size ?? 0;
}

/** Test-only timer identity for proving repeated cancellation reuses a timer. */
export function cancellationEscalationTimerForTests(runId: string): CancellationEscalationTimer | undefined {
  return cancellationEscalationTimers.get(runId)?.values().next().value;
}

/** Test-only visibility for whether an escalation timer retains the event loop. */
export function cancellationEscalationTimerReferencedForTests(runId: string): boolean | undefined {
  const timer = cancellationEscalationTimers.get(runId)?.values().next().value;
  if (timer === undefined) return undefined;
  const hasRef = (timer as unknown as { hasRef?: () => boolean }).hasRef;
  return typeof hasRef === "function" ? hasRef.call(timer) : undefined;
}

/** Test-only cleanup for the timer and process tracking hooks. */
export function clearCancellationEscalationTimersForTests(): void {
  for (const runId of cancellationEscalationTimers.keys()) clearCancellationEscalationTimers(runId);
}

/** Register a synthetic process for cancellation lifecycle tests. */
export function trackRunProcessForTests(runId: string, process: TrackedRunProcess): void {
  trackRunProcess(runId, process);
}

/** Clear synthetic process registrations after cancellation lifecycle tests. */
export function clearTrackedRunProcessesForTests(): void {
  activeRunProcesses.clear();
}

/** Create the run's cgroup (limits applied) when the host allows it. */
export function prepareRunCgroup(runId: string): string | null {
  const path = createRunCgroup(runId);
  if (path !== null) activeRunCgroups.set(runId, path);
  return path;
}

export function getRunCgroup(runId: string): string | null {
  return activeRunCgroups.get(runId) ?? null;
}

function spawnRunProcess(
  runId: string,
  args: readonly string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    stdout?: "pipe" | "ignore" | "inherit";
    stderr?: "pipe" | "ignore" | "inherit";
  },
  sandbox?: RunSandbox | null,
): TrackedRunProcess {
  const cgroup = activeRunCgroups.get(runId) ?? null;
  if (sandbox !== undefined && sandbox !== null) {
    const proc = sandbox.spawnGeneric(args, {
      cwd: options.cwd,
      env: options.env ?? {},
      cgroup,
    });
    return trackRunProcess(runId, proc);
  }
  const spawnOpts: Record<string, unknown> = {
    cwd: options.cwd,
    env: options.env ?? (process.env),
    stdout: options.stdout ?? "pipe",
    stderr: options.stderr ?? "pipe",
    detached: true,
  };
  if (cgroup !== null && cgroup !== "") {
    spawnOpts["cgroup"] = cgroup;
  }
  const proc = spawn(args as string[], spawnOpts as never);
  return trackRunProcess(runId, proc);
}

function trackRunProcess(runId: string, process: unknown): TrackedRunProcess {
  const child = process as TrackedRunProcess & { pid?: number | null };
  // Each tracked run subprocess is spawned with `detached: true`, making it the
  // leader of its own process group. That lets cancellation terminate the
  // whole group — the CLI binary, any shell wrapper, and all of its
  // grandchildren (providers, provisioners) — in one operation. Without a
  // dedicated group, a negative-pid kill would also target the worker's own
  // group.
  const tracked = {
    pid: child.pid ?? null,
    kill: child.kill,
    exited: child.exited,
    stdout: child.stdout,
    stderr: child.stderr,
  } as TrackedRunProcess;
  const processes = activeRunProcesses.get(runId) ?? new Set<TrackedRunProcess>();
  processes.add(tracked);
  activeRunProcesses.set(runId, processes);
  void tracked.exited.then((): void => {
    processes.delete(tracked);
    if (processes.size === 0) activeRunProcesses.delete(runId);
  }, (): void => {
    processes.delete(tracked);
    if (processes.size === 0) activeRunProcesses.delete(runId);
  });
  return tracked;
}

/**
 * Terminate every process in a run's process group via a negative-pid signal.
 *
 * Targeting the group (not just the leader) is what reaps backgrounded
 * descendants: IaC runs spawn providers, local-exec shells, and `sleep &`
 * children whose SIGINT is ignored, so a signal sent only to the leader would
 * orphan them.
 *
 * PID-reuse safety: a negative-pid kill signals every member of the group
 * whose id equals `pid`. Once the last descendant exits, the group is empty
 * and the kernel returns ESRCH (caught below). A later unrelated process that
 * reuses `pid` as its own group id is a non-issue here — the escalation window
 * is seconds, far shorter than any realistic reuse horizon, and the group is
 * gone long before then. This matches the cooperative process-group
 * termination used by standard IaC run engines.
 */
function terminateProcessGroup(pid: number | null, signal: "SIGINT" | "SIGKILL"): void {
  if (pid === null || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch (error: unknown) {
    logProcessTerminationFailure(error, { pid, signal, scope: "process-group" });
  }
}

/** Stop the actual Terraform process before a canceled run can report success. */
export function cancelRunExecution(runId: string, force = false): void {
  const signal = force ? "SIGKILL" : "SIGINT";
  // Cgroup cancellation (todo 9) first when the run has a group: cgroup.kill
  // is atomic kernel-side and reaches daemonized/double-forked descendants
  // that escape process-group termination. Process-group signals still fire
  // as the primary path; the cgroup kill is the backstop, and only escalates
  // immediately on force.
  if (force) {
    clearCancellationEscalationTimers(runId);
    killRunCgroup(runId);
  }
  for (const child of activeRunProcesses.get(runId) ?? []) {
    const pgid = child.pid;
    // Kill the whole process group, not just the tracked leader. IaC runs spawn
    // descendants — providers, local-exec shells, and backgrounded commands
    // (e.g. `sleep &`) — some of which ignore SIGINT. Only SIGKILL cannot be
    // ignored, so it is what guarantees no orphan survives cancellation.
    terminateProcessGroup(pgid, signal);
    killTrackedProcess(child, signal, runId, "cancel");
    if (!force) {
      // Grace period for a clean shutdown (tofu writes partial state, releases
      // locks), then force-kill anything still left in the group. This
      // escalation is intentionally NOT cancelled when the tracked leader
      // exits: the leader dying does not mean the process group is empty,
      // because orphaned descendants keep the group alive until they too are
      // reaped. Escalating to the group — not just the tracked child — is what
      // terminates those orphans.
      scheduleCancellationEscalation(runId, pgid);
    }
  }
}

export function terminateActiveRunExecutions(): void {
  const runIds = new Set([...activeRunProcesses.keys(), ...activeRunCgroups.keys(), ...cancellationEscalationTimers.keys()]);
  for (const runId of runIds) {
    clearCancellationEscalationTimers(runId);
    for (const child of activeRunProcesses.get(runId) ?? []) {
      terminateProcessGroup(child.pid, "SIGKILL");
      killTrackedProcess(child, "SIGKILL", runId, "shutdown");
    }
    if (activeRunCgroups.has(runId)) killRunCgroup(runId);
  }
}

/** Tear down a finished run's cgroup. Call from run finalization/cleanup. */
export function cleanupRunCgroup(runId: string): void {
  if (!activeRunCgroups.delete(runId)) return;
  destroyRunCgroup(runId);
}

async function runWasCanceled(runId: string): Promise<boolean> {
  const row = await db.query.runs.findFirst({ where: eq(runs.id, runId), columns: { status: true } });
  return row?.status === "canceled" || row?.status === "force_canceled";
}

/** Plan-phase cancel exit (issue #615): leave a user-visible line so a
 *  canceled run never ends in log silence or, worse, an internal
 *  state-machine error. Returns true when the caller must return. */
async function returnIfRunCanceled(runId: string): Promise<boolean> {
  if (!(await runWasCanceled(runId))) return false;
  await writeLog(runId, "plan", "[terrence] Run canceled.");
  return true;
}

type RunLogPhase = "plan" | "apply";
type RunDiagnosticLevel = "info" | "warn" | "error";

type RunDiagnosticFields = Readonly<Record<string, unknown>>;

async function writeLog(runId: string, phase: RunLogPhase, outputText: string): Promise<void> {
  try {
    await db.insert(logs).values({
      id: crypto.randomUUID(),
      runId,
      phase,
      outputText,
      createdAt: Date.now(),
    });
  } catch (error: unknown) {
    if (isDiskFullError(error)) markStorageDegraded("run log writes are failing (disk full)");
    recordFailure("runLogWrites");
    const key = `${runId}:${phase}`;
    if (!warnedRunLogFailures.has(key)) {
      warnedRunLogFailures.add(key);
      pruneWarnedRunLogFailuresIfNeeded();
      log.error("Failed to persist run log output", {
        runId,
        phase,
        error,
      });
    }
  }
}

/** Persist machine-readable context beside human-readable run output. */
async function writeRunDiagnostic(
  runId: string,
  phase: RunLogPhase,
  level: RunDiagnosticLevel,
  event: string,
  message: string,
  fields: RunDiagnosticFields = {},
): Promise<void> {
  const record = {
    ...fields,
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    level,
    event,
    runId,
    phase,
    message,
  };
  await writeLog(runId, phase, `[terrence diagnostic] ${safeJsonStringify(record)}`);
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
  let workspaceId: string | null = null;
  try {
    const existing = await db.query.runs.findFirst({
      where: eq(runs.id, runId),
      columns: { statusTimestamps: true, status: true, workspaceId: true },
    });
    workspaceId = existing?.workspaceId ?? null;
    const existingTimestamps = typeof existing?.statusTimestamps === "object" && existing.statusTimestamps !== null
      ? existing.statusTimestamps
      : {};
    // State machine guard: illegal writes are rejected, not merely logged.
    // Otherwise a canceled worker can overwrite the terminal cancellation with
    // "applied" after the operator action has already returned.
    const currentStatus = existing?.status;
    if (currentStatus !== undefined && currentStatus !== status && !canTransitionRunStatus(currentStatus, status)) {
      throw new Error(`Illegal run status transition for ${runId}: ${currentStatus} -> ${status}`);
    }
    const timestamps = { ...existingTimestamps, [statusKey]: now };
    const updated = await db.update(runs)
      .set({ status, statusTimestamps: timestamps, ...(extra ?? {}) })
      .where(and(eq(runs.id, runId), eq(runs.status, currentStatus ?? status)))
      .returning({ id: runs.id });
    if (updated.length === 0) {
      // A concurrent cancel/force-cancel won the race after the read above.
      // Do not publish or notify a transition that was not persisted.
      throw new Error(`Run ${runId} status transition to ${status} lost its compare-and-set race`);
    }
  } catch (err: unknown) {
    log.error(`Failed to update run ${runId} status to ${status}`, { error: err instanceof Error ? err.message : String(err) });
    throw err;
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
  // Publish the transition on the in-process bus so authenticated SSE
  // clients (10.20) can refresh without polling. The org lookup is one
  // cheap indexed read per transition; the event is dropped for clients
  // that are not members of the run's organization.
  if (workspaceId !== null) {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { orgId: true },
    });
    publish("run.status", {
      "run-id": runId,
      "workspace-id": workspaceId,
      "org-id": workspace?.orgId ?? null,
      status,
      at: now,
    });
    scheduleExplorerInventory(workspaceId);
  }
  // Terminal states close the run credential (the reference format run-token model): the token
  // is revoked before the status update returns, so the credential is dead the
  // moment callers observe the terminal state.
  if (isTerminalRunStatus(status)) {
    await cleanupRunToken(runId);
  }
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
  const address = asObject(check["address"]);
  const kind = typeof address?.["kind"] === "string" ? address["kind"] : "check";
  if (typeof address?.["to_display"] === "string") return { address: address["to_display"], kind };
  const parts = [address?.["type"], address?.["name"]].filter((part: unknown): part is string =>
    typeof part === "string" && part !== "");
  return { address: parts.length > 0 ? `${kind}.${parts.join(".")}` : `check.${String(index + 1)}`, kind };
}

function checkMessage(check: JsonObject): string | null {
  const messages = (Array.isArray(check["instances"]) ? check["instances"] : [])
    .flatMap((instance: unknown): unknown[] => {
      const value = asObject(instance);
      return Array.isArray(value?.["problems"]) ? value["problems"] : [];
    })
    .map((problem: unknown): string | undefined => {
      const value = asObject(problem);
      return typeof value?.["message"] === "string" ? value["message"] : undefined;
    })
    .filter((message: string | undefined): message is string => message !== undefined);
  return messages.length === 0 ? null : messages.join("\n");
}

async function storePlanCheckResults(
  workspaceId: string,
  planJson: JsonObject,
  association: Readonly<{ assessmentResultId?: string; runId?: string }>,
): Promise<StoredCheckSummary> {
  const rawChecks = Array.isArray(planJson["checks"]) ? planJson["checks"] : [];
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
    const normalizedStatus = checkStatus(check["status"]);
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

const MAX_CAPTURED_JSON_BYTES = 16 * 1024 * 1024;

async function readCapturedFile(output: CapturedProcessOutput): Promise<string> {
  return readFile(output.stdout.path, "utf8");
}

async function readCapturedJson(output: CapturedProcessOutput, label: string): Promise<string> {
  if (output.stdout.bytes > MAX_CAPTURED_JSON_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_CAPTURED_JSON_BYTES} byte limit`);
  }
  return readCapturedFile(output);
}

type PlanJsonCapture = Readonly<{ planJson: JsonObject; rawPath: string }>;

async function readPlanJson(
  runId: string,
  executionDir: string,
  planBinaryPath: string | undefined,
  timeoutMs: number,
  outputDirectory: string,
): Promise<PlanJsonCapture | undefined> {
  const tfplanPath = join(executionDir, "tfplan");
  if (!(await exists(tfplanPath))) return undefined;
  const binaries = [...new Set(
    [planBinaryPath, "tofu", "terraform"]
      .filter((binary: string | undefined): binary is string => typeof binary === "string" && binary !== ""),
  )];
  for (const binary of binaries) {
    let captured: CapturedProcessOutput | undefined;
    let keepStdout = false;
    let outputPromise: Promise<CapturedProcessOutput> | undefined;
    try {
      const child = spawnRunProcess(
        runId,
        [binary, "show", "-json", tfplanPath],
        {
          cwd: executionDir,
          env: { PATH: processEnv("PATH") },
          stdout: "pipe",
          stderr: "pipe",
        },
        runSandbox,
      );
      outputPromise = captureProcessOutput(child.stdout, child.stderr, outputDirectory, "terraform-show-json");
      const [exitCode, output] = await waitForTrackedProcess(runId, "plan", child, outputPromise, timeoutMs);
      captured = output;
      if (exitCode === 0) {
        // Terraform show -json is a file-backed user artifact and may
        // legitimately exceed the auxiliary JSON response limit. Keep the
        // parse isolated to its private spool file rather than rejecting a
        // valid large plan at an arbitrary 16 MiB boundary.
        const planJson = parseJsonObject(await readCapturedFile(output));
        keepStdout = true;
        return { planJson, rawPath: output.stdout.path };
      }
      log.warn("Terraform plan JSON command failed", {
        runId,
        binary,
        exitCode,
        stderr: output.stderr.preview.trim().slice(0, 2_000),
      });
    } catch (error: unknown) {
      logBestEffortFailure("Failed to read Terraform plan JSON", { runId, binary }, error);
    } finally {
      captured ??= await outputPromise?.catch((): undefined => undefined);
      if (captured !== undefined) {
        await rm(captured.stderr.path, { force: true });
        if (!keepStdout) await rm(captured.stdout.path, { force: true });
      }
    }
  }
  return undefined;
}

function processEnv(key: string): string {
  return process.env[key] ?? "";
}

async function infracostEnvironment(gcpCredentialsPath: string): Promise<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (key === "PATH" || key.startsWith("INFRACOST_"))) environment[key] = value;
  }
  const settings = await getSettings("cost");
  const stringSetting = (key: string): string | undefined => {
    const value = settings[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const mappedSettings: Readonly<Record<string, string | undefined>> = {
    INFRACOST_API_KEY: stringSetting("infracost-api-key"),
    AWS_ACCESS_KEY_ID: stringSetting("aws-access-key-id"),
    AWS_SECRET_ACCESS_KEY: stringSetting("aws-secret-key"),
    AZURE_CLIENT_ID: stringSetting("azure-client-id"),
    AZURE_CLIENT_SECRET: stringSetting("azure-client-secret"),
    AZURE_SUBSCRIPTION_ID: stringSetting("azure-subscription-id"),
    AZURE_TENANT_ID: stringSetting("azure-tenant-id"),
  };
  for (const [key, value] of Object.entries(mappedSettings)) {
    if (value !== undefined) environment[key] = value;
  }
  const gcpCredentials = settings["gcp-credentials"];
  if (typeof gcpCredentials === "string" && gcpCredentials !== "") {
    await writeFile(gcpCredentialsPath, gcpCredentials, { mode: 0o600 });
    environment["GOOGLE_APPLICATION_CREDENTIALS"] = gcpCredentialsPath;
  } else if (gcpCredentials !== null && typeof gcpCredentials === "object") {
    await writeFile(gcpCredentialsPath, JSON.stringify(gcpCredentials), { mode: 0o600 });
    environment["GOOGLE_APPLICATION_CREDENTIALS"] = gcpCredentialsPath;
  }
  return environment;
}

async function executeCostEstimate(runId: string, executionDir: string): Promise<void> {
  const run = await db.query.runs.findFirst({
    where: eq(runs.id, runId),
    columns: { statusTimestamps: true, workspaceId: true },
  });
  const statusTimestamps = run?.statusTimestamps ?? {};
  const timestamps: CostEstimateTimestamps = {
    "queued-at": statusTimestamps["planned-at"] ?? null,
    "pending-at": statusTimestamps["cost-estimating-at"] ?? new Date().toISOString(),
    "finished-at": null,
  };

  const workspace = run === undefined
    ? undefined
    : await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId), columns: { orgId: true } });
  if (workspace === undefined || !(await costEstimationEnabledForOrganization(workspace.orgId))) {
    await writeLog(runId, "plan", "[terrence] Cost estimation is disabled. Skipping.");
    const estimate = emptyCostEstimate("skipped_due_to_targeting", {
      ...timestamps,
      "finished-at": new Date().toISOString(),
    });
    await writeCostEstimateArtifact(runId, estimate);
    return;
  }

  const inputPath = join(executionDir, "terrence.infracost-plan.json");
  // GCP credentials must never live inside executionDir: that directory holds
  // user-supplied Terraform configuration, and a configuration that uses a
  // local_file data source or an external provider can read any file path
  // while the process is running. Keep the credentials in a private temp dir
  // outside the workspace and remove it when the estimate finishes.
  const secretsDir = await mkdtemp(join(tmpdir(), "terrence-infracost-"));
  const gcpCredentialsPath = join(secretsDir, "gcp-credentials.json");

  try {
    await writeCostEstimateArtifact(runId, emptyCostEstimate("pending", timestamps));
    const planJson = await readPlanJsonArtifact(runId);
    if (planJson === undefined) throw new Error("Persisted Terraform plan JSON is unavailable.");
    await writeFile(inputPath, JSON.stringify(planJson), { mode: 0o600 });

    // Resolve the Infracost binary: an explicit INFRACOST_BINARY override wins,
    // otherwise a version-pinned binary managed under <storage>/binaries/
    // (selected by INFRACOST_VERSION) is installed on demand and digest-verified.
    // A null here means no binary could be resolved/installed; the estimate is
    // recorded as errored (non-fatal to the surrounding plan/apply run).
    const managed = await resolveInfracostBinary();
    if (managed === null) {
      throw new Error("Infracost binary is unavailable (no INFRACOST_BINARY override and managed install failed)");
    }
    const costProcess = spawnRunProcess(
      runId,
      [managed.binaryPath, "breakdown", "--path", inputPath, "--format", "json", "--no-color"],
      {
        cwd: executionDir,
        env: await infracostEnvironment(gcpCredentialsPath),
        stdout: "pipe",
        stderr: "pipe",
      },
      runSandbox,
    );
    const costOutput = captureProcessOutput(costProcess.stdout, costProcess.stderr, secretsDir, "infracost");
    const [exitCode, capturedOutput] = await waitForTrackedProcess(
      runId,
      "cost-estimate",
      costProcess,
      costOutput,
      await executionTimeoutMs("plan"),
    );
    if (exitCode !== 0) {
      const detail = capturedOutput.stderr.preview.trim().slice(0, 2_000);
      throw new Error(`Infracost exited with code ${exitCode}${detail === "" ? "" : `: ${detail}`}`);
    }

    const estimate = parseInfracostOutput(JSON.parse(await readCapturedJson(capturedOutput, "Infracost output")) as unknown, {
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
    const cleanupTargets: readonly { label: string; operation: Promise<void> }[] = [
      { label: "plan input", operation: rm(inputPath, { force: true }) },
      { label: "credentials directory", operation: rm(secretsDir, { recursive: true, force: true }) },
    ];
    const cleanupResults = await Promise.allSettled(cleanupTargets.map((target) => target.operation));
    for (const [index, result] of cleanupResults.entries()) {
      if (result.status === "rejected") {
        const target = cleanupTargets[index];
        if (target !== undefined) {
          logBestEffortFailure("Could not clean up cost-estimate temporary files", { runId, artifact: target.label }, result.reason);
        }
      }
    }
  }
}

function assessmentResourceCounts(planJson: JsonObject): { drifted: number; undrifted: number } {
  const resourceChanges = Array.isArray(planJson["resource_changes"]) ? planJson["resource_changes"] : [];
  let drifted = 0;
  let undrifted = 0;
  for (const rawChange of resourceChanges) {
    const change = asObject(rawChange);
    if (change?.["mode"] === "data") continue;
    const detail = asObject(change?.["change"]);
    const actions = Array.isArray(detail?.["actions"]) ? detail["actions"] : [];
    if (actions.length === 0 || actions.every((action: unknown): boolean => action === "no-op" || action === "read")) {
      undrifted += 1;
    } else {
      drifted += 1;
    }
  }
  return { drifted, undrifted };
}

async function waitForTrackedProcess<T>(
  runId: string,
  phase: string,
  child: TrackedRunProcess,
  output: Promise<T>,
  timeoutMs: number,
): Promise<readonly [number, T]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelEscalationTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let cancellationRequested = false;
  let cancellationPollFailureLogged = false;
  const requestCancellation = (force: boolean): void => {
    if (cancellationRequested && !force) return;
    cancellationRequested = true;
    const signal = force ? "SIGKILL" : "SIGINT";
    terminateProcessGroup(child.pid, signal);
    killTrackedProcess(child, signal, runId, phase);
    if (force) killRunCgroup(runId);
    if (!force && cancelEscalationTimer === undefined) {
      cancelEscalationTimer = setTimeout((): void => {
        terminateProcessGroup(child.pid, "SIGKILL");
        killTrackedProcess(child, "SIGKILL", runId, `${phase}-cancellation`);
        killRunCgroup(runId);
      }, 5_000);
    }
  };
  const cancellationPoller = setInterval((): void => {
    void db.query.runs.findFirst({ where: eq(runs.id, runId), columns: { status: true } }).then((run): void => {
      if (run?.status === "force_canceled") requestCancellation(true);
      else if (run?.status === "canceled") requestCancellation(false);
    }).catch((error: unknown): void => {
      if (cancellationPollFailureLogged) return;
      cancellationPollFailureLogged = true;
      logBestEffortFailure("Cancellation status polling failed", { runId, phase }, error);
    });
  }, 250);
  cancellationPoller.unref?.();
  const completed = Promise.all([child.exited, output]);
  const timeout = new Promise<never>((_, reject): void => {
    timer = setTimeout((): void => {
      timedOut = true;
      reject(new Error(`${phase} process timed out after ${String(timeoutMs)} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([completed, timeout]);
  } catch (error: unknown) {
    if (!timedOut) {
      terminateProcessGroup(child.pid, "SIGKILL");
      killTrackedProcess(child, "SIGKILL", runId, `${phase}-output-failure`);
      if (activeRunCgroups.has(runId)) killRunCgroup(runId);
      await Promise.allSettled([child.exited, output]);
      throw error;
    }
    terminateProcessGroup(child.pid, "SIGKILL");
    killTrackedProcess(child, "SIGKILL", runId, `${phase}-timeout`);
    if (activeRunCgroups.has(runId)) killRunCgroup(runId);
    await Promise.allSettled([child.exited, output]);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cancelEscalationTimer !== undefined) clearTimeout(cancelEscalationTimer);
    clearInterval(cancellationPoller);
  }
}

async function streamLog(
  runId: string,
  phase: "plan" | "apply",
  stream: Readonly<ReadableStream<Uint8Array>> | undefined,
): Promise<void> {
  if (stream === undefined) return;
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

export function buildSanitizedEnv(
  workspaceVars: readonly { readonly key: string; readonly value: string; readonly category: string; readonly sensitive?: boolean }[],
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
    } else if (v.category === "terraform" && v.sensitive === true) {
      env[`TF_VAR_${v.key}`] = v.value;
    }
  }

  if (extraEnv !== undefined) {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (typeof v === "string") env[k] = v;
    }
  }

  return env;
}

/** One environment recipe for both phases (issues #607, #608): workspace
 * variables, then run-scoped variables with identical category routing (env
 * keys verbatim, sensitive terraform as TF_VAR_, non-sensitive terraform via
 * the tfvars files, never -var flags), then the phase-specific identity
 * environment the caller resolved. Sharing the recipe keeps plan and apply
 * from drifting apart again. */
export function buildRunPhaseEnv(
  workspaceVars: readonly { readonly key: string; readonly value: string; readonly category: string; readonly sensitive?: boolean }[],
  runVariables: unknown,
  phaseEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...buildSanitizedEnv(workspaceVars),
    ...buildSanitizedEnv(normalizeRunVariables(runVariables)),
    ...phaseEnv,
  };
}

type ExecutionVariable = {
  key: string;
  value: string;
  category: string;
  hcl: boolean;
  priority: boolean;
  sensitive: boolean;
};

/**
 * Normalize per-run variables for execution (issue #577). Items carry key
 * and value with optional category ("env" or "terraform", defaulting to
 * terraform) and sensitive flag. Malformed entries are skipped: validation
 * at creation rejects them, so anything reaching here predates it.
 */
export function normalizeRunVariables(variables: unknown): { key: string; value: string; category: string; sensitive: boolean }[] {
  if (!Array.isArray(variables)) return [];
  const normalized: { key: string; value: string; category: string; sensitive: boolean }[] = [];
  for (const item of variables) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Readonly<Record<string, unknown>>;
    if (typeof record["key"] !== "string" || typeof record["value"] !== "string") continue;
    normalized.push({
      key: record["key"],
      value: record["value"],
      category: record["category"] === "env" ? "env" : "terraform",
      sensitive: record["sensitive"] === true,
    });
  }
  return normalized;
}

export async function executionVariables(
  workspaceId: string,
  orgId: string,
  projectId: string | null,
  workspaceVariableOverrides?: readonly Readonly<Pick<ExecutionVariable, "key" | "value" | "category" | "hcl" | "sensitive">>[],
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
  const workspaceSetIds = new Set(workspaceLinks.map((link): string => link.variableSetId));
  const projectSetIds = new Set(projectLinks.map((link): string => link.variableSetId));
  const ownedProjectSetIds = new Set(
    orgVariableSets
      .filter((set): boolean => projectId !== null && set.parentProjectId === projectId)
      .map((set): string => set.id),
  );
  const activeSets = orgVariableSets
    .filter((vs: { readonly global: boolean | null; readonly id: string }): boolean => vs.global === true || attached.has(vs.id) || ownedProjectSetIds.has(vs.id))
    .sort((left, right): number => {
      const rank = (set: { readonly id: string; readonly priority: boolean | null }): number =>
        (set.priority === true ? 10 : 0) + (workspaceSetIds.has(set.id) ? 2 : projectSetIds.has(set.id) ? 1 : 0);
      return rank(left) - rank(right)
        || right.name.localeCompare(left.name)
        || right.id.localeCompare(left.id);
    });
  const activeSetIds = activeSets.map((vs: { readonly id: string }): string => vs.id);

  // Build priority lookup
  const prioritySetIds = new Set(activeSets.filter((vs: { readonly priority: boolean | null; readonly id: string }): boolean => vs.priority === true).map((vs: { readonly id: string }): string => vs.id));

  const setVars = activeSetIds.length === 0
    ? []
    : await db.query.variableSetVariables.findMany({
        where: inArray(variableSetVariables.variableSetId, activeSetIds),
        orderBy: [asc(variableSetVariables.id)],
      });
  const setOrder = new Map(activeSets.map((set, index): [string, number] => [set.id, index]));
  const orderedSetVars = [...setVars].sort((left, right): number =>
    (setOrder.get(left.variableSetId) ?? Number.MAX_SAFE_INTEGER) - (setOrder.get(right.variableSetId) ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id));

  const effective = new Map<string, ExecutionVariable>();

  // Decrypt sensitive variable values for execution (todo 167/168): rows
  // store sensitive values encrypted at rest; runs need the plaintext.
  // Overrides carry plaintext already (no encrypted column).
  const decryptIfNeeded = async (variable: { readonly value: string; readonly valueEncrypted?: string | null }): Promise<string> =>
    "valueEncrypted" in variable && variable.valueEncrypted !== null && variable.valueEncrypted !== undefined && variable.valueEncrypted !== ""
      ? decryptSecret(variable.valueEncrypted)
      : variable.value;

  // 1. Non-priority variable set variables first
  for (const variable of orderedSetVars) {
    if (!prioritySetIds.has(variable.variableSetId)) {
        effective.set(`${variable.category}:${variable.key}`, { ...variable, value: await decryptIfNeeded(variable), hcl: variable.hcl === true, priority: false, sensitive: variable.sensitive === true });
    }
  }

  // 2. Workspace variables override non-priority sets
  for (const variable of workspaceVars) {
    effective.set(`${variable.category}:${variable.key}`, { ...variable, value: await decryptIfNeeded(variable), hcl: variable.hcl === true, priority: false, sensitive: variable.sensitive === true });
  }

  // 3. Priority variable set variables override everything
  for (const variable of orderedSetVars) {
    if (prioritySetIds.has(variable.variableSetId)) {
      effective.set(`${variable.category}:${variable.key}`, { ...variable, value: await decryptIfNeeded(variable), hcl: variable.hcl === true, priority: true, sensitive: variable.sensitive === true });
    }
  }

  return [...effective.values()];
}

type ArchiveExtractionContext = Readonly<{
  runId?: string;
  phase?: string;
}>;

async function extractTarArchive(
  archivePath: string,
  destDir: string,
  workingDirectory?: string | null,
  context?: ArchiveExtractionContext,
): Promise<boolean> {
  const diagnosticContext = {
    ...context,
    archivePath,
    destinationDirectory: destDir,
    workingDirectory: workingDirectory ?? null,
  };
  try {
    await assertArchiveExpandedSize(archivePath);
    const verboseProc = spawn(["tar", "-tvzf", archivePath]);
    const verboseText = await new Response(verboseProc.stdout).text();
    const verboseExitCode = await verboseProc.exited;
    if (verboseExitCode !== 0) {
      log.error("Configuration archive member inspection failed", {
        ...diagnosticContext,
        exitCode: verboseExitCode,
      });
      return false;
    }

    const verboseLines = verboseText.split("\n").map((s: string): string => s.trim()).filter((s: string): boolean => s !== "");
    assertArchiveMemberCount(verboseLines);
    for (const line of verboseLines) {
      if (tarMemberIsForbiddenSpecial(line.charAt(0))) {
        log.error("Security error: archive contains forbidden link/special member", {
          ...diagnosticContext,
          member: line,
        });
        return false;
      }
      if (line.includes(" -> ") || line.includes(" link to ")) {
        log.error("Security error: archive contains link member", {
          ...diagnosticContext,
          member: line,
        });
        return false;
      }
    }

    const listProc = spawn(["tar", "-tzf", archivePath]);
    const membersText = await new Response(listProc.stdout).text();
    const exitCode = await listProc.exited;
    if (exitCode !== 0) {
      log.error("Configuration archive path inspection failed", {
        ...diagnosticContext,
        exitCode,
      });
      return false;
    }

    const members = membersText.split("\n").map((s: string): string => s.trim()).filter((s: string): boolean => s !== "");
    assertArchiveMemberCount(members);
    for (const m of members) {
      if (tarMemberPathUnsafe(m)) {
        log.error("Security error: archive contains dangerous path", {
          ...diagnosticContext,
          member: m,
          path: m,
        });
        return false;
      }
    }
    await assertArchiveLogicalSize(archivePath);

    // Uploaded archives can contain client-side execution artifacts (a stale
    // `tfplan` bookmark from `terraform plan -out=tfplan`, local state, or a
    // provider cache). Those must never shadow the server-managed files that
    // planning and apply reconstruct (saved plan, seeded state, backend
    // override, initialized providers).
    const executionArtifactExcludes = [
      "tfplan",
      "*/tfplan",
      "terraform.tfstate",
      "*/terraform.tfstate",
      "terraform.tfstate.backup",
      "*/terraform.tfstate.backup",
      ".terraform",
      "*/.terraform",
      ".terraform/*",
      "*/.terraform/*",
    ].flatMap((pattern): string[] => ["--exclude", pattern]);
    const extractProc = spawn(["tar", "-x", "-o", "-z", "-f", archivePath, "-C", destDir, ...executionArtifactExcludes]);
    const extractExitCode = await extractProc.exited;
    if (extractExitCode !== 0) {
      log.error("Configuration archive extraction process failed", {
        ...diagnosticContext,
        exitCode: extractExitCode,
      });
      return false;
    }
    await unnestArchiveDirectory(destDir, workingDirectory);
    return true;
  } catch (error: unknown) {
    log.error("Configuration archive extraction failed", {
      ...diagnosticContext,
      error,
    });
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
    const rootEntriesAreSafe = entries.every((e): boolean => e.isDirectory() || e.isFile());
    if (dirEntries.length === 1 && rootEntriesAreSafe && dirEntries[0] !== undefined) {
      const subDir = join(destDir, dirEntries[0].name);
      const subFiles = await readdir(subDir);
      const rootNames = new Set(entries.map((entry): string => entry.name));
      const conflictingFile = subFiles.find((file): boolean => rootNames.has(file));
      if (conflictingFile !== undefined) {
        throw new Error(`Cannot unnest archive directory: root entry '${conflictingFile}' already exists.`);
      }
      for (const file of subFiles) {
        await rename(join(subDir, file), join(destDir, file));
      }
      await rm(subDir, { recursive: true, force: true });
      log.info(`Un-nested archive directory '${dirEntries[0].name}' into working directory.`);
    }
  } catch (error: unknown) {
    log.warn("Could not unnest archive directory", { destDir, error });
    throw error;
  }
}

type RunTaskStage = "pre_plan" | "post_plan" | "pre_apply" | "post_apply";
type RunTaskExecution = Readonly<{
  task: Readonly<typeof runTasks.$inferSelect>;
  enforcementLevel: string;
  isGlobal: boolean;
}>;

function runTaskTransportError(taskUrl: string, stage: RunTaskStage, isGlobal: boolean): string | undefined {
  if ((stage !== "pre_apply" && !isGlobal) || envEnabled(process.env["TERRENCE_ALLOW_INSECURE_RUN_TASK_URLS"])) return undefined;
  try {
    return new URL(taskUrl).protocol === "https:"
      ? undefined
      : "Pre-apply run task URLs must use HTTPS";
  } catch {
    return undefined;
  }
}

async function executeRunTasks(
  runId: string,
  workspace: Readonly<{ id: string; name: string; orgId: string; workingDirectory: string | null }>,
  orgName: string,
  stage: RunTaskStage,
): Promise<boolean> {
  const [bindings, globalTasks] = await Promise.all([
    db.query.workspaceRunTasks.findMany({
      where: and(eq(workspaceRunTasks.workspaceId, workspace.id), eq(workspaceRunTasks.stage, stage)),
      orderBy: [asc(workspaceRunTasks.id)],
    }),
    db.query.runTasks.findMany({
      where: and(eq(runTasks.orgId, workspace.orgId), eq(runTasks.enabled, true)),
      orderBy: [asc(runTasks.id)],
    }),
  ]);
  const tasksById = new Map(globalTasks.map((task: Readonly<typeof runTasks.$inferSelect>): readonly [string, Readonly<typeof runTasks.$inferSelect>] => [task.id, task]));
  const executions = new Map<string, RunTaskExecution>();
  for (const binding of bindings) {
    const task = tasksById.get(binding.runTaskId);
    if (task !== undefined) executions.set(task.id, { task, enforcementLevel: binding.enforcementLevel, isGlobal: false });
  }
  for (const task of globalTasks) {
    const globalConfiguration = task.globalConfiguration;
    if (globalConfiguration?.enabled !== true || !Array.isArray(globalConfiguration.stages) || !globalConfiguration.stages.includes(stage)) continue;
    if (executions.has(task.id)) continue;
    const enforcementLevel = ["mandatory", "must_pass"].includes(globalConfiguration.enforcementLevel)
      ? globalConfiguration.enforcementLevel
      : "advisory";
    executions.set(task.id, { task, enforcementLevel, isGlobal: true });
  }
  if (executions.size === 0) return true;

  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  const taskAccessToken = (await runTokenStateFor(runId, workspace)).token;
  let proceed = true;
  const configuredTimeout = Number(process.env["RUN_TASK_TIMEOUT_MS"] ?? 3_600_000);
  const timeoutMs = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 3_600_000;

  // Batch-insert all pending run-task results in one statement instead of
  // issuing one INSERT per binding inside the loop below.
  const entryList: Readonly<{
    enforcementLevel: string;
    isGlobal: boolean;
    task: Readonly<typeof runTasks.$inferSelect>;
    resultId: string;
  }>[] = [...executions.values()].map(({ task, enforcementLevel, isGlobal }): Readonly<{
    enforcementLevel: string;
    isGlobal: boolean;
    task: Readonly<typeof runTasks.$inferSelect>;
    resultId: string;
  }> => ({ enforcementLevel, isGlobal, task, resultId: `taskrs-${crypto.randomUUID()}` }));
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

  for (const [index, entry] of entryList.entries()) {
    const { enforcementLevel, isGlobal, task, resultId } = entry;
    // Issue #584: a cancel during a run-task wait must stop the wait instead
    // of holding the workspace lock/concurrency slot until the 1h timeout.
    // Mark this and all not-yet-run results canceled and bail; the caller
    // treats a false return as blocking, and the phase catch turns it into a
    // clean "Run canceled." log line for an already-canceled run.
    if (await runWasCanceled(runId)) {
      await db.update(runTaskResults).set({ status: "canceled", message: "Run task canceled with its run." }).where(
        inArray(runTaskResults.id, entryList.slice(index).map((remaining): string => remaining.resultId)),
      );
      return false;
    }
    const port = process.env["PORT"] ?? "3000";
    const callbackBase = process.env["PUBLIC_URL"] ?? `http://localhost:${port}`;
    const callbackPath = `/api/v2/task-results/${resultId}/callback`;
    const callbackUrl = signedApiURL(
      { url: callbackBase },
      callbackPath,
      "PATCH",
      Math.ceil(timeoutMs / 1000) + 60,
    );
    const planJsonApiUrl = apiURL({ url: callbackBase }, `/api/v2/plans/plan-${runId}/json-output`);
    const payload = JSON.stringify({
      payload_version: 1,
      stage,
      capabilities: { outcomes: false },
      configuration_version_id: run?.configurationVersionId ?? null,
      is_speculative: run?.planOnly === true,
      organization_name: orgName,
      access_token: taskAccessToken,
      plan_json_api_url: planJsonApiUrl,
      run_created_at: new Date(run?.createdAt ?? Date.now()).toISOString(),
      run_id: runId,
      run_message: run?.message ?? "",
      task_result_callback_url: callbackUrl,
      task_result_enforcement_level: enforcementLevel,
      task_result_id: resultId,
      workspace_id: workspace.id,
      workspace_name: workspace.name,
      workspace_working_directory: workspace.workingDirectory ?? "",
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (typeof task.hmacKey === "string" && task.hmacKey !== "") {
      const hmacKey = await decryptSecret(task.hmacKey);
      headers["X-Tfc-Task-Signature"] = createHmac("sha512", hmacKey).update(payload).digest("hex");
    }

    let status = "running";
    let message: string | null = null;
    let resultUrl: string | null = null;
    const transportError = runTaskTransportError(task.url, stage, isGlobal);
    const destination = transportError === undefined
      ? await resolveExternalUrl(task.url, envEnabled(process.env["TERRENCE_ALLOW_PRIVATE_URLS"]))
      : { error: transportError };
    if ("error" in destination) {
      status = "failed";
      message = destination.error;
    } else {
      const resolvedTransportError = runTaskTransportError(destination.target.url, stage, isGlobal);
      if (resolvedTransportError !== undefined) {
        status = "failed";
        message = resolvedTransportError;
      } else try {
        const response = await fetchResolvedExternalUrl(destination.target, {
        method: "POST",
        headers,
        body: payload,
        timeoutMs: 10_000,
        });
        const responseText = await response.text();
        status = response.ok ? "running" : "failed";
        message = response.ok ? null : `Run task returned HTTP ${response.status}`;
        if (responseText !== "") {
          try {
            const parsed = JSON.parse(responseText) as Record<string, unknown>;
            const rawData = parsed["data"];
            const data = rawData !== null && typeof rawData === "object"
              ? rawData as Record<string, unknown>
              : parsed;
            const rawAttributes = data["attributes"];
            const attributes = rawAttributes !== null && typeof rawAttributes === "object"
              ? rawAttributes as Record<string, unknown>
              : data;
            if (["running", "passed", "failed"].includes(String(attributes["status"]))) status = String(attributes["status"]);
            if (typeof attributes["message"] === "string") message = attributes["message"];
            if (typeof attributes["url"] === "string") resultUrl = attributes["url"];
          } catch (error: unknown) {
            logBestEffortFailure(
              "Run task returned an invalid JSON response; using its HTTP status",
              { runId, resultId, taskId: task.id },
              error,
            );
          }
        }
      } catch (error: unknown) {
        status = "failed";
        message = error instanceof Error ? error.message : String(error);
      }
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
      const latest = await waitForTaskSettlement(resultId, timeoutMs, runId);
      if (latest === "canceled") {
        status = "canceled";
        message = "Run task canceled with its run.";
        await db.update(runTaskResults).set({ status, message }).where(eq(runTaskResults.id, resultId));
      } else if (latest !== undefined && ["passed", "failed"].includes(latest.status)) {
        status = latest.status;
        message = latest.message;
        resultUrl = latest.url;
      } else {
        status = "failed";
        message = `Run task callback timed out after ${String(timeoutMs)}ms`;
        await db.update(runTaskResults).set({ status, message }).where(eq(runTaskResults.id, resultId));
      }
    }
    const taskLogPhase = stage === "pre_apply" || stage === "post_apply" ? "apply" : "plan";
    await writeLog(runId, taskLogPhase, `[terrence] ${stage} run task "${task.name}" ${status}.`);
    if (status === "canceled") return false;
    if (status === "failed" && (enforcementLevel === "mandatory" || enforcementLevel === "must_pass")) {
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
  runId: string,
): Promise<Readonly<{ status: string; message: string | null; url: string | null }> | undefined | "canceled"> {
  const deadline = Date.now() + timeoutMs;
  // Exponential backoff: start at the poll base and double up to a cap so a
  // long-running task stops hammering the DB with a query every 100ms.
  let waitMs = RUN_TASK_POLL_INTERVAL_MS;
  const MAX_RUN_TASK_POLL_MS = 5_000;
  while (Date.now() < deadline) {
    const latest = await db.query.runTaskResults.findFirst({ where: eq(runTaskResults.id, resultId) });
    if (latest !== undefined && ["passed", "failed"].includes(latest.status)) return latest;
    // Issue #584: stop holding the workspace lock/concurrency slot while the
    // run is already canceled; the caller records the canceled result.
    if (await runWasCanceled(runId)) return "canceled";
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

/** Tracked wrapper: shutdown drain waits for in-flight run executions. */
export async function executeRun(runId: string): Promise<void> {
  prepareRunCgroup(runId);
  return trackLocalRunExecution(runId, () => trackLocalExecution(
    executeRunImpl(runId)
      .catch(async (error: unknown): Promise<void> => {
        if (!(await runWasCanceled(runId))) {
          try {
            const current = await db.query.runs.findFirst({ where: eq(runs.id, runId), columns: { statusTimestamps: true } });
            await db.update(runs).set({
              status: "errored",
              statusTimestamps: { ...(current?.statusTimestamps ?? {}), "errored-at": new Date().toISOString() },
            }).where(and(
              eq(runs.id, runId),
              notInArray(runs.status, [
                "canceled", "force_canceled", "applied", "errored", "discarded",
                "planned", "planned_and_saved", "planned_and_finished", "policy_soft_failed",
              ]),
            ));
          } catch (statusError: unknown) {
            log.error("Failed to fence a run after an execution error", { runId, error: statusError });
          }
        }
        throw error;
      })
      .finally((): void => {
        // Cgroup teardown retries are cheap: rmdir only succeeds on empty groups.
        cleanupRunCgroup(runId);
      }),
  ));
}

async function executeRunImpl(runId: string): Promise<void> {
  assertRunSandboxAvailable();
  const run = await db.query.runs.findFirst({
    where: eq(runs.id, runId),
  });

  if (run === undefined) return;
  if (run.status === "canceled" || run.status === "force_canceled") return;

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, run.workspaceId),
  });

  if (workspace === undefined) return;

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, workspace.orgId),
  });

  // Re-check executor policy at plan/apply entry (36-39): handles
  // admin enabling requireHardIsolation between claim and execution.
  if (workspace.executionMode !== "agent") {
    const pForExec = workspace.projectId
      ? await db.query.projects.findFirst({ where: eq(projects.id, workspace.projectId) })
      : undefined;
    const policyError = executorPolicyAllowsLocal(
      workspace,
      pForExec !== undefined ? { allowedExecutionModes: (pForExec as unknown as { allowedExecutionModes?: string | null } | undefined)?.allowedExecutionModes ?? null } : null,
      org !== undefined ? { requireHardIsolation: (org as unknown as { requireHardIsolation?: boolean | null } | undefined)?.requireHardIsolation ?? null } : null,
    );
    if (policyError !== null) {
      const policyRejected = await db.update(runs).set({ status: "errored", statusTimestamps: { ...(run.statusTimestamps ?? {}), "errored-at": new Date().toISOString() } }).where(and(
        eq(runs.id, runId),
        eq(runs.status, run.status),
      )).returning({ id: runs.id });
      if (policyRejected.length === 0) return;
      await writeLog(runId, "plan", `[terrence ERROR] ${policyError}`);
      publish("run.status", { "run-id": runId, "workspace-id": workspace.id, "org-id": workspace.orgId, status: "errored", at: new Date().toISOString() });
      queueRunNotification(runId, "run:errored", "errored");
      void reportRunVcsStatus(runId, "errored");
      return;
    }
  }

  const workDir = runWorkDir(runId);
  let durablePlan: SavedPlanMetadata | undefined;
  let plannedAgainstState: { id: string | null; serial: number } = { id: null, serial: 0 };

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
        const ok = await extractTarArchive(
          cv.archivePath,
          workDir,
          workspace.workingDirectory,
          { runId, phase: "plan" },
        );
        if (!ok) {
          await writeRunDiagnostic(
            runId,
            "plan",
            "error",
            "run.plan.archive_restore_failed",
            "The configuration archive could not be restored for planning.",
            {
              failureReason: "configuration_archive_restore_failed",
              archivePath: cv.archivePath,
              executionDirectory: workDir,
            },
          );
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
    if (await returnIfRunCanceled(runId)) return;
    await updateRunStatus(runId, "pre_plan_running");
    if (!(await executeRunTasks(runId, workspace, org?.name ?? workspace.orgId, "pre_plan"))) {
      throw new Error("Run blocked by mandatory pre-plan task failure.");
    }
    await updateRunStatus(runId, "pre_plan_completed");
    if (run.operation === "action_only") {
      await writeLog(runId, "plan", "[terrence] Action-only run will refresh state and invoke the requested Terraform action.");
    }
    await updateRunStatus(runId, "queuing");
    await updateRunStatus(runId, "plan_queued");
    await updateRunStatus(runId, "planning");
    if (await returnIfRunCanceled(runId)) return;

    const executionDir = workspaceExecutionDirectory(workDir, workspace.workingDirectory);
    try {
      await readdir(executionDir);
    } catch {
      throw new Error(`Working directory '${workspace.workingDirectory ?? ""}' does not exist in the configuration.`);
    }
    await writeLog(runId, "plan", `[terrence] Executing from ${executionDir}`);
    await writeLocalBackendOverride(executionDir);

    const latestState = await db.query.stateVersions.findFirst({
      where: and(
        eq(stateVersions.workspaceId, workspace.id),
        eq(stateVersions.status, "finalized"),
        eq(stateVersions.intermediate, false),
      ),
      orderBy: [desc(stateVersions.serial)],
    });
    plannedAgainstState = { id: latestState?.id ?? null, serial: latestState?.serial ?? 0 };
    if (latestState !== undefined && typeof latestState.statePayload === "string" && latestState.statePayload !== "") {
      await writeFile(join(executionDir, "terraform.tfstate"), decodeStatePayload(latestState.statePayload), { mode: 0o600 });
      await writeLog(runId, "plan", `[terrence] Seeded workspace state serial #${latestState.serial}.`);
    }

    const vars = await executionVariables(
      workspace.id,
      workspace.orgId,
      workspace.projectId,
    );

    const runVars = normalizeRunVariables(run.variables);
    const envVars = buildRunPhaseEnv(vars, run.variables, await runTerraformEnv(run.id, workspace, "plan", vars));
    if (run.debuggingMode) envVars["TF_LOG"] = "TRACE";
    const tfVarsLines = vars
      .filter((variable: { readonly category: string }): boolean => variable.category === "terraform")
      .map((variable: { readonly key: string; readonly hcl: boolean; readonly value: string }): string => `${variable.key} = ${variable.hcl ? variable.value : JSON.stringify(variable.value)}`);

    if (tfVarsLines.length > 0) {
      await writeFile(join(executionDir, "terrence.workspace.tfvars"), tfVarsLines.join("\n"), { mode: 0o600 });
      await writeLog(runId, "plan", `[terrence] Injected ${tfVarsLines.length} workspace Terraform variables.`);
    }
    // Non-sensitive terraform run variables ride a separate var-file passed
    // after the workspace one so they win (issue #577). JSON quoting keeps
    // values with spaces intact, and undeclared keys are ignored instead of
    // aborting the plan the way raw -var flags do.
    const runTfVarsLines = runVars
      .filter((variable): boolean => variable.category === "terraform" && !variable.sensitive)
      .map((variable): string => `${variable.key} = ${JSON.stringify(variable.value)}`);
    if (runTfVarsLines.length > 0) {
      await writeFile(join(executionDir, "terrence.run.tfvars"), runTfVarsLines.join("\n"), { mode: 0o600 });
      await writeLog(runId, "plan", `[terrence] Injected ${runTfVarsLines.length} run Terraform variables.`);
    }

    const requestedTool = workspace.iacBinary ?? org?.defaultIacBinary ?? "terraform";
    const requestedVersion = run.terraformVersion ?? workspace.terraformVersion ?? org?.defaultTerraformVersion ?? "latest";

    const currentDirFiles = await readdir(executionDir);
    const hasTfFiles = currentDirFiles.some((f: string): boolean => f.endsWith(".tf") || f.endsWith(".tf.json"));

    const isSimulatedAllowed = envEnabled(process.env["SIMULATED_RUNS"]) || Reflect.get(process.env, "NODE_ENV") === "test";
    if (!isSimulatedAllowed) {
      await writeLog(runId, "plan", `[terrence] Resolving binary for ${requestedTool} (version: ${requestedVersion})...`);
    }
    const resolved = isSimulatedAllowed ? null : await ensureBinary(requestedTool, requestedVersion);

    const planTimeoutMs = await executionTimeoutMs("plan");
    if (resolved !== null && hasTfFiles) {
      await db.update(runs).set({ terraformVersion: resolved.version }).where(eq(runs.id, runId));
      const binary = resolved.binaryPath;
      await writeLog(runId, "plan", `[terrence] Using ${resolved.tool} v${resolved.version} at ${binary}`);
      if (runSandbox !== null) await runSandbox.ensureTool(resolved.tool, resolved.version, binary);

      // 1. Run init
      if (await returnIfRunCanceled(runId)) return;
      await writeLog(runId, "plan", `\n--- Executing ${resolved.tool} init ---`);
      if (runSandbox !== null) await runSandbox.prepareWorkDir(runId);
      const initProc = spawnRunProcess(
        runId,
        [binary, "init", "-reconfigure", "-no-color", "-input=false"],
        {
          cwd: executionDir,
          env: envVars,
          stdout: "pipe",
          stderr: "pipe",
        },
        runSandbox,
      );

      const initOutput = Promise.all([
        streamLog(runId, "plan", initProc.stdout),
        streamLog(runId, "plan", initProc.stderr),
      ]);
      const [initExit] = await waitForTrackedProcess(runId, "plan", initProc, initOutput, planTimeoutMs);

      if (await returnIfRunCanceled(runId)) return;
      if (initExit !== 0) {
        throw new Error(`${resolved.tool} init failed with exit code ${initExit}`);
      }

      // 2. Run plan
      if (await returnIfRunCanceled(runId)) return;
      await writeLog(runId, "plan", `\n--- Executing ${resolved.tool} plan ---`);
      const planArgs = [binary, "plan", "-no-color", "-input=false"];
      if (!run.refresh) planArgs.push("-refresh=false");
      if (run.refreshOnly || run.operation === "action_only") planArgs.push("-refresh-only");
      if (run.isDestroy === true) planArgs.push("-destroy");
      for (const action of run.invokeActionAddrs ?? []) planArgs.push(`-invoke=${action}`);
      for (const target of run.targetAddrs ?? []) planArgs.push(`-target=${target}`);
      for (const replacement of run.replaceAddrs ?? []) planArgs.push(`-replace=${replacement}`);
      if (tfVarsLines.length > 0) planArgs.push("-var-file=terrence.workspace.tfvars");
      if (runTfVarsLines.length > 0) planArgs.push("-var-file=terrence.run.tfvars");
      for (const variable of vars) {
        if (variable.category === "terraform" && variable.priority) {
          if (variable.sensitive) continue;
          planArgs.push(`-var=${variable.key}=${variable.hcl ? variable.value : JSON.stringify(variable.value)}`);
        }
      }
      planArgs.push("-out=tfplan");

      const planProc = spawnRunProcess(
        runId,
        planArgs,
        {
          cwd: executionDir,
          env: envVars,
          stdout: "pipe",
          stderr: "pipe",
        },
        runSandbox,
      );

      const planOutput = Promise.all([
        streamLog(runId, "plan", planProc.stdout),
        streamLog(runId, "plan", planProc.stderr),
      ]);
      const [planExit] = await waitForTrackedProcess(runId, "plan", planProc, planOutput, planTimeoutMs);

      if (await returnIfRunCanceled(runId)) return;
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

    const planCapture = isSimulatedAllowed
      ? undefined
      : await readPlanJson(runId, executionDir, resolved?.binaryPath, planTimeoutMs, workDir);
    const planJson = isSimulatedAllowed
      ? parseJsonObject(process.env["SIMULATED_PLAN_JSON"] ?? "{}")
      : planCapture?.planJson;
    if (planJson !== undefined) {
      if (planCapture === undefined) await writePlanJsonArtifact(runId, planJson);
      else {
        // readPlanJson only returns after the child and both output streams are
        // complete; the raw file is in the private run workdir. Copy those
        // exact bytes instead of reserializing the large parsed plan in memory.
        await writePlanJsonArtifactFromFile(runId, planCapture.rawPath);
      }
      // The structured plan is persisted: tell SSE clients to fetch it once
      // instead of polling /json-output while the run is still planning.
      publish("plan.output.ready", {
        "run-id": runId,
        "workspace-id": workspace.id,
        "org-id": workspace.orgId,
        "plan-id": `plan-${runId}`,
      });
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
      orderBy: [asc(logs.createdAt), asc(logs.id)],
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
    await recordPlanInput(runId, plannedAgainstState, undefined);
    const persistPlanForLater = async (): Promise<void> => {
      if (durablePlan !== undefined) return;
      durablePlan = await persistSavedPlan(
        runId,
        executionDir,
        plannedAgainstState,
        run.configurationVersionId,
        isSimulatedAllowed,
      );
      await recordPlanInput(runId, plannedAgainstState, durablePlan);
    };
    if (await returnIfRunCanceled(runId)) return;
    await writeLog(runId, "plan", `[terrence] Plan completed successfully.`);

    await updateRunStatus(runId, "cost_estimating");
    await executeCostEstimate(runId, executionDir);
    if (await returnIfRunCanceled(runId)) return;
    await updateRunStatus(runId, "cost_estimated");

    await updateRunStatus(runId, "policy_checking");
    if (await returnIfRunCanceled(runId)) return;
    const policyResult = await runPolicyChecks(
      runId,
      workspace.id,
      workspace.orgId,
      executionDir,
      resolved?.binaryPath,
      planJson,
    );
    if (!policyResult.proceed) {
      // Persist before the terminal policy markers so metadata such as the
      // plan hash cannot appear to be a later execution phase.
      await persistPlanForLater();
      if (policyResult.hardFailed) {
        await updateRunStatus(runId, "errored");
        await writeLog(runId, "plan", `[terrence] Run blocked by hard-mandatory policy failure.`);
      } else if (policyResult.softFailed) {
        await updateRunStatus(runId, "policy_override");
        await updateRunStatus(runId, "policy_soft_failed");
        await writeLog(runId, "plan", `[terrence] Run requires policy override before apply.`);
      }
    } else {
      await updateRunStatus(runId, "policy_checked");
      if (await returnIfRunCanceled(runId)) return;
      await updateRunStatus(runId, "post_plan_running");
      if (!(await executeRunTasks(runId, workspace, org?.name ?? workspace.orgId, "post_plan"))) {
        throw new Error("Run blocked by mandatory post-plan task failure.");
      }
      await updateRunStatus(runId, "post_plan_completed");
      if (await returnIfRunCanceled(runId)) return;

      const hasNoResourceChanges = resourceCounts.additions === 0
        && resourceCounts.changes === 0
        && resourceCounts.destructions === 0;

      // Check if the plan has drift that needs to be applied to state
      const hasDrift = planJson !== undefined
        && Array.isArray((planJson as Record<string, unknown>)["resource_drift"])
        && ((planJson as Record<string, unknown>)["resource_drift"] as unknown[]).length > 0;

      if (run.operation === "action_only") {
        // Action-only runs still need the run-cancellation check and the
        // site-wide apply gates. Without them, a maintenance window or an
        // approval workflow would be bypassed whenever the caller created
        // the run through a path that requires apply permission (enforced
        // at create time, but the gate is defense-in-depth here too).
        if (await returnIfRunCanceled(runId)) return;
        const actionOnlyBlockReason = await import("./lib/operations").then(async (mod): Promise<string | null> =>
          mod.applyGateBlockReason(new Date()),
        );
        if (actionOnlyBlockReason !== null) {
          await writeLog(runId, "plan", `[terrence] Action-only apply blocked: ${actionOnlyBlockReason}`);
          await updateRunStatus(runId, "planned");
          queueRunNotification(runId, "run:needs_attention", "planned");
          await persistPlanForLater();
        } else {
          await executeApply(runId);
        }
      } else if (run.savePlan) {
        await persistPlanForLater();
        await updateRunStatus(runId, "planned_and_saved");
      } else if (run.planOnly) {
        await updateRunStatus(runId, "planned_and_finished");
      } else if (run.autoApply === true) {
        if (await returnIfRunCanceled(runId)) return;
        // Auto-apply must not bypass the site-wide apply gates: when an
        // approval workflow or a maintenance window blocks applies, fall
        // back to the needs-attention state instead of applying.
        const autoApplyBlockReason = await import("./lib/operations").then(async (mod): Promise<string | null> =>
          mod.applyGateBlockReason(new Date()),
        );
        if (autoApplyBlockReason !== null) {
          await writeLog(runId, "plan", `[terrence] Auto-apply blocked: ${autoApplyBlockReason}`);
          await updateRunStatus(runId, "planned");
          queueRunNotification(runId, "run:needs_attention", "planned");
          await persistPlanForLater();
        } else {
          await writeLog(
            runId,
            "plan",
            hasNoResourceChanges && !hasDrift
              ? `[terrence] Plan has no resource changes and no drift. Automatically applying to update workspace state.`
              : `[terrence] Cost estimate, policies, and run tasks passed. Proceeding to apply.`,
          );
          await executeApply(runId);
        }
      } else if (hasNoResourceChanges && !hasDrift && !run.allowEmptyApply) {
        await writeLog(runId, "plan", `[terrence] Plan has no resource changes or drift. Run finished.`);
        await updateRunStatus(runId, "planned_and_finished");
      } else {
        await updateRunStatus(runId, "planned");
        queueRunNotification(runId, "run:needs_attention", "planned");
        await persistPlanForLater();
      }
    }
  } catch (error: unknown) {
    // Issue #615: a cancel that wins the race against a plan-phase write must
    // not surface internal state-machine errors in the user-visible log. The
    // apply path already guards this way; mirror it here.
    if (await runWasCanceled(runId)) {
      await writeLog(runId, "plan", "[terrence] Run canceled.");
      throw error;
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error(`Run ${runId} planning failed`, { error });
    await writeRunDiagnostic(
      runId,
      "plan",
      "error",
      "run.plan.failed",
      "Planning failed.",
      { failureReason: "plan_failed", error },
    );
    await writeLog(runId, "plan", `[terrence ERROR] ${errMsg}`);
    try {
      if (!isTerminalRunStatus(run.status)) await updateRunStatus(runId, "errored");
    } catch (statusError: unknown) {
      log.error(`Failed to mark run ${runId} errored after planning failure`, { error: statusError });
    } finally {
      await cleanupSavedPlan(runId);
    }
    throw error;
  } finally {
    try {
      // Saved plans live under storage/saved-plans; never retain the execution
      // directory, which contains tfvars, state, provider caches, and tokens.
      await cleanupRunWorkDir(runId);
    } catch (error: unknown) {
      logBestEffortFailure("Run workdir cleanup failed after planning", { runId }, error);
      scheduleRunWorkDirCleanup(runId);
    }
  }
}

/** Tracked wrapper: shutdown drain waits for in-flight apply executions. */
export async function executeApply(runId: string): Promise<void> {
  const ownsCgroup = getRunCgroup(runId) === null;
  if (ownsCgroup) prepareRunCgroup(runId);
  return trackLocalRunExecution(runId, () => trackLocalExecution(
    executeApplyImpl(runId).catch(async (error: unknown): Promise<void> => {
      if (!(await runWasCanceled(runId))) {
        try {
          const current = await db.query.runs.findFirst({ where: eq(runs.id, runId), columns: { statusTimestamps: true } });
          await db.update(runs).set({
            status: "errored",
            statusTimestamps: { ...(current?.statusTimestamps ?? {}), "errored-at": new Date().toISOString() },
          }).where(and(
            eq(runs.id, runId),
            notInArray(runs.status, ["canceled", "force_canceled", "applied", "errored", "discarded"]),
          ));
        } catch (statusError: unknown) {
          log.error("Failed to fence a run after an apply error", { runId, error: statusError });
        }
      }
      throw error;
    }).finally((): void => {
      if (ownsCgroup) cleanupRunCgroup(runId);
    }),
  ));
}

/** Claim the workspace lock for the apply itself, so a manual lock acquired
 * during planning cannot race the apply gate. The conditional update is the
 * lock acquisition: only an actually-unlocked workspace can be owned by a run.
 */
async function acquireRunWorkspaceLock(workspaceId: string, runId: string): Promise<boolean> {
  const locked = await db.update(workspaces).set({
    locked: true,
    lockedReason: `Run ${runId} is applying`,
    lockOwnerType: "run",
    lockOwnerId: runId,
  }).where(and(eq(workspaces.id, workspaceId), or(eq(workspaces.locked, false), isNull(workspaces.locked)))).returning({ id: workspaces.id });
  return locked.length > 0;
}

async function releaseRunWorkspaceLock(workspaceId: string, runId: string): Promise<void> {
  await db.update(workspaces).set({
    locked: false,
    lockedReason: null,
    lockOwnerType: null,
    lockOwnerId: null,
  }).where(and(
    eq(workspaces.id, workspaceId),
    eq(workspaces.locked, true),
    eq(workspaces.lockOwnerType, "run"),
    eq(workspaces.lockOwnerId, runId),
  ));
}

async function cleanupApplyArtifacts(runId: string): Promise<void> {
  try {
    await cleanupSavedPlan(runId);
  } catch (error: unknown) {
    logBestEffortFailure("Saved-plan cleanup failed after apply gate failure", { runId }, error);
  }
  try {
    if (runSandbox !== null) await removeSandboxWorkDir(runId);
    else await rm(runWorkDir(runId), { recursive: true, force: true });
  } catch (error: unknown) {
    logBestEffortFailure("Run workdir cleanup failed after apply gate failure", { runId }, error);
    scheduleRunWorkDirCleanup(runId);
  }
}

async function executeApplyImpl(runId: string): Promise<void> {
  assertRunSandboxAvailable();
  const run = await db.query.runs.findFirst({
    where: eq(runs.id, runId),
  });

  if (run === undefined) return;
  if (run.status === "canceled" || run.status === "force_canceled") return;

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

  // Re-check executor policy at apply entry too (admin may have tightened policy between plan and apply).
  if (workspace.executionMode !== "agent") {
    const pForApply = workspace.projectId
      ? await db.query.projects.findFirst({ where: eq(projects.id, workspace.projectId) })
      : undefined;
    const policyErr = executorPolicyAllowsLocal(
      workspace,
      pForApply !== undefined ? { allowedExecutionModes: (pForApply as unknown as { allowedExecutionModes?: string | null } | undefined)?.allowedExecutionModes ?? null } : null,
      org !== undefined ? { requireHardIsolation: (org as unknown as { requireHardIsolation?: boolean | null } | undefined)?.requireHardIsolation ?? null } : null,
    );
    if (policyErr !== null) {
      if (run.status !== "canceled" && run.status !== "force_canceled") {
        await updateRunStatus(runId, "errored");
        await writeRunDiagnostic(
          runId,
          "apply",
          "error",
          "run.apply.policy_blocked",
          "Apply was blocked by executor policy before execution started.",
          {
            failureReason: "executor_policy_blocked",
            policyError: policyErr,
            executionMode: workspace.executionMode,
          },
        );
        await writeLog(runId, "apply", `[terrence ERROR] ${policyErr}`);
        publish("run.status", { "run-id": runId, "workspace-id": workspace.id, "org-id": workspace.orgId, status: "errored", at: new Date().toISOString() });
        queueRunNotification(runId, "run:errored", "errored");
        void reportRunVcsStatus(runId, "errored");
      }
      return;
    }
  }

  if (!(await acquireRunWorkspaceLock(workspace.id, runId))) {
    const key = `workspace-lock:${runId}`;
    if (scheduledBlockReasons.get(key) !== "workspace-locked") {
      scheduledBlockReasons.set(key, "workspace-locked");
      await writeLog(runId, "apply", "[terrence] Apply deferred because the workspace is locked.");
    }
    await db.update(runs).set({
      status: "confirmed",
      scheduledAt: run.scheduledAt ?? Date.now() + 1000,
    }).where(and(
      eq(runs.id, runId),
      eq(runs.status, run.status),
      notInArray(runs.status, FINAL_RUN_STATUSES),
    ));
    return;
  }
  scheduledBlockReasons.delete(`workspace-lock:${runId}`);
  let workspaceRunLock = true;

  try {
    if (!["confirmed", "apply_queued", "applying"].includes(run.status)) await updateRunStatus(runId, "confirmed");
    if (await runWasCanceled(runId)) return;
    try {
      if (!(await executeRunTasks(runId, workspace, org?.name ?? workspace.orgId, "pre_apply"))) {
        // Issue #584: a cancel during the task wait must not be recorded as a
        // task failure (and must not attempt canceled -> errored, which the
        // state machine rejects). The run is already canceled; just stop.
        if (await runWasCanceled(runId)) return;
        await updateRunStatus(runId, "errored");
        await writeLog(runId, "apply", "[terrence] Run blocked by mandatory pre-apply task failure.");
        await cleanupApplyArtifacts(runId);
        return;
      }
    } catch (error: unknown) {
      await writeLog(runId, "apply", `[terrence] Pre-apply run tasks could not complete: ${error instanceof Error ? error.message : String(error)}`);
      await cleanupApplyArtifacts(runId);
      throw error;
    }
    await updateRunStatus(runId, "apply_queued");
    await updateRunStatus(runId, "applying");
    if (await runWasCanceled(runId)) return;
  const workDir = runWorkDir(runId);

  let applySuccess = false;
  let applyStarted = false;
  let applyCanceled = false;

  try {
    const executionDir = workspaceExecutionDirectory(workDir, workspace.workingDirectory);
    await writeLog(runId, "apply", `[terrence] Starting apply phase for run ${runId}`);

    let applyStatePayload: string | null = null;
    let savedPlan: SavedPlanMetadata | undefined;
    // Peek at the metadata only: the plan file itself is restored after the
    // configuration archive is extracted, because uploaded archives can
    // contain a stale client-side `tfplan` bookmark that must not shadow the
    // verified saved plan.
    let savedPlanRequired = run.savePlan === true;
    if (!savedPlanRequired) {
      try {
        savedPlanRequired = (await readSavedPlanMetadata(runId)) !== undefined;
      } catch {
        // Corrupt metadata: take the saved-plan path so restore surfaces the diagnostic below.
        savedPlanRequired = true;
      }
    }
    // The saved-plan file is restored after the archive block below, so an
    // uploaded stale `tfplan` bookmark can never shadow the verified plan.
    // Validation of the restored plan lives alongside the restore.

    const requestedTool = workspace.iacBinary ?? org?.defaultIacBinary ?? "terraform";
    const requestedVersion = run.terraformVersion ?? workspace.terraformVersion ?? org?.defaultTerraformVersion ?? "latest";

    let dirFiles = (await exists(executionDir)) ? await readdir(executionDir) : [];
    let hasTfFiles = dirFiles.some((f: string): boolean => f.endsWith(".tf") || f.endsWith(".tf.json"));
    let configurationArchivePath: string | null = null;
    let archiveRestored = false;
    if (savedPlanRequired && !hasTfFiles && run.configurationVersionId !== null) {
      // The plan-phase workdir is cleaned after planning, so the directory may
      // not exist yet (it used to be created implicitly by the early restore).
      // Extract into workDir (like the plan phase): archive members carry
      // working-directory-relative paths, so extracting into executionDir
      // would nest them one level too deep.
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      const configuration = await db.query.configurationVersions.findFirst({ where: eq(configurationVersions.id, run.configurationVersionId) });
      configurationArchivePath = typeof configuration?.archivePath === "string" && configuration.archivePath !== ""
        ? configuration.archivePath
        : null;
      if (configurationArchivePath !== null && await exists(configurationArchivePath)) {
        archiveRestored = await extractTarArchive(
          configurationArchivePath,
          workDir,
          workspace.workingDirectory,
          { runId, phase: "apply" },
        );
        if (!archiveRestored) {
          await writeRunDiagnostic(
            runId,
            "apply",
            "error",
            "run.apply.archive_restore_failed",
            "The configuration archive could not be restored for apply.",
            {
              failureReason: "configuration_archive_restore_failed",
              archivePath: configurationArchivePath,
              executionDirectory: executionDir,
            },
          );
          throw new Error("Saved plan configuration archive could not be restored.");
        }
        dirFiles = await readdir(executionDir);
        hasTfFiles = dirFiles.some((f: string): boolean => f.endsWith(".tf") || f.endsWith(".tf.json"));
      }
    }
    if (savedPlanRequired) {
      // Restore after extraction: the uploaded archive can contain a stale
      // client-side `tfplan` bookmark, and the verified bytes must be the
      // last write so `terraform apply tfplan` reads the real saved plan.
      try {
        savedPlan = await restoreSavedPlan(runId, executionDir);
      } catch (error: unknown) {
        const integrityFailure = error instanceof SavedPlanIntegrityError;
        await writeRunDiagnostic(
          runId,
          "apply",
          "error",
          integrityFailure ? "run.apply.saved_plan_integrity_failed" : "run.apply.saved_plan_restore_failed",
          integrityFailure
            ? "Saved plan integrity verification failed before apply."
            : "Saved plan could not be restored before apply.",
          {
            failureReason: integrityFailure ? "saved_plan_integrity_check_failed" : "saved_plan_restore_failed",
            error,
          },
        );
        throw error;
      }
      if (savedPlan === undefined) {
        await writeRunDiagnostic(
          runId,
          "apply",
          "error",
          "run.apply.saved_plan_missing",
          "Apply cannot verify the saved plan because its metadata or file is unavailable.",
          { failureReason: "saved_plan_metadata_or_file_missing" },
        );
        throw new Error("Saved plan metadata or file is missing; the plan cannot be verified before apply.");
      }
      if (savedPlan.configurationVersionId !== run.configurationVersionId) {
        await writeRunDiagnostic(
          runId,
          "apply",
          "error",
          "run.apply.saved_plan_mismatch",
          "Saved plan belongs to a different configuration version.",
          {
            failureReason: "saved_plan_configuration_mismatch",
            savedPlanConfigurationVersionId: savedPlan.configurationVersionId,
            runConfigurationVersionId: run.configurationVersionId,
          },
        );
        throw new Error("Saved plan configuration version no longer matches the run.");
      }
      const currentState = await db.query.stateVersions.findFirst({
        where: and(eq(stateVersions.workspaceId, workspace.id), eq(stateVersions.status, "finalized"), eq(stateVersions.intermediate, false)),
        orderBy: [desc(stateVersions.serial)],
        columns: { id: true, serial: true, statePayload: true },
      });
      applyStatePayload = currentState?.statePayload ?? null;
      if (savedPlan.stateSerial !== (currentState?.serial ?? 0) || savedPlan.stateId !== (currentState?.id ?? null)) {
        await writeRunDiagnostic(
          runId,
          "apply",
          "error",
          "run.apply.saved_plan_stale",
          "Saved plan is stale because workspace state changed after planning.",
          {
            failureReason: "saved_plan_state_mismatch",
            savedPlanStateId: savedPlan.stateId,
            savedPlanStateSerial: savedPlan.stateSerial,
            currentStateId: currentState?.id ?? null,
            currentStateSerial: currentState?.serial ?? 0,
          },
        );
        throw new Error("Saved plan is stale because the workspace state changed after planning.");
      }
    }

    if (savedPlanRequired && !(await exists(join(executionDir, "tfplan")) && await exists(executionDir))) {
      await writeRunDiagnostic(
        runId,
        "apply",
        "error",
        "run.apply.plan_file_missing",
        "The verified saved plan file is not present in the apply execution directory.",
        {
          failureReason: "saved_plan_file_missing_after_restore",
          executionDirectory: executionDir,
          executionDirectoryExists: await exists(executionDir),
        },
      );
      throw new Error("Saved plan file 'tfplan' is missing; cannot apply run.");
    }
    if (savedPlanRequired && applyStatePayload !== null && applyStatePayload !== "") {
      await writeFile(join(executionDir, "terraform.tfstate"), decodeStatePayload(applyStatePayload), { mode: 0o600 });
      await writeLog(runId, "apply", `[terrence] Seeded workspace state for saved plan apply.`);
    }
    if (savedPlanRequired) await writeLocalBackendOverride(executionDir);
    // Refresh the listing: the restore/seed/override writes above happened
    // after the archive-time snapshot, and preflight must describe the
    // directory `terraform apply` is about to see.
    dirFiles = (await exists(executionDir)) ? await readdir(executionDir) : [];
    hasTfFiles = dirFiles.some((f: string): boolean => f.endsWith(".tf") || f.endsWith(".tf.json"));
    const isSimulatedAllowed = envEnabled(process.env["SIMULATED_RUNS"]) || Reflect.get(process.env, "NODE_ENV") === "test";
    let resolved: Awaited<ReturnType<typeof ensureBinary>> | null = null;
    if (!isSimulatedAllowed) {
      try {
        resolved = await ensureBinary(requestedTool, requestedVersion);
      } catch (error: unknown) {
        await writeRunDiagnostic(
          runId,
          "apply",
          "error",
          "run.apply.binary_resolution_failed",
          "The execution engine threw while resolving its CLI binary.",
          {
            failureReason: "cli_binary_resolution_threw",
            requestedTool,
            requestedVersion,
            error,
          },
        );
        throw error;
      }
    }

    const executionDirectoryExists = await exists(executionDir);
    const configurationFiles = dirFiles.filter((file: string): boolean => file.endsWith(".tf") || file.endsWith(".tf.json"));
    await writeRunDiagnostic(
      runId,
      "apply",
      "info",
      "run.apply.preflight",
      "Apply preflight evaluated.",
      {
        requestedTool,
        requestedVersion,
        resolvedTool: resolved?.tool ?? null,
        resolvedVersion: resolved?.version ?? null,
        binaryPath: resolved?.binaryPath ?? null,
        binaryResolved: resolved !== null,
        simulated: isSimulatedAllowed,
        savedPlanRequired,
        savedPlanRestored: savedPlan !== undefined,
        savedPlanFilePresent: await exists(join(executionDir, "tfplan")),
        archivePath: configurationArchivePath,
        archiveRestored,
        executionDirectory: executionDir,
        executionDirectoryExists,
        rootEntryCount: dirFiles.length,
        rootEntryNames: dirFiles.slice(0, 64),
        configurationFileCount: configurationFiles.length,
        configurationFiles,
      },
    );

    if (resolved !== null && executionDirectoryExists && hasTfFiles) {
      if (await runWasCanceled(runId)) return;
      const binary = resolved.binaryPath;
      if (runSandbox !== null) await runSandbox.ensureTool(resolved.tool, resolved.version, binary);
      const vars = await executionVariables(workspace.id, workspace.orgId, workspace.projectId ?? null);
      // Run-scoped variables ride the apply environment exactly like the
      // plan environment (issue #577): provider credentials injected at
      // plan time must still be present at apply time.
      const envVars = buildRunPhaseEnv(vars, run.variables, await runTerraformEnv(run.id, workspace, "apply", vars));
      if (run.debuggingMode) envVars["TF_LOG"] = "TRACE";
      const applyTimeoutMs = await executionTimeoutMs("apply");

      if (savedPlanRequired && resolved !== null) {
        if (await runWasCanceled(runId)) return;
        await writeLog(runId, "apply", `\n--- Executing ${resolved.tool} init ---`);
        if (runSandbox !== null) await runSandbox.prepareWorkDir(runId);
        const initProc = spawnRunProcess(
          runId,
          [binary, "init", "-reconfigure", "-no-color", "-input=false"],
          {
            cwd: executionDir,
            env: envVars,
            stdout: "pipe",
            stderr: "pipe",
          },
          runSandbox,
        );
        const initOutput = Promise.all([
          streamLog(runId, "apply", initProc.stdout),
          streamLog(runId, "apply", initProc.stderr),
        ]);
        const [initExit] = await waitForTrackedProcess(runId, "apply", initProc, initOutput, applyTimeoutMs);
        if (await runWasCanceled(runId)) return;
        if (initExit !== 0) throw new Error(`${resolved.tool} init failed with exit code ${initExit}`);
      }

      await writeLog(runId, "apply", `\n--- Executing ${resolved.tool} apply ---`);
      if (runSandbox !== null) await runSandbox.prepareWorkDir(runId);
      const hasPlanFile = await exists(join(executionDir, "tfplan"));
      if (!hasPlanFile) {
        await writeRunDiagnostic(
          runId,
          "apply",
          "error",
          "run.apply.plan_file_missing",
          "Terraform configuration was restored, but the plan file is missing.",
          {
            failureReason: "tfplan_missing_before_process_start",
            executionDirectory: executionDir,
            rootEntryNames: dirFiles.slice(0, 64),
          },
        );
        throw new Error("Saved plan file 'tfplan' is missing; cannot apply run.");
      }
      if (await runWasCanceled(runId)) return;
      const applyArgs = [binary, "apply", "-no-color", "-input=false", "tfplan"];

      // Record the state file produced by the apply. terraform writes the
      // state on failure too (with the successfully applied resources), and
      // the reference format saves that partial state so a follow-up run does not try to
      // recreate resources that already exist.
      const stateFilePath = join(executionDir, "terraform.tfstate");
      const saveStateAfterApply = async (): Promise<void> => {
        if (await runWasCanceled(runId)) return;
        if (!(await exists(stateFilePath))) return;
        const statePayload = await readFile(stateFilePath, "utf-8");
        if (await runWasCanceled(runId)) return;

        // Derive the JSON state and outputs from the raw payload. The resources
        // list and outputs endpoints read jsonState/jsonStateOutputs, so a
        // state version without them renders as "no resources".
        let jsonState: string | null = statePayload;
        let jsonStateOutputs: string | null = null;
        try {
          const parsed = JSON.parse(statePayload) as Record<string, unknown>;
          jsonStateOutputs = parsed["outputs"] !== null && parsed["outputs"] !== undefined
            ? JSON.stringify(parsed["outputs"])
            : null;
        } catch (error: unknown) {
          jsonState = null;
          logBestEffortFailure("Apply state file is not valid JSON; storing raw state without JSON resources", { runId }, error);
        }

        // Pull VCS commit metadata from the run's configuration version so the state
        // version's `vcs-commit-sha` matches TFE's definition ("commit used by the run
        // that produced that state, if applicable" — null for CLI pushes).
        let vcsCommitSha: string | null = null;
        let vcsCommitUrl: string | null = null;
        if (run.configurationVersionId !== null) {
          const cfg = await db.query.configurationVersions.findFirst({
            where: eq(configurationVersions.id, run.configurationVersionId),
            columns: { ingressAttributes: true },
          });
          const ingress = cfg?.ingressAttributes as Record<string, unknown> | null | undefined;
          if (typeof ingress?.["commitSha"] === "string" && ingress["commitSha"] !== "") vcsCommitSha = ingress["commitSha"];
          if (typeof ingress?.["commitUrl"] === "string" && ingress["commitUrl"] !== "") vcsCommitUrl = ingress["commitUrl"];
        }
        const nextSerial = await insertStateVersionWithSerialRetry({
          id: crypto.randomUUID(),
          workspaceId: workspace.id,
          statePayload: await encryptStatePayload(statePayload),
          jsonState: await encryptStatePayload(jsonState),
          jsonStateOutputs: await encryptStatePayload(jsonStateOutputs),
          runId,
          createdBy: run.createdBy,
          vcsCommitSha,
          vcsCommitUrl,
          terraformVersion: resolved.version,
          status: "finalized",
          createdAt: Date.now(),
        });
        scheduleExplorerInventory(workspace.id);

        await writeLog(runId, "apply", `[terrence] Recorded state version serial #${nextSerial}`);
      };

      applyStarted = true;
      const applyProc = spawnRunProcess(
        runId,
        applyArgs,
        {
          cwd: executionDir,
          env: envVars,
          stdout: "pipe",
          stderr: "pipe",
        },
        runSandbox,
      );

      const applyOutput = Promise.all([
        streamLog(runId, "apply", applyProc.stdout),
        streamLog(runId, "apply", applyProc.stderr),
      ]);
      const [applyExit] = await waitForTrackedProcess(runId, "apply", applyProc, applyOutput, applyTimeoutMs);

      if (await runWasCanceled(runId)) {
        applyCanceled = true;
        const captured = await captureInterruptedApplyState(runId).catch((captureError: unknown): boolean => {
          log.error("Could not capture state after canceled apply", { runId, error: captureError });
          return false;
        });
        await writeLog(
          runId,
          "apply",
          captured
            ? "[terrence] Apply was canceled; encrypted recovery state was captured before cleanup. Fetch it from GET /api/v2/runs/:run_id/recovery-state before TERRENCE_RECOVERY_RETENTION_MS expires it (default 7 days)."
            : "[terrence] Apply was canceled; no local state file was available to capture.",
        );
        return;
      }
      if (applyExit !== 0) {
        // Failed applies still record partial state (anything that applied
        // successfully), so a follow-up run does not recreate existing
        // resources.
        try {
          await saveStateAfterApply();
        } catch (saveError: unknown) {
          await writeLog(runId, "apply", `[terrence] Could not record partial state after failed apply: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
          try {
            await captureInterruptedApplyState(runId);
          } catch (captureError: unknown) {
            log.error("Could not capture state after partial apply persistence failure", { runId, error: captureError });
          }
        }
        throw new Error(`${resolved.tool} apply failed with exit code ${applyExit}`);
      }

      try {
        await saveStateAfterApply();
      } catch (saveError: unknown) {
        try {
          await captureInterruptedApplyState(runId);
        } catch (captureError: unknown) {
          log.error("Could not capture state after apply state persistence failure", { runId, error: captureError });
        }
        throw saveError;
      }

    } else if (isSimulatedAllowed) {
      await writeLog(runId, "apply", `[terrence] Execution engine: Simulated apply completed successfully.`);
    } else {
      const failedChecks = [
        ...(resolved === null ? ["cli_binary_unresolved"] : []),
        ...(!executionDirectoryExists ? ["execution_directory_missing"] : []),
        ...(!hasTfFiles ? ["configuration_files_missing"] : []),
      ];
      await writeRunDiagnostic(
        runId,
        "apply",
        "error",
        "run.apply.preflight_failed",
        "Apply preflight failed before the Terraform process started.",
        {
          failureReason: "apply_preflight_failed",
          failedChecks,
          requestedTool,
          requestedVersion,
          executionDirectory: executionDir,
          executionDirectoryExists,
          rootEntryNames: dirFiles.slice(0, 64),
          configurationFiles,
        },
      );
      if (failedChecks.length === 1 && failedChecks[0] === "cli_binary_unresolved") {
        throw new Error(`Unable to resolve CLI binary '${requestedTool}' for apply phase.`);
      }
      if (failedChecks.length === 1 && failedChecks[0] === "configuration_files_missing") {
        throw new Error(`No Terraform configuration (.tf or .tf.json) files were found in workspace directory '${executionDir}'.`);
      }
      throw new Error(`Apply preflight failed: ${failedChecks.join(", ") || "unknown_failure"}.`);
    }

    // Parse resource counts from apply log output
    const applyLogs = await db.query.logs.findMany({
      where: and(eq(logs.runId, runId), eq(logs.phase, "apply")),
      orderBy: [asc(logs.createdAt), asc(logs.id)],
    });
    const applyResourceCounts = parseResourceCounts(applyLogs.map((log: Readonly<{ outputText: string }>): string => log.outputText).join("\n"));

    await updateRunStatus(runId, "applied", {
      applyResourceAdditions: applyResourceCounts.additions,
      applyResourceChanges: applyResourceCounts.changes,
      applyResourceDestructions: applyResourceCounts.destructions,
      applyResourceImports: applyResourceCounts.imports,
    });
    applySuccess = true;
    await writeLog(runId, "apply", `[terrence] Run status updated to 'applied'.`);
    try {
      if (!(await executeRunTasks(runId, workspace, org?.name ?? workspace.orgId, "post_apply")) && !(await runWasCanceled(runId))) {
        await writeLog(runId, "apply", "[terrence] Post-apply run task failure recorded; the apply remains completed.");
      }
    } catch (error: unknown) {
      await writeLog(runId, "apply", `[terrence] Post-apply run tasks could not complete: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await cleanupRunToken(runId);
    }
    if (savedPlanRequired) await cleanupSavedPlan(runId);
  } catch (error: unknown) {
    if (await runWasCanceled(runId)) {
      applyCanceled = true;
      if (applyStarted) {
        await captureInterruptedApplyState(runId).catch((captureError: unknown): void => {
          log.error("Could not capture state after canceled apply", { runId, error: captureError });
        });
      }
      return;
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("Run apply failed", { runId, error });
    await writeRunDiagnostic(
      runId,
      "apply",
      "error",
      "run.apply.failed",
      "Apply failed.",
      { failureReason: "apply_failed", error },
    );
    await writeLog(runId, "apply", `[terrence ERROR] ${errMsg}`);
    await updateRunStatus(runId, "errored");
    await cleanupSavedPlan(runId);
  } finally {
    if (applySuccess) {
      try {
        if (runSandbox !== null) {
          await removeSandboxWorkDir(runId);
        } else {
          await rm(workDir, { recursive: true, force: true });
        }
      } catch (error: unknown) {
        logBestEffortFailure("Run workdir cleanup failed after successful apply", { runId }, error);
        scheduleRunWorkDirCleanup(runId);
      }
    } else {
      if (applyStarted && !applyCanceled) {
        await writeLog(runId, "apply", `[terrence] Apply failed; partial state was journaled before cleaning the execution directory.`);
      }
      try {
        if (runSandbox !== null) await removeSandboxWorkDir(runId);
        else await rm(workDir, { recursive: true, force: true });
      } catch (error: unknown) {
        logBestEffortFailure("Run workdir cleanup failed after failed apply", { runId }, error);
        scheduleRunWorkDirCleanup(runId);
      }
    }
  }
} finally {
  if (workspaceRunLock) {
    workspaceRunLock = false;
    await releaseRunWorkspaceLock(workspace.id, runId).catch((error: unknown): void => {
      log.error("Failed to release run workspace lock", { runId, workspaceId: workspace.id, error });
    });
  }
}
}

/**
 * Policy engine resolution failure: the binary is not installed, not on
 * PATH, and no override points at it. Distinct from evaluation errors so
 * callers can report "engine unavailable" instead of "policy failed".
 */
class PolicyEngineMissingError extends Error {
  readonly engine: "opa" | "sentinel";
  constructor(engine: "opa" | "sentinel", message: string) {
    super(message);
    this.name = "PolicyEngineMissingError";
    this.engine = engine;
  }
}

/**
 * Resolve a policy engine binary without spawning (issue #596). Honors
 * OPA_BINARY_PATH / SENTINEL_BINARY_PATH overrides, otherwise PATH.
 * Neither engine ships in the image; operators install them (OPA is
 * Apache-2.0, Sentinel is proprietary BYOB). Exported for tests.
 *
 * PATH is scanned manually from process.env at call time (instead of
 * Bun.which) so runtime PATH mutations are honored: tests prepend a
 * fixture directory with a fake engine, and operators may extend PATH in
 * wrapper scripts after the server starts.
 *
 * Returned paths are absolute regular executable files (CodeRabbit P1-sweep
 * review): a relative override is resolved against the server working
 * directory because the engine is spawned with cwd set to the run workdir,
 * and a non-executable match is skipped so it reports unavailable instead
 * of failing at spawn.
 */
function* executableCandidates(command: string): Generator<string> {
  const pathEnv = process.env["PATH"] ?? "";
  for (const dir of pathEnv.split(":")) {
    if (dir === "") continue;
    yield resolve(dir, command);
  }
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export async function probePolicyEngine(kind: "opa" | "sentinel"): Promise<{ path: string } | { missing: string }> {
  const override = kind === "opa" ? process.env["OPA_BINARY_PATH"] : process.env["SENTINEL_BINARY_PATH"];
  const command = override !== undefined && override.trim() !== "" ? override.trim() : kind;
  const candidates = command.includes("/") ? [resolve(command)] : executableCandidates(command);
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return { path: candidate };
  }
  const install = kind === "opa"
    ? "Install OPA (https://www.openpolicyagent.org/docs/latest/#running-opa) and ensure the `opa` binary is on PATH, or set OPA_BINARY_PATH to its location."
    : "Install Sentinel and ensure the `sentinel` binary is on PATH, or set SENTINEL_BINARY_PATH to its location.";
  return { missing: `${kind === "opa" ? "OPA" : "Sentinel"} policy engine is not available. ${install}` };
}

async function requirePolicyEngine(kind: "opa" | "sentinel"): Promise<string> {
  const probed = await probePolicyEngine(kind);
  if ("missing" in probed) throw new PolicyEngineMissingError(kind, probed.missing);
  return probed.path;
}

/**
 * Evaluate policies attached to a workspace after a plan completes.
 * Returns an object indicating whether the run should proceed to apply.
 * Exported for tests; the worker is the only production caller.
 */
export type SentinelParamInput = Readonly<{
  key: string;
  hcl: boolean;
  sensitive: boolean;
  plaintext: string;
}>;

/**
 * Scrub sensitive parameter plaintexts from a persisted policy-engine output
 * blob (CodeRabbit P1-sweep review, CWE-312): Sentinel auto-generates an
 * execution trace on failure and future engine versions may echo evaluated
 * values, so the stored check result must not retain secret-bearing strings.
 * Substring matching is deliberate: an echoed secret embedded in a larger
 * message is still a leak. The tradeoff is cosmetic mangling of diagnostic
 * text on secret-bearing sets, which is acceptable for a stored audit blob.
 * Exported for tests.
 */
export function redactSecrets(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let scrubbed = value;
    for (const secret of secrets) {
      if (secret !== "") scrubbed = scrubbed.split(secret).join("[redacted]");
    }
    return scrubbed;
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, secrets));
  if (value !== null && typeof value === "object") {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) scrubbed[key] = redactSecrets(entry, secrets);
    return scrubbed;
  }
  return value;
}

/**
 * Split Sentinel parameters across delivery channels (CodeRabbit P1-sweep
 * review, CWE-200): sensitive values ride the 0600 config file's `param`
 * section, never process arguments (visible in /proc, logs, and audit for
 * the process lifetime). Non-sensitive values keep the `-param` argv form.
 * Exported for tests.
 *
 * Config-file values are native: plain strings pass through, while hcl
 * values attempt a JSON parse (numbers, booleans, quoted strings, JSON
 * objects) and fall back to the raw string for non-JSON HCL.
 */
export function splitSentinelParams(
  parameters: readonly SentinelParamInput[],
): { configParams: Record<string, { value: unknown }>; argvParams: string[] } {
  const configParams: Record<string, { value: unknown }> = {};
  const argvParams: string[] = [];
  for (const parameter of parameters) {
    if (parameter.sensitive) {
      let value: unknown = parameter.plaintext;
      if (parameter.hcl) {
        try {
          value = JSON.parse(parameter.plaintext) as unknown;
        } catch {
          value = parameter.plaintext;
        }
      }
      configParams[parameter.key] = { value };
    } else {
      argvParams.push(
        "-param",
        `${parameter.key}=${parameter.hcl ? parameter.plaintext : JSON.stringify(parameter.plaintext)}`,
      );
    }
  }
  return { configParams, argvParams };
}

export async function runPolicyChecks(
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

  const planTimeoutMs = await executionTimeoutMs("plan");
  const policyTimeoutMs = Math.min(planTimeoutMs, POLICY_EVALUATION_TIMEOUT_MS);
  const generatedPlanCapture = preloadedPlanJson !== undefined || executionDir === undefined || executionDir === ""
    ? undefined
    : await readPlanJson(runId, executionDir, planBinaryPath, planTimeoutMs, executionDir);
  const generatedPlanJson = preloadedPlanJson ?? generatedPlanCapture?.planJson;
  if (generatedPlanCapture !== undefined) await rm(generatedPlanCapture.rawPath, { force: true });
  const planJsonPayload = generatedPlanJson === undefined ? null : JSON.stringify(generatedPlanJson);

  let hardFailed = false;
  let softFailed = false;
  const checkBatch: (typeof policyChecks.$inferInsert)[] = [];

  // Fail closed (kanban t_282cf10b): policy evaluation must run against the
  // CURRENT plan. Falling back to the latest state version would silently
  // approve changes the policy never inspected. Without plan JSON every
  // policy check errors and the run is blocked from applying.
  if (planJsonPayload === null || planJsonPayload === "") {
    await writeLog(runId, "plan", "[terrence ERROR] Plan JSON is unavailable; refusing to evaluate policies against stored state.");
    for (const policy of allPolicies) {
      checkBatch.push({
        id: `pchk-${crypto.randomUUID()}`,
        runId,
        policyId: policy.id,
        policySetId: policy.policySetId,
        status: "errored",
        result: { error: "Plan JSON is unavailable; policy evaluation failed closed" },
        createdAt: Date.now(),
      });
      if (policy.enforcementLevel === "hard-mandatory") hardFailed = true;
      if (policy.enforcementLevel === "soft-mandatory") softFailed = true;
    }
    if (checkBatch.length > 0) await db.insert(policyChecks).values(checkBatch);
    return { proceed: !hardFailed && !softFailed, hardFailed, softFailed };
  }

  await writeLog(runId, "plan", `[terrence] Evaluating ${allPolicies.length} policies across ${allSetIds.length} policy sets...`);

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
        const policySandbox = policyEvaluationSandbox();
        // Try to evaluate with OPA
        // Unpredictable per-invocation directory: a guessable tmp path under
        // /tmp invites symlink attacks and cross-run tampering.
        const workDir = join(tmpdir(), "terrence", "opa", `${runId}-${crypto.randomUUID()}`);
        try {
          await mkdir(workDir, { recursive: true, mode: 0o700 });
          await mkdir(join(workDir, "tmp"), { recursive: true, mode: 0o700 });
        const policyPath = join(workDir, "policy.rego");
        const dataPath = join(workDir, "input.json");
        await writeFile(policyPath, policySource, { mode: 0o600 });
        await writeFile(dataPath, planJsonPayload, { mode: 0o600 });
        const opaQuery = typeof policy.source === "string" && typeof policy.query === "string" && policy.query !== ""
          ? policy.query
          : "data";
        // Validate OPA query to prevent argument injection — only allow safe query syntax
        const opaQuerySafe = /^[a-zA-Z0-9_.]+$/.test(opaQuery) ? opaQuery : "data";
        const opaProc = spawnRunProcess(
          runId,
          [await requirePolicyEngine("opa"), "eval", "--data", policyPath, "--input", dataPath, opaQuerySafe],
          {
            cwd: workDir,
            env: { PATH: process.env["PATH"] ?? "" },
            stdout: "pipe",
            stderr: "pipe",
          },
          policySandbox,
        );
        const opaOutput = captureProcessOutput(opaProc.stdout, opaProc.stderr, workDir, "opa");
        const [opaExit, capturedOutput] = await waitForTrackedProcess(runId, "policy", opaProc, opaOutput, policyTimeoutMs);
        if (opaExit === 0) {
          checkResult = parseJsonObject(await readCapturedJson(capturedOutput, "OPA output"));
          const resultList = checkResult["result"] as Record<string, unknown>[] | undefined;
          const exprList = resultList?.[0]?.["expressions"] as Record<string, unknown>[] | undefined;
          const valObj = exprList?.[0]?.["value"] as Record<string, unknown> | undefined;
          const violated = valObj?.["violations"];
          if (violated !== undefined && Array.isArray(violated) && violated.length > 0) {
            checkStatus = "failed";
          } else {
            checkStatus = "passed";
          }
        } else {
          checkStatus = "errored";
          checkResult = { error: "OPA evaluation failed" };
        }
        } finally {
          try {
            await rm(workDir, { recursive: true, force: true });
          } catch (error: unknown) {
            logBestEffortFailure("OPA policy workdir cleanup failed", { runId, policyId: policy.id }, error);
          }
        }
      } else if (isSentinel && typeof policySource === "string" && policySource !== "") {
        const workDir = join(tmpdir(), "terrence", "sentinel", `${runId}-${crypto.randomUUID()}`, policy.id);
        try {
          await mkdir(workDir, { recursive: true, mode: 0o700 });
          await mkdir(join(workDir, "tmp"), { recursive: true, mode: 0o700 });
        const policyPath = join(workDir, "policy.sentinel");
        const configPath = join(workDir, "sentinel.json");
        await writeFile(policyPath, policySource, { mode: 0o600 });
        // Keep the potentially large plan out of argv (/proc and ARG_MAX). A
        // JSON config preserves the plan as data without HCL interpolation.
        // Sensitive parameters ride the same 0600 config file (CWE-200):
        // decrypted values must never appear in process arguments.
        const paramInputs: SentinelParamInput[] = [];
        for (const parameter of (policy.policySetId !== null ? parametersBySet.get(policy.policySetId) ?? [] : [])) {
          // Sensitive parameters are stored encrypted (issue #577):
          // resolve the plaintext for the engine invocation.
          paramInputs.push({
            key: parameter.key,
            hcl: parameter.hcl === true,
            sensitive: parameter.sensitive === true,
            plaintext: await variableValueForRead(parameter),
          });
        }
        const { configParams, argvParams } = splitSentinelParams(paramInputs);
        await writeFile(configPath, JSON.stringify({
          global: { tfplan: { value: generatedPlanJson ?? {} } },
          ...(Object.keys(configParams).length > 0 ? { param: configParams } : {}),
        }), { mode: 0o600 });
        const args = [
          await requirePolicyEngine("sentinel"),
          "apply",
          "-json",
          "-timeout=30s",
          `-config=${configPath}`,
          ...argvParams,
        ];
        args.push(policyPath);

        const policySandbox = policyEvaluationSandbox();
        const sentinelProc = spawnRunProcess(
          runId,
          args,
          {
            cwd: workDir,
            env: { PATH: process.env["PATH"] ?? "" },
            stdout: "pipe",
            stderr: "pipe",
          },
          policySandbox,
        );
        const sentinelOutput = captureProcessOutput(sentinelProc.stdout, sentinelProc.stderr, workDir, "sentinel");
        const [sentinelExit, capturedOutput] = await waitForTrackedProcess(runId, "policy", sentinelProc, sentinelOutput, policyTimeoutMs);
        const sentinelStdout = await readCapturedJson(capturedOutput, "Sentinel output");
        const sentinelStderr = capturedOutput.stderr.truncated
          ? `${capturedOutput.stderr.preview}\n[terrence] Sentinel stderr truncated.`
          : capturedOutput.stderr.preview;
        let sentinel: Record<string, unknown>;
        try {
          const parsed = JSON.parse(sentinelStdout) as unknown;
          sentinel = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : { output: sentinelStdout };
        } catch {
          sentinel = { output: sentinelStdout };
        }
        if (sentinelStderr !== "") sentinel["stderr"] = sentinelStderr;
        // Scrub sensitive parameter plaintexts before persisting (CodeRabbit
        // P1-sweep review, CWE-312): failure traces may echo evaluated values.
        const sensitivePlaintexts = paramInputs
          .filter((param) => param.sensitive && param.plaintext !== "")
          .map((param) => param.plaintext);
        if (sensitivePlaintexts.length > 0) {
          sentinel = redactSecrets(sentinel, sensitivePlaintexts) as Record<string, unknown>;
        }
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
            "duration-ms": typeof sentinel["duration"] === "number" ? sentinel["duration"] : 0,
            sentinel,
          };
        } else {
          checkStatus = "errored";
          checkResult = { error: `Sentinel evaluation exited with code ${String(sentinelExit)}`, sentinel };
        }
        } finally {
          try {
            await rm(workDir, { recursive: true, force: true });
          } catch (error: unknown) {
            logBestEffortFailure("Sentinel policy workdir cleanup failed", { runId, policyId: policy.id }, error);
          }
        }
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
      // A missing engine is unreachable, not errored (issue #596): the
      // policy never evaluated. Blocking semantics match errored
      // (mandatory and soft-mandatory stop the run; advisory warns).
      if (err instanceof PolicyEngineMissingError) {
        checkBatch.push({
          id: checkId,
          runId,
          policyId: policy.id,
          policySetId: policy.policySetId,
          status: "unreachable",
          result: { error: err.message },
          createdAt: Date.now(),
        });
        if (policy.enforcementLevel === "hard-mandatory") hardFailed = true;
        if (policy.enforcementLevel === "soft-mandatory") softFailed = true;
        await writeLog(runId, "plan", `[terrence] Policy "${policy.name}" unreachable: ${err.message}`);
        continue;
      }
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

type CapturedProcess = Readonly<{ exitCode: number; output: string; capturedOutput: CapturedProcessOutput }>;

async function captureProcess(
  runId: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
  outputDirectory: string,
): Promise<CapturedProcess> {
  const child = spawnRunProcess(runId, args, { cwd, env, stdout: "pipe", stderr: "pipe" }, runSandbox);
  const outputPromise = captureProcessOutput(child.stdout, child.stderr, outputDirectory, "assessment");
  const [exitCode, capturedOutput] = await waitForTrackedProcess(runId, "assessment", child, outputPromise, timeoutMs);
  return { exitCode, output: processOutputPreview(capturedOutput), capturedOutput };
}

function assessmentIntervalMs(): number {
  const configured = Number(process.env["HEALTH_ASSESSMENT_INTERVAL_MS"] ?? 86_400_000);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 86_400_000;
}

function autoDestroyDurationMs(value: string | null): number | undefined {
  const match = /^([1-9]\d{0,3})([dh])$/.exec(value ?? "");
  if (match === null) return undefined;
  const amount = Number(match[1]);
  return amount * (match[2] === "d" ? 86_400_000 : 3_600_000);
}

const AUTO_DESTROY_SCAN_PAGE_SIZE = 200;

type AutoDestroyDescendingCursor = Readonly<{ createdAt: number; id: string }>;
type AutoDestroyRunCursor = Readonly<{ workspaceId: string; createdAt: number; id: string }>;
type AutoDestroyStateRow = Pick<typeof stateVersions.$inferSelect, "id" | "workspaceId" | "createdAt">;
type AutoDestroyConfigurationRow = Pick<typeof configurationVersions.$inferSelect, "id" | "workspaceId" | "createdAt">;
type AutoDestroyRunRow = Pick<typeof runs.$inferSelect, "id" | "workspaceId" | "status" | "isDestroy" | "message" | "createdAt">;

type AutoDestroyRunFacts = Readonly<{
  activeWorkspaceIds: ReadonlySet<string>;
  lastAttemptAt: ReadonlyMap<string, number>;
}>;

async function latestAutoDestroyStateAt(workspaceIds: readonly string[]): Promise<Map<string, number>> {
  const latest = new Map<string, number>();
  const unresolved = new Set(workspaceIds);
  let cursor: AutoDestroyDescendingCursor | null = null;
  while (unresolved.size > 0) {
    const page: AutoDestroyStateRow[] = await db.query.stateVersions.findMany({
      where: and(
        inArray(stateVersions.workspaceId, [...unresolved]),
        eq(stateVersions.status, "finalized"),
        eq(stateVersions.intermediate, false),
        cursor === null
          ? undefined
          : or(
              lt(stateVersions.createdAt, cursor.createdAt),
              and(eq(stateVersions.createdAt, cursor.createdAt), lt(stateVersions.id, cursor.id)),
            ),
      ),
      columns: { id: true, workspaceId: true, createdAt: true },
      orderBy: [desc(stateVersions.createdAt), desc(stateVersions.id)],
      limit: AUTO_DESTROY_SCAN_PAGE_SIZE,
    });
    if (page.length === 0) break;
    for (const state of page) {
      if (!latest.has(state.workspaceId)) {
        latest.set(state.workspaceId, state.createdAt);
        unresolved.delete(state.workspaceId);
      }
    }
    const last = page[page.length - 1];
    if (last === undefined) break;
    cursor = { createdAt: last.createdAt, id: last.id };
    if (page.length < AUTO_DESTROY_SCAN_PAGE_SIZE) break;
  }
  return latest;
}

async function latestAutoDestroyConfigurationIds(workspaceIds: readonly string[]): Promise<Map<string, string>> {
  const latest = new Map<string, string>();
  const unresolved = new Set(workspaceIds);
  let cursor: AutoDestroyDescendingCursor | null = null;
  while (unresolved.size > 0) {
    const page: AutoDestroyConfigurationRow[] = await db.query.configurationVersions.findMany({
      where: and(
        inArray(configurationVersions.workspaceId, [...unresolved]),
        cursor === null
          ? undefined
          : or(
              lt(configurationVersions.createdAt, cursor.createdAt),
              and(eq(configurationVersions.createdAt, cursor.createdAt), lt(configurationVersions.id, cursor.id)),
            ),
      ),
      columns: { id: true, workspaceId: true, createdAt: true },
      orderBy: [desc(configurationVersions.createdAt), desc(configurationVersions.id)],
      limit: AUTO_DESTROY_SCAN_PAGE_SIZE,
    });
    if (page.length === 0) break;
    for (const configuration of page) {
      if (!latest.has(configuration.workspaceId)) {
        latest.set(configuration.workspaceId, configuration.id);
        unresolved.delete(configuration.workspaceId);
      }
    }
    const last = page[page.length - 1];
    if (last === undefined) break;
    cursor = { createdAt: last.createdAt, id: last.id };
    if (page.length < AUTO_DESTROY_SCAN_PAGE_SIZE) break;
  }
  return latest;
}

async function autoDestroyRunFacts(workspaceIds: readonly string[]): Promise<AutoDestroyRunFacts> {
  const activeWorkspaceIds = new Set<string>();
  const lastAttemptAt = new Map<string, number>();
  const unresolved = new Set(workspaceIds);
  let cursor: AutoDestroyRunCursor | null = null;
  while (unresolved.size > 0) {
    const page: AutoDestroyRunRow[] = await db.query.runs.findMany({
      where: and(
        inArray(runs.workspaceId, [...unresolved]),
        or(
          notInArray(runs.status, FINAL_RUN_STATUSES),
          and(eq(runs.isDestroy, true), like(runs.message, "[auto-destroy]%")),
        ),
        cursor === null
          ? undefined
          : or(
              gt(runs.workspaceId, cursor.workspaceId),
              and(
                eq(runs.workspaceId, cursor.workspaceId),
                or(
                  lt(runs.createdAt, cursor.createdAt),
                  and(eq(runs.createdAt, cursor.createdAt), lt(runs.id, cursor.id)),
                ),
              ),
            ),
      ),
      columns: { id: true, workspaceId: true, status: true, isDestroy: true, message: true, createdAt: true },
      orderBy: [asc(runs.workspaceId), desc(runs.createdAt), desc(runs.id)],
      limit: AUTO_DESTROY_SCAN_PAGE_SIZE,
    });
    if (page.length === 0) break;
    for (const run of page) {
      if (!FINAL_RUN_STATUSES.includes(run.status)) {
        activeWorkspaceIds.add(run.workspaceId);
        unresolved.delete(run.workspaceId);
      } else if (run.isDestroy === true && run.message?.startsWith("[auto-destroy]") === true) {
        if (!lastAttemptAt.has(run.workspaceId)) lastAttemptAt.set(run.workspaceId, run.createdAt);
        // Keep scanning this workspace: an older non-final run may appear on
        // a later page and must suppress a duplicate destroy run.
      }
    }
    const last = page[page.length - 1];
    if (last === undefined) break;
    cursor = { workspaceId: last.workspaceId, createdAt: last.createdAt, id: last.id };
    if (page.length < AUTO_DESTROY_SCAN_PAGE_SIZE) break;
  }
  return { activeWorkspaceIds, lastAttemptAt };
}

export async function enqueueDueAutoDestroyRuns(now = Date.now()): Promise<string[]> {
  if (isMaintenanceActive()) return [];
  if (workerQueueDraining()) return [];

  const created: string[] = [];
  let workspaceCursor: AutoDestroyDescendingCursor | null = null;
  for (;;) {
    const workspacePage: (typeof workspaces.$inferSelect)[] = await db.query.workspaces.findMany({
      where: workspaceCursor === null
        ? undefined
        : or(
            gt(workspaces.createdAt, workspaceCursor.createdAt),
            and(eq(workspaces.createdAt, workspaceCursor.createdAt), gt(workspaces.id, workspaceCursor.id)),
          ),
      orderBy: [asc(workspaces.createdAt), asc(workspaces.id)],
      limit: AUTO_DESTROY_SCAN_PAGE_SIZE,
    });
    if (workspacePage.length === 0) break;

    const workspaceIds = workspacePage.map((workspace): string => workspace.id);
    const [latestStateAt, latestConfigurationId, runFacts] = await Promise.all([
      latestAutoDestroyStateAt(workspaceIds),
      latestAutoDestroyConfigurationIds(workspaceIds),
      autoDestroyRunFacts(workspaceIds),
    ]);

    for (const workspace of workspacePage) {
      if (workspace.locked === true || runFacts.activeWorkspaceIds.has(workspace.id)) continue;
      const scheduledAt = workspace.autoDestroyAt === null ? Number.NaN : Date.parse(workspace.autoDestroyAt);
      const scheduled = Number.isFinite(scheduledAt) && scheduledAt <= now;
      const duration = autoDestroyDurationMs(workspace.autoDestroyActivityDuration);
      const activityAt = Math.max(
        workspace.createdAt,
        latestStateAt.get(workspace.id) ?? 0,
        runFacts.lastAttemptAt.get(workspace.id) ?? 0,
      );
      const inactive = duration !== undefined && activityAt + duration <= now;
      if (!scheduled && !inactive) continue;

      const runId = newRunId();
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

    const last = workspacePage[workspacePage.length - 1];
    if (last === undefined) break;
    workspaceCursor = { createdAt: last.createdAt, id: last.id };
    if (workspacePage.length < AUTO_DESTROY_SCAN_PAGE_SIZE) break;
  }
  return created;
}


export async function enqueueDueAssessments(now = Date.now()): Promise<string[]> {
  if (isMaintenanceActive()) return [];
  if (workerQueueDraining()) return [];
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
  for (const assessment of batch) scheduleExplorerInventory(assessment.workspaceId);
  return enqueued;
}

/** Tracked wrapper: shutdown drain waits for in-flight assessments. */
async function executeAssessment(assessmentResultId: string): Promise<void> {
  return trackLocalExecution(executeAssessmentImpl(assessmentResultId));
}

async function executeAssessmentImpl(assessmentResultId: string): Promise<void> {
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
    scheduleExplorerInventory(workspace.id);
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

    const simulated = envEnabled(process.env["SIMULATED_RUNS"]) || Reflect.get(process.env, "NODE_ENV") === "test";
    let planJson: JsonObject;
    let providerSchema: JsonObject = {};

    if (simulated) {
      planJson = parseJsonObject(process.env["SIMULATED_ASSESSMENT_JSON"] ?? '{"resource_changes":[],"checks":[]}');
      providerSchema = parseJsonObject(process.env["SIMULATED_ASSESSMENT_SCHEMA"] ?? "{}");
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
      if (!(await extractTarArchive(
        configuration.archivePath,
        workDir,
        undefined,
        { phase: "assessment" },
      ))) {
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
      await writeFile(join(executionDir, "terraform.tfstate"), decodeStatePayload(latestState.statePayload), { mode: 0o600 });

      const variables = await executionVariables(workspace.id, workspace.orgId, workspace.projectId ?? null);
      const project = workspace.projectId === null ? undefined : await db.query.projects.findFirst({ where: eq(projects.id, workspace.projectId) });
      const settings = await db.query.adminGeneralSettings.findFirst({ where: eq(adminGeneralSettings.id, "general") });
      const assessmentTimeoutMs = timeoutSeconds(settings?.planTimeout, 7_200) * 1_000;
      const identity = await workspaceIdentityEnvironment({
        organizationId: organization?.id ?? workspace.orgId,
        organizationName: organization?.name ?? workspace.orgId,
        projectId: workspace.projectId ?? "default",
        projectName: project?.name ?? "Default Project",
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        runId: assessmentResultId,
        phase: "plan",
        ttlSeconds: timeoutSeconds(settings?.planTimeout, 7_200),
      }, variables, executionDir);
      const environment = { ...buildSanitizedEnv(variables), ...buildSanitizedEnv(normalizeRunVariables(appliedRun.variables)), ...identity.environment };
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
      // Run-scoped terraform variables ride their own var-file like the plan
      // path (issue #577) instead of raw -var flags.
      const appliedRunTfVarsLines = normalizeRunVariables(appliedRun.variables)
        .filter((variable): boolean => variable.category === "terraform" && !variable.sensitive)
        .map((variable): string => `${variable.key} = ${JSON.stringify(variable.value)}`);
      if (appliedRunTfVarsLines.length > 0) {
        await writeFile(
          join(executionDir, "terrence.run.tfvars"),
          appliedRunTfVarsLines.join("\n"),
          { mode: 0o600 },
        );
      }

      const requestedTool = workspace.iacBinary ?? organization?.defaultIacBinary ?? "terraform";
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
        `assessment-${assessmentResultId}`,
        [resolved.binaryPath, "init", "-reconfigure", "-no-color", "-input=false"],
        executionDir,
        environment,
        assessmentTimeoutMs,
        workDir,
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
      if (appliedRunTfVarsLines.length > 0) planArgs.push("-var-file=terrence.run.tfvars");
      for (const variable of variables) {
        if (variable.category === "terraform" && variable.priority) {
          planArgs.push(`-var=${variable.key}=${variable.hcl ? variable.value : JSON.stringify(variable.value)}`);
        }
      }
      const plan = await captureProcess(
        `assessment-${assessmentResultId}`,
        planArgs,
        executionDir,
        environment,
        assessmentTimeoutMs,
        workDir,
      );
      appendOutput(plan.output);
      if (plan.exitCode !== 0 && plan.exitCode !== 2) {
        throw new Error(`${resolved.tool} assessment plan failed with exit code ${String(plan.exitCode)}`);
      }

      const generatedPlan = await readPlanJson(assessmentResultId, executionDir, resolved.binaryPath, assessmentTimeoutMs, workDir);
      if (generatedPlan === undefined) throw new Error("Unable to read assessment plan JSON.");
      planJson = generatedPlan.planJson;

      const schema = await captureProcess(
        `assessment-${assessmentResultId}`,
        [resolved.binaryPath, "providers", "schema", "-json"],
        executionDir,
        environment,
        assessmentTimeoutMs,
        workDir,
      );
      if (schema.exitCode === 0) providerSchema = parseJsonObject(await readCapturedJson(schema.capturedOutput, "Provider schema output"));
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
      scheduleExplorerInventory(workspace.id);
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
    scheduleExplorerInventory(workspace.id);
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
    scheduleExplorerInventory(workspace.id);
    queueAssessmentNotification(assessmentResultId, "assessment:failed");
  } finally {
    await revokeWorkloadIdentityTokens(assessmentResultId).catch((error: unknown): void => {
      log.error("Failed to revoke assessment workload identity tokens", { assessmentResultId, error: String(error) });
    });
    try {
      if (runSandbox !== null) {
        await removeSandboxWorkDir(`assessment-${assessmentResultId}`);
      } else {
        await rm(workDir, { recursive: true, force: true });
      }
    } catch (error: unknown) {
      logBestEffortFailure("Assessment workdir cleanup failed", { assessmentResultId }, error);
    }
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
async function withQueueGate<T>(gate: "assessment" | "worker", fn: () => Promise<T>): Promise<T> {
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
  if (isMaintenanceActive()) return [];
  if (workerQueueDraining()) return [];
  const configured = Number(process.env["HEALTH_ASSESSMENT_CONCURRENCY"] ?? 2);
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
let workerQueueCursor: { createdAt: number; id: string } = { createdAt: 0, id: "" };

export async function pollWorkerQueue(): Promise<string[]> {
  return withQueueGate("worker", async (): Promise<string[]> => {
  if (isMaintenanceActive()) return [];
  if (workerQueueDraining()) return [];
  if (isStorageDegraded()) return [];
  await recoverStaleAgentJobs();
  // ponytail: scan the pending queue in-process; replace with a grouped SQL claim if queue volume matters.
  // Keyset-paged scan over (createdAt, id): a page full of ineligible runs can
  // no longer hide newer eligible ones (kanban 1.5). The cursor is stable even
  // while earlier runs are claimed and leave the pending set.
  const MAX_CLAIMS = 5;
  const SCAN_PAGE_SIZE = 50;
  // Hard bound on pages per poll: a queue dominated by permanently ineligible
  // runs (locked workspaces, agent-pool outages) must not turn one poll cycle
  // into a full-table scan. Eligible runs beyond the budget wait for the next
  // poll, which resumes from the same cursor position.
  const MAX_SCAN_PAGES = 10;
  const claimedRunIds: string[] = [];
  const claimedWorkspaceIds = new Set<string>();
  let cursorCreatedAt = workerQueueCursor.createdAt;
  let cursorId = workerQueueCursor.id;
  let morePages = true;
  let scannedPages = 0;
  while (claimedRunIds.length < MAX_CLAIMS && morePages && scannedPages < MAX_SCAN_PAGES) {
    scannedPages += 1;
    const pendingRuns = await db.query.runs.findMany({
      where: and(
        eq(runs.status, "pending"),
        cursorId === ""
          ? undefined
          : or(
              gt(runs.createdAt, cursorCreatedAt),
              and(eq(runs.createdAt, cursorCreatedAt), gt(runs.id, cursorId)),
            ),
      ),
      orderBy: [asc(runs.createdAt), asc(runs.id)],
      limit: SCAN_PAGE_SIZE,
    });
    if (pendingRuns.length === 0) {
      // A complete pass reached the end of the pending set. Wrap so newly
      // queued runs and previously blocked prefixes are eligible next poll.
      workerQueueCursor = { createdAt: 0, id: "" };
      break;
    }
    morePages = pendingRuns.length === SCAN_PAGE_SIZE;

  // Pre-fetch workspaces to avoid N+1 inside the loop
  const workspaceIds = [...new Set(pendingRuns.map((run): string => run.workspaceId))];
  const workspacesById = workspaceIds.length === 0
    ? new Map<string, typeof workspaces.$inferSelect>()
    : new Map(
        (await db.query.workspaces.findMany({
          where: inArray(workspaces.id, workspaceIds),
        })).map((ws): [string, typeof workspaces.$inferSelect] => [ws.id, ws]),
      );

  // Resolve queue eligibility inputs once per page instead of querying the
  // same pool, project, organization, and scope rows for every candidate.
  const agentPoolIds = [...new Set([...workspacesById.values()]
    .filter((workspace): boolean => workspace.executionMode === "agent" && workspace.agentPoolId !== null)
    .map((workspace): string | null => workspace.agentPoolId)
    .filter((id): id is string => id !== null))];
  const projectIds = [...new Set([...workspacesById.values()]
    .map((workspace): string | null => workspace.projectId)
    .filter((id): id is string => id !== null))];
  const organizationIds = [...new Set([...workspacesById.values()].map((workspace): string => workspace.orgId))];
  const [poolRows, projectRows, organizationRows, allowedWorkspaceRows, allowedProjectRows] = await Promise.all([
    agentPoolIds.length === 0 ? Promise.resolve([]) : db.query.agentPools.findMany({ where: inArray(agentPools.id, agentPoolIds) }),
    projectIds.length === 0 ? Promise.resolve([]) : db.query.projects.findMany({ where: inArray(projects.id, projectIds) }),
    organizationIds.length === 0 ? Promise.resolve([]) : db.query.organizations.findMany({ where: inArray(organizations.id, organizationIds) }),
    agentPoolIds.length === 0 ? Promise.resolve([]) : db.query.agentPoolAllowedWorkspaces.findMany({ where: inArray(agentPoolAllowedWorkspaces.agentPoolId, agentPoolIds) }),
    agentPoolIds.length === 0 ? Promise.resolve([]) : db.query.agentPoolAllowedProjects.findMany({ where: inArray(agentPoolAllowedProjects.agentPoolId, agentPoolIds) }),
  ]);
  const poolsById = new Map(poolRows.map((pool): [string, typeof agentPools.$inferSelect] => [pool.id, pool]));
  const projectsById = new Map(projectRows.map((project): [string, typeof projects.$inferSelect] => [project.id, project]));
  const organizationsById = new Map(organizationRows.map((organization): [string, typeof organizations.$inferSelect] => [organization.id, organization]));
  const allowedWorkspacesByPool = new Map<string, Set<string>>();
  for (const row of allowedWorkspaceRows) {
    const values = allowedWorkspacesByPool.get(row.agentPoolId) ?? new Set<string>();
    values.add(row.workspaceId);
    allowedWorkspacesByPool.set(row.agentPoolId, values);
  }
  const allowedProjectsByPool = new Map<string, Set<string>>();
  for (const row of allowedProjectRows) {
    const values = allowedProjectsByPool.get(row.agentPoolId) ?? new Set<string>();
    values.add(row.projectId);
    allowedProjectsByPool.set(row.agentPoolId, values);
  }
  const noAllowedIds = new Set<string>();

  for (const run of pendingRuns) {
    if (claimedRunIds.length === MAX_CLAIMS) break;
    cursorCreatedAt = run.createdAt;
    cursorId = run.id;
    workerQueueCursor = { createdAt: cursorCreatedAt, id: cursorId };
    if (claimedWorkspaceIds.has(run.workspaceId)) continue;

    const workspace = workspacesById.get(run.workspaceId);
    if (workspace === undefined) continue;
    // A lock acquired after run creation parks the run silently (issue
    // #575). Log the block throttled instead of parking with no signal.
    if (workspace.locked === true) {
      if (notePlanLockLogged(run.id)) {
        const reason = typeof workspace.lockedReason === "string" && workspace.lockedReason !== ""
          ? ` Reason: ${workspace.lockedReason}`
          : "";
        await writeLog(run.id, "plan", `[terrence] Run is waiting: the workspace is locked.${reason} Unlock the workspace or cancel this run.`);
      }
      continue;
    }

    // Atomic conditional claim: only claim if no planning/applying run exists for this workspace,
    // and the run is still pending.
    // Speculative/plan-only runs do NOT block the queue — they can run alongside other runs.
    const blockerStatuses = run.planOnly || run.savePlan
      ? []
      : [
          ...WORKSPACE_BLOCKING_RUN_STATUSES,
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
      const pool = workspace.agentPoolId === null ? undefined : poolsById.get(workspace.agentPoolId);
      if (
        pool?.orgId !== workspace.orgId
        || !(await agentPoolAllowsWorkspace(
          pool,
          workspace.id,
          workspace.projectId,
          allowedWorkspacesByPool.get(pool.id) ?? noAllowedIds,
          allowedProjectsByPool.get(pool.id) ?? noAllowedIds,
        ))
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
        const inputState = await tx.query.stateVersions.findFirst({
          where: and(eq(stateVersions.workspaceId, workspace.id), eq(stateVersions.status, "finalized"), eq(stateVersions.intermediate, false)),
          orderBy: [desc(stateVersions.serial)],
          columns: { id: true, serial: true },
        });
        const claimed = await tx.update(runs).set({
          agentPoolId: pool.id,
          status: "plan_queued",
          statusTimestamps: {
            ...(run.statusTimestamps ?? {}),
            "plan-queued-at": new Date().toISOString(),
            ...(inputState === undefined ? {} : {
              "input-state-version-id": inputState.id,
              "input-state-serial": String(inputState.serial),
            }),
          },
        }).where(claimWhere).returning({ id: runs.id });
        if (claimed.length === 0) return false;
        await tx.insert(agentJobs).values({
          id: `ajob-${crypto.randomUUID()}`,
          runId: run.id,
          agentPoolId: pool.id,
          phase: "plan",
          // Resolve the IaC binary now so claimAgentJob can route by
          // capability. Unset workspace binary means terraform for agent
          // execution (the tfc-agent contract); the org default only
          // applies to locally executed runs.
          iacBinary: workspace.iacBinary ?? "terraform",
          fencingToken: 0,
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

    // Executor policy (36-39): refuse local Landlock for untrusted workspaces
    // or when project/org requires hard isolation.
    {
      let projectForPolicy: { allowedExecutionModes?: string | null } | null = null;
      let orgForPolicy: { requireHardIsolation?: boolean | null } | null = null;
      try {
        if (workspace.projectId !== null && workspace.projectId !== undefined) {
          const p = projectsById.get(workspace.projectId);
          if (p !== undefined) projectForPolicy = { allowedExecutionModes: p.allowedExecutionModes ?? null };
        }
        const o = organizationsById.get(workspace.orgId);
        if (o !== undefined) orgForPolicy = { requireHardIsolation: o.requireHardIsolation ?? null };
      } catch (error: unknown) {
        log.error("executor policy lookup failed, deferring run", { runId: run.id, error: String(error) });
        continue;
      }
      const policyError = executorPolicyAllowsLocal(
        workspace,
        projectForPolicy,
        orgForPolicy,
      );
      if (policyError !== null) {
        const blocked = await db.update(runs).set({
          status: "errored",
          statusTimestamps: { ...(run.statusTimestamps ?? {}), "errored-at": new Date().toISOString() },
        }).where(and(claimWhere, eq(runs.status, "pending"))).returning({ id: runs.id });
        if (blocked.length > 0) {
          await writeLog(run.id, "plan", `[terrence ERROR] ${policyError}`);
          queueRunNotification(run.id, "run:errored", "errored");
          void reportRunVcsStatus(run.id, "errored");
          publish("run.status", {
            "run-id": run.id,
            "workspace-id": workspace.id,
            "org-id": workspace.orgId,
            status: "errored",
            at: new Date().toISOString(),
          });
        }
        continue;
      }
    }

    // Local-execution workspaces never run on the server (issue #567):
    // remote runs are rejected at creation, so any pending row here
    // predates the gate. Error it with an explanation instead of
    // executing it or leaving it stuck forever.
    if (workspace.executionMode === "local") {
      const blocked = await db.update(runs).set({
        status: "errored",
        statusTimestamps: { ...(run.statusTimestamps ?? {}), "errored-at": new Date().toISOString() },
      }).where(and(claimWhere, eq(runs.status, "pending"))).returning({ id: runs.id });
      if (blocked.length > 0) {
        await writeLog(run.id, "plan", "[terrence ERROR] Remote runs cannot execute on workspaces with local execution mode. Plan and apply locally with the CLI; this run predates local-execution enforcement.");
        queueRunNotification(run.id, "run:errored", "errored");
        void reportRunVcsStatus(run.id, "errored");
        publish("run.status", {
          "run-id": run.id,
          "workspace-id": workspace.id,
          "org-id": workspace.orgId,
          status: "errored",
          at: new Date().toISOString(),
        });
      }
      continue;
    }

    let localReservationHeld = workspace.executionMode !== "agent" && reserveLocalRunExecution(run.id);
    if (!localReservationHeld && workspace.executionMode !== "agent") continue;

    // Claim local and remote runs atomically by moving them into the first execution stage.
    try {
      const claimed = await db.update(runs)
        .set({ status: "fetching" })
        .where(claimWhere)
        .returning({ id: runs.id });

      if (claimed.length > 0) {
        claimedRunIds.push(run.id);
        claimedWorkspaceIds.add(run.workspaceId);
        planLockLoggedAt.delete(run.id);
        // Advance through plan_queued then dispatch to planning
        executeRun(run.id).catch((err: unknown): void => { log.error("Worker error on run", { runId: run.id, error: err }); });
        localReservationHeld = false;
      } else if (localReservationHeld) {
        releaseLocalRunReservation(run.id);
        localReservationHeld = false;
      }
    } catch (error: unknown) {
      if (localReservationHeld) releaseLocalRunReservation(run.id);
      throw error;
    }
  }
  }

  return claimedRunIds;
  });
}

/**
 * Apply confirmed runs whose scheduled-at time has arrived.
 * The schedule-apply endpoint only stamps `scheduledAt`; this poller is the
 * single execution path, so a restart never loses a schedule. The
 * interactive apply action and the approval webhook stay independent.
 * Each run is claimed atomically (conditional status update) so overlapping
 * polls or a future multi-worker deployment can never dispatch the same run
 * twice; per-run failures are isolated so one bad apply cannot abort the
 * batch. Gate semantics mirror the auto-apply path: a blocked apply stays
 * confirmed and is retried on the next poll.
 */
export async function applyDueScheduledRuns(): Promise<string[]> {
  if (isMaintenanceActive()) return [];
  if (workerQueueDraining()) return [];
  if (isStorageDegraded()) return [];
  const now = Date.now();
  const dueRuns = await db.query.runs.findMany({
    columns: { id: true, workspaceId: true, planOnly: true, savePlan: true, statusTimestamps: true },
    where: and(
      eq(runs.status, "confirmed"),
      isNotNull(runs.scheduledAt),
      sql`${runs.scheduledAt} <= ${now}`,
      eq(runs.planOnly, false),
    ),
    limit: 50,
  });
  // Prune block-reason bookkeeping for runs that left the due set (applied,
  // canceled, or rescheduled).
  const dueIds = new Set(dueRuns.map((run): string => run.id));
  for (const key of scheduledBlockReasons.keys()) {
    const runId = key.startsWith("scheduled:") || key.startsWith("agent-pool:") || key.startsWith("workspace-lock:")
      ? key.slice(key.indexOf(":") + 1)
      : "";
    if (runId !== "" && !dueIds.has(runId)) scheduledBlockReasons.delete(key);
  }
  const scheduledWorkspaceRows = dueRuns.length === 0
    ? []
    : await db.query.workspaces.findMany({
        columns: { id: true, orgId: true, locked: true, lockedReason: true, executionMode: true, agentPoolId: true, projectId: true },
        where: inArray(workspaces.id, [...new Set(dueRuns.map((run): string => run.workspaceId))]),
      });
  const workspacesById = new Map(scheduledWorkspaceRows.map((workspace): readonly [string, typeof workspace] => [workspace.id, workspace]));
  const applied: string[] = [];
  for (const run of dueRuns) {
    if (run.planOnly === true) continue;
    try {
      const workspace = workspacesById.get(run.workspaceId);
      if (workspace === undefined) continue;
      // A lock acquired after the apply was confirmed parks the run
      // silently (issue #575). Log the block throttled like the other
      // deferral reasons instead of parking with no signal.
      if (workspace.locked === true) {
        const reason = typeof workspace.lockedReason === "string" && workspace.lockedReason !== ""
          ? workspace.lockedReason
          : "locked";
        const key = `scheduled:${run.id}`;
        if (scheduledBlockReasons.get(key) !== `workspace-locked:${reason}`) {
          scheduledBlockReasons.set(key, `workspace-locked:${reason}`);
          await writeLog(run.id, "apply", `[terrence] Apply is waiting: the workspace is locked (${reason}). Unlock the workspace or cancel this run.`);
        }
        continue;
      }
      if (workspace.executionMode === "local") {
        // Local-execution workspaces never run on the server (issue #567):
        // a confirmed row here predates the creation gate. Error it with
        // an explanation instead of dispatching or leaving it confirmed
        // forever.
        const blocked = await db.update(runs).set({
          status: "errored",
          statusTimestamps: { ...(run.statusTimestamps ?? {}), "errored-at": new Date().toISOString() },
        }).where(and(eq(runs.id, run.id), eq(runs.status, "confirmed"))).returning({ id: runs.id });
        if (blocked.length > 0) {
          await writeLog(run.id, "apply", "[terrence ERROR] Remote runs cannot execute on workspaces with local execution mode. This apply predates local-execution enforcement.");
          queueRunNotification(run.id, "run:errored", "errored");
          void reportRunVcsStatus(run.id, "errored");
        }
        continue;
      }
      const gateBlockReason = await applyGateBlockReason(new Date());
      if (gateBlockReason !== null) {
        // Log the deferral only when the block reason changes so a closed
        // maintenance window cannot spam the run log on every poll.
        const key = `scheduled:${run.id}`;
        if (scheduledBlockReasons.get(key) !== gateBlockReason) {
          scheduledBlockReasons.set(key, gateBlockReason);
          await writeLog(run.id, "apply", `[terrence] Scheduled apply blocked: ${gateBlockReason}`);
        }
        continue;
      }
      scheduledBlockReasons.delete(`scheduled:${run.id}`);
      if (workspace.executionMode === "agent") {
        const pool = workspace.agentPoolId === null
          ? undefined
          : await db.query.agentPools.findFirst({ where: eq(agentPools.id, workspace.agentPoolId) });
        if (
          pool?.orgId !== workspace.orgId
          || !(await agentPoolAllowsWorkspace(pool, workspace.id, workspace.projectId))
        ) {
          // Persistent pool failures must not spam the run log on every
          // poll; log once per reason like the gate-block path. The run
          // stays confirmed and is retried once the pool is reachable.
          const key = `agent-pool:${run.id}`;
          if (scheduledBlockReasons.get(key) !== "pool-unreachable") {
            scheduledBlockReasons.set(key, "pool-unreachable");
            await writeLog(run.id, "apply", "[terrence ERROR] The configured agent pool is missing or is not allowed to execute this workspace.");
          }
          continue;
        }
        scheduledBlockReasons.delete(`agent-pool:${run.id}`);
        // Claim (confirmed -> apply_queued) and job insert are ONE
        // transaction (kanban t_c5f59537): a crash cannot leave the run
        // apply_queued without a job. Concurrent polls see zero rows. Any
        // failure throws and rolls back the whole transaction; the outer
        // catch keeps the run confirmed for the next poll.
        const job = await db.transaction(async (transaction): Promise<AgentJob | undefined> => {
          const tx = transaction as unknown as typeof db;
          return insertAgentApplyJobTx(tx, run.id, pool.id, run.statusTimestamps);
        });
        if (job === undefined) continue;
        applied.push(run.id);
        continue;
      }
      // Atomic claim: only the poll that flips confirmed -> apply_queued
      // may dispatch; concurrent polls see zero rows and skip.
      const localReservation = reserveLocalRunExecution(run.id);
      if (!localReservation) continue;
      const claimed = await db.update(runs).set({
        status: "apply_queued",
        statusTimestamps: {
          ...(run.statusTimestamps ?? {}),
          "apply-queued-at": new Date().toISOString(),
        },
      }).where(and(eq(runs.id, run.id), eq(runs.status, "confirmed"))).returning({ id: runs.id });
      if (claimed.length === 0) {
        releaseLocalRunReservation(run.id);
        continue;
      }
      // Fire-and-forget like the manual-apply dispatch: the poll cycle must
      // keep moving; executeApply owns its own lifecycle and errors are
      // logged, with the claim already taken so nothing re-dispatches.
      void executeApply(run.id).catch((error: unknown): void => {
        log.error("Scheduled executeApply failed", { runId: run.id, error });
      });
      applied.push(run.id);
    } catch (error: unknown) {
      if (localRunReservations.has(run.id)) releaseLocalRunReservation(run.id);
      log.error("Scheduled apply failed", { runId: run.id, error });
      // Keep the run confirmed so a transient failure retries next poll.
      try {
        await db.update(runs).set({ status: "confirmed" }).where(and(eq(runs.id, run.id), eq(runs.status, "apply_queued")));
      } catch (restoreError: unknown) {
        logBestEffortFailure("Failed to restore scheduled run after apply dispatch failure", { runId: run.id }, restoreError);
      }
    }
  }
  return applied;
}

/** Latest gate-block reason per scheduled run (avoids per-poll log spam). */
const scheduledBlockReasons = new Map<string, string>();

export function scheduledBlockReasonsForTests(): ReadonlyMap<string, string> {
  return scheduledBlockReasons;
}

export function clearScheduledBlockReasonsForTests(): void {
  scheduledBlockReasons.clear();
}

export function pruneScheduledBlockReasonsForTests(dueIds: ReadonlySet<string>): void {
  for (const key of scheduledBlockReasons.keys()) {
    const runId = key.startsWith("scheduled:") || key.startsWith("agent-pool:") || key.startsWith("workspace-lock:")
      ? key.slice(key.indexOf(":") + 1)
      : "";
    if (runId !== "" && !dueIds.has(runId)) scheduledBlockReasons.delete(key);
  }
}

/**
 * Parse a poll-interval override. Invalid, empty, or sub-minimum values
 * fall back to the default so a misconfiguration cannot hot-loop the DB
 * (kanban 3.7 pattern).
 */
function pollIntervalMs(raw: string | undefined, fallback: number, minimum: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

/**
 * Run queue poll interval (startWorkerQueue claims pending runs and drains
 * the apply schedule on this cadence). Configurable for low-power homelab
 * installs that want a gentler query load.
 */
const WORKER_POLL_INTERVAL_MS = pollIntervalMs(process.env["TERRENCE_WORKER_POLL_MS"], 1500, 100);

/**
 * Auto-destroy scan cadence, independent of the run-queue poll. The sweep
 * reads all workspaces/runs/finalized states/configurations, so it only
 * makes sense to run it while auto-destroy matters (default 30s, scratch
 * review: full-table sweep per 1.5s tick is O(all history) even with zero
 * workspaces using auto-destroy).
 */
const AUTO_DESTROY_POLL_INTERVAL_MS = pollIntervalMs(process.env["TERRENCE_AUTO_DESTROY_POLL_MS"], 30_000, 5_000);

/**
 * Health-assessment discovery cadence. Assessments become due in minutes to
 * days; discovering them every 1.5s reloads every workspace and organization
 * for nothing. Default 60s (scratch review).
 */
const ASSESSMENT_POLL_INTERVAL_MS = pollIntervalMs(process.env["TERRENCE_ASSESSMENT_POLL_MS"], 60_000, 5_000);

// --- Graceful-drain state (shutdown) ---
// SIGTERM sets the draining flag: the pollers stop claiming new work while
// in-flight executeRun/executeApply/executeAssessment calls finish
// naturally, then the shutdown path checkpoints the DB once idle (or after a
// bounded grace). Startup reconciliation (reconcileInterruptedLocalRuns) is
// the safety net for executions that could NOT finish (SIGKILL, power loss).
let draining = false;
let activeLocalExecutions = 0;
const activeLocalRunExecutions = new Map<string, number>();
const localRunReservations = new Set<string>();
const localRunWaiters: (() => void)[] = [];
let executionIdleCallback: (() => void) | null = null;

/** Stop the background scheduler from claiming new work (graceful shutdown).
 * Terminal for the process: poll cycles stop re-arming and startWorkerQueue
 * cannot be restarted (isWorkerLoopRunning stays set), which is the intended
 * contract for the shutdown path in index.ts. */
export function stopWorkerQueue(): void {
  draining = true;
}

export function workerQueueDraining(): boolean {
  return draining;
}

/**
 * Resolve when every locally executing run/assessment has finished, or after
 * graceMs elapses (returns false). Callers wait on this before checkpointing
 * the DB so no execution can write after the checkpoint.
 */
export async function waitForWorkerDrain(graceMs: number): Promise<boolean> {
  if (activeLocalExecutions === 0) return Promise.resolve(true);
  return new Promise((resolve): void => {
    const timer = setTimeout((): void => {
      executionIdleCallback = null;
      resolve(false);
    }, graceMs);
    executionIdleCallback = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
  });
}

/** Count a local execution so shutdown can wait for it (drain mode). */
async function trackLocalExecution<T>(promise: Promise<T>): Promise<T> {
  activeLocalExecutions += 1;
  const settle = (): void => {
    activeLocalExecutions -= 1;
    if (activeLocalExecutions === 0 && executionIdleCallback !== null) {
      const callback = executionIdleCallback;
      executionIdleCallback = null;
      callback();
    }
  };
  return promise.then(
    (value: T): T => {
      settle();
      return value;
    },
    (error: unknown): never => {
      settle();
      throw error;
    },
  );
}

function localRunConcurrencyLimit(): number {
  const configured = Number(process.env["TERRENCE_RUN_CONCURRENCY"] ?? 5);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 5;
}

/** Last lock-blocked log per pending run (issue #575): re-log at most every
 * 5 minutes so the queue poll does not spam. Bounded; stale entries are
 * harmless because run ids are unique (a stale timestamp only triggers a
 * fresh, accurate log if the id ever reappears as pending). */
const planLockLoggedAt = new Map<string, number>();
const PLAN_LOCK_LOG_INTERVAL_MS = 5 * 60 * 1000;

function notePlanLockLogged(runId: string): boolean {
  const now = Date.now();
  const last = planLockLoggedAt.get(runId);
  if (last !== undefined && now - last < PLAN_LOCK_LOG_INTERVAL_MS) return false;
  planLockLoggedAt.set(runId, now);
  if (planLockLoggedAt.size > 2000) {
    const oldest = planLockLoggedAt.keys().next();
    if (!oldest.done) planLockLoggedAt.delete(oldest.value);
  }
  return true;
}

export function clearPlanLockLoggedForTests(): void {
  planLockLoggedAt.clear();
}

function localRunCapacityUsed(): number {
  return activeLocalRunExecutions.size + localRunReservations.size;
}

function reserveLocalRunExecution(runId: string): boolean {
  if (activeLocalRunExecutions.has(runId) || localRunReservations.has(runId)) return true;
  if (localRunCapacityUsed() >= localRunConcurrencyLimit()) return false;
  localRunReservations.add(runId);
  return true;
}

function releaseLocalRunReservation(runId: string): void {
  if (!localRunReservations.delete(runId)) return;
  localRunWaiters.shift()?.();
}

function acquireLocalRunExecutionSlot(runId: string): Promise<void> {
  const activeCount = activeLocalRunExecutions.get(runId);
  if (activeCount !== undefined) {
    activeLocalRunExecutions.set(runId, activeCount + 1);
    return Promise.resolve();
  }
  if (!localRunReservations.has(runId)) {
    return (async (): Promise<void> => {
      while (localRunCapacityUsed() >= localRunConcurrencyLimit()) {
        await new Promise<void>((resolve): void => { localRunWaiters.push(resolve); });
      }
      localRunReservations.add(runId);
      localRunReservations.delete(runId);
      activeLocalRunExecutions.set(runId, 1);
    })();
  }
  localRunReservations.delete(runId);
  activeLocalRunExecutions.set(runId, 1);
  return Promise.resolve();
}

function releaseLocalRunExecutionSlot(runId: string): void {
  const activeCount = activeLocalRunExecutions.get(runId);
  if (activeCount === undefined) return;
  if (activeCount > 1) {
    activeLocalRunExecutions.set(runId, activeCount - 1);
    return;
  }
  activeLocalRunExecutions.delete(runId);
  localRunWaiters.shift()?.();
}

async function trackLocalRunExecution<T>(runId: string, work: () => Promise<T>): Promise<T> {
  await acquireLocalRunExecutionSlot(runId);
  try {
    return await work();
  } finally {
    releaseLocalRunExecutionSlot(runId);
  }
}

export function activeLocalRunExecutionCount(): number {
  return activeLocalRunExecutions.size;
}

/**
 * Ephemeral per-run credentials (the reference format run-token model). Runs execute with a
 * local backend, so the CLI never sees the user's credentials file; the run
 * token is delivered through a private CLI config file instead. One token is
 * minted per run and reused across plan and apply; it is revoked when the run
 * reaches a terminal state and expires at most 24h after minting.
 */
type RunTokenState = {
  token: string;
  tfrcPath: string;
  oidc: Partial<Record<"plan" | "apply", Record<string, string>>>;
};
const runTokenCache = new Map<string, RunTokenState>();

async function runTokenStateFor(
  runId: string,
  workspace: Readonly<{ id: string; orgId: string }>,
): Promise<RunTokenState> {
  const cached = runTokenCache.get(runId);
  if (cached !== undefined) {
    if (await exists(cached.tfrcPath)) return cached;
    const tfrcPath = await writeRunCliConfig(runWorkDir(runId), registryHostname(), cached.token);
    const refreshed = { ...cached, tfrcPath };
    runTokenCache.set(runId, refreshed);
    return refreshed;
  }
  const token = await mintRunToken(runId, workspace.id, workspace.orgId);
  const tfrcPath = await writeRunCliConfig(runWorkDir(runId), registryHostname(), token);
  const value: RunTokenState = { token, tfrcPath, oidc: {} };
  runTokenCache.set(runId, value);
  return value;
}

function registryHostname(): string {
  let hostname = "localhost";
  const configured = process.env["PUBLIC_URL"];
  if (typeof configured === "string" && configured !== "") {
    try {
      hostname = new URL(configured).hostname;
    } catch {
      // keep the default
    }
  }
  return hostname;
}

function timeoutSeconds(value: unknown, fallback: number): number {
  // Settings accept unitless seconds; clamp valid values to one minute and 24 hours.
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.min(86_400, Math.max(60, Math.floor(value))) : fallback;
  const match = typeof value === "string" ? /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(value.trim().toLowerCase()) : null;
  if (match === null) return fallback;
  const amount = Number(match[1]);
  const multiplier = match[2] === "d" ? 86_400 : match[2] === "h" ? 3_600 : match[2] === "m" ? 60 : 1;
  return Number.isFinite(amount) && amount > 0 ? Math.min(86_400, Math.max(60, Math.floor(amount * multiplier))) : fallback;
}

async function executionTimeoutMs(phase: "plan" | "apply"): Promise<number> {
  const settings = await db.query.adminGeneralSettings.findFirst({
    where: eq(adminGeneralSettings.id, "general"),
    columns: { planTimeout: true, applyTimeout: true },
  });
  const raw = phase === "plan" ? settings?.planTimeout : settings?.applyTimeout;
  const fallback = phase === "plan" ? 7_200 : 86_400;
  return timeoutSeconds(raw, fallback) * 1_000;
}

async function runTerraformEnv(
  runId: string,
  workspace: Readonly<{ id: string; orgId: string; projectId: string | null; name: string }>,
  phase: "plan" | "apply",
  variables: readonly Readonly<{ key: string; value: string; category: string }>[],
): Promise<Record<string, string>> {
  const base = await runTokenStateFor(runId, workspace);
  const existingIdentity = base.oidc[phase];
  if (existingIdentity !== undefined) return { TF_CLI_CONFIG_FILE: base.tfrcPath, ...existingIdentity };
  const oidcConfigured = variables.some((variable) => variable.category === "env" && (
    (/^TFC_(AWS|GCP|AZURE|VAULT|the cloud platform|KUBERNETES)_PROVIDER_AUTH(?:_|$)/.test(variable.key) && variable.value.trim().toLowerCase() === "true")
    || (/^TFC_WORKLOAD_IDENTITY_AUDIENCE(?:_|$)/.test(variable.key) && variable.value.trim() !== "")
  ));
  if (!oidcConfigured) {
    base.oidc[phase] = {};
    return { TF_CLI_CONFIG_FILE: base.tfrcPath };
  }
  const [organization, project, settings] = await Promise.all([
    db.query.organizations.findFirst({ where: eq(organizations.id, workspace.orgId) }),
    workspace.projectId === null ? Promise.resolve(undefined) : db.query.projects.findFirst({ where: eq(projects.id, workspace.projectId) }),
    db.query.adminGeneralSettings.findFirst({ where: eq(adminGeneralSettings.id, "general") }),
  ]);
  const identity = organization === undefined ? { environment: {}, tokens: [] } : await workspaceIdentityEnvironment({
    organizationId: organization.id,
    organizationName: organization.name,
    projectId: workspace.projectId ?? "default",
    projectName: project?.name ?? "Default Project",
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    runId,
    phase,
    ttlSeconds: timeoutSeconds(phase === "plan" ? settings?.planTimeout : settings?.applyTimeout, phase === "plan" ? 7_200 : 86_400),
  }, variables, runWorkDir(runId));
  base.oidc[phase] = identity.environment;
  return { TF_CLI_CONFIG_FILE: base.tfrcPath, ...identity.environment };
}

async function cleanupRunToken(runId: string): Promise<void> {
  const cached = runTokenCache.get(runId);
  runTokenCache.delete(runId);
  try {
    await revokeRunTokens(runId);
    await revokeWorkloadIdentityTokens(runId);
  } catch (err: unknown) {
    log.error(`Failed to revoke run tokens for ${runId}`, { error: err instanceof Error ? err.message : String(err) });
  }
  if (cached !== undefined) {
    try {
      await rm(cached.tfrcPath, { force: true });
    } catch {
      // best-effort: the run dir is removed anyway
    }
  }
}

/**
 * Startup reconciliation for runs interrupted by a process restart (SIGKILL,
 * power loss, crash). Local executions die with the process, but their runs
 * keep transient statuses that block the workspace queue forever.
 *
 * Execution states are NEVER resumed automatically: we do not know how far a
 * plan/apply got. States in which no side effect can have fired (archive
 * fetch, queueing) are requeued to pending; everything after pre-plan tasks
 * began is errored with an explanatory log line — applies in particular are
 * never replayed. Agent-mode workspaces are skipped entirely:
 * recoverStaleAgentJobs owns those transitions via heartbeat leases.
 */
const REQUEUE_AFTER_RESTART = new Set(["fetching", "fetching_completed", "queuing", "plan_queued"]);
const ERROR_AFTER_RESTART = new Set([
  "pre_plan_running",
  "pre_plan_completed",
  "planning",
  "cost_estimating",
  "cost_estimated",
  "policy_checking",
  "policy_override",
  "policy_checked",
  "post_plan_running",
  "post_plan_completed",
  "apply_queued",
  "applying",
]);

async function captureInterruptedApplyState(runId: string): Promise<boolean> {
  const root = runWorkDir(runId);
  if (!(await exists(root))) return false;
  const recoveryDir = join(storageDir, "recovery", runId);
  for await (const candidate of new Bun.Glob("**/terraform.tfstate").scan({ cwd: root, onlyFiles: true })) {
    const source = typeof candidate === "string" && candidate.startsWith("/") ? candidate : join(root, String(candidate));
    await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
    const payload = await readFile(source, "utf8");
    const encrypted = await encryptStatePayload(payload);
    if (encrypted === null) return false;
    await writeFile(join(recoveryDir, "terraform.tfstate"), encrypted, { mode: 0o600 });
    await writeFile(join(recoveryDir, ".recovered"), new Date().toISOString(), { mode: 0o600 });
    return true;
  }
  return false;
}

async function pruneInterruptedApplyRecovery(): Promise<void> {
  const rawRetention = process.env["TERRENCE_RECOVERY_RETENTION_MS"];
  const parsedRetention = rawRetention === undefined || rawRetention === "" ? 7 * 24 * 60 * 60 * 1000 : Number(rawRetention);
  const retentionMs = Number.isSafeInteger(parsedRetention) && parsedRetention >= 0 ? parsedRetention : 7 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;
  type CleanupEntry = Readonly<{ name: string; isDirectory(): boolean }>;
  const readCleanupEntries = async (root: string, message: string): Promise<readonly CleanupEntry[] | null> => {
    try {
      return await readdir(root, { withFileTypes: true, encoding: "utf8" }) as unknown as CleanupEntry[];
    } catch (error: unknown) {
      if (!isMissingFileError(error)) logBestEffortFailure(message, { root }, error);
      return null;
    }
  };
  const pruneRoot = async (root: string, requireRecoveredMarker = false): Promise<void> => {
    const entries = await readCleanupEntries(root, "Could not scan cleanup directory");
    if (entries === null) return;
    await Promise.all(entries
      .filter((entry): boolean => entry.isDirectory())
      .map(async (entry): Promise<void> => {
        const path = join(root, entry.name);
        try {
          if (requireRecoveredMarker && !(await exists(join(path, ".recovered")))) return;
          if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
        } catch (error: unknown) {
          if (!isMissingFileError(error)) {
            logBestEffortFailure("Could not prune interrupted-apply recovery", { path }, error);
          }
        }
      }));
  };
  const pruneSavedPlans = async (): Promise<void> => {
    const root = join(storageDir, "saved-plans");
    const entries = await readCleanupEntries(root, "Could not scan saved-plan cleanup directory");
    if (entries === null) return;
    await Promise.all(entries
      .filter((entry): boolean => entry.isDirectory())
      .map(async (entry): Promise<void> => {
        const path = join(root, entry.name);
        try {
          if ((await stat(path)).mtimeMs >= cutoff) return;
          const run = await db.query.runs.findFirst({ where: eq(runs.id, entry.name), columns: { status: true } });
          if (run !== undefined && !FINAL_RUN_STATUSES.includes(run.status)) return;
          await rm(path, { recursive: true, force: true });
        } catch (error: unknown) {
          if (!isMissingFileError(error)) logBestEffortFailure("Could not prune saved plan", { path }, error);
        }
      }));
  };
  await Promise.all([pruneRoot(join(storageDir, "recovery"), true), pruneSavedPlans()]);
}

export async function reconcileInterruptedLocalRuns(): Promise<{
  requeued: number;
  errored: number;
  assessmentsErrored: number;
  rearmed: number;
}> {
  await pruneInterruptedApplyRecovery();
  const pendingAt = new Date().toISOString();
  const candidates = await db.query.runs.findMany({
    where: or(
      inArray(runs.status, [...REQUEUE_AFTER_RESTART]),
      inArray(runs.status, [...ERROR_AFTER_RESTART]),
    ),
    columns: { id: true, workspaceId: true, status: true, statusTimestamps: true },
  });

  const workspaceIds = [...new Set(candidates.map((run): string => run.workspaceId))];
  const executionModes = workspaceIds.length === 0
    ? []
    : await db.query.workspaces.findMany({
        where: inArray(workspaces.id, workspaceIds),
        columns: { id: true, executionMode: true },
      });
  const agentWorkspaceIds = new Set(
    executionModes.filter((ws): boolean => ws.executionMode === "agent").map((ws): string => ws.id),
  );

  let requeued = 0;
  let errored = 0;
  for (const run of candidates) {
    try {
    // Agent-mode runs are owned by recoverStaleAgentJobs; only running local
    // (or workspace-deleted, which can never execute again) runs are
    // reconciled here.
    if (agentWorkspaceIds.has(run.workspaceId)) {
      continue;
    }

    if (REQUEUE_AFTER_RESTART.has(run.status)) {
      const updated = await db.update(runs).set({
        status: "pending",
        statusTimestamps: { ...(run.statusTimestamps ?? {}), "pending-at": pendingAt },
      }).where(and(eq(runs.id, run.id), eq(runs.status, run.status))).returning({ id: runs.id });
      if (updated.length === 0) continue;
      requeued += 1;
      await writeLog(run.id, "plan", "[terrence] Run requeued: the Terrence process restarted before this run's plan began.");
    } else {
      const applySide = run.status === "apply_queued" || run.status === "applying";
      let capturedPartialState = false;
      if (run.status === "applying") {
        try {
          capturedPartialState = await captureInterruptedApplyState(run.id);
        } catch (error: unknown) {
          logBestEffortFailure("Could not capture state after interrupted apply", { runId: run.id }, error);
        }
      }
      const message = applySide
        ? run.status === "applying"
          ? `Terrence restarted during apply; infrastructure state may be partially changed. This run was NOT re-executed automatically.${capturedPartialState ? " A durable recovery copy was captured." : " No local state file was available to capture."}`
          : "Terrence restarted before this apply began; the run was confirmed but never executed. Discard it or start a new run."
        : run.status === "pre_plan_running" || run.status === "pre_plan_completed"
          ? "Terrence restarted while running pre-plan tasks, which may already have executed. This run was marked errored."
          : "Terrence restarted during the plan phase. This run was marked errored.";
      await writeLog(run.id, applySide ? "apply" : "plan", `[terrence ERROR] ${message}`);
      // Mirrors the executeRun/executeApply error path: publishes the
      // transition, reports VCS status, revokes the run token, notifies.
      await updateRunStatus(run.id, "errored");
      if (applySide) await releaseRunWorkspaceLock(run.workspaceId, run.id);
      try {
        if (runSandbox !== null) await removeSandboxWorkDir(run.id);
        else await rm(runWorkDir(run.id), { recursive: true, force: true });
      } catch (error: unknown) {
        logBestEffortFailure("Startup reconciliation workdir cleanup failed", { runId: run.id }, error);
        scheduleRunWorkDirCleanup(run.id);
      }
      errored += 1;
    }
    } catch (error: unknown) {
      // One bad transition or CAS race must not abort the whole startup
      // reconciliation; log and continue to the next interrupted run.
      const detail = error instanceof Error ? error.message : String(error);
      try {
        await writeLog(run.id, "plan", `[terrence ERROR] Startup reconciliation failed for run ${run.id}: ${detail}`);
      } catch (logError: unknown) {
        logBestEffortFailure("Could not persist startup reconciliation failure", { runId: run.id }, logError);
      }
      log.error(`Startup reconciliation failed for run ${run.id}`, { runId: run.id, error: detail });
    }
  }

  // Orphaned manual-apply dispatches (issue #572): the apply route writes
  // confirmed with scheduledAt null and dispatches fire-and-forget. A crash
  // in between leaves a resting state that no poller selects
  // (applyDueScheduledRuns requires scheduledAt) yet still blocks the
  // workspace queue. At boot no dispatcher can be alive, so re-arm these
  // for the scheduled-apply poller by stamping scheduledAt now. The
  // poller's atomic confirmed -> apply_queued claim keeps this safe
  // against double dispatch, and agent-mode runs stay with
  // recoverStaleAgentJobs.
  let rearmed = 0;
  const orphanedApplies = await db.query.runs.findMany({
    where: and(
      eq(runs.status, "confirmed"),
      isNull(runs.scheduledAt),
      eq(runs.planOnly, false),
    ),
    columns: { id: true, workspaceId: true },
  });
  if (orphanedApplies.length > 0) {
    const orphanWorkspaceIds = [...new Set(orphanedApplies.map((run): string => run.workspaceId))];
    const orphanWorkspaces = await db.query.workspaces.findMany({
      where: inArray(workspaces.id, orphanWorkspaceIds),
      columns: { id: true, executionMode: true },
    });
    const orphanAgentWorkspaceIds = new Set(
      orphanWorkspaces.filter((ws): boolean => ws.executionMode === "agent").map((ws): string => ws.id),
    );
    for (const run of orphanedApplies) {
      if (orphanAgentWorkspaceIds.has(run.workspaceId)) continue;
      try {
        const rearmedRows = await db.update(runs).set({ scheduledAt: Date.now() }).where(and(
          eq(runs.id, run.id),
          eq(runs.status, "confirmed"),
          isNull(runs.scheduledAt),
        )).returning({ id: runs.id });
        if (rearmedRows.length === 0) continue;
        rearmed += 1;
        await writeLog(run.id, "apply", "[terrence] Run re-armed: the Terrence process restarted after apply was confirmed but before dispatch. The scheduled-apply poller will dispatch it.");
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        logBestEffortFailure("Startup reconciliation failed to re-arm orphaned apply", { runId: run.id }, detail);
      }
    }
  }

  // Running assessments die with the process too; they count against the
  // assessment concurrency budget, so error them and let the next discovery
  // cycle create a fresh pending result.
  const runningAssessments = await db.query.assessmentResults.findMany({
    where: eq(assessmentResults.status, "running"),
    columns: { id: true },
  });
  let assessmentsErrored = 0;
  for (const assessment of runningAssessments) {
    const updated = await db.update(assessmentResults).set({
      status: "errored",
      errorMessage: "Terrence restarted during this health assessment",
      completedAt: Date.now(),
    }).where(and(
      eq(assessmentResults.id, assessment.id),
      eq(assessmentResults.status, "running"),
    )).returning({ id: assessmentResults.id });
    if (updated.length === 0) continue;
    assessmentsErrored += 1;
    try {
      if (runSandbox !== null) {
        await removeSandboxWorkDir(`assessment-${assessment.id}`);
      } else {
        await rm(join(tmpdir(), "terrence", "assessments", assessment.id), { recursive: true, force: true });
      }
    } catch (error: unknown) {
      logBestEffortFailure("Startup assessment workdir cleanup failed", { assessmentResultId: assessment.id }, error);
    }
  }

  return { requeued, errored, assessmentsErrored, rearmed };
}

export function startWorkerQueue(): void {
  // Off switch for benchmarks/tests that must run in a process with no
  // background DB activity (the polling loop otherwise injects queries
  // and CPU into measurements).
  if (envEnabled(process.env["TERRENCE_DISABLE_WORKER"])) return;
  if (isWorkerLoopRunning) return;
  isWorkerLoopRunning = true;
  startDurableJobWorker({
    "module-test": runModuleTestJob,
    "stack-configuration": runStackConfigurationJob,
    "stack-deployment": runStackDeploymentJob,
    "explorer-inventory": runExplorerInventoryJob,
    "explorer-catalog": runExplorerCatalogJob,
    "plan-explanation": runPlanExplanationJob,
    "vcs-webhook": handleVcsWebhookJob,
  });

  const arm = (cycle: () => Promise<void>, interval: number): void => {
    if (workerQueueDraining()) return;
    const timer = setTimeout((): void => { void cycle(); }, jitteredPollDelay(interval));
    timer.unref?.();
  };

  const fastCycle = async (): Promise<void> => {
    const pollCycleStarted = Date.now();
    workerPollStarted();
    try {
      // Each poller catches its own failures: one broken poller (schema
      // drift, transient DB error) must never reject the shared Promise.all
      // and starve the run queue alongside it. Outcome timings feed the
      // /metrics worker gauges.
      const pollers: readonly (readonly [string, Promise<unknown>])[] = [
        ["pollWorkerQueue", pollWorkerQueue()],
        ["applyDueScheduledRuns", applyDueScheduledRuns()],
      ];
      await Promise.all(pollers.map(async ([name, poller]): Promise<unknown> => {
        const started = Date.now();
        return poller
          .then((result: unknown): unknown => {
            workerPollerFinished(name, true, started);
            return result;
          })
          .catch((error: unknown): void => {
            workerPollerFinished(name, false, started);
            log.error("Queue poller failed", { error });
          });
      }));
      workerPollFinished(true, pollCycleStarted);
    } catch (err: unknown) {
      log.error("Queue error", { error: err });
      workerPollFinished(false, pollCycleStarted);
    } finally {
      arm(fastCycle, WORKER_POLL_INTERVAL_MS);
    }
  };

  const slowCycle = (name: string, poller: () => Promise<unknown>, interval: number): void => {
    const cycle = async (): Promise<void> => {
      const started = Date.now();
      try {
        await poller();
        workerPollerFinished(name, true, started);
      } catch (error: unknown) {
        workerPollerFinished(name, false, started);
        log.error("Queue poller failed", { error });
      } finally {
        arm(cycle, interval);
      }
    };
    void cycle();
  };

  void fastCycle();
  // Auto-destroy and assessment discovery run on their own slow cadences:
  // the fast poll must not sweep full tables on every 1.5s tick.
  slowCycle(
    "enqueueDueAutoDestroyRuns",
    async (): Promise<unknown> => enqueueDueAutoDestroyRuns(),
    AUTO_DESTROY_POLL_INTERVAL_MS,
  );
  slowCycle(
    "enqueueDueAssessments",
    async (): Promise<void> => {
      try {
        await enqueueDueAssessments();
      } finally {
        // Discovery failures must not strand already-pending assessments:
        // the claim pass runs regardless, and the discovery error still
        // surfaces to slowCycle's catch for logging + metrics.
        await pollAssessmentQueue();
      }
    },
    ASSESSMENT_POLL_INTERVAL_MS,
  );
  // Forwarded agent requests (which may carry credentials) are purged after
  // their retention window so the table cannot grow unbounded and stale
  // pre-completion rows do not persist sensitive headers indefinitely.
  slowCycle(
    "purgeExpiredForwardedRequests",
    async (): Promise<unknown> => purgeExpiredForwardedRequests(),
    60 * 60 * 1000,
  );
}
