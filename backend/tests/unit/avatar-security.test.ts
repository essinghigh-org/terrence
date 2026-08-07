import { describe, expect, it } from "bun:test";
import {
  AvatarService,
  avatarCacheKey,
  isPrivateIp,
  isPrivateIpv4,
  isPrivateIpv6,
} from "../../src/lib/avatars";

describe("avatarCacheKey", (): void => {
  it("is a stable 64-hex SHA-256 the server can recompute (no reversible URL)", (): void => {
    const keyA = avatarCacheKey("vcs", "https://gitlab.example.com/uploads/avatar/1.png");
    const keyB = avatarCacheKey("vcs", "https://gitlab.example.com/uploads/avatar/1.png");
    expect(keyA).toBe(keyB);
    expect(keyA).toMatch(/^[0-9a-f]{64}$/);
    // The key is opaque: a changed URL must not be recoverable, only different.
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

describe("private-range detection (SSRF)", (): void => {
  it("rejects loopback / RFC1918 / link-local / CGNAT IPv4", (): void => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"]) {
      expect(isPrivateIp(ip)).toBeTrue();
    }
  });

  it("allows public IPv4", (): void => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "140.82.112.5"]) {
      expect(isPrivateIp(ip)).toBeFalse();
    }
  });

  it("rejects IPv6 loopback / link-local / ULA and allows public v6", (): void => {
    expect(isPrivateIp("::1")).toBeTrue();
    expect(isPrivateIp("fe80::1")).toBeTrue();
    expect(isPrivateIp("fd00::1")).toBeTrue();
    expect(isPrivateIp("fc00::1")).toBeTrue();
    expect(isPrivateIp("2606:4700:4700::1111")).toBeFalse();
  });

  it("classifies IPv4-mapped addresses by their embedded IPv4", (): void => {
    expect(isPrivateIp("::ffff:10.0.0.1")).toBeTrue();
    expect(isPrivateIp("::ffff:8.8.8.8")).toBeFalse();
  });

  it("exports consistent helpers", (): void => {
    expect(isPrivateIpv4("127.0.0.1")).toBeTrue();
    expect(isPrivateIpv6("::1")).toBeTrue();
  });
});