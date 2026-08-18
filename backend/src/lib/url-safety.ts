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

import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
  // Normalize into the full 8-hextet sequence so embedded-IPv4 detection
  // inspects the final two hextets regardless of "::" compression. Raw DNS
  // AAAA answers arrive uncompressed ("0:0:0:0:0:ffff:127.0.0.1"), so the
  // compressed-only tail inspection would otherwise fail open.
  const parts = lower.split("::");
  let hextets: string[];
  if (parts.length === 2) {
    const headPart = parts[0] ?? "";
    const tailPart = parts[1] ?? "";
    const head = headPart === "" ? [] : headPart.split(":");
    const tail = tailPart === "" ? [] : tailPart.split(":");
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return true; // too many hextets → malformed → fail closed
    hextets = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    const body = parts[0] ?? "";
    hextets = body === "" ? [] : body.split(":");
    if (hextets.length !== 8) return true; // no compression and wrong width → fail closed
  }

  // An embedded dotted quad occupies the last hextet; validate the rest as
  // hextets and classify the quad itself. Any malformed piece → fail closed.
  const tail = hextets.slice(-2);
  const last = tail[1] ?? "";
  if (last.includes(".")) {
    if (!hextets.slice(0, -1).every((h): boolean => V6_HEXTET.test(h))) return true;
    const n = v4ToNumber(last.split("."));
    if (n === null) return true;
    return isPrivateV4(n);
  }
  if (!hextets.every((h): boolean => V6_HEXTET.test(h))) return true;

  // "::" (unspecified) and "::1" (loopback).
  if (hextets.every((h): boolean => h === "0")) return true;
  if (hextets.slice(0, 7).every((h): boolean => h === "0") && (hextets[7] ?? "") === "1") return true;

  const firstHextet = Number.parseInt(hextets[0] ?? "0", 16);
  if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((firstHextet & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  // Embedded IPv4 (IPv4-mapped ::ffff:a.b.c.d / ::ffff:xxxx, and the
  // deprecated IPv4-compatible ::a.b.c.d): the final two hextets hold the
  // address, already validated as hex above.
  const hi = Number.parseInt(tail[0] ?? "0", 16);
  const lo = Number.parseInt(tail[1] ?? "0", 16);
  const n = ((hi << 16) | lo) >>> 0;
  return isPrivateV4(n);
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
  // (non-special parsing edge) is checked defensively across the full
  // unsigned 32-bit range: 2130706433 is 127.0.0.1, not a hostname.
  if (quad.length === 1 && /^\d+$/.test(host)) {
    const n = Number(host);
    if (Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff && isPrivateV4(n >>> 0)) return PRIVATE_MSG;
  }
  return null;
}

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

/** Bound on a single external resolution so a stuck resolver cannot hang a request. */
const RESOLVE_TIMEOUT_MS = 5000;

async function resolveWithTimeout(hostname: string, resolve: HostResolver): Promise<readonly string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolve(hostname),
      new Promise<readonly string[]>((_, reject): void => {
        timer = setTimeout((): void => {
          reject(new Error("DNS resolution timed out"));
        }, RESOLVE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function resolvedAddressesError(ips: readonly string[], allowPrivate: boolean): string | null {
  if (ips.length === 0 || ips.some((ip): boolean => isIP(ip) === 0)) return "URL could not be resolved safely";
  if (allowPrivate) return null;
  for (const ip of ips) {
    if (ip.includes(":")) {
      if (isPrivateV6(ip)) return PRIVATE_MSG;
      continue;
    }
    const n = v4ToNumber(ip.split("."));
    if (n !== null && isPrivateV4(n)) return PRIVATE_MSG;
  }
  return null;
}

/**
 * Async URL validation with an injectable resolver: rejects private/loopback
 * literals synchronously (same rules as validateExternalUrl) and additionally
 * rejects hostnames whose resolved addresses are private. The resolver is
 * supplied by the caller (real DNS lookup, mock, or rebinding simulation).
 * This is the test harness surface for DNS-rebinding class hosts.
 *
 * Fail-closed contract: if resolution rejects or times out, the URL is
 * rejected (a distinct reason string) rather than treated as an empty
 * address list. Unresolvable is not provably safe.
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
    let ips: readonly string[];
    try {
      ips = await resolveWithTimeout(parsed.hostname.replace(/^\[|\]$/g, ""), resolve);
    } catch {
      return "URL could not be resolved safely";
    }
    return resolvedAddressesError(ips, false);
  }
  return null;
}

export type ResolvedExternalUrl = Readonly<{ address: string; url: string }>;

/** Resolve once, validate every answer, then return the address callers must connect to. */
export async function resolveExternalUrl(
  url: string,
  allowPrivate = false,
  resolve: HostResolver = async (hostname): Promise<readonly string[]> =>
    (await lookup(hostname, { all: true, verbatim: true })).map((entry): string => entry.address),
): Promise<{ error: string } | { target: ResolvedExternalUrl }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "Invalid URL" };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return { error: "Only http and https URLs are allowed" };
  const literalReason = privateHostReason(parsed.hostname);
  if (!allowPrivate && literalReason !== null) return { error: literalReason };

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  let addresses: readonly string[];
  try {
    addresses = isIP(hostname) === 0 ? await resolveWithTimeout(hostname, resolve) : [hostname];
  } catch {
    return { error: "URL could not be resolved safely" };
  }
  const addressError = resolvedAddressesError(addresses, allowPrivate);
  if (addressError !== null) return { error: addressError };
  const address = addresses[0];
  if (address === undefined) return { error: "URL could not be resolved safely" };
  return { target: { address, url: parsed.toString() } };
}

type ExternalRequestInit = Readonly<{
  method: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes?: number;
}>;

/** HTTP(S) request pinned to the validated address. Redirects are not followed. */
export async function fetchResolvedExternalUrl(target: ResolvedExternalUrl, init: ExternalRequestInit): Promise<Response> {
  return new Promise((resolvePromise, rejectPromise): void => {
    const { address } = target;
    const url = new URL(target.url);
    const secure = url.protocol === "https:";
    const defaultPort = secure ? 443 : 80;
    const port = url.port === "" ? defaultPort : Number(url.port);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const hostHeader = `${hostname.includes(":") ? `[${hostname}]` : hostname}${port === defaultPort ? "" : `:${port}`}`;
    const headers = new Headers(init.headers);
    headers.set("Host", hostHeader);
    headers.set("Accept-Encoding", "identity");
    if (init.body !== undefined) headers.set("Content-Length", String(Buffer.byteLength(init.body)));
    const request = (secure ? https : http).request({
      protocol: url.protocol,
      hostname: address,
      port,
      path: `${url.pathname}${url.search}`,
      method: init.method,
      headers: Object.fromEntries(headers),
      servername: secure && isIP(hostname) === 0 ? hostname : undefined,
      auth: url.username === "" ? undefined : `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
      signal: AbortSignal.timeout(init.timeoutMs),
    // Node stream callbacks expose mutable transport objects by design.
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    }, (response: http.IncomingMessage): void => {
      const chunks: Readonly<Uint8Array>[] = [];
      const maxBytes = init.maxResponseBytes ?? 1024 * 1024;
      let total = 0;
      let settled = false;
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
      response.on("data", (chunk: Uint8Array): void => {
        total += chunk.length;
        if (total > maxBytes) {
          settled = true;
          response.destroy();
          request.destroy();
          rejectPromise(new Error(`Response exceeds ${maxBytes} byte limit`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", (): void => {
        if (settled) return;
        settled = true;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          for (const entry of Array.isArray(value) ? value : [value]) {
            if (entry !== undefined) responseHeaders.append(name, entry);
          }
        }
        resolvePromise(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 502,
          headers: responseHeaders,
        }));
      });
      response.on("error", (error: Readonly<Error>): void => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      });
    });
    request.on("error", (error: Readonly<Error>): void => {
      rejectPromise(error);
    });
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}
