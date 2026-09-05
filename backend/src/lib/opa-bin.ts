import { join, resolve } from "path";
import { chmod, exists, mkdir, rename, rm, stat, writeFile } from "fs/promises";
import { log } from "./log";

// ---------------------------------------------------------------------------
// On-demand, versioned OPA binary management (storage-backed, issue #596).
//
// Policy checks resolved OPA via OPA_BINARY_PATH / PATH only, so the
// advertised OPA checks failed with executable-not-found on stock installs.
// This module moves OPA onto the same storage-backed, version-pinned,
// digest-verified lifecycle as Infracost (see infracost-bin.ts): deployments
// select a version via OPA_VERSION and the binary is downloaded on first use
// into <storage>/binaries/opa/<version>/ and cached thereafter. Sentinel
// stays bring-your-own (proprietary, no public download) via
// SENTINEL_BINARY_PATH / PATH.
//
// It intentionally does NOT extend binaryManager.ts or infracost-bin.ts: OPA
// publishes a single static binary per platform (no archive to extract) with
// a per-asset `.sha256` sidecar, so its download/verify steps differ from
// both the zip-based manager and the tar.gz-based Infracost path.
// ---------------------------------------------------------------------------

const STORAGE_DIR = resolve(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"));
// Tests may redirect the binary cache (setup.ts shares one disk cache across the
// test worker and spawned backends via TERRENCE_BINARY_CACHE_DIR).
const BINARY_BASE_DIR = resolve(
  process.env["TERRENCE_BINARY_CACHE_DIR"] !== undefined && process.env["TERRENCE_BINARY_CACHE_DIR"] !== ""
    ? process.env["TERRENCE_BINARY_CACHE_DIR"]
    : join(STORAGE_DIR, "binaries"),
);

/** Default OPA version applied when OPA_VERSION is unset. Kept in sync with
 * releases; bump deliberately. */
const DEFAULT_OPA_VERSION = "1.20.2";

export type OpaIntegrity = {
  tool: "opa";
  version: string;
  binarySha256: string;
};

const INTEGRITY_FILE = ".integrity.json";

function integrityFilePath(targetDir: string): string {
  return join(targetDir, INTEGRITY_FILE);
}

/** Validate an OPA version spec (exact x.y.z, optional leading v). */
function validateVersion(version: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version.replace(/^v/, ""));
}

async function calculateSha256(buffer: Readonly<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map((b: number): string => b.toString(16).padStart(2, "0")).join("");
}

type IntegrityRead =
  | { status: "ok"; integrity: OpaIntegrity }
  | { status: "missing" }
  | { status: "invalid" };

async function readIntegrity(targetDir: string): Promise<IntegrityRead> {
  let raw: string;
  try {
    raw = await Bun.file(integrityFilePath(targetDir)).text();
  } catch {
    return { status: "missing" };
  }
  let parsed: Partial<OpaIntegrity>;
  try {
    parsed = JSON.parse(raw) as Partial<OpaIntegrity>;
  } catch {
    return { status: "invalid" };
  }
  if (
    parsed.tool === "opa"
    && typeof parsed.version === "string"
    && typeof parsed.binarySha256 === "string"
    && /^[0-9a-f]{64}$/.test(parsed.binarySha256)
  ) {
    return { status: "ok", integrity: { tool: "opa", version: parsed.version, binarySha256: parsed.binarySha256 } };
  }
  return { status: "invalid" };
}

async function verifyBinary(targetPath: string, integrity: Readonly<OpaIntegrity>): Promise<boolean> {
  try {
    const buffer = await Bun.file(targetPath).arrayBuffer();
    return (await calculateSha256(buffer)) === integrity.binarySha256.toLowerCase();
  } catch {
    return false;
  }
}

async function writeIntegrity(targetDir: string, integrity: Readonly<OpaIntegrity>): Promise<void> {
  await writeFile(integrityFilePath(targetDir), JSON.stringify(integrity, null, 2), "utf8");
  try {
    await chmod(integrityFilePath(targetDir), 0o600);
  } catch {
    // Best-effort; storage dir permissions are the operator's concern.
  }
}

