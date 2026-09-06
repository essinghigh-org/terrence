import { newResourceId } from "./resource-id";
import { and, asc, eq, inArray, lt, lte } from "drizzle-orm";
import { envFlag } from "./env";
import { db } from "../db";
import { workerQueueDraining } from "../worker";
import { durableJobs } from "../db/schema";
import { log } from "./log";
import { jitteredPollDelay } from "./poll-jitter";
import {
  assessResourceBudget,
  parseResourceBudgetConfig,
  resourceBudgetJobFromDurable,
  resourceBudgetSnapshot,
  selectResourceBudgetJob,
  type ResourceBudgetAdmission,
  type ResourceBudgetJob,
  type ResourceBudgetSnapshot,
  type ResourceJobClass,
  type ResourceBudgetState,
} from "./resource-budgets";
import { PERSISTED_JOB_PAYLOAD_SCHEMA_VERSION, parsePersistedJobPayload } from "./validation";
import { createOperationContext } from "./operation-context";

export type DurableJobKind = "module-test" | "stack-configuration" | "stack-deployment" | "explorer-inventory" | "explorer-catalog" | "plan-explanation" | "vcs-webhook";
export type DurableJob = Readonly<typeof durableJobs.$inferSelect>;
export type DurableJobContext = Readonly<{
  heartbeat: () => Promise<boolean>;
  canceled: () => Promise<boolean>;
  signal: Readonly<AbortSignal>;
}>;
export type DurableJobHandler = (job: DurableJob, context: DurableJobContext) => Promise<void>;
export type DurableJobBudgetOptions = Readonly<{
  organizationId?: string | null;
  jobClass?: ResourceJobClass;
  estimatedBytes?: number;
}>;

type EnqueueDurableJobOptions = Readonly<{
  dedupeKey?: string;
  runAfter?: number;
  rescheduleRunning?: boolean;
  budget?: DurableJobBudgetOptions;
}>;

const LEASE_MS = 30_000;
const POLL_MS = 500;
/** Attempts before a durable job dead-letters (todo 186); shared with the webhook delivery mirror. */
export const DURABLE_MAX_ATTEMPTS = 3;
let workerRunning = false;
const NO_EXISTING_DURABLE_JOB = Symbol("no-existing-durable-job");

/** A queue admission failure is explicit and carries a retry hint. */
export class DurableJobBudgetError extends Error {
  public readonly admission: ResourceBudgetAdmission;
  public readonly status: 413 | 429;

  constructor(admission: ResourceBudgetAdmission) {
    super(admission.reason === "artifact-bytes-limit"
      ? "Durable job artifact estimate exceeds the configured byte budget"
      : `Durable job queue capacity is temporarily unavailable (${admission.reason ?? "capacity"})`);
    this.name = "DurableJobBudgetError";
    this.admission = admission;
    this.status = admission.reason === "artifact-bytes-limit" ? 413 : 429;
  }
}

function payloadWithBudgetMetadata(
  payload: Readonly<Record<string, unknown>>,
  budget: DurableJobBudgetOptions | undefined,
): Record<string, unknown> {
  if (budget === undefined) return { ...payload };
  return {
    ...payload,
    ...(budget.organizationId === undefined ? {} : { organizationId: budget.organizationId }),
    ...(budget.jobClass === undefined ? {} : { jobClass: budget.jobClass }),
    ...(budget.estimatedBytes === undefined ? {} : { estimatedBytes: budget.estimatedBytes }),
  };
}

function preserveBudgetMetadata(
  existing: Readonly<Record<string, unknown>>,
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged = { ...payload };
  for (const key of ["organizationId", "jobClass", "estimatedBytes"] as const) {
    if (!(key in merged) && key in existing) merged[key] = existing[key];
  }
  return merged;
}

async function durableJobBudgetState(excludeJobId?: string): Promise<ResourceBudgetState> {
  const [queuedRows, runningRows] = await Promise.all([
    db.query.durableJobs.findMany({
      where: eq(durableJobs.status, "queued"),
      columns: { id: true, kind: true, payload: true, runAfter: true, createdAt: true },
    }),
    db.query.durableJobs.findMany({
      where: eq(durableJobs.status, "running"),
      columns: { id: true, kind: true, payload: true, runAfter: true, createdAt: true },
    }),
  ]);
  return {
    queued: queuedRows.filter((row): boolean => row.id !== excludeJobId).map(resourceBudgetJobFromDurable),
    running: runningRows.filter((row): boolean => row.id !== excludeJobId).map(resourceBudgetJobFromDurable),
  };
}

async function assertDurableJobBudget(row: ResourceBudgetJob, excludeJobId?: string): Promise<void> {
  const admission = assessResourceBudget(parseResourceBudgetConfig(), await durableJobBudgetState(excludeJobId), row);
  if (!admission.accepted) throw new DurableJobBudgetError(admission);
}

