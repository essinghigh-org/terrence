import { isAbsolute, normalize, resolve, sep } from "path";

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

/** Member names of a .tar.gz archive, or null when it cannot be listed. */
export async function listArchiveMembers(archivePath: string): Promise<Set<string> | null> {
  try {
    const proc = Bun.spawn(["tar", "-tzf", archivePath], { stdout: "pipe", stderr: "ignore" });
    const [exited, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (exited !== 0) return null;
    const members = new Set<string>();
    for (const line of stdout.split("\n")) {
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
 * configuration: the directory itself or anything beneath it. */
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
export function archiveContainsWorkingDir(members: ReadonlySet<string>, workingDirectory: string): boolean {
  const dir = workingDirectory.replace(/^\/+/, "").replace(/\/+$/, "");
  if (dir === "") return true;
  for (const member of members) {
    const normalized = normalizeArchiveMember(member);
    if (normalized === dir || normalized.startsWith(dir + "/")) return true;
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
