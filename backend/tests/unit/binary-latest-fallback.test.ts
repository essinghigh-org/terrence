import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// Kanban 6.9: "latest" version discovery must never fall back to hard-coded
// versions that go stale. The resolver runs in a fresh `bun -e` subprocess
// with an isolated STORAGE_DIR so module-level caches (version-cache file,
// BINARY_BASE_DIR) are deterministic.
let dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "terrence-latest-fallback-"));
  dirs.push(dir);
  return dir;
}

afterEach(async (): Promise<void> => {
  await Promise.all(dirs.map((dir): Promise<void> => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

const script = `
const { mkdir, writeFile } = await import("node:fs/promises");
const { join } = await import("node:path");
const { resolveLatestVersion } = await import("./src/binaryManager.ts");

const out = {};

// Upstream unreachable, nothing cached or installed: explicit failure, never
// a silently ancient version.
globalThis.fetch = async () => { throw new Error("network down"); };
try {
  await resolveLatestVersion("tofu");
  out.explicitFailure = false;
} catch (error) {
  out.explicitFailure = String(error.message).includes("no cached or installed version");
}

// Upstream unreachable, installed binary present: last-known-good on disk wins.
const installedDir = join(process.env.TERRENCE_BINARY_CACHE_DIR, "tofu", "1.9.3");
await mkdir(installedDir, { recursive: true });
await writeFile(join(installedDir, "tofu"), "x");
out.installedFallback = (await resolveLatestVersion("tofu")) === "1.9.3";

// Upstream reachable: remote tag wins as before.
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ tag_name: "v1.8.1" }),
});
out.remoteWins = (await resolveLatestVersion("tofu")) === "1.8.1";

console.log(JSON.stringify(out));
`;

test("latest-version resolution falls back to last-known-good, never hard-coded (kanban 6.9)", async () => {
  const dir = await tempDir();
  const result = Bun.spawnSync([Bun.which("bun")!, "-e", script], {
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...process.env as Record<string, string>,
      STORAGE_DIR: join(dir, "storage"),
      TERRENCE_BINARY_CACHE_DIR: join(dir, "binaries"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  expect(result.exitCode).toBe(0);
  const verdict = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  for (const [key, value] of Object.entries(verdict)) {
    expect(value, key).toBe(true);
  }
  // The fallback path logs expected warnings to stderr; surface them only
  // when a verdict failed so debugging output is still available.
  if (stderr !== "" && Object.values(verdict).some((value): boolean => value !== true)) {
    throw new Error(`subprocess stderr: ${stderr.slice(0, 1000)}`);
  }
});