import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startStaticServer, type TestServer } from "./helpers/server";

let server: TestServer;

describe("public asset URLs in built HTML", () => {
  beforeAll(async (): Promise<void> => {
    server = await startStaticServer();
  });

  afterAll(async (): Promise<void> => {
    await server?.close();
  });

  test("all icon, manifest, stylesheet and script links in dist/index.html return HTTP 200", async (): Promise<void> => {
    const distDir = join(import.meta.dir, "../../dist");
    const indexHtml = readFileSync(join(distDir, "index.html"), "utf8");

    // Extract all href and src URLs
    const urlMatches = Array.from(indexHtml.matchAll(/(?:href|src)="([^"]+)"/g)).map((m) => m[1]);
    expect(urlMatches.length).toBeGreaterThan(0);

    for (const rawUrl of urlMatches) {
      if (typeof rawUrl !== "string") continue;
      // Normalize relative path
      const urlPath = rawUrl.replace(/^\.\//, "/");
      const res = await fetch(`${server.baseUrl}${urlPath}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBeTruthy();
    }
  });

  test("standard root /favicon.svg, /manifest.webmanifest, and /icons/ return HTTP 200", async (): Promise<void> => {
    const publicPaths = [
      "/favicon.svg",
      "/manifest.webmanifest",
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/apple-touch-icon.png",
    ];

    for (const path of publicPaths) {
      const res = await fetch(`${server.baseUrl}${path}`);
      expect(res.status).toBe(200);
    }
  });
});
