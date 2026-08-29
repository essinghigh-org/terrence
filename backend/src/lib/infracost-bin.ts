import { join, resolve } from "path";
import { chmod, exists, mkdir, rename, rm, stat, writeFile } from "fs/promises";
import { log } from "./log";

// ---------------------------------------------------------------------------
// On-demand, versioned Infracost binary management (storage-backed).
//
// The tofu/terraform binaries are managed by binaryManager.ts (versioned,
// integrity-checked downloads under <storage>/binaries). Infracost historically
// shipped as a single fixed binary baked into the container image at build time,
// which (a) forced an image rebuild to bump the version and (b) carried the
// remaining CVE surface in the image. This module moves Infracost onto the same
// storage-backed, version-pinned, digest-verified lifecycle so deployments can
// select a version via INFRACOST_VERSION and update it without rebuilding the
// image, and the image no longer needs to embed the binary at all.
//
// It intentionally does NOT extend binaryManager.ts: Infracost publishes a
// tar.gz (single top-level executable) rather than a zip-of-a-binary, and uses a
// per-asset `.sha256` sidecar instead of a SHA256SUMS aggregate, so its
// download/extract/verify steps differ enough that forcing a branch into the
// zip-based manager would bloat the tofu/terraform path with no benefit.
// ---------------------------------------------------------------------------

const STORAGE_DIR = resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"));
// Tests may redirect the binary cache (setup.ts shares one disk cache across the
// test worker and spawned backends via TERRENCE_BINARY_CACHE_DIR).
const BINARY_BASE_DIR = resolve(
  process.env.TERRENCE_BINARY_CACHE_DIR !== undefined && process.env.TERRENCE_BINARY_CACHE_DIR !== ""
    ? process.env.TERRENCE_BINARY_CACHE_DIR
    : join(STORAGE_DIR, "binaries"),
);

/** Default Infracost version applied when INFRACOST_VERSION is unset. Kept in
 * sync with releases; bump deliberately. */
const DEFAULT_INFRACOST_VERSION = "0.10.45";

export type InfracostIntegrity = {
  tool: "infracost";
  version: string;
  binarySha256: string;
}

const INTEGRITY_FILE = ".integrity.json";

function integrityFilePath(targetDir: string): string {
  return join(targetDir, INTEGRITY_FILE);
}

/** Validate an infracost version spec (exact x.y.z, no constraints/mostly). */
function validateVersion(version: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version.replace(/^v/, ""));
}

async function calculateSha256(buffer: Readonly<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map((b: number): string => b.toString(16).padStart(2, "0")).join("");
}

type IntegrityRead =
  | { status: "ok"; integrity: InfracostIntegrity }
  | { status: "missing" }
  | { status: "invalid" };

async function readIntegrity(targetDir: string): Promise<IntegrityRead> {
  let raw: string;
  try {
    raw = await Bun.file(integrityFilePath(targetDir)).text();
  } catch {
    return { status: "missing" };
  }
  let parsed: Partial<InfracostIntegrity>;
  try {
    parsed = JSON.parse(raw) as Partial<InfracostIntegrity>;
  } catch {
    return { status: "invalid" };
  }
  if (
    parsed.tool === "infracost"
    && typeof parsed.version === "string"
    && typeof parsed.binarySha256 === "string"
    && /^[0-9a-f]{64}$/.test(parsed.binarySha256)
  ) {
    return { status: "ok", integrity: { tool: "infracost", version: parsed.version, binarySha256: parsed.binarySha256 } };
  }
  return { status: "invalid" };
}

async function verifyBinary(targetPath: string, integrity: InfracostIntegrity): Promise<boolean> {
  try {
    const buffer = await Bun.file(targetPath).arrayBuffer();
    return (await calculateSha256(buffer)) === integrity.binarySha256.toLowerCase();
  } catch {
    return false;
  }
}

async function writeIntegrity(targetDir: string, integrity: InfracostIntegrity): Promise<void> {
  await writeFile(integrityFilePath(targetDir), JSON.stringify(integrity, null, 2), "utf8");
  try {
    await chmod(integrityFilePath(targetDir), 0o600);
  } catch {
    // Best-effort; storage dir permissions are the operator's concern.
  }
}

/** Download the archive and its `.sha256` sidecar, verify the digest, and only
 * then write the archive to disk. Throws on any upstream/verify failure; the
 * caller tiers that into a recoverable, non-fatal cost-estimate error. */
