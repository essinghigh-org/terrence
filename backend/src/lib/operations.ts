import { eq, inArray, and } from "drizzle-orm";
import { db } from "../db";
import { runs, workspaces } from "../db/schema";
import { getSettings, type Settings } from "./settings";
import { insertAgentApplyJobTx, type AgentJob } from "./agent-jobs";
import { auditLog } from "./utils";
import { reportRunVcsStatus } from "./webhooks";
import { storageDegradedReason } from "./storage-health";
import { queueRunNotification } from "./notifications";
import { log } from "./log";

// --- Maintenance windows (kanban 21.6) -------------------------------
// Global site setting `maintenance-windows`:
//   { enabled: boolean, windows: [{ days: number[] (0=Sun..6=Sat),
//       "start-time": "HH:MM", "end-time": "HH:MM", timezone: "UTC" }] }
// Applies are blocked OUTSIDE the configured windows; plans are never
// affected. Overnight windows (end <= start) span midnight.

export type MaintenanceWindow = Readonly<{
  days?: unknown;
  "start-time"?: unknown;
  "end-time"?: unknown;
  timezone?: unknown;
}>;

function windowDayNumbers(window: MaintenanceWindow): number[] {
  if (!Array.isArray(window.days)) return [];
  return window.days
    .filter((day): day is number => typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a: number, b: number): number => a - b);
}

