import { and, asc, eq, gte } from "drizzle-orm";
import { databaseCurrentTimeMs, db } from "../db";
import { controlPlaneNodes, durableJobs } from "../db/schema";
import { controlPlaneInstanceId, controlPlaneNodeId } from "./ha-config";
import {
  BackupVerificationError,
  runRestoreRehearsal,
  type BackupRehearsalReport,
  type BackupSourceOptions,
} from "./backup-verification";
import type { DeepReadonly } from "./types";

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
  source: BackupSourceOptions;
  cliPath?: string;
  requireCli?: boolean;
  finishedAt?: string;
  result?: BackupRehearsalReport;
  error?: { code?: string; detail: string };
}>;

function serializeError(error: unknown): { code?: string; detail: string } {
  return error instanceof BackupVerificationError
    ? { code: error.code, detail: error.message }
    : { detail: error instanceof Error ? error.message : String(error) };
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
        payload: { ...payload, finishedAt, error },
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
      payload: { ...payload, finishedAt, ...update },
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

async function executeJob(id: string, payload: StoredPayload): Promise<void> {
  try {
    const result = await runRestoreRehearsal({
      source: payload.source,
      id,
      ...(payload.cliPath === undefined ? {} : { cliPath: payload.cliPath }),
      ...(payload.requireCli === true ? { requireCli: true } : {}),
    });
    await completeJob(id, payload, "done", { result });
  } catch (error: unknown) {
    await completeJob(id, payload, "failed", { error: serializeError(error) });
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
  const payload: StoredPayload = {
    ownerNodeId: controlPlaneNodeId(),
    ownerInstanceId: controlPlaneInstanceId,
    startedAt: new Date(now).toISOString(),
    source: input.source,
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
  try {
    await db.insert(durableJobs).values(row);
  } catch (error: unknown) {
    const active = await db.query.durableJobs.findFirst({
      where: and(
        eq(durableJobs.kind, BACKUP_REHEARSAL_KIND),
        eq(durableJobs.dedupeKey, ACTIVE_REHEARSAL_KEY),
        eq(durableJobs.status, "running"),
      ),
    });
    const job = active === undefined ? undefined : publicJob(active);
    if (job === undefined) throw error;
    return { created: false, job };
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
