import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { controlPlaneInstanceId } from "./ha-config";

export const UPLOAD_TEMP_LEASE_SUFFIX = ".terrence-upload-lease.json";
export const UPLOAD_TEMP_LEASE_LOCK_SUFFIX = ".mutation-lock";
const UPLOAD_TEMP_LEASE_LOCK_STALE_MS = 60_000;
const UPLOAD_TEMP_LEASE_LOCK_WAIT_MS = 10;
const UPLOAD_TEMP_LEASE_LOCK_TIMEOUT_MS = 5_000;

export type UploadTempLease = Readonly<{
  ownerInstanceId: string;
  claimedAt: number;
}>;

export function uploadTempLeasePath(targetPath: string): string {
  return `${targetPath}${UPLOAD_TEMP_LEASE_SUFFIX}`;
}

export function uploadTempLeaseMutationLockPath(targetPath: string): string {
  return `${uploadTempLeasePath(targetPath)}${UPLOAD_TEMP_LEASE_LOCK_SUFFIX}`;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

async function tryAcquireUploadTempLeaseMutationLock(targetPath: string): Promise<boolean> {
  const path = uploadTempLeaseMutationLockPath(targetPath);
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ ownerInstanceId: controlPlaneInstanceId, startedAt: Date.now() }),
        "utf8",
      );
    } finally {
      await handle.close();
    }
    return true;
  } catch (error: unknown) {
    if (!isErrno(error, "EEXIST")) throw error;
    try {
      const info = await stat(path);
      if (Date.now() - info.mtimeMs > UPLOAD_TEMP_LEASE_LOCK_STALE_MS) {
        await rm(path, { force: true });
      }
    } catch {
      // The current owner may have released the lock between open and stat.
    }
    return false;
  }
}

export async function withUploadTempLeaseMutationLock<T>(targetPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + UPLOAD_TEMP_LEASE_LOCK_TIMEOUT_MS;
  while (!(await tryAcquireUploadTempLeaseMutationLock(targetPath))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for upload lease mutation lock: ${targetPath}`);
    await Bun.sleep(UPLOAD_TEMP_LEASE_LOCK_WAIT_MS);
  }
  try {
    return await fn();
  } finally {
    await rm(uploadTempLeaseMutationLockPath(targetPath), { force: true });
  }
}

export async function acquireUploadTempLease(targetPath: string): Promise<void> {
  await withUploadTempLeaseMutationLock(targetPath, async (): Promise<void> => {
    const lease: UploadTempLease = { ownerInstanceId: controlPlaneInstanceId, claimedAt: Date.now() };
    await writeFile(uploadTempLeasePath(targetPath), JSON.stringify(lease), { mode: 0o600 });
  });
}

export async function releaseUploadTempLease(targetPath: string): Promise<void> {
  await withUploadTempLeaseMutationLock(targetPath, async (): Promise<void> => {
    await rm(uploadTempLeasePath(targetPath), { force: true });
  });
}

export async function readUploadTempLease(targetPath: string): Promise<UploadTempLease | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(uploadTempLeasePath(targetPath), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record["ownerInstanceId"] !== "string" ||
      record["ownerInstanceId"] === "" ||
      typeof record["claimedAt"] !== "number" ||
      !Number.isFinite(record["claimedAt"]) ||
      record["claimedAt"] < 0
    ) {
      return null;
    }
    return { ownerInstanceId: record["ownerInstanceId"], claimedAt: record["claimedAt"] };
  } catch {
    return null;
  }
}
