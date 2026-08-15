import { readFileSync, writeFileSync } from "node:fs";

// Persistent version-discovery cache (kanban 6.10). Kept in its own tiny
// module so the file-format helpers can be unit-tested without network or
// touching the binary manager's import-time state.

export type VersionCacheEntry = Readonly<{
  versions: string[];
  fetchedAt: number;
}>;

export type VersionCacheTool = "tofu" | "terraform" | "tfe-provider";

export type VersionCacheFile = Partial<Record<VersionCacheTool, VersionCacheEntry>>;

/** True when the entry exists and its fetchedAt is within ttlMs of now. */
export function isVersionCacheFresh(
  entry: VersionCacheEntry | undefined,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  return entry !== undefined
    && Number.isFinite(entry.fetchedAt)
    && now - entry.fetchedAt < ttlMs;
}

/**
 * Read the on-disk cache. Missing, unreadable, or structurally corrupted
 * files degrade to an empty cache (cold start) rather than throwing.
 */
export function loadVersionCacheFile(filePath: string): VersionCacheFile {
  let parsed: VersionCacheFile;
  try {
    const raw = readFileSync(filePath, "utf8");
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    parsed = value as VersionCacheFile;
  } catch {
    return {};
  }
  for (const tool of ["tofu", "terraform", "tfe-provider"] as const) {
    const entry = parsed[tool];
    if (entry === undefined) continue;
    if (!Array.isArray(entry.versions)
      || !entry.versions.every((v: unknown): boolean => typeof v === "string")
      || typeof entry.fetchedAt !== "number"
      || !Number.isFinite(entry.fetchedAt)) {
      delete parsed[tool];
    }
  }
  return parsed;
}

/** Persist one tool's entry, preserving other tools' entries. Best-effort:
 * a failing write must never break version discovery. */
export function saveVersionCacheFile(
  filePath: string,
  tool: VersionCacheTool,
  entry: VersionCacheEntry,
): void {
  try {
    const existing = loadVersionCacheFile(filePath);
    existing[tool] = entry;
    writeFileSync(filePath, JSON.stringify(existing));
  } catch {
    // Swallow: persistence is best-effort.
  }
}