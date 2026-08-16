import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
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
  const tokenHash = createHash("sha256").update(authorization.slice(7)).digest("hex");
  const token = await db.query.agentPoolTokens.findFirst({
    where: and(
      eq(agentPoolTokens.agentPoolId, agent.agentPoolId),
      eq(agentPoolTokens.token, tokenHash),
    ),
  });
  if (token === undefined) return undefined;
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
    refreshedAgent = rows[0] as Agent | undefined;
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

export async function claimAgentJob(agent: Agent): Promise<ClaimedAgentJob | undefined> {
  const existing = await db.query.agentJobs.findFirst({
    where: and(
      eq(agentJobs.agentId, agent.id),
      eq(agentJobs.status, "claimed"),
    ),
    orderBy: [asc(agentJobs.claimedAt)],
  });
  if (existing !== undefined) return claimedJobDetails(existing);

  // Capability routing: only jobs whose resolved IaC binary the agent
  // declared at registration are claimable. A plain tfc-agent (default
  // ["terraform"]) can never claim a tofu job; it waits for an agent that
  // declared tofu. Fall back to terraform-only for rows predating the
  // column default (defensive; the DDL default covers new rows).
  const agentBinaries = agent.iacBinaries !== null && agent.iacBinaries.length > 0
    ? agent.iacBinaries
    : ["terraform"];

  for (let attempts = 0; attempts < 10; attempts += 1) {
    const candidate = await db.query.agentJobs.findFirst({
      where: and(
        eq(agentJobs.agentPoolId, agent.agentPoolId),
        eq(agentJobs.status, "queued"),
        inArray(agentJobs.iacBinary, agentBinaries),
      ),
      orderBy: [asc(agentJobs.createdAt)],
    });
    if (candidate === undefined) return undefined;

    const now = Date.now();
    const claimed = await db.update(agentJobs).set({
      agentId: agent.id,
      status: "claimed",
      claimedAt: now,
    }).where(and(
      eq(agentJobs.id, candidate.id),
      eq(agentJobs.status, "queued"),
    )).returning();
    const claimedJob = claimed[0];
    if (claimedJob === undefined) {
      const raced = await db.query.agentJobs.findFirst({
        where: and(eq(agentJobs.agentId, agent.id), eq(agentJobs.status, "claimed")),
      });
      return raced === undefined ? undefined : await claimedJobDetails(raced);
    }

    const expectedRunStatus = candidate.phase === "plan" ? "plan_queued" : "apply_queued";
    const nextRunStatus = candidate.phase === "plan" ? "planning" : "applying";
    const run = await db.query.runs.findFirst({ where: eq(runs.id, candidate.runId) });
    if (run?.status !== expectedRunStatus) {
      await db.update(agentJobs).set({
        status: "canceled",
        completedAt: Date.now(),
        errorMessage: "Run is no longer waiting for this job",
      }).where(and(eq(agentJobs.id, candidate.id), eq(agentJobs.status, "claimed")));
      continue;
    }
    const associated = await db.update(runs).set({
      agentPoolId: agent.agentPoolId,
      agentId: agent.id,
      status: nextRunStatus,
      statusTimestamps: timestampsWithStatus(run.statusTimestamps, nextRunStatus),
    }).where(and(
      eq(runs.id, run.id),
      eq(runs.status, expectedRunStatus),
    )).returning({ id: runs.id });
    if (associated.length === 0) {
      await db.update(agentJobs).set({
        status: "canceled",
        completedAt: Date.now(),
        errorMessage: "Run is no longer waiting for this job",
      }).where(and(eq(agentJobs.id, candidate.id), eq(agentJobs.status, "claimed")));
      continue;
    }
    await db.update(agents).set({ status: "busy", lastPingAt: now }).where(eq(agents.id, agent.id));
    notifyRunStatus(claimedJob.runId, claimedJob.phase === "plan" ? "planning" : "applying");
    return await claimedJobDetails(claimedJob);
  }
  return undefined;
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
  await insertAgentJobLog(db, job, outputText, Date.now());
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

export async function completeAgentJob(
  agentId: string,
  jobId: string,
  completion: AgentJobCompletion,
): Promise<Readonly<{ job: AgentJob; runStatus: string }> | undefined> {
  const outcome = await db.transaction(async (transaction): Promise<Readonly<{ job: AgentJob; runStatus: string }> | undefined> => {
    const tx = transaction as unknown as typeof db;
    const job = await tx.query.agentJobs.findFirst({
      where: and(
        eq(agentJobs.id, jobId),
        eq(agentJobs.agentId, agentId),
        eq(agentJobs.status, "claimed"),
      ),
    });
    if (job === undefined) return undefined;
    const run = await tx.query.runs.findFirst({ where: eq(runs.id, job.runId) });
    const expectedRunStatus = job.phase === "plan" ? "planning" : "applying";
    if (run?.status !== expectedRunStatus) return undefined;
    if (completion.planJson !== null && (completion.status !== "completed" || job.phase !== "plan")) {
      return undefined;
    }
    if (completion.planJson !== null) {
      await writePlanJsonArtifact(run.id, completion.planJson);
    }
    // Modern agent protocol uploads the plan JSON separately (PUT to the job's
    // plan-json URL) before completing; fall back to the stored artifact so
    // resource counts are still derived from the real plan.
    const effectivePlanJson = completion.planJson !== null
      ? completion.planJson
      : await readPlanJsonArtifact(run.id);
    const structuredPlanCounts = job.phase === "plan" && effectivePlanJson !== undefined
      ? planJsonResourceCounts(effectivePlanJson)
      : undefined;

    const now = Date.now();
    if (completion.status === "errored" && completion.errorMessage !== null && completion.errorMessage !== "") {
      await insertAgentJobLog(tx, job, `[agent error] ${completion.errorMessage}`, now);
    }
    const jobStatus = completion.status === "completed" ? "completed" : "errored";
    const updatedJobs = await tx.update(agentJobs).set({
      status: jobStatus,
      result: { ...completion.result },
      errorMessage: completion.errorMessage,
      completedAt: now,
    }).where(and(
      eq(agentJobs.id, job.id),
      eq(agentJobs.agentId, agentId),
      eq(agentJobs.status, "claimed"),
    )).returning();
    const updatedJob = updatedJobs[0];
    if (updatedJob === undefined) return undefined;

    let policyOutcome: AgentPolicyOutcome = {
      evaluated: false,
      hardFailed: false,
      softFailed: false,
    };
    let runStatus = "errored";
    if (completion.status === "completed" && job.phase === "plan") {
      const workspace = await tx.query.workspaces.findFirst({
        where: eq(workspaces.id, run.workspaceId),
      });
      if (workspace === undefined) throw new Error("Agent workspace disappeared during completion");
      policyOutcome = await recordAgentPolicyChecks(
        tx,
        workspace,
        run.id,
        completion.result,
        now,
      );
      runStatus = policyOutcome.hardFailed
        ? "errored"
        : policyOutcome.softFailed
          ? "policy_soft_failed"
          : run.planOnly
            ? "planned_and_finished"
            : run.savePlan
              ? "planned_and_saved"
              : run.autoApply || run.allowEmptyApply
                ? "apply_queued"
                : "planned";
    } else if (completion.status === "completed") {
      runStatus = "applied";
    }

    let statusTimestamps = run.statusTimestamps;
    if (completion.status === "completed" && job.phase === "plan") {
      statusTimestamps = timestampsWithStatus(statusTimestamps, "planned");
    }
    if (policyOutcome.evaluated) {
      statusTimestamps = timestampsWithStatus(statusTimestamps, "policy_checking");
      if (policyOutcome.softFailed && !policyOutcome.hardFailed) {
        statusTimestamps = timestampsWithStatus(statusTimestamps, "policy_override");
      } else if (!policyOutcome.hardFailed) {
        statusTimestamps = timestampsWithStatus(statusTimestamps, "policy_checked");
      }
    }
    const updatedRuns = await tx.update(runs).set({
      status: runStatus,
      statusTimestamps: timestampsWithStatus(statusTimestamps, runStatus),
      ...(job.phase === "plan"
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
          }),
    }).where(and(
      eq(runs.id, run.id),
      eq(runs.status, expectedRunStatus),
    )).returning({ id: runs.id });
    if (updatedRuns.length === 0) throw new Error("Run changed while its agent job was completing");

    if (completion.status === "completed" && job.phase === "plan" && runStatus === "apply_queued") {
      await tx.insert(agentJobs).values({
        id: `ajob-${crypto.randomUUID()}`,
        runId: run.id,
        agentPoolId: job.agentPoolId,
        phase: "apply",
        status: "queued",
        createdAt: now,
      });
    }

    if (completion.status === "completed" && job.phase === "apply" && completion.statePayload !== null) {
      const latestState = await tx.query.stateVersions.findFirst({
        where: eq(stateVersions.workspaceId, run.workspaceId),
        orderBy: [desc(stateVersions.serial)],
      });
      await tx.insert(stateVersions).values({
        id: crypto.randomUUID(),
        workspaceId: run.workspaceId,
        serial: (latestState?.serial ?? 0) + 1,
        statePayload: completion.statePayload,
        jsonState: completion.jsonState ?? completion.statePayload,
        jsonStateOutputs: completion.jsonStateOutputs,
        runId: run.id,
        status: "finalized",
        createdAt: now,
      });
    }

    await tx.update(agents).set({ status: "idle", lastPingAt: now }).where(eq(agents.id, agentId));
    return { job: updatedJob, runStatus };
  });
  if (outcome !== undefined) notifyRunStatus(outcome.job.runId, outcome.runStatus);
  return outcome;
}
