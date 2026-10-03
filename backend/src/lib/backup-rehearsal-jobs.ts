import { and, asc, eq, gte } from "drizzle-orm";
import { databaseCurrentTimeMs, db } from "../db";
import { controlPlaneNodes, durableJobs } from "../db/schema";
import { databaseConstraint } from "./database-errors";
import { log } from "./log";
import { controlPlaneInstanceId, controlPlaneNodeId } from "./ha-config";
import {
  BackupVerificationError,
  runRestoreRehearsal,
  type BackupRehearsalReport,
  type BackupSourceOptions,
} from "./backup-verification";
import type { DeepReadonly } from "./types";
import { decryptSecret, encryptSecret } from "./secrets";

const BACKUP_REHEARSAL_KIND = "backup-rehearsal";
const ACTIVE_REHEARSAL_KEY = "active";
const MAX_REHEARSAL_JOBS = 20;
// Keep this aligned with the HA node registry's readiness timeout. A row is
// interrupted only after its owning replica has stopped heartbeating long
// enough to be considered unavailable by the rest of the control plane.
const OWNER_STALE_MS = 45_000;

export type BackupRehearsalJob = Readonly<{
  id: string;
  status: "running" | "done" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  result?: BackupRehearsalReport;
  error?: { code?: string; detail: string };
}>;

type StoredPayload = DeepReadonly<{
  ownerNodeId: string;
  ownerInstanceId: string;
  startedAt: string;
  source: Omit<BackupSourceOptions, "postgresTargetUrl">;
  postgresTargetUrlEncrypted?: string;
  cliPath?: string;
  requireCli?: boolean;
  finishedAt?: string;
  result?: BackupRehearsalReport;
  error?: { code?: string; detail: string };
}>;

function terminalPayload(payload: StoredPayload): Omit<StoredPayload, "postgresTargetUrlEncrypted"> {
  const { postgresTargetUrlEncrypted, ...retained } = payload;
  void postgresTargetUrlEncrypted;
  return retained;
}

function serializeError(error: unknown): { code?: string; detail: string } {
  return error instanceof BackupVerificationError
    ? { code: error.code, detail: error.message }
    : { detail: error instanceof Error ? error.message : String(error) };
}

function activeRehearsalConflict(error: unknown): boolean {
  if (databaseConstraint(error) !== "unique") return false;
  let current = error;
  const visited = new Set<unknown>();
  while (current !== null && typeof current === "object" && !visited.has(current) && visited.size < 8) {
    visited.add(current);
    const record = current as Readonly<Record<string, unknown>>;
    const constraint = record["constraint"] ?? record["constraint_name"];
    if (constraint === "durable_jobs_kind_dedupe_idx") return true;
    const message = typeof record["message"] === "string" ? record["message"] : "";
    if (message.includes("durable_jobs.kind") && message.includes("durable_jobs.dedupe_key")) return true;
    current = record["cause"];
  }
  return false;
}
function parsePayload(value: Readonly<Record<string, unknown>>): StoredPayload | null {
  if (
    typeof value["ownerNodeId"] !== "string" ||
    typeof value["ownerInstanceId"] !== "string" ||
    typeof value["startedAt"] !== "string" ||
    value["source"] === null ||
    typeof value["source"] !== "object" ||
    Array.isArray(value["source"])
  ) {
    return null;
  }
  const source = value["source"] as Record<string, unknown>;
  if (typeof source["sourcePath"] !== "string" || source["sourcePath"] === "") return null;
  return value as unknown as StoredPayload;
}

function publicJob(row: DeepReadonly<typeof durableJobs.$inferSelect>): BackupRehearsalJob | undefined {
  const payload = parsePayload(row.payload);
  if (payload === null) return undefined;
  if (!["running", "done", "failed", "interrupted"].includes(row.status)) return undefined;
  return {
    id: row.id,
    status: row.status as BackupRehearsalJob["status"],
    startedAt: payload.startedAt,
    ...(payload.finishedAt === undefined ? {} : { finishedAt: payload.finishedAt }),
    ...(payload.result === undefined ? {} : { result: payload.result }),
    ...(payload.error === undefined ? {} : { error: payload.error }),
  };
}

async function pruneTerminalJobs(): Promise<void> {
  const rows = await db.query.durableJobs.findMany({
    where: eq(durableJobs.kind, BACKUP_REHEARSAL_KIND),
    orderBy: [asc(durableJobs.createdAt), asc(durableJobs.id)],
  });
  const terminal = rows.filter((row): boolean => row.status !== "running");
  const excess = terminal.slice(0, Math.max(0, terminal.length - MAX_REHEARSAL_JOBS));
  for (const row of excess) await db.delete(durableJobs).where(eq(durableJobs.id, row.id));
}

async function ownerAlive(payload: StoredPayload, databaseNow: number): Promise<boolean> {
  if (payload.ownerInstanceId === controlPlaneInstanceId) return true;
  const row = await db.query.controlPlaneNodes.findFirst({
    where: and(
      eq(controlPlaneNodes.instanceId, payload.ownerInstanceId),
      gte(controlPlaneNodes.lastHeartbeatAt, databaseNow - OWNER_STALE_MS),
    ),
    columns: { id: true },
  });
  return row !== undefined;
}

