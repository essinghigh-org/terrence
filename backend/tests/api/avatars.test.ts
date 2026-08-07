import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "../../src/app";
import { AvatarService } from "../../src/lib/avatars";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let storage: string;
let origin: string;
let server: { url: URL; stop: () => void };

const previousStorageDir = process.env.STORAGE_DIR;
const previousGithubAppHttpUrl = process.env.GITHUB_APP_HTTP_URL;

beforeAll(async (): Promise<void> => {
  storage = mkdtempSync(join(tmpdir(), "avatar-test-"));
  process.env.STORAGE_DIR = storage;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request: Request): Response {
      const path = new URL(request.url).pathname;
      if (path === "/avatar.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
      if (path === "/text.txt") return new Response("not an image", { headers: { "content-type": "text/plain" } });
      if (path === "/fake.png") return new Response("not real image bytes", { headers: { "content-type": "image/png" } });
      return new Response("not found", { status: 404 });
    },
  });
  origin = server.url.toString(); // http://127.0.0.1:<port>/
});

afterAll(async (): Promise<void> => {
  server.stop();
  rmSync(storage, { recursive: true, force: true });
  if (previousStorageDir === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = previousStorageDir;
  if (previousGithubAppHttpUrl === undefined) delete process.env.GITHUB_APP_HTTP_URL;
  else process.env.GITHUB_APP_HTTP_URL = previousGithubAppHttpUrl;
});

describe("avatar proxy route", (): void => {
  it("serves a proxied avatar at its opaque key with a long cache; 404 for unknown keys", async (): Promise<void> => {
    // The bound `github-app` integration origin makes this loopback host trusted.
    process.env.GITHUB_APP_HTTP_URL = origin.slice(0, -1);
    const key = await AvatarService.record("github-app", `${origin}avatar.png`);
    const res = await app.handle(new Request(`http://t/api/v2/avatars/${key}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(res.headers.get("content-type")).toBe("image/png");
    // ETag derives from the image bytes (content hash), not the URL key.
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    expect(Buffer.from(new Uint8Array(await res.arrayBuffer())).equals(PNG)).toBeTrue();
    delete process.env.GITHUB_APP_HTTP_URL;

    // Unknown keys never fetch anything.
    const unknown = "f".repeat(64);
    const missing = await app.handle(new Request(`http://t/api/v2/avatars/${unknown}`));
    expect(missing.status).toBe(404);
  });

  it("honours 304 revalidation when the browser sends If-None-Match", async (): Promise<void> => {
    process.env.GITHUB_APP_HTTP_URL = origin.slice(0, -1);
    const key = await AvatarService.record("github-app", `${origin}avatar.png`);
    // Prime the cache, then a revalidation request with the returned ETag must
    // 304 — and the 304 must carry the cache metadata.
    const primed = await app.handle(new Request(`https://t/api/v2/avatars/${key}`));
    expect(primed.status).toBe(200);
    const etag = primed.headers.get("etag");
    expect(etag).not.toBeNull();
    const res = await app.handle(new Request(`https://t/api/v2/avatars/${key}`, {
      headers: { "If-None-Match": etag ?? "" },
    }));
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    delete process.env.GITHUB_APP_HTTP_URL;
  });

  it("refuses a non-trusted private destination (SSRF), including shape-mismatch", async (): Promise<void> => {
      // An UNBOUND provider id gets no private exception even when a GitHub App
      // origin is configured — trust is integration-scoped, never global.
      process.env.GITHUB_APP_HTTP_URL = "http://example.com";
      try {
        const key = await AvatarService.record("probe", "http://127.0.0.1:1/avatar.png");
        const res = await app.handle(new Request(`https://t/api/v2/avatars/${key}`));
        expect([422, 502]).toContain(res.status);
      } finally {
        delete process.env.GITHUB_APP_HTTP_URL;
      }
    });

    it("scopes the private exception to the matching integration origin", async (): Promise<void> => {
      process.env.GITHUB_APP_HTTP_URL = origin.slice(0, -1);
      try {
        const key = await AvatarService.record("github-app", "http://127.0.0.1:1/avatar.png");
        const res = await app.handle(new Request(`https://t/api/v2/avatars/${key}`));
        expect([422, 502]).toContain(res.status);
      } finally {
        delete process.env.GITHUB_APP_HTTP_URL;
      }
    });

  it("rejects non-image and mislabeled content from the upstream", async (): Promise<void> => {
    process.env.GITHUB_APP_HTTP_URL = origin.slice(0, -1);
    const text = await AvatarService.record("github-app", `${origin}text.txt`);
    const rText = await app.handle(new Request(`https://t/api/v2/avatars/${text}`));
    expect(rText.status).toBe(415);
    const fake = await AvatarService.record("github-app", `${origin}fake.png`);
    const rFake = await app.handle(new Request(`https://t/api/v2/avatars/${fake}`));
    expect(rFake.status).toBe(415);
    delete process.env.GITHUB_APP_HTTP_URL;
  });
});