import { tokenHashCandidates } from "./token-service";
import { and, asc, desc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  agentJobs,
  agentPoolTokens,
  agents,
  configurationVersions,
  logs,
  policies,
  policyChecks,
  policySetExclusions,
  policySetParameters,
  policySetProjects,
  policySets,
  policySetWorkspaces,
  runs,
  stateVersions,
  workspaces,
} from "../db/schema";
import { queueRunNotification } from "./notifications";
import { reportRunVcsStatus } from "./webhooks";
import {
  planJsonResourceCounts,
  readPlanJsonArtifact,
  writePlanJsonArtifact,
  type PlanJson,
} from "./plan-json";
import type { DeepReadonly } from "./utils";
import { insertStateVersionWithSerialTx } from "./state-serial";
import { encryptStatePayload } from "./validation";

export const MAX_AGENT_RESULT_BYTES = 64 * 1024;
export const MAX_AGENT_RESULT_DEPTH = 8;
export const MAX_AGENT_RESULT_KEYS = 500;

function isLargeString(value: unknown): boolean {
  return typeof value === "string" && value.length > 16_384;
}

function isArrayTooLarge(value: readonly unknown[], keyCount: { count: number }, depth: number): boolean {
  if (value.length > 1000) return true;
  keyCount.count += value.length;
  if (keyCount.count > MAX_AGENT_RESULT_KEYS) return true;
  for (const item of value) if (isResultValueTooLarge(item, depth + 1, keyCount)) return true;
  return false;
}