type OpaPlatform = { os: string; arch: string } | { unsupported: string };

/** OPA publishes one static binary per platform: opa_<os>_<arch>. Anything
 * outside linux/darwin on amd64/arm64 has no upstream asset. */
function currentPlatform(): OpaPlatform {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (os === null || arch === null) return { unsupported: `${process.platform}/${process.arch}` };
  return { os, arch };
}

/** Parse an OPA per-asset `.sha256` sidecar (`<sha256><space><space><file>`
 * or a bare hash) and return the digest when it names the expected asset. A
 * sidecar naming a different file is refused: it proves nothing about the
 * downloaded binary. */
function parseSidecar(sidecarText: string, asset: string): string | null {
  const parts = sidecarText.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === undefined || !/^[0-9a-f]{64}$/i.test(parts[0])) return null;
  if (parts.length >= 2 && parts[1] !== asset) return null;
  return parts[0].toLowerCase();
}

/** Download the binary and its `.sha256` sidecar, verify the digest, and
 * only then write the binary to disk inside stagingDir. Throws on any
 * upstream/verify failure; the caller tiers that into an unreachable (never
 * failed) policy check with install guidance. */
async function downloadAndVerify(
  version: string,
  asset: string,
  stagingDir: string,
): Promise<void> {
  const binaryUrl = `https://github.com/open-policy-agent/opa/releases/download/v${version}/${asset}`;
  const sumUrl = `${binaryUrl}.sha256`;

  log.info(`[terrence] Downloading OPA v${version} (${asset}) from ${binaryUrl}`);
  const [binaryRes, sumRes] = await Promise.all([
    fetch(binaryUrl, { signal: AbortSignal.timeout(180_000) }),
    fetch(sumUrl, { signal: AbortSignal.timeout(30_000) }),
  ]);
  if (!binaryRes.ok) throw new Error(`HTTP ${binaryRes.status} fetching OPA binary`);
  if (!sumRes.ok) throw new Error(`HTTP ${sumRes.status} fetching OPA checksum`);

  const binaryBuffer = await binaryRes.arrayBuffer();
  const expected = parseSidecar(await sumRes.text(), asset);
  if (expected === null) {
    throw new Error("OPA checksum sidecar did not contain a valid SHA-256 entry for the platform binary");
  }

  const actual = await calculateSha256(binaryBuffer);
  if (actual !== expected) {
    throw new Error(`OPA binary SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }

  await mkdir(stagingDir, { recursive: true });
  const stagedPath = join(stagingDir, "opa");
  await Bun.write(stagedPath, binaryBuffer);
  await chmod(stagedPath, 0o755);
}

/** How long a per-version install lock may be held before it is treated as
 * stale (owner crashed mid-install) and reclaimed. Generous: a fresh download
 * is bounded by a 180s fetch timeout plus verification, far below this. */
const LOCK_STALE_MS = 10 * 60_000;

/** How long to wait for a concurrent installer to release the version lock
 * before giving up and reporting the engine as unavailable. */
const LOCK_WAIT_MS = 5 * 60_000;

/** Poll interval while waiting on a held version lock. */
const LOCK_POLL_MS = 200;

function lockDirFor(version: string): string {
  return join(BINARY_BASE_DIR, "opa", `.opa-${version}.lock`);
}

function stagingDirFor(version: string): string {
  return join(BINARY_BASE_DIR, "opa", `.opa-${version}.staging-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
}

/** Acquire the per-version install lock (atomic mkdir). Returns true on
 * success. Reclaims stale locks left by crashed installers. */
async function acquireVersionLock(lockDir: string): Promise<boolean> {
  // Ensure the parent tree exists before the non-recursive lock mkdir below:
  // on a fresh storage layout `binaries/opa/` may not exist yet, and a
  // recursive mkdir of the lock itself would defeat its atomicity (no EEXIST).
  await mkdir(join(BINARY_BASE_DIR, "opa"), { recursive: true });
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
        log.warn(`[terrence] Timed out waiting for OPA install lock ${lockDir}`);
        return false;
      }
      await Bun.sleep(LOCK_POLL_MS);
    }
  }
}

