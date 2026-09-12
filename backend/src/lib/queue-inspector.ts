import { and, asc, eq, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  agentJobs,
  agentPools,
  agents,
  runs,
  workspaces,
} from "../db/schema";
import { agentPoolAllowsWorkspace } from "./agent-pool-scope";
import { configuredHeartbeatTimeoutMs, isAgentLiveForClaim } from "./agent-jobs";
import { applyGateBlockReason } from "./operations";
import { isMaintenanceActive, maintenanceSnapshot } from "./maintenance";
import { storageDegradedReason } from "./storage-health";
import { FINAL_RUN_STATUSES, WORKSPACE_BLOCKING_RUN_STATUSES, type DeepReadonly } from "./utils";

/** A queue explanation is a point-in-time diagnostic, never a scheduling lock. */
export type QueueInspectionState = "ready" | "waiting" | "blocked" | "running" | "unknown";

export type QueueInspection = Readonly<{
  state: QueueInspectionState;
  reasonCode: string;
  reason: string;
  phase: "plan" | "apply" | null;
  position: number | null;
  positionQualified: boolean;
  positionAsOf: string;
  positionNote: string | null;
  scheduledAt: string | null;
  requiredCapabilities: readonly string[];
  competingJobClass: string | null;
  constraints: readonly string[];
  workspace: Readonly<{
    id: string;
    name: string;
    locked: boolean;
    lockReason: string | null;
    serializationBlocked: boolean;
  }>;
  agentPool: Readonly<{
    id: string | null;
    name: string | null;
    totalAgents: number;
    liveAgents: number;
    matchingAgents: number;
    availableAgents: number;
    busyAgents: number;
    staleAgents: number;
  }>;
}>;

export type QueueInspectorContext = Readonly<{
  now?: number;
  workerDraining?: boolean;
  localConcurrencyLimit?: number;
  localExecuting?: number;
  applyGateReason?: string | null;
}>;

type RunRow = DeepReadonly<typeof runs.$inferSelect>;
type WorkspaceRow = DeepReadonly<typeof workspaces.$inferSelect>;
type PoolRow = DeepReadonly<typeof agentPools.$inferSelect>;
type AgentRow = DeepReadonly<typeof agents.$inferSelect>;

const POSITION_NOTE = "Estimate from the scheduler order at this snapshot; new claims, cancellations, locks and worker heartbeats can change it.";
const NO_POOL = Object.freeze({
  id: null,
  name: null,
  totalAgents: 0,
  liveAgents: 0,
  matchingAgents: 0,
  availableAgents: 0,
  busyAgents: 0,
  staleAgents: 0,
});

