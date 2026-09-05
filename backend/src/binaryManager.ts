import { isAbsolute, join, relative, resolve, sep } from "path";
import { mkdir, exists, chmod, unlink, readdir, rm, readFile, writeFile } from "fs/promises";
import { spawn } from "bun";
import { envEnabled } from "./lib/env";
import { log } from "./lib/log";
import { isVersionCacheFresh, loadVersionCacheFile, saveVersionCacheFile } from "./lib/version-cache";

const STORAGE_DIR = resolve(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../storage"));
// TERRENCE_BINARY_CACHE_DIR lets tests share one disk-backed binary cache
// across the test worker and every spawned backend instead of re-downloading
// into each per-test tmpfs storage dir (which is charged to cgroup RAM).
const BINARY_BASE_DIR = resolve(
  process.env["TERRENCE_BINARY_CACHE_DIR"] !== undefined && process.env["TERRENCE_BINARY_CACHE_DIR"] !== ""
    ? process.env["TERRENCE_BINARY_CACHE_DIR"]
    : join(STORAGE_DIR, "binaries"),
);

/** Reject a single archive entry whose normalized path escapes the extraction
 * root via an absolute path, a drive letter, or a `..` traversal segment. */
export function zipEntryEscapes(entry: string): boolean {
  const normalized = entry.replaceAll("\\", "/");
  return normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").some((segment): boolean => segment === "..");
}

/** Official IaC zip packages contain exactly one member: the signed binary
 * itself (e.g. `tofu` or `terraform`, possibly prefixed with `./`). Return
 * the list of entries that are NOT that expected binary, so callers can
 * reject archives carrying anything extra (kanban 6.7). */
export function unexpectedZipMembers(entries: readonly string[], expectedBinary: string): string[] {
  return entries.filter((entry: string): boolean => {
    const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "");
    return normalized !== expectedBinary;
  });
}

/** Inspect a Zip archive's member list before extracting so a potentially
 * malicious entry can never be written outside the target directory. Returns
 * the member names, or `null` if the listing could not be produced. */
async function listZipEntries(zipPath: string): Promise<string[] | null> {
  const listingProc = spawn(["unzip", "-Z1", zipPath], { stdout: "pipe", stderr: "pipe" });
  const listingText = await new Response(listingProc.stdout).text();
  if ((await listingProc.exited) !== 0) return null;
  return listingText.split("\n").map((entry): string => entry.trim()).filter((entry): boolean => entry !== "");
}

// ---------------------------------------------------------------------------
// Installed-binary integrity (kanban 6.5)
//
// Every dynamically installed binary records the SHA-256 of the on-disk
// executable in a per-installation `.integrity.json`. `ensureBinary` re-checks
// the digest before returning a cached binary and re-installs on mismatch;
// `revalidateInstalledBinaries` sweeps the whole cache at startup.
// ---------------------------------------------------------------------------

export type BinaryIntegrity = {
  tool: "tofu" | "terraform";
  version: string;
  /** SHA-256 hex digest of the installed executable file, not the archive. */
  binarySha256: string;
}

export function integrityFilePath(targetDir: string): string {
  return join(targetDir, ".integrity.json");
}

/** Result of reading an installation's integrity sidecar.
 * - `ok`: the file parsed and its tool/version/digest fields are well-formed.
 * - `missing`: no sidecar exists (installation predates integrity tracking).
 * - `invalid`: the sidecar exists but is unreadable, malformed, or describes
 *   the wrong tool/version — the installation must not be trusted.
 */
export type IntegrityRead =
  | { status: "ok"; integrity: BinaryIntegrity }
  | { status: "missing" }
  | { status: "invalid" };

/** Read and validate the integrity file for an installation directory. */
export async function readBinaryIntegrity(targetDir: string): Promise<IntegrityRead> {
  let raw: string;
  try {
    raw = await readFile(integrityFilePath(targetDir), "utf8");
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
    return { status: code === "ENOENT" ? "missing" : "invalid" };
  }
  let parsed: Partial<BinaryIntegrity>;
  try {
    parsed = JSON.parse(raw) as Partial<BinaryIntegrity>;
  } catch {
    return { status: "invalid" };
  }
  if (
    (parsed.tool === "tofu" || parsed.tool === "terraform")
    && typeof parsed.version === "string"
    && typeof parsed.binarySha256 === "string"
    && /^[0-9a-f]{64}$/.test(parsed.binarySha256)
  ) {
    return { status: "ok", integrity: { tool: parsed.tool, version: parsed.version, binarySha256: parsed.binarySha256 } };
  }
  return { status: "invalid" };
}

/** True when the on-disk binary matches the persisted digest. */
export async function verifyBinaryIntegrity(
  binaryPath: string,
  integrity: BinaryIntegrity,
): Promise<boolean> {
  try {
    const buffer = await Bun.file(binaryPath).arrayBuffer();
    return await calculateSha256(buffer) === integrity.binarySha256.toLowerCase();
  } catch {
    return false;
  }
}

