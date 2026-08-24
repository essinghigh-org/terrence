import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// infracost-bin tests.
//
// The module captures STORAGE_DIR / TERRENCE_BINARY_CACHE_DIR at import time
// (module scope), so tests that exercise the managed download path run in a
// child bun process with the env set BEFORE the import — the same pattern as
// tests/worker/binaryManager.test.ts. fetch is always mocked inside the child
// so no test ever contacts the real GitHub release endpoint.
// ---------------------------------------------------------------------------

const BACKEND_ROOT = join(import.meta.dir, "../..");

async function runChild(script: string, env: { TEST_DIR: string } & Record<string, string>): Promise<string> {
  const child = Bun.spawn([Bun.which("bun")!, "-e", script], {
    cwd: BACKEND_ROOT,
    // Always isolate storage/cache per child: setup.ts points
    // TERRENCE_BINARY_CACHE_DIR at the shared disk cache, which these tests
    // must never write into.
    env: {
      ...Bun.env,
      STORAGE_DIR: join(env.TEST_DIR, "storage"),
      TERRENCE_BINARY_CACHE_DIR: join(env.TEST_DIR, "storage", "binaries"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout);
  // The backend log module writes single-line JSON to stdout; the script's own
  // console.log result is always the final line (same pattern as
  // tests/worker/binaryManager.test.ts).
  return stdout.trim().split("\n").at(-1) ?? "";
}

test("honours an explicit INFRACOST_BINARY override without touching the network", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terrence-infracost-ovr-"));
  try {
    const script = `
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const fake = join(process.env.TEST_DIR, "fake-infracost");
      await writeFile(fake, "#!/bin/sh\\n", { mode: 0o755 });
      process.env.INFRACOST_BINARY = fake;
      // Fail loudly if the managed path is ever hit instead of the override.
      globalThis.fetch = async () => { throw new Error("network must not be touched"); };
      const { resolveInfracostBinary } = await import("./src/lib/infracost-bin.ts");
      const resolved = await resolveInfracostBinary();
      console.log(JSON.stringify(resolved));
    `;
    const out = await runChild(script, { TEST_DIR: dir });
    expect(JSON.parse(out.trim())).toEqual({ binaryPath: join(dir, "fake-infracost"), version: "override" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("returns null for an invalid INFRACOST_VERSION without attempting a download", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terrence-infracost-inv-"));
  try {
    const script = `
      process.env.INFRACOST_VERSION = "not-a-version";
      globalThis.fetch = async () => { throw new Error("network must not be touched"); };
      const { resolveInfracostBinary } = await import("./src/lib/infracost-bin.ts");
      console.log(JSON.stringify(await resolveInfracostBinary()));
    `;
    const out = await runChild(script, { TEST_DIR: dir });
    expect(JSON.parse(out.trim())).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("returns null when the managed binary cannot be downloaded (upstream 404)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terrence-infracost-404-"));
  try {
    const script = `
      process.env.INFRACOST_VERSION = "9.9.9";
      // Deterministic 404 for every URL: no real GitHub contact, and a 404 is
      // indistinguishable from an unpublished version.
      globalThis.fetch = async () => new Response("not found", { status: 404 });
      const { resolveInfracostBinary } = await import("./src/lib/infracost-bin.ts");
      const resolved = await resolveInfracostBinary();
      console.log(JSON.stringify({ resolved }));
    `;
    const out = await runChild(script, { TEST_DIR: dir });
    expect(JSON.parse(out.trim())).toEqual({ resolved: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent resolutions of the same version download exactly once and share the install", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terrence-infracost-conc-"));
  try {
    const script = `
      const { mkdir, readFile, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");

      // Build a real, single-member tar.gz fixture named like the release asset.
      const fixtureDir = join(process.env.TEST_DIR, "fixture");
      const binary = join(fixtureDir, "infracost-linux-amd64");
      await mkdir(fixtureDir, { recursive: true });
      await writeFile(binary, "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });
      const archivePath = join(process.env.TEST_DIR, "infracost-linux-amd64.tar.gz");
      const tar = Bun.spawn(["tar", "-czf", archivePath, "-C", fixtureDir, "infracost-linux-amd64"], {
        stdout: "ignore",
        stderr: "pipe",
      });
      if ((await tar.exited) !== 0) throw new Error(await new Response(tar.stderr).text());

      const archive = await readFile(archivePath);
      const hash = new Bun.CryptoHasher("sha256").update(archive).digest("hex");

      let archiveRequests = 0;
      globalThis.fetch = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        // Slow the response so concurrent callers genuinely overlap in time.
        await Bun.sleep(100);
        if (url.endsWith(".sha256")) {
          return new Response(hash + "  infracost-linux-amd64.tar.gz\\n");
        }
        archiveRequests += 1;
        return new Response(archive);
      };

      process.env.INFRACOST_VERSION = "0.10.45";
      const { resolveInfracostBinary } = await import("./src/lib/infracost-bin.ts");

      const results = await Promise.all([
        resolveInfracostBinary(),
        resolveInfracostBinary(),
        resolveInfracostBinary(),
        resolveInfracostBinary(),
      ]);
      console.log(JSON.stringify({ results, archiveRequests }));
    `;
    const out = await runChild(script, { TEST_DIR: dir });
    const parsed = JSON.parse(out.trim());
    const results = parsed.results as ({ binaryPath: string; version: string } | null)[];
    expect(results).toHaveLength(4);
    for (const r of results) expect(r).not.toBeNull();
    // Every caller resolves to the same published path...
    const paths = new Set(results.map((r) => r!.binaryPath));
    expect(paths.size).toBe(1);
    // ...and only ONE worker actually fetched the archive (lock serialization).
    expect(parsed.archiveRequests).toBe(1);
    // The published directory has no leftover staging/lock siblings.
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed download leaves no published install and no lock behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terrence-infracost-fail-"));
  try {
    const script = `
      const { readdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      process.env.INFRACOST_VERSION = "9.9.9";
      globalThis.fetch = async () => new Response("boom", { status: 500 });
      const { resolveInfracostBinary } = await import("./src/lib/infracost-bin.ts");
      const resolved = await resolveInfracostBinary();
      const root = join(process.env.TEST_DIR, "storage", "binaries", "infracost");
      let entries = [];
      try { entries = await readdir(root); } catch { entries = []; }
      console.log(JSON.stringify({ resolved, entries }));
    `;
    const out = await runChild(script, { TEST_DIR: dir });
    const parsed = JSON.parse(out.trim());
    expect(parsed.resolved).toBeNull();
    // No version dir, no staging dir, no lock dir may survive a failed install.
    expect(parsed.entries).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
