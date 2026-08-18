// SQLite -> PostgreSQL migration wizard admin endpoints.
//
// Thin REST wrapper over src/lib/migration/wizard.ts (the crash-safe state
// machine). The UI drives the 14-step flow through these endpoints:
//
//   GET  /api/v2/admin/db-migration/status            wizard state + guard info
//   POST /api/v2/admin/db-migration/test-connection   validate a postgres URL
//   POST /api/v2/admin/db-migration/compatibility     check target emptiness
//   POST /api/v2/admin/db-migration/start             enter drain + copy (202)
//   POST /api/v2/admin/db-migration/cancel            request cancellation
//   POST /api/v2/admin/db-migration/switch            switch boot config to pg
//   POST /api/v2/admin/db-migration/restart           schedule in-place restart
//
// The wizard core owns the actual work (maintenance gate, WAL checkpoint,
// schema DDL, record copy, verification, boot-config switch); these routes
// only gate on site-admin, translate bodies, and surface WizardError as 409.
import { Elysia } from "elysia";
import { authPlugin } from "../../auth";
import {
  WizardError,
  checkCompatibility,
  environmentDatabaseUrlWarning,
  loadWizardState,
  maskPostgresUrl,
  requestCancel,
  restartDisabled,
  restartProcess,
  sourceSqlitePath,
  startMigration,
  switchBackend,
  testConnection,
  wizardJobRunning,
  wizardStatus,
} from "../../lib/migration/wizard";
import type { ParamCtx } from "./types";

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

function urlAttribute(body: unknown): string {
  if (body === null || typeof body !== "object") return "";
  const data = (body as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return "";
  const attributes = (data as { attributes?: unknown }).attributes;
  if (attributes === null || typeof attributes !== "object") return "";
  const url = (attributes as { url?: unknown }).url;
  return typeof url === "string" ? url.trim() : "";
}

/** Run a wizard core call, translating WizardError into a 409 response. */
async function runWizardAction<T>(
  action: () => Promise<T> | T,
  set: ParamCtx["set"],
): Promise<{ data: T } | ReturnType<typeof errorBody>> {
  try {
    return { data: await action() };
  } catch (error: unknown) {
    if (error instanceof WizardError) {
      setStatus(set, 409);
      return errorBody(409, "Migration Conflict", error.message);
    }
    throw error;
  }
}

export const dbMigrationRoutes = new Elysia({ name: "admin-db-migration" })
  .use(authPlugin)
  .get("/api/v2/admin/db-migration/status", ({ user, set }: ParamCtx): unknown => {
    if (!requireAdmin(user, set)) return;
    const state = wizardStatus() ?? loadWizardState();
    let sourceDatabase: { path: string; memory: boolean } | null;
    try {
      sourceDatabase = sourceSqlitePath();
    } catch {
      // The wizard only migrates FROM SQLite; a PostgreSQL backend has no
      // sqlite source and must not turn the status endpoint into a 500.
      sourceDatabase = null;
    }
    return {
      data: {
        wizard: state,
        running: wizardJobRunning(),
        "source-database": sourceDatabase,
        "restart-disabled": restartDisabled(),
        "environment-database-url": environmentDatabaseUrlWarning(),
      },
    };
  })
  .post("/api/v2/admin/db-migration/test-connection", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (!requireAdmin(user, set)) return;
    const url = urlAttribute(body);
    if (url === "") {
      setStatus(set, 422);
      return errorBody(422, "Unprocessable Entity", "A postgres connection URL is required");
    }
    return runWizardAction((): Promise<unknown> => testConnection(url), set);
  })
  .post("/api/v2/admin/db-migration/compatibility", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (!requireAdmin(user, set)) return;
    const url = urlAttribute(body);
    if (url === "") {
      setStatus(set, 422);
      return errorBody(422, "Unprocessable Entity", "A postgres connection URL is required");
    }
    return runWizardAction((): Promise<unknown> => checkCompatibility(url), set);
  })
  .post("/api/v2/admin/db-migration/start", async ({ user, body, set }: ParamCtx): Promise<unknown> => {
    if (!requireAdmin(user, set)) return;
    const url = urlAttribute(body);
    if (url === "") {
      setStatus(set, 422);
      return errorBody(422, "Unprocessable Entity", "A postgres connection URL is required");
    }
    if (wizardJobRunning()) {
      setStatus(set, 409);
      return errorBody(409, "Migration Conflict", "A migration is already running");
    }
    const result = await runWizardAction((): unknown => startMigration(url), set);
    if (result !== undefined && "data" in result) setStatus(set, 202);
    return result;
  })
  .post("/api/v2/admin/db-migration/cancel", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (!requireAdmin(user, set)) return;
    return runWizardAction((): unknown => requestCancel(), set);
  })
  .post("/api/v2/admin/db-migration/switch", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (!requireAdmin(user, set)) return;
    return runWizardAction((): unknown => switchBackend(), set);
  })
  .post("/api/v2/admin/db-migration/restart", async ({ user, set }: ParamCtx): Promise<unknown> => {
    if (!requireAdmin(user, set)) return;
    // restartProcess throws WizardError when the backend has not been
    // switched; route it through the wrapper so it surfaces as 409, not 500.
    return runWizardAction((): unknown => restartProcess(), set);
  });

// Re-exported for tests that want to assert URL masking.
export { maskPostgresUrl };