async function writeBinaryIntegrity(targetDir: string, integrity: BinaryIntegrity): Promise<void> {
  const file = integrityFilePath(targetDir);
  await writeFile(file, JSON.stringify(integrity, null, 2), "utf8");
  try {
    await chmod(file, 0o600);
  } catch {
    // Best-effort; ownership/permissions of the storage dir are the operator's.
  }
}

/** Sweep the binary cache, deleting any installation whose executable no
 * longer matches its persisted digest, or whose integrity sidecar exists but
 * is malformed or describes a different tool/version. Returns the removed
 * version dirs. Installations without a sidecar are left in place and logged
 * once (they predate integrity tracking). */
export async function revalidateInstalledBinaries(
  baseDir: string = BINARY_BASE_DIR,
): Promise<string[]> {
  const removed: string[] = [];
  let toolDir: string;
  try {
    for (toolDir of await readdir(baseDir)) {
      if (toolDir !== "tofu" && toolDir !== "terraform") continue;
      const versionsDir = join(baseDir, toolDir);
      for (const version of await readdir(versionsDir)) {
        const targetDir = join(versionsDir, version);
        const binaryPath = join(targetDir, toolDir);
        if (!(await exists(binaryPath))) continue;
        const integrity = await readBinaryIntegrity(targetDir);
        if (integrity.status === "missing") {
          log.warn(
            `[terrence] Installed ${toolDir} v${version} has no integrity metadata; ` +
            "it will be re-verified on next use",
          );
          continue;
        }
        if (integrity.status === "invalid") {
          log.warn(
            `[terrence] Installed ${toolDir} v${version} has malformed integrity metadata; removing for re-download`,
          );
          await rm(targetDir, { recursive: true, force: true });
          removed.push(`${toolDir}/${version}`);
          continue;
        }
        if (!(await verifyBinaryIntegrity(binaryPath, integrity.integrity))) {
          log.warn(
            `[terrence] Installed ${toolDir} v${version} failed integrity check; removing for re-download`,
          );
          await rm(targetDir, { recursive: true, force: true });
          removed.push(`${toolDir}/${version}`);
        }
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[terrence] Binary integrity sweep failed: ${message}`);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Upstream rate-limit awareness (kanban 6.11)
//
// Unauthenticated GitHub API enumeration is the heaviest upstream caller;
// honor the X-RateLimit-* headers instead of hammering through a 403/429.
// While a limit is known to be exhausted we refuse to re-fetch until the
// reset timestamp passes; the version cache keeps serving in the meantime.
// ---------------------------------------------------------------------------

let rateLimitedUntil = 0;

/** Apply GitHub's X-RateLimit-* headers to our own fetch discipline.
 * Throws when the limit is known to be exhausted. */
function guardUpstreamRateLimit(response: Response, context: string): void {
  const remainingRaw = response.headers.get("x-ratelimit-remaining");
  const resetRaw = response.headers.get("x-ratelimit-reset");
  if (remainingRaw === null || resetRaw === null) return;

  const remaining = Number.parseInt(remainingRaw, 10);
  const resetSec = Number.parseInt(resetRaw, 10);
  const resetMs = Number.isFinite(resetSec) ? resetSec * 1000 : Date.now() + 60_000;

  if (Number.isFinite(remaining) && remaining <= 5) {
    log.warn(`[terrence] GitHub API rate limit headroom low (${remainingRaw} remaining) for ${context}`);
  }
  if (Number.isFinite(remaining) && remaining === 0) {
    rateLimitedUntil = resetMs;
    const when = new Date(resetMs).toISOString();
    throw new Error(`GitHub API rate limit exhausted for ${context}; try again after ${when}`);
  }
}

/** Called before touching GitHub's API while a known exhaustion window is
 * still open. Returns when the window has passed, throws otherwise. */
function assertNotRateLimited(context: string): void {
  if (rateLimitedUntil > Date.now()) {
    throw new Error(`GitHub API rate limit window active until ${new Date(rateLimitedUntil).toISOString()} (${context})`);
  }
  rateLimitedUntil = 0;
}

export function validateVersion(version: string): boolean {
  if (version === "") return false;
  if (version === "latest") return true;
  // Allow exact semver
  if (/^v?[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$/.test(version)) return true;
  // ~> requires full X.Y.Z (not shorthand ~> 1.5 or ~> 1)
  if (/^~> v?[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) return true;
  if (/^>= v?[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(version)) return true;
  if (/^<= v?[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(version)) return true;
  if (/^> v?[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(version)) return true;
  if (/^< v?[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(version)) return true;
  // Comma-separated: ">= 1.2, < 2.0" (no != allowed)
  if (/^[><=~]+ v?[0-9.]+(, [><=~]+ v?[0-9.]+)*$/.test(version) && !version.includes("!=")) return true;
  return false;
}

  // Strip pre-release suffix (everything after the first `-`) before numeric version segment parsing
  function parseSemver(version: string): number[] {
  const clean = version.replace(/^v/, "").split("-")[0];
  return (clean ?? "").split(".").map((s: string): number => Number.parseInt(s, 10));
}

function compareSemver(a: string, b: string): number {
  const aParts = parseSemver(a);
  const bParts = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const aNum = aParts[i];
    const bNum = bParts[i];
    const aVal = typeof aNum === "number" && !Number.isNaN(aNum) ? aNum : 0;
    const bVal = typeof bNum === "number" && !Number.isNaN(bNum) ? bNum : 0;
    if (aVal !== bVal) return aVal - bVal;
  }
  // Pre-release sorts below stable: a build with a `-` suffix comes before the same version without one
  const aHasPre = a.replace(/^v/, "").includes("-");
  const bHasPre = b.replace(/^v/, "").includes("-");
  if (aHasPre && !bHasPre) return -1;
  if (!aHasPre && bHasPre) return 1;
  return 0;
}

function matchesConstraint(version: string, constraint: string): boolean {
  const trimmed = constraint.trim();
  if (trimmed.startsWith("~> ")) {
    // Pessimistic: >= X.Y.Z, < X.(Y+1).0
    const target = trimmed.slice(3).replace(/^v/, "");
    const parts = target.split(".").map((s: string): number => Number.parseInt(s, 10));
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    const upper = `${major}.${minor + 1}.0`;
    return compareSemver(version, target) >= 0 && compareSemver(version, upper) < 0;
  }
  if (trimmed.startsWith(">= ")) {
    const target = trimmed.slice(3).replace(/^v/, "");
    return compareSemver(version, target) >= 0;
  }
  if (trimmed.startsWith("<= ")) {
    const target = trimmed.slice(3).replace(/^v/, "");
    return compareSemver(version, target) <= 0;
  }
  if (trimmed.startsWith("> ")) {
    const target = trimmed.slice(2).replace(/^v/, "");
    return compareSemver(version, target) > 0;
  }
  if (trimmed.startsWith("< ")) {
    const target = trimmed.slice(2).replace(/^v/, "");
    return compareSemver(version, target) < 0;
  }
  // Exact
  return compareSemver(version, trimmed.replace(/^v/, "")) === 0;
}

function matchesConstraints(version: string, constraintExpr: string): boolean {
  if (constraintExpr === "latest") return true;
  const constraints = constraintExpr.split(",").map((s: string): string => s.trim());
  return constraints.every((c: string): boolean => matchesConstraint(version, c));
}

export async function resolveLatestVersion(tool: "tofu" | "terraform"): Promise<string> {
  try {
    if (tool === "tofu") {
      assertNotRateLimited("releases/latest");
      // Unauthenticated GitHub API allows 60 req/hr per IP; CI runners share an
      // IP across parallel jobs and exhaust it. Authenticate when a token is
      // available (5000 req/hr).
      const githubToken = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? "";
      const authHeaders: Record<string, string> = githubToken !== ""
        ? { Authorization: `Bearer ${githubToken}` }
        : {};
      const res = await fetch("https://api.github.com/repos/opentofu/opentofu/releases/latest", {
        headers: { "User-Agent": "terrence-iac-manager", ...authHeaders },
        signal: AbortSignal.timeout(10000),
      });
      guardUpstreamRateLimit(res, "releases/latest");
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const tagName = data["tag_name"];
        const tag = typeof tagName === "string" ? tagName.replace(/^v/, "") : undefined;
        if (tag !== undefined && validateVersion(tag)) return tag;
      }
    } else {
      const res = await fetch("https://checkpoint-api.hashicorp.com/v1/check/terraform", {
        headers: { "User-Agent": "terrence-iac-manager" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const currentVersion = data["current_version"];
        if (typeof currentVersion === "string" && validateVersion(currentVersion)) return currentVersion;
      }
    }
  } catch (err: unknown) {
    log.warn(`Could not resolve latest version for ${tool} from upstream; using last-known-good`, {
      tool,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Kanban 6.9: never fall back to a hard-coded version that goes stale.
  // Prefer the last-known-good discovery cache, then an already-installed
  // binary; only fail explicitly when neither exists.
  const fallback = await lastKnownGoodVersion(tool);
  if (fallback !== undefined) return fallback;
  throw new Error(`Could not resolve latest version for ${tool}: upstream unreachable and no cached or installed version exists`);
}

// Highest version from the persistent discovery cache (kanban 6.10), then
// from the installed-binary directory. Returns undefined when neither has
// usable data.
async function lastKnownGoodVersion(tool: "tofu" | "terraform"): Promise<string | undefined> {
  const cached = (versionCache.get(tool)?.versions ?? []).reduce(
    (best: string | undefined, candidate: string): string | undefined =>
      best === undefined || compareSemver(candidate, best) > 0 ? candidate : best,
    undefined,
  );
  if (cached !== undefined) return cached;
  try {
    const entries = await readdir(join(BINARY_BASE_DIR, tool));
    return entries.reduce(
      (best: string | undefined, entry: string): string | undefined =>
        validateVersion(entry) && (best === undefined || compareSemver(entry, best) > 0) ? entry : best,
      undefined,
    );
  } catch {
    return undefined;
  }
}

// Available-versions cache. Persistent across restarts (kanban 6.10): the
// tofu path paginates the full GitHub release history (up to 100 requests),
// so a fresh fetch is deliberately reused for a long TTL. The cache file
// lives in the storage dir and is seeded into memory at startup.
const versionCache = new Map<string, { versions: string[]; fetchedAt: number }>();
const VERSION_CACHE_FILE = join(STORAGE_DIR, "version-cache.json");
function resolveVersionCacheTtl(): number {
  const configured = Number(process.env["TERRENCE_VERSION_CACHE_TTL_MS"]);
  return Number.isFinite(configured) && configured > 0 ? configured : 24 * 60 * 60 * 1000;
}
const VERSION_CACHE_TTL_MS = resolveVersionCacheTtl();
for (const [tool, entry] of Object.entries(loadVersionCacheFile(VERSION_CACHE_FILE))) {
  if (tool === "tofu" || tool === "terraform") versionCache.set(tool, entry);
}

async function fetchAvailableVersions(tool: "tofu" | "terraform"): Promise<string[]> {
  const cached = versionCache.get(tool);
  if (cached !== undefined && isVersionCacheFresh(cached, VERSION_CACHE_TTL_MS)) {
    return cached.versions;
  }

  try {
    assertNotRateLimited(tool === "tofu" ? "releases enumeration" : "hashicorp index");
    // Same GitHub-token discipline as resolveLatestVersion: CI runners share an
    // egress IP and the unauthenticated 60 req/hr ceiling is easily exhausted.
    const githubToken = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? "";
    const authHeaders: Record<string, string> = githubToken !== ""
      ? { Authorization: `Bearer ${githubToken}` }
      : {};
    let versions: string[] = [];
    if (tool === "tofu") {
      // Paginate through all GitHub releases
      let page = 1;
      while (page <= 100) {
        const res = await fetch(
          `https://api.github.com/repos/opentofu/opentofu/releases?per_page=100&page=${page}`,
          {
            headers: { "User-Agent": "terrence-iac-manager", ...authHeaders },
            signal: AbortSignal.timeout(15000),
          },
        );
        try {
          guardUpstreamRateLimit(res, `releases enumeration page ${page}`);
        } catch (rateError: unknown) {
          // Stop paginating but keep whatever versions we already collected;
          // the persistent cache still serves them until the window passes.
          log.warn(`[terrence] Stopping version enumeration early: ${rateError instanceof Error ? rateError.message : String(rateError)}`);
          break;
        }
        if (!res.ok) break;
        const data = (await res.json()) as Record<string, unknown>[];
        if (!Array.isArray(data) || data.length === 0) break;
        versions.push(...data
          .map((r: Readonly<Record<string, unknown>>): string | undefined => {
            const tagName = r["tag_name"];
            return typeof tagName === "string" ? tagName.replace(/^v/, "") : undefined;
          })
          .filter((v: string | undefined): v is string => v !== undefined && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v)));
        page++;
        if (data.length < 100) break;
      }
    } else {
      const res = await fetch("https://releases.hashicorp.com/terraform/index.json", {
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = (await res.json()) as { versions?: Record<string, unknown> };
        versions = Object.keys(data.versions ?? {})
          .filter((v: string): boolean => /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v));
      }
    }
    versions.sort(compareSemver);
    versionCache.set(tool, { versions, fetchedAt: Date.now() });
    saveVersionCacheFile(VERSION_CACHE_FILE, tool, { versions, fetchedAt: Date.now() });
    return versions;
  } catch {
    if (cached !== undefined) return cached.versions;
    throw new Error(`Failed to fetch available versions for ${tool}`);
  }
}