async function releaseVersionLock(lockDir: string): Promise<void> {
  await rm(lockDir, { recursive: true, force: true });
}

async function validCachedOpaBinary(binaryPath: string, targetDir: string, invalidMessage: string): Promise<boolean> {
  if (!(await exists(binaryPath))) return false;
  const integrity = await readIntegrity(targetDir);
  if (integrity.status === "ok" && (await verifyBinary(binaryPath, integrity.integrity))) return true;
  log.warn(invalidMessage);
  return false;
}

async function cleanupFailedOpaInstall(stagingDir: string): Promise<void> {
  if (stagingDir === "") return;
  try {
    await rm(stagingDir, { recursive: true, force: true });
  } catch {
    // Cleanup failure is secondary.
  }
}

/** Resolve the managed OPA binary selected by OPA_VERSION, downloading and
 * digest-verifying it into <storage>/binaries/opa/<version>/ on first use
 * and caching thereafter.
 *
 * This is the last tier of OPA resolution (worker probe order: explicit
 * OPA_BINARY_PATH override, then PATH, then this): it performs a network
 * download, so callers that must stay offline pass no such option — they
 * simply do not call it.
 *
 * Concurrent resolution of the same version is serialized with a per-version
 * lock: only one worker downloads/verifies; everyone else waits, rechecks
 * the cache after acquiring the lock, and reuses the published install.
 * Install work happens in a unique staging directory that is atomically
 * renamed into place, so a failed attempt can never leave a
 * partially-written install at the published path.
 *
 * Returns null when no binary can be resolved/installed so the caller
 * records an unreachable (never failed) policy check with install guidance.
 */
export async function resolveManagedOpaBinary(): Promise<{ binaryPath: string; version: string } | null> {
  const version = (process.env["OPA_VERSION"] ?? DEFAULT_OPA_VERSION).trim().replace(/^v/, "");
  if (version === "" || !validateVersion(version)) {
    log.warn(`[terrence] Invalid OPA_VERSION "${version}"; cannot install OPA`);
    return null;
  }

  const platform = currentPlatform();
  if ("unsupported" in platform) {
    log.warn(`[terrence] No upstream OPA binary for platform ${platform.unsupported}; cannot install OPA`);
    return null;
  }
  const asset = `opa_${platform.os}_${platform.arch}`;

  const targetDir = join(BINARY_BASE_DIR, "opa", version);
  const binaryPath = join(targetDir, "opa");

  // Fast path: a valid, fully-published install already exists. Read-only.
  if (await validCachedOpaBinary(binaryPath, targetDir, `[terrence] Cached OPA v${version} failed integrity check; reinstalling`)) {
    return { binaryPath, version };
  }

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
    if (await validCachedOpaBinary(binaryPath, targetDir, `[terrence] Cached OPA v${version} failed integrity check under lock; reinstalling`)) {
      return { binaryPath, version };
    }
    if (await exists(targetDir)) {
      // targetDir exists without a binary (legacy/partial state). We hold the
      // lock, so it cannot be another worker's in-progress install; clear it
      // so the atomic rename below can publish into a clean path.
      await rm(targetDir, { recursive: true, force: true });
    }

    stagingDir = stagingDirFor(version);
    await downloadAndVerify(version, asset, stagingDir);

    const digest = await calculateSha256(await Bun.file(join(stagingDir, "opa")).arrayBuffer());
    await writeIntegrity(stagingDir, { tool: "opa", version, binarySha256: digest });
    await rename(stagingDir, targetDir);
    stagingDir = "";
    log.info(`[terrence] Installed OPA v${version} to ${targetDir}`);
    return { binaryPath, version };
  } catch (error: unknown) {
    // A partial install is never trusted; remove only this worker's staging
    // directory. The published targetDir is never touched here — it may be
    // another worker's valid install.
    await cleanupFailedOpaInstall(stagingDir);
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[terrence] Could not install OPA v${version}: ${message}`);
    return null;
  } finally {
    await releaseVersionLock(lockDir);
  }
}
