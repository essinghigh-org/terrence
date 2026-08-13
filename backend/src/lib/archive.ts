import { createReadStream } from "node:fs";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

export const MAX_EXPANDED_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_ARCHIVE_MEMBERS = 10_000;

export function assertArchiveMemberCount(members: readonly unknown[]): void {
  if (members.length > MAX_ARCHIVE_MEMBERS) throw new Error("Archive contains too many members");
}

/** Reject compressed archives before tar can expand them into excessive disk usage. */
export async function assertArchiveExpandedSize(
  path: string,
  maxBytes = MAX_EXPANDED_ARCHIVE_BYTES,
): Promise<void> {
  let total = 0;
  await pipeline(
    createReadStream(path),
    createGunzip(),
    new Writable({
      // Node's Writable callback receives a mutable Buffer from the stream API.
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
      write(chunk: Buffer, _encoding, callback): void {
        total += chunk.length;
        callback(total > maxBytes ? new Error(`Archive expands beyond the ${maxBytes} byte limit`) : undefined);
      },
    }),
  );
}

/** Count logical file bytes so sparse tar members cannot bypass the gzip expansion cap. */
export async function assertArchiveLogicalSize(
  path: string,
  maxBytes = MAX_EXPANDED_ARCHIVE_BYTES,
): Promise<void> {
  const process = Bun.spawn(["tar", "-xOzf", path], { stdout: "pipe", stderr: "pipe" });
  const stderrPromise = new Response(process.stderr).text();
  const reader = process.stdout.getReader();
  let total = 0;
  let limitError: Error | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        limitError = new Error(`Archive contents exceed the ${maxBytes} byte limit`);
        process.kill();
        break;
      }
    }
  } catch (error) {
    process.kill();
    await Promise.allSettled([process.exited, stderrPromise]);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const [exitCode, stderr] = await Promise.all([process.exited, stderrPromise]);
  if (limitError !== undefined) throw limitError;
  if (exitCode !== 0) throw new Error(`Archive content validation failed: ${stderr.trim() || "tar failed"}`);
}