export async function availableVersions(tool: "tofu" | "terraform"): Promise<string[]> {
  return fetchAvailableVersions(tool);
}

// ---------------------------------------------------------------------------
// Binary download resilience (issue #602). Archives are 60-100 MiB, so the
// old 30s hard timeout was too short for slow links: 120s per attempt with
// an env override, plus bounded retries with backoff. Unknown versions and
// rejected archives fail fast instead of burning the retry budget.
// ---------------------------------------------------------------------------

/** Per-attempt binary download timeout. Overridable for slow links. */
export function resolveBinaryDownloadTimeoutMs(): number {
  const configured = Number(process.env["TERRENCE_BINARY_DOWNLOAD_TIMEOUT_MS"]);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 120_000;
}

/** Retries for timed-out or transient binary downloads. Capped so a wedged
 * upstream cannot stall run startup for long. */
export function resolveBinaryDownloadRetries(): number {
  const configured = Number(process.env["TERRENCE_BINARY_DOWNLOAD_RETRIES"]);
  if (!Number.isSafeInteger(configured) || configured < 0) return 2;
  return Math.min(configured, 5);
}

/** A failed binary-archive download. `retryable` is false for failures
 * another attempt cannot fix (unpublished version, rejected archive). */
export class BinaryDownloadError extends Error {
  public readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "BinaryDownloadError";
    this.retryable = retryable;
  }
}

