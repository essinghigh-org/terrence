// ---------------------------------------------------------------------------
// Postgres -> SQLite export admin endpoints (kanban task 4/4).
//
// Entry point next to the forward migration wizard, with the same drain-mode
// guard rails. The export runs as a background job so the UI can show
// per-table progress; completed files live in <storage>/exports and can be
// listed, downloaded and deleted through these endpoints.
//
//   POST /api/v2/admin/db-export/test-connection   validate a source URL
//   POST /api/v2/admin/db-export                   start an export job (202)
//   GET  /api/v2/admin/db-export/jobs/:job_id      job status + progress
//   GET  /api/v2/admin/db-export                   list export files
//   GET  /api/v2/admin/db-export/files/:file_name  download an export file
//   DELETE /api/v2/admin/db-export/files/:file_name  remove an export file
// ---------------------------------------------------------------------------
import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import { runDbExport, listExportFiles, deleteExportFile, exportFilePath } from "../../lib/db-export";
import { DbExportError } from "../../lib/db-export";
import { createPgSource } from "../../lib/db-transfer";
import { maskPostgresUrl } from "../../lib/migration/wizard";
import type { DbExportProgress, DbExportResult } from "../../lib/db-export";
import type { TransferSource } from "../../lib/db-transfer";
import type { ParamCtx } from "./types";

export type ExportJob = {
  readonly id: string;
  status: "running" | "done" | "failed";
  readonly startedAt: number;
  finishedAt?: number;
  table?: string;
  rowsCopied?: number;
  error?: { code?: string; title: string; detail?: string };
  result?: DbExportResult;
}

// In-memory job registry: jobs live for the lifetime of the process (the
// wizard's forward path uses the same model). Completed files are durable
// on disk and remain downloadable after a restart.
const jobs = new Map<string, ExportJob>();
const MAX_JOBS = 20;

function pruneJobs(): void {
  while (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (oldest === undefined) return;
    jobs.delete(oldest[0]);
  }
}

function setStatus(set: ParamCtx["set"], status: number): void {
  (set as { status?: number }).status = status;
}

function errorBody(status: number, title: string, detail: string, code?: string): {
  errors: { status: string; title: string; detail: string; code?: string }[];
} {
  return {
    errors: [{
      status: String(status),
      title,
      detail,
      ...(code === undefined ? {} : { code }),
    }],
  };
}

function requireAdmin(user: ParamCtx["user"], set: ParamCtx["set"]): boolean {
  if (user?.isSiteAdmin !== true) {
    setStatus(set, 404);
    return false;
  }
  return true;
}

