import { describe, expect, it } from "bun:test";
import { requestBaseUrl } from "../../src/lib/utils";
import { refreshTrustedClientIpHeaders } from "../../src/lib/client-ip";

// Issue #576: generated links prefer PUBLIC_URL, then proxy headers, then
// the connection address. PUBLIC_URL is read at module load, so these run
// only when it is unset (the default in test and fresh installs).
const publicUrlSet = typeof process.env["PUBLIC_URL"] === "string" && process.env["PUBLIC_URL"] !== "";

// Issue #648: forwarded-host trust is peer-gated. Tests that need a trusted
// proxy configure loopback trust, then restore the empty default.
async function withTrustedProxyCidrs(cidrs: string, fn: () => void): Promise<void> {
  const previous = process.env["TERRENCE_TRUSTED_PROXY_CIDRS"];
  process.env["TERRENCE_TRUSTED_PROXY_CIDRS"] = cidrs;
  await refreshTrustedClientIpHeaders();
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env["TERRENCE_TRUSTED_PROXY_CIDRS"];
    else process.env["TERRENCE_TRUSTED_PROXY_CIDRS"] = previous;
    await refreshTrustedClientIpHeaders();
  }
}

describe("request base URL resolution (#576, #648)", () => {
  const req = (url: string, headers?: Record<string, string>, peerAddress?: string | null) => ({
    url,
    ...(headers === undefined
      ? {}
      : { headers: { get: (name: string): string | null => headers[name.toLowerCase()] ?? null } }),
    ...(peerAddress === undefined ? {} : { peerAddress }),
  });

  it("uses X-Forwarded-Host and Proto from a trusted proxy peer", async () => {
    if (publicUrlSet) return;
    await withTrustedProxyCidrs("127.0.0.0/8", (): void => {
      expect(requestBaseUrl(req("http://terrence:3000/x", {
        "x-forwarded-host": "terraform.example.com",
        "x-forwarded-proto": "https",
      }, "127.0.0.1"))).toBe("https://terraform.example.com");
    });
  });

  it("ignores X-Forwarded-Host from an untrusted peer", async () => {
    if (publicUrlSet) return;
    await withTrustedProxyCidrs("10.0.0.0/8", (): void => {
      // Peer is outside the trusted range: fall back to the origin.
      expect(requestBaseUrl(req("http://terrence:3000/x", {
        "x-forwarded-host": "terraform.example.com",
        "x-forwarded-proto": "https",
      }, "192.0.2.1"))).toBe("http://terrence:3000");
      // No peer known (background callers, tests): same fallback.
      expect(requestBaseUrl(req("http://terrence:3000/x", {
        "x-forwarded-host": "terraform.example.com",
        "x-forwarded-proto": "https",
      }))).toBe("http://terrence:3000");
    });
  });

  it("falls back to the Host header", () => {
    if (publicUrlSet) return;
    expect(requestBaseUrl(req("http://127.0.0.1:3000/x", { host: "terraform.example.com" }))).toBe(
      "http://terraform.example.com",
    );
  });

  it("honors a valid forwarded proto with Host from a trusted peer", async () => {
    if (publicUrlSet) return;
    await withTrustedProxyCidrs("127.0.0.0/8", (): void => {
      expect(requestBaseUrl(req("http://127.0.0.1:3000/x", {
        host: "terraform.example.com",
        "x-forwarded-proto": "https",
      }, "127.0.0.1"))).toBe("https://terraform.example.com");
      // Garbage proto never overrides the connection scheme.
      expect(requestBaseUrl(req("http://127.0.0.1:3000/x", {
        host: "terraform.example.com",
        "x-forwarded-proto": "gopher",
      }, "127.0.0.1"))).toBe("http://terraform.example.com");
    });
  });

  it("falls back to the connection origin with no headers", () => {
    if (publicUrlSet) return;
    expect(requestBaseUrl(req("http://terrence:3000/x"))).toBe("http://terrence:3000");
  });

  it("rejects header-injection garbage", async () => {
    if (publicUrlSet) return;
    await withTrustedProxyCidrs("127.0.0.0/8", (): void => {
      expect(requestBaseUrl(req("http://terrence:3000/x", {
        "x-forwarded-host": "evil.example.com\r\nX-Injected: 1",
        "x-forwarded-proto": "https",
      }, "127.0.0.1"))).toBe("http://terrence:3000");
    });
  });
});
