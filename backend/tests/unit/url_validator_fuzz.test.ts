import { describe, expect, it } from "bun:test";
import { validateExternalUrl } from "../../src/lib/utils";
import { resolveExternalUrl, validateExternalUrlResolved, type HostResolver } from "../../src/lib/url-safety";

/**
 * Fuzz coverage for the outbound URL validators (review item 22.5).
 *
 * A seeded PRNG (deterministic across runs and CI hosts) generates
 * adversarial URLs from a grammar covering the review's list: IPv4 odd
 * forms, IPv6, IPv4-mapped IPv6, encoded hostnames, userinfo, plus
 * trailing dots, scheme variants and DNS-rebinding wrapper domains.
 *
 * Properties asserted on every generated URL:
 *   - validateExternalUrl never throws,
 *   - scheme-valid URLs with private/loopback literal hosts are REJECTED,
 *   - scheme-valid URLs with public literal hosts are ACCEPTED,
 *   - allowPrivate=true accepts private literals but still rejects
 *     non-http(s) schemes and unparseable URLs,
 *   - blocked results only use the documented error messages.
 */

/** mulberry32: tiny seeded PRNG, deterministic per seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRIVATE_V4 = [
  "127.0.0.1", "127.0.0.2", "127.1.2.3", "10.0.0.1", "10.255.255.255",
  "172.16.0.1", "172.31.255.255", "192.168.1.1", "192.168.254.254",
  "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.254",
  "0.0.0.0", "192.0.2.1", "198.18.0.1", "198.19.255.254", "198.51.100.7", "203.0.113.9",
  "224.0.0.1", "240.0.0.1", "255.255.255.255", "192.0.0.1",
];
const PUBLIC_V4 = [
  "8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1",
  "128.0.0.1", "11.0.0.1",
];
// Odd IPv4 forms: the WHATWG parser normalizes these to dotted quads, so
// they must be rejected like their canonical equivalents.
const ODD_V4_PRIVATE = [
  "2130706433", "0x7f000001", "0X7F000001", "0177.0.0.1", "127.1", "127.0.1",
  "127.0.0.1.", "0x0a000001", "167772161", "0xC0A80101", "0300.0250.0001.0001",
  "10.1", "192.168.1", "%31%32%37.0.0.1", "127.%30.%30.1",
];
const PRIVATE_V6 = [
  "[::1]", "[::]", "[fc00::1]", "[fd12:3456:789a::1]", "[fe80::1]",
  "[ff02::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:10.0.0.1]",
  "[::ffff:a00:1]", "[::7f00:1]",
];
const PUBLIC_V6 = [
  "[2001:4860:4860::8888]", "[2606:4700::1111]", "[2607:f8b0:4005:808::200e]",
  "[2a00:1450:4001:82f::200e]", "[2600::1]",
];
const LOCALHOST = ["localhost", "localhost.", "LOCALHOST", "%6c%6f%63%61%6c%68%6f%73%74"];
// DNS-rebinding wrappers: resolve to loopback/private IPs but are not IP
// literals. The sync validator cannot classify them (documented gap); the
// resolved harness (below) catches them.
const REBINDING = [
  "127.0.0.1.nip.io", "10.0.0.1.xip.io", "127.0.0.1.sslip.io",
  "localhost.nip.io", "169.254.169.254.nip.io", "0x7f000001.nip.io",
];
const PUBLIC_HOSTS = [
  "example.com", "api.github.com", "registry.terraform.io", "xn--bcher-kva.example",
  "releases.hashicorp.com", "a.b.co.uk",
];

const PRIVATE_POOLS: readonly string[][] = [PRIVATE_V4, ODD_V4_PRIVATE, PRIVATE_V6, LOCALHOST];
const PUBLIC_POOLS: readonly string[][] = [PUBLIC_V4, PUBLIC_V6, PUBLIC_HOSTS];

type GenUrl = {
  url: string;
  /** Expected at the sync level (scheme + literal-host classification). */
  expectBlocked: boolean;
}