function windowMinutes(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{1,2}:\d{2}$/.test(value)) return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const hours = Number.parseInt(match[1] ?? "0", 10);
  const minutes = Number.parseInt(match[2] ?? "0", 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

function localDayAndMinutes(window: MaintenanceWindow, now: Date): { day: number; minutes: number } | undefined {
  const timezone = typeof window.timezone === "string" && window.timezone !== "" ? window.timezone : "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const dayName = parts.find((part): boolean => part.type === "weekday")?.value;
    const hour = Number(parts.find((part): boolean => part.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((part): boolean => part.type === "minute")?.value ?? "0");
    if (dayName === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return undefined;
    const dayByShortName: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { day: dayByShortName[dayName] ?? 0, minutes: hour * 60 + minute };
  } catch {
    // Invalid timezone identifier: treat as UTC (same as the default above).
    return { day: now.getUTCDay(), minutes: now.getUTCHours() * 60 + now.getUTCMinutes() };
  }
}

export function inMaintenanceWindow(window: MaintenanceWindow, now: Date): boolean {
  const days = windowDayNumbers(window);
  const start = windowMinutes(window["start-time"]);
  const end = windowMinutes(window["end-time"]);
  if (days.length === 0 || start === undefined || end === undefined) return false;
  const local = localDayAndMinutes(window, now);
  if (local === undefined) return false;
  if (end > start) return days.includes(local.day) && local.minutes >= start && local.minutes < end;
  // Overnight window: [start, 24:00) on a listed day, plus [00:00, end)
  // on the day AFTER a listed day.
  if (days.includes(local.day) && local.minutes >= start) return true;
  return days.includes((local.day + 6) % 7) && local.minutes < end;
}

/** True when the window entry is structurally usable (has days and a
 * parseable start/end clock). Used to warn about misconfigured windows. */
export function isValidMaintenanceWindow(window: MaintenanceWindow): boolean {
  return windowDayNumbers(window).length > 0
    && windowMinutes(window["start-time"]) !== undefined
    && windowMinutes(window["end-time"]) !== undefined;
}

/** True when an apply must be blocked because the site has maintenance
 * windows configured and `now` is outside every one of them. */
export function maintenanceWindowsBlockApply(settings: Settings, now: Date): boolean {
  if (settings["enabled"] !== true) return false;
  const windows = Array.isArray(settings["windows"]) ? settings["windows"] as MaintenanceWindow[] : [];
  if (windows.length === 0) return false;
  if (windows.every((window: MaintenanceWindow): boolean => !isValidMaintenanceWindow(window))) {
    // A malformed window never matches, so with only malformed windows the
    // site would stay blocked forever. Log loudly so operators fix the
    // config; the blocking result is still returned (invalid windows simply
    // never match), which is the documented maintenance-window contract.
    log.warn("Maintenance windows are enabled but every configured window is malformed; applies will remain blocked until fixed", {
      windows,
    });
  }
  return !windows.some((window: MaintenanceWindow): boolean => inMaintenanceWindow(window, now));
}

/** True when the site requires external approval before applies (21.8). */
export function approvalWebhookBlocksApply(settings: Settings): boolean {
  return settings["enabled"] === true;
}

/** Reason an apply must be blocked right now, or null when applies are
 * allowed. Shared by the interactive route, the approval webhook, and the
 * worker's auto-apply path so no confirmation path can bypass the gates.
 * `skipApprovalGate` is set by the approval webhook itself: the webhook IS
 * the approval, so it must not block on the gate it exists to satisfy. */
export async function applyGateBlockReason(
  now: Date,
  skipApprovalGate = false,
): Promise<string | null> {
  const [approvalSettings, maintenanceSettings] = await Promise.all([
    getSettings("approval-webhook"),
    getSettings("maintenance-windows"),
  ]);
  const degraded = storageDegradedReason();
  if (degraded !== null) {
    return `Applies paused: ${degraded}`;
  }
  if (!skipApprovalGate && approvalWebhookBlocksApply(approvalSettings)) {
    return "Apply blocked: this instance requires approval through an external workflow (see admin approval-webhook settings)";
  }
  if (maintenanceWindowsBlockApply(maintenanceSettings, now)) {
    return "Applies are only allowed during maintenance windows (see admin maintenance-windows settings)";
  }
  return null;
}

// --- Apply confirmation (shared by API action + approval webhook) ----
// Mirrors the tail of POST /api/v2/runs/:run_id/actions/apply without
// the user/permission layer: the webhook path is machine-to-machine and
// authenticated by HMAC instead. The run must have a completed saved
// plan and must still be `planned`/`planned_and_saved`.

export type ConfirmRunResult = Readonly<{
  ok: boolean;
  status?: string;
  reason?: string;
}>;

export async function confirmRunForApply(
  runId: string,
  options: Readonly<{ isWebhookApproval?: boolean }> = {},
): Promise<ConfirmRunResult> {
  const before = await db.query.runs.findFirst({
    where: and(eq(runs.id, runId), inArray(runs.status, ["planned", "planned_and_saved"])),
  });
  if (before === undefined) {
    return { ok: false, reason: "Run must have a completed saved plan before apply" };
  }
  // The maintenance gate applies to every confirmation path, not only the
  // interactive route (otherwise a confirmation could start an apply outside
  // the allowed schedule). The approval gate applies everywhere except the
  // webhook itself, which is the approval.
  const blockReason = await applyGateBlockReason(new Date(), options.isWebhookApproval === true);
  if (blockReason !== null) {
    return { ok: false, reason: blockReason };
  }
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, before.workspaceId) });
  if (workspace === undefined) {
    return { ok: false, reason: "Run workspace no longer exists" };
  }
  if (workspace.executionMode === "agent") {
    const poolId = workspace.agentPoolId;
    if (poolId === null) return { ok: false, reason: "The workspace does not have an agent pool" };
    // Confirmation CAS and apply-job creation are ONE transaction (kanban
    // t_c5f59537): a crash between the two previously left the run confirmed
    // with no job, permanently desynced. A failure rolls back the confirm.
    let queued: AgentJob | undefined;
    let queueError: string | null = null;
    try {
      queued = await db.transaction(async (transaction): Promise<AgentJob | undefined> => {
        const tx = transaction as unknown as typeof db;
        const confirmedTimestamps = {
          ...(before.statusTimestamps ?? {}),
          "confirmed-at": new Date().toISOString(),
        };
        const confirmed = await tx.update(runs).set({
          status: "confirmed",
          statusTimestamps: confirmedTimestamps,
        }).where(and(eq(runs.id, runId), eq(runs.status, before.status))).returning({ id: runs.id });
        if (confirmed.length === 0) return undefined;
        return insertAgentApplyJobTx(tx, runId, poolId, confirmedTimestamps);
      });
    } catch (error: unknown) {
      queueError = error instanceof Error ? error.message : String(error);
    }
    if (queued === undefined) {
      return {
        ok: false,
        reason: queueError === null ? "Run apply is already queued" : `Agent apply job could not be queued: ${queueError}`,
      };
    }
    await auditLog("apply", "runs", runId, null, workspace.orgId, {
      workspaceId: workspace.id,
      fromStatus: before.status,
      toStatus: "apply_queued",
      source: "approval-webhook",
    });
    queueRunNotification(runId, "run:confirmed", "apply_queued");
    void reportRunVcsStatus(runId, "apply_queued");
    return { ok: true, status: "apply_queued" };
  }
  const confirmed = await db.update(runs).set({
    status: "confirmed",
    statusTimestamps: {
      ...(before.statusTimestamps ?? {}),
      "confirmed-at": new Date().toISOString(),
    },
  }).where(and(eq(runs.id, runId), eq(runs.status, before.status))).returning({ id: runs.id });
  if (confirmed.length === 0) {
    return { ok: false, reason: "Run apply is already queued" };
  }
  await auditLog("apply", "runs", runId, null, workspace.orgId, {
    workspaceId: workspace.id,
    fromStatus: before.status,
    toStatus: "confirmed",
    source: "approval-webhook",
  });
  queueRunNotification(runId, "run:confirmed", "confirmed");
  const { executeApply } = await import("../worker");
  executeApply(runId).catch((error: unknown): void => {
    if (error !== null && error !== undefined) console.error(error);
  });
  return { ok: true, status: "applying" };
}