function resourceBudgetJobFromInsert(
  row: Readonly<{ id: string; kind: string; payload: Record<string, unknown>; runAfter: number; createdAt: number }>,
): ResourceBudgetJob {
  return resourceBudgetJobFromDurable(row);
}

async function requeueExistingDurableJob(
  existing: DurableJob,
  payload: Readonly<Record<string, unknown>>,
  options: EnqueueDurableJobOptions,
  runAfter: number,
): Promise<DurableJob> {
  const requeuedPayload = preserveBudgetMetadata(existing.payload, payload);
  parsePersistedJobPayload(existing.kind, requeuedPayload, PERSISTED_JOB_PAYLOAD_SCHEMA_VERSION, existing.id);
  // A requeue changes the row's payload and scheduling state. Check before
  // changing it; otherwise a deduped retry could bypass the same limits
  // enforced for a fresh row (or double-count a running row).
  if (options.budget !== undefined) {
    await assertDurableJobBudget(resourceBudgetJobFromInsert({
      id: existing.id,
      kind: existing.kind,
      payload: requeuedPayload,
      runAfter,
      createdAt: existing.createdAt,
    }), existing.id);
  }
  const now = Date.now();
  const requeued = await db.update(durableJobs).set({
    status: "queued",
    payload: requeuedPayload,
    payloadSchemaVersion: PERSISTED_JOB_PAYLOAD_SCHEMA_VERSION,
    attempts: 0,
    runAfter,
    lockedBy: null,
    lockToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    lastError: null,
    updatedAt: now,
  }).where(and(eq(durableJobs.id, existing.id), options.rescheduleRunning ? inArray(durableJobs.status, ["running", "succeeded", "failed", "canceled"]) : inArray(durableJobs.status, ["succeeded", "failed", "canceled"]))).returning();
  return (requeued[0] ?? await db.query.durableJobs.findFirst({ where: eq(durableJobs.id, existing.id) })) as DurableJob;
}

async function enqueueExistingDurableJob(
  kind: DurableJobKind,
  payload: Readonly<Record<string, unknown>>,
  options: EnqueueDurableJobOptions,
): Promise<DurableJob | typeof NO_EXISTING_DURABLE_JOB> {
  if (options.dedupeKey === undefined) return NO_EXISTING_DURABLE_JOB;
  const existing = await db.query.durableJobs.findFirst({
    where: and(
      eq(durableJobs.kind, kind),
      eq(durableJobs.dedupeKey, options.dedupeKey),
    ),
  });
  if (existing === undefined) return NO_EXISTING_DURABLE_JOB;
  const runAfter = options.runAfter ?? Date.now();
  if (existing.status === "running" && !options.rescheduleRunning) return existing;
  if (existing.status === "queued") {
    if (runAfter >= existing.runAfter) return existing;
    const earlier = await db.update(durableJobs).set({ runAfter, updatedAt: Date.now() }).where(and(eq(durableJobs.id, existing.id), eq(durableJobs.status, "queued"))).returning();
    return (earlier[0] ?? existing);
  }
  return requeueExistingDurableJob(existing, payload, options, runAfter);
}

