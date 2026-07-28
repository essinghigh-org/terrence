import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  agentJobs,
  agentPoolTokens,
  agents,
  configurationVersions,
  logs,
  runs,
  stateVersions,
  workspaces,
} from "../db/schema";
import { queueRunNotification } from "./notifications";
import { reportRunVcsStatus } from "./webhooks";

export type AgentJobPhase = "plan" | "apply";

export type AgentJobCompletion = Readonly<{
  status: "completed" | "errored";
  errorMessage: string | null;
  resourceAdditions: number | null;
  resourceChanges: number | null;
  resourceDestructions: number | null;
  statePayload: string | null;
  jsonState: string | null;
  jsonStateOutputs: string | null;
  result: Readonly<Record<string, unknown>>;
}>;

type DeepReadonly<T> = T extends readonly (infer Value)[]
  ? readonly DeepReadonly<Value>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

type Agent = DeepReadonly<typeof agents.$inferSelect>;
type AgentJob = DeepReadonly<typeof agentJobs.$inferSelect>;

export type ClaimedAgentJob = Readonly<{
  job: AgentJob;
  run: Readonly<typeof runs.$inferSelect>;
  workspace: Readonly<typeof workspaces.$inferSelect>;
  configuration: Readonly<typeof configurationVersions.$inferSelect> | null;
  inputState: Readonly<typeof stateVersions.$inferSelect> | null;
  planResult: Readonly<Record<string, unknown>> | null;
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
          : ["planned", "planned_and_saved"].includes(status)
            ? "run:needs_attention"
            : undefined;
  if (trigger !== undefined) queueRunNotification(runId, trigger, status);
  void reportRunVcsStatus(runId, status);
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
  await Promise.all([
    db.update(agentPoolTokens).set({ lastUsedAt: now }).where(eq(agentPoolTokens.id, token.id)),
    db.update(agents).set({ lastPingAt: now }).where(eq(agents.id, agent.id)),
  ]);
  return agent;
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
  return {
    job,
    run,
    workspace,
    configuration: configuration ?? null,
    inputState: inputState ?? null,
    planResult: planJob?.result ?? null,
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

  for (let attempts = 0; attempts < 10; attempts += 1) {
    const candidate = await db.query.agentJobs.findFirst({
      where: and(
        eq(agentJobs.agentPoolId, agent.agentPoolId),
        eq(agentJobs.status, "queued"),
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
  await db.insert(logs).values({
    id: crypto.randomUUID(),
    runId: job.runId,
    phase: job.phase,
    outputText,
    createdAt: Date.now(),
  });
  return true;
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

export async function enqueueAgentApplyJob(
  runId: string,
  agentPoolId: string,
): Promise<AgentJob | undefined> {
  const queued = await db.transaction(async (transaction): Promise<AgentJob | undefined> => {
    const tx = transaction as unknown as typeof db;
    const run = await tx.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (run?.status !== "confirmed") return undefined;
    const job: AgentJob = {
      id: `ajob-${crypto.randomUUID()}`,
      runId,
      agentPoolId,
      agentId: null,
      phase: "apply",
      status: "queued",
      result: null,
      errorMessage: null,
      claimedAt: null,
      completedAt: null,
      createdAt: Date.now(),
    };
    await tx.insert(agentJobs).values(job);
    const updated = await tx.update(runs).set({
      agentPoolId,
      status: "apply_queued",
      statusTimestamps: timestampsWithStatus(run.statusTimestamps, "apply_queued"),
    }).where(and(eq(runs.id, runId), eq(runs.status, "confirmed"))).returning({ id: runs.id });
    if (updated.length === 0) throw new Error("Run changed while its agent apply job was queued");
    return job;
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

    const now = Date.now();
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

    let runStatus = "errored";
    if (completion.status === "completed" && job.phase === "plan") {
      runStatus = run.planOnly
        ? "planned_and_finished"
        : run.savePlan
          ? "planned_and_saved"
          : run.autoApply || run.allowEmptyApply
            ? "apply_queued"
            : "planned";
    } else if (completion.status === "completed") {
      runStatus = "applied";
    }

    const updatedRuns = await tx.update(runs).set({
      status: runStatus,
      statusTimestamps: timestampsWithStatus(run.statusTimestamps, runStatus),
      ...(job.phase === "plan"
        ? {
            planResourceAdditions: completion.resourceAdditions,
            planResourceChanges: completion.resourceChanges,
            planResourceDestructions: completion.resourceDestructions,
          }
        : {
            applyResourceAdditions: completion.resourceAdditions,
            applyResourceChanges: completion.resourceChanges,
            applyResourceDestructions: completion.resourceDestructions,
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
