import { describe, expect, it } from "bun:test";
import { resolveBitbucketNextUrl } from "../../src/lib/webhooks";

describe("Bitbucket pagination URL validation", () => {
  const baseUrl = "https://api.bitbucket.org/2.0/repositories/example/repo/diffstat/abc?pagelen=100";

  it("accepts a next page on the configured Bitbucket origin", () => {
    const next = "https://api.bitbucket.org/2.0/repositories/example/repo/diffstat/abc?page=2&pagelen=100";
    expect(resolveBitbucketNextUrl({ next }, baseUrl)).toBe(next);
  });

  it("stops pagination when the provider returns a cross-origin next URL", () => {
    expect(resolveBitbucketNextUrl({ next: "https://attacker.example/steal" }, baseUrl)).toBeUndefined();
  });

  it("stops pagination for malformed next values", () => {
    expect(resolveBitbucketNextUrl({ next: 42 }, baseUrl)).toBeUndefined();
    expect(resolveBitbucketNextUrl({ next: "" }, baseUrl)).toBeNull();
  });
});
