import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  isVersionCacheFresh,
  loadVersionCacheFile,
  saveVersionCacheFile,
  type VersionCacheEntry,
} from "../../src/lib/version-cache";

describe("version cache persistence (kanban 6.10)", () => {
  let dir = "";
  let file = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "terrence-vc-"));
    file = join(dir, "version-cache.json");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads an empty cache for a missing file", () => {
    expect(loadVersionCacheFile(join(dir, "nope.json"))).toEqual({});
  });

  it("round-trips a saved entry", () => {
    const entry: VersionCacheEntry = { versions: ["1.9.0", "1.8.4"], fetchedAt: Date.now() };
    saveVersionCacheFile(file, "tofu", entry);
    const loaded = loadVersionCacheFile(file);
    expect(loaded.tofu).toEqual(entry);
  });

  it("preserves other tools' entries when saving one tool", () => {
    saveVersionCacheFile(file, "terraform", { versions: ["1.8.5"], fetchedAt: Date.now() });
    const loaded = loadVersionCacheFile(file);
    expect(loaded.tofu?.versions).toEqual(["1.9.0", "1.8.4"]);
    expect(loaded.terraform?.versions).toEqual(["1.8.5"]);
  });

  it("drops structurally corrupted entries but keeps valid ones", () => {
    writeFileSync(file, JSON.stringify({
      tofu: { versions: "not-an-array", fetchedAt: 123 },
      terraform: { versions: ["1.8.5"], fetchedAt: Date.now() },
    }));
    const loaded = loadVersionCacheFile(file);
    expect(loaded.tofu).toBeUndefined();
    expect(loaded.terraform?.versions).toEqual(["1.8.5"]);
  });

  it("degrades to an empty cache for unparseable content", () => {
    writeFileSync(file, "{ not json");
    expect(loadVersionCacheFile(file)).toEqual({});
    expect(existsSync(file)).toBe(true);
  });

  it("judges freshness by ttl window", () => {
    const now = 1_000_000;
    expect(isVersionCacheFresh({ versions: [], fetchedAt: now - 1000 }, 60_000, now)).toBe(true);
    expect(isVersionCacheFresh({ versions: [], fetchedAt: now - 120_000 }, 60_000, now)).toBe(false);
    expect(isVersionCacheFresh(undefined, 60_000, now)).toBe(false);
    expect(isVersionCacheFresh({ versions: [], fetchedAt: Number.NaN }, 60_000, now)).toBe(false);
  });
});