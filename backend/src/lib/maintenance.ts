// Maintenance/drain gate (storage/maintenance.json).
//
// The SQLite → PostgreSQL migration wizard needs to stop run execution while
// it takes a consistent snapshot of the source database. This module is the
// single source of truth for that gate:
//
//   - `isMaintenanceActive()` gates run claims (worker queue, agent jobs) and
//     run creation (API routes, VCS webhooks, auto-destroy/scheduled polls).
//   - The state is persisted so a crash mid-migration keeps the gate closed
//     until the operator resumes or aborts the wizard.
//
// The file is deliberately tiny and separate from the wizard state file so
// other components (worker, routes) can gate on it without importing the
// whole wizard machinery.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type MaintenanceSource = "migration-wizard";

export type MaintenanceState = Readonly<{
  active: boolean;
  reason: string | null;
  enteredAt: string | null;
  source: MaintenanceSource | null;
}>;

const INACTIVE: MaintenanceState = { active: false, reason: null, enteredAt: null, source: null };

const storageDir = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"));

export function maintenanceFilePath(storageDirOverride?: string): string {
  return join(storageDirOverride ?? storageDir, "maintenance.json");
}

function parseState(raw: unknown): MaintenanceState {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return INACTIVE;
  const record = raw as Record<string, unknown>;
  if (record.active !== true) return INACTIVE;
  return {
    active: true,
    reason: typeof record.reason === "string" ? record.reason : null,
    enteredAt: typeof record.enteredAt === "string" ? record.enteredAt : null,
    source: record.source === "migration-wizard" ? "migration-wizard" : null,
  };
}

function readStateFromDisk(): MaintenanceState {
  try {
    const text = readFileSync(maintenanceFilePath(), "utf8");
    return parseState(JSON.parse(text));
  } catch (error: unknown) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return INACTIVE;
    // A corrupt maintenance file must fail closed (gate stays closed) rather
    // than silently unblocking run execution during a migration.
    return { active: true, reason: "maintenance file unreadable", enteredAt: null, source: null };
  }
}

let cached: MaintenanceState | undefined;

function currentState(): MaintenanceState {
  if (cached === undefined) cached = readStateFromDisk();
  return cached;
}

function persist(state: MaintenanceState): void {
  const path = maintenanceFilePath();
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  cached = state;
}

/** True while maintenance/drain mode is active (run claims and creation blocked). */
export function isMaintenanceActive(): boolean {
  return currentState().active;
}

/** Read the current maintenance state (for status endpoints and the UI). */
export function maintenanceSnapshot(): MaintenanceState {
  return currentState();
}

/** Enter maintenance mode. Idempotent: re-entering refreshes the reason. */
export function enterMaintenance(reason: string, source: MaintenanceSource): MaintenanceState {
  const state: MaintenanceState = {
    active: true,
    reason,
    enteredAt: new Date().toISOString(),
    source,
  };
  persist(state);
  return state;
}

/** Leave maintenance mode. Idempotent. */
export function exitMaintenance(): MaintenanceState {
  persist(INACTIVE);
  return INACTIVE;
}

/** Test helper: drop the in-memory cache (tests use a fresh STORAGE_DIR). */
/** @public Intentional surface: benchmark/test hook or cross-module API. */
export function resetMaintenanceCacheForTests(): void {
  cached = undefined;
}
