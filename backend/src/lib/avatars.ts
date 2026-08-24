// Same-origin avatar service (fetch + cache + serve under one abstraction).
//
// Serializers never hand the browser a remote avatar URL. They call
// AvatarService.resolveUrl(), which derives an opaque cache key server-side
// and records the upstream URL internally. The browser only ever loads
// /api/v2/avatars/<key>; the key is a SHA-256 over (provider id + canonical
// URL), so no ?url= parameter exists and an authenticated user cannot turn
// this endpoint into an arbitrary-fetch SSRF hole (unknown keys 404 without
// contacting anything).
//
// Fetch rules (OWASP SSRF guidance):
//   - http/https only, no URL credentials
//   - DNS is resolved, every returned address is classified, and the HTTP
//     connection is PINNED to a validated address while the original hostname
//     is retained for the Host header and TLS SNI/cert verification. This
//     closes the DNS-rebinding / TOCTOU gap between "validate" and "connect":
//     we never blindly `fetch(url)` after resolving (which would re-resolve).
//   - resolution/safety fails CLOSED: if we cannot look the host up safely, we
//     refuse to fetch at all.
//   - non-public networks are rejected unless the destination origin equals
//     the single VCS integration that supplied the avatar (integration-scoped
//     trust, not a global allow-list).
//   - redirects are never followed
//   - short timeout, 2 MiB response cap, image MIME + magic-byte sniffing
//   - no incoming cookies/Authorization are ever forwarded
//
// Caching: storage/avatars/<2-hex>/<key>.json (metadata) + <key>.img (bytes).
// The browser ETag is derived from SHA-256 of the cached bytes, so it changes
// when the avatar changes (not when the URL stays the same); responses use
// Cache-Control: private, max-age=86400 and 304s carry the cache metadata.
// The server revalidates upstream with If-None-Match / If-Modified-Since and
// serves a stale cached copy if the upstream is unreachable.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir, stat, unlink, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { db } from "../db";

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 6_000;
const DNS_TIMEOUT_MS = 2_500;
export const AVATAR_REVALIDATE_MS = 60 * 60 * 1000; // server considers fresh 1h
export const AVATAR_CLIENT_CACHE = "private, max-age=86400";
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;      // max total avatar disk usage
const DEFAULT_CACHE_ENTRIES = 2048;                // max entries on disk
const DEFAULT_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // drop untouched after 30d
// Throttle: sweep at most ~1 in this many successful upstream fetches.
const SWEEP_EVERY_N_FETCHES = 64;

const IMAGE_KIND_TO_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export type AvatarMeta = Readonly<{
  key: string;
  providerId: string;
  url: string;
  state: "pending" | "fetched";
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number | null;
  expiresAt: number | null;
  bytes: number | null;
  /** SHA-256 (hex) of the cached image bytes — the browser ETag source. */
  contentHash: string | null;
}>;

function avatarDir(): string {
  return resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"), "avatars");
}

const KEY_RE = /^[0-9a-f]{64}$/;

/** Refuse cache keys that could escape the avatar directory (%2e segments). */
function assertKey(key: string): string {
  if (!KEY_RE.test(key)) throw new Error("invalid avatar cache key");
  return key;
}

function metaPath(key: string): string {
  return join(avatarDir(), assertKey(key).slice(0, 2), `${key}.json`);
}

function imgPath(key: string): string {
  return join(avatarDir(), assertKey(key).slice(0, 2), `${key}.img`);
}

function hasCachedImage(key: string): boolean {
  try {
    return existsSync(imgPath(key));
  } catch {
    return false; // invalid key => nothing cached
  }
}