async function downloadAndVerify(
  version: string,
  targetDir: string,
): Promise<void> {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const osName = process.platform === "darwin" ? "darwin" : "linux";
  const asset = `infracost-${osName}-${arch}.tar.gz`;

  const archiveUrl = `https://github.com/infracost/infracost/releases/download/v${version}/${asset}`;
  const sumUrl = `${archiveUrl}.sha256`;

  log.info(`[terrence] Downloading Infracost v${version} (${asset}) from ${archiveUrl}`);
  const [archiveRes, sumRes] = await Promise.all([
    fetch(archiveUrl, { signal: AbortSignal.timeout(120_000) }),
    fetch(sumUrl, { signal: AbortSignal.timeout(30_000) }),
  ]);
  if (!archiveRes.ok) throw new Error(`HTTP ${archiveRes.status} fetching Infracost archive`);
  if (!sumRes.ok) throw new Error(`HTTP ${sumRes.status} fetching Infracost checksum`);

  const archiveBuffer = await archiveRes.arrayBuffer();
  const expected = (await sumRes.text()).trim().split(/\s+/)[0]?.toLowerCase();
  if (expected === undefined || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error("Infracost checksum sidecar did not contain a valid SHA-256 hash");
  }

  const actual = await calculateSha256(archiveBuffer);
  if (actual !== expected) {
    throw new Error(`Infracost archive SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }

  await mkdir(targetDir, { recursive: true });
  await Bun.write(join(targetDir, "download.tar.gz"), archiveBuffer);
}

/** Extract the verified tar.gz (single top-level executable) into targetDir and
 * return the on-disk binary path. Rejects archives that would write outside
 * targetDir or carry more than the single expected member. */
async function extractVerified(targetDir: string): Promise<string> {
  const archivePath = join(targetDir, "download.tar.gz");

  const listProc = Bun.spawn(["tar", "-tzf", archivePath], { stdout: "pipe", stderr: "pipe" });
  const listing = (await new Response(listProc.stdout).text()).trim().split("\n").map((s: string): string => s.trim()).filter(Boolean);
  if ((await listProc.exited) !== 0) throw new Error("Could not list Infracost archive members");

  const expected = `infracost-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "amd64"}`;
  const unexpected = listing.filter((entry: string): boolean => {
    const normalized = entry.replace(/^\.\//, "").replace(/\/$/, "");
    // Accept exactly one member: the executable itself (optionally a dir
    // prefix in some future archives). Anything else is refused.
    return !(normalized === expected || normalized.endsWith(`/${expected}`));
  });
  if (listing.length === 0 || unexpected.length > 0) {
    throw new Error(`Infracost archive has unexpected members (${listing.join(", ")}); refusing to extract`);
  }

  const extractProc = Bun.spawn(["tar", "-xzf", archivePath, "-C", targetDir], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await extractProc.exited;
  if (exitCode !== 0) throw new Error(`Infracost archive extraction failed (exit ${exitCode})`);

  // The verified archive contains a single top-level executable named
  // exactly `infracost-<os>-<arch>`. Its path is deterministic.
  const binaryPath = join(targetDir, expected);
  await chmod(binaryPath, 0o755);
  try {
    await rm(archivePath, { force: true });
  } catch {
    // Leftover archive is harmless; removal is best-effort.
  }
  return binaryPath;
}

/** How long a per-version install lock may be held before it is treated as
 * stale (owner crashed mid-install) and reclaimed. Generous: a fresh download
 * is bounded by a 120s fetch timeout plus extraction, far below this. */
const LOCK_STALE_MS = 10 * 60_000;

/** How long to wait for a concurrent installer to release the version lock
 * before giving up and reporting the estimate as unavailable. */
const LOCK_WAIT_MS = 5 * 60_000;

/** Poll interval while waiting on a held version lock. */
const LOCK_POLL_MS = 200;

function lockDirFor(version: string): string {
  return join(BINARY_BASE_DIR, "infracost", `.infracost-${version}.lock`);
}

function stagingDirFor(version: string): string {
  return join(BINARY_BASE_DIR, "infracost", `.infracost-${version}.staging-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
}

/** Acquire the per-version install lock (atomic mkdir). Returns true on
 * success. Reclaims stale locks left by crashed installers. */
async function acquireVersionLock(lockDir: string): Promise<boolean> {
  // Ensure the parent tree exists before the non-recursive lock mkdir below:
  // on a fresh storage layout `binaries/infracost/` may not exist yet, and a
  // recursive mkdir of the lock itself would defeat its atomicity (no EEXIST).
  await mkdir(join(BINARY_BASE_DIR, "infracost"), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockDir);
      return true;
    } catch {
      // Held by another worker. Reclaim if the owner has been gone too long.
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock vanished between the failed mkdir and the stat; retry mkdir.
        continue;
      }
      if (Date.now() >= deadline) {
        log.warn(`[terrence] Timed out waiting for Infracost install lock ${lockDir}`);
        return false;
      }
      await Bun.sleep(LOCK_POLL_MS);
    }
  }
}

