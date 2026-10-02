// Site-administrator backup evidence operations.
//
// These endpoints create evidence, verify a supplied backup, and run a
// disposable restore rehearsal.  They intentionally do not expose a restore
// or cutover endpoint: replacing the active database requires an operator's
// shutdown, reconciliation, and separate confirmation plan.
import { Elysia } from "elysia";
import { and, desc, eq, lt } from "drizzle-orm";
import { authPlugin } from "../../auth";
import { db } from "../../db";
import { backupRehearsalJobs } from "../../db/schema";
import {
  BackupVerificationError,
  createBackupManifest,
  createBackupManifestForSource,
  readBackupStatus,
  runRestoreRehearsal,
  verifyBackupIntegrity,
  type BackupIntegrityReport,
  type BackupRehearsalReport,
  type BackupSourceOptions,
} from "../../lib/backup-verification";
import type { ParamCtx } from "./types";

type BackupJob = Readonly<{
  id: string;
  status: "running" | "done" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  result?: BackupRehearsalReport;
  error?: { code?: string; detail: string };
}>;

/** A running rehearsal whose owner must have disappeared is reaped instead of
 * blocking admission forever. Rehearsals bind to their local CLI for the
 * duration, so an hour is generous. */
const MAX_REHEARSAL_RUNTIME_MS = 60 * 60 * 1000;

function setStatus(set: ParamCtx["set"], status: number): void {
  (set as { status?: number }).status = status;
}

function errorBody(set: ParamCtx["set"], status: number, detail: string, code?: string): Record<string, unknown> {
  setStatus(set, status);
  return {
    errors: [
      {
        status: String(status),
        title: status === 404 ? "Not Found" : status === 409 ? "Conflict" : "Unprocessable Entity",
        detail,
        ...(code === undefined ? {} : { code }),
      },
    ],
  };
}

function requireAdmin(user: ParamCtx["user"], set: ParamCtx["set"]): boolean {
  if (user?.isSiteAdmin === true) return true;
  setStatus(set, 404);
  return false;
}

