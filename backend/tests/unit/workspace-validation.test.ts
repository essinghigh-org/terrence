import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveContainsWorkingDir,
  invalidTriggerPatternIndexes,
  invalidTriggerPrefixIndexes,
  listArchiveMembers,
  summarizeTopLevelEntries,
} from "../../src/workspace";

// Issue #628: save-time validation for trigger entries and working dirs.
describe("invalidTriggerPatternIndexes", (): void => {
  test("accepts well-typed patterns, flags blanks and non-strings", (): void => {
    expect(invalidTriggerPatternIndexes(["**/*.tf", "terraform/**/*.tf", "exact/path"])).toEqual([]);
    // Bun.Glob never rejects a string, so odd-but-typed patterns stay
    // accepted (previewable); only blanks and non-strings fail.
    expect(invalidTriggerPatternIndexes(["[", "(unclosed"])).toEqual([]);
    expect(invalidTriggerPatternIndexes(["ok", "", "   ", 42, null])).toEqual([1, 2, 3, 4]);
  });
});

describe("invalidTriggerPrefixIndexes", (): void => {
  test("flags blanks and non-strings", (): void => {
    expect(invalidTriggerPrefixIndexes(["terraform", "modules/vpc"])).toEqual([]);
    expect(invalidTriggerPrefixIndexes(["terraform", "", 7])).toEqual([1, 2]);
  });
});

describe("archiveContainsWorkingDir", (): void => {
  const members = new Set(["./main.tf", "terraform/cluster/main.tf", "terraform/cluster/", "modules/vpc/main.tf"]);

  test("matches the directory itself or anything beneath it", (): void => {
    expect(archiveContainsWorkingDir(members, "terraform/cluster")).toBe(true);
    expect(archiveContainsWorkingDir(members, "terraform")).toBe(true);
    expect(archiveContainsWorkingDir(members, "missing")).toBe(false);
    expect(archiveContainsWorkingDir(members, "terraform/clust")).toBe(false);
    expect(archiveContainsWorkingDir(members, "")).toBe(true);
  });

  test("rejects an exact match against a regular file (CodeRabbit review)", (): void => {
    // A regular file named "terraform" with no directory entry or
    // descendants must not satisfy working-directory "terraform".
    expect(archiveContainsWorkingDir(new Set(["./main.tf", "terraform"]), "terraform")).toBe(false);
    // Directory entries (trailing slash) and descendants still count.
    expect(archiveContainsWorkingDir(new Set(["./main.tf", "terraform/"]), "terraform")).toBe(true);
    expect(archiveContainsWorkingDir(new Set(["terraform/main.tf"]), "terraform")).toBe(true);
  });
});

describe("summarizeTopLevelEntries", (): void => {
  test("lists distinct top-level names, capped", (): void => {
    const members = new Set(["./main.tf", "terraform/a.tf", "terraform/b.tf", "modules/vpc/x.tf"]);
    expect(summarizeTopLevelEntries(members)).toEqual(["main.tf", "terraform", "modules"]);
    expect(summarizeTopLevelEntries(members, 2)).toEqual(["main.tf", "terraform"]);
  });
});

describe("listArchiveMembers", (): void => {
  test("lists a real archive and reports unreadable ones as null", async (): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "terrence-ws-validate-"));
    try {
      const configDir = join(dir, "config");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(configDir, "terraform", "cluster"), { recursive: true });
      await writeFile(join(configDir, "main.tf"), "terraform {}");
      await writeFile(join(configDir, "terraform", "cluster", "main.tf"), "terraform {}");
      const archivePath = join(dir, "config.tar.gz");
      const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", configDir, "."]);
      expect(await tar.exited).toBe(0);
      const members = await listArchiveMembers(archivePath);
      expect(members === null).toBe(false);
      expect(archiveContainsWorkingDir(members ?? new Set(), "terraform/cluster")).toBe(true);
      expect(archiveContainsWorkingDir(members ?? new Set(), "elsewhere")).toBe(false);
      expect(await listArchiveMembers(join(dir, "missing.tar.gz"))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