function iso(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function queuePhase(run: RunRow): "plan" | "apply" | null {
  if (run.status === "plan_queued" || run.status === "planning" || run.status === "pending" || run.status === "queuing") return "plan";
  if (run.status === "apply_queued" || run.status === "applying" || run.status === "confirmed") return "apply";
  return null;
}

function baseInspection(
  run: RunRow,
  workspace: WorkspaceRow,
  context: Required<Pick<QueueInspectorContext, "now">>,
): QueueInspection {
  return {
    state: "unknown",
    reasonCode: "not-queueable",
    reason: "This run is not waiting for a scheduler claim.",
    phase: queuePhase(run),
    position: null,
    positionQualified: false,
    positionAsOf: new Date(context.now).toISOString(),
    positionNote: null,
    scheduledAt: iso(run.scheduledAt),
    requiredCapabilities: [],
    competingJobClass: null,
    constraints: [],
    workspace: {
      id: workspace.id,
      name: workspace.name,
      locked: workspace.locked === true,
      lockReason: workspace.lockedReason ?? null,
      serializationBlocked: false,
    },
    agentPool: NO_POOL,
  };
}

function withPosition(
  inspection: QueueInspection,
  position: number | null,
  qualified = true,
): QueueInspection {
  return {
    ...inspection,
    position,
    positionQualified: qualified && position !== null,
    positionNote: position === null ? null : POSITION_NOTE,
  };
}

async function pendingPosition(run: RunRow): Promise<number | null> {
  const rows = await db.select({ count: sql<number>`count(*)` }).from(runs).where(and(
    eq(runs.status, "pending"),
    or(
      lt(runs.createdAt, run.createdAt),
      and(eq(runs.createdAt, run.createdAt), lt(runs.id, run.id)),
    ),
  ));
  const count = rows[0]?.count;
  return typeof count === "number" && Number.isSafeInteger(count) ? count + 1 : null;
}

async function workspaceSerializationBlocker(run: RunRow): Promise<{ blocked: boolean; status: string | null }> {
  if (run.planOnly === true || run.savePlan === true) return { blocked: false, status: null };
  const blocker = await db.query.runs.findFirst({
    where: and(
      eq(runs.workspaceId, run.workspaceId),
      inArray(runs.status, WORKSPACE_BLOCKING_RUN_STATUSES),
      eq(runs.planOnly, false),
      eq(runs.savePlan, false),
      notInArray(runs.id, [run.id]),
    ),
    orderBy: [asc(runs.createdAt), asc(runs.id)],
    columns: { status: true },
  });
  return { blocked: blocker !== undefined, status: blocker?.status ?? null };
}

function binaryFor(workspace: WorkspaceRow): string {
  return workspace.iacBinary ?? "terraform";
}

function poolSummary(
  pool: PoolRow,
  agentsInPool: readonly AgentRow[],
  claimedAgentIds: Readonly<ReadonlySet<string>>,
  requiredBinary: string,
  now: number,
): QueueInspection["agentPool"] {
  const live = agentsInPool.filter((agent): boolean => isAgentLiveForClaim(agent, now));
  const matching = live.filter((agent): boolean => (agent.iacBinaries ?? ["terraform"]).includes(requiredBinary));
  const available = matching.filter((agent): boolean => !claimedAgentIds.has(agent.id));
  const stale = agentsInPool.filter((agent): boolean => !isAgentLiveForClaim(agent, now)).length;
  return {
    id: pool.id,
    name: pool.name,
    totalAgents: agentsInPool.length,
    liveAgents: live.length,
    matchingAgents: matching.length,
    availableAgents: available.length,
    busyAgents: matching.length - available.length,
    staleAgents: stale,
  };
}

async function inspectPool(
  workspace: WorkspaceRow,
  requiredBinary: string,
  now: number,
): Promise<{ pool: QueueInspection["agentPool"]; reasonCode: string | null; reason: string | null; constraints: string[] }> {
  const pool = workspace.agentPoolId === null
    ? undefined
    : await db.query.agentPools.findFirst({ where: eq(agentPools.id, workspace.agentPoolId) });
  if (pool === undefined || pool.orgId !== workspace.orgId) {
    return {
      pool: NO_POOL,
      reasonCode: "agent-pool-missing",
      reason: "The workspace points at an agent pool that is missing or belongs to another organization.",
      constraints: ["agent-pool must exist and belong to the workspace organization"],
    };
  }
  const [agentsInPool, claimedJobs] = await Promise.all([
    db.query.agents.findMany({ where: eq(agents.agentPoolId, pool.id) }),
    db.query.agentJobs.findMany({ where: and(eq(agentJobs.agentPoolId, pool.id), eq(agentJobs.status, "claimed")), columns: { agentId: true } }),
  ]);
  const claimedAgentIds = new Set(claimedJobs.map((job): string | null => job.agentId).filter((id): id is string => id !== null));
  const summary = poolSummary(pool, agentsInPool, claimedAgentIds, requiredBinary, now);
  const allowed = await agentPoolAllowsWorkspace(pool, workspace.id, workspace.projectId);
  if (!allowed) {
    return {
      pool: summary,
      reasonCode: "agent-pool-scope",
      reason: "The agent pool is not allowed to execute this workspace.",
      constraints: ["agent-pool workspace/project scope must include this workspace"],
    };
  }
  if (summary.matchingAgents === 0) {
    return {
      pool: summary,
      reasonCode: "no-eligible-agent",
      reason: `No live agent in this pool advertises the required ${requiredBinary} capability.`,
      constraints: [`live agent with iac-binaries including ${requiredBinary}`],
    };
  }
  if (summary.availableAgents === 0) {
    return {
      pool: summary,
      reasonCode: "all-eligible-agents-busy",
      reason: `All ${summary.matchingAgents} live agents with ${requiredBinary} capability already have a claimed job.`,
      constraints: [`live ${requiredBinary} agent without a claimed job`],
    };
  }
  return {
    pool: summary,
    reasonCode: null,
    reason: null,
    constraints: [`live ${requiredBinary} agent without a claimed job`],
  };
}

async function agentJobPosition(job: Readonly<{ id: string; agentPoolId: string; iacBinary: string; createdAt: number }>): Promise<number | null> {
  const rows = await db.select({ count: sql<number>`count(*)` }).from(agentJobs).where(and(
    eq(agentJobs.agentPoolId, job.agentPoolId),
    eq(agentJobs.status, "queued"),
    eq(agentJobs.iacBinary, job.iacBinary),
    or(
      lt(agentJobs.createdAt, job.createdAt),
      and(eq(agentJobs.createdAt, job.createdAt), lt(agentJobs.id, job.id)),
    ),
  ));
  const count = rows[0]?.count;
  return typeof count === "number" && Number.isSafeInteger(count) ? count + 1 : null;
}

async function inspectQueuedAgentJob(
  run: RunRow,
  workspace: WorkspaceRow,
  job: DeepReadonly<typeof agentJobs.$inferSelect>,
  context: Required<Pick<QueueInspectorContext, "now">>,
): Promise<QueueInspection> {
  const requiredBinary = job.iacBinary || binaryFor(workspace);
  const base = baseInspection(run, workspace, context);
  const poolInspection = await inspectPool(workspace, requiredBinary, context.now);
  const position = await agentJobPosition(job);
  const constraints = [...poolInspection.constraints];
  if (job.phase === "apply") constraints.push("workspace must be unlocked before an apply claim");
  if (job.phase === "plan") constraints.push("run must remain in plan_queued while waiting");
  if (run.status !== (job.phase === "plan" ? "plan_queued" : "apply_queued")) {
    return withPosition({
      ...base,
      state: "blocked",
      reasonCode: "run-state-changed",
      reason: "The queued job no longer matches the run state required by the claim path.",
      phase: job.phase as "plan" | "apply",
      requiredCapabilities: [requiredBinary],
      competingJobClass: "run",
      constraints,
      agentPool: poolInspection.pool,
    }, position);
  }
  if (poolInspection.reasonCode !== null) {
    return withPosition({
      ...base,
      state: "waiting",
      reasonCode: poolInspection.reasonCode,
      reason: poolInspection.reason ?? "The agent pool is not currently claimable.",
      phase: job.phase as "plan" | "apply",
      requiredCapabilities: [requiredBinary],
      competingJobClass: "run",
      constraints,
      agentPool: poolInspection.pool,
    }, position);
  }
  if (job.phase === "apply" && workspace.locked === true) {
    return withPosition({
      ...base,
      state: "waiting",
      reasonCode: "workspace-lock",
      reason: workspace.lockedReason === null || workspace.lockedReason === ""
        ? "The workspace is locked, so the apply claim will retry later."
        : `The workspace is locked: ${workspace.lockedReason}`,
      phase: "apply",
      requiredCapabilities: [requiredBinary],
      competingJobClass: "run",
      constraints,
      agentPool: poolInspection.pool,
    }, position);
  }
  return withPosition({
    ...base,
    state: "ready",
    reasonCode: "agent-capacity-available",
    reason: `A live ${requiredBinary} agent is available; the next poll may claim this job.`,
    phase: job.phase as "plan" | "apply",
    requiredCapabilities: [requiredBinary],
    competingJobClass: "run",
    constraints,
    agentPool: poolInspection.pool,
  }, position);
}

type PoolInspection = Awaited<ReturnType<typeof inspectPool>>;

function pendingEarlyBlock(
  base: QueueInspection,
  position: number | null,
  workspace: WorkspaceRow,
  context: Required<Pick<QueueInspectorContext, "now">> & QueueInspectorContext,
): QueueInspection | null {
  const phase = "plan" as const;
  const maintenance = maintenanceSnapshot();
  if (maintenance.active || isMaintenanceActive()) {
    return withPosition({ ...base, state: "blocked", reasonCode: "maintenance", reason: maintenance.reason ?? "Run claims are paused while maintenance mode is active.", phase, constraints: ["maintenance gate must be open"] }, position);
  }
  if (context.workerDraining === true) {
    return withPosition({ ...base, state: "blocked", reasonCode: "worker-draining", reason: "The worker is draining and will not claim new runs.", phase, constraints: ["worker drain must be inactive"] }, position);
  }
  const storageReason = storageDegradedReason();
  if (storageReason !== null) {
    return withPosition({ ...base, state: "blocked", reasonCode: "storage-degraded", reason: `Run claims are paused: ${storageReason}`, phase, constraints: ["storage health must be normal"] }, position);
  }
  if (workspace.locked === true) {
    return withPosition({ ...base, state: "waiting", reasonCode: "workspace-lock", reason: workspace.lockedReason === null || workspace.lockedReason === "" ? "The workspace is locked; this run waits for it to be unlocked." : `The workspace is locked: ${workspace.lockedReason}`, phase, constraints: ["workspace must be unlocked"], workspace: { ...base.workspace, serializationBlocked: false } }, position);
  }
  return null;
}

function pendingAgentInspection(
  base: QueueInspection,
  position: number | null,
  requiredBinary: string,
  poolInspection: PoolInspection,
): QueueInspection {
  const phase = "plan" as const;
  const poolBase = { ...base, phase, requiredCapabilities: [requiredBinary], competingJobClass: "run", agentPool: poolInspection.pool, constraints: poolInspection.constraints };
  if (poolInspection.reasonCode !== null) {
    return withPosition({ ...poolBase, state: poolInspection.reasonCode === "agent-pool-scope" || poolInspection.reasonCode === "agent-pool-missing" ? "blocked" : "waiting", reasonCode: poolInspection.reasonCode, reason: poolInspection.reason ?? "The agent pool is not currently claimable." }, position);
  }
  return withPosition({ ...poolBase, state: "ready", reasonCode: "agent-capacity-available", reason: "The worker can enqueue this run for a compatible agent on its next poll." }, position);
}

function pendingLocalInspection(
  base: QueueInspection,
  position: number | null,
  workspace: WorkspaceRow,
  context: Required<Pick<QueueInspectorContext, "now">> & QueueInspectorContext,
): QueueInspection {
  const phase = "plan" as const;
  if (workspace.executionMode === "local") {
    return withPosition({ ...base, state: "blocked", reasonCode: "local-execution-disabled", reason: "This workspace is configured for local execution; the server will not claim this remote run.", phase, constraints: ["workspace execution mode must not be local"] }, position);
  }
  const limit = context.localConcurrencyLimit;
  const executing = context.localExecuting;
  if (limit !== undefined && executing !== undefined && executing >= limit) {
    return withPosition({ ...base, state: "waiting", reasonCode: "local-capacity", reason: `All ${limit} local execution slots are busy.`, phase, constraints: [`local executions below concurrency limit (${executing}/${limit})`] }, position);
  }
  return withPosition({ ...base, state: "ready", reasonCode: "local-capacity-available", reason: "A local execution slot is available; the worker can claim this run on its next poll.", phase, constraints: ["workspace serialization permits this run", "local execution slot available"] }, position);
}

async function inspectPendingRun(
  run: RunRow,
  workspace: WorkspaceRow,
  context: Required<Pick<QueueInspectorContext, "now">> & QueueInspectorContext,
): Promise<QueueInspection> {
  const base = baseInspection(run, workspace, context);
  const position = await pendingPosition(run);
  const early = pendingEarlyBlock(base, position, workspace, context);
  if (early !== null) return early;
  const serialization = await workspaceSerializationBlocker(run);
  if (serialization.blocked) {
    return withPosition({ ...base, state: "waiting", reasonCode: "workspace-serialization", reason: `Another ${serialization.status ?? "active"} run is using this workspace.`, phase: "plan", constraints: ["workspace serialization permits one blocking run"] , workspace: { ...base.workspace, serializationBlocked: true } }, position);
  }
  if (workspace.executionMode === "agent") {
    const requiredBinary = binaryFor(workspace);
    const poolInspection = await inspectPool(workspace, requiredBinary, context.now);
    return pendingAgentInspection(base, position, requiredBinary, poolInspection);
  }
  return pendingLocalInspection(base, position, workspace, context);
}

function confirmedScheduleBlock(base: QueueInspection, run: RunRow, now: number): QueueInspection | null {
  const scheduledAt = run.scheduledAt;
  if (scheduledAt === null || scheduledAt === undefined) {
    return { ...base, state: "waiting", reasonCode: "awaiting-apply", reason: "The plan is confirmed and is waiting for an apply action.", phase: "apply", constraints: ["an apply action or schedule is required"] };
  }
  if (scheduledAt > now) {
    return { ...base, state: "waiting", reasonCode: "scheduled", reason: "The scheduled apply time has not arrived.", phase: "apply", scheduledAt: iso(scheduledAt), constraints: ["scheduled-at must be in the past"] };
  }
  return null;
}

function confirmedLockBlock(base: QueueInspection, workspace: WorkspaceRow): QueueInspection | null {
  if (workspace.locked !== true) return null;
  return { ...base, state: "waiting", reasonCode: "workspace-lock", reason: workspace.lockedReason === null || workspace.lockedReason === "" ? "The scheduled apply is waiting for the workspace lock to clear." : `The workspace is locked: ${workspace.lockedReason}`, phase: "apply", constraints: ["workspace must be unlocked"] };
}

function confirmedAgentApply(base: QueueInspection, requiredBinary: string, poolInspection: PoolInspection): QueueInspection {
  return {
    ...base,
    state: poolInspection.reasonCode === null ? "ready" : poolInspection.reasonCode === "agent-pool-scope" || poolInspection.reasonCode === "agent-pool-missing" ? "blocked" : "waiting",
    reasonCode: poolInspection.reasonCode ?? "agent-capacity-available",
    reason: poolInspection.reason ?? "A compatible agent is available; the scheduled apply can be queued.",
    phase: "apply",
    requiredCapabilities: [requiredBinary],
    competingJobClass: "run",
    constraints: poolInspection.constraints,
    agentPool: poolInspection.pool,
  };
}

function confirmedLocalApply(
  base: QueueInspection,
  context: Required<Pick<QueueInspectorContext, "now">> & QueueInspectorContext,
): QueueInspection {
  if (context.localConcurrencyLimit !== undefined && context.localExecuting !== undefined && context.localExecuting >= context.localConcurrencyLimit) {
    return { ...base, state: "waiting", reasonCode: "local-capacity", reason: `All ${context.localConcurrencyLimit} local execution slots are busy.`, phase: "apply", constraints: [`local executions below concurrency limit (${context.localExecuting}/${context.localConcurrencyLimit})`] };
  }
  return { ...base, state: "ready", reasonCode: "local-capacity-available", reason: "The scheduled apply is due and a local execution slot is available.", phase: "apply", constraints: ["apply gates must be open", "local execution slot available"] };
}

async function inspectConfirmedRun(
  run: RunRow,
  workspace: WorkspaceRow,
  context: Required<Pick<QueueInspectorContext, "now">> & QueueInspectorContext,
): Promise<QueueInspection> {
  const base = baseInspection(run, workspace, context);
  const scheduled = confirmedScheduleBlock(base, run, context.now);
  if (scheduled !== null) return scheduled;
  const locked = confirmedLockBlock(base, workspace);
  if (locked !== null) return locked;
  const gateReason = context.applyGateReason === undefined ? await applyGateBlockReason(new Date(context.now)) : context.applyGateReason;
  if (gateReason !== null) {
    return { ...base, state: "waiting", reasonCode: "apply-gate", reason: gateReason, phase: "apply", constraints: ["approval, maintenance and storage apply gates must be open"] };
  }
  if (workspace.executionMode === "local") {
    return { ...base, state: "blocked", reasonCode: "local-execution-disabled", reason: "This workspace is configured for local execution; the server will not dispatch this scheduled apply.", phase: "apply", constraints: ["workspace execution mode must not be local"] };
  }
  if (workspace.executionMode === "agent") {
    const requiredBinary = binaryFor(workspace);
    const poolInspection = await inspectPool(workspace, requiredBinary, context.now);
    return confirmedAgentApply(base, requiredBinary, poolInspection);
  }
  return confirmedLocalApply(base, context);
}

/** Inspect one run using the same pool, lock and serialization constraints used by workers. */
export async function inspectRunQueue(run: RunRow, options: QueueInspectorContext = {}): Promise<QueueInspection> {
  const now = options.now ?? Date.now();
  const context = { ...options, now } as Required<Pick<QueueInspectorContext, "now">> & QueueInspectorContext;
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, run.workspaceId) });
  if (workspace === undefined) {
    return {
      state: "unknown",
      reasonCode: "workspace-missing",
      reason: "The run references a workspace that no longer exists.",
      phase: queuePhase(run),
      position: null,
      positionQualified: false,
      positionAsOf: new Date(now).toISOString(),
      positionNote: null,
      scheduledAt: iso(run.scheduledAt),
      requiredCapabilities: [],
      competingJobClass: null,
      constraints: [],
      workspace: { id: run.workspaceId, name: "Unknown workspace", locked: false, lockReason: null, serializationBlocked: false },
      agentPool: NO_POOL,
    };
  }
  if (FINAL_RUN_STATUSES.includes(run.status)) return baseInspection(run, workspace, context);
  if (run.status === "pending" || run.status === "queuing") return inspectPendingRun(run, workspace, context);
  if (run.status === "confirmed") return inspectConfirmedRun(run, workspace, context);
  if (run.status === "plan_queued" || run.status === "apply_queued") {
    const job = await db.query.agentJobs.findFirst({ where: and(eq(agentJobs.runId, run.id), eq(agentJobs.phase, run.status === "plan_queued" ? "plan" : "apply"), eq(agentJobs.status, "queued")) });
    if (job === undefined) {
      return { ...baseInspection(run, workspace, context), state: "unknown", reasonCode: "job-missing", reason: "The run is queued but its agent job is not present; worker reconciliation will decide its next state." };
    }
    return inspectQueuedAgentJob(run, workspace, job, context);
  }
  const running = baseInspection(run, workspace, context);
  return { ...running, state: "running", reasonCode: "already-running", reason: "The scheduler has claimed this run and it is executing.", phase: queuePhase(run) };
}

