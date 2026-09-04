import { describe, expect, it } from "bun:test";
import { requestBaseUrl } from "../../src/lib/utils";

// Issue #576: generated links prefer PUBLIC_URL, then proxy headers, then
// the connection address. PUBLIC_URL is read at module load, so these run
// only when it is unset (the default in test and fresh installs).
const publicUrlSet = typeof process.env["PUBLIC_URL"] === "string" && process.env["PUBLIC_URL"] !== "";

describe("request base URL resolution (#576)", () => {
  const req = (url: string, headers?: Record<string, string>) => ({
    url,
    headers: headers === undefined
      ? undefined
      : { get: (name: string): string | null => headers[name.toLowerCase()] ?? null },
  });

  it("uses X-Forwarded-Host and Proto behind a proxy", () => {
    if (publicUrlSet) return;
    expect(requestBaseUrl(req("http://terrence:3000/x", {
      "x-forwarded-host": "terraform.example.com",
      "x-forwarded-proto": "https",
    }))).toBe("https://terraform.example.com");
  });

  it("falls back to the Host header", () => {
    if (publicUrlSet) return;
    expect(requestBaseUrl(req("http://127.0.0.1:3000/x", { host: "terraform.example.com" }))).toBe(
      "http://terraform.example.com",
    );
  });

  it("falls back to the connection address with no headers", () => {
    if (publicUrlSet) return;
    expect(requestBaseUrl(req("http://terrence:3000/x"))).toBe("http://terrence:3000/x");
  });

  it("rejects header-injection garbage", () => {
    if (publicUrlSet) return;
    expect(requestBaseUrl(req("http://terrence:3000/x", {
      "x-forwarded-host": "evil.example.com\r\nX-Injected: 1",
      "x-forwarded-proto": "https",
    }))).toBe("http://terrence:3000/x");
    expect(requestBaseUrl(req("http://terrence:3000/x", {
      host: "terraform.example.com",
      "x-forwarded-proto": "gopher",
    }))).toBe("http://terrence:3000/x");
  });
});
