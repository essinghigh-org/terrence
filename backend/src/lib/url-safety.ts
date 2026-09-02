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
const DEFAULT_USER_AGENT = "Terrence";

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

/** True when an IPv4 host is inside a CIDR (e.g. "10.0.0.0/24"). */
/** @lintignore Intentional surface: outbound allowlist CIDR policy. */
export function isIPv4InCidr(host: string, cidr: string): boolean {
  try {
    const slash = cidr.indexOf("/");
    if (slash === -1) return host === cidr;
    const base = cidr.slice(0, slash);
    const bits = parseInt(cidr.slice(slash + 1), 10);
    if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
    const baseParts = base.split(".");
    const hostParts = host.split(".");
    if (baseParts.length !== 4 || hostParts.length !== 4) return false;
    const toNum = (p: string[]): number => p.reduce((a, v) => (a << 8) | parseInt(v, 10), 0) >>> 0;
    const mask = bits === 0 ? 0 : (~0 >>> (32 - bits)) << (32 - bits) >>> 0;
    return (toNum(hostParts) & mask) === (toNum(baseParts) & mask);
  } catch { return false; }
}

type OutboundAllowlist = Readonly<{ hosts: readonly string[]; cidrs: readonly string[] }>;

function readOutboundAllowlist(): OutboundAllowlist {
  return {
    hosts: (process.env.TERRENCE_OUTBOUND_ALLOW_HOSTS ?? "")
      .split(",").map((value): string => value.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean),
    // CIDR entries are deliberately IPv4-only; IPv6 private destinations fail closed.
    cidrs: (process.env.TERRENCE_OUTBOUND_ALLOW_CIDRS ?? "")
      .split(",").map((value): string => value.trim()).filter(Boolean),
  };
}

function allowlistAllows(hostname: string, addresses: readonly string[], allowlist: OutboundAllowlist): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (allowlist.hosts.some((allowed): boolean => host === allowed || host.endsWith(`.${allowed}`))) return true;
  return allowlist.cidrs.some((cidr): boolean => [hostname, ...addresses].some((address): boolean => isIPv4InCidr(address, cidr)));
}

/** Private destinations explicitly allowed by the operator's egress policy. */
export function outboundAllowlistAllows(hostname: string, addresses: readonly string[] = []): boolean {
  return allowlistAllows(hostname, addresses, readOutboundAllowlist());
}

function expandHextets(parts: readonly string[]): string[] | null {
  if (parts.length === 2) {
    const headPart = parts[0] ?? "";
    const tailPart = parts[1] ?? "";
    const head = headPart === "" ? [] : headPart.split(":");
    const tail = tailPart === "" ? [] : tailPart.split(":");
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    return [...head, ...Array<string>(missing).fill("0"), ...tail];
  }
  const body = parts[0] ?? "";
  const hextets = body === "" ? [] : body.split(":");
  if (hextets.length !== 8) return null;
  return hextets;
}

function isEmbeddedIpv4Private(hextets: readonly string[]): boolean | null {
  const tail = hextets.slice(-2);
  const last = tail[1] ?? "";
  if (!last.includes(".")) return null;
  if (!hextets.slice(0, -1).every((h): boolean => V6_HEXTET.test(h))) return true;
  const n = v4ToNumber(last.split("."));
  if (n === null) return true;
  return isPrivateV4(n);
}

function isSpecialV6Private(hextets: readonly string[]): boolean {
  if (hextets.every((h): boolean => h === "0")) return true;
  if (hextets.slice(0, 7).every((h): boolean => h === "0") && (hextets[7] ?? "") === "1") return true;
  const firstHextet = Number.parseInt(hextets[0] ?? "0", 16);
  if ((firstHextet & 0xfe00) === 0xfc00) return true;
  if ((firstHextet & 0xffc0) === 0xfe80) return true;
  if ((firstHextet & 0xff00) === 0xff00) return true;
  return false;
}

