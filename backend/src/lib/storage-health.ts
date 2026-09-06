import { log } from "./log";
import { statfs } from "node:fs/promises";

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

/** Minimum free space Terrence keeps available for a run's state, logs, and
 * temporary archive files. This is deliberately conservative: an assessment
 * is advisory until a run starts, but a volume with no headroom is a known
 * execution failure. */
export const STORAGE_PREFLIGHT_MIN_FREE_BYTES = 100 * 1024 * 1024;

export type StorageHeadroom = Readonly<{
  availableBytes: number;
  totalBytes: number;
  minimumBytes: number;
}>;

/** Read filesystem headroom without enumerating or opening user artifacts. */
export async function inspectStorageHeadroom(
  path: string,
  minimumBytes = STORAGE_PREFLIGHT_MIN_FREE_BYTES,
): Promise<StorageHeadroom | null> {
  try {
    const stats = await statfs(path);
    const blockSize = stats.bsize;
    const availableBlocks = stats.bavail;
    const totalBlocks = stats.blocks;
    if (![blockSize, availableBlocks, totalBlocks, minimumBytes].every(Number.isSafeInteger)
      || blockSize <= 0 || availableBlocks < 0 || totalBlocks < 0 || minimumBytes < 0) return null;
    return {
      availableBytes: Math.min(Number.MAX_SAFE_INTEGER, blockSize * availableBlocks),
      totalBytes: Math.min(Number.MAX_SAFE_INTEGER, blockSize * totalBlocks),
      minimumBytes,
    };
  } catch {
    return null;
  }
}

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
