import { describe, expect, it } from "bun:test";
import { authenticatedRateLimitKey, rememberRateLimitPrincipal } from "../../src/auth";

describe("authenticatedRateLimitKey", () => {
  it("returns undefined when no principal was stored", () => {
    const request = {};
    expect(authenticatedRateLimitKey(request)).toBeUndefined();
  });

  it("returns user principal string", () => {
    const request = {};
    rememberRateLimitPrincipal(request, {
      id: "tok-1",
      token: "shhh",
      userId: "user-1",
      teamId: null,
      orgId: null,
      expiresAt: null,
      lastUsedAt: null,
    });
    expect(authenticatedRateLimitKey(request)).toBe("user:user-1");
  });

  it("returns team principal string", () => {
    const request = {};
    rememberRateLimitPrincipal(request, {
      id: "tok-2",
      token: "shhh",
      userId: null,
      teamId: "team-2",
      orgId: null,
      expiresAt: null,
      lastUsedAt: null,
    });
    expect(authenticatedRateLimitKey(request)).toBe("team:team-2");
  });

  it("returns organization principal string", () => {
    const request = {};
    rememberRateLimitPrincipal(request, {
      id: "tok-3",
      token: "shhh",
      userId: null,
      teamId: null,
      orgId: "org-3",
      expiresAt: null,
      lastUsedAt: null,
    });
    expect(authenticatedRateLimitKey(request)).toBe("organization:org-3");
  });

  it("returns undefined when token has no principal fields", () => {
    const request = {};
    rememberRateLimitPrincipal(request, {
      id: "tok-4",
      token: "shhh",
      userId: null,
      teamId: null,
      orgId: null,
      expiresAt: null,
      lastUsedAt: null,
    });
    expect(authenticatedRateLimitKey(request)).toBeUndefined();
  });

  it("isolates requests with a WeakMap", () => {
    const a = {};
    const b = {};
    rememberRateLimitPrincipal(a, {
      id: "tok-a",
      token: "shhh",
      userId: "user-a",
      teamId: null,
      orgId: null,
      expiresAt: null,
      lastUsedAt: null,
    });
    rememberRateLimitPrincipal(b, {
      id: "tok-b",
      token: "shhh",
      userId: null,
      teamId: "team-b",
      orgId: null,
      expiresAt: null,
      lastUsedAt: null,
    });
    expect(authenticatedRateLimitKey(a)).toBe("user:user-a");
    expect(authenticatedRateLimitKey(b)).toBe("team:team-b");
  });
});
