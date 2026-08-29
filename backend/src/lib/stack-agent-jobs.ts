import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db";
import {
  agents,
  stackAgentJobs,
  stackRecords,
  stackStateLocks,
  stacks,
} from "../db/schema";
import { enqueueDurableJob } from "./durable-jobs";
import { refreshStackStateLock, removeStackState, saveStackState } from "./stack-worker";
import type { DeepReadonly } from "./utils";

export type StackAgent = DeepReadonly<typeof agents.$inferSelect>;
export type StackAgentJob = DeepReadonly<typeof stackAgentJobs.$inferSelect>;
type StackRecord = Readonly<typeof stackRecords.$inferSelect>;
const STACK_AGENT_CLAIM_TIMEOUT_MS = 15 * 60_000;

export const MAX_STACK_AGENT_RESULT_BYTES = 64 * 1024;
export const MAX_STACK_AGENT_RESULT_DEPTH = 8;
export const MAX_STACK_AGENT_RESULT_KEYS = 500;

function isStackResultArrayTooLarge(value: readonly unknown[], depth: number, keyCount: { count: number }): boolean {
  if (value.length > 1000) return true;
  keyCount.count += value.length;
  if (keyCount.count > MAX_STACK_AGENT_RESULT_KEYS) return true;
  for (const item of value) if (isStackResultValueTooLarge(item, depth + 1, keyCount)) return true;
  return false;
}

function isStackResultObjectTooLarge(value: Record<string, unknown>, depth: number, keyCount: { count: number }): boolean {
  const entries = Object.entries(value);
  if (entries.length > 200) return true;
  keyCount.count += entries.length;
  if (keyCount.count > MAX_STACK_AGENT_RESULT_KEYS) return true;
  for (const [k, v] of entries) {
    if (k.length > 1024) return true;
    if (typeof v === "string" && v.length > 16_384) return true;
    if (isStackResultValueTooLarge(v, depth + 1, keyCount)) return true;
  }
  return false;
}

function isStackResultValueTooLarge(value: unknown, depth: number, keyCount: { count: number }): boolean {
  if (depth > MAX_STACK_AGENT_RESULT_DEPTH) return true;
  if (typeof value === "string" && value.length > 16_384) return true;
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return isStackResultArrayTooLarge(value, depth, keyCount);
  return isStackResultObjectTooLarge(value as Record<string, unknown>, depth, keyCount);
}

export function isStackAgentResultValid(result: unknown): boolean {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  try {
    // State payloads are stored as artifacts, not in the JSONB metadata — exclude
    // them from the size budget so large valid Terraform state does not reject
    // the run.
    const { state: _s, json_state: _js, ...metadata } = result as Record<string, unknown>;
    const serialized = JSON.stringify(Object.keys(metadata).length === Object.keys(result).length ? result : metadata);
    if (new TextEncoder().encode(serialized).byteLength > MAX_STACK_AGENT_RESULT_BYTES) return false;
  } catch {
    return false;
  }
  return !isStackResultValueTooLarge(result, 0, { count: 0 });
}

export type StackAgentJobCompletion = Readonly<{
  status: "completed" | "errored";
  errorMessage: string | null;
  result: Readonly<Record<string, unknown>>;
}>;

type StackAgentCompletionOutcome = Readonly<{
  job: StackAgentJob;
  runStatus: string;
  fencingToken?: number;
}>;

export type ClaimedStackAgentJob = Readonly<{
  job: StackAgentJob;
  stack: Readonly<typeof stacks.$inferSelect>;
  configuration: StackRecord;
  deploymentRun: StackRecord;
  step: StackRecord;
}>;

function payloadString(record: StackRecord, key: string): string | undefined {
  const value = (record.payload ?? {})[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function payloadFencingToken(record: StackRecord): number | undefined {
  const value = (record.payload ?? {})["fencing-token"] ?? (record.payload ?? {}).fencingToken;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

async function jobDetails(job: StackAgentJob): Promise<ClaimedStackAgentJob | undefined> {
  const [stack, step] = await Promise.all([
    db.query.stacks.findFirst({ where: eq(stacks.id, job.stackId) }),
    db.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, job.stepId), eq(stackRecords.recordType, "stack-deployment-steps")) }),
  ]);
  if (stack === undefined || step === undefined || step.parentId === null) return undefined;
  const deploymentRun = await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, step.parentId), eq(stackRecords.recordType, "stack-deployment-runs")) });
  if (deploymentRun === undefined || deploymentRun.parentId === null) return undefined;
  const configuration = await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, payloadString(deploymentRun, "configurationId") ?? ""), eq(stackRecords.recordType, "stack-configurations")) });
  if (configuration === undefined) return undefined;
  return { job, stack, configuration, deploymentRun, step };
}

