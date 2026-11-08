import {
  workspacePolicyExecutionError,
  workspacePolicyPlanningError,
  captureWorkspacePolicyEvaluation,
  latestWorkspacePolicyEvaluation,
  loadWorkspacePolicySnapshot,
  completeWorkspacePolicyEvaluation,
  policyFailureIsOverridable,
  type WorkspacePolicySnapshot,
  type WorkspacePolicyEvaluation,
} from "./workspace-policy-gate";
import { runConfigurationTrusted } from "./run-trust";
import { integerSetting } from "./runtime-config";
import { newResourceId } from "./resource-id";
import { tokenHashCandidates } from "./token-service";
import { and, asc, desc, eq, gt, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import { storageDir } from "../db/driver";
import {
  agentJobs,
  agentPoolTokens,
  agents,
  configurationVersions,
  logs,
  organizations,
  policyChecks,
  runs,
  runTokens,
  stateVersions,
  workspaces,
} from "../db/schema";
import { queueRunNotification } from "./notifications";
import { reportRunVcsStatus } from "./webhooks";
import { planJsonResourceCounts, readPlanJsonArtifact, writePlanJsonArtifact, type PlanJson } from "./plan-json";
import type { DeepReadonly } from "./utils";
import { insertStateVersionWithSerialTx } from "./state-serial";
import { encryptStatePayload, parseTerraformStatePayload } from "./validation";
import { variableValueForRead } from "./variable-crypto";
import { isAgentPoolTokenActive } from "./agent-token";
import { canTransitionRunStatus, isTerminalRunStatus } from "./run-status";
import { captureRecoveryStatePayload } from "./recovery-files";
import {
  agentSupportsPhase,
  agentSupportsCapability,
  effectiveAgentExecutionPolicy,
  LEGACY_AGENT_CAPABILITIES,
  NATIVE_AGENT_CAPABILITY,
} from "./agent-protocol";
import { prepareNativeRun, nativePolicyVerdict, type NativeRun } from "./tfpolicy-native";
import {
  readNativeAgentCandidate,
  persistNativeAgentPlan,
  revokeNativeAgentLease,
  type NativeCandidate,
} from "./agent-native-policy";

export const MAX_AGENT_RESULT_BYTES = 64 * 1024;
export const MAX_AGENT_RESULT_DEPTH = 8;
export const MAX_AGENT_RESULT_KEYS = 500;

export function parseAgentFencingToken(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isLargeString(value: unknown): boolean {
  return typeof value === "string" && value.length > 16_384;
}

function isArrayTooLarge(
  value: readonly unknown[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- keyCount is a mutation accumulator shared across the recursion by design
  keyCount: { count: number },
  depth: number,
): boolean {
  if (value.length > 1000) return true;
  keyCount.count += value.length;
  if (keyCount.count > MAX_AGENT_RESULT_KEYS) return true;
  for (const item of value) if (isResultValueTooLarge(item, depth + 1, keyCount)) return true;
  return false;
}

function isObjectTooLarge(
  entries: readonly (readonly [string, unknown])[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- keyCount is a mutation accumulator shared across the recursion by design
  keyCount: { count: number },
  depth: number,
): boolean {
  if (entries.length > 200) return true;
  keyCount.count += entries.length;
  if (keyCount.count > MAX_AGENT_RESULT_KEYS) return true;
  for (const [k, v] of entries) {
    if (k.length > 1024) return true;
    if (isLargeString(v)) return true;
    if (isResultValueTooLarge(v, depth + 1, keyCount)) return true;
  }
  return false;
}

function isResultValueTooLarge(
  value: unknown,
  depth: number,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- keyCount is a mutation accumulator shared across the recursion by design
  keyCount: { count: number },
): boolean {
  if (depth > MAX_AGENT_RESULT_DEPTH) return true;
  if (isLargeString(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return isArrayTooLarge(value, keyCount, depth);
  return isObjectTooLarge(Object.entries(value as Record<string, unknown>), keyCount, depth);
}

export function isAgentResultValid(result: unknown): boolean {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  try {
    const serialized = JSON.stringify(result);
    if (new TextEncoder().encode(serialized).byteLength > MAX_AGENT_RESULT_BYTES) return false;
  } catch {
    return false;
  }
  return !isResultValueTooLarge(result, 0, { count: 0 });
}

export type AgentJobCompletion = Readonly<{
  status: "completed" | "errored";
  errorMessage: string | null;
  resourceAdditions: number | null;
  resourceChanges: number | null;
  resourceDestructions: number | null;
  resourceImports: number | null;
  planJson: PlanJson | null;
  statePayload: string | null;
  jsonState: string | null;
  jsonStateOutputs: string | null;
  result: Readonly<Record<string, unknown>>;
}>;

export type Agent = DeepReadonly<typeof agents.$inferSelect>;
export type AgentJob = DeepReadonly<typeof agentJobs.$inferSelect>;
type Workspace = DeepReadonly<typeof workspaces.$inferSelect>;
type Database = Readonly<typeof db>;

// Agent liveness is persisted at most this often per agent. The offline
// sweep cutoff (AGENT_HEARTBEAT_TIMEOUT_MS) must stay comfortably above
// this interval so a throttled agent is never swept as unavailable.
const AGENT_PING_WRITE_INTERVAL_MS = 15_000;
// Lower bound so an operator-shrunk timeout cannot drive the write
// interval to something pathological (sub-second DB writes).
const MIN_PING_WRITE_INTERVAL_MS = 3_000;
const MAX_INVALID_COMPLETION_REQUEUES = 3;

export function configuredHeartbeatTimeoutMs(): number {
  return integerSetting("AGENT_HEARTBEAT_TIMEOUT_MS");
}

/**
 * Claim eligibility shared by the agent poller and queue diagnostics. An
 * authenticated poll refreshes lastPingAt before the claim path reaches this
 * check, so a live worker remains eligible even when its recorded status is
 * busy from a previous claim that has already completed.
 */
export function isAgentLiveForClaim(
  agent: Readonly<{ status: string; lastPingAt: number | null }>,
  now = Date.now(),
): boolean {
  if (["unknown", "exited", "errored", "draining"].includes(agent.status)) return false;
  return agent.lastPingAt !== null && now - agent.lastPingAt <= configuredHeartbeatTimeoutMs();
}

/** Persist-at-most interval derived from the sweep timeout: always stays
 * below the timeout so a heartbeating agent can never be swept as stale. */
function effectivePingWriteIntervalMs(): number {
  const timeout = configuredHeartbeatTimeoutMs();
  return Math.min(AGENT_PING_WRITE_INTERVAL_MS, Math.max(MIN_PING_WRITE_INTERVAL_MS, Math.floor(timeout / 4)));
}
// Agent-pool tokens mirror the user-token lastUsedAt throttle (auth.ts).
const AGENT_TOKEN_LAST_USED_INTERVAL_MS = 60_000;

type AgentPolicyEvaluation = Readonly<{
  unsupportedSets: readonly Readonly<{ id: string; kind: string }>[];
  policySets: readonly Readonly<{
    id: string;
    name: string;
    description: string | null;
    kind: string;
    policyToolVersion: string;
    overridable: boolean;
    policies: readonly Readonly<{
      id: string;
      name: string;
      description: string | null;
      enforcementLevel: string;
      query: string | null;
      source: string | null;
    }>[];
    parameters: readonly Readonly<{
      key: string;
      value: string;
      sensitive: boolean;
      hcl: boolean;
    }>[];
  }>[];
}>;
type AgentPolicy = AgentPolicyEvaluation["policySets"][number]["policies"][number];
type AgentPolicyParameter = AgentPolicyEvaluation["policySets"][number]["parameters"][number];

export type ClaimedAgentJob = Readonly<{
  job: AgentJob;
  run: Readonly<typeof runs.$inferSelect>;
  workspace: Workspace;
  configuration: Readonly<typeof configurationVersions.$inferSelect> | null;
  inputState: Readonly<typeof stateVersions.$inferSelect> | null;
  planResult: Readonly<Record<string, unknown>> | null;
  policyEvaluation: AgentPolicyEvaluation | null;
  nativePolicy?: NativeRun | null;
}>;

type AgentPolicyOutcome = Readonly<{
  evaluated: boolean;
  hardFailed: boolean;
  softFailed: boolean;
}>;

function timestampsWithStatus(
  timestamps: Readonly<Record<string, string>> | null,
  status: string,
): Record<string, string> {
  return {
    ...(timestamps ?? {}),
    [`${status.replace(/_/g, "-")}-at`]: new Date().toISOString(),
  };
}

function notifyRunStatus(runId: string, status: string): void {
  const trigger =
    status === "planning"
      ? "run:planning"
      : status === "applying"
        ? "run:applying"
        : status === "applied" || status === "planned_and_finished"
          ? "run:completed"
          : status === "errored"
            ? "run:errored"
            : ["planned", "planned_and_saved", "policy_soft_failed"].includes(status)
              ? "run:needs_attention"
              : undefined;
  if (trigger !== undefined) queueRunNotification(runId, trigger, status);
  void reportRunVcsStatus(runId, status);
}

async function getAgentPolicyEvaluation(
  snapshot: DeepReadonly<WorkspacePolicySnapshot>,
  nativeVerified = false,
): Promise<AgentPolicyEvaluation | null> {
  const effectiveSets = snapshot.sets;
  const unsupportedSets = effectiveSets.filter(
    (set) => !(nativeVerified && set.kind === "tfpolicy") && (set.kind !== "sentinel" || !set.agentEnabled),
  );
  const effectivePolicies = snapshot.policies;
  const parameters = snapshot.parameters;
  const policySetsWithPolicies: AgentPolicyEvaluation["policySets"][number][] = [];
  for (const policySet of effectiveSets) {
    if (policySet.kind !== "sentinel" || !policySet.agentEnabled) continue;
    const setPolicies = effectivePolicies
      .filter((policy): boolean => policy.policySetId === policySet.id)
      .map(
        (policy): AgentPolicy => ({
          id: policy.id,
          name: policy.name,
          description: policy.description,
          enforcementLevel: policy.enforcementLevel,
          query: policy.query,
          source: policy.source,
        }),
      );
    if (setPolicies.length === 0) continue;
    // Sensitive parameters are stored encrypted (issue #577): resolve the
    // plaintext for the agent payload, which the agent passes to the engine.
    const setParameters = parameters.filter((parameter): boolean => parameter.policySetId === policySet.id);
    const decryptedParameters = await Promise.all(
      setParameters.map(
        async (parameter): Promise<AgentPolicyParameter> => ({
          key: parameter.key,
          value: await variableValueForRead(parameter),
          sensitive: parameter.sensitive === true,
          hcl: parameter.hcl === true,
        }),
      ),
    );
    policySetsWithPolicies.push({
      id: policySet.id,
      name: policySet.name,
      description: policySet.description,
      kind: policySet.kind,
      policyToolVersion: policySet.policyToolVersion ?? "latest",
      overridable: policySet.overridable === true,
      policies: setPolicies,
      parameters: decryptedParameters,
    });
  }
  return policySetsWithPolicies.length === 0 && unsupportedSets.length === 0
    ? null
    : { policySets: policySetsWithPolicies, unsupportedSets };
}

function validatedAgentPolicyResult(
  rawCheck: Readonly<Record<string, unknown>>,
): Readonly<{ status: string; result: Record<string, unknown> }> {
  const status = rawCheck["status"];
  const result = rawCheck["result"];
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return { status: "errored", result: { error: "Malformed agent policy result" } };
  const values = result as Record<string, unknown>;
  if (status === "errored" || status === "unreachable") return { status, result: values };
  if (
    (status !== "passed" && status !== "failed") ||
    values["passed"] !== (status === "passed") ||
    values["error"] != null ||
    values["errors"] != null ||
    values["skipped"] === true
  ) {
    return {
      status: "errored",
      result: { ...values, error: "Agent policy decision is missing, malformed or contradicts its status" },
    };
  }
  return { status, result: values };
}

function agentPolicyResults(
  result: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, Readonly<{ status: string; result: Record<string, unknown> }>> {
  const rawChecks = result["policy-checks"];
  if (!Array.isArray(rawChecks)) return new Map();
  const reported = new Map<string, Readonly<{ status: string; result: Record<string, unknown> }>>();
  const seen = new Set<string>();
  for (const rawCheck of rawChecks) {
    if (typeof rawCheck !== "object" || rawCheck === null || Array.isArray(rawCheck)) continue;
    const check = rawCheck as Record<string, unknown>;
    const policyId = check["policy-id"];
    if (typeof policyId !== "string") continue;
    // Poison duplicates before parsing: an invalid first report must not be
    // replaced with a later apparently valid result for the same policy.
    if (seen.has(policyId)) {
      reported.delete(policyId);
      continue;
    }
    seen.add(policyId);
    reported.set(policyId, validatedAgentPolicyResult(check));
  }
  return reported;
}

function agentPolicyCheckVerdict(
  policy: Readonly<{ enforcementLevel: string }>,
  policySet: Readonly<{ kind: string; overridable: boolean }>,
  status: string,
): Readonly<{ hardFailed: boolean; softFailed: boolean; status: string }> {
  if (status === "passed" || (status === "failed" && policy.enforcementLevel === "advisory"))
    return { hardFailed: false, softFailed: false, status };
  const softFailed = status === "failed" && policyFailureIsOverridable(policy, policySet);
  return { hardFailed: !softFailed, softFailed, status: softFailed ? "soft_failed" : status };
}

async function recordUnsupportedAgentPolicies(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  runId: string,
  evaluationId: string,
  unsupportedSets: AgentPolicyEvaluation["unsupportedSets"],
  now: number,
): Promise<void> {
  for (const policySet of unsupportedSets) {
    await database.insert(policyChecks).values({
      id: newResourceId("pchk"),
      runId,
      policySetId: policySet.id,
      status: "unreachable",
      result: {
        error: `Policy set '${policySet.kind}' execution is not supported by this agent configuration; refusing to apply`,
        policyEvaluationId: evaluationId,
      },
      createdAt: now,
    });
  }
}

async function recordNativeAgentPolicies(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  runId: string,
  checkpointId: string,
  fingerprint: string,
  native?: DeepReadonly<NativeCandidate>,
): Promise<AgentPolicyVerdict | null> {
  if (native === undefined) return { hardFailed: false, softFailed: false };
  if (native.context.evaluation.id !== checkpointId || native.context.evaluation.snapshot.fingerprint !== fingerprint)
    return null;
  await persistNativeAgentPlan(database, native);
  return nativePolicyVerdict(database, runId, native.context.evaluation);
}

async function finishAgentPolicyEvaluation(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  workspace: Workspace,
  checkpointId: string,
  fingerprint: string,
  verdict: AgentPolicyVerdict,
): Promise<AgentPolicyOutcome> {
  const unchanged = await completeWorkspacePolicyEvaluation(database, workspace, { id: checkpointId, fingerprint });
  return { evaluated: true, hardFailed: !unchanged || verdict.hardFailed, softFailed: verdict.softFailed };
}

async function recordAgentPolicyChecks(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  workspace: Workspace,
  runId: string,
  result: Readonly<Record<string, unknown>>,
  now: number,
  native?: DeepReadonly<NativeCandidate>,
): Promise<AgentPolicyOutcome> {
  const checkpoint = await latestWorkspacePolicyEvaluation(database, runId);
  const snapshot = await loadWorkspacePolicySnapshot(database, workspace);
  if (checkpoint?.result?.["fingerprint"] !== snapshot.fingerprint) {
    return { evaluated: true, hardFailed: true, softFailed: false };
  }
  const nativeOutcome = await recordNativeAgentPolicies(database, runId, checkpoint.id, snapshot.fingerprint, native);
  if (nativeOutcome === null) return { evaluated: true, hardFailed: true, softFailed: false };
  const evaluation = await getAgentPolicyEvaluation(snapshot, native !== undefined);
  if (evaluation === null)
    return finishAgentPolicyEvaluation(database, workspace, checkpoint.id, snapshot.fingerprint, nativeOutcome);

  if (evaluation.unsupportedSets.length > 0) {
    await recordUnsupportedAgentPolicies(database, runId, checkpoint.id, evaluation.unsupportedSets, now);
    return { evaluated: true, hardFailed: true, softFailed: false };
  }

  const reported = agentPolicyResults(result);
  let hardFailed = nativeOutcome.hardFailed;
  let softFailed = nativeOutcome.softFailed;
  for (const policySet of evaluation.policySets) {
    for (const policy of policySet.policies) {
      const outcome = reported.get(policy.id);
      const checkStatus = outcome?.status ?? "errored";
      const verdict = agentPolicyCheckVerdict(policy, policySet, checkStatus);
      await database.insert(policyChecks).values({
        id: newResourceId("pchk"),
        runId,
        policyId: policy.id,
        policySetId: policySet.id,
        status: verdict.status,
        result: {
          ...(outcome?.result ?? { error: "Agent did not return a policy outcome" }),
          policyEvaluationId: checkpoint.id,
        },
        createdAt: now,
      });
      hardFailed = hardFailed || verdict.hardFailed;
      softFailed = softFailed || verdict.softFailed;
    }
  }
  return finishAgentPolicyEvaluation(database, workspace, checkpoint.id, snapshot.fingerprint, {
    hardFailed,
    softFailed,
  });
}

type StaleAgentRecoveryHook = (
  facts: Readonly<{
    jobId: string;
    runId: string;
    phase: string;
    jobStatus: string | null;
    runStatus: string | null;
  }>,
) => void | Promise<void>;

class StaleAgentRecoveryRaceError extends Error {
  constructor() {
    super("Stale-agent recovery raced another job mutation");
    this.name = "StaleAgentRecoveryRaceError";
  }
}

type RecoveredStaleAgentJob = Readonly<{ jobId: string; runId: string; runStatus: string; job: AgentJob }>;

function isPostgresRecoveryRace(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "40P01" || code === "40001";
}

function isNativeApply(job: AgentJob): boolean {
  return job.phase === "apply" && typeof job.result?.["nativePolicyEvaluationId"] === "string";
}

function nativeApplyWasAdmitted(job: AgentJob): boolean {
  return isNativeApply(job) && job.result?.["policyApplyAdmissionToken"] === job.fencingToken;
}

/** The marker commits before any runnable payload leaves the server. Its
 * presence means possible delivery, even if the HTTP response was lost.
 * Older leases without tracking remain ambiguous and must stay protected. */
function nativeApplyWasNotDelivered(job: AgentJob): boolean {
  return (
    isNativeApply(job) &&
    job.result?.["payloadDeliveryTrackingToken"] === job.fencingToken &&
    job.result["nativeRecoveryRequired"] !== true &&
    job.result["payloadDeliveryToken"] !== job.fencingToken
  );
}

function nativeApplyNeedsRecovery(job: AgentJob): boolean {
  return isNativeApply(job) && job.result?.["nativeStateRecovered"] !== true && !nativeApplyWasNotDelivered(job);
}

async function holdNativeApplyForRecovery(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  job: AgentJob,
  run: AgentRunRow | undefined,
  reason: string,
): Promise<string | null> {
  const canceled = run?.status === "canceled" || run?.status === "force_canceled";
  const runStatus = canceled ? run.status : "errored";
  const held = await database
    .update(agentJobs)
    .set({
      status: canceled ? "canceled" : "errored",
      completedAt: Date.now(),
      errorMessage: reason,
      result: { ...job.result, nativeRecoveryRequired: true },
    })
    .where(and(eq(agentJobs.id, job.id), eq(agentJobs.fencingToken, job.fencingToken), eq(agentJobs.status, "claimed")))
    .returning({ id: agentJobs.id });
  if (held.length === 0) return null;
  if (run !== undefined && !canceled)
    await database
      .update(runs)
      .set({ status: "errored", statusTimestamps: timestampsWithStatus(run.statusTimestamps, "errored") })
      .where(and(eq(runs.id, run.id), inArray(runs.status, ["applying", "apply_queued"])));
  return runStatus;
}

function agentPhaseRunStatuses(phase: string): readonly [string, string] {
  return phase === "plan" ? ["planning", "plan_queued"] : ["applying", "apply_queued"];
}

async function recoverOneStaleAgentJob(
  snapshot: AgentJob,
  now: number,
  afterRunQueued: StaleAgentRecoveryHook | undefined,
): Promise<RecoveredStaleAgentJob | null> {
  const owner = snapshot.agentId === null ? isNull(agentJobs.agentId) : eq(agentJobs.agentId, snapshot.agentId);

  return db.transaction(async (transaction): Promise<RecoveredStaleAgentJob | null> => {
    const database = transaction as unknown as Database;
    // Match completion's lock order (job -> run) without making the job
    // claimable. This prevents PostgreSQL deadlocks while preserving the
    // run-first visible state transition that closes the failover race.
    const lockedJobs = await database
      .update(agentJobs)
      .set({ agentId: snapshot.agentId })
      .where(
        and(
          eq(agentJobs.id, snapshot.id),
          eq(agentJobs.status, "claimed"),
          eq(agentJobs.fencingToken, snapshot.fencingToken),
          owner,
        ),
      )
      .returning();
    const job = lockedJobs[0];
    if (job === undefined) return null;
    // Admission may have committed after the sweep read its candidate list.
    // Decide recovery from the locked lease, never from that earlier snapshot.
    const [expectedRunStatus, queuedRunStatus] = agentPhaseRunStatuses(job.phase);

    const run = await database.query.runs.findFirst({ where: eq(runs.id, job.runId) });
    if (run === undefined) {
      await database
        .update(agentJobs)
        .set({ status: "canceled", completedAt: now, errorMessage: "Run is no longer waiting for this job" })
        .where(and(eq(agentJobs.id, job.id), eq(agentJobs.status, "claimed"), owner));
      return null;
    }

    if (isNativeApply(job)) {
      const runStatus = await failAgentJobDeliveryInTransaction(database, job, run, "Native agent lease expired");
      await database.update(runTokens).set({ revokedAt: now }).where(eq(runTokens.runId, job.runId));
      return runStatus === null ? null : { jobId: job.id, runId: job.runId, runStatus, job };
    }
    if (run.status === expectedRunStatus) {
      const updatedRuns = await database
        .update(runs)
        .set({
          agentId: null,
          status: queuedRunStatus,
          statusTimestamps: timestampsWithStatus(run.statusTimestamps, queuedRunStatus),
        })
        .where(and(eq(runs.id, job.runId), eq(runs.status, expectedRunStatus)))
        .returning({ id: runs.id });
      if (updatedRuns.length === 0) return null;
    } else if (run.status === queuedRunStatus) {
      // Repair an interrupted recovery from an older process/version: the run
      // was queued but the stale job never became claimable.
      await database.update(runs).set({ agentId: null }).where(eq(runs.id, run.id));
    } else {
      await database
        .update(agentJobs)
        .set({ status: "canceled", completedAt: now, errorMessage: "Run is no longer waiting for this job" })
        .where(and(eq(agentJobs.id, job.id), eq(agentJobs.status, "claimed"), owner));
      return null;
    }

    if (afterRunQueued !== undefined) {
      const [observedJob, observedRun] = await Promise.all([
        database.query.agentJobs.findFirst({ where: eq(agentJobs.id, job.id), columns: { status: true } }),
        database.query.runs.findFirst({ where: eq(runs.id, job.runId), columns: { status: true } }),
      ]);
      await afterRunQueued({
        jobId: job.id,
        runId: job.runId,
        phase: job.phase,
        jobStatus: observedJob?.status ?? null,
        runStatus: observedRun?.status ?? null,
      });
    }

    const updatedJobs = await database
      .update(agentJobs)
      .set({
        agentId: null,
        status: "queued",
        claimedAt: null,
        completedAt: null,
        errorMessage: null,
        fencingToken: sql`${agentJobs.fencingToken} + 1`,
      })
      .where(and(eq(agentJobs.id, job.id), eq(agentJobs.status, "claimed"), owner))
      .returning({ id: agentJobs.id });
    if (updatedJobs.length === 0) throw new StaleAgentRecoveryRaceError();

    if (job.phase === "apply") {
      await database
        .update(workspaces)
        .set({ locked: false, lockedReason: null, lockOwnerType: null, lockOwnerId: null })
        .where(
          and(
            eq(workspaces.id, run.workspaceId),
            eq(workspaces.locked, true),
            eq(workspaces.lockOwnerType, "agent-run"),
            eq(workspaces.lockOwnerId, run.id),
          ),
        );
    }
    return { jobId: job.id, runId: job.runId, runStatus: queuedRunStatus, job };
  });
}

export async function recoverStaleAgentJobs(
  now = Date.now(),
  afterRunQueued?: StaleAgentRecoveryHook,
): Promise<string[]> {
  const timeout = configuredHeartbeatTimeoutMs();
  const cutoff = now - timeout;
  const unavailableAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(or(lt(agents.lastPingAt, cutoff), inArray(agents.status, ["unknown", "exited", "errored"])));
  const unavailableAgentIds = unavailableAgents.map((agent): string => agent.id);

  if (unavailableAgentIds.length > 0) {
    await db
      .update(agents)
      .set({ status: "unknown" })
      .where(
        and(
          inArray(agents.id, unavailableAgentIds),
          inArray(agents.status, ["idle", "busy"]),
          lt(agents.lastPingAt, cutoff),
        ),
      );
  }

  const unavailableClaim =
    unavailableAgentIds.length === 0
      ? isNull(agentJobs.agentId)
      : or(isNull(agentJobs.agentId), inArray(agentJobs.agentId, unavailableAgentIds));
  const staleJobs = await db.query.agentJobs.findMany({
    where: and(eq(agentJobs.status, "claimed"), unavailableClaim),
    orderBy: [asc(agentJobs.claimedAt)],
    limit: 100,
  });
  const recoveredJobs: RecoveredStaleAgentJob[] = [];

  for (const job of staleJobs) {
    try {
      const recovered = await recoverOneStaleAgentJob(job, now, afterRunQueued);
      if (recovered !== null) {
        recoveredJobs.push(recovered);
        const lease = recovered.job;
        if (typeof lease.result?.["nativePolicyEvaluationId"] === "string")
          await revokeNativeAgentLease(lease.runId, lease.result["nativePolicyEvaluationId"], lease);
      }
    } catch (error: unknown) {
      if (error instanceof StaleAgentRecoveryRaceError || isPostgresRecoveryRace(error)) continue;
      throw error;
    }
  }

  for (const item of recoveredJobs) void reportRunVcsStatus(item.runId, item.runStatus);
  await releaseCanceledRunLocks(now);
  return recoveredJobs.map((item): string => item.jobId);
}

/** Whether any of these agents is still heartbeating (issue #617): fresh
 * ping and not in a dead-ish status, mirroring the sweep's unavailability
 * definition. */
async function hasLiveAgent(agentIds: readonly string[], cutoff: number): Promise<boolean> {
  if (agentIds.length === 0) return false;
  const live = await db.query.agents.findFirst({
    where: and(
      inArray(agents.id, [...agentIds]),
      gt(agents.lastPingAt, cutoff),
      notInArray(agents.status, ["unknown", "exited", "errored"]),
    ),
    columns: { id: true },
  });
  return live !== undefined;
}

/** Lease-expiry backstop for locks held after cancel (issue #617): when a
 * canceled/force-canceled run has no active jobs left and none of its
 * canceled-out jobs can still have a live agent behind them, no remote apply
 * can be running — release the run-owned lock. Holds while any agent is
 * still heartbeating; a truly wedged agent is the operator's force-unlock. */
async function releaseCanceledRunLocks(now = Date.now()): Promise<void> {
  const cutoff = now - configuredHeartbeatTimeoutMs();
  const heldLocks = await db.query.workspaces.findMany({
    where: and(eq(workspaces.locked, true), eq(workspaces.lockOwnerType, "agent-run")),
    columns: { id: true, lockOwnerId: true },
    limit: 100,
  });
  for (const held of heldLocks) {
    if (held.lockOwnerId === null) continue;
    const run = await db.query.runs.findFirst({
      where: eq(runs.id, held.lockOwnerId),
      columns: { id: true, status: true, workspaceId: true },
    });
    if (run === undefined || run.workspaceId !== held.id) continue;
    if (run.status !== "canceled" && run.status !== "force_canceled") continue;
    const activeJob = await db.query.agentJobs.findFirst({
      where: and(eq(agentJobs.runId, run.id), inArray(agentJobs.status, ["queued", "claimed"])),
      columns: { id: true },
    });
    // Active jobs are the main sweep's business (or a mid-cancel window).
    if (activeJob !== undefined) continue;
    const outstanding = await db.query.agentJobs.findMany({
      where: and(eq(agentJobs.runId, run.id), inArray(agentJobs.status, ["canceled", "errored"])),
    });
    if (outstanding.some(nativeApplyNeedsRecovery)) continue;
    const agentIds = [
      ...new Set(
        outstanding
          .filter((job) => !nativeApplyWasNotDelivered(job))
          .map((job): string | null => job.agentId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (await hasLiveAgent(agentIds, cutoff)) continue;
    await db
      .update(workspaces)
      .set({ locked: false, lockedReason: null, lockOwnerType: null, lockOwnerId: null })
      .where(
        and(
          eq(workspaces.id, held.id),
          eq(workspaces.locked, true),
          eq(workspaces.lockOwnerType, "agent-run"),
          eq(workspaces.lockOwnerId, run.id),
        ),
      );
  }
}

/** Whether a run-owned workspace lock is held by a live run (issue #617):
 * manual locks are never live-run locks. A non-terminal owner run (note:
 * "canceled" is non-terminal in this model) is live. A terminal owner run
 * (e.g. force_canceled after a hold) is live only while a canceled-out job
 * may still have a heartbeating agent behind it. Orphaned locks (owner run
 * gone) and fully terminal local locks are not live. */
export async function isLiveRunLock(
  workspace: Readonly<{ lockOwnerType?: string | null; lockOwnerId?: string | null }>,
): Promise<boolean> {
  const { lockOwnerType, lockOwnerId } = workspace;
  if ((lockOwnerType !== "run" && lockOwnerType !== "agent-run") || lockOwnerId === null || lockOwnerId === undefined) {
    return false;
  }
  const run = await db.query.runs.findFirst({ where: eq(runs.id, lockOwnerId), columns: { status: true } });
  if (run === undefined) return false;
  if (!isTerminalRunStatus(run.status)) return true;
  if (lockOwnerType !== "agent-run") return false;
  const recovery = await db.query.agentJobs.findMany({
    where: and(eq(agentJobs.runId, lockOwnerId), eq(agentJobs.status, "errored")),
  });
  if (recovery.some((job) => job.result?.["nativeRecoveryRequired"] === true)) return true;
  const outstanding = await db.query.agentJobs.findMany({
    where: and(eq(agentJobs.runId, lockOwnerId), eq(agentJobs.status, "canceled")),
  });
  if (outstanding.some(nativeApplyNeedsRecovery)) return true;
  const agentIds = [
    ...new Set(
      outstanding
        .filter((job) => !nativeApplyWasNotDelivered(job))
        .map((job): string | null => job.agentId)
        .filter((id): id is string => id !== null),
    ),
  ];
  return hasLiveAgent(agentIds, Date.now() - configuredHeartbeatTimeoutMs());
}

export async function authenticateAgent(agentId: string, authorization: string | null): Promise<Agent | undefined> {
  if (authorization?.startsWith("Bearer agent-") !== true) return undefined;
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (agent === undefined) return undefined;
  const [tokenHash, legacyTokenHash] = tokenHashCandidates(authorization.slice(7));
  const tokenRows = await db.query.agentPoolTokens.findMany({
    where: and(
      eq(agentPoolTokens.agentPoolId, agent.agentPoolId),
      inArray(agentPoolTokens.token, [tokenHash, legacyTokenHash]),
    ),
    limit: 2,
  });
  const token = tokenRows.find((candidate) => candidate.token === tokenHash) ?? tokenRows[0];
  if (token === undefined) return undefined;
  const now = Date.now();
  if (!isAgentPoolTokenActive(token, now)) return undefined;
  if (token.token === legacyTokenHash) {
    await db.update(agentPoolTokens).set({ token: tokenHash }).where(eq(agentPoolTokens.id, token.id));
  }
  if (token.lastUsedAt === null || now - token.lastUsedAt >= AGENT_TOKEN_LAST_USED_INTERVAL_MS) {
    await db.update(agentPoolTokens).set({ lastUsedAt: now }).where(eq(agentPoolTokens.id, token.id));
  }
  let refreshedAgent: Agent | undefined;
  // Persist the liveness heartbeat at most once per interval; within the
  // window the agent is kept fresh in memory only. Status transitions out
  // of "unknown" always persist so a recovered agent is visible promptly.
  if (
    agent.lastPingAt === null ||
    now - agent.lastPingAt >= effectivePingWriteIntervalMs() ||
    agent.status === "unknown"
  ) {
    const rows = await db
      .update(agents)
      .set({
        lastPingAt: now,
        status: sql<string>`CASE WHEN ${agents.status} = 'unknown' THEN 'idle' ELSE ${agents.status} END`,
      })
      .where(eq(agents.id, agent.id))
      .returning();
    refreshedAgent = rows[0];
  }
  return refreshedAgent ?? { ...agent, lastPingAt: now };
}

function agentApplyIsAssociated(
  job: AgentJob,
  run: Readonly<Pick<typeof runs.$inferSelect, "status" | "agentId">> | undefined,
  workspace: Readonly<Pick<typeof workspaces.$inferSelect, "locked" | "lockOwnerType" | "lockOwnerId">> | undefined,
): boolean {
  return (
    run?.status === "applying" &&
    run.agentId === job.agentId &&
    workspace?.locked === true &&
    workspace.lockOwnerType === "agent-run" &&
    workspace.lockOwnerId === job.runId
  );
}

async function jobSupportsNativePolicy(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  job: AgentJob,
): Promise<boolean> {
  if (job.agentId === null) return false;
  const agent = await database.query.agents.findFirst({ where: eq(agents.id, job.agentId) });
  return agent !== undefined && agentSupportsCapability(agent, NATIVE_AGENT_CAPABILITY);
}

async function agentDeliveryPolicyError(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  job: AgentJob,
  run: DeepReadonly<typeof runs.$inferSelect> | undefined,
  workspace: Workspace | undefined,
): Promise<string | null> {
  if (job.phase === "plan") {
    if (
      workspace === undefined ||
      run?.status !== "planning" ||
      run.agentId !== job.agentId ||
      run.workspaceId !== workspace.id
    )
      return "Plan blocked: agent claim is not associated with an active run and its workspace";
    return workspacePolicyPlanningError(database, workspace, await jobSupportsNativePolicy(database, job));
  }
  if (workspace === undefined || !agentApplyIsAssociated(job, run, workspace))
    return "Apply blocked: agent claim is not associated with an active run and its workspace lock";
  return agentApplyPolicyError(database, workspace, job.runId, await jobSupportsNativePolicy(database, job));
}

async function agentApplyPolicyError(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  workspace: Workspace,
  runId: string,
  nativeSupported = false,
): Promise<string | null> {
  // Hosted admission never grants a legacy agent a native execution capability.
  return (
    (await workspacePolicyPlanningError(database, workspace, nativeSupported)) ??
    workspacePolicyExecutionError(database, workspace, runId)
  );
}

/** Apply admission is persisted before returning credentials/artifacts. A retry
 * after admission must not revoke a potentially running remote apply or release
 * its lock. Plan delivery rechecks unsupported runtimes on every handoff. */
async function admitAgentJobDelivery(job: AgentJob, workspace: Workspace): Promise<boolean> {
  const accepted = await db.transaction(async (transaction) => {
    const database = transaction as unknown as Database;
    const rows = await database
      .update(agentJobs)
      .set({ status: "claimed" })
      .where(
        and(
          eq(agentJobs.id, job.id),
          eq(agentJobs.status, "claimed"),
          eq(agentJobs.fencingToken, job.fencingToken),
          job.agentId === null ? isNull(agentJobs.agentId) : eq(agentJobs.agentId, job.agentId),
        ),
      )
      .returning();
    const owned = rows[0];
    if (owned === undefined) return null;
    if (job.phase === "apply" && owned.result?.["policyApplyAdmissionToken"] === job.fencingToken) return true;
    const run = await database.query.runs.findFirst({ where: eq(runs.id, job.runId) });
    const currentWorkspace = await database.query.workspaces.findFirst({ where: eq(workspaces.id, workspace.id) });
    const error = await agentDeliveryPolicyError(database, owned, run, currentWorkspace);
    if (error === null) {
      if (job.phase === "apply")
        await database
          .update(agentJobs)
          .set({ result: { ...owned.result, policyApplyAdmissionToken: job.fencingToken } })
          .where(eq(agentJobs.id, job.id));
      return true;
    }
    await database
      .update(agentJobs)
      .set({ status: "errored", errorMessage: error, completedAt: Date.now() })
      .where(eq(agentJobs.id, job.id));
    let rejectedRun = false;
    if (run !== undefined) {
      const rejected = await database
        .update(runs)
        .set({ status: "errored", statusTimestamps: timestampsWithStatus(run.statusTimestamps, "errored") })
        .where(
          and(
            eq(runs.id, run.id),
            inArray(runs.status, job.phase === "plan" ? ["plan_queued", "planning"] : ["apply_queued", "applying"]),
          ),
        )
        .returning({ id: runs.id });
      rejectedRun = rejected.length > 0;
      if (job.phase === "apply") await releaseApplyWorkspaceLock(database, owned, run);
    }
    if (job.agentId !== null) {
      const remaining = await database.query.agentJobs.findFirst({
        where: and(eq(agentJobs.agentId, job.agentId), eq(agentJobs.status, "claimed")),
      });
      if (remaining === undefined)
        await database.update(agents).set({ status: "idle" }).where(eq(agents.id, job.agentId));
    }
    return rejectedRun ? false : null;
  });
  if (accepted === false) notifyRunStatus(job.runId, "errored");
  return accepted === true;
}

async function agentDispatchPolicyEvaluation(
  job: AgentJob,
  run: DeepReadonly<typeof runs.$inferSelect>,
  workspace: Workspace,
): Promise<
  Readonly<{ evaluation: AgentPolicyEvaluation | null; nativeEvaluation: WorkspacePolicyEvaluation }> | undefined
> {
  const dispatchKey = `${job.id}:${job.fencingToken}`;
  const previous = await latestWorkspacePolicyEvaluation(db, run.id);
  const evaluation =
    previous?.result?.["dispatchKey"] === dispatchKey
      ? { id: previous.id, snapshot: await loadWorkspacePolicySnapshot(db, workspace) }
      : await captureWorkspacePolicyEvaluation(db, workspace, run.id, dispatchKey);
  if (
    previous?.result?.["dispatchKey"] === dispatchKey &&
    previous.result["fingerprint"] !== evaluation.snapshot.fingerprint
  ) {
    await failAgentJobDelivery(job, "Policies changed after agent dispatch; create a new plan");
    return undefined;
  }
  return {
    evaluation: await getAgentPolicyEvaluation(evaluation.snapshot, await jobSupportsNativePolicy(db, job)),
    nativeEvaluation: evaluation,
  };
}

function rejectNativePolicyDowngrade(job: AgentJob): void {
  if (typeof job.result?.["nativePolicyEvaluationId"] === "string")
    throw new Error("Native policy configuration changed after agent dispatch; create a new plan");
}

async function prepareAgentNativePolicy(
  job: AgentJob,
  run: DeepReadonly<typeof runs.$inferSelect>,
  workspace: Workspace,
  evaluation?: DeepReadonly<WorkspacePolicyEvaluation>,
): Promise<NativeRun | null> {
  const snapshot = evaluation?.snapshot ?? (await loadWorkspacePolicySnapshot(db, workspace));
  if (!snapshot.sets.some((set) => set.kind === "tfpolicy")) {
    rejectNativePolicyDowngrade(job);
    return null;
  }
  if (!(await jobSupportsNativePolicy(db, job))) throw new Error("Agent did not negotiate native policy execution");
  const checkpoint = evaluation ?? (await latestWorkspacePolicyEvaluation(db, run.id));
  if (
    checkpoint === undefined ||
    ("result" in checkpoint && checkpoint.result?.["fingerprint"] !== snapshot.fingerprint)
  )
    throw new Error("Native agent evaluation is missing or stale");
  const organization = await db.query.organizations.findFirst({ where: eq(organizations.id, workspace.orgId) });
  if (organization === undefined) throw new Error("Native agent organization disappeared");
  return prepareNativeRun(
    { id: checkpoint.id, snapshot },
    run.id,
    workspace,
    organization.name,
    job.iacBinary,
    run.terraformVersion ?? workspace.terraformVersion ?? organization.defaultTerraformVersion ?? "latest",
    false,
  );
}

/** The caller must hold the current lease's row lock. */
export async function failAgentJobDeliveryInTransaction(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  job: AgentJob,
  run: AgentRunRow | undefined,
  reason: string,
): Promise<string | null> {
  if (nativeApplyNeedsRecovery(job))
    return holdNativeApplyForRecovery(database, job, run, `${reason}; state recovery is required`);
  const canceled = run?.status === "canceled" || run?.status === "force_canceled";
  await database
    .update(agentJobs)
    .set({ status: canceled ? "canceled" : "errored", completedAt: Date.now(), errorMessage: reason })
    .where(eq(agentJobs.id, job.id));
  if (run !== undefined) {
    await database
      .update(runs)
      .set({ status: "errored", statusTimestamps: timestampsWithStatus(run.statusTimestamps, "errored") })
      .where(and(eq(runs.id, run.id), inArray(runs.status, ["plan_queued", "planning", "apply_queued", "applying"])));
    await releaseApplyWorkspaceLock(database, job, run);
  }
  return canceled ? run.status : "errored";
}

/** Terminalize an undelivered job; preserve state recovery after a possible native apply handoff. */
export async function failAgentJobDelivery(job: AgentJob, reason: string): Promise<void> {
  const runStatus = await db.transaction(async (transaction): Promise<string | null> => {
    const database = transaction as unknown as Database;
    const rows = await database
      .update(agentJobs)
      .set({ status: "claimed" })
      .where(
        and(
          eq(agentJobs.id, job.id),
          eq(agentJobs.status, "claimed"),
          eq(agentJobs.fencingToken, job.fencingToken),
          job.agentId === null ? isNull(agentJobs.agentId) : eq(agentJobs.agentId, job.agentId),
        ),
      )
      .returning();
    const owned = rows[0];
    if (owned === undefined) return null;
    const run = await database.query.runs.findFirst({ where: eq(runs.id, job.runId) });
    const status = await failAgentJobDeliveryInTransaction(database, owned, run, reason);
    await database.update(runTokens).set({ revokedAt: Date.now() }).where(eq(runTokens.runId, job.runId));
    if (job.agentId !== null) await database.update(agents).set({ status: "idle" }).where(eq(agents.id, job.agentId));
    return status;
  });
  if (runStatus !== null) notifyRunStatus(job.runId, runStatus);
}

/** Persist the fence before returning any runnable payload. An uncertain HTTP delivery stays protected. */
export async function markAgentJobPayloadDelivered(job: AgentJob, nativePolicy: boolean): Promise<void> {
  await db.transaction(async (transaction) => {
    const database = transaction as unknown as Database;
    const rows = await database
      .update(agentJobs)
      .set({ status: "claimed" })
      .where(
        and(
          eq(agentJobs.id, job.id),
          eq(agentJobs.status, "claimed"),
          eq(agentJobs.fencingToken, job.fencingToken),
          job.agentId === null ? isNull(agentJobs.agentId) : eq(agentJobs.agentId, job.agentId),
        ),
      )
      .returning();
    const owned = rows[0];
    if (owned === undefined) throw new Error("Agent lease changed before payload delivery");
    if (nativePolicy !== (typeof owned.result?.["nativePolicyEvaluationId"] === "string"))
      throw new Error("Agent native execution mode changed before payload delivery");
    await database
      .update(agentJobs)
      .set({ result: { ...owned.result, payloadDeliveryToken: job.fencingToken } })
      .where(eq(agentJobs.id, job.id));
  });
}

async function prepareClaimedNativePolicy(
  job: AgentJob,
  run: DeepReadonly<typeof runs.$inferSelect>,
  workspace: Workspace,
  evaluation?: DeepReadonly<WorkspacePolicyEvaluation>,
): Promise<NativeRun | null | undefined> {
  let nativePolicy: NativeRun | null;
  try {
    nativePolicy = await prepareAgentNativePolicy(job, run, workspace, evaluation);
  } catch (error: unknown) {
    await failAgentJobDelivery(
      job,
      `Native policy preparation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  if (nativePolicy !== null) {
    const evaluationId = nativePolicy.evaluation.id;
    const recorded = await db.transaction(async (transaction): Promise<boolean> => {
      const database = transaction as unknown as Database;
      const rows = await database
        .update(agentJobs)
        .set({ status: "claimed" })
        .where(
          and(
            eq(agentJobs.id, job.id),
            eq(agentJobs.fencingToken, job.fencingToken),
            eq(agentJobs.status, "claimed"),
            job.agentId === null ? isNull(agentJobs.agentId) : eq(agentJobs.agentId, job.agentId),
          ),
        )
        .returning();
      const current = rows[0];
      if (current === undefined) return false;
      // A concurrent handoff may already have recorded possible delivery.
      // Merge under the same lease lock so preparation cannot erase that fence.
      await database
        .update(agentJobs)
        .set({ result: { ...current.result, nativePolicyEvaluationId: evaluationId } })
        .where(eq(agentJobs.id, job.id));
      return true;
    });
    if (!recorded) return undefined;
  }
  return nativePolicy;
}

async function claimedJobDetails(job: AgentJob): Promise<ClaimedAgentJob | undefined> {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, job.runId) });
  if (run === undefined || !(await runConfigurationTrusted(run))) return undefined;
  const [workspace, configuration, inputState, planJob] = await Promise.all([
    db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) }),
    run.configurationVersionId === null
      ? Promise.resolve(undefined)
      : db.query.configurationVersions.findFirst({
          where: eq(configurationVersions.id, run.configurationVersionId),
        }),
    db.query.stateVersions.findFirst({
      where: and(
        eq(stateVersions.workspaceId, run.workspaceId),
        eq(stateVersions.status, "finalized"),
        eq(stateVersions.intermediate, false),
      ),
      orderBy: [desc(stateVersions.serial)],
    }),
    job.phase === "apply"
      ? db.query.agentJobs.findFirst({
          where: and(eq(agentJobs.runId, run.id), eq(agentJobs.phase, "plan")),
        })
      : Promise.resolve(undefined),
  ]);
  if (workspace === undefined) return undefined;
  if (!(await admitAgentJobDelivery(job, workspace))) return undefined;
  const dispatch =
    job.phase === "plan"
      ? await agentDispatchPolicyEvaluation(job, run, workspace)
      : { evaluation: null, nativeEvaluation: undefined };
  if (dispatch === undefined) return undefined;
  const policyEvaluation = dispatch.evaluation;
  const nativePolicy = await prepareClaimedNativePolicy(job, run, workspace, dispatch.nativeEvaluation);
  if (nativePolicy === undefined) return undefined;
  return {
    job,
    run,
    workspace,
    configuration: configuration ?? null,
    inputState: inputState ?? null,
    planResult: planJob?.result ?? null,
    policyEvaluation,
    nativePolicy,
  };
}

async function findExistingClaim(agent: Agent): Promise<ClaimedAgentJob | undefined> {
  const existing = await db.query.agentJobs.findFirst({
    where: and(eq(agentJobs.agentId, agent.id), eq(agentJobs.status, "claimed")),
    orderBy: [asc(agentJobs.claimedAt)],
  });
  if (existing === undefined) return undefined;
  return claimedJobDetails(existing);
}

function resolveAgentBinaries(agent: Agent): readonly string[] {
  return agent.iacBinaries !== null && agent.iacBinaries.length > 0 ? agent.iacBinaries : ["terraform"];
}

async function findCandidateJob(
  agent: Agent,
  acceptedPhases: readonly string[],
  agentBinaries: readonly string[],
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Set has no rule-verifiable readonly form; skippedIds is only read here
  skippedIds: ReadonlySet<string>,
): Promise<AgentJobRow | undefined> {
  const compatiblePhases = acceptedPhases.filter((phase): boolean => agentSupportsPhase(agent, phase));
  if (compatiblePhases.length === 0) return undefined;
  return db.query.agentJobs.findFirst({
    where: and(
      eq(agentJobs.agentPoolId, agent.agentPoolId),
      eq(agentJobs.status, "queued"),
      inArray(agentJobs.phase, [...compatiblePhases]),
      inArray(agentJobs.iacBinary, agentBinaries),
      ...(skippedIds.size > 0 ? [notInArray(agentJobs.id, [...skippedIds])] : []),
    ),
    orderBy: [asc(agentJobs.createdAt)],
  });
}

async function tryClaimCandidate(candidate: AgentJobRow, agent: Agent): Promise<AgentJobRow | undefined> {
  return db.transaction(async (transaction) => {
    const database = transaction as unknown as Database;
    const claimed = await database
      .update(agentJobs)
      .set({
        agentId: agent.id,
        status: "claimed",
        claimedAt: Date.now(),
        fencingToken: sql`${agentJobs.fencingToken} + 1`,
      })
      .where(and(eq(agentJobs.id, candidate.id), eq(agentJobs.status, "queued")))
      .returning();
    const job = claimed[0];
    if (job === undefined) return undefined;
    // Establish non-delivery before exposing the lease to either poll route.
    // Never add tracking retroactively to an already claimed, older lease.
    const result = { ...job.result, payloadDeliveryTrackingToken: job.fencingToken };
    await database.update(agentJobs).set({ result }).where(eq(agentJobs.id, job.id));
    return { ...job, result };
  });
}

async function validateCandidateRun(
  candidate: AgentJobRow,
): Promise<{ run: AgentRunRow; expectedRunStatus: string; nextRunStatus: string } | null> {
  const expectedRunStatus = candidate.phase === "plan" ? "plan_queued" : "apply_queued";
  const nextRunStatus = candidate.phase === "plan" ? "planning" : "applying";
  const run = await db.query.runs.findFirst({ where: eq(runs.id, candidate.runId) });
  if (run === undefined || run.status !== expectedRunStatus) {
    await db
      .update(agentJobs)
      .set({ status: "canceled", completedAt: Date.now(), errorMessage: "Run is no longer waiting for this job" })
      .where(and(eq(agentJobs.id, candidate.id), eq(agentJobs.status, "claimed")));
    return null;
  }
  if (!(await runConfigurationTrusted(run))) {
    await db
      .update(agentJobs)
      .set({
        status: "errored",
        completedAt: Date.now(),
        errorMessage: "Pull-request configuration lacks trusted repository admission",
      })
      .where(and(eq(agentJobs.id, candidate.id), eq(agentJobs.status, "claimed")));
    await db
      .update(runs)
      .set({ status: "errored", statusTimestamps: timestampsWithStatus(run.statusTimestamps, "errored") })
      .where(and(eq(runs.id, run.id), eq(runs.status, expectedRunStatus)));
    notifyRunStatus(run.id, "errored");
    return null;
  }
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
  const policyError =
    workspace === undefined
      ? `${candidate.phase === "plan" ? "Plan" : "Apply"} blocked: workspace no longer exists`
      : candidate.phase === "plan"
        ? await workspacePolicyPlanningError(db, workspace, await jobSupportsNativePolicy(db, candidate))
        : await agentApplyPolicyError(db, workspace, run.id, await jobSupportsNativePolicy(db, candidate));
  if (policyError !== null) {
    await db
      .update(agentJobs)
      .set({ status: "errored", completedAt: Date.now(), errorMessage: policyError })
      .where(and(eq(agentJobs.id, candidate.id), eq(agentJobs.status, "claimed")));
    await db
      .update(runs)
      .set({ status: "errored", statusTimestamps: timestampsWithStatus(run.statusTimestamps, "errored") })
      .where(and(eq(runs.id, run.id), eq(runs.status, expectedRunStatus)));
    notifyRunStatus(run.id, "errored");
    return null;
  }
  return { run, expectedRunStatus, nextRunStatus };
}

async function tryLockWorkspaceForApply(
  candidate: AgentJobRow,
  run: AgentRunRow,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- skipped ids are accumulated into this set by design
  skippedApplyJobIds: Set<string>,
): Promise<"locked" | "skipped" | "no-lock"> {
  if (candidate.phase !== "apply") return "no-lock";
  const locked = await db
    .update(workspaces)
    .set({
      locked: true,
      lockedReason: `Run ${candidate.runId} is applying`,
      lockOwnerType: "agent-run",
      lockOwnerId: candidate.runId,
    })
    .where(and(eq(workspaces.id, run.workspaceId), or(eq(workspaces.locked, false), isNull(workspaces.locked))))
    .returning({ id: workspaces.id });
  if (locked.length > 0) return "locked";
  skippedApplyJobIds.add(candidate.id);
  await db
    .update(agentJobs)
    .set({ agentId: null, status: "queued", claimedAt: null })
    .where(and(eq(agentJobs.id, candidate.id), eq(agentJobs.status, "claimed")));
  return "skipped";
}

async function tryAssociateRun(
  candidate: AgentJobRow,
  run: AgentRunRow,
  agent: Agent,
  expectedRunStatus: string,
  nextRunStatus: string,
): Promise<{ id: string } | null> {
  const capabilities = agent.capabilities ?? LEGACY_AGENT_CAPABILITIES;
  const associated = await db
    .update(runs)
    .set({
      agentPoolId: agent.agentPoolId,
      agentId: agent.id,
      agentVersion: agent.version,
      agentProtocolVersion: agent.protocolVersion,
      agentCapabilities: [...capabilities],
      agentExecutionPolicy: effectiveAgentExecutionPolicy(agent, candidate.phase, candidate.iacBinary),
      status: nextRunStatus,
      statusTimestamps: timestampsWithStatus(run.statusTimestamps, nextRunStatus),
    })
    .where(and(eq(runs.id, run.id), eq(runs.status, expectedRunStatus)))
    .returning({ id: runs.id });
  if (associated.length > 0) return associated[0] as { id: string };
  if (candidate.phase === "apply") {
    await db
      .update(workspaces)
      .set({ locked: false, lockedReason: null, lockOwnerType: null, lockOwnerId: null })
      .where(
        and(
          eq(workspaces.id, run.workspaceId),
          eq(workspaces.locked, true),
          eq(workspaces.lockOwnerType, "agent-run"),
          eq(workspaces.lockOwnerId, run.id),
        ),
      );
  }
  await db
    .update(agentJobs)
    .set({ status: "canceled", completedAt: Date.now(), errorMessage: "Run is no longer waiting for this job" })
    .where(and(eq(agentJobs.id, candidate.id), eq(agentJobs.status, "claimed")));
  return null;
}

export async function claimAgentJob(
  agent: Agent,
  acceptedPhases: readonly string[] = ["plan", "apply"],
): Promise<ClaimedAgentJob | undefined> {
  if (!isAgentLiveForClaim(agent)) return undefined;
  const existingClaim = await findExistingClaim(agent);
  if (existingClaim !== undefined) return existingClaim;
  if (acceptedPhases.length === 0) return undefined;
  const agentBinaries = resolveAgentBinaries(agent);
  const skippedApplyJobIds = new Set<string>();
  for (let attempts = 0; attempts < 10; attempts += 1) {
    const candidate = await findCandidateJob(agent, acceptedPhases, agentBinaries, skippedApplyJobIds);
    if (candidate === undefined) return undefined;
    const claimedJob = await tryClaimCandidate(candidate, agent);
    if (claimedJob === undefined) {
      const raced = await db.query.agentJobs.findFirst({
        where: and(eq(agentJobs.agentId, agent.id), eq(agentJobs.status, "claimed")),
      });
      return raced === undefined ? undefined : await claimedJobDetails(raced);
    }
    const validation = await validateCandidateRun(claimedJob);
    if (validation === null) continue;
    const { run, expectedRunStatus, nextRunStatus } = validation;
    const claimedAt = Date.now();
    const lockResult = await tryLockWorkspaceForApply(candidate, run, skippedApplyJobIds);
    if (lockResult === "skipped") continue;
    const associated = await tryAssociateRun(candidate, run, agent, expectedRunStatus, nextRunStatus);
    if (associated === null) continue;
    await db.update(agents).set({ status: "busy", lastPingAt: claimedAt }).where(eq(agents.id, agent.id));
    notifyRunStatus(claimedJob.runId, claimedJob.phase === "plan" ? "planning" : "applying");
    return await claimedJobDetails(claimedJob);
  }
  return undefined;
}

export async function cancelAgentJobsForRun(runId: string): Promise<void> {
  const now = Date.now();
  await db.update(runTokens).set({ revokedAt: now }).where(eq(runTokens.runId, runId));
  // The canceled row is serialized with payload delivery. Read its current
  // marker: an undelivered native apply cannot run, even with a live agent.
  const claimedJobs = await db
    .update(agentJobs)
    .set({
      status: "canceled",
      completedAt: now,
      errorMessage: "Run canceled",
    })
    .where(and(eq(agentJobs.runId, runId), eq(agentJobs.status, "claimed")))
    .returning();
  await db
    .update(agentJobs)
    .set({
      status: "canceled",
      completedAt: now,
      errorMessage: "Run canceled",
    })
    .where(and(eq(agentJobs.runId, runId), eq(agentJobs.status, "queued")));
  // Issue #617: a claimed job may still be running remotely. Releasing the
  // workspace lock now would hand a second apply the workspace while the
  // first agent may still write. Hold the lock until the agent acknowledges
  // (terminal completion for the canceled job) or its heartbeat lease
  // expires (the stale-job sweep releases it). Native applies with no delivery
  // marker or recovery hold cannot have started and need no acknowledgment.
  if (claimedJobs.every(nativeApplyWasNotDelivered)) {
    const terminalJobs = await db.query.agentJobs.findMany({
      where: and(eq(agentJobs.runId, runId), inArray(agentJobs.status, ["canceled", "errored"])),
    });
    if (terminalJobs.some(nativeApplyNeedsRecovery)) return;
    await db
      .update(workspaces)
      .set({ locked: false, lockedReason: null, lockOwnerType: null, lockOwnerId: null })
      .where(
        and(eq(workspaces.locked, true), eq(workspaces.lockOwnerType, "agent-run"), eq(workspaces.lockOwnerId, runId)),
      );
  }
}

/** ANSI escape sequences: CSI (colors/cursor), OSC (titles/hyperlinks), Fe escapes. */
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** Strip ANSI escape sequences so stored run logs render as plain text. */
export function stripAnsiEscape(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

export async function appendAgentJobLog(
  agentId: string,
  jobId: string,
  fencingToken: number,
  outputText: string,
): Promise<boolean> {
  return db.transaction(async (transaction): Promise<boolean> => {
    const database = transaction as unknown as Database;
    const claimed = await database
      .update(agentJobs)
      .set({ status: "claimed" })
      .where(
        and(
          eq(agentJobs.id, jobId),
          eq(agentJobs.agentId, agentId),
          eq(agentJobs.fencingToken, fencingToken),
          eq(agentJobs.status, "claimed"),
        ),
      )
      .returning({ phase: agentJobs.phase, runId: agentJobs.runId });
    const job = claimed[0];
    if (job === undefined) return false;
    await insertAgentJobLog(database, job, stripAnsiEscape(outputText), Date.now());
    return true;
  });
}

async function insertAgentJobLog(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  job: Pick<AgentJob, "phase" | "runId">,
  outputText: string,
  createdAt: number,
): Promise<void> {
  await database.insert(logs).values({
    id: crypto.randomUUID(),
    runId: job.runId,
    phase: job.phase,
    outputText,
    createdAt,
  });
}

export async function findClaimedAgentJob(
  agentId: string,
  jobId: string,
  fencingToken: number,
): Promise<ClaimedAgentJob | undefined> {
  const job = await db.query.agentJobs.findFirst({
    where: and(
      eq(agentJobs.id, jobId),
      eq(agentJobs.agentId, agentId),
      eq(agentJobs.fencingToken, fencingToken),
      eq(agentJobs.status, "claimed"),
    ),
  });
  return job === undefined ? undefined : claimedJobDetails(job);
}

/**
 * Insert an agent apply job and flip the run confirmed -> apply_queued in one
 * transaction. The caller owns the transaction; the run must be `confirmed`
 * when this runs. Throwing rolls back the caller's whole transaction, so a
 * crash can never leave a confirmed run without a job (kanban t_c5f59537).
 */
export async function insertAgentApplyJobTx(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: typeof db,
  runId: string,
  agentPoolId: string,
  statusTimestamps: Readonly<Record<string, string>> | null,
): Promise<AgentJob> {
  const run = await database.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (run === undefined) throw new Error("Run disappeared while its agent apply job was queued");
  const workspace = await database.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
  // Same resolution as the plan job: unset workspace binary means terraform
  // for agent execution (tfc-agent contract), never the org default.
  const iacBinary = workspace?.iacBinary ?? "terraform";
  const job: AgentJob = {
    id: newResourceId("ajob"),
    runId,
    agentPoolId,
    agentId: null,
    phase: "apply",
    iacBinary,
    status: "queued",
    result: null,
    errorMessage: null,
    claimedAt: null,
    completedAt: null,
    fencingToken: 0,
    createdAt: Date.now(),
    requeueAttempts: 0,
  };
  await database.insert(agentJobs).values(job);
  const updated = await database
    .update(runs)
    .set({
      agentPoolId,
      status: "apply_queued",
      statusTimestamps: timestampsWithStatus(statusTimestamps, "apply_queued"),
    })
    .where(and(eq(runs.id, runId), eq(runs.status, "confirmed")))
    .returning({ id: runs.id });
  if (updated.length === 0) throw new Error("Run changed while its agent apply job was queued");
  return job;
}

type AgentJobRow = DeepReadonly<typeof agentJobs.$inferSelect>;
type AgentRunRow = DeepReadonly<typeof runs.$inferSelect>;
type CompletionResult = Readonly<{ job: AgentJob; runStatus: string }>;
type CompletionPreparation = Readonly<{
  structuredPlanCounts: ReturnType<typeof planJsonResourceCounts>;
  now: number;
}>;
type CompletionOutcome = Readonly<{
  policyOutcome: AgentPolicyOutcome;
  runStatus: string;
}>;

const UNEVALUATED_POLICY_OUTCOME: AgentPolicyOutcome = {
  evaluated: false,
  hardFailed: false,
  softFailed: false,
};

async function requeueInvalidCompletion(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  agentId: string,
  job: AgentJobRow,
  run: AgentRunRow | undefined,
  expectedRunStatus: string,
  reason: string,
): Promise<void> {
  const requeueAttempts = job.requeueAttempts + 1;
  const terminal = requeueAttempts >= MAX_INVALID_COMPLETION_REQUEUES;
  const updatedJobs = await database
    .update(agentJobs)
    .set({
      status: terminal ? "canceled" : "queued",
      agentId: null,
      claimedAt: null,
      completedAt: terminal ? Date.now() : null,
      errorMessage: reason,
      requeueAttempts,
    })
    .where(
      and(
        eq(agentJobs.id, job.id),
        eq(agentJobs.agentId, agentId),
        eq(agentJobs.fencingToken, job.fencingToken),
        eq(agentJobs.status, "claimed"),
      ),
    )
    .returning({ id: agentJobs.id });
  if (updatedJobs.length === 0) return;
  const nextRunStatus = terminal ? "errored" : job.phase === "plan" ? "plan_queued" : "apply_queued";
  if (run !== undefined) {
    await database
      .update(runs)
      .set({
        agentId: null,
        status: nextRunStatus,
        statusTimestamps: timestampsWithStatus(run.statusTimestamps, nextRunStatus),
      })
      .where(and(eq(runs.id, run.id), eq(runs.status, expectedRunStatus)));
  }
  if (job.phase === "apply" && run !== undefined) {
    await database
      .update(workspaces)
      .set({ locked: false, lockedReason: null, lockOwnerType: null, lockOwnerId: null })
      .where(
        and(
          eq(workspaces.id, run.workspaceId),
          eq(workspaces.locked, true),
          eq(workspaces.lockOwnerType, "agent-run"),
          eq(workspaces.lockOwnerId, run.id),
        ),
      );
  }
  await database.update(agents).set({ status: "idle", lastPingAt: Date.now() }).where(eq(agents.id, agentId));
}

function invalidCompletionReason(
  job: AgentJobRow,
  run: AgentRunRow | undefined,
  completion: AgentJobCompletion,
  expectedRunStatus: string,
): string | undefined {
  if (run?.status !== expectedRunStatus) return "Run changed before agent completion";
  if (!isAgentResultValid(completion.result)) return "Invalid agent completion result";
  if (completion.planJson !== null && (completion.status !== "completed" || job.phase !== "plan")) {
    return "plan-json is only valid for completed plan jobs";
  }
  if (
    job.phase === "apply" &&
    completion.status === "completed" &&
    (completion.statePayload === null || completion.statePayload === undefined)
  ) {
    return "Completed apply job must return non-null statePayload";
  }
  return undefined;
}

async function validateAgentCompletion(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  agentId: string,
  job: AgentJobRow,
  run: AgentRunRow | undefined,
  completion: AgentJobCompletion,
  expectedRunStatus: string,
): Promise<boolean> {
  const reason = invalidCompletionReason(job, run, completion, expectedRunStatus);
  if (reason === undefined) return true;
  if (nativeApplyWasAdmitted(job)) {
    await holdNativeApplyForRecovery(database, job, run, `${reason}; native state recovery is required`);
  } else {
    await requeueInvalidCompletion(database, agentId, job, run, expectedRunStatus, reason);
  }
  return false;
}

async function prepareAgentCompletion(
  job: AgentJobRow,
  run: AgentRunRow,
  completion: AgentJobCompletion,
): Promise<CompletionPreparation> {
  if (completion.planJson !== null) await writePlanJsonArtifact(run.id, completion.planJson);
  // Modern agent protocol uploads the plan JSON separately (PUT to the job's
  // plan-json URL) before completing; fall back to the stored artifact so
  // resource counts are still derived from the real plan.
  const effectivePlanJson = completion.planJson ?? (await readPlanJsonArtifact(run.id));
  const structuredPlanCounts =
    job.phase === "plan" && effectivePlanJson !== undefined ? planJsonResourceCounts(effectivePlanJson) : undefined;
  return { structuredPlanCounts, now: Date.now() };
}

const SERVER_AGENT_RESULT_KEYS = new Set([
  "nativePolicyEvaluationId",
  "nativeRecoveryRequired",
  "nativeStateRecovered",
  "policyApplyAdmissionToken",
  "payloadDeliveryToken",
  "payloadDeliveryTrackingToken",
]);
function agentOwnedCompletionResult(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(result).filter(([key]) => !SERVER_AGENT_RESULT_KEYS.has(key)));
}

async function persistAgentJobCompletion(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  agentId: string,
  job: AgentJobRow,
  completion: AgentJobCompletion,
  now: number,
): Promise<AgentJobRow | undefined> {
  if (completion.status === "errored" && completion.errorMessage !== null && completion.errorMessage !== "") {
    await insertAgentJobLog(database, job, `[agent error] ${completion.errorMessage}`, now);
  }
  const jobStatus = completion.status === "completed" ? "completed" : "errored";
  const updatedJobs = await database
    .update(agentJobs)
    .set({
      status: jobStatus,
      result: {
        ...job.result,
        ...agentOwnedCompletionResult(completion.result),
        ...(job.phase === "apply" &&
        typeof job.result?.["nativePolicyEvaluationId"] === "string" &&
        completion.statePayload !== null
          ? { nativeStateRecovered: true }
          : {}),
      },
      errorMessage: completion.errorMessage,
      completedAt: now,
    })
    .where(
      and(
        eq(agentJobs.id, job.id),
        eq(agentJobs.agentId, agentId),
        eq(agentJobs.fencingToken, job.fencingToken),
        eq(agentJobs.status, "claimed"),
      ),
    )
    .returning();
  return updatedJobs[0];
}

/** Narrow plan inputs for the agent plan-status decision (issue #587).
 * Exported for tests; the full row types remain module-private. */
export type AgentPlanFlags = Readonly<{
  autoApply: boolean;
  allowEmptyApply: boolean;
  savePlan: boolean;
  planOnly: boolean;
}>;

export type AgentPolicyVerdict = Readonly<{
  hardFailed: boolean;
  softFailed: boolean;
}>;

/**
 * Decide the run status after an agent plan job completes. Exported for tests.
 *
 * allow-empty-apply only PERMITS applying an empty plan (mirroring the local
 * worker, where an empty plan with the flag stops at planned for
 * confirmation instead of finishing): it never triggers an automatic apply
 * on its own. Only an explicit autoApply queues the apply phase.
 */
export function resolvePlanStatus(policyOutcome: AgentPolicyVerdict, run: AgentPlanFlags): string {
  if (policyOutcome.hardFailed) return "errored";
  if (policyOutcome.softFailed) return "policy_soft_failed";
  if (run.savePlan) return "planned_and_saved";
  if (run.planOnly) return "planned_and_finished";
  if (run.autoApply) return "apply_queued";
  return "planned";
}

async function determineCompletionOutcome(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  job: AgentJobRow,
  run: AgentRunRow,
  completion: AgentJobCompletion,
  now: number,
  applyGateReason: string | null,
  native?: DeepReadonly<NativeCandidate>,
): Promise<CompletionOutcome> {
  if (completion.status !== "completed") {
    return { policyOutcome: UNEVALUATED_POLICY_OUTCOME, runStatus: "errored" };
  }
  if (job.phase !== "plan") {
    return { policyOutcome: UNEVALUATED_POLICY_OUTCOME, runStatus: "applied" };
  }
  const workspace = await database.query.workspaces.findFirst({
    where: eq(workspaces.id, run.workspaceId),
  });
  if (workspace === undefined) throw new Error("Agent workspace disappeared during completion");
  const policyOutcome = await recordAgentPolicyChecks(database, workspace, run.id, completion.result, now, native);
  const runStatus = resolvePlanStatus(policyOutcome, run);
  if (runStatus === "apply_queued" && applyGateReason !== null) {
    return { policyOutcome, runStatus: "planned" };
  }
  return { policyOutcome, runStatus };
}

function completionStatusTimestamps(
  run: AgentRunRow,
  job: AgentJobRow,
  completion: AgentJobCompletion,
  policyOutcome: AgentPolicyOutcome,
): Readonly<Record<string, string>> | null {
  let statusTimestamps = run.statusTimestamps;
  if (completion.status === "completed" && job.phase === "plan") {
    statusTimestamps = timestampsWithStatus(statusTimestamps, "planned");
  }
  if (!policyOutcome.evaluated) return statusTimestamps;
  statusTimestamps = timestampsWithStatus(statusTimestamps, "policy_checking");
  if (policyOutcome.softFailed && !policyOutcome.hardFailed) {
    statusTimestamps = timestampsWithStatus(statusTimestamps, "policy_override");
  } else if (!policyOutcome.hardFailed) {
    statusTimestamps = timestampsWithStatus(statusTimestamps, "policy_checked");
  }
  return statusTimestamps;
}

async function persistRunCompletion(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  job: AgentJobRow,
  run: AgentRunRow,
  completion: AgentJobCompletion,
  expectedRunStatus: string,
  structuredPlanCounts: ReturnType<typeof planJsonResourceCounts>,
  policyOutcome: AgentPolicyOutcome,
  runStatus: string,
  now: number,
): Promise<void> {
  const statusTimestamps = completionStatusTimestamps(run, job, completion, policyOutcome);
  // Issue #587: agent completions must honor the declared state machine like
  // every other writer. The expected-status guard below races safely, but an
  // illegal edge is a code bug, so fail loudly instead of persisting it.
  if (!canTransitionRunStatus(run.status, runStatus)) {
    throw new Error(`Refusing illegal agent completion transition ${run.status} -> ${runStatus} for run ${run.id}`);
  }
  const resourceValues =
    job.phase === "plan"
      ? {
          planResourceAdditions: structuredPlanCounts?.additions ?? completion.resourceAdditions,
          planResourceChanges: structuredPlanCounts?.changes ?? completion.resourceChanges,
          planResourceDestructions: structuredPlanCounts?.destructions ?? completion.resourceDestructions,
          planResourceImports: structuredPlanCounts?.imports ?? completion.resourceImports,
        }
      : {
          applyResourceAdditions: completion.resourceAdditions,
          applyResourceChanges: completion.resourceChanges,
          applyResourceDestructions: completion.resourceDestructions,
          applyResourceImports: completion.resourceImports,
        };
  const updatedRuns = await database
    .update(runs)
    .set({
      status: runStatus,
      statusTimestamps: timestampsWithStatus(statusTimestamps, runStatus),
      ...(job.phase === "apply" && completion.status === "completed" ? { appliedAt: now } : {}),
      ...resourceValues,
    })
    .where(and(eq(runs.id, run.id), eq(runs.status, expectedRunStatus)))
    .returning({ id: runs.id });
  if (updatedRuns.length === 0) throw new Error("Run changed while its agent job was completing");
}

async function persistApplyStateVersion(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  job: AgentJobRow,
  run: AgentRunRow,
  completion: AgentJobCompletion,
  now: number,
): Promise<void> {
  if (job.phase !== "apply" || completion.statePayload === null) return;
  await insertStateVersionWithSerialTx(database, {
    id: crypto.randomUUID(),
    workspaceId: run.workspaceId,
    statePayload: await encryptStatePayload(completion.statePayload),
    jsonState: await encryptStatePayload(completion.jsonState ?? completion.statePayload),
    jsonStateOutputs: await encryptStatePayload(completion.jsonStateOutputs),
    runId: run.id,
    createdBy: run.createdBy,
    status: "finalized",
    createdAt: now,
  });
}

async function releaseApplyWorkspaceLock(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  job: AgentJobRow,
  run: AgentRunRow,
): Promise<void> {
  if (job.phase !== "apply") return;
  await database
    .update(workspaces)
    .set({ locked: false, lockedReason: null, lockOwnerType: null, lockOwnerId: null })
    .where(
      and(
        eq(workspaces.id, run.workspaceId),
        eq(workspaces.locked, true),
        eq(workspaces.lockOwnerType, "agent-run"),
        eq(workspaces.lockOwnerId, run.id),
      ),
    );
}

async function enqueueApplyAfterPlan(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  job: AgentJobRow,
  run: AgentRunRow,
  completion: AgentJobCompletion,
  runStatus: string,
  now: number,
): Promise<void> {
  if (completion.status !== "completed" || job.phase !== "plan" || runStatus !== "apply_queued") return;
  const workspace = await database.query.workspaces.findFirst({
    where: eq(workspaces.id, run.workspaceId),
    columns: { iacBinary: true },
  });
  await database.insert(agentJobs).values({
    id: newResourceId("ajob"),
    runId: run.id,
    agentPoolId: job.agentPoolId,
    phase: "apply",
    iacBinary: workspace?.iacBinary ?? "terraform",
    fencingToken: 0,
    status: "queued",
    createdAt: now,
  });
}

/** Terminal report for a job canceled out from under its agent (issue #617).
 * The agent stopped its remote run and checked back: release the workspace
 * lock the cancel held and free the agent. The run itself is already
 * canceled/force-canceled and is left untouched. Returns undefined unless
 * this exact (job, agent, fencing) triple is a canceled job of a canceled
 * run — anything else stays a fencing conflict. */
async function acknowledgeCanceledAgentJob(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  agentId: string,
  jobId: string,
  fencingToken: number,
  completion: AgentJobCompletion,
): Promise<CompletionResult | undefined> {
  const job = await database.query.agentJobs.findFirst({
    where: and(
      eq(agentJobs.id, jobId),
      eq(agentJobs.agentId, agentId),
      eq(agentJobs.fencingToken, fencingToken),
      eq(agentJobs.status, "canceled"),
    ),
  });
  if (job === undefined) return undefined;
  const run = await database.query.runs.findFirst({ where: eq(runs.id, job.runId) });
  if (run === undefined || (run.status !== "canceled" && run.status !== "force_canceled")) return undefined;
  if (job.phase === "apply" && typeof job.result?.["nativePolicyEvaluationId"] === "string") {
    if (parseTerraformStatePayload(completion.statePayload) === null) return undefined;
    if (job.result["nativeStateRecovered"] !== true)
      await persistApplyStateVersion(database, job, run, completion, Date.now());
    await database
      .update(agentJobs)
      .set({ result: { ...job.result, nativeRecoveryRequired: false, nativeStateRecovered: true } })
      .where(eq(agentJobs.id, job.id));
  }
  await releaseApplyWorkspaceLock(database, job, run);
  await database.update(agents).set({ status: "idle", lastPingAt: Date.now() }).where(eq(agents.id, agentId));
  return { job, runStatus: run.status };
}

async function acknowledgeFinishedNativeJob(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  agentId: string,
  jobId: string,
  fencingToken: number,
): Promise<CompletionResult | undefined> {
  const job = await database.query.agentJobs.findFirst({
    where: and(
      eq(agentJobs.id, jobId),
      eq(agentJobs.agentId, agentId),
      eq(agentJobs.fencingToken, fencingToken),
      inArray(agentJobs.status, ["completed", "errored", "canceled"]),
    ),
  });
  if (
    typeof job?.result?.["nativePolicyEvaluationId"] !== "string" ||
    job.result["nativeRecoveryRequired"] === true ||
    (job.phase === "apply" && job.result["nativeStateRecovered"] !== true)
  )
    return undefined;
  const run = await database.query.runs.findFirst({ where: eq(runs.id, job.runId) });
  return run === undefined ? undefined : { job, runStatus: run.status };
}

async function acknowledgeNativeRecovery(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  agentId: string,
  jobId: string,
  fencingToken: number,
  completion: AgentJobCompletion,
): Promise<CompletionResult | undefined> {
  const job = await database.query.agentJobs.findFirst({
    where: and(
      eq(agentJobs.id, jobId),
      eq(agentJobs.agentId, agentId),
      eq(agentJobs.fencingToken, fencingToken),
      eq(agentJobs.status, "errored"),
      eq(agentJobs.phase, "apply"),
    ),
  });
  if (job?.result?.["nativeRecoveryRequired"] !== true || parseTerraformStatePayload(completion.statePayload) === null)
    return undefined;
  const run = await database.query.runs.findFirst({ where: eq(runs.id, job.runId) });
  // Cancellation commits the run before its separate job update. It can win
  // after the recovery hold read the run, leaving an errored job on a canceled
  // run. Recover the same fenced state without undoing that terminal decision.
  if (run === undefined || !["errored", "canceled", "force_canceled"].includes(run.status)) return undefined;
  await persistApplyStateVersion(database, job, run, completion, Date.now());
  await database
    .update(agentJobs)
    .set({ result: { ...job.result, nativeRecoveryRequired: false, nativeStateRecovered: true } })
    .where(eq(agentJobs.id, job.id));
  await releaseApplyWorkspaceLock(database, job, run);
  await database.update(agents).set({ status: "idle", lastPingAt: Date.now() }).where(eq(agents.id, agentId));
  return { job, runStatus: run.status };
}

async function canceledApplyRecoveryRunId(
  agentId: string,
  jobId: string,
  fencingToken: number,
): Promise<string | null> {
  const job = await db.query.agentJobs.findFirst({
    where: and(
      eq(agentJobs.id, jobId),
      eq(agentJobs.agentId, agentId),
      eq(agentJobs.fencingToken, fencingToken),
      inArray(agentJobs.status, ["claimed", "canceled", "errored"]),
      eq(agentJobs.phase, "apply"),
    ),
  });
  if (
    job === undefined ||
    (job.status === "claimed" && !nativeApplyWasAdmitted(job)) ||
    (job.status === "errored" && job.result?.["nativeRecoveryRequired"] !== true)
  )
    return null;
  const run = await db.query.runs.findFirst({
    where: and(
      eq(runs.id, job.runId),
      inArray(runs.status, [
        "canceled",
        "force_canceled",
        ...(job.result?.["nativeRecoveryRequired"] === true ? ["errored"] : []),
      ]),
    ),
    columns: { id: true },
  });
  return run?.id ?? null;
}

async function validateNativeCompletionState(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Drizzle clients are stateful.
  database: Database,
  job: AgentJob,
  run: AgentRunRow | undefined,
  completion: AgentJobCompletion,
  native?: DeepReadonly<NativeCandidate>,
): Promise<AgentJobCompletion | null> {
  if (nativeApplyWasAdmitted(job) && parseTerraformStatePayload(completion.statePayload) === null) {
    await holdNativeApplyForRecovery(
      database,
      job,
      run,
      "Native apply returned without valid Terraform state; recovery is required",
    );
    return null;
  }
  if (native === undefined || run === undefined) return completion;
  const workspace = await database.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
  const snapshot = workspace === undefined ? undefined : await loadWorkspacePolicySnapshot(database, workspace);
  const checkpoint = await latestWorkspacePolicyEvaluation(database, run.id);
  return snapshot?.fingerprint === native.context.evaluation.snapshot.fingerprint &&
    checkpoint?.id === native.context.evaluation.id
    ? completion
    : {
        ...completion,
        status: "errored",
        planJson: null,
        errorMessage: "Policies changed during native agent execution; state retained",
      };
}

async function completeAgentJobInTransaction(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  agentId: string,
  jobId: string,
  fencingToken: number,
  completion: AgentJobCompletion,
  applyGateReason: string | null,
  native?: DeepReadonly<NativeCandidate>,
): Promise<CompletionResult | undefined> {
  // Serialize completion, cancellation and recovery on the same fenced job
  // before interpreting either its metadata or the run's status.
  const rows = await database
    .update(agentJobs)
    .set({ agentId })
    .where(and(eq(agentJobs.id, jobId), eq(agentJobs.agentId, agentId), eq(agentJobs.fencingToken, fencingToken)))
    .returning();
  const job = rows[0];
  if (job === undefined) return undefined;
  // Issue #617: a claimed job that was canceled out from under the agent
  // cannot complete normally, but its terminal report IS the acknowledgment
  // that the remote run stopped: release the run-owned apply lock the cancel
  // held, free the agent, and ack without touching the (already terminal)
  // run. Anything else is still a fencing conflict.
  if (job.status !== "claimed") {
    return (
      (await acknowledgeFinishedNativeJob(database, agentId, jobId, fencingToken)) ??
      (await acknowledgeNativeRecovery(database, agentId, jobId, fencingToken, completion)) ??
      acknowledgeCanceledAgentJob(database, agentId, jobId, fencingToken, completion)
    );
  }
  const run = await database.query.runs.findFirst({ where: eq(runs.id, job.runId) });
  if (nativeApplyWasAdmitted(job) && (run?.status === "canceled" || run?.status === "force_canceled")) {
    await holdNativeApplyForRecovery(database, job, run, "Canceled native apply requires returned state");
    return acknowledgeCanceledAgentJob(database, agentId, jobId, fencingToken, completion);
  }
  const expectedRunStatus = job.phase === "plan" ? "planning" : "applying";
  const fencedCompletion = await validateNativeCompletionState(database, job, run, completion, native);
  if (fencedCompletion === null) return undefined;
  completion = fencedCompletion;
  if (!(await validateAgentCompletion(database, agentId, job, run, completion, expectedRunStatus))) return undefined;
  if (run === undefined) return undefined;
  const preparation = await prepareAgentCompletion(job, run, completion);
  const updatedJob = await persistAgentJobCompletion(database, agentId, job, completion, preparation.now);
  if (updatedJob === undefined) return undefined;
  const outcome = await determineCompletionOutcome(
    database,
    job,
    run,
    completion,
    preparation.now,
    applyGateReason,
    native,
  );
  await persistRunCompletion(
    database,
    job,
    run,
    completion,
    expectedRunStatus,
    preparation.structuredPlanCounts,
    outcome.policyOutcome,
    outcome.runStatus,
    preparation.now,
  );
  await persistApplyStateVersion(database, job, run, completion, preparation.now);
  await releaseApplyWorkspaceLock(database, job, run);
  await enqueueApplyAfterPlan(database, job, run, completion, outcome.runStatus, preparation.now);
  await database.update(agents).set({ status: "idle", lastPingAt: preparation.now }).where(eq(agents.id, agentId));
  return { job: updatedJob, runStatus: outcome.runStatus };
}

class CanceledApplyRecoveryCaptureError extends Error {
  constructor(runId: string, options: Readonly<{ cause: unknown }>) {
    super(
      `Canceled apply ${runId} cannot be acknowledged until its returned state is durably captured for recovery`,
      options,
    );
    this.name = "CanceledApplyRecoveryCaptureError";
  }
}

async function captureCanceledApplyStateBeforeAcknowledgment(
  agentId: string,
  jobId: string,
  fencingToken: number,
  statePayload: string,
): Promise<void> {
  const recoveryRunId = await canceledApplyRecoveryRunId(agentId, jobId, fencingToken);
  if (recoveryRunId === null) return;
  try {
    await captureRecoveryStatePayload(storageDir, recoveryRunId, statePayload);
  } catch (error: unknown) {
    // Fail closed. The remote agent journals an unacknowledged completion and,
    // for apply recovery, retains its work directory until the server ACKs.
    // Releasing the workspace lock here would allow a new apply to start while
    // the only post-mutation state still lives on the agent. A retry repeats
    // the same fencing predicates and capture before acknowledgment.
    throw new CanceledApplyRecoveryCaptureError(recoveryRunId, { cause: error });
  }
}

async function verifyNativeCompletion(
  job: AgentJob | undefined,
  completion: AgentJobCompletion,
): Promise<Readonly<{ completion: AgentJobCompletion; native: NativeCandidate | undefined }>> {
  if (job === undefined || completion.status !== "completed") return { completion, native: undefined };
  try {
    const run = await db.query.runs.findFirst({ where: eq(runs.id, job.runId) });
    const workspace =
      run === undefined
        ? undefined
        : await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
    if (run === undefined || workspace === undefined) return { completion, native: undefined };
    const context = await prepareAgentNativePolicy(job, run, workspace);
    if (context === null) {
      if (typeof job.result?.["nativePolicyEvaluationId"] === "string")
        throw new Error("Native policy scope changed during execution; returned state retained");
      return { completion, native: undefined };
    }
    const native = await readNativeAgentCandidate(context, job);
    if (job.phase === "apply" && (native.payload["allows"] !== true || native.payload["exitCode"] !== 0))
      throw new Error("Native apply policy verification failed; returned state retained");
    return {
      native,
      completion:
        job.phase === "plan" ? { ...completion, planJson: JSON.parse(native.planJson) as PlanJson } : completion,
    };
  } catch (error: unknown) {
    return {
      native: undefined,
      completion: {
        ...completion,
        status: "errored",
        planJson: null,
        errorMessage: error instanceof Error ? error.message : "Native execution evidence is missing or invalid",
      },
    };
  }
}

export async function completeAgentJob(
  agentId: string,
  jobId: string,
  fencingToken: number,
  completion: AgentJobCompletion,
): Promise<Readonly<{ job: AgentJob; runStatus: string }> | undefined> {
  const claimedJob = await db.query.agentJobs.findFirst({
    where: and(
      eq(agentJobs.id, jobId),
      eq(agentJobs.agentId, agentId),
      eq(agentJobs.fencingToken, fencingToken),
      eq(agentJobs.status, "claimed"),
    ),
  });
  const verified = await verifyNativeCompletion(claimedJob, completion);
  completion = verified.completion;
  const native = verified.native;
  if (completion.statePayload !== null) {
    // Durable filesystem capture happens before the DB transaction so the
    // transaction never blocks unrelated statements on fsync/read-back I/O.
    // The transaction below repeats the exact canceled-job fencing checks
    // before releasing the workspace lock or acknowledging the agent.
    if (
      claimedJob !== undefined &&
      nativeApplyWasAdmitted(claimedJob) &&
      parseTerraformStatePayload(completion.statePayload) === null
    ) {
      // Preserve invalid returned bytes for diagnosis, but never publish them
      // as usable state or acknowledge that remote state can be discarded.
      await captureRecoveryStatePayload(storageDir, claimedJob.runId, completion.statePayload);
    } else {
      await captureCanceledApplyStateBeforeAcknowledgment(agentId, jobId, fencingToken, completion.statePayload);
    }
  }

  const applyGateReason =
    claimedJob?.phase === "plan"
      ? await import("./operations").then(
          async ({ applyGateBlockReason }): Promise<string | null> => applyGateBlockReason(new Date()),
        )
      : null;
  const outcome = await db.transaction(
    async (transaction): Promise<CompletionResult | undefined> =>
      completeAgentJobInTransaction(
        transaction as unknown as Database,
        agentId,
        jobId,
        fencingToken,
        completion,
        applyGateReason,
        native,
      ),
  );
  if (typeof claimedJob?.result?.["nativePolicyEvaluationId"] === "string")
    await revokeNativeAgentLease(claimedJob.runId, claimedJob.result["nativePolicyEvaluationId"], claimedJob);
  if (outcome !== undefined) notifyRunStatus(outcome.job.runId, outcome.runStatus);
  return outcome;
}
