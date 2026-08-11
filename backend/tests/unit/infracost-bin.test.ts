import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInfracostBinary } from "../../src/lib/infracost-bin";

async function withScratch(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "terrence-infracost-bin-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const OLD_BINARY = process.env.INFRACOST_BINARY;
const OLD_VERSION = process.env.INFRACOST_VERSION;

function restoreEnv(): void {
  if (OLD_BINARY === undefined) delete process.env.INFRACOST_BINARY;
  else process.env.INFRACOST_BINARY = OLD_BINARY;
  if (OLD_VERSION === undefined) delete process.env.INFRACOST_VERSION;
  else process.env.INFRACOST_VERSION = OLD_VERSION;
}

test("honours an explicit INFRACOST_BINARY override without touching the network", async () => {
  await withScratch(async (dir) => {
    const fake = join(dir, "fake-infracost");
    await writeFile(fake, "#!/bin/sh\n", { mode: 0o755 });
    process.env.INFRACOST_BINARY = fake;
    process.env.STORAGE_DIR = join(dir, "storage");
    process.env.TERRENCE_BINARY_CACHE_DIR = join(dir, "storage", "binaries");
    try {
      const resolved = await resolveInfracostBinary();
      expect(resolved?.binaryPath).toBe(fake);
      expect(resolved?.version).toBe("override");
    } finally {
      restoreEnv();
    }
  });
});

test("returns null for an invalid INFRACOST_VERSION without attempting a download", async () => {
  await withScratch(async (dir) => {
    delete process.env.INFRACOST_BINARY;
    process.env.INFRACOST_VERSION = "not-a-version";
    process.env.STORAGE_DIR = join(dir, "storage");
    process.env.TERRENCE_BINARY_CACHE_DIR = join(dir, "storage", "binaries");
    try {
      expect(await resolveInfracostBinary()).toBeNull();
    } finally {
      restoreEnv();
    }
  });
});

test("returns null when the managed binary cannot be downloaded (unreachable version)", async () => {
  await withScratch(async (dir) => {
    delete process.env.INFRACOST_BINARY;
    // A version that has never been published -> upstream 404 -> graceful null.
    process.env.INFRACOST_VERSION = "9.9.9";
    process.env.STORAGE_DIR = join(dir, "storage");
    process.env.TERRENCE_BINARY_CACHE_DIR = join(dir, "storage", "binaries");
    try {
      const resolved = await resolveInfracostBinary();
      expect(resolved).toBeNull();
    } finally {
      restoreEnv();
    }
  });
});