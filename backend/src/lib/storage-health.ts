import { log } from "./log";

/**
 * storage-health.ts — disk-full detection (kanban 3.23).
 *
 * When a state/log/artifact write fails with ENOSPC (or SQLite reports a full
 * disk), the instance latches into a degraded state: new applies are blocked
 * by applyGateBlockReason, the worker stops claiming runs, and readiness
 * endpoints report not-ready so an orchestrator can see the problem.
 *
 * The latch is deliberately sticky: it clears only on process restart (or via
 * the test reset). A flapping disk would otherwise toggle readiness forever.
 */
let degradedReason: string | null = null;

/** True when the error is a disk-full condition (ENOSPC/EDQUOT/SQLITE_FULL). */
export function isDiskFullError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === "ENOSPC" || code === "EDQUOT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("database or disk is full") || message.includes("SQLITE_FULL");
}

/** Latch the degraded state. Idempotent; first call logs the transition. */
export function markStorageDegraded(reason: string): void {
  if (degradedReason === null) {
    degradedReason = reason;
    log.error("Storage degraded", { reason });
  }
}

export function storageDegradedReason(): string | null {
  return degradedReason;
}

export function isStorageDegraded(): boolean {
  return degradedReason !== null;
}

/** Test-only reset (the production latch clears only on restart). */
export function resetStorageHealthForTests(): void {
  degradedReason = null;
}