function attrsOf(body: unknown): Readonly<Record<string, unknown>> {
  if (body === null || typeof body !== "object") return {};
  const data = (body as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return {};
  const attributes = (data as { attributes?: unknown }).attributes;
  if (attributes === null || typeof attributes !== "object") return {};
  return attributes as Record<string, unknown>;
}

export type DbExportRouteDeps = {
  /** Override source construction (tests inject SQLite-backed sources). */
  readonly sourceFactory?: (url: string) => TransferSource;
}

export function createDbExportRoutes(deps: DbExportRouteDeps = {}) {
  const sourceFactory = deps.sourceFactory ?? ((url: string): TransferSource => createPgSource(url));

  return new Elysia({ name: "admin-db-export" })
    .use(authPlugin)
    .post("/api/v2/admin/db-export/test-connection", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
      if (!requireAdmin(user, set)) return errorBody(404, "Not Found", "Not Found");
      const url = typeof attrsOf(body)["postgres-url"] === "string" ? attrsOf(body)["postgres-url"] as string : "";
      if (url.trim() === "") {
        setStatus(set, 422);
        return errorBody(422, "Unprocessable Entity", "postgres-url is required");
      }
      try {
        const connection = sourceFactory(url);
        await connection.ping();
        const hasUsers = await connection.hasTable("users");
        await connection.endSnapshot();
        if (!hasUsers) {
          setStatus(set, 422);
          return errorBody(422, "Incompatible database", "The source database has no Terrence schema (missing users table)");
        }
        return { data: { type: "db-export-connection-tests", id: "current", attributes: { ok: true } } };
      } catch (error) {
        setStatus(set, 422);
        // Driver errors may echo the connection URL back; never expose
        // credentials. maskPostgresUrl redacts the password portion.
        const message = error instanceof Error ? maskPostgresUrl(error.message) : "Unknown connection error";
        return errorBody(422, "Connection failed", message);
      }
    })
    .post("/api/v2/admin/db-export", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
      if (!requireAdmin(user, set)) return errorBody(404, "Not Found", "Not Found");
      const attrs = attrsOf(body);
      const url = typeof attrs["postgres-url"] === "string" ? attrs["postgres-url"] : "";
      if (url.trim() === "") {
        setStatus(set, 422);
        return errorBody(422, "Unprocessable Entity", "postgres-url is required");
      }
      const outputName = typeof attrs["output-name"] === "string" && attrs["output-name"].trim() !== ""
        ? attrs["output-name"]
        : undefined;
      const force = attrs["force"] === true;

      // Only one export may run at a time: concurrent jobs could both pass the
      // output-name existence check and write the same file. Completed and
      // failed jobs stay eligible for the next export.
      if ([...jobs.values()].some((job): boolean => job.status === "running")) {
        setStatus(set, 409);
        return errorBody(409, "Export Conflict", "An export is already running; wait for it to finish");
      }

      const id = crypto.randomUUID();
      const job: ExportJob = { id, status: "running", startedAt: Date.now() };
      jobs.set(id, job);
      pruneJobs();
      setStatus(set, 202);
      void (async (): Promise<void> => {
        try {
          const result = await runDbExport(
            {
              pgUrl: url,
              ...(outputName === undefined ? {} : { outputName }),
              ...(force ? { force: true } : {}),
              ...(deps.sourceFactory === undefined ? {} : { sourceFactory: deps.sourceFactory }),
            },
            (progress: DbExportProgress) => {
              job.table = progress.table;
              job.rowsCopied = progress.rowsCopied;
            },
          );
          job.status = "done";
          job.finishedAt = Date.now();
          job.result = result;
        } catch (error) {
          job.status = "failed";
          job.finishedAt = Date.now();
          if (error instanceof DbExportError) {
            job.error = { code: error.code, title: "Export failed", detail: error.message };
          } else {
            const message = error instanceof Error ? error.message : String(error);
            job.error = { title: "Export failed", detail: message };
          }
        }
      })();
      return { data: { type: "db-exports", id, attributes: { status: "running" } } };
    })
    .get("/api/v2/admin/db-export/jobs/:job_id", async ({ user, params, set }: ParamCtx): Promise<unknown> => {
      if (!requireAdmin(user, set)) return errorBody(404, "Not Found", "Not Found");
      const job = jobs.get(params["job_id"] ?? "");
      if (job === undefined) {
        setStatus(set, 404);
        return errorBody(404, "Not Found", "No such export job");
      }
      const { id, status, startedAt, finishedAt, table, rowsCopied, error, result } = job;
      return {
        data: {
          type: "db-exports",
          id,
          attributes: {
            status,
            "started-at": startedAt,
            ...(finishedAt === undefined ? {} : { "finished-at": finishedAt }),
            ...(table === undefined ? {} : { table, "rows-copied": rowsCopied ?? 0 }),
            ...(error === undefined ? {} : { error }),
            ...(result === undefined ? {} : { result }),
          },
        },
      };
    })
    .get("/api/v2/admin/db-export", async ({ user, set }: ParamCtx): Promise<unknown> => {
      if (!requireAdmin(user, set)) return errorBody(404, "Not Found", "Not Found");
      return {
        data: listExportFiles().map((file) => ({
          type: "db-export-files",
          id: file.name,
          attributes: { "size-bytes": file.sizeBytes, "modified-at": file.modifiedAt },
        })),
      };
    })
    .get("/api/v2/admin/db-export/files/:file_name", async ({ user, params, set }: ParamCtx): Promise<unknown> => {
      if (!requireAdmin(user, set)) return errorBody(404, "Not Found", "Not Found");
      const name = params["file_name"] ?? "";
      let full: string;
      try {
        full = exportFilePath(name);
      } catch (error) {
        setStatus(set, 422);
        return errorBody(422, "Unprocessable Entity", error instanceof Error ? error.message : String(error));
      }
      const file = Bun.file(full);
      if (!(await file.exists())) {
        setStatus(set, 404);
        return errorBody(404, "Not Found", "No such export file");
      }
      // The header uses the sanitized bare file name (exportFilePath already
      // rejected traversal and unsafe characters), never the raw route param.
      const safeName = full.split("/").pop() ?? name;
      (set as { headers?: Record<string, string | number> }).headers = {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeName.replace(/["\r\n]/g, "")}"`,
      };
      return file;
    })
    .delete("/api/v2/admin/db-export/files/:file_name", async ({ user, params, set }: ParamCtx): Promise<unknown> => {
      if (!requireAdmin(user, set)) return errorBody(404, "Not Found", "Not Found");
      const name = params["file_name"] ?? "";
      let deleted: boolean;
      try {
        deleted = deleteExportFile(name);
      } catch (error) {
        setStatus(set, 422);
        return errorBody(422, "Unprocessable Entity", error instanceof Error ? error.message : String(error));
      }
      if (!deleted) {
        setStatus(set, 404);
        return errorBody(404, "Not Found", "No such export file");
      }
      setStatus(set, 204);
      return {};
    });
}

export const dbExportRoutes = createDbExportRoutes();
