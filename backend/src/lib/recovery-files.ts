import { chmod, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { decodeStatePayload, decryptStatePayload, encryptStatePayload, isClientEncryptedState, parseTerraformStatePayload } from "./validation";
import { log } from "./log";

// ---------------------------------------------------------------------------
// Interrupted-apply recovery files (issue #579).
//
// When the process dies mid-apply, boot reconciliation copies the run's
// terraform.tfstate into <storage>/recovery/<runId>/ so the operator can
// fetch it (GET /api/v2/runs/:id/recovery-state) or promote it into a real
// state version (POST .../actions/recover-state, which retains the copy and
// promotion manifest as audit evidence). A power loss between a bare write
// and the workdir cleanup it precedes used to leave truncated ciphertext
// whose only source was then deleted, so every write here is durable and verified:
//
//   - state bytes go to a temp sibling, are fsynced, and are atomically
//     renamed into place, followed by a directory fsync;
//   - the published copy is read back, decrypted, and compared to the
//     source before anything else happens;
//   - the `.recovered` completion marker is written last (durably). A
//     state file without the marker is an unverified partial: readers
//     refuse it, and the boot sweep adopts it (marker it) when it
//     decrypts and parses, or deletes it when it does not.
//
// storageDir is a parameter (not the import-captured driver value) so tests
// can redirect it per case.
// ---------------------------------------------------------------------------

export const RECOVERY_STATE_FILENAME = "terraform.tfstate";
export const RECOVERY_MARKER_FILENAME = ".recovered";
export const RECOVERY_EVIDENCE_FILENAME = ".evidence.json";
export const RECOVERY_PROMOTED_FILENAME = ".promoted";
export const RECOVERY_PROMOTION_LOCK_FILENAME = ".promoting";
const STAGING_PREFIX = ".staging-";
const RECOVERY_EVIDENCE_VERSION = 1;
const MAX_RECOVERY_EVIDENCE_BYTES = 16 * 1024;
const PROMOTION_LOCK_TTL_MS = 10 * 60 * 1000;

export type RecoveryCaptureEvidence = Readonly<{
  version: 1;
  capturedAt: string;
  digest: string;
  size: number;
  serial: number | null;
  lineage: string | null;
  representation: "terraform-v4" | "opentofu-encrypted" | "invalid";
  status: "captured" | "promoted";
  promotedAt?: string;
  promotedStateVersionId?: string;
  promotedSerial?: number;
}>;

export type RecoveryCopyInspection = Readonly<{
  status: "missing" | "incomplete" | "invalid" | "opaque" | "candidate" | "promoted";
  marker: string | null;
  capturedAt: string | null;
  evidence: RecoveryCaptureEvidence | null;
  digest: string | null;
  size: number | null;
  serial: number | null;
  lineage: string | null;
  terraformVersion: string | null;
  payload?: string;
}>;

export function recoveryDirFor(storageDir: string, runId: string): string {
  return join(storageDir, "recovery", runId);
}

export function recoveryStatePathFor(storageDir: string, runId: string): string {
  return join(recoveryDirFor(storageDir, runId), RECOVERY_STATE_FILENAME);
}

export function recoveryMarkerPathFor(storageDir: string, runId: string): string {
  return join(recoveryDirFor(storageDir, runId), RECOVERY_MARKER_FILENAME);
}

export function recoveryEvidencePathFor(storageDir: string, runId: string): string {
  return join(recoveryDirFor(storageDir, runId), RECOVERY_EVIDENCE_FILENAME);
}

export function recoveryPromotedPathFor(storageDir: string, runId: string): string {
  return join(recoveryDirFor(storageDir, runId), RECOVERY_PROMOTED_FILENAME);
}

export function recoveryPromotionLockPathFor(storageDir: string, runId: string): string {
  return join(recoveryDirFor(storageDir, runId), RECOVERY_PROMOTION_LOCK_FILENAME);
}

function stagingPathFor(dir: string, name: string): string {
  return join(dir, `${STAGING_PREFIX}${name}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

async function fsyncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function boundedStateString(value: unknown): string | null {
  return typeof value === "string" && value.length <= 256 && value !== "" ? value : null;
}

function evidenceRepresentation(payload: string): RecoveryCaptureEvidence["representation"] {
  if (isClientEncryptedState(payload)) return "opentofu-encrypted";
  return parseTerraformStatePayload(payload) === null ? "invalid" : "terraform-v4";
}

function evidenceForPayload(payload: string, capturedAt: string): RecoveryCaptureEvidence {
  const parsed = parseTerraformStatePayload(payload);
  return {
    version: RECOVERY_EVIDENCE_VERSION,
    capturedAt,
    digest: createHash("sha256").update(payload).digest("hex"),
    size: Buffer.byteLength(payload),
    serial: parsed?.["serial"] !== undefined && Number.isSafeInteger(parsed["serial"]) ? parsed["serial"] as number : null,
    lineage: boundedStateString(parsed?.["lineage"]),
    representation: evidenceRepresentation(payload),
    status: "captured",
  };
}

function parseRecoveryEvidence(raw: string): RecoveryCaptureEvidence | null {
  if (raw.length > MAX_RECOVERY_EVIDENCE_BYTES) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record["version"] !== RECOVERY_EVIDENCE_VERSION
      || typeof record["capturedAt"] !== "string"
      || !/^\d{4}-\d{2}-\d{2}T/.test(record["capturedAt"])
      || typeof record["digest"] !== "string"
      || !/^[a-f0-9]{64}$/.test(record["digest"])
      || !Number.isSafeInteger(record["size"])
      || (record["size"] as number) < 0
      || !["terraform-v4", "opentofu-encrypted", "invalid"].includes(String(record["representation"]))
      || !["captured", "promoted"].includes(String(record["status"]))
      || (record["serial"] !== null && !Number.isSafeInteger(record["serial"]))
      || (record["lineage"] !== null && boundedStateString(record["lineage"]) === null)) {
      return null;
    }
    const promotedStateVersionId = record["promotedStateVersionId"];
    const promotedAt = record["promotedAt"];
    const promotedSerial = record["promotedSerial"];
    if (record["status"] === "promoted"
      && (typeof promotedStateVersionId !== "string" || promotedStateVersionId === "" || typeof promotedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(promotedAt))) {
      return null;
    }
    if (promotedSerial !== undefined && !Number.isSafeInteger(promotedSerial)) return null;
    return {
      version: RECOVERY_EVIDENCE_VERSION,
      capturedAt: record["capturedAt"],
      digest: record["digest"],
      size: record["size"] as number,
      serial: record["serial"] as number | null,
      lineage: record["lineage"] as string | null,
      representation: record["representation"] as RecoveryCaptureEvidence["representation"],
      status: record["status"] as RecoveryCaptureEvidence["status"],
      ...(typeof promotedAt === "string" ? { promotedAt } : {}),
      ...(typeof promotedStateVersionId === "string" ? { promotedStateVersionId } : {}),
      ...(typeof promotedSerial === "number" ? { promotedSerial } : {}),
    };
  } catch {
    return null;
  }
}

async function readEvidence(storageDir: string, runId: string): Promise<RecoveryCaptureEvidence | null> {
  try {
    return parseRecoveryEvidence(await readFile(recoveryEvidencePathFor(storageDir, runId), "utf8"));
  } catch {
    return null;
  }
}

/** Inspect a recovery copy without returning its raw state by default. The
 * marker, state bytes and manifest are checked together so callers cannot
 * accidentally offer a markerless or changed copy as a verified candidate. */
export async function inspectRecoveryCopy(
  storageDir: string,
  runId: string,
  includePayload = false,
): Promise<RecoveryCopyInspection> {
  const markerPath = recoveryMarkerPathFor(storageDir, runId);
  let marker: string;
  try {
    marker = await readFile(markerPath, "utf8");
  } catch {
    let stateExists = false;
    try { stateExists = await Bun.file(recoveryStatePathFor(storageDir, runId)).exists(); } catch { stateExists = false; }
    return {
      status: stateExists ? "incomplete" : "missing",
      marker: null,
      capturedAt: null,
      evidence: await readEvidence(storageDir, runId),
      digest: null,
      size: null,
      serial: null,
      lineage: null,
      terraformVersion: null,
    };
  }
  const evidence = await readEvidence(storageDir, runId);
  let evidenceFilePresent = false;
  try { evidenceFilePresent = await Bun.file(recoveryEvidencePathFor(storageDir, runId)).exists(); } catch { evidenceFilePresent = false; }
  const evidenceInvalid = evidence === null && evidenceFilePresent;
  const markerValue = marker.trim();
  // `complete` was the marker written by the pre-manifest recovery format.
  // Continue to read those durable copies so an upgrade does not turn an
  // already captured state into an inaccessible orphan.
  const capturedAt = /^\d{4}-\d{2}-\d{2}T/.test(markerValue)
    ? markerValue
    : markerValue === "complete"
      ? evidence?.capturedAt ?? null
      : null;
  if (markerValue === "" || (capturedAt === null && markerValue !== "complete")) {
    return { status: "incomplete", marker, capturedAt: null, evidence, digest: null, size: null, serial: null, lineage: null, terraformVersion: null };
  }
  let stored: string;
  try {
    stored = await readFile(recoveryStatePathFor(storageDir, runId), "utf8");
  } catch {
    return { status: "incomplete", marker, capturedAt, evidence, digest: null, size: null, serial: null, lineage: null, terraformVersion: null };
  }
  let payload: string;
  try {
    payload = decodeStatePayload(stored);
  } catch {
    // Older/manual recovery captures were written as plaintext Terraform
    // JSON. Keep those captures reviewable and promotable while preserving
    // the encrypted representation used by normal capture writes.
    if (parseTerraformStatePayload(stored) === null) {
      return { status: "invalid", marker, capturedAt, evidence, digest: null, size: Buffer.byteLength(stored), serial: null, lineage: null, terraformVersion: null };
    }
    payload = stored;
  }
  const parsed = parseTerraformStatePayload(payload);
  const digest = createHash("sha256").update(payload).digest("hex");
  const serial = parsed?.["serial"] !== undefined && Number.isSafeInteger(parsed["serial"]) ? parsed["serial"] as number : null;
  const lineage = boundedStateString(parsed?.["lineage"]);
  const terraformVersion = boundedStateString(parsed?.["terraform_version"]);
  const evidenceMatches = !evidenceInvalid && (evidence === null
    || (evidence.digest === digest && evidence.size === Buffer.byteLength(payload)));
  const status = evidence?.status === "promoted" && evidence.promotedStateVersionId !== undefined && evidenceMatches
    ? "promoted"
    : evidenceInvalid
      ? "invalid"
      : parsed !== null && evidenceMatches
        ? "candidate"
        : isClientEncryptedState(payload) && evidenceMatches
          ? "opaque"
          : "invalid";
  return {
    status,
    marker,
    capturedAt,
    evidence,
    digest,
    size: Buffer.byteLength(payload),
    serial,
    lineage,
    terraformVersion,
    ...(includePayload ? { payload } : {}),
  };
}

/** Claim a promotion attempt with an expiring filesystem lock. This closes
 * the cross-process window where two identical POSTs could both commit. */
export async function acquireRecoveryPromotionLock(storageDir: string, runId: string): Promise<boolean> {
  const dir = recoveryDirFor(storageDir, runId);
  await mkdirDurable(dir);
  const path = recoveryPromotionLockPathFor(storageDir, runId);
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ startedAt: new Date().toISOString() }), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(dir);
    return true;
  } catch (error: unknown) {
    if (!isErrno(error, "EEXIST")) throw error;
    try {
      const info = await stat(path);
      if (Date.now() - info.mtimeMs > PROMOTION_LOCK_TTL_MS) {
        await rm(path, { force: true });
        return await acquireRecoveryPromotionLock(storageDir, runId);
      }
    } catch {
      // A concurrent owner may have completed between open and stat.
    }
    return false;
  }
}

export async function releaseRecoveryPromotionLock(storageDir: string, runId: string): Promise<void> {
  await rm(recoveryPromotionLockPathFor(storageDir, runId), { force: true });
}

/** Retain the captured bytes and attach the committed state version identity
 * so repeated recovery requests can return the original result. */
export async function markRecoveryPromoted(
  storageDir: string,
  runId: string,
  stateVersionId: string,
  serial: number,
): Promise<void> {
  const inspection = await inspectRecoveryCopy(storageDir, runId, true);
  const evidence = inspection.evidence ?? (inspection.payload === undefined ? null : evidenceForPayload(inspection.payload, inspection.capturedAt ?? new Date().toISOString()));
  if (evidence === null) throw new Error("Cannot retain recovery evidence without a valid capture manifest");
  const promoted: RecoveryCaptureEvidence = {
    ...evidence,
    status: "promoted",
    promotedAt: new Date().toISOString(),
    promotedStateVersionId: stateVersionId,
    promotedSerial: serial,
  };
  await writeFileDurable(recoveryDirFor(storageDir, runId), RECOVERY_EVIDENCE_FILENAME, JSON.stringify(promoted), 0o600);
  await writeFileDurable(recoveryDirFor(storageDir, runId), RECOVERY_PROMOTED_FILENAME, promoted.promotedAt ?? new Date().toISOString(), 0o600);
}

/** Recursively create `dir` (mode 0700: this module only manages the
 * recovery area) and fsync every created level's parent, so a power loss
 * cannot drop a newly created recovery directory entry. A plain recursive
 * mkdir plus a leaf-only fsync leaves exactly that window on first capture.
 */
async function mkdirDurable(dir: string): Promise<void> {
  const missing: string[] = [];
  let cur = dir;
  for (;;) {
    missing.unshift(cur);
    try {
      await mkdir(cur, { mode: 0o700 });
      break;
    } catch (error: unknown) {
      if (isErrno(error, "EEXIST")) break;
      if (!isErrno(error, "ENOENT")) throw error;
      const parent = dirname(cur);
      if (parent === cur) throw error;
      cur = parent;
    }
  }
  // missing[0] exists (pre-existing, or just created with an existing
  // parent); create downward, fsyncing each parent.
  const top = missing[0];
  if (top === undefined) throw new Error(`Cannot create recovery directory ${dir}: path resolution failed`);
  let parent = top;
  for (const child of missing.slice(1)) {
    try {
      await mkdir(child, { mode: 0o700 });
    } catch (error: unknown) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    await fsyncDirectory(parent);
    parent = child;
  }
  const topParent = dirname(top);
  if (topParent !== top) await fsyncDirectory(topParent);
  await fsyncDirectory(dir);
}

/** Durably publish `data` as `dir/name`: temp sibling, file fsync, atomic
 * rename, directory fsync, then mode bits. A crash can leave the staging
 * temp behind (swept at boot) but never a partial published file. Staging
 * temps from a failed attempt are removed before throwing. */
export async function writeFileDurable(
  dir: string,
  name: string,
  data: string,
  mode: number,
): Promise<void> {
  await mkdirDurable(dir);
  const staging = stagingPathFor(dir, name);
  try {
    const handle = await open(staging, "w", mode);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staging, join(dir, name));
    await fsyncDirectory(dir);
    await chmod(join(dir, name), mode);
  } catch (error: unknown) {
    await rm(staging, { force: true });
    throw error;
  }
}

/** Capture the run's terraform.tfstate into the recovery area (issue #579).
 *
 * Returns true when a copy was captured and read-back verified, false when
 * the work root holds no state file at all. Throws when a state file exists
 * but cannot be captured intact (unreadable, unencryptable, unverifiable):
 * callers must treat that as a failed capture and preserve the work
 * directory for manual recovery instead of deleting it.
 */
export async function captureInterruptedApplyState(
  storageDir: string,
  runId: string,
  workRoot: string,
): Promise<boolean> {
  let source: string | null = null;
  for await (const candidate of new Bun.Glob("**/terraform.tfstate").scan({ cwd: workRoot, onlyFiles: true })) {
    source = candidate.startsWith("/") ? candidate : join(workRoot, candidate);
    break;
  }
  if (source === null) return false;

  const recoveryDir = recoveryDirFor(storageDir, runId);
  const markerPath = recoveryMarkerPathFor(storageDir, runId);
  await mkdirDurable(recoveryDir);
  let markerWritten = false;
  let previousMarker: string | null = null;
  let previousEvidence: string | null = null;
  let previousState: string | null = null;
  let previousPromoted: string | null = null;
  try {
    // A retry can run after a crash that landed between a previous
    // capture's marker write and the run status change: drop any stale
    // marker first so a replacement state is never mistaken for complete
    // before it passes read-back verification below.
    try {
      previousMarker = await readFile(markerPath, "utf8");
    } catch {
      previousMarker = null;
    }
    try {
      previousEvidence = await readFile(recoveryEvidencePathFor(storageDir, runId), "utf8");
    } catch {
      previousEvidence = null;
    }
    try {
      previousState = await readFile(recoveryStatePathFor(storageDir, runId), "utf8");
    } catch {
      previousState = null;
    }
    try {
      previousPromoted = await readFile(recoveryPromotedPathFor(storageDir, runId), "utf8");
    } catch {
      previousPromoted = null;
    }
    if (previousMarker !== null) {
      await rm(markerPath, { force: true });
      await fsyncDirectory(recoveryDir);
    }
    // A recapture supersedes any prior promotion metadata for this run. The
    // old marker is retained above for rollback if the replacement fails.
    if (previousPromoted !== null) {
      await rm(recoveryPromotedPathFor(storageDir, runId), { force: true });
      await fsyncDirectory(recoveryDir);
    }
    // Raw bytes on purpose: utf8 decoding replaces split multibyte
    // sequences, which would let a corrupted copy pass verification. If
    // the source is not valid UTF-8 the encryption layer cannot preserve
    // it, so reject here (throwing preserves the work directory).
    const raw = await readFile(source);
    const payload = raw.toString("utf8");
    if (!Buffer.from(payload, "utf8").equals(raw)) {
      throw new Error("source state file is not valid UTF-8; leaving the work directory for manual recovery");
    }
    const encrypted = await encryptStatePayload(payload);
    if (encrypted === null) throw new Error("state encryption produced no output");
    await writeFileDurable(recoveryDir, RECOVERY_STATE_FILENAME, encrypted, 0o600);
    // Verify the published copy before it becomes anyone's only record: a
    // truncated or bit-rotted write must fail here, while the source still
    // exists, and never surface later as a 404 on read. Decrypt-only on
    // purpose: interrupted applies can leave partial, non-JSON bytes, and
    // the cancel path contract is to preserve whatever the engine wrote
    // (read-time parsing still gates the download/recover endpoints).
    const stored = await readFile(recoveryStatePathFor(storageDir, runId), "utf8");
    if (decryptStatePayload(stored) !== payload) {
      throw new Error("recovery copy failed read-back verification");
    }
    const capturedAt = new Date().toISOString();
    await writeFileDurable(recoveryDir, RECOVERY_EVIDENCE_FILENAME, JSON.stringify(evidenceForPayload(payload, capturedAt)), 0o600);
    await writeFileDurable(recoveryDir, RECOVERY_MARKER_FILENAME, capturedAt, 0o600);
    markerWritten = true;
    return true;
  } catch (error: unknown) {
    if (previousMarker !== null && previousState !== null) {
      // Restore every published part of the previous complete copy. A failure
      // after replacing the state bytes (for example while writing its
      // manifest) must not orphan the only verified recovery evidence.
      try {
        await writeFileDurable(recoveryDir, RECOVERY_STATE_FILENAME, previousState, 0o600);
        await writeFileDurable(recoveryDir, RECOVERY_MARKER_FILENAME, previousMarker, 0o600);
        if (previousEvidence !== null) {
          await writeFileDurable(recoveryDir, RECOVERY_EVIDENCE_FILENAME, previousEvidence, 0o600);
        } else {
          await rm(recoveryEvidencePathFor(storageDir, runId), { force: true });
        }
        if (previousPromoted !== null) {
          await writeFileDurable(recoveryDir, RECOVERY_PROMOTED_FILENAME, previousPromoted, 0o600);
        } else {
          await rm(recoveryPromotedPathFor(storageDir, runId), { force: true });
        }
        markerWritten = true;
      } catch {
        // Fall through to removal below.
      }
    }
    // Never leave a markerless partial behind: without the marker the copy
    // is unreadable by design, so an incomplete capture is just garbage.
    // (When the replacement itself was published but unverifiable, the
    // source work directory is preserved by the caller, so nothing is lost.)
    if (!markerWritten) await rm(recoveryDir, { recursive: true, force: true });
    throw error;
  }
}

export type RecoverySweepResult = Readonly<{
  removedStaging: number;
  adoptedComplete: number;
  removedPartial: number;
}>;

/** Boot sweep for recovery-area leftovers (issue #579).
 *
 * Crash windows are tiny but nonzero: a staging temp means a capture died
 * before its atomic rename, and a markerless state means it died between
 * the rename and the marker. Staging temps are always safe to delete.
 * A markerless state that still decrypts and parses is a complete copy
 * missing only its marker, so it is adopted (marker written); anything
 * else is an unverifiable partial and is deleted. station-keeping runs at
 * boot, when no capture can be in flight.
 */
export async function sweepIncompleteRecoveryCopies(storageDir: string): Promise<RecoverySweepResult> {
  let removedStaging = 0;
  let adoptedComplete = 0;
  let removedPartial = 0;
  let entries: string[];
  try {
    entries = await readdir(join(storageDir, "recovery"));
  } catch {
    return { removedStaging, adoptedComplete, removedPartial };
  }
  for (const entry of entries) {
    const dir = join(storageDir, "recovery", entry);
    let children: string[];
    try {
      children = await readdir(dir);
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.startsWith(STAGING_PREFIX)) continue;
      try {
        await rm(join(dir, child), { force: true });
        removedStaging += 1;
      } catch {
        // Best-effort; the next boot retries.
      }
    }
    let hasMarker = false;
    try {
      children = await readdir(dir);
      hasMarker = children.includes(RECOVERY_MARKER_FILENAME);
    } catch {
      continue;
    }
    if (hasMarker) continue;
    let adoptable = false;
    try {
      const stored = await readFile(join(dir, RECOVERY_STATE_FILENAME), "utf8");
      const payload = decodeStatePayload(stored);
      // Without the client key, a markerless encrypted copy cannot be verified.
      // Retain it for manual recovery instead of treating it as disposable corruption.
      if (isClientEncryptedState(payload)) continue;
      adoptable = parseTerraformStatePayload(payload) !== null;
    } catch {
      adoptable = false;
    }
    try {
      if (adoptable) {
        await writeFileDurable(dir, RECOVERY_MARKER_FILENAME, new Date().toISOString(), 0o600);
        adoptedComplete += 1;
        log.info(`[terrence] Adopted interrupted-apply recovery copy for run ${entry} (state intact, marker missing)`);
      } else {
        await rm(dir, { recursive: true, force: true });
        removedPartial += 1;
        log.warn(`[terrence] Removed incomplete interrupted-apply recovery copy for run ${entry}`);
      }
    } catch {
      // Best-effort; the next boot retries.
    }
  }
  return { removedStaging, adoptedComplete, removedPartial };
}
