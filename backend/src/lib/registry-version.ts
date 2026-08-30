/** Shared registry version ordering. Registry versions are semantic versions,
 * but the fallback keeps malformed legacy rows deterministic instead of
 * allowing one bad row to make an entire response fail. */
export const MODULE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function isModuleVersion(value: string): boolean {
  const match = MODULE_SEMVER_PATTERN.exec(value);
  if (match === null) return false;
  const prerelease = match[4];
  return prerelease === undefined || prerelease.split(".").every((identifier): boolean =>
    !/^\d+$/u.test(identifier) || identifier === "0" || !identifier.startsWith("0"));
}

/** Compare in ascending semantic-version precedence, with a stable fallback. */
export function compareModuleVersions(left: string, right: string): number {
  const leftValid = isModuleVersion(left);
  const rightValid = isModuleVersion(right);
  if (leftValid && rightValid) {
    try {
      const ordered = Bun.semver.order(left, right);
      if (ordered !== 0) return ordered;
    } catch {
      // Fall through to the lexical tie-breaker for malformed runtime input.
    }
  } else if (leftValid !== rightValid) {
    return leftValid ? 1 : -1;
  }
  return left.localeCompare(right);
}

/** Sort descending: highest semantic-version precedence first. */
export function sortModuleVersionsDescending<T extends Readonly<{ version: string }>>(
  versions: readonly T[],
): T[] {
  return [...versions].sort((left, right): number => compareModuleVersions(right.version, left.version));
}

export function highestUsableModuleVersion<
  T extends Readonly<{ version: string; status: string; isRevoked?: boolean | null }>,
>(versions: readonly T[]): T | undefined {
  return sortModuleVersionsDescending(versions.filter((version): boolean =>
    version.status === "ok" && version.isRevoked !== true))[0] ?? undefined;
}