/** Convert internal names to the JSON:API field names used by admin clients. */
export function queueInspectionResource(value: QueueInspection): Record<string, unknown> {
  return {
    state: value.state,
    "reason-code": value.reasonCode,
    reason: value.reason,
    phase: value.phase,
    position: value.position,
    "position-qualified": value.positionQualified,
    "position-as-of": value.positionAsOf,
    "position-note": value.positionNote,
    "scheduled-at": value.scheduledAt,
    "required-capabilities": value.requiredCapabilities,
    "competing-job-class": value.competingJobClass,
    "eligibility-constraints": value.constraints,
    workspace: {
      id: value.workspace.id,
      name: value.workspace.name,
      locked: value.workspace.locked,
      "lock-reason": value.workspace.lockReason,
      "serialization-blocked": value.workspace.serializationBlocked,
    },
    "agent-pool": {
      id: value.agentPool.id,
      name: value.agentPool.name,
      "total-agents": value.agentPool.totalAgents,
      "live-agents": value.agentPool.liveAgents,
      "matching-agents": value.agentPool.matchingAgents,
      "available-agents": value.agentPool.availableAgents,
      "busy-agents": value.agentPool.busyAgents,
      "stale-agents": value.agentPool.staleAgents,
    },
  };
}

export async function queueInspectorCapacity(now = Date.now()): Promise<Record<string, unknown>> {
  const [poolRows, agentRows, queuedRows, claimedRows] = await Promise.all([
    db.query.agentPools.findMany({ columns: { id: true, name: true } }),
    db.query.agents.findMany({ columns: { id: true, agentPoolId: true, status: true, lastPingAt: true, iacBinaries: true } }),
    db.query.agentJobs.findMany({ where: eq(agentJobs.status, "queued"), columns: { agentPoolId: true } }),
    db.query.agentJobs.findMany({ where: eq(agentJobs.status, "claimed"), columns: { agentPoolId: true, agentId: true } }),
  ]);
  const claimedByAgent = new Set(claimedRows.map((row): string | null => row.agentId).filter((id): id is string => id !== null));
  const pools = poolRows.map((pool): Record<string, unknown> => {
    const poolAgents = agentRows.filter((agent): boolean => agent.agentPoolId === pool.id);
    const live = poolAgents.filter((agent): boolean => isAgentLiveForClaim(agent, now));
    return {
      id: pool.id,
      name: pool.name,
      agents: poolAgents.length,
      "live-agents": live.length,
      "available-agents": live.filter((agent): boolean => !claimedByAgent.has(agent.id)).length,
      "queued-jobs": queuedRows.filter((job): boolean => job.agentPoolId === pool.id).length,
      "claimed-jobs": claimedRows.filter((job): boolean => job.agentPoolId === pool.id).length,
    };
  });
  return {
    "snapshot-at": new Date(now).toISOString(),
    "heartbeat-timeout-ms": configuredHeartbeatTimeoutMs(),
    pools,
  };
}