export function isRetryableBinaryDownloadError(error: unknown): boolean {
  return error instanceof BinaryDownloadError && error.retryable;
}

const MAX_BINARY_SIZE = 100 * 1024 * 1024;

/** Read a response body with a running byte cap so a lying content-length or
 * an unbounded chunked response cannot allocate past the limit before the
 * size check runs. Stream failures become retryable download errors. */
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
async function readBoundedBody(res: Response): Promise<ArrayBuffer> {
  const reader = res.body?.getReader();
  if (reader === undefined) {
    const arrayBuffer = await res.arrayBuffer().catch((err: unknown): never => {
      const message = err instanceof Error ? err.message : String(err);
      throw new BinaryDownloadError(`Binary download body read failed: ${message}`, true);
    });
    if (arrayBuffer.byteLength > MAX_BINARY_SIZE) {
      throw new BinaryDownloadError(`Binary package too large: ${arrayBuffer.byteLength} bytes exceeds ${MAX_BINARY_SIZE} limit`, false);
    }
    return arrayBuffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BINARY_SIZE) {
        throw new BinaryDownloadError(`Binary package too large: response exceeds ${MAX_BINARY_SIZE} limit`, false);
      }
      chunks.push(value);
    }
  } catch (err: unknown) {
    if (err instanceof BinaryDownloadError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new BinaryDownloadError(`Binary download body read failed: ${message}`, true);
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

/** Fetch one binary archive with a bounded timeout. Throws
 * BinaryDownloadError: retryable for timeouts, network failures, and
 * 429/5xx; fail-fast for 404/4xx and oversize archives. */
export async function fetchBinaryArchive(downloadUrl: string, timeoutMs: number): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(downloadUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new BinaryDownloadError(
        `Binary download timed out after ${timeoutMs}ms (raise TERRENCE_BINARY_DOWNLOAD_TIMEOUT_MS on slow links)`,
        true,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new BinaryDownloadError(`Binary download failed: ${message}`, true);
  }
  if (res.status === 404) {
    throw new BinaryDownloadError(
      `Binary archive not found at ${downloadUrl} (HTTP 404): the requested version was never published for this OS/arch`,
      false,
    );
  }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new BinaryDownloadError(`HTTP status ${res.status} when fetching binary package`, retryable);
  }
  const contentLength = res.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > MAX_BINARY_SIZE) {
      throw new BinaryDownloadError(`Binary package too large: ${parsed} bytes exceeds ${MAX_BINARY_SIZE} limit`, false);
    }
  }
  const arrayBuffer = await readBoundedBody(res);
  return arrayBuffer;
}