function isObjectTooLarge(entries: readonly [string, unknown][], keyCount: { count: number }, depth: number): boolean {
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

function isResultValueTooLarge(value: unknown, depth: number, keyCount: { count: number }): boolean {
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

const DEFAULT_AGENT_HEARTBEAT_TIMEOUT_MS = 60_000;
// Agent liveness is persisted at most this often per agent. The offline
// sweep cutoff (AGENT_HEARTBEAT_TIMEOUT_MS) must stay comfortably above
// this interval so a throttled agent is never swept as unavailable.
const AGENT_PING_WRITE_INTERVAL_MS = 15_000;
// Lower bound so an operator-shrunk timeout cannot drive the write
// interval to something pathological (sub-second DB writes).
const MIN_PING_WRITE_INTERVAL_MS = 3_000;
const MAX_INVALID_COMPLETION_REQUEUES = 3;

export function configuredHeartbeatTimeoutMs(): number {
  const configured = Number(
    process.env.AGENT_HEARTBEAT_TIMEOUT_MS ?? DEFAULT_AGENT_HEARTBEAT_TIMEOUT_MS,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_AGENT_HEARTBEAT_TIMEOUT_MS;
}

/** Persist-at-most interval derived from the sweep timeout: always stays
 * below the timeout so a heartbeating agent can never be swept as stale. */
function effectivePingWriteIntervalMs(): number {
  const timeout = configuredHeartbeatTimeoutMs();
  return Math.min(
    AGENT_PING_WRITE_INTERVAL_MS,
    Math.max(MIN_PING_WRITE_INTERVAL_MS, Math.floor(timeout / 4)),
  );
}
// Agent-pool tokens mirror the user-token lastUsedAt throttle (auth.ts).
const AGENT_TOKEN_LAST_USED_INTERVAL_MS = 60_000;

type AgentPolicyEvaluation = Readonly<{
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
  const trigger = status === "planning"
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
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  workspace: Workspace,
): Promise<AgentPolicyEvaluation | null> {
  const [attached, projectAttached, globalSets, exclusions] = await Promise.all([
    database.query.policySetWorkspaces.findMany({
      where: eq(policySetWorkspaces.workspaceId, workspace.id),
    }),
    workspace.projectId === null
      ? Promise.resolve([])
      : database.query.policySetProjects.findMany({
          where: eq(policySetProjects.projectId, workspace.projectId),
        }),
    database.query.policySets.findMany({
      where: and(
        eq(policySets.orgId, workspace.orgId),
        eq(policySets.global, true),
      ),
    }),
    database.query.policySetExclusions.findMany({
      where: eq(policySetExclusions.workspaceId, workspace.id),
    }),
  ]);
  const excludedIds = new Set(exclusions.map((exclusion): string => exclusion.policySetId));
  const attachedIds = [...new Set([
    ...attached.map((link): string => link.policySetId),
    ...projectAttached.map((link): string => link.policySetId),
    ...globalSets.map((policySet): string => policySet.id),
  ])].filter((policySetId): boolean => !excludedIds.has(policySetId));
  if (attachedIds.length === 0) return null;

  const effectiveSets = await database.query.policySets.findMany({
    where: and(
      inArray(policySets.id, attachedIds),
      eq(policySets.orgId, workspace.orgId),
      eq(policySets.kind, "sentinel"),
      eq(policySets.agentEnabled, true),
    ),
    orderBy: [asc(policySets.createdAt), asc(policySets.id)],
  });
  const effectiveIds = effectiveSets.map((policySet): string => policySet.id);
  if (effectiveIds.length === 0) return null;

  const [effectivePolicies, parameters] = await Promise.all([
    database.query.policies.findMany({
      where: inArray(policies.policySetId, effectiveIds),
      orderBy: [asc(policies.createdAt), asc(policies.id)],
    }),
    database.query.policySetParameters.findMany({
      where: inArray(policySetParameters.policySetId, effectiveIds),
      orderBy: [asc(policySetParameters.key), asc(policySetParameters.id)],
    }),
  ]);
  const policySetsWithPolicies = effectiveSets.flatMap((policySet): AgentPolicyEvaluation["policySets"] => {
    const setPolicies = effectivePolicies
      .filter((policy): boolean => policy.policySetId === policySet.id)
      .map((policy): AgentPolicy => ({
        id: policy.id,
        name: policy.name,
        description: policy.description,
        enforcementLevel: policy.enforcementLevel === "advisory" ? "advisory" : "mandatory",
        query: policy.query,
        source: policy.source,
      }));
    if (setPolicies.length === 0) return [];
    return [{
      id: policySet.id,
      name: policySet.name,
      description: policySet.description,
      kind: policySet.kind,
      policyToolVersion: policySet.policyToolVersion ?? "latest",
      overridable: policySet.overridable !== false,
      policies: setPolicies,
      parameters: parameters
        .filter((parameter): boolean => parameter.policySetId === policySet.id)
        .map((parameter): AgentPolicyParameter => ({
          key: parameter.key,
          value: parameter.value,
          sensitive: parameter.sensitive === true,
          hcl: parameter.hcl === true,
        })),
    }];
  });
  return policySetsWithPolicies.length === 0 ? null : { policySets: policySetsWithPolicies };
}

function agentPolicyResults(
  result: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, Readonly<{ status: string; result: Record<string, unknown> }>> {
  const rawChecks = result["policy-checks"];
  if (!Array.isArray(rawChecks)) return new Map();
  const reported = new Map<string, Readonly<{ status: string; result: Record<string, unknown> }>>();
  const duplicates = new Set<string>();
  for (const rawCheck of rawChecks) {
    if (typeof rawCheck !== "object" || rawCheck === null || Array.isArray(rawCheck)) continue;
    const check = rawCheck as Record<string, unknown>;
    const policyId = check["policy-id"];
    const status = check.status;
    if (
      typeof policyId !== "string"
      || !["passed", "failed", "errored", "unreachable"].includes(
        typeof status === "string" ? status : "",
      )
    ) continue;
    if (reported.has(policyId)) {
      duplicates.add(policyId);
      reported.delete(policyId);
      continue;
    }
    if (duplicates.has(policyId)) continue;
    const checkResult = check.result;
    reported.set(policyId, {
      status: status as string,
      result: typeof checkResult === "object" && checkResult !== null && !Array.isArray(checkResult)
        ? checkResult as Record<string, unknown>
        : {},
    });
  }
  return reported;
}

async function recordAgentPolicyChecks(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  workspace: Workspace,
  runId: string,
  result: Readonly<Record<string, unknown>>,
  now: number,
): Promise<AgentPolicyOutcome> {
  const evaluation = await getAgentPolicyEvaluation(database, workspace);
  if (evaluation === null) {
    return { evaluated: false, hardFailed: false, softFailed: false };
  }

  const reported = agentPolicyResults(result);
  let hardFailed = false;
  let softFailed = false;
  for (const policySet of evaluation.policySets) {
    for (const policy of policySet.policies) {
      const outcome = reported.get(policy.id);
      const checkStatus = outcome?.status ?? "errored";
      const storedStatus = checkStatus === "failed"
        && policy.enforcementLevel === "mandatory"
        && policySet.overridable
        ? "soft_failed"
        : checkStatus;
      await database.insert(policyChecks).values({
        id: `pchk-${crypto.randomUUID()}`,
        runId,
        policyId: policy.id,
        policySetId: policySet.id,
        status: storedStatus,
        result: outcome?.result ?? { error: "Agent did not return a policy outcome" },
        createdAt: now,
      });
      if (checkStatus === "passed" || policy.enforcementLevel === "advisory") continue;
      if (checkStatus === "failed" && policySet.overridable) softFailed = true;
      else hardFailed = true;
    }
  }
  return { evaluated: true, hardFailed, softFailed };
}

export async function recoverStaleAgentJobs(now = Date.now()): Promise<string[]> {
  const timeout = configuredHeartbeatTimeoutMs();
  const cutoff = now - timeout;
  // ponytail: run the sweep on the shared connection WITHOUT a write transaction.
  // The process shares a single stable bun:sqlite connection, so a write
  // transaction here would hold that connection's write lock across the entire
  // sweep and stall concurrent queries on this worker poll. Recovery is
  // race-safe without the transaction: every update below is conditional on the
  // row's current status and its returning() is checked, and a partially-
  // recovered job is simply picked up by the next poll (1.5s later).
  // ponytail: global sweep is fine for homelab; add heartbeat indexes only if agent volume makes it measurable.
  const unavailableAgents = await db.select({ id: agents.id })
    .from(agents)
    .where(or(
      lt(agents.lastPingAt, cutoff),
      inArray(agents.status, ["unknown", "exited", "errored"]),
    ));
  const unavailableAgentIds = unavailableAgents.map((agent): string => agent.id);

  if (unavailableAgentIds.length > 0) {
    await db.update(agents).set({ status: "unknown" }).where(and(
      inArray(agents.id, unavailableAgentIds),
      inArray(agents.status, ["idle", "busy"]),
      lt(agents.lastPingAt, cutoff),
    ));
  }

  const unavailableClaim = unavailableAgentIds.length === 0
    ? isNull(agentJobs.agentId)
    : or(
        isNull(agentJobs.agentId),
        inArray(agentJobs.agentId, unavailableAgentIds),
      );
  const staleJobs = await db.query.agentJobs.findMany({
    where: and(eq(agentJobs.status, "claimed"), unavailableClaim),
    orderBy: [asc(agentJobs.claimedAt)],
  });
  const recoveredJobs: { jobId: string; runId: string; runStatus: string }[] = [];

  // Pre-fetch all affected runs in a single query to avoid N+1
  const staleRunIds = [...new Set(staleJobs.map((job): string => job.runId))];
  const staleRuns = staleRunIds.length === 0
    ? new Map<string, typeof runs.$inferSelect>()
    : new Map(
        (await db.query.runs.findMany({
          where: inArray(runs.id, staleRunIds),
        })).map((r): [string, typeof runs.$inferSelect] => [r.id, r]),
      );

  for (const job of staleJobs) {
    const expectedRunStatus = job.phase === "plan" ? "planning" : "applying";
    const queuedRunStatus = job.phase === "plan" ? "plan_queued" : "apply_queued";
    const owner = job.agentId === null
      ? isNull(agentJobs.agentId)
      : eq(agentJobs.agentId, job.agentId);

    const updatedJobs = await db.update(agentJobs).set({
      agentId: null,
      status: "queued",
      claimedAt: null,
      completedAt: null,
      errorMessage: null,
    }).where(and(
      eq(agentJobs.id, job.id),
      eq(agentJobs.status, "claimed"),
      owner,
    )).returning({ id: agentJobs.id });
    if (updatedJobs.length === 0) {
      // An agent claimed or completed this job mid-sweep; leave the run alone.
      continue;
    }

    const run = staleRuns.get(job.runId);
    const updatedRuns = run === undefined
      ? []
      : await db.update(runs).set({
          agentId: null,
          status: queuedRunStatus,
          statusTimestamps: timestampsWithStatus(run.statusTimestamps, queuedRunStatus),
        }).where(and(
          eq(runs.id, job.runId),
          eq(runs.status, expectedRunStatus),
        )).returning({ id: runs.id });
    if (updatedRuns.length === 0) {
      // The run is no longer waiting for this job; drop the requeued job so it
      // is not left orphaned, the claim path reconciles any in-flight claim.
      await db.update(agentJobs).set({
        status: "canceled",
        completedAt: now,
        errorMessage: "Run is no longer waiting for this job",
      }).where(and(
        eq(agentJobs.id, job.id),
        eq(agentJobs.status, "queued"),
      ));
      continue;
    }
    recoveredJobs.push({ jobId: job.id, runId: job.runId, runStatus: queuedRunStatus });
  }

  for (const item of recoveredJobs) void reportRunVcsStatus(item.runId, item.runStatus);
  return recoveredJobs.map((item): string => item.jobId);
}

export async function authenticateAgent(
  agentId: string,
  authorization: string | null,
): Promise<Agent | undefined> {
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
  if (token.token === legacyTokenHash) {
    await db.update(agentPoolTokens).set({ token: tokenHash }).where(eq(agentPoolTokens.id, token.id));
  }
  const now = Date.now();
  if (token.lastUsedAt === null || now - token.lastUsedAt >= AGENT_TOKEN_LAST_USED_INTERVAL_MS) {
    await db.update(agentPoolTokens).set({ lastUsedAt: now }).where(eq(agentPoolTokens.id, token.id));
  }
  let refreshedAgent: Agent | undefined;
  // Persist the liveness heartbeat at most once per interval; within the
  // window the agent is kept fresh in memory only. Status transitions out
  // of "unknown" always persist so a recovered agent is visible promptly.
  if (
    agent.lastPingAt === null
    || now - agent.lastPingAt >= effectivePingWriteIntervalMs()
    || agent.status === "unknown"
  ) {
    const rows = await db.update(agents).set({
      lastPingAt: now,
      status: sql<string>`CASE WHEN ${agents.status} = 'unknown' THEN 'idle' ELSE ${agents.status} END`,
    }).where(eq(agents.id, agent.id)).returning();
    refreshedAgent = rows[0];
  }
  return refreshedAgent ?? { ...agent, lastPingAt: now };
}

async function claimedJobDetails(job: AgentJob): Promise<ClaimedAgentJob | undefined> {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, job.runId) });
  if (run === undefined) return undefined;
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
  const policyEvaluation = job.phase === "plan"
    ? await getAgentPolicyEvaluation(db, workspace)
    : null;
  return {
    job,
    run,
    workspace,
    configuration: configuration ?? null,
    inputState: inputState ?? null,
    planResult: planJob?.result ?? null,
    policyEvaluation,
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

async function findCandidateJob(agent: Agent, acceptedPhases: readonly string[], agentBinaries: readonly string[], skippedIds: ReadonlySet<string>): Promise<AgentJobRow | undefined> {
  return db.query.agentJobs.findFirst({
    where: and(
      eq(agentJobs.agentPoolId, agent.agentPoolId),
      eq(agentJobs.status, "queued"),
      inArray(agentJobs.phase, [...acceptedPhases]),
      inArray(agentJobs.iacBinary, agentBinaries),
      ...(skippedIds.size > 0 ? [notInArray(agentJobs.id, [...skippedIds])] : []),
    ),
    orderBy: [asc(agentJobs.createdAt)],
  });
}

async function tryClaimCandidate(candidate: AgentJobRow, agent: Agent): Promise<AgentJobRow | undefined> {
  const now = Date.now();
  const claimed = await db.update(agentJobs).set({ agentId: agent.id, status: "claimed", claimedAt: now }).where(and(eq(agentJobs.id, candidate.id), eq(agentJobs.status, "queued"))).returning();
  const claimedJob = claimed[0];
  if (claimedJob !== undefined) return claimedJob;
  return undefined;
}

async function validateCandidateRun(candidate: AgentJobRow): Promise<{ run: AgentRunRow; expectedRunStatus: string; nextRunStatus: string } | null> {
  const expectedRunStatus = candidate.phase === "plan" ? "plan_queued" : "apply_queued";
  const nextRunStatus = candidate.phase === "plan" ? "planning" : "applying";
  const run = await db.query.runs.findFirst({ where: eq(runs.id, candidate.runId) });
  if (run === undefined || run.status !== expectedRunStatus) {
    await db.update(agentJobs).set({ status: "canceled", completedAt: Date.now(), errorMessage: "Run is no longer waiting for this job" }).where(and(eq(agentJobs.id, candidate.id), eq(agentJobs.status, "claimed")));
    return null;
  }
  return { run, expectedRunStatus, nextRunStatus };
}


async function tryLockWorkspaceForApply(candidate: AgentJobRow, run: AgentRunRow, skippedApplyJobIds: Set<string>): Promise<"locked" | "skipped" | "no-lock"> {
  if (candidate.phase !== "apply") return "no-lock";
  const locked = await db.update(workspaces).set({ locked: true, lockedReason: `Run ${candidate.runId} is applying`, lockOwnerType: "agent-run", lockOwnerId: candidate.runId }).where(and(eq(workspaces.id, run.workspaceId), or(eq(workspaces.locked, false), isNull(workspaces.locked)))).returning({ id: workspaces.id });
  if (locked.length > 0) return "locked";
  skippedApplyJobIds.add(candidate.id);
  await db.update(agentJobs).set({ agentId: null, status: "queued", claimedAt: null }).where(and(eq(agentJobs.id, candidate.id), eq(agentJobs.status, "claimed")));
  return "skipped";
}

async function tryAssociateRun(candidate: AgentJobRow, run: AgentRunRow, agent: Agent, expectedRunStatus: string, nextRunStatus: string): Promise<{ id: string } | null> {
  const associated = await db.update(runs).set({ agentPoolId: agent.agentPoolId, agentId: agent.id, status: nextRunStatus, statusTimestamps: timestampsWithStatus(run.statusTimestamps, nextRunStatus) }).where(and(eq(runs.id, run.id), eq(runs.status, expectedRunStatus))).returning({ id: runs.id });
  if (associated.length > 0) return associated[0] as { id: string };
  if (candidate.phase === "apply") {
    await db.update(workspaces).set({ locked: false, lockedReason: null, lockOwnerType: null, lockOwnerId: null }).where(and(eq(workspaces.id, run.workspaceId), eq(workspaces.locked, true), eq(workspaces.lockOwnerType, "agent-run"), eq(workspaces.lockOwnerId, run.id)));
  }
  await db.update(agentJobs).set({ status: "canceled", completedAt: Date.now(), errorMessage: "Run is no longer waiting for this job" }).where(and(eq(agentJobs.id, candidate.id), eq(agentJobs.status, "claimed")));
  return null;
}

export async function claimAgentJob(
  agent: Agent,
  acceptedPhases: readonly string[] = ["plan", "apply"],
): Promise<ClaimedAgentJob | undefined> {
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
      const raced = await db.query.agentJobs.findFirst({ where: and(eq(agentJobs.agentId, agent.id), eq(agentJobs.status, "claimed")) });
      return raced === undefined ? undefined : await claimedJobDetails(raced);
    }
    const validation = await validateCandidateRun(candidate);
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
  await db.update(agentJobs).set({
    status: "canceled",
    completedAt: Date.now(),
    errorMessage: "Run canceled",
  }).where(and(
    eq(agentJobs.runId, runId),
    inArray(agentJobs.status, ["queued", "claimed"]),
  ));
  await db.update(workspaces).set({ locked: false, lockedReason: null, lockOwnerType: null, lockOwnerId: null }).where(and(
    eq(workspaces.locked, true),
    eq(workspaces.lockOwnerType, "agent-run"),
    eq(workspaces.lockOwnerId, runId),
  ));
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
  outputText: string,
): Promise<boolean> {
  const job = await db.query.agentJobs.findFirst({
    where: and(
      eq(agentJobs.id, jobId),
      eq(agentJobs.agentId, agentId),
      eq(agentJobs.status, "claimed"),
    ),
  });
  if (job === undefined) return false;
  await insertAgentJobLog(db, job, stripAnsiEscape(outputText), Date.now());
  return true;
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
): Promise<ClaimedAgentJob | undefined> {
  const job = await db.query.agentJobs.findFirst({
    where: and(
      eq(agentJobs.id, jobId),
      eq(agentJobs.agentId, agentId),
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
    id: `ajob-${crypto.randomUUID()}`,
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
    createdAt: Date.now(),
    requeueAttempts: 0,
  };
  await database.insert(agentJobs).values(job);
  const updated = await database.update(runs).set({
    agentPoolId,
    status: "apply_queued",
    statusTimestamps: timestampsWithStatus(statusTimestamps, "apply_queued"),
  }).where(and(eq(runs.id, runId), eq(runs.status, "confirmed"))).returning({ id: runs.id });
  if (updated.length === 0) throw new Error("Run changed while its agent apply job was queued");
  return job;
}

export async function enqueueAgentApplyJob(
  runId: string,
  agentPoolId: string,
): Promise<AgentJob | undefined> {
  const queued = await db.transaction(async (transaction): Promise<AgentJob | undefined> => {
    const tx = transaction as unknown as typeof db;
    const run = await tx.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run?.status !== "confirmed") return undefined;
    return insertAgentApplyJobTx(tx, runId, agentPoolId, run.statusTimestamps);
  });
  if (queued !== undefined) void reportRunVcsStatus(runId, "apply_queued");
  return queued;
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
  const updatedJobs = await database.update(agentJobs).set({
    status: terminal ? "canceled" : "queued",
    agentId: null,
    claimedAt: null,
    completedAt: terminal ? Date.now() : null,
    errorMessage: reason,
    requeueAttempts,
  }).where(and(
    eq(agentJobs.id, job.id),
    eq(agentJobs.agentId, agentId),
    eq(agentJobs.status, "claimed"),
  )).returning({ id: agentJobs.id });
  if (updatedJobs.length === 0) return;
  const nextRunStatus = terminal ? "errored" : job.phase === "plan" ? "plan_queued" : "apply_queued";
  if (run !== undefined) {
    await database.update(runs).set({
      agentId: null,
      status: nextRunStatus,
      statusTimestamps: timestampsWithStatus(run.statusTimestamps, nextRunStatus),
    }).where(and(eq(runs.id, run.id), eq(runs.status, expectedRunStatus)));
  }
  if (job.phase === "apply" && run !== undefined) {
    await database.update(workspaces).set({ locked: false, lockedReason: null, lockOwnerType: null, lockOwnerId: null }).where(and(
      eq(workspaces.id, run.workspaceId),
      eq(workspaces.locked, true),
      eq(workspaces.lockOwnerType, "agent-run"),
      eq(workspaces.lockOwnerId, run.id),
    ));
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
  if (job.phase === "apply" && completion.status === "completed" && (completion.statePayload === null || completion.statePayload === undefined)) {
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
  await requeueInvalidCompletion(database, agentId, job, run, expectedRunStatus, reason);
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
  const effectivePlanJson = completion.planJson ?? await readPlanJsonArtifact(run.id);
  const structuredPlanCounts = job.phase === "plan" && effectivePlanJson !== undefined
    ? planJsonResourceCounts(effectivePlanJson)
    : undefined;
  return { structuredPlanCounts, now: Date.now() };
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
  const updatedJobs = await database.update(agentJobs).set({
    status: jobStatus,
    result: { ...completion.result },
    errorMessage: completion.errorMessage,
    completedAt: now,
  }).where(and(
    eq(agentJobs.id, job.id),
    eq(agentJobs.agentId, agentId),
    eq(agentJobs.status, "claimed"),
  )).returning();
  return updatedJobs[0];
}

function resolvePlanStatus(policyOutcome: AgentPolicyOutcome, run: AgentRunRow): string {
  if (policyOutcome.hardFailed) return "errored";
  if (policyOutcome.softFailed) return "policy_soft_failed";
  if (run.savePlan) return "planned_and_saved";
  if (run.planOnly) return "planned_and_finished";
  if (run.autoApply || run.allowEmptyApply) return "apply_queued";
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
  const policyOutcome = await recordAgentPolicyChecks(
    database,
    workspace,
    run.id,
    completion.result,
    now,
  );
  return { policyOutcome, runStatus: resolvePlanStatus(policyOutcome, run) };
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
  const resourceValues = job.phase === "plan"
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
  const updatedRuns = await database.update(runs).set({
    status: runStatus,
    statusTimestamps: timestampsWithStatus(statusTimestamps, runStatus),
    ...(job.phase === "apply" && completion.status === "completed" ? { appliedAt: now } : {}),
    ...resourceValues,
  }).where(and(
    eq(runs.id, run.id),
    eq(runs.status, expectedRunStatus),
  )).returning({ id: runs.id });
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
  if (completion.status !== "completed" || job.phase !== "apply" || completion.statePayload === null) return;
  await insertStateVersionWithSerialTx(database, {
    id: crypto.randomUUID(),
    workspaceId: run.workspaceId,
    statePayload: await encryptStatePayload(completion.statePayload),
    jsonState: await encryptStatePayload(completion.jsonState ?? completion.statePayload),
    jsonStateOutputs: await encryptStatePayload(completion.jsonStateOutputs),
    runId: run.id,
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
  await database.update(workspaces).set({ locked: false, lockedReason: null, lockOwnerType: null, lockOwnerId: null }).where(and(
    eq(workspaces.id, run.workspaceId),
    eq(workspaces.locked, true),
    eq(workspaces.lockOwnerType, "agent-run"),
    eq(workspaces.lockOwnerId, run.id),
  ));
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
  await database.insert(agentJobs).values({
    id: `ajob-${crypto.randomUUID()}`,
    runId: run.id,
    agentPoolId: job.agentPoolId,
    phase: "apply",
    status: "queued",
    createdAt: now,
  });
}

async function completeAgentJobInTransaction(
  // Drizzle's transaction/query client is stateful by design.
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  database: Database,
  agentId: string,
  jobId: string,
  completion: AgentJobCompletion,
): Promise<CompletionResult | undefined> {
  const job = await database.query.agentJobs.findFirst({
    where: and(
      eq(agentJobs.id, jobId),
      eq(agentJobs.agentId, agentId),
      eq(agentJobs.status, "claimed"),
    ),
  });
  if (job === undefined) return undefined;
  const run = await database.query.runs.findFirst({ where: eq(runs.id, job.runId) });
  const expectedRunStatus = job.phase === "plan" ? "planning" : "applying";
  if (!await validateAgentCompletion(database, agentId, job, run, completion, expectedRunStatus)) return undefined;
  if (run === undefined) return undefined;
  const preparation = await prepareAgentCompletion(job, run, completion);
  const updatedJob = await persistAgentJobCompletion(database, agentId, job, completion, preparation.now);
  if (updatedJob === undefined) return undefined;
  const outcome = await determineCompletionOutcome(database, job, run, completion, preparation.now);
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

export async function completeAgentJob(
  agentId: string,
  jobId: string,
  completion: AgentJobCompletion,
): Promise<Readonly<{ job: AgentJob; runStatus: string }> | undefined> {
  const outcome = await db.transaction(async (transaction): Promise<CompletionResult | undefined> =>
    completeAgentJobInTransaction(transaction as unknown as Database, agentId, jobId, completion));
  if (outcome !== undefined) notifyRunStatus(outcome.job.runId, outcome.runStatus);
  return outcome;
}