function generateUrls(rand: () => number, count: number): GenUrl[] {
  const schemes = ["http", "https", "ftp", "file", "javascript", "ws", "http"];
  const paths = ["", "/", "/path/to/resource", "/%2e%2e/x?q=1#frag", "?a=b&c=d", "/:8080"];
  const userinfos = ["", "user:pass@", "admin@", "%75ser@"];
  const out: GenUrl[] = [];
  for (let i = 0; i < count; i += 1) {
    const roll = rand();
    const scheme = schemes[Math.floor(rand() * schemes.length)] ?? "http";
    const userinfo = userinfos[Math.floor(rand() * userinfos.length)] ?? "";
    const path = paths[Math.floor(rand() * paths.length)] ?? "";
    let host: string;
    let hostPrivate: boolean;
    const isPrivatePool = roll < 0.55;
    const pool = isPrivatePool
      ? (PRIVATE_POOLS[Math.floor(rand() * PRIVATE_POOLS.length)] ?? PRIVATE_V4)
      : (PUBLIC_POOLS[Math.floor(rand() * PUBLIC_POOLS.length)] ?? PUBLIC_V4);
    host = pool[Math.floor(rand() * pool.length)] ?? "example.com";
    hostPrivate = isPrivatePool;
    if (!isPrivatePool && rand() < 0.08) {
      host = REBINDING[Math.floor(rand() * REBINDING.length)] ?? "127.0.0.1.nip.io";
      hostPrivate = false; // not an IP literal; sync cannot classify
    }
    const port = rand() < 0.2 ? `:${Math.floor(rand() * 65535)}` : "";
    const schemeOk = scheme === "http" || scheme === "https";
    out.push({
      url: `${scheme}://${userinfo}${host}${port}${path}`,
      expectBlocked: !schemeOk || hostPrivate,
    });
  }
  return out;
}