async function releaseVersionLock(lockDir: string): Promise<void> {
  await rm(lockDir, { recursive: true, force: true });
}

async function validCachedInfracostBinary(binaryPath: string, targetDir: string, invalidMessage: string): Promise<boolean> {
  if (!(await exists(binaryPath))) return false;
  const integrity = await readIntegrity(targetDir);
  if (integrity.status === "ok" && (await verifyBinary(binaryPath, integrity.integrity))) return true;
  log.warn(invalidMessage);
  return false;
}

async function cleanupFailedInfracostInstall(stagingDir: string): Promise<void> {
  if (stagingDir === "") return;
  try {
    await rm(stagingDir, { recursive: true, force: true });
  } catch {
    // Cleanup failure is secondary.
  }
}

/** Resolve the Infracost binary for a cost-estimate run.
 *
 * Priority:
 *   1. Explicit INFRACOST_BINARY override (unchanged from previous behaviour) —
 *      returned as-is when set and non-empty.
 *   2. Managed versioned binary selected by INFRACOST_VERSION, downloaded and
 *      digest-verified into <storage>/binaries/infracost/<version>/ on first use
 *      and cached thereafter.
 *
 * Concurrent resolution of the same version is serialized with a per-version
 * lock: only one worker downloads/extracts; everyone else waits, rechecks the
 * cache after acquiring the lock, and reuses the published install. Install
 * work happens in a unique staging directory that is atomically renamed into
 * place, so a failed attempt can never leave a partially-written install at
 * the published path and cleanup never touches another worker's install.
 *
 * Returns null when no binary can be resolved/installed so the caller records an
 * errored (but non-fatal to the plan/apply run) cost estimate — matching the
 * existing missing-tooling semantics.
 */
export async function resolveInfracostBinary(): Promise<{ binaryPath: string; version: string } | null> {
  const override = (process.env.INFRACOST_BINARY ?? "").trim();
  if (override !== "") {
    return { binaryPath: override, version: "override" };
  }

  const version = (process.env.INFRACOST_VERSION ?? DEFAULT_INFRACOST_VERSION).trim().replace(/^v/, "");
  if (version === "" || !validateVersion(version)) {
    log.warn(`[terrence] Invalid INFRACOST_VERSION "${version}"; cannot install Infracost`);
    return null;
  }

  const targetDir = join(BINARY_BASE_DIR, "infracost", version);
  const binaryPath = join(targetDir, `infracost-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "amd64"}`);

  // Fast path: a valid, fully-published install already exists. Read-only.
  if (await validCachedInfracostBinary(binaryPath, targetDir, `[terrence] Cached Infracost v${version} failed integrity check; reinstalling`)) return { binaryPath, version };

  // Slow path: serialize installs per version so concurrent workers never
  // download into / delete each other's directories.
  const lockDir = lockDirFor(version);
  if (!(await acquireVersionLock(lockDir))) {
    return null;
  }
  let stagingDir = "";
  try {
    // Recheck after acquiring the lock: a worker that finished while we were
    // waiting has already published a valid install we can reuse.
    if (await validCachedInfracostBinary(binaryPath, targetDir, `[terrence] Cached Infracost v${version} failed integrity check under lock; reinstalling`)) return { binaryPath, version };
    if (await exists(targetDir)) {
      // targetDir exists without a binary (legacy/partial state). We hold the
      // lock, so it cannot be another worker's in-progress install; clear it
      // so the atomic rename below can publish into a clean path.
      await rm(targetDir, { recursive: true, force: true });
    }

    stagingDir = stagingDirFor(version);
    await downloadAndVerify(version, stagingDir);
    const installedPath = await extractVerified(stagingDir);

    const digest = await calculateSha256(await Bun.file(installedPath).arrayBuffer());
    await writeIntegrity(stagingDir, { tool: "infracost", version, binarySha256: digest });
    await rename(stagingDir, targetDir);
    stagingDir = "";
    log.info(`[terrence] Installed Infracost v${version} to ${targetDir}`);
    return { binaryPath, version };
  } catch (error: unknown) {
    // A partial install is never trusted; remove only this worker's staging
    // directory. The published targetDir is never touched here — it may be
    // another worker's valid install.
    await cleanupFailedInfracostInstall(stagingDir);
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[terrence] Could not install Infracost v${version}: ${message}`);
    return null;
  } finally {
    await releaseVersionLock(lockDir);
  }
}