// ---------------------------------------------------------------------------
// Run-creation preflight (issue #602). Network-free: only the on-disk cache,
// a PATH probe, and release lists already known from earlier discovery.
// Anything inconclusive defers to ensureBinary at run time so on-demand
// download keeps working.
// ---------------------------------------------------------------------------

/** Exact versions with a directory in the on-disk binary cache. */
export async function installedBinaryVersions(tool: "tofu" | "terraform"): Promise<string[]> {
  try {
    const entries = await readdir(join(BINARY_BASE_DIR, tool));
    return entries.filter((entry): boolean => /^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$/.test(entry));
  } catch {
    return [];
  }
}

/** Release versions already known without network: the live discovery cache
 * (fresh or stale — staleness only matters for brand-new releases), falling
 * back to the persisted discovery file. Empty when nothing is known yet. */
export function knownAvailableVersions(tool: "tofu" | "terraform"): string[] {
  const live = versionCache.get(tool);
  if (live !== undefined && live.versions.length > 0) return [...live.versions];
  return [...(loadVersionCacheFile(VERSION_CACHE_FILE)[tool]?.versions ?? [])];
}

/** Closest candidate to an exact target: the highest version at or below the
 * target, else the highest known. Undefined when there are no candidates. */
export function closestKnownVersion(target: string, candidates: readonly string[]): string | undefined {
  const normalized = target.replace(/^v/, "");
  let below: string | undefined;
  let highest: string | undefined;
  for (const candidate of candidates) {
    if (highest === undefined || compareSemver(candidate, highest) > 0) highest = candidate;
    if (compareSemver(candidate, normalized) <= 0 && (below === undefined || compareSemver(candidate, below) > 0)) {
      below = candidate;
    }
  }
  return below ?? highest;
}

export type BinaryPreflight = { ok: true } | { ok: false; detail: string };

/**
 * Fail fast on exact versions that can never resolve: well-formed but absent
 * from the known release list with nothing usable installed. Returns ok for
 * constraints/"latest" (they need network to resolve) and whenever nothing
 * is known locally (a cold or offline host defers to the run-time download
 * attempt, which reports the failure with remedies).
 */