function isPrivateV6(host: string): boolean {
  const hextets = expandHextets(host.toLowerCase().split("::"));
  if (hextets === null) return true;
  const embedded = isEmbeddedIpv4Private(hextets);
  if (embedded !== null) return embedded;
  if (!hextets.every((h): boolean => V6_HEXTET.test(h))) return true;
  if (isSpecialV6Private(hextets)) return true;
  const tail = hextets.slice(-2);
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
function normalizeHost(hostname: string): string {
  let host = hostname;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

function isBareNumericPrivate(host: string): boolean {
  if (!/^\d+$/.test(host)) return false;
  const n = Number(host);
  return Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff && isPrivateV4(n >>> 0);
}

function isQuadPrivate(host: string): boolean {
  const quad = host.split(".");
  if (quad.length !== 4) return false;
  const n = v4ToNumber(quad);
  return n !== null && isPrivateV4(n);
}

export function privateHostReason(hostname: string): string | null {
  if (hostname === "") return null;
  const host = normalizeHost(hostname);
  if (host.includes(":")) return isPrivateV6(host) ? PRIVATE_MSG : null;
  if (host.toLowerCase() === "localhost") return PRIVATE_MSG;
  if (isQuadPrivate(host)) return PRIVATE_MSG;
  if (host.split(".").length === 1 && isBareNumericPrivate(host)) return PRIVATE_MSG;
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
  return ips.some(privateAddress) ? PRIVATE_MSG : null;
}

function privateAddress(ip: string): boolean {
  if (ip.includes(":")) return isPrivateV6(ip);
  const n = v4ToNumber(ip.split("."));
  return n !== null && isPrivateV4(n);
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
function parseExternalUrl(url: string): URL | string {
  try {
    return new URL(url);
  } catch {
    return "Invalid URL";
  }
}

function validateExternalProtocol(parsed: Readonly<URL>): string | null {
  if (!["http:", "https:"].includes(parsed.protocol)) return "Only http and https URLs are allowed";
  if (parsed.username !== "" || parsed.password !== "") return "URLs with embedded credentials (user:password@host) are not allowed";
  return null;
}

async function resolveExternalAddresses(hostname: string, resolve: HostResolver): Promise<readonly string[] | string> {
  try {
    return isIP(hostname) === 0 ? await resolveWithTimeout(hostname, resolve) : [hostname];
  } catch {
    return "URL could not be resolved safely";
  }
}

function checkLiteralPrivate(hostname: string, allowPrivate: boolean, allowlist: ReturnType<typeof readOutboundAllowlist>): string | null {
  const literalReason = privateHostReason(hostname);
  const cleanHostname = hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && literalReason !== null && !allowlistAllows(cleanHostname, [cleanHostname], allowlist)) return literalReason;
  return null;
}

function checkResolvedPrivate(hostname: string, addresses: readonly string[], allowPrivate: boolean, allowlist: ReturnType<typeof readOutboundAllowlist>): string | null {
  if (allowPrivate) return null;
  const hasPrivate = addresses.some((candidate): boolean => privateAddress(candidate) && !allowlistAllows(hostname, [candidate], allowlist));
  return hasPrivate ? PRIVATE_MSG : null;
}

export async function resolveExternalUrl(
  url: string,
  allowPrivate = false,
  resolve: HostResolver = async (hostname): Promise<readonly string[]> =>
    (await lookup(hostname, { all: true, verbatim: true })).map((entry): string => entry.address),
): Promise<{ error: string } | { target: ResolvedExternalUrl }> {
  const parsedOrError = parseExternalUrl(url);
  if (typeof parsedOrError === "string") return { error: parsedOrError };
  const parsed = parsedOrError;
  const protocolError = validateExternalProtocol(parsed);
  if (protocolError !== null) return { error: protocolError };
  const allowlist = readOutboundAllowlist();
  const cleanHostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const literalError = checkLiteralPrivate(parsed.hostname, allowPrivate, allowlist);
  if (literalError !== null) return { error: literalError };
  // Tests may inject a transport for deterministic fake provider hosts. Keep
  // syntax and credential checks above, but avoid depending on public DNS.
  if (process.env.NODE_ENV === "test" && externalUrlTransportForTests !== undefined) {
    return { target: { address: "127.0.0.1", url: parsed.toString() } };
  }
  const addressesOrError = await resolveExternalAddresses(cleanHostname, resolve);
  if (typeof addressesOrError === "string") return { error: addressesOrError };
  const addresses = addressesOrError;
  const addressError = resolvedAddressesError(addresses, true);
  if (addressError !== null) return { error: addressError };
  const privateError = checkResolvedPrivate(cleanHostname, addresses, allowPrivate, allowlist);
  if (privateError !== null) return { error: privateError };
  const address = addresses[0];
  if (address === undefined) return { error: "URL could not be resolved safely" };
  return { target: { address, url: parsed.toString() } };
}

export type ExternalRequestInit = Readonly<{
  method: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes?: number;
}>;

export type ExternalUrlTransportForTests = (target: ResolvedExternalUrl, init: ExternalRequestInit) => Promise<Response>;
let externalUrlTransportForTests: ExternalUrlTransportForTests | undefined;

/** Test-only transport override; the default always uses the pinned Node transport. */
export function setExternalUrlTransportForTests(transport: ExternalUrlTransportForTests | undefined): void {
  if (process.env.NODE_ENV !== "test") throw new Error("setExternalUrlTransportForTests is test-only");
  externalUrlTransportForTests = transport;
}

function pinnedRequestOptions(target: ResolvedExternalUrl, init: ExternalRequestInit): Readonly<{
  secure: boolean;
  options: http.RequestOptions & { servername?: string | undefined };
}> {
  const url = new URL(target.url);
  const secure = url.protocol === "https:";
  const defaultPort = secure ? 443 : 80;
  const port = url.port === "" ? defaultPort : Number(url.port);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const hostHeader = `${hostname.includes(":") ? `[${hostname}]` : hostname}${port === defaultPort ? "" : `:${port}`}`;
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("User-Agent", DEFAULT_USER_AGENT);
  headers.set("Host", hostHeader);
  headers.set("Accept-Encoding", "identity");
  if (init.body !== undefined) headers.set("Content-Length", String(Buffer.byteLength(init.body)));
  return {
    secure,
    options: {
      protocol: url.protocol,
      hostname: target.address,
      port,
      path: `${url.pathname}${url.search}`,
      method: init.method,
      headers: Object.fromEntries(headers),
      servername: secure && isIP(hostname) === 0 ? hostname : undefined,
      // Defense-in-depth with the resolveExternalUrl userinfo rejection:
      // credentials must arrive as explicit headers, not URL components.
      auth: undefined,
      signal: AbortSignal.timeout(init.timeoutMs),
    },
  };
}

/** HTTP(S) request pinned to the validated address. Redirects are not followed. */
export async function fetchResolvedExternalUrl(target: ResolvedExternalUrl, init: ExternalRequestInit): Promise<Response> {
  if (process.env.NODE_ENV === "test" && externalUrlTransportForTests !== undefined) return externalUrlTransportForTests(target, init);
  return new Promise((resolvePromise, rejectPromise): void => {
    const { secure, options } = pinnedRequestOptions(target, init);
    const request = (secure ? https : http).request(
      options,
      // Node stream callbacks expose mutable transport objects by design.
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
      (response: http.IncomingMessage): void => {
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

/** HTTP(S) request that resolves after headers and streams the body. */
export async function fetchResolvedExternalUrlStream(target: ResolvedExternalUrl, init: ExternalRequestInit): Promise<Response> {
  if (process.env.NODE_ENV === "test" && externalUrlTransportForTests !== undefined) return externalUrlTransportForTests(target, init);
  return new Promise((resolvePromise, rejectPromise): void => {
    const { secure, options } = pinnedRequestOptions(target, init);
    let responseStarted = false;
    let failResponseStream: ((error: Readonly<Error>) => void) | undefined;
    const request = (secure ? https : http).request(
      options,
      // Node stream callbacks expose mutable transport objects by design.
      // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
      (response: http.IncomingMessage): void => {
      responseStarted = true;
      let total = 0;
      let closed = false;
      const maxBytes = init.maxResponseBytes ?? 1024 * 1024;
      const declaredLength = Number(response.headers["content-length"]);
      const stream = new ReadableStream<Uint8Array>({
        start(controller): void {
          failResponseStream = (error: Readonly<Error>): void => {
            if (closed) return;
            closed = true;
            controller.error(error);
          };
          if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            closed = true;
            response.destroy();
            request.destroy();
            controller.error(new Error(`Response exceeds ${maxBytes} byte limit`));
            return;
          }
          // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
          response.on("data", (chunk: Uint8Array): void => {
            if (closed) return;
            total += chunk.length;
            if (total > maxBytes) {
              closed = true;
              response.destroy();
              request.destroy();
              controller.error(new Error(`Response exceeds ${maxBytes} byte limit`));
              return;
            }
            controller.enqueue(chunk);
            if (controller.desiredSize !== null && controller.desiredSize <= 0) response.pause();
          });
          response.on("end", (): void => {
            if (closed) return;
            closed = true;
            controller.close();
          });
          response.on("error", (error: Readonly<Error>): void => {
            failResponseStream?.(error);
          });
          response.on("close", (): void => {
            if (closed || response.complete || response.readableEnded) return;
            failResponseStream?.(new Error("External response closed before completing"));
          });
        },
        pull(): void {
          if (!closed) response.resume();
        },
        cancel(reason: unknown): void {
          closed = true;
          response.destroy(reason instanceof Error ? reason : undefined);
          request.destroy();
        },
      });
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        for (const entry of Array.isArray(value) ? value : [value]) {
          if (entry !== undefined) responseHeaders.append(name, entry);
        }
      }
      resolvePromise(new Response(stream, {
        status: response.statusCode ?? 502,
        headers: responseHeaders,
      }));
    });
    request.on("error", (error: Readonly<Error>): void => {
      if (!responseStarted) rejectPromise(error);
      else failResponseStream?.(error);
    });
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}
