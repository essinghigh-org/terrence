import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// opa-bin tests (issue #596).
//
// The module captures STORAGE_DIR / TERRENCE_BINARY_CACHE_DIR at import time
// (module scope), so tests that exercise the managed download path run in a
// child bun process with the env set BEFORE the import — the same pattern as
// tests/unit/infracost-bin.test.ts. fetch is always mocked inside the child
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
  // tests/unit/infracost-bin.test.ts).
  return stdout.trim().split("\n").at(-1) ?? "";
}

const PLATFORM_SNIPPET = `
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const asset = "opa_" + os + "_" + arch;
`;

test("returns null for an invalid OPA_VERSION without attempting a download", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terrence-opa-inv-"));
  try {
    const script = `
      process.env.OPA_VERSION = "not-a-version";
      globalThis.fetch = async () => { throw new Error("network must not be touched"); };
      const { resolveManagedOpaBinary } = await import("./src/lib/opa-bin.ts");
      console.log(JSON.stringify(await resolveManagedOpaBinary()));
    `;
    const out = await runChild(script, { TEST_DIR: dir });
    expect(JSON.parse(out.trim())).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("returns null when the managed binary cannot be downloaded (upstream 404)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terrence-opa-404-"));
  try {
    const script = `
      process.env.OPA_VERSION = "9.9.9";
      // Deterministic 404 for every URL: no real GitHub contact, and a 404 is
      // indistinguishable from an unpublished version.
      globalThis.fetch = async () => new Response("not found", { status: 404 });
      const { resolveManagedOpaBinary } = await import("./src/lib/opa-bin.ts");
      const resolved = await resolveManagedOpaBinary();
      console.log(JSON.stringify({ resolved }));
    `;
    const out = await runChild(script, { TEST_DIR: dir });
    expect(JSON.parse(out.trim())).toEqual({ resolved: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloads, verifies, installs, and reuses the managed OPA binary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terrence-opa-ok-"));
  try {
    const script = `
      const { stat, readFile, readdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      ${PLATFORM_SNIPPET}
      const payload = new TextEncoder().encode("#!/bin/sh\\nexit 0\\n");
      const hash = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
      const sums = hash + "  " + asset + "\\n" + "00".repeat(32) + "  " + asset + ".sha256\\n";
      globalThis.fetch = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith(".sha256")) return new Response(sums);
        return new Response(payload);
      };
      const { resolveManagedOpaBinary } = await import("./src/lib/opa-bin.ts");
      const first = await resolveManagedOpaBinary();
      if (first === null) throw new Error("expected a resolved binary");
      // The published binary is executable and integrity-pinned.
      const mode = (await stat(first.binaryPath)).mode;
      const integrity = JSON.parse(await readFile(join(first.binaryPath, "..", ".integrity.json"), "utf8"));
      const root = join(process.env.TEST_DIR, "storage", "binaries", "opa");
      const entries = await readdir(root);
      // Second resolution must hit the cache without touching the network.
      globalThis.fetch = async () => { throw new Error("network must not be touched"); };
      const second = await resolveManagedOpaBinary();
      console.log(JSON.stringify({ first, executable: (mode & 0o111) !== 0, integrity, entries, second }));
    `;
    const out = await runChild(script, { TEST_DIR: dir });
    const parsed = JSON.parse(out.trim());
    expect(parsed.first.version).toBe("1.20.2");
    expect(parsed.first.binaryPath).toBe(join(dir, "storage", "binaries", "opa", "1.20.2", "opa"));
    expect(parsed.executable).toBe(true);
    expect(parsed.integrity).toEqual({
      tool: "opa",
      version: "1.20.2",
      binarySha256: parsed.integrity.binarySha256,
    });
    expect(/^[0-9a-f]{64}$/.test(parsed.integrity.binarySha256)).toBe(true);
    // Published version dir only: no staging or lock siblings survive.
    expect(parsed.entries).toEqual(["1.20.2"]);
    expect(parsed.second).toEqual(parsed.first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses a binary whose digest does not match checksums.txt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terrence-opa-mismatch-"));
  try {
    const script = `
      const { readdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      ${PLATFORM_SNIPPET}
      const payload = new TextEncoder().encode("tampered");
      const sums = "ff".repeat(32) + "  " + asset + "\\n";
      globalThis.fetch = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith(".sha256")) return new Response(sums);
        return new Response(payload);
      };
      process.env.OPA_VERSION = "1.2.3";
      const { resolveManagedOpaBinary } = await import("./src/lib/opa-bin.ts");
      const resolved = await resolveManagedOpaBinary();
      const root = join(process.env.TEST_DIR, "storage", "binaries", "opa");
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

test("refuses a checksum sidecar naming a different file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terrence-opa-wrongfile-"));
  try {
    const script = `
      ${PLATFORM_SNIPPET}
      const payload = new TextEncoder().encode("#!/bin/sh\\nexit 0\\n");
      const hash = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
      // Correct hash, but for some other artifact: proves nothing about ours.
      const sums = hash + "  some-other-file\\n";
      globalThis.fetch = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith(".sha256")) return new Response(sums);
        return new Response(payload);
      };
      process.env.OPA_VERSION = "1.2.3";
      const { resolveManagedOpaBinary } = await import("./src/lib/opa-bin.ts");
      console.log(JSON.stringify(await resolveManagedOpaBinary()));
    `;
    const out = await runChild(script, { TEST_DIR: dir });
    expect(JSON.parse(out.trim())).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed download leaves no published install and no lock behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "terrence-opa-fail-"));
  try {
    const script = `
      const { readdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      process.env.OPA_VERSION = "9.9.9";
      globalThis.fetch = async () => new Response("boom", { status: 500 });
      const { resolveManagedOpaBinary } = await import("./src/lib/opa-bin.ts");
      const resolved = await resolveManagedOpaBinary();
      const root = join(process.env.TEST_DIR, "storage", "binaries", "opa");
      let entries = [];
      try { entries = await readdir(root); } catch { entries = []; }
      console.log(JSON.stringify({ resolved, entries }));
    `;
    const out = await runChild(script, { TEST_DIR: dir });
    const parsed = JSON.parse(out.trim());
    expect(parsed.resolved).toBeNull();
    expect(parsed.entries).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