export async function enqueueDurableJob(
  kind: DurableJobKind,
  payload: Record<string, unknown>,
  options: EnqueueDurableJobOptions = {},
): Promise<DurableJob> {
  const durablePayload = payloadWithBudgetMetadata(payload, options.budget);
  parsePersistedJobPayload(kind, durablePayload, PERSISTED_JOB_PAYLOAD_SCHEMA_VERSION);
  const existing = await enqueueExistingDurableJob(kind, durablePayload, options);
  if (existing !== NO_EXISTING_DURABLE_JOB) return existing;
  const now = Date.now();
  const row: typeof durableJobs.$inferInsert = {
    id: newResourceId("job"),
    kind,
    dedupeKey: options.dedupeKey ?? null,
    status: "queued",
    payload: durablePayload,
    payloadSchemaVersion: PERSISTED_JOB_PAYLOAD_SCHEMA_VERSION,
    attempts: 0,
    runAfter: options.runAfter ?? now,
    lockedBy: null,
    lockToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  if (options.budget !== undefined) {
    await assertDurableJobBudget(resourceBudgetJobFromInsert({
      id: row.id,
      kind: row.kind,
      payload: durablePayload,
      runAfter: row.runAfter ?? now,
      createdAt: row.createdAt ?? now,
    }));
  }
  try {
    await db.insert(durableJobs).values(row);
    return row as DurableJob;
  } catch (error: unknown) {
    if (options.dedupeKey === undefined) throw error;
    const existing = await db.query.durableJobs.findFirst({
      where: and(eq(durableJobs.kind, kind), eq(durableJobs.dedupeKey, options.dedupeKey)),
    });
    if (existing === undefined) throw error;
    return existing;
  }
}

async function requeueExpiredJobs(now: number): Promise<void> {
  await db.update(durableJobs).set({
    status: "queued",
    lockedBy: null,
    lockToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    updatedAt: now,
    lastError: "Worker lease expired; job reclaimed after restart",
  }).where(and(
    eq(durableJobs.status, "running"),
    lt(durableJobs.leaseExpiresAt, now),
  ));
}

export async function claimDurableJob(
  workerId: string,
  kinds: readonly DurableJobKind[],
  now = Date.now(),
): Promise<DurableJob | undefined> {
  if (kinds.length === 0) return undefined;
  await requeueExpiredJobs(now);
  // Read a bounded candidate window and apply the same policy used by
  // admission. The limit prevents a noisy queue from turning every poll into
  // an unbounded JSON scan; the row-level update below remains the fencing
  // authority when another worker wins the race.
  const [candidateRows, runningRows] = await Promise.all([
    db.query.durableJobs.findMany({
      where: and(
        inArray(durableJobs.kind, [...kinds]),
        eq(durableJobs.status, "queued"),
        lte(durableJobs.runAfter, now),
      ),
      orderBy: [asc(durableJobs.runAfter), asc(durableJobs.createdAt)],
      limit: 256,
    }),
    db.query.durableJobs.findMany({
      where: eq(durableJobs.status, "running"),
      columns: { id: true, kind: true, payload: true, runAfter: true, createdAt: true },
    }),
  ]);
  const selected = selectResourceBudgetJob(
    parseResourceBudgetConfig(),
    {
      queued: candidateRows.map(resourceBudgetJobFromDurable),
      running: runningRows.map(resourceBudgetJobFromDurable),
    },
    now,
  );
  const candidate = selected === undefined ? undefined : candidateRows.find((row): boolean => row.id === selected.id);
  if (candidate === undefined) return undefined;
  const lockToken = crypto.randomUUID();
  const updated = await db.update(durableJobs).set({
    status: "running",
    attempts: candidate.attempts + 1,
    lockedBy: workerId,
    lockToken,
    leaseExpiresAt: now + LEASE_MS,
    heartbeatAt: now,
    updatedAt: now,
    lastError: null,
  }).where(and(
    eq(durableJobs.id, candidate.id),
    eq(durableJobs.status, "queued"),
    lte(durableJobs.runAfter, now),
  )).returning();
  return updated[0];
}

/** Aggregate queue diagnostics for site-admin metrics and the admin API. */
export async function collectDurableJobBudgetSnapshot(): Promise<ResourceBudgetSnapshot> {
  return resourceBudgetSnapshot(parseResourceBudgetConfig(), await durableJobBudgetState());
}

export async function heartbeatDurableJob(job: DurableJob, now = Date.now()): Promise<boolean> {
  const updated = await db.update(durableJobs).set({
    leaseExpiresAt: now + LEASE_MS,
    heartbeatAt: now,
    updatedAt: now,
  }).where(and(
    eq(durableJobs.id, job.id),
    eq(durableJobs.status, "running"),
    eq(durableJobs.lockToken, job.lockToken ?? ""),
  )).returning({ id: durableJobs.id });
  return updated.length === 1;
}

/** @public Intentional surface: benchmark/test hook or cross-module API. */
export async function isDurableJobCanceled(job: DurableJob): Promise<boolean> {
  const row = await db.query.durableJobs.findFirst({ where: eq(durableJobs.id, job.id) });
  return row?.status === "canceled";
}

// Stop stale work too: cancellation, deletion, lease reclamation, or a new
// lock token all mean this worker no longer owns the durable job.
async function isDurableJobStopped(job: DurableJob): Promise<boolean> {
  const row = await db.query.durableJobs.findFirst({ where: eq(durableJobs.id, job.id) });
  return row === undefined || row.status !== "running" || row.lockToken !== job.lockToken;
}

export async function cancelDurableJob(jobId: string): Promise<boolean> {
  const updated = await db.update(durableJobs).set({ status: "canceled", updatedAt: Date.now() }).where(and(
    eq(durableJobs.id, jobId),
    inArray(durableJobs.status, ["queued", "running"]),
  )).returning({ id: durableJobs.id });
  return updated.length === 1;
}

export async function cancelDurableJobs(kind: DurableJobKind, dedupeKey: string): Promise<number> {
  const updated = await db.update(durableJobs).set({ status: "canceled", updatedAt: Date.now() }).where(and(
    eq(durableJobs.kind, kind),
    eq(durableJobs.dedupeKey, dedupeKey),
    inArray(durableJobs.status, ["queued", "running"]),
  )).returning({ id: durableJobs.id });
  return updated.length;
}

async function finishDurableJob(job: DurableJob, status: "succeeded" | "failed" | "queued", error?: string): Promise<boolean> {
  const now = Date.now();
  const retry = status === "queued";
  const updated = await db.update(durableJobs).set({
    status,
    lockedBy: null,
    lockToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    updatedAt: now,
    runAfter: retry ? now + Math.min(60_000, 1000 * 2 ** Math.max(0, job.attempts - 1)) : now,
    lastError: error ?? null,
  }).where(and(
    eq(durableJobs.id, job.id),
    eq(durableJobs.status, "running"),
    eq(durableJobs.lockToken, job.lockToken ?? ""),
  )).returning({ id: durableJobs.id });
  return updated.length === 1;
}

async function runJob(job: DurableJob, handler: DurableJobHandler): Promise<void> {
  const operation = createOperationContext();
  let heartbeatFailures = 0;
  const heartbeatTimer = setInterval((): void => {
    void heartbeatDurableJob(job).then((ok): void => {
      if (!ok) {
        heartbeatFailures += 1;
        operation.cancel("lease-lost", new Error("Durable job lease was lost"));
      }
      else heartbeatFailures = 0;
      if (heartbeatFailures >= 3) {
        log.warn("Durable job heartbeat repeatedly failed, stopping heartbeat", { jobId: job.id });
        clearInterval(heartbeatTimer);
      }
    }).catch((error: unknown): void => {
      heartbeatFailures += 1;
      log.warn("Durable job heartbeat failed", { jobId: job.id, error: String(error), failures: heartbeatFailures });
      if (heartbeatFailures >= 3) clearInterval(heartbeatTimer);
    });
  }, LEASE_MS / 3);
  try {
    await handler(job, {
      signal: operation.signal,
      heartbeat: async (): Promise<boolean> => {
        const owned = await heartbeatDurableJob(job);
        if (!owned) operation.cancel("lease-lost", new Error("Durable job lease was lost"));
        return owned;
      },
      canceled: async (): Promise<boolean> => {
        const stopped = await isDurableJobStopped(job);
        if (stopped) {
          const row = await db.query.durableJobs.findFirst({ where: eq(durableJobs.id, job.id), columns: { status: true, lockToken: true } });
          operation.cancel(
            row?.status === "canceled" ? "user-cancel" : "lease-lost",
            new Error("Durable job was canceled or ownership expired"),
          );
        }
        return stopped;
      },
    });
    // A handler is cooperative, but a legacy handler may return after its
    // signal was raised. Never publish success after a lease/cancel race;
    // the fenced transition below either leaves a canceled row untouched or
    // makes a still-owned lease eligible for retry.
    if (operation.signal.aborted) {
      const stopped = await isDurableJobStopped(job).catch((): boolean => true);
      if (!stopped) {
        const reason = operation.signal.reason instanceof Error
          ? operation.signal.reason.message
          : "Durable job operation was canceled";
        await finishDurableJob(job, job.attempts >= DURABLE_MAX_ATTEMPTS ? "failed" : "queued", reason);
      }
      return;
    }
    await finishDurableJob(job, "succeeded");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stopped = await isDurableJobStopped(job).catch((): boolean => false);
    if (!stopped) {
      await finishDurableJob(job, job.attempts >= DURABLE_MAX_ATTEMPTS ? "failed" : "queued", message);
    }
    log.error("Durable job failed", { jobId: job.id, kind: job.kind, attempts: job.attempts, error: message });
  } finally {
    clearInterval(heartbeatTimer);
    operation.dispose();
  }
}

export function startDurableJobWorker(
  handlers: Readonly<Partial<Record<DurableJobKind, DurableJobHandler>>>,
): void {
  if (envFlag("TERRENCE_DISABLE_WORKER") || workerRunning) return;
  workerRunning = true;
  const workerId = `durable-${process.pid}-${crypto.randomUUID()}`;
  const kinds = Object.keys(handlers) as DurableJobKind[];
  const schedulePoll = (): void => {
    const timer = setTimeout((): void => { void poll(); }, jitteredPollDelay(POLL_MS));
    timer.unref?.();
  };
  const poll = async (): Promise<void> => {
    if (workerQueueDraining()) {
      schedulePoll();
      return;
    }
    try {
      const job = await claimDurableJob(workerId, kinds);
      if (job !== undefined) {
        const handler = handlers[job.kind as DurableJobKind];
        if (handler === undefined) {
          await finishDurableJob(job, "failed", `No handler registered for ${job.kind}`);
        } else {
          await runJob(job, handler);
        }
      }
    } catch (error: unknown) {
      log.error("Durable job poll failed", { error: String(error) });
    } finally {
      schedulePoll();
    }
  };
  void poll();
}
