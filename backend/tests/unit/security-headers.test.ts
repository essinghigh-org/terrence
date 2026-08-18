import { describe, expect, it } from "bun:test";
import { staticCacheControl, staticMimeFor, buildContentSecurityPolicy } from "../../src/lib/security-headers";

describe("buildContentSecurityPolicy", (): void => {
  it("keeps img-src same-origin (avatars are proxied server-side)", (): void => {
    const csp = buildContentSecurityPolicy();
    const directives = csp.split("; ");
    expect(directives).toContain("script-src 'self'"); // exact, so a widened script-src fails
    expect(directives).toContain("base-uri 'none'");
    expect(directives).toContain("img-src 'self' data:");
    expect(csp).not.toContain("https://");
  });
});

describe("staticCacheControl", (): void => {
  it("marks hashed /assets files immutable for a year", (): void => {
    expect(staticCacheControl("/assets/index-DgdIUkJ9.css")).toBe("public, max-age=31536000, immutable");
    expect(staticCacheControl("/assets/index-Cpds-VMV.js")).toBe("public, max-age=31536000, immutable");
  });

  it("serves favicon and icons with a short-lived public cache", (): void => {
    expect(staticCacheControl("/favicon.svg")).toContain("public, max-age=86400");
    expect(staticCacheControl("/icons/icon-512.png")).toContain("public, max-age=86400");
  });

  it("revalidates the manifest (no-cache)", (): void => {
    expect(staticCacheControl("/manifest.webmanifest")).toBe("no-cache");
  });

  it("never caches the SPA HTML so deploys pick up new hashed assets", (): void => {
    expect(staticCacheControl("/")).toBe("no-cache");
    expect(staticCacheControl("/login")).toBe("no-cache");
    expect(staticCacheControl("/register")).toBe("no-cache");
    expect(staticCacheControl("/app/workspaces")).toBe("no-cache");
  });

  it("leaves API and unknown paths to the default policy", (): void => {
    expect(staticCacheControl("/api/v2/ping")).toBeUndefined();
    expect(staticCacheControl("/api/state")).toBeUndefined();
  });
});

describe("staticMimeFor", (): void => {
  it.each([
    ["/index.html", "text/html; charset=utf-8", "text/html"],
    ["/assets/index-abc.js", "text/javascript; charset=utf-8", "text/javascript"],
    ["/assets/index.css", "text/css; charset=utf-8", "text/css"],
    ["/manifest.webmanifest", "application/manifest+json; charset=utf-8", "application/manifest+json"],
    ["/favicon.svg", "image/svg+xml", "image/svg+xml"],
    ["/icons/icon-192.png", "image/png", "image/png"],
    ["/icons/apple-touch-icon.png", "image/png", "image/png"],
  ])("maps %s to %s", (_: string, expected: string, prefix: string): void => {
    expect(staticMimeFor(_)).toBe(expected);
    expect((staticMimeFor(_) ?? "").startsWith(prefix)).toBeTrue();
  });

  it("returns undefined for unknown/extension-less paths", (): void => {
    expect(staticMimeFor("/api/v2/ping")).toBeUndefined();
    expect(staticMimeFor("/manifest")).toBeUndefined();
  });
});