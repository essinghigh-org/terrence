import { isAbsolute, normalize, resolve, sep } from "path";

export const MAX_ARCHIVE_METADATA_BYTES = 4 * 1024 * 1024;
export const ARCHIVE_LIST_TIMEOUT_MS = 5_000;

/** Bound tar/subprocess stdout so malformed archives cannot make the API
 * buffer unbounded data. Kills and reaps the process when the byte cap or
 * the deadline is exceeded; null on any failure. Moved here from the
 * workspaces route so archive listing shares the same bounds. */
export async function readBoundedProcessOutput(process: Readonly<{
  exited: Promise<number>;
  stdout: Readonly<ReadableStream<Uint8Array>>;
  kill: (exitCode?: number | NodeJS.Signals) => void;
}>, maxBytes: number, timeoutMs: number): Promise<string | null> {
  const read = async (): Promise<string | null> => {
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let output = "";
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > maxBytes) {
          process.kill("SIGKILL");
          return null;
        }
        output += decoder.decode(result.value, { stream: true });
      }
      output += decoder.decode();
      return await process.exited === 0 ? output : null;
    } finally {
      reader.releaseLock();
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const readPromise = read();
  const timeoutPromise = new Promise<null>((resolve): void => {
    timer = setTimeout((): void => {
      process.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([readPromise, timeoutPromise]);
    if (result === null) {
      process.kill("SIGKILL");
      await Promise.allSettled([readPromise, process.exited]);
    }
    return result;
  } catch {
    process.kill("SIGKILL");
    await Promise.allSettled([readPromise, process.exited]);
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function normalizeWorkingDirectory(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.includes("\0") || value.includes("\\")) {
    throw new Error("working-directory must be a relative path");
  }

  const normalized = normalize(value);
  if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error("working-directory must be a relative path");
  }
  return normalized === "." ? null : normalized;
}

export function workspaceExecutionDirectory(root: string, value: unknown): string {
  const base = resolve(root);
  const target = resolve(base, normalizeWorkingDirectory(value) ?? ".");
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error("working-directory must stay inside the configuration");
  }
  return target;
}

/** Indexes of trigger-pattern entries that can never match: non-strings
 * and blank strings. Bun.Glob itself never rejects a string (unrecognized
 * syntax matches literally), so anything well-typed stays accepted; use the
 * trigger preview to check a pattern against real file lists instead. */
export function invalidTriggerPatternIndexes(patterns: readonly unknown[]): number[] {
  const invalid: number[] = [];
  for (const [index, pattern] of patterns.entries()) {
    if (typeof pattern !== "string" || pattern.trim() === "") invalid.push(index);
  }
  return invalid;
}

/** Indexes of trigger-prefix entries that are not usable path strings. */
export function invalidTriggerPrefixIndexes(prefixes: readonly unknown[]): number[] {
  const invalid: number[] = [];
  for (const [index, prefix] of prefixes.entries()) {
    if (typeof prefix !== "string" || prefix.trim() === "") invalid.push(index);
  }
  return invalid;
}

/** Member names of a .tar.gz archive, or null when it cannot be listed.
 * Output and runtime are bounded (CodeRabbit review): a hostile archive
 * cannot make trigger-preview or save-time validation buffer unbounded
 * tar output or hang the request. */
export async function listArchiveMembers(archivePath: string): Promise<Set<string> | null> {
  try {
    const listing = await readBoundedProcessOutput(
      Bun.spawn(["tar", "-tzf", archivePath], { stdout: "pipe", stderr: "ignore" }),
      MAX_ARCHIVE_METADATA_BYTES,
      ARCHIVE_LIST_TIMEOUT_MS,
    );
    if (listing === null) return null;
    const members = new Set<string>();
    for (const line of listing.split("\n")) {
      const trimmed = line.trim();
      if (trimmed !== "") members.add(trimmed);
    }
    return members;
  } catch {
    return null;
  }
}

function normalizeArchiveMember(member: string): string {
  return member.replace(/^\.\//, "").replace(/\/+$/, "");
}

/** True when a normalized working directory matches something inside the
 * configuration: a directory entry itself or anything beneath it. An exact
 * match against a regular file does NOT count (CodeRabbit review): tar
 * lists directories with a trailing slash, so a slash-less exact match is
 * a file the worker could not `readdir`. */
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
export function archiveContainsWorkingDir(members: ReadonlySet<string>, workingDirectory: string): boolean {
  const dir = workingDirectory.replace(/^\/+/, "").replace(/\/+$/, "");
  if (dir === "") return true;
  for (const member of members) {
    const stripped = member.replace(/^\.\//, "");
    const normalized = stripped.replace(/\/+$/, "");
    if (normalized === dir) {
      if (stripped.endsWith("/")) return true;
      continue;
    }
    if (normalized.startsWith(dir + "/")) return true;
  }
  return false;
}

/** Distinct top-level names for save-time messages, capped. */
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
export function summarizeTopLevelEntries(members: ReadonlySet<string>, limit = 10): string[] {
  const tops: string[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    const top = normalizeArchiveMember(member).split("/")[0] ?? "";
    if (top === "" || seen.has(top)) continue;
    seen.add(top);
    tops.push(top);
    if (tops.length >= limit) break;
  }
  return tops;
}
