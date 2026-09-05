import { chmod, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { decodeStatePayload, encryptStatePayload, parseTerraformStatePayload } from "./validation";
import { log } from "./log";

// ---------------------------------------------------------------------------
// Interrupted-apply recovery files (issue #579).
//
// When the process dies mid-apply, boot reconciliation copies the run's
// terraform.tfstate into <storage>/recovery/<runId>/ so the operator can
// fetch it (GET /api/v2/runs/:id/recovery-state) or promote it into a real
// state version (POST .../actions/recover-state, which deletes the copy on
// success). A power loss between a bare write and the workdir cleanup it
// precedes used to leave truncated ciphertext whose only source was then
// deleted, so every write here is durable and verified:
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
const STAGING_PREFIX = ".staging-";

export function recoveryDirFor(storageDir: string, runId: string): string {
  return join(storageDir, "recovery", runId);
}

export function recoveryStatePathFor(storageDir: string, runId: string): string {
  return join(recoveryDirFor(storageDir, runId), RECOVERY_STATE_FILENAME);
}

export function recoveryMarkerPathFor(storageDir: string, runId: string): string {
  return join(recoveryDirFor(storageDir, runId), RECOVERY_MARKER_FILENAME);
}

function stagingPathFor(dir: string, name: string): string {
  return join(dir, `${STAGING_PREFIX}${name}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
}

async function fsyncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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
  await mkdir(dir, { recursive: true, mode: 0o700 });
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
  await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
  let markerWritten = false;
  try {
    const payload = await readFile(source, "utf8");
    const encrypted = await encryptStatePayload(payload);
    if (encrypted === null) throw new Error("state encryption produced no output");
    await writeFileDurable(recoveryDir, RECOVERY_STATE_FILENAME, encrypted, 0o600);
    // Verify the published copy before it becomes anyone's only record: a
    // truncated or bit-rotted write must fail here, while the source still
    // exists, and never surface later as a 404 on read.
    const stored = await readFile(recoveryStatePathFor(storageDir, runId), "utf8");
    if (decodeStatePayload(stored) !== payload) {
      throw new Error("recovery copy failed read-back verification");
    }
    await writeFileDurable(recoveryDir, RECOVERY_MARKER_FILENAME, new Date().toISOString(), 0o600);
    markerWritten = true;
    return true;
  } catch (error: unknown) {
    // Never leave a markerless partial behind: without the marker the copy
    // is unreadable by design, so an incomplete capture is just garbage.
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
      adoptable = parseTerraformStatePayload(decodeStatePayload(stored)) !== null;
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
