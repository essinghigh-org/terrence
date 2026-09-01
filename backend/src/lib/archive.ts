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

/** True when a tar member name is dangerous to extract. The conservative
 * substring rule is part of the existing archive-safety contract: any `..`
 * sequence is rejected, including one embedded in a filename. */
export function tarMemberPathUnsafe(member: string): boolean {
  return member.startsWith("/") || member.includes("..");
}

/** True when a tar verbose-listing type denotes a link or special file. */
export function tarMemberIsForbiddenSpecial(firstChar: string): boolean {
  return firstChar === "l"
    || firstChar === "h"
    || firstChar === "c"
    || firstChar === "b"
    || firstChar === "p"
    || firstChar === "s";
}

function tarVerboseMemberName(line: string): string | undefined {
  // `--numeric-owner` makes the owner field a single token. The remaining
  // suffix is the exact member name, including spaces; symlink targets remain
  // available in the full line for the special-member check above.
  return /^\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+(.+)$/.exec(line)?.[1];
}

/** Validate every safety property before a tar archive is extracted. */
export async function assertSafeTarArchive(path: string): Promise<void> {
  await assertArchiveExpandedSize(path);
  const verboseProcess = Bun.spawn(["tar", "--numeric-owner", "-tvzf", path], { stdout: "pipe", stderr: "pipe" });
  const [verboseExit, verboseText] = await Promise.all([
    verboseProcess.exited,
    new Response(verboseProcess.stdout).text(),
    new Response(verboseProcess.stderr).text(),
  ]);
  if (verboseExit !== 0) throw new Error("Archive member inspection failed");
  const verboseMembers = verboseText.split("\n").map((line): string => line.trim()).filter((line): boolean => line !== "");
  assertArchiveMemberCount(verboseMembers);
  for (const line of verboseMembers) {
    if (tarMemberIsForbiddenSpecial(line.charAt(0)) || line.includes(" -> ") || line.includes(" link to ")) {
      throw new Error("Archive contains a forbidden link or special member");
    }
    const member = tarVerboseMemberName(line);
    if (member === undefined || tarMemberPathUnsafe(member)) throw new Error("Archive contains a dangerous path");
  }
  await assertArchiveLogicalSize(path);
}