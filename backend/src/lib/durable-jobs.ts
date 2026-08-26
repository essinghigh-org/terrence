import { and, asc, eq, inArray, lt, lte } from "drizzle-orm";
import { envEnabled } from "./env";
import { db } from "../db";
import { durableJobs } from "../db/schema";
import { log } from "./log";

export type DurableJobKind = "module-test" | "stack-configuration" | "stack-deployment" | "explorer-inventory" | "explorer-catalog" | "plan-explanation" | "vcs-webhook";
export type DurableJob = Readonly<typeof durableJobs.$inferSelect>;
export type DurableJobContext = Readonly<{
  heartbeat: () => Promise<boolean>;
  canceled: () => Promise<boolean>;
}>;
export type DurableJobHandler = (job: DurableJob, context: DurableJobContext) => Promise<void>;

const LEASE_MS = 30_000;
const POLL_MS = 500;
/** Attempts before a durable job dead-letters (todo 186); shared with the webhook delivery mirror. */
export const DURABLE_MAX_ATTEMPTS = 3;
let workerRunning = false;

export async function enqueueDurableJob(
  kind: DurableJobKind,
  payload: Record<string, unknown>,
  options: Readonly<{ dedupeKey?: string; runAfter?: number; rescheduleRunning?: boolean }> = {},
): Promise<DurableJob> {
  if (options.dedupeKey !== undefined) {
    const existing = await db.query.durableJobs.findFirst({
      where: and(
        eq(durableJobs.kind, kind),
        eq(durableJobs.dedupeKey, options.dedupeKey),
      ),
    });
    if (existing !== undefined) {
      const runAfter = options.runAfter ?? Date.now();
      if (existing.status === "running" && !options.rescheduleRunning) return existing;
      if (existing.status === "queued") {
        if (runAfter >= existing.runAfter) return existing;
        const earlier = await db.update(durableJobs).set({ runAfter, updatedAt: Date.now() }).where(and(eq(durableJobs.id, existing.id), eq(durableJobs.status, "queued"))).returning();
        return (earlier[0] ?? existing);
      }
      const now = Date.now();
      const requeued = await db.update(durableJobs).set({
        status: "queued",
        payload,
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
  }
  const now = Date.now();
  const row: typeof durableJobs.$inferInsert = {
    id: `job-${crypto.randomUUID()}`,
    kind,
    dedupeKey: options.dedupeKey ?? null,
    status: "queued",
    payload,
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
  const candidate = await db.query.durableJobs.findFirst({
    where: and(
      inArray(durableJobs.kind, [...kinds]),
      eq(durableJobs.status, "queued"),
      lte(durableJobs.runAfter, now),
    ),
    orderBy: [asc(durableJobs.runAfter), asc(durableJobs.createdAt)],
  });
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
  const heartbeatTimer = setInterval((): void => {
    void heartbeatDurableJob(job).catch((error: unknown): void => {
      log.warn("Durable job heartbeat failed", { jobId: job.id, error: String(error) });
    });
  }, LEASE_MS / 3);
  try {
    await handler(job, {
      heartbeat: async (): Promise<boolean> => heartbeatDurableJob(job),
      canceled: async (): Promise<boolean> => isDurableJobStopped(job),
    });
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
  }
}

export function startDurableJobWorker(
  handlers: Readonly<Partial<Record<DurableJobKind, DurableJobHandler>>>,
): void {
  if (envEnabled(process.env.TERRENCE_DISABLE_WORKER) || workerRunning) return;
  workerRunning = true;
  const workerId = `durable-${process.pid}-${crypto.randomUUID()}`;
  const kinds = Object.keys(handlers) as DurableJobKind[];
  const poll = async (): Promise<void> => {
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
      setTimeout((): void => { void poll(); }, POLL_MS);
    }
  };
  void poll();
}
