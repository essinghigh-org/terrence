import { createReadStream } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { runBoundedProcess } from "./bounded-process";

export const MAX_EXPANDED_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_ARCHIVE_MEMBERS = 10_000;

export function assertArchiveMemberCount(members: readonly unknown[]): void {
  if (members.length > MAX_ARCHIVE_MEMBERS) throw new Error("Archive contains too many members");
}

/** Reject compressed archives before tar can expand them into excessive disk usage. */
export async function assertArchiveExpandedSize(
  path: string,
  maxBytes = MAX_EXPANDED_ARCHIVE_BYTES,
  signal: AbortSignal = AbortSignal.timeout(30_000),
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
    { signal },
  );
}

/** Count logical file bytes so sparse tar members cannot bypass the gzip expansion cap. */
export async function assertArchiveLogicalSize(
  path: string,
  maxBytes = MAX_EXPANDED_ARCHIVE_BYTES,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<void> {
  await runBoundedProcess(["tar", "-xOzf", path], {
    signal,
    maxStdoutBytes: maxBytes,
    discardStdout: true,
    stdoutLimitMessage: `Archive contents exceed the ${maxBytes} byte limit`,
  });
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

export type ArchiveOptions = Readonly<{
  maxCompressedBytes?: number;
  maxFileBytes?: number;
  signal?: AbortSignal;
}>;

/** Validate every safety property before a tar archive is extracted. */
export async function assertSafeTarArchive(path: string, options: ArchiveOptions = {}): Promise<void> {
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal === undefined ? [] : [options.signal])]);
  signal.throwIfAborted();
  const compressed = await stat(path);
  if (!compressed.isFile() || compressed.size === 0) throw new Error("Archive is empty");
  if (compressed.size > (options.maxCompressedBytes ?? MAX_EXPANDED_ARCHIVE_BYTES)) {
    throw new Error("Archive exceeds the compressed byte upload limit");
  }
  await assertArchiveExpandedSize(path, MAX_EXPANDED_ARCHIVE_BYTES, signal);
  const { stdout: verboseText } = await runBoundedProcess(["tar", "--numeric-owner", "-tvzf", path], { signal });
  const verboseMembers = verboseText.split("\n").filter((line): boolean => line !== "");
  assertArchiveMemberCount(verboseMembers);
  if (verboseMembers.length === 0) throw new Error("Archive contains no files");
  const seen = new Set<string>();
  for (const line of verboseMembers) {
    if (!line.startsWith("-") && !line.startsWith("d")) {
      throw new Error("Archive contains a forbidden link or special member");
    }
    const member = tarVerboseMemberName(line);
    if (member === undefined || tarMemberPathUnsafe(member) || member.includes("\\") || /^[A-Za-z]:/.test(member)) {
      throw new Error("Archive contains an unsafe path");
    }
    const canonical = member.split("/").filter((part): boolean => part !== "" && part !== ".").join("/");
    if (seen.has(canonical)) throw new Error("Archive contains duplicate members");
    seen.add(canonical);
    const size = Number(/^\S+\s+\S+\s+(\d+)\s/.exec(line)?.[1]);
    if (!Number.isSafeInteger(size) || size > (options.maxFileBytes ?? MAX_EXPANDED_ARCHIVE_BYTES)) {
      throw new Error("Archive contains a file larger than the byte limit");
    }
  }
  await assertArchiveLogicalSize(path, MAX_EXPANDED_ARCHIVE_BYTES, signal);
}

async function assertExtractionDirectory(destination: string, signal: Readonly<AbortSignal>): Promise<void> {
  let ancestor = resolve(destination);
  while (true) {
    signal.throwIfAborted();
    if (!(await lstat(ancestor)).isDirectory()) throw new Error("Archive destination contains a link or special file");
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const pending = [destination];
  let entries = 0;
  while (pending.length > 0) {
    signal.throwIfAborted();
    const path = pending.pop();
    if (path === undefined) break;
    const info = await lstat(path);
    if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1) || (!info.isDirectory() && !info.isFile())) {
      throw new Error("Archive destination contains a link or special file");
    }
    if (info.isDirectory()) {
      const names = await readdir(path);
      entries += names.length;
      if (entries > MAX_ARCHIVE_MEMBERS) throw new Error("Archive destination contains too many members");
      pending.push(...names.map((name): string => join(path, name)));
    }
  }
}

/** Callers supply a private staging directory; validate before writing any member. */
export async function extractSafeTarArchive(
  path: string,
  destination: string,
  options: ArchiveOptions = {},
  excludes: readonly string[] = [],
): Promise<void> {
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal === undefined ? [] : [options.signal])]);
  await assertSafeTarArchive(path, { ...options, signal });
  await assertExtractionDirectory(destination, signal);
  await runBoundedProcess([
    "tar", "-x", "-o", "-z", "-f", path, "-C", destination,
    ...excludes.flatMap((pattern): string[] => ["--exclude", pattern]),
  ], { signal });
}
