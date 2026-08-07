import { describe, expect, it } from "bun:test";
import {
  AvatarService,
  avatarCacheKey,
  isLiteralIpv4,
  isLiteralIpv6,
  isNonPublicAddress,
  isNonPublicIpv4,
  isNonPublicIpv6,
} from "../../src/lib/avatars";

describe("avatarCacheKey", (): void => {
  it("is a stable 64-hex SHA-256 the server can recompute (no reversible URL)", (): void => {
    const keyA = avatarCacheKey("vcs", "https://gitlab.example.com/uploads/avatar/1.png");
    const keyB = avatarCacheKey("vcs", "https://gitlab.example.com/uploads/avatar/1.png");
    expect(keyA).toBe(keyB);
    expect(keyA).toMatch(/^[0-9a-f]{64}$/);
    expect(avatarCacheKey("vcs", "https://gitlab.example.com/uploads/avatar/2.png")).not.toBe(keyA);
  });

  it("differs across provider ids for the same URL", (): void => {
    const url = "https://example.com/a.png";
    expect(avatarCacheKey("user-gravatar", url)).not.toBe(avatarCacheKey("vcs", url));
  });
});

describe("AvatarService.resolveUrl", (): void => {
  it("returns a same-origin opaque URL for http(s) avatars", (): void => {
    const resolved = AvatarService.resolveUrl("vcs", "https://avatars.githubusercontent.com/u/42?v=4");
    expect(resolved).toMatch(/^\/api\/v2\/avatars\/[0-9a-f]{64}$/);
  });

  it("rejects non-http(s) and malformed URLs (no SSRF via scheme)", (): void => {
    expect(AvatarService.resolveUrl("vcs", "file:///etc/passwd")).toBeNull();
    expect(AvatarService.resolveUrl("vcs", "ftp://example.com/a.png")).toBeNull();
    expect(AvatarService.resolveUrl("vcs", "not a url")).toBeNull();
    expect(AvatarService.resolveUrl("vcs", null)).toBeNull();
  });
});

describe("AvatarService.resolveVcsUrl", (): void => {
  const url = "https://gitlab.example.com/uploads/avatar/1.png";

  it("binds the cache key to the integration provider id", (): void => {
    const bound = AvatarService.resolveVcsUrl("vcs:oc-123", url);
    expect(bound).toMatch(/^\/api\/v2\/avatars\/[0-9a-f]{64}$/);
    const key = bound!.replace("/api/v2/avatars/", "");
    expect(key).toBe(AvatarService.cacheKey("vcs:oc-123", url));
    expect(key).not.toBe(AvatarService.cacheKey("vcs", url));
  });

  it("binds the GitHub App provider id", (): void => {
    const bound = AvatarService.resolveVcsUrl("github-app", url);
    const key = bound!.replace("/api/v2/avatars/", "");
    expect(key).toBe(AvatarService.cacheKey("github-app", url));
  });

  it("falls back to the strict unbound provider when no key is given", (): void => {
    const bound = AvatarService.resolveVcsUrl(null, url);
    const key = bound!.replace("/api/v2/avatars/", "");
    expect(key).toBe(AvatarService.cacheKey("vcs", url));
  });

  it("rejects non-http(s) URLs even when bound", (): void => {
    expect(AvatarService.resolveVcsUrl("vcs:oc-123", "file:///etc/passwd")).toBeNull();
  });
});

describe("address classification (SSRF)", (): void => {
  it("rejects loopback / RFC1918 / link-local / CGNAT / metadata IPv4", (): void => {
    for (const ip of ["127.0.0.1", "127.0.0.0", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"]) {
      expect(isNonPublicIpv4(ip)).toBeTrue();
    }
  });

  it("rejects IPv4 multicast 224.0.0.0/4 and reserved/broadcast", (): void => {
    for (const ip of ["224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255"]) {
      expect(isNonPublicIpv4(ip)).toBeTrue();
    }
  });

  it("allows public IPv4", (): void => {
      for (const ip of ["8.8.8.8", "1.1.1.1", "140.82.112.5"]) {
        expect(isNonPublicIpv4(ip)).toBeFalse();
      }
    });

  it("rejects IPv6 loopback, ULA, and multicast ff00::/8", (): void => {
    expect(isNonPublicIpv6("::1")).toBeTrue();
    expect(isNonPublicIpv6("fc00::1")).toBeTrue();
    expect(isNonPublicIpv6("fd12:3456::1")).toBeTrue();
    expect(isNonPublicIpv6("ff00::1")).toBeTrue();
    expect(isNonPublicIpv6("ff02::1")).toBeTrue();
  });

  it("rejects IPv6 link-local fe80::/10 (fe80-febf, not just the fe80 prefix)", (): void => {
    expect(isNonPublicIpv6("fe80::1")).toBeTrue();
    expect(isNonPublicIpv6("fe9f::1")).toBeTrue();   // top hextet 0xfe9f still /10
    expect(isNonPublicIpv6("febf::1")).toBeTrue();   // top of fe80::/10
    // fec0:: (site-local, legacy) is above the /10 boundary — not link-local.
    expect(isNonPublicIpv6("fec0::1")).toBeFalse();
  });

  it("allows public IPv6", (): void => {
    expect(isNonPublicIpv6("2606:4700:4700::1111")).toBeFalse();
    expect(isNonPublicIpv6("2001:4860:4860::8888")).toBeFalse();
  });

  it("classifies IPv4-mapped ::ffff:a.b.c.d by the embedded IPv4", (): void => {
    expect(isNonPublicAddress("::ffff:10.0.0.1")).toBeTrue();
    expect(isNonPublicAddress("::ffff:169.254.169.254")).toBeTrue();
    expect(isNonPublicAddress("::ffff:8.8.8.8")).toBeFalse();
  });

  it("isNonPublicAddress handles plain v4 and v6", (): void => {
    expect(isNonPublicAddress("127.0.0.1")).toBeTrue();
    expect(isNonPublicAddress("224.0.0.1")).toBeTrue();
    expect(isNonPublicAddress("::1")).toBeTrue();
    expect(isNonPublicAddress("8.8.8.8")).toBeFalse();
  });

  it("detects literal IPs separately from hostnames", (): void => {
    expect(isLiteralIpv4("8.8.8.8")).toBeTrue();
    expect(isLiteralIpv4("300.1.1.1")).toBeFalse(); // invalid octet
    expect(isLiteralIpv4("example.com")).toBeFalse();
    expect(isLiteralIpv6("::1")).toBeTrue();
    expect(isLiteralIpv6("2001:db8::1")).toBeTrue();
    expect(isLiteralIpv6("example.com")).toBeFalse();
  });
});