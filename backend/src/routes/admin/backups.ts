// Site-administrator backup evidence operations.
//
// These endpoints create evidence, verify a supplied backup, and run a
// disposable restore rehearsal.  They intentionally do not expose a restore
// or cutover endpoint: replacing the active database requires an operator's
// shutdown, reconciliation, and separate confirmation plan.
import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import {
  BackupVerificationError,
  createBackupManifest,
  createBackupManifestForSource,
  readBackupStatus,
  verifyBackupIntegrity,
  type BackupIntegrityReport,
  type BackupSourceOptions,
} from "../../lib/backup-verification";
import { getBackupRehearsalJob, startBackupRehearsalJob } from "../../lib/backup-rehearsal-jobs";
import type { ParamCtx } from "./types";

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
    ...(typeof attrs["postgres-target-url"] === "string" && attrs["postgres-target-url"].trim() !== ""
      ? { postgresTargetUrl: attrs["postgres-target-url"] }
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
  const started = await startBackupRehearsalJob({
    source,
    ...(typeof attrs["cli-path"] === "string" && attrs["cli-path"].trim() !== "" ? { cliPath: attrs["cli-path"] } : {}),
    ...(attrs["require-cli"] === true ? { requireCli: true } : {}),
  });
  if (!started.created) return errorBody(set, 409, "A restore rehearsal is already running");
  setStatus(set, 202);
  return {
    data: {
      type: "backup-restore-rehearsals",
      id: started.job.id,
      attributes: { status: started.job.status, "started-at": started.job.startedAt },
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
          "last-verified-database-driver": status.lastVerifiedDatabaseDriver,
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
      const job = await getBackupRehearsalJob(params["rehearsal_id"] ?? "");
      if (job === undefined) return errorBody(set, 404, "No such restore rehearsal");
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
