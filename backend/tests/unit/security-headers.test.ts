import { describe, expect, it } from "bun:test";
import { staticCacheControl, staticMimeFor, buildContentSecurityPolicy } from "../../src/lib/security-headers";

describe("buildContentSecurityPolicy", (): void => {
  it("includes the default avatar CDNs and a strict script-src by default", (): void => {
    const previous = process.env.TERRENCE_CSP_IMG_SRC;
    delete process.env.TERRENCE_CSP_IMG_SRC;
    try {
      const csp = buildContentSecurityPolicy();
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("https://avatars.githubusercontent.com");
      expect(csp).toContain("https://www.gravatar.com");
      expect(csp).not.toContain("https://ghe.example.com");
    } finally {
      restore(previous);
    }
  });

  it("appends TERRENCE_CSP_IMG_SRC origins to img-src without a rebuild", (): void => {
    const previous = process.env.TERRENCE_CSP_IMG_SRC;
    process.env.TERRENCE_CSP_IMG_SRC = "https://ghe.example.com, https://gitlab.example.com";
    try {
      const csp = buildContentSecurityPolicy();
      expect(csp).toContain("img-src 'self' data: https://www.gravatar.com https://secure.gravatar.com https://avatars.githubusercontent.com https://ghe.example.com https://gitlab.example.com");
      expect(csp).toContain("script-src 'self'");
    } finally {
      restore(previous);
    }
  });

  function restore(value: string | undefined): void {
    if (value === undefined) delete process.env.TERRENCE_CSP_IMG_SRC;
    else process.env.TERRENCE_CSP_IMG_SRC = value;
  }
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