export async function claimStackAgentJob(
  agent: StackAgent,
  acceptedPhases: readonly string[] = ["plan", "apply"],
): Promise<ClaimedStackAgentJob | undefined> {
  await db.update(stackAgentJobs).set({ agentId: null, status: "queued", claimedAt: null, completedAt: null, result: null, errorMessage: null, updatedAt: Date.now() }).where(and(
    eq(stackAgentJobs.status, "claimed"),
    lt(stackAgentJobs.claimedAt, Date.now() - STACK_AGENT_CLAIM_TIMEOUT_MS),
  ));
  const existing = await db.query.stackAgentJobs.findFirst({
    where: and(eq(stackAgentJobs.agentId, agent.id), eq(stackAgentJobs.status, "claimed")),
    orderBy: [asc(stackAgentJobs.claimedAt)],
  });
  if (existing !== undefined) return jobDetails(existing);
  if (acceptedPhases.length === 0) return undefined;
  const binaries = agent.iacBinaries !== null && agent.iacBinaries.length > 0 ? agent.iacBinaries : ["terraform"];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = await db.query.stackAgentJobs.findFirst({
      where: and(
        eq(stackAgentJobs.agentPoolId, agent.agentPoolId),
        eq(stackAgentJobs.status, "queued"),
        inArray(stackAgentJobs.phase, [...acceptedPhases]),
        inArray(stackAgentJobs.iacBinary, binaries),
      ),
      orderBy: [asc(stackAgentJobs.createdAt)],
    });
    if (candidate === undefined) return undefined;
    const now = Date.now();
    const claimed = await db.update(stackAgentJobs).set({ agentId: agent.id, status: "claimed", claimedAt: now, updatedAt: now }).where(and(
      eq(stackAgentJobs.id, candidate.id),
      eq(stackAgentJobs.status, "queued"),
    )).returning();
    const job = claimed[0];
    if (job === undefined) continue;
    const details = await jobDetails(job);
    if (details === undefined) {
      await db.update(stackAgentJobs).set({ status: "errored", errorMessage: "Stack deployment step no longer exists", completedAt: now, updatedAt: now }).where(eq(stackAgentJobs.id, job.id));
      continue;
    }
    if (["succeeded", "failed", "canceled"].includes(details.deploymentRun.status)) {
      await db.update(stackAgentJobs).set({ status: "canceled", agentId: null, completedAt: now, updatedAt: now }).where(eq(stackAgentJobs.id, job.id));
      continue;
    }
    const nextStatus = job.phase === "plan" ? "planning" : "applying";
    await db.update(stackRecords).set({ status: "running", updatedAt: now }).where(and(eq(stackRecords.id, details.step.id), inArray(stackRecords.status, ["queued", "approved", "pending"])));
    await db.update(stackRecords).set({ status: nextStatus, updatedAt: now }).where(and(eq(stackRecords.id, details.deploymentRun.id), inArray(stackRecords.status, ["queued", "approved", "acquiring_lock", "planning", "applying"])));
    await db.update(agents).set({ status: "busy", lastPingAt: now }).where(eq(agents.id, agent.id));
    const rawFencingToken = (details.step.payload ?? {})["fencing-token"];
    const fencingToken = typeof rawFencingToken === "number" && Number.isInteger(rawFencingToken) ? rawFencingToken : undefined;
    const needsLock = (details.step.payload ?? {})["requires-state-lock"] === true;
    if (needsLock && (fencingToken === undefined || !await refreshStackStateLock(details.stack.id, details.deploymentRun.name ?? "default", details.deploymentRun.id, fencingToken))) {
      await db.update(stackAgentJobs).set({ agentId: null, status: "queued", claimedAt: null, updatedAt: Date.now() }).where(eq(stackAgentJobs.id, job.id));
      await db.update(agents).set({ status: "idle", lastPingAt: Date.now() }).where(eq(agents.id, agent.id));
      await enqueueDurableJob("stack-deployment", { runId: details.deploymentRun.id }, { dedupeKey: `stack-run:${details.deploymentRun.id}`, runAfter: Date.now() + 1000, rescheduleRunning: true });
      continue;
    }
    return { ...details, job };
  }
  return undefined;
}