function attrsOf(body: unknown): Readonly<Record<string, unknown>> {
  if (body === null || typeof body !== "object") return {};
  const data = (body as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return {};
  const attrs = (data as { attributes?: unknown }).attributes;
  return attrs !== null && typeof attrs === "object" && !Array.isArray(attrs) ? (attrs as Record<string, unknown>) : {};
}

function sourceFromAttributes(attrs: Readonly<Record<string, unknown>>): BackupSourceOptions | null {
  const raw = attrs["backup-path"] ?? attrs["source-path"];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const source: BackupSourceOptions = {
    sourcePath: raw,
    ...(typeof attrs["storage-path"] === "string" && attrs["storage-path"].trim() !== ""
      ? { storagePath: attrs["storage-path"] }
      : {}),
    ...(typeof attrs["database-path"] === "string" && attrs["database-path"].trim() !== ""
      ? { databasePath: attrs["database-path"] }
      : {}),
  };
  return source;
}

function reportResource(report: BackupIntegrityReport): Record<string, unknown> {
  return {
    passed: report.passed,
    checks: report.checks,
    "last-verified-restore-at": report.lastVerifiedRestoreAt,
    ...(report.manifest === null ? {} : { manifest: report.manifest }),
  };
}

/** Mark abandoned running rehearsals (owner process died) as interrupted. Runs
 * cross-replica because every replica applies the same deterministic rule. */
async function reapStaleRehearsals(): Promise<void> {
  const cutoff = Date.now() - MAX_REHEARSAL_RUNTIME_MS;
  await db
    .update(backupRehearsalJobs)
    .set({ status: "interrupted", finishedAt: Date.now(), updatedAt: Date.now() })
    .where(and(eq(backupRehearsalJobs.status, "running"), lt(backupRehearsalJobs.startedAt, cutoff)));
}

function rowToJob(row: typeof backupRehearsalJobs.$inferSelect): BackupJob {
  return {
    id: row.id,
    status: row.status as BackupJob["status"],
    startedAt: new Date(row.startedAt).toISOString(),
    ...(row.finishedAt === null || row.finishedAt === undefined
      ? {}
      : { finishedAt: new Date(row.finishedAt).toISOString() }),
    ...(row.result === null || row.result === undefined
      ? {}
      : { result: row.result as unknown as BackupRehearsalReport }),
    ...(row.error === null || row.error === undefined ? {} : { error: row.error }),
  };
}

async function persistRehearsalOutcome(
  id: string,
  outcome:
    | { status: "done"; result: BackupRehearsalReport }
    | { status: "failed"; error: { code?: string; detail: string } },
): Promise<void> {
  const now = Date.now();
  await db
    .update(backupRehearsalJobs)
    .set(
      outcome.status === "done"
        ? { status: "done", result: outcome.result, finishedAt: now, updatedAt: now }
        : { status: "failed", error: outcome.error, finishedAt: now, updatedAt: now },
    )
    .where(eq(backupRehearsalJobs.id, id));
}

function serializeError(error: unknown): { code?: string; detail: string } {
  return error instanceof BackupVerificationError
    ? { code: error.code, detail: error.message }
    : { detail: error instanceof Error ? error.message : String(error) };
}

async function startRehearsal(
  attrs: Readonly<Record<string, unknown>>,
  set: ParamCtx["set"],
): Promise<Record<string, unknown>> {
  const source = sourceFromAttributes(attrs);
  if (source === null) return errorBody(set, 422, "backup-path is required");
  await reapStaleRehearsals().catch((): void => undefined);
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  // The partial unique index on status='running' fences concurrent insertion
  // across replicas: only one rehearsal can enter the running state.
  try {
    await db.insert(backupRehearsalJobs).values({ id, status: "running", startedAt });
  } catch {
    return errorBody(set, 409, "A restore rehearsal is already running");
  }
  void (async (): Promise<void> => {
    try {
      const result = await runRestoreRehearsal({
        source,
        id,
        ...(typeof attrs["cli-path"] === "string" && attrs["cli-path"].trim() !== ""
          ? { cliPath: attrs["cli-path"] }
          : {}),
        ...(attrs["require-cli"] === true ? { requireCli: true } : {}),
      });
      await persistRehearsalOutcome(id, { status: "done", result });
    } catch (error) {
      await persistRehearsalOutcome(id, { status: "failed", error: serializeError(error) }).catch(
        (dbError: unknown): void => {
          console.error("Failed to persist rehearsal failure", dbError);
        },
      );
    }
  })();
  setStatus(set, 202);
  return {
    data: {
      type: "backup-restore-rehearsals",
      id,
      attributes: { status: "running", "started-at": new Date(startedAt).toISOString() },
    },
  };
}

export const backupRoutes = new Elysia({ name: "admin-backups" })
  .use(authPlugin)
  .post("/api/v2/admin/backups/manifests", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (!requireAdmin(user, set)) return errorBody(set, 404, "Not Found");
    const attrs = attrsOf(body);
    try {
      const source = sourceFromAttributes(attrs);
      const result =
        source === null
          ? await createBackupManifest({
              ...(attrs["persist"] === false ? { persist: false } : {}),
              ...(typeof attrs["storage-path"] === "string" && attrs["storage-path"].trim() !== ""
                ? { storagePath: attrs["storage-path"] }
                : {}),
              ...(typeof attrs["database-path"] === "string" && attrs["database-path"].trim() !== ""
                ? { databasePath: attrs["database-path"] }
                : {}),
              ...(typeof attrs["output-directory"] === "string" && attrs["output-directory"].trim() !== ""
                ? { outputDirectory: attrs["output-directory"] }
                : {}),
            })
          : await createBackupManifestForSource(source, {
              ...(attrs["persist"] === false ? { persist: false } : {}),
              ...(typeof attrs["output-directory"] === "string" && attrs["output-directory"].trim() !== ""
                ? { outputDirectory: attrs["output-directory"] }
                : {}),
            });
      setStatus(set, 201);
      return {
        data: {
          type: "backup-manifests",
          id: result.manifest.manifestSha256,
          attributes: { manifest: result.manifest, "manifest-path": result.path },
        },
      };
    } catch (error) {
      return errorBody(set, 422, serializeError(error).detail, serializeError(error).code);
    }
  })
  .get("/api/v2/admin/backups/status", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (!requireAdmin(user, set)) return errorBody(set, 404, "Not Found");
    const status = await readBackupStatus();
    return {
      data: {
        type: "backup-status",
        id: "current",
        attributes: {
          "last-verified-restore-at": status.lastVerifiedRestoreAt,
          "last-verified-manifest-sha256": status.lastVerifiedManifestSha256,
          "last-rehearsal-id": status.lastRehearsalId,
        },
      },
    };
  })
  .post("/api/v2/admin/backups/integrity-checks", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (!requireAdmin(user, set)) return errorBody(set, 404, "Not Found");
    const source = sourceFromAttributes(attrsOf(body));
    if (source === null) return errorBody(set, 422, "backup-path is required");
    try {
      const report = await verifyBackupIntegrity(source);
      return {
        data: {
          type: "backup-integrity-checks",
          id: report.manifest?.manifestSha256 ?? crypto.randomUUID(),
          attributes: reportResource(report),
        },
      };
    } catch (error) {
      const serialized = serializeError(error);
      return errorBody(set, 422, serialized.detail, serialized.code);
    }
  })
  .post("/api/v2/admin/backups/verify", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (!requireAdmin(user, set)) return errorBody(set, 404, "Not Found");
    const source = sourceFromAttributes(attrsOf(body));
    if (source === null) return errorBody(set, 422, "backup-path is required");
    try {
      const report = await verifyBackupIntegrity(source);
      return {
        data: {
          type: "backup-integrity-checks",
          id: report.manifest?.manifestSha256 ?? crypto.randomUUID(),
          attributes: reportResource(report),
        },
      };
    } catch (error) {
      const serialized = serializeError(error);
      return errorBody(set, 422, serialized.detail, serialized.code);
    }
  })
  .post("/api/v2/admin/backups/restore-rehearsals", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (!requireAdmin(user, set)) return errorBody(set, 404, "Not Found");
    return startRehearsal(attrsOf(body), set);
  })
  .post("/api/v2/admin/backups/restore-rehearsal", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (!requireAdmin(user, set)) return errorBody(set, 404, "Not Found");
    return startRehearsal(attrsOf(body), set);
  })
  .get(
    "/api/v2/admin/backups/restore-rehearsals/:rehearsal_id",
    async ({ user, params, set }: ParamCtx): Promise<unknown> => {
      if (!requireAdmin(user, set)) return errorBody(set, 404, "Not Found");
      await reapStaleRehearsals().catch((): void => undefined);
      const row = await db.query.backupRehearsalJobs.findFirst({
        where: eq(backupRehearsalJobs.id, params["rehearsal_id"] ?? ""),
        orderBy: [desc(backupRehearsalJobs.startedAt)],
      });
      if (row === undefined) return errorBody(set, 404, "No such restore rehearsal");
      const job = rowToJob(row);
      return {
        data: {
          type: "backup-restore-rehearsals",
          id: job.id,
          attributes: {
            status: job.status,
            "started-at": job.startedAt,
            ...(job.finishedAt === undefined ? {} : { "finished-at": job.finishedAt }),
            ...(job.result === undefined ? {} : { result: job.result }),
            ...(job.error === undefined ? {} : { error: job.error }),
          },
        },
      };
    },
  );