describe("fuzz: outbound URL validator", () => {
  it("rejects private literals and accepts public literals across 3000 seeded URLs", (): void => {
    const rand = mulberry32(0x5eed22_5);
    const urls = generateUrls(rand, 3000);
    for (const { url, expectBlocked } of urls) {
      const result = validateExternalUrl(url);
      if (expectBlocked) {
        expect(result, `expected ${url} to be blocked`).not.toBeNull();
      } else {
        expect(result, `expected ${url} to be accepted`).toBeNull();
      }
    }
  });

  it("never throws and only uses the documented error messages", (): void => {
    const rand = mulberry32(0xdeadbeef);
    const urls = generateUrls(rand, 2000);
    const known = new Set([
      "Only http and https URLs are allowed",
      "URL points to a private or loopback address",
      "Invalid URL",
    ]);
    for (const { url } of urls) {
      const result = validateExternalUrl(url);
      expect(result === null || typeof result === "string", `unexpected result type for ${url}`).toBe(true);
      if (result !== null) expect(known.has(result), `unexpected message for ${url}: ${result}`).toBe(true);
    }
  });

  it("allowPrivate=true still rejects non-http schemes and unparseable URLs", (): void => {
    const rand = mulberry32(0x1234abcd);
    for (const { url } of generateUrls(rand, 1500)) {
      const result = validateExternalUrl(url, true);
      if (url.startsWith("http://") || url.startsWith("https://")) {
        // Private literal hosts are now allowed; only genuinely invalid
        // inputs (the URL parser rejects) stay blocked.
        expect(result, `unexpected block for ${url}`).toBeNull();
      }
    }
    expect(validateExternalUrl("ftp://example.com/", true)).toContain("http and https");
    expect(validateExternalUrl("not a url", true)).toBe("Invalid URL");
    expect(validateExternalUrl("http://", true)).toBe("Invalid URL");
  });

  it("blocks every targeted vector class from the review", (): void => {
    const vectors: string[] = [
      // IPv4 odd forms
      "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/",
      "http://127.1/", "http://127.0.0.1./",
      // IPv6
      "http://[::1]/", "http://[fc00::1]/", "http://[fe80::1]/", "http://[ff02::1]/",
      // mapped IPv4
      "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/",
      // encoded hostnames
      "http://%31%32%37.0.0.1/", "http://127.%30.%30.1/",
      "http://%6c%6f%63%61%6c%68%6f%73%74/",
      // userinfo
      "http://user:pass@127.0.0.1/", "http://admin@10.0.0.1/",
      // localhost variants
      "http://localhost/", "http://localhost./",
      // RFC1918 / link-local / CGNAT / metadata / documentation / benchmarking
      "http://10.1.2.3/", "http://172.20.0.1/", "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/", "http://100.64.0.1/",
      "http://192.0.2.1/", "http://198.18.0.1/", "http://198.19.255.254/",
      "http://198.51.100.7/", "http://203.0.113.9/",
    ];
    for (const url of vectors) {
      expect(validateExternalUrl(url), `expected ${url} to be blocked`).not.toBeNull();
    }
  });

  it("accepts genuinely public endpoints", (): void => {
    for (const url of [
      "https://example.com/", "https://8.8.8.8/dns-query",
      "https://[2001:4860:4860::8888]/", "https://user:pass@api.github.com/repos",
    ]) {
      expect(validateExternalUrl(url), `expected ${url} to be accepted`).toBeNull();
    }
  });

  it("rejects DNS rebinding answers with an injectable resolver", async (): Promise<void> => {
    // Sync validator cannot see through wrapper domains...
    expect(validateExternalUrl("http://127.0.0.1.nip.io/")).toBeNull();
    expect(validateExternalUrl("http://localhost.nip.io/")).toBeNull();

    // ...but the resolved harness re-checks per resolution, so a
    // public-then-private answer sequence (the rebinding pattern) is caught
    // on the second resolution instead of being cached as safe. Answers come
    // from an explicit ordered sequence, not call parity.
    const sequence: readonly string[][] = [["93.184.216.34"], ["127.0.0.1"]];
    let call = 0;
    const rebindingResolver: HostResolver = async (hostname: string): Promise<string[]> => {
      if (!hostname.includes("nip.io")) return [];
      const answer = sequence[Math.min(call, sequence.length - 1)] ?? [];
      call += 1;
      return answer;
    };
    expect(await validateExternalUrlResolved("http://127.0.0.1.nip.io/", false, rebindingResolver)).toBeNull();
    expect(await validateExternalUrlResolved("http://127.0.0.1.nip.io/", false, rebindingResolver)).toContain("private");

    // Wrapper resolving straight to a private address is rejected.
    const privateResolver: HostResolver = async (): Promise<string[]> => ["10.0.0.1"];
    expect(await validateExternalUrlResolved("http://127.0.0.1.nip.io/", false, privateResolver)).toContain("private");
    // A public resolution stays accepted.
    const publicResolver: HostResolver = async (): Promise<string[]> => ["93.184.216.34"];
    expect(await validateExternalUrlResolved("http://127.0.0.1.nip.io/", false, publicResolver)).toBeNull();
    // allowPrivate=true skips the resolved check too.
    expect(await validateExternalUrlResolved("http://127.0.0.1.nip.io/", true, privateResolver)).toBeNull();

    // Raw AAAA answers arrive UNCOMPRESSED; embedded private v4 must still be
    // caught after normalization (0:0:0:0:0:ffff:7f00:1 is 127.0.0.1).
    const uncompressedResolver: HostResolver = async (): Promise<string[]> => [
      "0:0:0:0:0:ffff:127.0.0.1",
      "0:0:0:0:0:ffff:7f00:1",
      "0:0:0:0:0:ffff:8.8.8.8",
    ];
    expect(await validateExternalUrlResolved("http://127.0.0.1.nip.io/", false, uncompressedResolver)).toContain("private");

    // Resolver rejection fails closed instead of being treated as safe.
    const failingResolver: HostResolver = async (): Promise<string[]> => {
      throw new Error("resolver down");
    };
    expect(await validateExternalUrlResolved("http://example.com/", false, failingResolver)).toContain("resolve");
  });

  it("returns a validated address that callers can pin without a second DNS lookup", async () => {
    let resolutions = 0;
    const result = await resolveExternalUrl("https://example.com/hook", false, async () => {
      resolutions += 1;
      return ["93.184.216.34"];
    });
    expect(result).toEqual({ target: { address: "93.184.216.34", url: "https://example.com/hook" } });
    expect(resolutions).toBe(1);

    const literal = await resolveExternalUrl("https://93.184.216.34/hook", false, async () => {
      resolutions += 1;
      return [];
    });
    expect(literal).toEqual({ target: { address: "93.184.216.34", url: "https://93.184.216.34/hook" } });
    expect(resolutions).toBe(1);

    const mixed = await resolveExternalUrl("https://example.com/hook", false, async () => ["93.184.216.34", "127.0.0.1"]);
    expect("error" in mixed ? mixed.error : "").toContain("private");
  });
});
