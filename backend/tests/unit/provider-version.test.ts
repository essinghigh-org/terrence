import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import {
  fetchLatestTfeProviderVersion,
  getLatestTfeProviderVersion,
} from "../../src/lib/provider-version";

// Latest-release lookup for the tfe provider (provider-surface freshness).
// The GitHub fetch is stubbed; the disk cache is redirected to a temp file
// via TERRENCE_VERSION_CACHE_FILE so real storage stays untouched.

const originalFetch = globalThis.fetch;
const originalCacheFile = process.env["TERRENCE_VERSION_CACHE_FILE"];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(handler: () => Promise<Response>): void {
  globalThis.fetch = mock(handler) as unknown as typeof fetch;
}

describe("provider version lookup", () => {
  let dir = "";
  let cacheFile = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "terrence-prov-ver-"));
    cacheFile = join(dir, "version-cache.json");
    process.env["TERRENCE_VERSION_CACHE_FILE"] = cacheFile;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    if (originalCacheFile === undefined) delete process.env["TERRENCE_VERSION_CACHE_FILE"];
    else process.env["TERRENCE_VERSION_CACHE_FILE"] = originalCacheFile;
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses the latest release tag from the GitHub API", async () => {
    stubFetch(async (): Promise<Response> => jsonResponse({ tag_name: "v0.80.0" }));
    expect(await fetchLatestTfeProviderVersion()).toBe("0.80.0");
  });

  it("rejects malformed tags", async () => {
    stubFetch(async (): Promise<Response> => jsonResponse({ tag_name: "not-a-version" }));
    expect(await fetchLatestTfeProviderVersion()).toBeNull();
  });

  it("returns null when the upstream call fails", async () => {
    stubFetch(async (): Promise<Response> => new Response("rate limited", { status: 403 }));
    expect(await fetchLatestTfeProviderVersion()).toBeNull();
  });

  it("caches the resolved version and short-circuits later lookups", async () => {
    let calls = 0;
    stubFetch(async (): Promise<Response> => {
      calls += 1;
      return jsonResponse({ tag_name: "v0.80.0" });
    });

    expect(await getLatestTfeProviderVersion()).toBe("0.80.0");
    expect(calls).toBe(1);
    // Second call hits the fresh on-disk cache; the network is untouched.
    expect(await getLatestTfeProviderVersion()).toBe("0.80.0");
    expect(calls).toBe(1);
  });

  it("persists a freshly cached entry for other consumers", async () => {
    stubFetch(async (): Promise<Response> => jsonResponse({ tag_name: "v0.80.0" }));
    expect(await getLatestTfeProviderVersion()).toBe("0.80.0");
    const saved = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, unknown>;
    const entry = saved["tfe-provider"] as { versions?: string[]; fetchedAt?: unknown };
    expect(Array.isArray(entry.versions)).toBe(true);
    expect(entry.versions?.[0]).toBe("0.80.0");
    expect(typeof entry.fetchedAt).toBe("number");
  });

  it("backs off repeated upstream calls after a failed lookup", async () => {
    // Clear the disk cache so the lookup actually reaches the (stubbed) network.
    rmSync(cacheFile, { force: true });
    let calls = 0;
    stubFetch(async (): Promise<Response> => {
      calls += 1;
      return new Response("rate limited", { status: 403 });
    });
    expect(await getLatestTfeProviderVersion()).toBeNull();
    expect(calls).toBe(1);
    // Within the failure backoff window the cached failure short-circuits.
    expect(await getLatestTfeProviderVersion()).toBeNull();
    expect(calls).toBe(1);
  });
});