export function avatarCacheKey(providerId: string, url: string): string {
  return createHash("sha256").update(`${providerId}\u0000${url}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Pending-record map (solves the write race and the failed-write retry bug)
//
// `resolveUrl()` is synchronous but must not hand the browser a URL whose
// metadata hasn't been (or isn't about to be) persisted. We keep an in-memory
// map of `key -> writePromise`: resolveUrl sets it before returning, so a
// subsequent readMeta() awaits it. If the underlying write fails, the entry is
// removed so it can be retried (fixes the old "recordedKeys.add before the
// work" bug where a failed write poisoned the key forever).
// ---------------------------------------------------------------------------
const pendingWrites = new Map<string, Promise<void>>();

async function writeMeta(meta: AvatarMeta): Promise<void> {
  const dir = join(avatarDir(), meta.key.slice(0, 2));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${metaPath(meta.key)}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(meta), { mode: 0o600 });
  await rename(tmp, metaPath(meta.key));
}

function ensureRecorded(providerId: string, url: string): string {
  const key = avatarCacheKey(providerId, url);
  if (pendingWrites.has(key)) return key;
  // A sweep may have deleted the metadata; re-record in that case.
  if (existsSync(metaPath(key))) return key;
  const write = (async (): Promise<void> => {
    const meta: AvatarMeta = {
      key, providerId, url, state: "pending",
      contentType: null, etag: null, lastModified: null,
      fetchedAt: null, expiresAt: null, bytes: null, contentHash: null,
    };
    await writeMeta(meta);
  })();
  // Drop the entry once settled: failures retry it, successes free memory
  // (later calls see the persisted file).
  void write.catch(() => undefined).finally(() => pendingWrites.delete(key));
  pendingWrites.set(key, write);
  return key;
}

/** readMeta: await any in-flight record write first, then load the file. */
async function readAvatarMeta(key: string): Promise<AvatarMeta | null> {
  const pending = pendingWrites.get(key);
  if (pending !== undefined) await pending.catch(() => undefined);
  try {
    const raw = await readFile(metaPath(key), "utf8");
    const parsed = JSON.parse(raw) as Partial<AvatarMeta>;
    if (typeof parsed.key !== "string" || typeof parsed.url !== "string") return null;
    return parsed as AvatarMeta;
  } catch {
    return null;
  }
}

/** Synchronous serializer-facing: same-origin service URL or null. */
function resolveUrl(providerId: string, url: string | null | undefined): string | null {
  if (typeof url !== "string" || url === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const key = ensureRecorded(providerId, url);
  return `/api/v2/avatars/${key}`;
}

/**
 * Serializer-facing helper for VCS-provided avatars. `providerKey` is the
 * bound integration identity (`"vcs:<oauth-clients.id>"` for OAuth flows,
 * `"github-app"` for the GitHub App): the private-network exception is only
 * granted when the avatar's origin matches that integration's own origin.
 * Unknown/absent keys fall back to the strict unbound provider (no exception).
 */
function resolveVcsUrl(providerKey: string | null | undefined, url: string | null | undefined): string | null {
  return resolveUrl(typeof providerKey === "string" && providerKey !== "" ? providerKey : "vcs", url);
}

// ---------------------------------------------------------------------------
// Address classification (correct: IPv4 multicast, IPv6 link-local /10, etc.)
// ---------------------------------------------------------------------------
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_TAIL_RE = /^(?:[0-9a-f:]*)?::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

export function isLiteralIpv4(host: string): boolean {
  const m = IPV4_RE.exec(host);
  if (m === null) return false;
  return [m[1]!, m[2]!, m[3]!, m[4]!].every((o: string): boolean => Number(o) <= 255);
}

export function isLiteralIpv6(host: string): boolean {
  if (!host.includes(":")) return false;
  try {
    parseV6(host);
    return true;
  } catch {
    return false;
  }
}

/** True when an IPv4 address must never be a fetch destination (non-global). */
export function isNonPublicIpv4(ip: string): boolean {
  const m = IPV4_RE.exec(ip);
  if (m === null) return true;
  const a = Number(m[1]); const b = Number(m[2]); const c = Number(m[3]); const d = Number(m[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) return true;
  return (
    a === 0 || a === 10 || a === 127                       // unspecified, RFC1918, loopback
    || (a === 100 && b >= 64 && b <= 127)                  // CGNAT
    || (a === 169 && b === 254)                            // link-local / cloud metadata
    || (a === 172 && b >= 16 && b <= 31)                   // RFC1918
    || (a === 192 && b === 168)                            // RFC1918
    || (a === 192 && b === 0 && c === 0)                   // IETF protocol assignments
    || (a === 192 && b === 0 && c === 2)                   // TEST-NET-1
    || (a === 198 && b === 18)                             // benchmark
    || (a === 198 && b === 51 && c === 100)                // TEST-NET-2
    || (a === 203 && b === 0 && c === 113)                 // TEST-NET-3
    || (a >= 224 && a <= 239)                              // multicast 224.0.0.0/4
    || a >= 240                                            // reserved / broadcast
  );
}

/** Parse an IPv6 literal into a 128-bit bigint (throws on invalid). */
function parseV6(host: string): bigint {
  let addr = host;
  const embedded = /^(.*):(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (embedded !== null && embedded[2] !== undefined) {
    const v4 = embedded[2].split(".").map(Number);
    if (v4.some((o: number): boolean => o > 255)) throw new Error("bad v4 tail");
    const hi = ((v4[0]! << 8) | v4[1]!) & 0xffff;
    const lo = ((v4[2]! << 8) | v4[3]!) & 0xffff;
    addr = `${embedded[1]}:${hi.toString(16)}:${lo.toString(16)}`;
  }
  const hextets: string[] = [];
  if (addr.includes("::")) {
    const split = addr.split("::");
    const leftRaw = split[0] ?? "";
    const rightRaw = split[1] ?? "";
    const left = leftRaw === "" ? [] : leftRaw.split(":");
    const right = rightRaw === "" ? [] : rightRaw.split(":");
    if (left.length + right.length >= 8) throw new Error("bad length");
    for (const part of left) hextets.push(part.padStart(4, "0"));
    while (hextets.length < 8 - right.length) hextets.push("0000");
    for (const part of right) hextets.push(part.padStart(4, "0"));
  } else {
    const parts = addr.split(":");
    if (parts.length !== 8) throw new Error("bad length");
    for (const part of parts) hextets.push(part.padStart(4, "0"));
  }
  if (hextets.some((h: string): boolean => !/^[0-9a-fA-F]{4}$/.test(h))) throw new Error("bad hextet");
  return BigInt(`0x${hextets.join("")}`);
}

/** True when an IPv6 address must never be a fetch destination (non-global). */
export function isNonPublicIpv6(ip: string): boolean {
  let big: bigint;
  try {
    big = parseV6(ip);
  } catch {
    return true; // unparseable forms are conservatively refused
  }
  const topByte = Number((big >> 120n) & 0xffn);
  const group6 = Number((big >> 112n) & 0xffffn);
  if (big === 0n) return true;                                      // ::
  if (big === 1n) return true;                                      // ::1 loopback
  // ::ffff:0:0/96 (IPv4-mapped) and ::/96 (IPv4-compatible) in hex form.
  if ((big >> 32n) === 0xffffn || (big >> 32n) === 0n) {
    const v4 = Number(big & 0xffffffffn);
    return isNonPublicIpv4(
      `${(v4 >>> 24) & 0xff}.${(v4 >>> 16) & 0xff}.${(v4 >>> 8) & 0xff}.${v4 & 0xff}`,
    );
  }
  if (topByte === 0xff) return true;                              // ff00::/8 multicast
  if (group6 >= 0xfe80 && group6 <= 0xfeff) return true;          // fe80::/10 link-local + fec0::/10 site-local (deprecated)
  if (topByte === 0xfc || topByte === 0xfd) return true;          // fc00::/7 ULA
  return false;
}

/** True for any address that must not be fetched (non-global, incl. mapped). */
export function isNonPublicAddress(ip: string): boolean {
  const mapped = IPV6_TAIL_RE.exec(ip);
  if (mapped !== null && mapped[1] !== undefined) return isNonPublicIpv4(mapped[1]);
  if (!ip.includes(":")) return isNonPublicIpv4(ip);
  return isNonPublicIpv6(ip);
}

// ---------------------------------------------------------------------------
// Trusted (integration-scoped) origins
// ---------------------------------------------------------------------------
function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/**
 * The single origin a provider id may fetch without the public-only
 * restriction — and only that one. Bound to the specific VCS integration that
 * supplied the avatar, not a global allow-list, so an org-level oauth client
 * cannot authorize fetching arbitrary private hosts. `null` = no exception.
 */
async function authorizedOriginForProvider(providerId: string): Promise<string | null> {
  // Bound OAuth integration: "vcs:<oauth-clients.id>".
  const bound = /^vcs:(.+)$/.exec(providerId);
  if (bound !== null && bound[1] !== undefined) {
    try {
      const client = await db.query.oauthClients.findFirst({
        where: (table, { eq }) => eq(table.id, bound[1] ?? ""),
        columns: { httpUrl: true },
      });
      if (client !== undefined && typeof client.httpUrl === "string" && client.httpUrl !== "") {
        return originOf(client.httpUrl);
      }
    } catch {
      return null;
    }
    return null;
  }
  if (providerId === "github-app") {
    const httpUrl = process.env.GITHUB_APP_HTTP_URL;
    if (typeof httpUrl === "string" && httpUrl !== "") return originOf(httpUrl);
    return null;
  }
  return null; // "user-gravatar", unbound "vcs", etc. have NO private exception
}

// ---------------------------------------------------------------------------
// DNS + connection pinning
// ---------------------------------------------------------------------------
/** Node's WHATWG URL.hostname keeps IPv6 brackets ([::1]) — strip them. */
function unbracketHostname(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

async function resolveHost(hostname: string): Promise<string[] | null> {
  try {
    const result = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<null>((resolvePromise): void => {
        setTimeout(() => { resolvePromise(null); }, DNS_TIMEOUT_MS);
      }),
    ]);
    if (result === null) return null;
    return result.map((entry): string => entry.address);
  } catch {
    return null;
  }
}

type DestinationDecision = { error: string } | { pinned: string };

/** Returns the address to connect to, or an error (fails CLOSED on DNS). */
async function assertSafeAvatarDestination(url: string, providerId: string): Promise<DestinationDecision> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "Invalid avatar URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "Only http and https avatar URLs are allowed" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { error: "Avatar URLs must not contain credentials" };
  }

  const hostname = unbracketHostname(parsed.hostname);
  const expectedOrigin = `${parsed.protocol}//${parsed.host}`;
  const authorized = await authorizedOriginForProvider(providerId);
  const originTrusted = authorized !== null && authorized === expectedOrigin;

  if (isLiteralIpv4(hostname) || isLiteralIpv6(hostname)) {
    // Literal IP: no DNS involved, classify directly. Trusted integration
    // origins (e.g. a self-hosted GitLab on a literal private IP) pass.
    if (!originTrusted && isNonPublicAddress(hostname)) {
      return { error: "Avatar URL is a non-public address" };
    }
    return { pinned: hostname };
  }

  const resolved = await resolveHost(hostname);
  if (resolved === null) {
    // FAIL CLOSED: unsafe/unresolvable lookup => never fall through to a
    // blind fetch (the old code returned OK on null, opening a TOCTOU hole).
    return { error: "Could not safely resolve the avatar host" };
  }
  for (const address of resolved) {
    if (!originTrusted && isNonPublicAddress(address)) {
      // Reject if ANY answer is non-public: split-horizon/rebinding defense.
      return { error: "Avatar host resolves to a non-public address (loopback/private/multicast)" };
    }
  }
  return { pinned: resolved[0]! };
}

// ---------------------------------------------------------------------------
// Pinned HTTP(S) client
// ---------------------------------------------------------------------------
type RawResponse = Readonly<{
  status: number;
  headers: http.IncomingHttpHeaders;
  bytes: Buffer;
  truncated: boolean;
}>;

async function requestPinned(target: {
  scheme: "http" | "https";
  address: string;  // validated IP / literal host to connect to
  hostname: string; // original hostname (no port) for Host + TLS SNI
  port: number;
  path: string;     // pathname + search
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}): Promise<RawResponse> {
  return new Promise((resolvePromise, rejectPromise): void => {
    const { scheme, address, hostname, port, path, headers, timeoutMs, maxBytes } = target;
    const mod = scheme === "https" ? https : http;
    const connectHost = address.includes(":") ? `[${address}]` : address;
    const defaultPort = scheme === "https" ? 443 : 80;
    // Bracket based on the value being placed in the Host header (the original
    // hostname), never the connect address (which may be a resolved IPv6).
    const hostHeader = `${hostname.includes(":") ? `[${hostname}]` : hostname}${port === defaultPort ? "" : `:${port}`}`;
    const options: https.RequestOptions = {
      protocol: `${scheme}:`,
      host: connectHost,
      hostname: connectHost,
      port,
      path,
      method: "GET",
      // TLS SNI + certificate verification stay bound to the ORIGINAL hostname.
      servername: scheme === "https" ? hostname : undefined,
      headers: { ...headers, Host: hostHeader },
      signal: AbortSignal.timeout(timeoutMs),
    };
    const request = mod.request(options, (res: http.IncomingMessage): void => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      let settled = false;
      res.on("data", (chunk: Uint8Array): void => {
        total += chunk.length;
        if (total > maxBytes) {
          // Exceeded the cap: settle immediately with the 413 signal instead of
          // waiting for the socket (destroy() does not emit end/error).
          res.destroy();
          if (!settled) {
            settled = true;
            resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.alloc(0), truncated: true });
          }
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", (): void => {
        if (settled) return;
        settled = true;
        resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.concat(chunks), truncated: false });
      });
      res.on("error", (error: Error): void => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      });
    });
    request.on("error", (error: Error): void => { rejectPromise(error); });
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Fetch + cache (revalidation-aware, content-hashed ETag)
// ---------------------------------------------------------------------------
function sniffImageKind(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes);
  const head = b.slice(0, 512).toString("utf8").trimStart();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "svg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && b.slice(0, 6).toString("latin1") === "GIF87a") return "gif";
  if (b.length >= 6 && b.slice(0, 6).toString("latin1") === "GIF89a") return "gif";
  if (b.length >= 12 && b.slice(0, 4).toString("latin1") === "RIFF"
    && b.slice(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

export type AvatarFetchResult = Readonly<{
  ok: boolean;
  status: number;
  message: string | null;
  meta: AvatarMeta;
}>;

/** Fetch/revalidate the upstream and refresh the local cache. Never throws. */
async function doRefreshAvatar(meta: AvatarMeta): Promise<AvatarFetchResult> {
  const decision = await assertSafeAvatarDestination(meta.url, meta.providerId);
  if ("error" in decision) {
    return { ok: false, status: 422, message: decision.error, meta };
  }
  const pinned = decision.pinned;
  const parsed = new URL(meta.url);
  const scheme = parsed.protocol === "https:" ? "https" : "http";
  const hostname = unbracketHostname(parsed.hostname);
  const port = parsed.port !== "" ? Number(parsed.port) : (scheme === "https" ? 443 : 80);

  // Only revalidate when a cached image exists; otherwise the upstream would
  // answer 304 forever with no body to (re)store.
  const cached = hasCachedImage(meta.key);
  const headers: Record<string, string> = {};
  if (cached && meta.etag !== null) headers["If-None-Match"] = meta.etag;
  if (cached && meta.lastModified !== null) headers["If-Modified-Since"] = meta.lastModified;
  // Incoming cookies/Authorization are deliberately never forwarded.

  let raw: RawResponse;
  try {
    raw = await requestPinned({
      scheme,
      address: pinned,
      hostname,
      port,
      path: `${parsed.pathname}${parsed.search}`,
      headers,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_AVATAR_BYTES,
    });
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : "fetch failed", meta };
  }

  const now = Date.now();
  if (raw.status === 304 && hasCachedImage(meta.key)) {
    // Retain the cached content hash — the representation did not change.
    const refreshed: AvatarMeta = { ...meta, state: "fetched", fetchedAt: now, expiresAt: now + AVATAR_REVALIDATE_MS };
    await writeMeta(refreshed);
    return { ok: true, status: 304, message: null, meta: refreshed };
  }
  if (raw.status < 200 || raw.status >= 300) {
    return { ok: false, status: raw.status, message: `upstream returned ${raw.status}`, meta };
  }
  if (raw.truncated) {
    return { ok: false, status: 413, message: "avatar exceeds the 2 MiB limit", meta };
  }
  const contentType = typeof raw.headers["content-type"] === "string"
    ? (raw.headers["content-type"]).toLowerCase()
    : "";
  if (!contentType.startsWith("image/")) {
    return { ok: false, status: 415, message: "upstream returned a non-image content type", meta };
  }
  if (raw.bytes.length === 0) {
    return { ok: false, status: 0, message: "upstream returned an empty body", meta };
  }
  const kind = sniffImageKind(new Uint8Array(raw.bytes));
  if (kind === null) {
    return { ok: false, status: 415, message: "upstream bytes are not a recognized image", meta };
  }
  const mime = IMAGE_KIND_TO_MIME[kind] ?? "image/png";
  // New content => new content hash => new browser ETag (fixes stale-avatar 304).
  const contentHash = createHash("sha256").update(raw.bytes).digest("hex");
  await mkdir(join(avatarDir(), meta.key.slice(0, 2)), { recursive: true, mode: 0o700 });
  // Atomic write (temp + rename) so a concurrent reader never sees a partial file.
  const tmpImg = `${imgPath(meta.key)}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpImg, raw.bytes, { mode: 0o600 });
  await rename(tmpImg, imgPath(meta.key));
  const refreshed: AvatarMeta = {
    ...meta,
    state: "fetched",
    contentType: mime,
    etag: typeof raw.headers.etag === "string" ? raw.headers.etag : meta.etag,
    lastModified: typeof raw.headers["last-modified"] === "string" ? raw.headers["last-modified"] : meta.lastModified,
    fetchedAt: now,
    expiresAt: now + AVATAR_REVALIDATE_MS,
    bytes: raw.bytes.length,
    contentHash,
  };
  await writeMeta(refreshed);
  maybeSweepCache(); // throttled: bounded cache, never append-only
  return { ok: true, status: raw.status, message: null, meta: refreshed };
}

// One upstream refresh per key at a time: concurrent requests for the same
// avatar share a single fetch instead of duplicating it / racing the writes.
const refreshInFlight = new Map<string, Promise<AvatarFetchResult>>();

/** Fetch/revalidate the upstream and refresh the local cache. Never throws. */
async function refreshAvatar(meta: AvatarMeta): Promise<AvatarFetchResult> {
  const running = refreshInFlight.get(meta.key);
  if (running !== undefined) return running;
  const run = doRefreshAvatar(meta);
  refreshInFlight.set(meta.key, run);
  void run.finally(() => {
    if (refreshInFlight.get(meta.key) === run) refreshInFlight.delete(meta.key);
  });
  return run;
}

async function readCachedImageBytes(key: string): Promise<Buffer | null> {
  try {
    return await readFile(imgPath(key));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache garbage collection (bounded: storage/avatars is not append-only)
// ---------------------------------------------------------------------------
function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Bounded sweep: drops untouched entries past the max age and evicts the
 * least-recently-fetched entries when the cache exceeds the byte/entry budget.
 * Metadata-only records (recorded but never fetched) older than an hour are
 * orphans and are removed too — a future serializer call re-records them.
 * Best-effort: never throws.
 */
async function sweepAvatarCache(): Promise<{ removed: number }> {
  const dir = avatarDir();
  const maxBytes = positiveEnv("AVATAR_CACHE_MAX_BYTES", DEFAULT_CACHE_BYTES);
  const maxEntries = positiveEnv("AVATAR_CACHE_MAX_ENTRIES", DEFAULT_CACHE_ENTRIES);
  const maxAgeMs = positiveEnv("AVATAR_CACHE_MAX_AGE_MS", DEFAULT_CACHE_AGE_MS);
  const now = Date.now();
  let removed = 0;

  let shardNames: string[] = [];
  try {
    shardNames = (await readdir(dir, { withFileTypes: true }))
      .filter((entry): boolean => entry.isDirectory())
      .map((entry): string => entry.name);
  } catch {
    return { removed };
  }

  // key -> { imgPath, size (img+json), last (fetchedAt ?? mtime), orphan }
  const entries = new Map<string, { img?: string; json?: string; size: number; last: number }>();
  for (const shard of shardNames) {
    const shardPath = join(dir, shard);
    let names: string[] = [];
    try {
      names = (await readdir(shardPath, { withFileTypes: true }))
        .filter((entry): boolean => entry.isFile() && /^[0-9a-f]{64}\.(json|img)$/.test(entry.name))
        .map((entry): string => entry.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const key = name.slice(0, 64);
      const record = entries.get(key) ?? { size: 0, last: 0 };
      if (name.endsWith(".img")) record.img = join(shardPath, name);
      else record.json = join(shardPath, name);
      entries.set(key, record);
    }
  }

  for (const [key, record] of entries) {
    let size = 0;
    let last = 0;
    if (record.img !== undefined) {
      try {
        const imageStat = await stat(record.img);
        size += imageStat.size;
        last = imageStat.mtimeMs;
      } catch {
        delete record.img; // image vanished; treat the record as an orphan
      }
    }
    if (record.json !== undefined) {
      try {
        const jsonStat = await stat(record.json);
        size += jsonStat.size;
        if (last === 0) last = jsonStat.mtimeMs;
      } catch {
        // ignore missing json
      }
      const meta = await readAvatarMeta(key);
      if (meta?.fetchedAt !== null && typeof meta?.fetchedAt === "number") last = Math.max(last, meta.fetchedAt);
    }
    record.size = size;
    record.last = last;
  }

  const removals = new Set<string>();
  // 1) Age-based: untouched past the max age (and metadata-only orphans).
  for (const [key, record] of entries) {
    const orphan = record.img === undefined;
    if (record.last > 0 && now - record.last > maxAgeMs) removals.add(key);
    else if (orphan && now - record.last > 60 * 60 * 1000) removals.add(key);
  }
  // 2) Budget-based: evict least-recently-fetched until within limits.
  let totalBytes = 0;
  const live: { key: string; last: number; size: number }[] = [];
  for (const [key, record] of entries) {
    if (removals.has(key)) continue;
    totalBytes += record.size;
    live.push({ key, last: record.last, size: record.size });
  }
  live.sort((a, b): number => a.last - b.last);
  // Evict enough oldest entries to reach the entry/byte budgets.
  const mustRemoveForCount = Math.max(0, live.length - maxEntries);
  for (let index = 0; index < live.length && (index < mustRemoveForCount || totalBytes > maxBytes); index += 1) {
    const candidate = live[index];
    if (candidate === undefined) break;
    totalBytes -= candidate.size;
    removals.add(candidate.key);
  }

  for (const key of removals) {
    const record = entries.get(key);
    if (record === undefined) continue;
    const targets = [record.img, record.json].filter((path): path is string => typeof path === "string");
    for (const path of targets) {
      try {
        await unlink(path);
        removed += 1;
      } catch {
        // already gone
      }
    }
  }
  return { removed };
}

let successfulFetchesSinceSweep = 0;
let sweepInFlight: Promise<{ removed: number }> | null = null;
function maybeSweepCache(): void {
  successfulFetchesSinceSweep += 1;
  if (successfulFetchesSinceSweep < SWEEP_EVERY_N_FETCHES) return;
  if (sweepInFlight !== null) return; // don't stack overlapping sweeps
  successfulFetchesSinceSweep = 0;
  sweepInFlight = sweepAvatarCache();
  void sweepInFlight.finally(() => {
    sweepInFlight = null;
  });
}

/**
 * The single abstraction serializers/the route talk to: resolve a remote
 * avatar URL to a same-origin key, cache, and serve back — never handing the
 * browser a third-party URL and never accepting an arbitrary `?url=`. Caching,
 * revalidation, pinned network access and content-hashed ETags live here.
 */
export const AvatarService = {
  cacheKey: avatarCacheKey,
  resolveUrl,
  resolveVcsUrl,
  record: ensureRecorded,
  refresh: refreshAvatar,
  hasCached: hasCachedImage,
  readMeta: readAvatarMeta,
  readBytes: readCachedImageBytes,
  /** Bounded GC: age-based + LRU eviction within the byte/entry budget. */
  sweepCache: sweepAvatarCache,
} as const;

export { avatarDir, metaPath, imgPath };