export async function preflightBinaryAvailability(
  toolInput?: string | null,
  versionInput?: string | null,
): Promise<BinaryPreflight> {
  const tool = toolInput?.toLowerCase() === "terraform" ? "terraform" : "tofu";
  const raw = versionInput !== null && versionInput !== undefined && versionInput !== "" ? versionInput : "latest";
  if (!validateVersion(raw)) {
    return { ok: false, detail: `Invalid ${tool} version "${raw}": expected an exact version such as 1.9.0, "latest", or a constraint such as ">= 1.5, < 2.0".` };
  }
  const exact = /^v?([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?)$/.exec(raw.trim())?.[1];
  if (exact === undefined) return { ok: true };
  // Release discovery only tracks stable versions, so a prerelease pin can
  // never be confirmed from the known list; defer it to run-time resolution
  // (unchanged behavior) rather than 422ing a published prerelease.
  if (exact.includes("-")) return { ok: true };
  if (await exists(join(BINARY_BASE_DIR, tool, exact, tool))) return { ok: true };
  if ((await systemBinaryFallback(tool, exact)) !== null) return { ok: true };
  const known = knownAvailableVersions(tool);
  if (known.length === 0) return { ok: true };
  if (known.includes(exact)) return { ok: true };
  const closest = closestKnownVersion(exact, [...(await installedBinaryVersions(tool)), ...known]);
  const hint = closest === undefined ? "no versions are cached or known" : `closest known version: ${closest}`;
  return {
    ok: false,
    detail: `${tool} version ${exact} is not available (${hint}). `
      + `The run would fail while resolving its CLI binary. If the version was just released, wait for version discovery to refresh or pre-install the binary; `
      + `set GITHUB_TOKEN or GH_TOKEN when release enumeration is rate-limited.`,
  };
}

async function resolveVersionConstraint(tool: "tofu" | "terraform", constraintExpr: string): Promise<string> {
  if (constraintExpr === "latest") {
    return resolveLatestVersion(tool);
  }
  // Check if it's already an exact version
  if (/^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$/.test(constraintExpr.replace(/^v/, ""))) {
    return constraintExpr.replace(/^v/, "");
  }
  // Fetch available versions and find best match
  const available = await fetchAvailableVersions(tool);
  if (available.length === 0) {
    // No versions available — fail through ensureBinary error path
    throw new Error(`Could not fetch available versions for ${tool}`);
  }
  // Find the highest version matching the constraint (iterate descending)
  for (let i = available.length - 1; i >= 0; i--) {
    const candidate = available[i];
    if (candidate !== undefined && matchesConstraints(candidate, constraintExpr)) {
      return candidate;
    }
  }
  // No match found — throw
  throw new Error(`No ${tool} version matching "${constraintExpr}" found`);
}

async function calculateSha256(buffer: Readonly<ArrayBuffer>): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b: number): string => b.toString(16).padStart(2, "0")).join("");
}

