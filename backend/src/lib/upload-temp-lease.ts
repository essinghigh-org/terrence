import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { controlPlaneInstanceId } from "./ha-config";

export const UPLOAD_TEMP_LEASE_SUFFIX = ".terrence-upload-lease.json";

export type UploadTempLease = Readonly<{
  ownerInstanceId: string;
  claimedAt: number;
}>;

export function uploadTempLeasePath(targetPath: string): string {
  return `${targetPath}${UPLOAD_TEMP_LEASE_SUFFIX}`;
}

export async function acquireUploadTempLease(targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  const lease: UploadTempLease = { ownerInstanceId: controlPlaneInstanceId, claimedAt: Date.now() };
  await writeFile(uploadTempLeasePath(targetPath), JSON.stringify(lease), { mode: 0o600 });
}

export async function releaseUploadTempLease(targetPath: string): Promise<void> {
  await rm(uploadTempLeasePath(targetPath), { force: true });
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
