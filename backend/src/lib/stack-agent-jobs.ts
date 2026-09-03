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
type StackRecord = DeepReadonly<typeof stackRecords.$inferSelect>;
const STACK_AGENT_CLAIM_TIMEOUT_MS = 15 * 60_000;

export const MAX_STACK_AGENT_RESULT_BYTES = 64 * 1024;
export const MAX_STACK_AGENT_RESULT_DEPTH = 8;
export const MAX_STACK_AGENT_RESULT_KEYS = 500;

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- recursive validation intentionally shares a mutable counter
function isStackResultArrayTooLarge(value: readonly unknown[], depth: number, keyCount: { count: number }): boolean {
  if (value.length > 1000) return true;
  keyCount.count += value.length;
  if (keyCount.count > MAX_STACK_AGENT_RESULT_KEYS) return true;
  for (const item of value) if (isStackResultValueTooLarge(item, depth + 1, keyCount)) return true;
  return false;
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- recursive validation intentionally shares a mutable counter
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

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- recursive validation intentionally shares a mutable counter
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
    const resultRecord = result as Record<string, unknown>;
    const metadata = Object.fromEntries(Object.entries(resultRecord).filter(([key]): boolean => key !== "state" && key !== "json_state"));
    const serialized = JSON.stringify(Object.keys(metadata).length === Object.keys(resultRecord).length ? resultRecord : metadata);
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
  stepPayload: Readonly<Record<string, unknown>>;
  runStatus: string;
  fencingToken?: number;
}>;

export type ClaimedStackAgentJob = Readonly<{
  job: StackAgentJob;
  stack: DeepReadonly<typeof stacks.$inferSelect>;
  configuration: StackRecord;
  deploymentRun: StackRecord;
  step: StackRecord;
}>;

