import { join, resolve } from "node:path";
import {
  isVersionCacheFresh,
  loadVersionCacheFile,
  saveVersionCacheFile,
} from "./version-cache";

// Latest-version lookup for the hashicorp/tfe provider. Feeds the
// provider-surface freshness chip and the refresh-provider-surface script.
// The lookup is best-effort: any failure degrades to null (the dashboard
// simply omits the chip) and the persistent cache absorbs GitHub's
// unauthenticated rate limit (one request per TTL window).

const STORAGE_DIR = resolve(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"));
const CACHE_FILE = join(STORAGE_DIR, "version-cache.json");

function resolveTtl(): number {
  const configured = Number(process.env["TERRENCE_VERSION_CACHE_TTL_MS"]);
  return Number.isFinite(configured) && configured > 0 ? configured : 24 * 60 * 60 * 1000;
}

/** Raw GitHub lookup of the latest stable hashicorp/tfe release tag.
 * Never throws: non-OK responses, timeouts, and malformed payloads return
 * null so callers can fall back to their pinned version. */
export async function fetchLatestTfeProviderVersion(): Promise<string | null> {
  try {
    const res = await fetch("https://api.github.com/repos/hashicorp/terraform-provider-tfe/releases/latest", {
      headers: { "User-Agent": "terrence-provider-surface", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: unknown };
    if (typeof data.tag_name !== "string") return null;
    const version = data.tag_name.replace(/^v/, "");
    return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
let lastFailedAt = 0;

/** Latest stable provider version, disk-cached under the version-cache TTL.
 * Never throws. Failed upstream lookups are held back in memory for
 * FAILURE_BACKOFF_MS so a flaky GitHub API cannot trigger a request on every
 * dashboard load. The cache file can be overridden for tests and scripts. */
export async function getLatestTfeProviderVersion(): Promise<string | null> {
  const file = process.env["TERRENCE_VERSION_CACHE_FILE"] ?? CACHE_FILE;
  const ttl = resolveTtl();
  const cached = loadVersionCacheFile(file)["tfe-provider"];
  if (cached !== undefined && isVersionCacheFresh(cached, ttl)) {
    return cached.versions[0] ?? null;
  }
  const now = Date.now();
  if (now - lastFailedAt < FAILURE_BACKOFF_MS) return null;
  const latest = await fetchLatestTfeProviderVersion();
  if (latest !== null) {
    saveVersionCacheFile(file, "tfe-provider", { versions: [latest], fetchedAt: Date.now() });
    lastFailedAt = 0;
  } else {
    lastFailedAt = now;
  }
  return latest;
}