export async function findClaimedStackAgentJob(agentId: string, jobId: string): Promise<ClaimedStackAgentJob | undefined> {
  const job = await db.query.stackAgentJobs.findFirst({ where: and(eq(stackAgentJobs.id, jobId), eq(stackAgentJobs.agentId, agentId), eq(stackAgentJobs.status, "claimed")) });
  return job === undefined ? undefined : jobDetails(job);
}

export async function heartbeatStackAgentJob(agentId: string, jobId: string): Promise<boolean> {
  const claimed = await findClaimedStackAgentJob(agentId, jobId);
  if (claimed === undefined) return false;
  if ((claimed.step.payload ?? {})["requires-state-lock"] !== true) return true;
  const rawFencingToken = (claimed.step.payload ?? {})["fencing-token"];
  return typeof rawFencingToken === "number" && Number.isInteger(rawFencingToken)
    ? refreshStackStateLock(claimed.stack.id, claimed.deploymentRun.name ?? "default", claimed.deploymentRun.id, rawFencingToken)
    : false;
}

function boolResult(result: Readonly<Record<string, unknown>>, key: string): boolean {
  return result[key] === true;
}

function stackStatePayload(result: Readonly<Record<string, unknown>> | null | undefined): string | null {
  const state = result?.state ?? result?.json_state;
  if (typeof state === "string") return state;
  if (state !== null && typeof state === "object") return JSON.stringify(state);
  return null;
}

async function persistCompletedApplyState(outcome: StackAgentCompletionOutcome): Promise<void> {
  if (outcome.job.phase !== "apply") return;
  const run = await db.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, outcome.job.deploymentRunId), eq(stackRecords.recordType, "stack-deployment-runs")) });
  if (run === undefined) return;
  const statePayload = stackStatePayload(outcome.job.result);
  try {
    if (run.payload?.destroy === true) await removeStackState(outcome.job.stackId, run.name ?? "default", run.id, outcome.fencingToken);
    else {
      if (statePayload === null) throw new Error("Stack agent apply completion must include the resulting state");
      await saveStackState(outcome.job.stackId, run.name ?? "default", run.id, statePayload, outcome.fencingToken);
    }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    await db.transaction(async (tx): Promise<void> => {
      await tx.update(stackRecords).set({ status: "failed", payload: { ...(outcome.job.result ?? {}), error: detail }, updatedAt: now }).where(eq(stackRecords.id, outcome.job.stepId));
      await tx.update(stackRecords).set({ status: "failed", payload: { error: detail }, updatedAt: now }).where(eq(stackRecords.id, run.id));
      await tx.update(stackStateLocks).set({ runId: null, leaseExpiresAt: null, releasedAt: now, updatedAt: now }).where(and(
        eq(stackStateLocks.runId, run.id),
        eq(stackStateLocks.stackId, outcome.job.stackId),
        ...(outcome.fencingToken === undefined ? [] : [eq(stackStateLocks.fencingToken, outcome.fencingToken)]),
      ));
    });
    throw error;
  }
}