export async function reconcileInterruptedBackupRehearsals(): Promise<void> {
  const running = await db.query.durableJobs.findMany({
    where: and(eq(durableJobs.kind, BACKUP_REHEARSAL_KIND), eq(durableJobs.status, "running")),
  });
  if (running.length === 0) return;
  const databaseNow = await databaseCurrentTimeMs();
  for (const row of running) {
    const payload = parsePayload(row.payload);
    if (payload === null || (await ownerAlive(payload, databaseNow))) continue;
    const finishedAt = new Date(databaseNow).toISOString();
    const error = {
      code: "owner-interrupted",
      detail: "The API replica running this restore rehearsal stopped before it completed.",
    };
    await db
      .update(durableJobs)
      .set({
        status: "interrupted",
        dedupeKey: null,
        lastError: error.detail,
        payload: { ...terminalPayload(payload), finishedAt, error },
        updatedAt: databaseNow,
      })
      .where(
        and(
          eq(durableJobs.id, row.id),
          eq(durableJobs.kind, BACKUP_REHEARSAL_KIND),
          eq(durableJobs.status, "running"),
          eq(durableJobs.dedupeKey, ACTIVE_REHEARSAL_KEY),
        ),
      );
  }
}

async function completeJob(
  id: string,
  payload: StoredPayload,
  status: "done" | "failed",
  update: DeepReadonly<{ result?: BackupRehearsalReport; error?: { code?: string; detail: string } }>,
): Promise<void> {
  const finishedAt = new Date().toISOString();
  await db
    .update(durableJobs)
    .set({
      status,
      dedupeKey: null,
      payload: { ...terminalPayload(payload), finishedAt, ...update },
      lastError: update.error?.detail ?? null,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(durableJobs.id, id),
        eq(durableJobs.kind, BACKUP_REHEARSAL_KIND),
        eq(durableJobs.status, "running"),
        eq(durableJobs.dedupeKey, ACTIVE_REHEARSAL_KEY),
      ),
    );
  await pruneTerminalJobs();
}

async function persistCompletion(
  id: string,
  payload: StoredPayload,
  status: "done" | "failed",
  update: DeepReadonly<{ result?: BackupRehearsalReport; error?: { code?: string; detail: string } }>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await completeJob(id, payload, status, update);
      return;
    } catch (error: unknown) {
      lastError = error;
    }
  }
  log.error("Unable to persist backup rehearsal completion", {
    jobId: id,
    status,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
}

async function executeJob(id: string, payload: StoredPayload): Promise<void> {
  try {
    const postgresTargetUrl =
      payload.postgresTargetUrlEncrypted === undefined
        ? undefined
        : await decryptSecret(payload.postgresTargetUrlEncrypted);
    const result = await runRestoreRehearsal({
      source: { ...payload.source, ...(postgresTargetUrl === undefined ? {} : { postgresTargetUrl }) },
      id,
      ...(payload.cliPath === undefined ? {} : { cliPath: payload.cliPath }),
      ...(payload.requireCli === true ? { requireCli: true } : {}),
    });
    await persistCompletion(id, payload, "done", { result });
  } catch (error: unknown) {
    await persistCompletion(id, payload, "failed", { error: serializeError(error) });
  }
}

export async function startBackupRehearsalJob(
  input: Readonly<{
    source: BackupSourceOptions;
    cliPath?: string;
    requireCli?: boolean;
  }>,
): Promise<{ created: boolean; job: BackupRehearsalJob }> {
  await reconcileInterruptedBackupRehearsals();
  const id = crypto.randomUUID();
  const now = Date.now();
  const { postgresTargetUrl, ...source } = input.source;
  const payload: StoredPayload = {
    ownerNodeId: controlPlaneNodeId(),
    ownerInstanceId: controlPlaneInstanceId,
    startedAt: new Date(now).toISOString(),
    source,
    ...(postgresTargetUrl === undefined ? {} : { postgresTargetUrlEncrypted: await encryptSecret(postgresTargetUrl) }),
    ...(input.cliPath === undefined ? {} : { cliPath: input.cliPath }),
    ...(input.requireCli === true ? { requireCli: true } : {}),
  };
  const row: typeof durableJobs.$inferInsert = {
    id,
    kind: BACKUP_REHEARSAL_KIND,
    dedupeKey: ACTIVE_REHEARSAL_KEY,
    status: "running",
    payload: { ...payload, source: { ...payload.source } },
    payloadSchemaVersion: 1,
    attempts: 0,
    runAfter: now,
    lockedBy: payload.ownerInstanceId,
    lockToken: null,
    leaseExpiresAt: null,
    heartbeatAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await db.insert(durableJobs).values(row);
      break;
    } catch (error: unknown) {
      if (!activeRehearsalConflict(error)) throw error;
      const active = await db.query.durableJobs.findFirst({
        where: and(
          eq(durableJobs.kind, BACKUP_REHEARSAL_KIND),
          eq(durableJobs.dedupeKey, ACTIVE_REHEARSAL_KEY),
          eq(durableJobs.status, "running"),
        ),
      });
      const job = active === undefined ? undefined : publicJob(active);
      if (job !== undefined) return { created: false, job };
      if (attempt === 1) throw error;
    }
  }
  const job = publicJob(row as typeof durableJobs.$inferSelect);
  if (job === undefined) throw new Error("Created backup rehearsal row is invalid");
  void executeJob(id, payload);
  return { created: true, job };
}

export async function getBackupRehearsalJob(id: string): Promise<BackupRehearsalJob | undefined> {
  await reconcileInterruptedBackupRehearsals();
  const row = await db.query.durableJobs.findFirst({
    where: and(eq(durableJobs.id, id), eq(durableJobs.kind, BACKUP_REHEARSAL_KIND)),
  });
  return row === undefined ? undefined : publicJob(row);
}

export const BACKUP_REHEARSAL_RECORD_KIND = BACKUP_REHEARSAL_KIND;