function payloadString(record: StackRecord, key: string): string | undefined {
  const value = (record.payload ?? {})[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function payloadFencingToken(record: StackRecord): number | undefined {
  const value = (record.payload ?? {})["fencing-token"] ?? (record.payload ?? {})["fencingToken"];
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

type StackAgentClaimAttempt =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "retry" }>
  | Readonly<{ kind: "claimed"; details: ClaimedStackAgentJob }>;

async function claimStackAgentAttempt(
  agent: StackAgent,
  acceptedPhases: readonly string[],
  binaries: readonly string[],
): Promise<StackAgentClaimAttempt> {
  const candidate = await db.query.stackAgentJobs.findFirst({
    where: and(
      eq(stackAgentJobs.agentPoolId, agent.agentPoolId),
      eq(stackAgentJobs.status, "queued"),
      inArray(stackAgentJobs.phase, [...acceptedPhases]),
      inArray(stackAgentJobs.iacBinary, binaries),
    ),
    orderBy: [asc(stackAgentJobs.createdAt)],
  });
  if (candidate === undefined) return { kind: "empty" };
  const now = Date.now();
  const claimed = await db.update(stackAgentJobs).set({ agentId: agent.id, status: "claimed", claimedAt: now, updatedAt: now }).where(and(
    eq(stackAgentJobs.id, candidate.id),
    eq(stackAgentJobs.status, "queued"),
  )).returning();
  const job = claimed[0];
  if (job === undefined) return { kind: "retry" };
  const details = await jobDetails(job);
  if (details === undefined) {
    await db.update(stackAgentJobs).set({ status: "errored", errorMessage: "Stack deployment step no longer exists", completedAt: now, updatedAt: now }).where(eq(stackAgentJobs.id, job.id));
    return { kind: "retry" };
  }
  if (["succeeded", "failed", "canceled"].includes(details.deploymentRun.status)) {
    await db.update(stackAgentJobs).set({ status: "canceled", agentId: null, completedAt: now, updatedAt: now }).where(eq(stackAgentJobs.id, job.id));
    return { kind: "retry" };
  }
  const nextStatus = job.phase === "plan" ? "planning" : "applying";
  await db.update(stackRecords).set({ status: "running", updatedAt: now }).where(and(eq(stackRecords.id, details.step.id), inArray(stackRecords.status, ["queued", "approved", "pending"])));
  await db.update(stackRecords).set({ status: nextStatus, updatedAt: now }).where(and(eq(stackRecords.id, details.deploymentRun.id), inArray(stackRecords.status, ["queued", "approved", "acquiring_lock", "planning", "applying"])));
  await db.update(agents).set({ status: "busy", lastPingAt: now }).where(eq(agents.id, agent.id));
  const rawFencingToken = (details.step.payload ?? {})["fencing-token"];
  const fencingToken = typeof rawFencingToken === "number" && Number.isInteger(rawFencingToken) ? rawFencingToken : undefined;
  const needsLock = (details.step.payload ?? {})["requires-state-lock"] === true;
  const lockHeld = !needsLock || (
    fencingToken !== undefined
    && await refreshStackStateLock(details.stack.id, details.deploymentRun.name ?? "default", details.deploymentRun.id, fencingToken)
  );
  if (!lockHeld) {
    await db.update(stackAgentJobs).set({ agentId: null, status: "queued", claimedAt: null, updatedAt: Date.now() }).where(eq(stackAgentJobs.id, job.id));
    await db.update(agents).set({ status: "idle", lastPingAt: Date.now() }).where(eq(agents.id, agent.id));
    await enqueueDurableJob("stack-deployment", { runId: details.deploymentRun.id }, { dedupeKey: `stack-run:${details.deploymentRun.id}`, runAfter: Date.now() + 1000, rescheduleRunning: true });
    return { kind: "retry" };
  }
  return { kind: "claimed", details: { ...details, job } };
}

export async function claimStackAgentJob(
  agent: StackAgent,
  acceptedPhases: readonly string[] = ["plan", "apply"],
): Promise<ClaimedStackAgentJob | undefined> {
  await db.update(stackAgentJobs).set({ agentId: null, status: "queued", claimedAt: null, completedAt: null, result: null, errorMessage: null, updatedAt: Date.now() }).where(and(
    eq(stackAgentJobs.status, "claimed"),
    eq(stackAgentJobs.agentPoolId, agent.agentPoolId),
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
    const result = await claimStackAgentAttempt(agent, acceptedPhases, binaries);
    if (result.kind === "empty") return undefined;
    if (result.kind === "claimed") return result.details;
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
  const requiresStateLock = (claimed.step.payload ?? {})["requires-state-lock"] === true;
  if (requiresStateLock) {
    const rawFencingToken = (claimed.step.payload ?? {})["fencing-token"];
    if (typeof rawFencingToken !== "number" || !Number.isInteger(rawFencingToken)) return false;
    if (!await refreshStackStateLock(claimed.stack.id, claimed.deploymentRun.name ?? "default", claimed.deploymentRun.id, rawFencingToken)) return false;
  }
  const now = Date.now();
  const renewed = await db.update(stackAgentJobs).set({ claimedAt: now, updatedAt: now }).where(and(
    eq(stackAgentJobs.id, jobId),
    eq(stackAgentJobs.agentId, agentId),
    eq(stackAgentJobs.status, "claimed"),
  )).returning({ id: stackAgentJobs.id });
  return renewed.length > 0;
}

function stackStatePayload(result: Readonly<Record<string, unknown>> | null | undefined): string | null {
  const state = result?.["state"] ?? result?.["json_state"];
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
    if (run.payload?.["destroy"] === true) await removeStackState(outcome.job.stackId, run.name ?? "default", run.id, outcome.fencingToken);
    else {
      if (statePayload === null) throw new Error("Stack agent apply completion must include the resulting state");
      await saveStackState(outcome.job.stackId, run.name ?? "default", run.id, statePayload, outcome.fencingToken);
    }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    await db.transaction(async (tx): Promise<void> => {
      await tx.update(stackRecords).set({ status: "failed", payload: { ...outcome.stepPayload, ...(outcome.job.result ?? {}), error: detail }, updatedAt: now }).where(eq(stackRecords.id, outcome.job.stepId));
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

type StackAgentTransaction = DeepReadonly<typeof db>;

type StackAgentCompletionContext = Readonly<{
  job: StackAgentJob;
  step: StackRecord;
}>;

function validateStackAgentCompletion(completion: StackAgentJobCompletion): void {
  // Terraform state can be arbitrarily large — validate the metadata envelope
  // without the state payload so a valid apply with a large state is not
  // rejected. State is persisted as a file artifact via saveStackState.
  const resultRecord = completion.result as Record<string, unknown>;
  const metadata = Object.fromEntries(Object.entries(resultRecord).filter(([key]): boolean => key !== "state" && key !== "json_state"));
  if (!isStackAgentResultValid(metadata)) throw new Error(`stack agent result metadata exceeds ${MAX_STACK_AGENT_RESULT_BYTES} bytes or structural limits`);
}

async function stackAgentCompletionContext(
  tx: StackAgentTransaction,
  agentId: string,
  jobId: string,
): Promise<StackAgentCompletionContext | undefined> {
  const job = await tx.query.stackAgentJobs.findFirst({ where: and(eq(stackAgentJobs.id, jobId), eq(stackAgentJobs.agentId, agentId), eq(stackAgentJobs.status, "claimed")) });
  if (job === undefined) return undefined;
  const step = await tx.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, job.stepId), eq(stackRecords.recordType, "stack-deployment-steps")) });
  if (step === undefined) return undefined;
  return { job, step };
}

async function persistStackAgentCompletion(
  tx: StackAgentTransaction,
  agentId: string,
  job: StackAgentJob,
  completion: StackAgentJobCompletion,
  now: number,
): Promise<StackAgentJob | undefined> {
  const jobStatus = completion.status === "completed" ? "completed" : "errored";
  const updated = await tx.update(stackAgentJobs).set({ status: jobStatus, result: { ...completion.result }, errorMessage: completion.errorMessage, completedAt: now, updatedAt: now }).where(and(
    eq(stackAgentJobs.id, job.id), eq(stackAgentJobs.agentId, agentId), eq(stackAgentJobs.status, "claimed"),
  )).returning();
  return updated[0];
}

async function stackAgentCompletionRun(tx: StackAgentTransaction, step: StackRecord): Promise<StackRecord | undefined> {
  return step.parentId === null
    ? undefined
    : tx.query.stackRecords.findFirst({ where: and(eq(stackRecords.id, step.parentId), eq(stackRecords.recordType, "stack-deployment-runs")) });
}

async function persistTerminalStackAgentCompletion(
  tx: StackAgentTransaction,
  agentId: string,
  completed: StackAgentJob,
  step: StackRecord,
  run: StackRecord,
  now: number,
): Promise<StackAgentCompletionOutcome | undefined> {
  if (!["succeeded", "failed", "canceled"].includes(run.status)) return undefined;
  await tx.update(agents).set({ status: "idle", lastPingAt: now }).where(eq(agents.id, agentId));
  return { job: completed, stepPayload: step.payload ?? {}, runStatus: run.status };
}

async function persistFailedStackAgentCompletion(
  tx: StackAgentTransaction,
  agentId: string,
  job: StackAgentJob,
  step: StackRecord,
  run: StackRecord,
  completion: StackAgentJobCompletion,
  now: number,
): Promise<StackAgentCompletionOutcome> {
  const detail = completion.errorMessage ?? "Stack agent execution failed";
  await tx.update(stackRecords).set({ status: "failed", payload: { ...(step.payload ?? {}), error: detail }, updatedAt: now }).where(eq(stackRecords.id, step.id));
  await tx.update(stackRecords).set({ status: "failed", payload: { ...(run.payload ?? {}), error: detail }, updatedAt: now }).where(eq(stackRecords.id, run.id));
  const fencingToken = payloadFencingToken(step);
  await tx.update(stackStateLocks).set({ runId: null, leaseExpiresAt: null, releasedAt: now, updatedAt: now }).where(and(
    eq(stackStateLocks.runId, run.id),
    eq(stackStateLocks.stackId, job.stackId),
    ...(fencingToken === undefined ? [] : [eq(stackStateLocks.fencingToken, fencingToken)]),
  ));
  await tx.update(agents).set({ status: "idle", lastPingAt: now }).where(eq(agents.id, agentId));
  return { job, stepPayload: step.payload ?? {}, runStatus: "failed" };
}

function completionFlag(result: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return keys.some((key): boolean => result[key] === true);
}

async function persistSuccessfulStackAgentCompletion(
  tx: StackAgentTransaction,
  agentId: string,
  job: StackAgentJob,
  step: StackRecord,
  run: StackRecord,
  completion: StackAgentJobCompletion,
  now: number,
): Promise<StackAgentCompletionOutcome> {
  const result = { ...(step.payload ?? {}), ...(completion.result), "agent-job-id": job.id };
  const hasChanges = completionFlag(completion.result, ["hasChanges", "has-changes", "has_changes"]);
  let runStatus = "step_completed";
  const deferredChanges = completionFlag(completion.result, ["deferredChanges", "deferred-changes", "deferred_changes"]);
  if (job.phase === "plan" && (hasChanges || deferredChanges)) {
    await tx.update(stackRecords).set({ status: "pending_operator", payload: result, updatedAt: now }).where(eq(stackRecords.id, step.id));
    runStatus = "pre_deploying_pending_operator";
  } else {
    await tx.update(stackRecords).set({ status: "completed", payload: result, updatedAt: now }).where(eq(stackRecords.id, step.id));
  }
  await tx.update(stackRecords).set({ status: runStatus, payload: { ...(run.payload ?? {}), lastAgentJobId: job.id }, updatedAt: now }).where(eq(stackRecords.id, run.id));
  await tx.update(agents).set({ status: "idle", lastPingAt: now }).where(eq(agents.id, agentId));
  const fencingToken = payloadFencingToken(step);
  return { job, stepPayload: result, runStatus, ...(fencingToken === undefined ? {} : { fencingToken }) };
}

export async function completeStackAgentJob(
  agentId: string,
  jobId: string,
  completion: StackAgentJobCompletion,
): Promise<StackAgentCompletionOutcome | undefined> {
  const outcome = await db.transaction(async (transaction): Promise<StackAgentCompletionOutcome | undefined> => {
    validateStackAgentCompletion(completion);
    const tx = transaction as unknown as StackAgentTransaction;
    const context = await stackAgentCompletionContext(tx, agentId, jobId);
    if (context === undefined) return undefined;
    const now = Date.now();
    const completed = await persistStackAgentCompletion(tx, agentId, context.job, completion, now);
    if (completed === undefined) return undefined;
    const run = await stackAgentCompletionRun(tx, context.step);
    if (run === undefined) return undefined;
    const terminal = await persistTerminalStackAgentCompletion(tx, agentId, completed, context.step, run, now);
    if (terminal !== undefined) return terminal;
    if (completion.status === "errored") return persistFailedStackAgentCompletion(tx, agentId, completed, context.step, run, completion, now);
    return persistSuccessfulStackAgentCompletion(tx, agentId, completed, context.step, run, completion, now);
  });
  if (outcome !== undefined && outcome.runStatus === "step_completed") {
    await persistCompletedApplyState(outcome);
    await enqueueDurableJob("stack-deployment", { runId: outcome.job.deploymentRunId }, { dedupeKey: `stack-run:${outcome.job.deploymentRunId}`, rescheduleRunning: true });
  }
  return outcome;
}
