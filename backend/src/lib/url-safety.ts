/**
 * URL host safety classification (SSRF hardening).
 *
 * The WHATWG URL parser (Bun/node) already normalizes IPv4 odd forms
 * (decimal, hex, octal, short forms), percent-encoded octets and trailing
 * dots into canonical dotted quads, so hostname checks below operate on the
 * normalized host. What the parser does NOT normalize away:
 *
 *   - IPv6 literals ("[::1]", "[::ffff:7f00:1]") — brackets retained,
 *   - "localhost." style hostnames,
 *   - DNS-rebinding wrapper domains (nip.io, xip.io, ...) — these cannot be
 *     classified without resolution and are the documented gap covered by
 *     validateExternalUrlResolved() / the fuzz harness.
 *
 * The sync path (validateExternalUrl in lib/utils.ts) rejects every
 * syntactically-classifiable private/loopback literal. The async path adds a
 * caller-supplied resolver so rebinding-class hosts can be re-checked after
 * resolution.
 */

const PRIVATE_MSG = "URL points to a private or loopback address";

const V4_OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const V6_HEXTET = /^[0-9a-f]{1,4}$/;

function v4ToNumber(parts: readonly string[]): number | null {
  if (parts.length !== 4) return null;
  for (const part of parts) {
    if (!V4_OCTET.test(part)) return null;
  }
  return ((Number(parts[0]) << 24) | (Number(parts[1]) << 16) | (Number(parts[2]) << 8) | Number(parts[3])) >>> 0;
}

/** RFC1918 + loopback + link-local + CGNAT + cloud-metadata + multicast + reserved. */
function isPrivateV4(n: number): boolean {
  if (n === 0) return true; // 0.0.0.0/8 unspecified
  if ((n >>> 24) === 127) return true; // loopback
  if ((n >>> 24) === 10) return true; // RFC1918 10/8
  if ((n >>> 20) === 0xac1 && ((n >>> 16) & 0xff) >= 0x10 && ((n >>> 16) & 0xff) <= 0x1f) return true; // 172.16/12
  if ((n >>> 16) === 0xc0a8) return true; // 192.168/16
  if ((n >>> 16) === 0xa9fe) return true; // 169.254/16 link-local (incl. cloud metadata)
  if ((n >>> 22) === 0x191) return true; // 100.64/10 CGNAT
  if ((n >>> 28) === 0xe) return true; // 224/4 multicast
  if ((n >>> 24) >= 240) return true; // 240/4 reserved + broadcast
  if ((n >>> 24) === 192 && ((n >>> 16) & 0xff) === 0 && ((n >>> 8) & 0xff) === 0) return true; // 192.0.0.0/24 reserved
  return false;
}

function isPrivateV6(host: string): boolean {
  const lower = host.toLowerCase();
  // Split on "::" (at most one compression marker).
  const parts = lower.split("::", 2);
  const head = parts[0] ?? "";
  const tailPart = parts[1];
  const before = head === "" ? [] : head.split(":");
  const after = tailPart === undefined || tailPart === "" ? [] : tailPart.split(":");

  // "::" alone = unspecified.
  if (before.length === 0 && after.length === 0) return true;
  // "::1" = loopback.
  if (before.length === 0 && after.length === 1 && (after[0] ?? "") === "1") return true;

  const first = before.length > 0 ? (before[0] ?? "") : "0";
  if (!V6_HEXTET.test(first)) return true; // malformed → treat as private (fail closed)
  const firstHextet = Number.parseInt(first, 16);
  if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((firstHextet & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  // Embedded IPv4 (IPv4-mapped ::ffff:a.b.c.d / ::ffff:xxxx, and the
  // deprecated IPv4-compatible ::a.b.c.d). The URL parser normalizes dotted
  // tails to hex, but stay defensive for both shapes.
  if (after.length >= 2) {
    const tail = after.slice(-2);
    const last = tail[tail.length - 1] ?? "";
    if (last.includes(".")) {
      const n = v4ToNumber(last.split("."));
      if (n !== null && isPrivateV4(n)) return true;
    } else if (tail.every((part): boolean => V6_HEXTET.test(part))) {
      const hi = Number.parseInt(tail[0] ?? "0", 16);
      const lo = Number.parseInt(tail[1] ?? "0", 16);
      const n = ((hi << 16) | lo) >>> 0;
      if (isPrivateV4(n)) return true;
    }
  }
  return false;
}

/**
 * Classify a URL hostname as a private/loopback literal. Returns a
 * human-readable reason string when the host is an IP literal in a reserved
 * range (or localhost), null otherwise. Non-IP hostnames (and DNS-rebinding
 * wrapper domains) return null — they need resolution, see
 * validateExternalUrlResolved().
 */
export function privateHostReason(hostname: string): string | null {
  let host = hostname;
  if (host === "") return null;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  if (host.includes(":")) {
    return isPrivateV6(host) ? PRIVATE_MSG : null;
  }
  if (host.toLowerCase() === "localhost") return PRIVATE_MSG;

  const quad = host.split(".");
  if (quad.length === 4) {
    const n = v4ToNumber(quad);
    if (n !== null && isPrivateV4(n)) return PRIVATE_MSG;
  }
  // WHATWG normalizes odd IPv4 forms to quads, but a bare numeric host
  // (non-special parsing edge) is checked defensively.
  if (quad.length === 1 && V4_OCTET.test(host)) {
    const n = Number(host);
    if (n <= 0xffffffff && isPrivateV4(n)) return PRIVATE_MSG;
  }
  return null;
}

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

/**
 * Async URL validation with an injectable resolver: rejects private/loopback
 * literals synchronously (same rules as validateExternalUrl) and additionally
 * rejects hostnames whose resolved addresses are private. The resolver is
 * supplied by the caller (real DNS lookup, mock, or rebinding simulation).
 * This is the test harness surface for DNS-rebinding class hosts.
 */
export async function validateExternalUrlResolved(
  url: string,
  allowPrivate: boolean,
  resolve: HostResolver,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return "Only http and https URLs are allowed";
  const literalReason = privateHostReason(parsed.hostname);
  if (!allowPrivate && literalReason !== null) return literalReason;
  if (!allowPrivate) {
    const ips = await resolve(parsed.hostname).catch((): readonly string[] => []);
    for (const ip of ips) {
      const ipv6 = ip.includes(":");
      const reason = ipv6
        ? isPrivateV6(ip)
        : (() => {
            const quad = ip.split(".");
            if (quad.length !== 4) return false;
            const n = v4ToNumber(quad);
            return n !== null && isPrivateV4(n);
          })();
      if (reason) return PRIVATE_MSG;
    }
  }
  return null;
}
