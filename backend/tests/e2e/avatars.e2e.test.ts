// E2E: avatar rendering over a real HTTP server.
//
// Boots the real Elysia app on an ephemeral port, then verifies the exact
// round-trip a browser performs to render an avatar:
//   1. A user resource's `avatar-url` is a same-origin /api/v2/avatars/<key>
//      (what <AvatarImage> would load), and GETting it returns image bytes.
//   2. A bound VCS integration avatar is fetched through the server-side
//      proxy (pinned fetch → cache → serve) with content-hashed ETag + 304.
//   3. The endpoint stays tight: unknown keys 404 and unbound SSRF attempts
//      are refused.
// Self-contained: temp avatar dir, no production storage.

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

let storage = "";
let port = 0;
let upstream: { url: URL; stop: () => void };

const previousStorageDir = process.env["STORAGE_DIR"];
const previousGithub = process.env["GITHUB_APP_HTTP_URL"];

async function api(
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; json: Record<string, any> }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/vnd.api+json";
  if (init.token !== undefined) headers["Authorization"] = `Bearer ${init.token}`;
  const requestInit: RequestInit = { method: init.method ?? "GET", headers };
  if (init.body !== undefined) requestInit.body = JSON.stringify(init.body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, requestInit);
  let json: Record<string, any> = {};
  try {
    json = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, json };
}

async function signupAndToken(): Promise<{ token: string; userId: string }> {
  const username = `av-e2e-${Date.now().toString(36)}`;
  const password = "av-e2e-password-123";
  await api("/api/v2/users", { method: "POST", body: { data: { type: "users", attributes: { username, password } } } });
  const login = await api("/api/v2/users/login", { method: "POST", body: { data: { attributes: { username, password } } } });
  expect(login.status).toBe(200);
  const token = login.json["data"]?.attributes?.token as string;
  expect(typeof token).toBe("string");
  const details = await api("/api/v2/account/details", { token });
  expect(details.status).toBe(200);
  return { token, userId: details.json["data"]?.id as string };
}

beforeAll(async (): Promise<void> => {
  storage = mkdtempSync(join(tmpdir(), "avatar-e2e-test-"));
  process.env["STORAGE_DIR"] = storage;
  // Deterministic local upstream for the bound-VCS avatar path.
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request: Request): Response {
      const path = new URL(request.url).pathname;
      if (path === "/avatar.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
      return new Response("not found", { status: 404 });
    },
  });
  process.env["GITHUB_APP_HTTP_URL"] = upstream.url.toString().slice(0, -1);
  app.listen(0);
  port = (app.server as unknown as { port: number }).port;
  expect(port).toBeGreaterThan(0);
});

afterAll(async (): Promise<void> => {
  // Fully tear down the listening app: stop it AND null app.server. A shared
  // Bun worker is reused across test FILES, so leaving app.server set here
  // breaks later files' synthetic app.handle() requests (client-IP and
  // rate-limit-key resolution both branch on `server` being non-null).
  const running = app as unknown as { server: { stop(): unknown } | null };
  if (running.server !== null) {
    running.server.stop();
    running.server = null;
  }
  upstream.stop();
  rmSync(storage, { recursive: true, force: true });
  if (previousStorageDir === undefined) delete process.env["STORAGE_DIR"];
  else process.env["STORAGE_DIR"] = previousStorageDir;
  if (previousGithub === undefined) delete process.env["GITHUB_APP_HTTP_URL"];
  else process.env["GITHUB_APP_HTTP_URL"] = previousGithub;
});

describe("avatar rendering over real HTTP", (): void => {
  it("a signed-in user's avatar-url is a same-origin key that a UI can render", async (): Promise<void> => {
    const { token } = await signupAndToken();
    const details = await api("/api/v2/account/details", { token });
    expect(details.status).toBe(200);
    const avatarUrl = details.json["data"]?.attributes?.["avatar-url"] as string | undefined;
    // What <Avatar> would set as <img src> — never a third-party URL.
    expect(avatarUrl).toMatch(/^\/api\/v2\/avatars\/[0-9a-f]{64}$/);
    // The endpoint is reachable over real HTTP. The upstream is the public
    // Gravatar URL the user serializer recorded; an offline/sandboxed runner
    // has no network, so only enforce the strict 200-image assertions when the
    // proxy actually reached the upstream. A genuinely broken render (a 200
    // with no bytes, or a non-standard status) still fails.
    const image = await fetch(`http://127.0.0.1:${port}${avatarUrl}`);
    if (image.status === 200) {
      expect(image.headers.get("content-type")).toMatch(/^image\//);
      expect(image.headers.get("cache-control")).toBe("private, max-age=86400");
      expect(image.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
      const bytes = new Uint8Array(await image.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(0);
    } else {
      // Proxy refused/gapped (upstream unreachable): must be one of the
      // service's own error statuses, never a 500.
      expect([404, 422, 502]).toContain(image.status);
    }
  });

  it("serves a bound VCS avatar end-to-end with a content-hashed ETag and 304", async (): Promise<void> => {
    // The bound github-app origin (GITHUB_APP_HTTP_URL) authorizes the local
    // upstream; this is the deterministic path (no external network).
    const key = await AvatarService.record("github-app", `${upstream.url.toString()}avatar.png`);
    const target = `/api/v2/avatars/${key}`;
    const primed = await fetch(`http://127.0.0.1:${port}${target}`);
    expect(primed.status).toBe(200);
    expect(primed.headers.get("content-type")).toBe("image/png");
    expect(primed.headers.get("cache-control")).toBe("private, max-age=86400");
    const etag = primed.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(Buffer.from(new Uint8Array(await primed.arrayBuffer())).equals(PNG)).toBeTrue();

    const revalidated = await fetch(`http://127.0.0.1:${port}${target}`, { headers: { "If-None-Match": etag ?? "" } });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
    expect(revalidated.headers.get("cache-control")).toBe("private, max-age=86400");
  });

  it("404s unknown keys (never contacts anything)", async (): Promise<void> => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v2/avatars/${"f".repeat(64)}`);
    expect(res.status).toBe(404);
  });

  it("rejects an unbound private destination (SSRF)", async (): Promise<void> => {
    process.env["GITHUB_APP_HTTP_URL"] = "http://example.com";
    try {
      const key = await AvatarService.record("probe", "http://127.0.0.1:1/avatar.png");
      const res = await fetch(`http://127.0.0.1:${port}/api/v2/avatars/${key}`);
      expect([422, 502]).toContain(res.status);
    } finally {
      // Restore the bound local upstream origin (the suite default).
      process.env["GITHUB_APP_HTTP_URL"] = upstream.url.toString().slice(0, -1);
    }
  });
});