async function verifySha256(tool: "tofu" | "terraform", version: string, filename: string, buffer: Readonly<ArrayBuffer>): Promise<boolean> {

  const allowBypass = envEnabled(process.env["ALLOW_UNVERIFIED_CHECKSUMS"]);
  try {
    let checksumUrl = "";
    if (tool === "tofu") {
      checksumUrl = `https://github.com/opentofu/opentofu/releases/download/v${version}/tofu_${version}_SHA256SUMS`;
    } else {
      checksumUrl = `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_SHA256SUMS`;
    }

    const res = await fetch(checksumUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.warn(`[terrence] Could not download SHA256SUMS for ${tool} v${version}`);
      return allowBypass;
    }

    const text = await res.text();
    const actualHash = await calculateSha256(buffer);

    for (const line of text.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const expectedHash = parts[0];
        const file = parts[1];
        if (expectedHash !== undefined && (file === filename || file === `./${filename}`)) {
          if (expectedHash.toLowerCase() !== actualHash.toLowerCase()) {
            console.error(`[terrence] SHA256 mismatch for ${filename}! Expected ${expectedHash}, got ${actualHash}`);
            return false;
          }
          return true;
        }
      }
    }
    console.error(`[terrence] Checksum entry not found for ${filename}`);
    return allowBypass;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[terrence] Checksum verification warning: ${errMsg}`);
    return allowBypass;
  }
}

async function systemBinaryFallback(
  tool: "tofu" | "terraform",
  constraint: string,
): Promise<{ binaryPath: string; tool: string; version: string } | null> {
  try {
    const which = spawn(["which", tool]);
    if ((await which.exited) !== 0) return null;
    const binaryPath = (await new Response(which.stdout).text()).trim();
    if (binaryPath === "") return null;
    const versionProcess = spawn([binaryPath, "version"]);
    const configuredProbeTimeout = Number(process.env["TERRENCE_BINARY_PROBE_TIMEOUT_MS"]);
    const probeTimeout = Number.isSafeInteger(configuredProbeTimeout) && configuredProbeTimeout > 0 ? configuredProbeTimeout : 10_000;
    const output = await new Promise<string | null>((resolve): void => {
      let settled = false;
      const timer = setTimeout((): void => {
        settled = true;
        try { versionProcess.kill(); } catch {}
        resolve(null);
      }, probeTimeout);
      versionProcess.exited.then(async (exitCode): Promise<void> => {
        const stdout = await new Response(versionProcess.stdout).text();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(exitCode === 0 ? stdout.trim() : null);
      }, (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      });
    });
    if (output === null) return null;
    const match = /(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)/.exec(output);
    const version = match?.[1];
    const normalizedConstraint = constraint.trim().replace(/^v/, "");
    const exactConstraint = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/.test(normalizedConstraint);
    if (version === undefined || (exactConstraint ? version !== normalizedConstraint : !matchesConstraints(version, constraint))) return null;
    return { binaryPath, tool, version };
  } catch {
    return null;
  }
}

type BinaryResolution = { binaryPath: string; tool: string; version: string };
const binaryInstallLocks = new Map<string, Promise<void>>();

async function withBinaryInstallLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = binaryInstallLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve): void => { release = resolve; });
  binaryInstallLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (binaryInstallLocks.get(key) === current) binaryInstallLocks.delete(key);
  }
}

export async function ensureBinary(toolInput?: string | null, versionInput?: string | null): Promise<BinaryResolution | null> {
  const tool = (toolInput?.toLowerCase() === "terraform" ? "terraform" : "tofu");
  let version = (versionInput !== null && versionInput !== undefined && versionInput !== "" ? versionInput : "latest");

  if (!validateVersion(version)) {
    console.warn(`[terrence] Invalid version format requested: ${versionInput ?? ""}`);
    return null;
  }

  // Resolve constraints to exact versions. If discovery is unavailable after
  // a restart, a locally installed binary is still usable when its own
  // version satisfies the requested constraint.
  try {
    version = await resolveVersionConstraint(tool, version);
  } catch (error: unknown) {
    const fallback = await systemBinaryFallback(tool, version);
    if (fallback !== null) {
      log.warn(`[terrence] Using system-installed ${tool} v${fallback.version}; version discovery failed`);
      return fallback;
    }
    throw error;
  }
  version = version.replace(/^v/, "");
  // A system binary is only accepted after its reported version matches this
  // resolved version exactly. Falling back is therefore safe for pending runs
  // whose managed cache disappeared during a restart, including exact-version
  // runs; ALLOW_TOOL_FALLBACK remains reserved for alternate-tool fallback.
  const allowSystemFallback = true;

  return withBinaryInstallLock(`${tool}:${version}`, async (): Promise<BinaryResolution | null> => {
    const targetDir = join(BINARY_BASE_DIR, tool, version);
  const binaryPath = join(targetDir, tool);

  if (await exists(binaryPath)) {
    // Cached binary: re-validate against the persisted digest before use so a
    // tampered or partially-written executable is never trusted "because it
    // exists" (kanban 6.5). A missing sidecar is a pre-integrity install:
    // used as-is with a warning (the startup sweep keeps those too); malformed
    // metadata or a digest mismatch deletes the install and falls through to
    // a fresh download.
    const integrity = await readBinaryIntegrity(targetDir);
    if (integrity.status === "missing") {
      log.warn(`[terrence] Using unverified cached ${tool} v${version} at ${binaryPath} (no integrity metadata)`);
      return { binaryPath, tool, version };
    }
    if (integrity.status === "invalid") {
      log.warn(`[terrence] Cached ${tool} v${version} has malformed integrity metadata; re-downloading`);
      await rm(targetDir, { recursive: true, force: true });
    } else if (!(await verifyBinaryIntegrity(binaryPath, integrity.integrity))) {
      log.warn(`[terrence] Cached ${tool} v${version} failed integrity check; re-downloading`);
      await rm(targetDir, { recursive: true, force: true });
    } else {
      return { binaryPath, tool, version };
    }
  }

  try {
    await mkdir(targetDir, { recursive: true });
    const zipPath = join(targetDir, "download.zip");

    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const os = process.platform === "darwin" ? "darwin" : "linux";

    const zipFilename = tool === "tofu"
      ? `tofu_${version}_${os}_${arch}.zip`
      : `terraform_${version}_${os}_${arch}.zip`;

    const downloadUrl = tool === "tofu"
      ? `https://github.com/opentofu/opentofu/releases/download/v${version}/${zipFilename}`
      : `https://releases.hashicorp.com/terraform/${version}/${zipFilename}`;

    log.info(`Downloading ${tool} v${version} from ${downloadUrl}`);
    // Issue #602: retry slow-link timeouts and transient upstream failures
    // with backoff; unpublished versions and rejected archives fail fast.
    const downloadTimeoutMs = resolveBinaryDownloadTimeoutMs();
    const downloadRetries = resolveBinaryDownloadRetries();
    let arrayBuffer: ArrayBuffer | null = null;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);
        log.info(`Retrying ${tool} v${version} download (attempt ${attempt + 1} of ${downloadRetries + 1})`);
        await new Promise<void>((resolve): void => {
          setTimeout(resolve, backoffMs);
        });
      }
      try {
        arrayBuffer = await fetchBinaryArchive(downloadUrl, downloadTimeoutMs);
        break;
      } catch (downloadErr: unknown) {
        if (attempt >= downloadRetries || !isRetryableBinaryDownloadError(downloadErr)) throw downloadErr;
      }
    }
    // The loop only exits via break (arrayBuffer just assigned) or throw.

    const isValidHash = await verifySha256(tool, version, zipFilename, arrayBuffer);
    if (!isValidHash) {
      throw new Error(`SHA256 verification failed for ${zipFilename}`);
    }

    await Bun.write(zipPath, arrayBuffer);

    // Zip Slip protection: verify the archive's member list BEFORE extraction
    // so a malicious entry can never be written outside the target directory.
    const zipEntries = await listZipEntries(zipPath);
    if (zipEntries === null || zipEntries.some(zipEntryEscapes)) {
      await rm(targetDir, { recursive: true, force: true });
      throw new Error("Zip Slip detected: archive contains a path that escapes the target directory");
    }

    // Official packages contain the binary and standard release documentation;
    // reject anything unexpected (kanban 6.7) so an archive smuggling extra files is never unpacked.
    const ALLOWED_EXTRAS = new Set(["LICENSE", "LICENSE.txt", "README.md", "CHANGELOG.md"]);
    const unexpected = unexpectedZipMembers(zipEntries, tool).filter(
      (entry): boolean => !ALLOWED_EXTRAS.has(entry.replaceAll("\\", "/").replace(/^\.\//, "")),
    );
    if (unexpected.length > 0) {
      await rm(targetDir, { recursive: true, force: true });
      throw new Error(`Archive contains unexpected members (${unexpected.join(", ")}); refusing to extract`);
    }

    let exitCode = -1;
    try {
      const unzipProc = spawn(["unzip", "-o", zipPath, "-d", targetDir]);
      exitCode = await unzipProc.exited;
      // Defense in depth: confirm every extracted path still resolves under the
      // target directory (path containment, not a string prefix check).
      if (exitCode === 0) {
        const resolvedTarget = resolve(targetDir);
        const entries = await readdir(targetDir, { recursive: true, withFileTypes: false });
        const escaped = entries.some((entry): boolean => {
          const relativePath = relative(resolvedTarget, resolve(join(targetDir, entry)));
          return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
        });
        if (escaped) {
          exitCode = -1;
          try {
            await rm(targetDir, { recursive: true, force: true });
          } catch {
            // Cleanup failure is secondary — Zip Slip error is primary
          }
        }
      }
    } catch (spawnErr: unknown) {
      exitCode = -1;
      const spawnMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      console.error(`[terrence] Failed to spawn unzip process: ${spawnMsg}`);
    }

    try {
      await unlink(zipPath);
    } catch {}

    if (exitCode === 0 && (await exists(binaryPath))) {
      try {
        await chmod(binaryPath, 0o755);
        // Record the on-disk digest so future runs can re-validate the cache
        // without re-downloading (kanban 6.5).
        const binaryBuffer = await Bun.file(binaryPath).arrayBuffer();
        await writeBinaryIntegrity(targetDir, {
          tool,
          version,
          binarySha256: await calculateSha256(binaryBuffer),
        });
        log.info(`Successfully installed ${tool} v${version} to ${binaryPath}`);
        return { binaryPath, tool, version };
      } catch (integrityErr: unknown) {
        // Extraction succeeded but the install cannot be trusted (integrity
        // metadata unreadable/unwritable); remove the whole directory so the
        // next attempt starts clean and nothing half-recorded is reused.
        try {
          await rm(targetDir, { recursive: true, force: true });
        } catch {
          // Cleanup failure is secondary — install error is primary.
        }
        throw integrityErr;
      }
    } else {
      console.error(`[terrence] Unzip failed with exit code ${exitCode}`);
      // A partial extraction is never trusted: remove whatever was unpacked
      // so the cache cannot contain a half-written binary.
      try {
        await rm(targetDir, { recursive: true, force: true });
      } catch {
        // Cleanup failure is secondary — the unzip error is already reported.
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[terrence] Dynamic download failed for ${tool} v${version}: ${errMsg}`);
  }

  if (allowSystemFallback) {
    const fallback = await systemBinaryFallback(tool, version);
    if (fallback !== null) {
      log.info(`System-installed ${tool} v${fallback.version} satisfies constraint "${version}" at ${fallback.binaryPath}`);
      return fallback;
    }
  }

  // Alternate-tool fallback ONLY if opt-in via environment flag
  if (envEnabled(process.env["ALLOW_TOOL_FALLBACK"])) {
    const fallbackTool = tool === "tofu" ? "terraform" : "tofu";
    try {
      const sysAlt = spawn(["which", fallbackTool]);
      if ((await sysAlt.exited) === 0) {
        const sysPath = (await new Response(sysAlt.stdout).text()).trim();
        if (sysPath !== "") {
          console.warn(`[terrence] ALLOW_TOOL_FALLBACK: using alternative tool ${fallbackTool} at ${sysPath}`);
          return { binaryPath: sysPath, tool: fallbackTool, version: "system-fallback" };
        }
      }
    } catch {}
  }

  return null;
  });
}