export async function completeStackAgentJob(
  agentId: string,
  jobId: string,
  completion: StackAgentJobCompletion,
): Promise<StackAgentCompletionOutcome | undefined> {
  const outcome = await db.transaction(async (tx): Promise<StackAgentCompletionOutcome | undefined> => {
    // Terraform state can be arbitrarily large — validate the metadata envelope
    // without the state payload so a valid apply with a large state is not
    // rejected. State is persisted as a file artifact via saveStackState.
    const { state: _state, json_state: _jsonState, ...metadata } = completion.result as Record<string, unknown>;
    if (!isStackAgentResultValid(metadata)) throw new Error(`stack agent result metadata exceeds ${MAX_STACK_AGENT_RESULT_BYTES} bytes or structural limits`);
    const job = await tx.query.stackAgentJobs.findFirst({ where: and(eq(stackAgentJobs.id, jobId), eq(stackAgentJobs.agentId, agentId), eq(stackAgentJobs.status, "claimed")) });
    if (job === undefined) return undefined;
    const step = await tx.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, job.stepId), eq(stackRecords.recordType, "stack-deployment-steps")) });
    if (step === undefined) return undefined;
    const now = Date.now();
    const jobStatus = completion.status === "completed" ? "completed" : "errored";
    const updated = await tx.update(stackAgentJobs).set({ status: jobStatus, result: { ...completion.result }, errorMessage: completion.errorMessage, completedAt: now, updatedAt: now }).where(and(
      eq(stackAgentJobs.id, job.id), eq(stackAgentJobs.agentId, agentId), eq(stackAgentJobs.status, "claimed"),
    )).returning();
    const completed = updated[0];
    if (completed === undefined) return undefined;
    const run = step.parentId === null ? undefined : await tx.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, step.parentId), eq(stackRecords.recordType, "stack-deployment-runs")) });
    if (run === undefined) return undefined;
    if (["succeeded", "failed", "canceled"].includes(run.status)) {
      await tx.update(agents).set({ status: "idle", lastPingAt: now }).where(eq(agents.id, agentId));
      return { job: completed, runStatus: run.status };
    }
    if (completion.status === "errored") {
      await tx.update(stackRecords).set({ status: "failed", payload: { ...(step.payload ?? {}), error: completion.errorMessage ?? "Stack agent execution failed" }, updatedAt: now }).where(eq(stackRecords.id, step.id));
      await tx.update(stackRecords).set({ status: "failed", payload: { ...(run.payload ?? {}), error: completion.errorMessage ?? "Stack agent execution failed" }, updatedAt: now }).where(eq(stackRecords.id, run.id));
      const fencingToken = payloadFencingToken(step);
      await tx.update(stackStateLocks).set({ runId: null, leaseExpiresAt: null, releasedAt: now, updatedAt: now }).where(and(
        eq(stackStateLocks.runId, run.id),
        eq(stackStateLocks.stackId, job.stackId),
        ...(fencingToken === undefined ? [] : [eq(stackStateLocks.fencingToken, fencingToken)]),
      ));
      await tx.update(agents).set({ status: "idle", lastPingAt: now }).where(eq(agents.id, agentId));
      return { job: completed, runStatus: "failed" };
    }
    const result = { ...(step.payload ?? {}), ...(completion.result), "agent-job-id": job.id };
    const hasChanges = boolResult(completion.result, "hasChanges") || boolResult(completion.result, "has-changes") || boolResult(completion.result, "has_changes");
    let runStatus = "step_completed";
    const deferredChanges = boolResult(completion.result, "deferredChanges") || boolResult(completion.result, "deferred-changes") || boolResult(completion.result, "deferred_changes");
    if (job.phase === "plan" && (hasChanges || deferredChanges)) {
      await tx.update(stackRecords).set({ status: "pending_operator", payload: result, updatedAt: now }).where(eq(stackRecords.id, step.id));
      runStatus = "pre_deploying_pending_operator";
    } else {
      await tx.update(stackRecords).set({ status: "completed", payload: result, updatedAt: now }).where(eq(stackRecords.id, step.id));
    }
    await tx.update(stackRecords).set({ status: runStatus, payload: { ...(run.payload ?? {}), lastAgentJobId: job.id }, updatedAt: now }).where(eq(stackRecords.id, run.id));
    await tx.update(agents).set({ status: "idle", lastPingAt: now }).where(eq(agents.id, agentId));
    const rawFencingToken = (step.payload ?? {})["fencing-token"];
    const fencingToken = typeof rawFencingToken === "number" && Number.isInteger(rawFencingToken) ? rawFencingToken : undefined;
    return { job: completed, runStatus, ...(fencingToken === undefined ? {} : { fencingToken }) };
  });
  if (outcome !== undefined && outcome.runStatus === "step_completed") {
    await persistCompletedApplyState(outcome);
    await enqueueDurableJob("stack-deployment", { runId: outcome.job.deploymentRunId }, { dedupeKey: `stack-run:${outcome.job.deploymentRunId}`, rescheduleRunning: true });
  }
  return outcome;
}
