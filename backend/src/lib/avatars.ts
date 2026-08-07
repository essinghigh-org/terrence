// Same-origin avatar proxy/cache.
//
// Serializers never hand the browser a remote avatar URL. They call
// proxiedAvatarUrl(), which derives an opaque cache key server-side and
// records the upstream URL internally. The browser only ever loads
// /api/v2/avatars/<key>; the key is a SHA-256 over (provider id + canonical
// URL), so no ?url= parameter exists and an authenticated user cannot turn
// this endpoint into an arbitrary-fetch SSRF hole (unknown keys 404 without
// contacting anything).
//
// Fetch rules (OWASP SSRF guidance):
//   - http/https only, no URL credentials
//   - resolve A/AAAA and reject loopback/link-local/multicast/private ranges
//     UNLESS the origin is a configured VCS integration (admin-trusted:
//     oauth clients' httpUrl or the GitHub App http URL) — self-hosted GitLab
//     at 10.x is legitimate
//   - redirects are never followed (redirect: "error")
//   - short timeout, 2 MiB response cap, image MIME + magic-byte sniffing
//   - no incoming cookies/Authorization are ever forwarded
//
// Caching: storage/avatars/<2-hex>/<key>.json (metadata) + <key>.img (bytes).
// The browser gets Cache-Control: private, max-age=86400 + ETag; the server
// revalidates the upstream copy with If-None-Match / If-Modified-Since and
// serves a stale cached copy if the upstream is unreachable.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lookup } from "node:dns/promises";
import { db } from "../db";

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 6_000;
const DNS_TIMEOUT_MS = 2_500;
export const AVATAR_REVALIDATE_MS = 60 * 60 * 1000; // server considers fresh 1h
export const AVATAR_CLIENT_CACHE = "private, max-age=86400";

const IMAGE_KIND_TO_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
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
}>;

function avatarDir(): string {
  return resolve(process.env.STORAGE_DIR ?? join(import.meta.dir, "../../storage"), "avatars");
}

function metaPath(key: string): string {
  return join(avatarDir(), key.slice(0, 2), `${key}.json`);
}

function imgPath(key: string): string {
  return join(avatarDir(), key.slice(0, 2), `${key}.img`);
}

export function hasCachedImage(key: string): boolean {
  return existsSync(imgPath(key));
}

export function avatarCacheKey(providerId: string, url: string): string {
  return createHash("sha256").update(`${providerId}\u0000${url}`).digest("hex");
}

// Write-once memoization for the fire-and-forget record writes from the
// synchronous serializer path (a page of runs enqueues N distinct records).
const recordedKeys = new Set<string>();
export async function writeAvatarRecord(providerId: string, url: string): Promise<string> {
  const key = avatarCacheKey(providerId, url);
  if (recordedKeys.has(key) || existsSync(metaPath(key))) return key;
  recordedKeys.add(key);
  const dir = join(avatarDir(), key.slice(0, 2));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const meta: AvatarMeta = {
    key, providerId, url, state: "pending",
    contentType: null, etag: null, lastModified: null,
    fetchedAt: null, expiresAt: null, bytes: null,
  };
  await writeFile(metaPath(key), JSON.stringify(meta), { mode: 0o600 });
  return key;
}

/** Synchronous serializer helper: opaque proxy URL or null. */
export function proxiedAvatarUrl(providerId: string, url: string | null | undefined): string | null {
  if (typeof url !== "string" || url === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const key = avatarCacheKey(providerId, url);
  void writeAvatarRecord(providerId, url);
  return `/api/v2/avatars/${key}`;
}

export async function readAvatarMeta(key: string): Promise<AvatarMeta | null> {
  try {
    const raw = await readFile(metaPath(key), "utf8");
    const parsed = JSON.parse(raw) as Partial<AvatarMeta>;
    if (typeof parsed.key !== "string" || typeof parsed.url !== "string") return null;
    return parsed as AvatarMeta;
  } catch {
    return null;
  }
}

async function saveAvatarMeta(meta: AvatarMeta): Promise<void> {
  await writeFile(metaPath(meta.key), JSON.stringify(meta), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// SSRF validation
// ---------------------------------------------------------------------------
export function isPrivateIpv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m === null) return false;
  const a = Number(m[1]); const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === "::1"
    || lower.startsWith("fe80") // link-local
    || lower.startsWith("fc") || lower.startsWith("fd") // ULA
    || lower.startsWith("ff0"); // multicast (ff00::/8)
}

export function isPrivateIp(ip: string): boolean {
  if (!ip.includes(":")) return isPrivateIpv4(ip);
  const mapped = ip.toLowerCase().match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped !== null && mapped[1] !== undefined) return isPrivateIpv4(mapped[1]);
  return isPrivateIpv6(ip);
}

/**
 * Origins the administrator explicitly configured as VCS integrations. An
 * avatar hosted on one of these is legitimate even if it resolves to a
 * private network (self-hosted GitLab etc.).
 */
export async function trustedAvatarOrigins(): Promise<Set<string>> {
  const origins = new Set<string>();
  try {
    const clients = await db.query.oauthClients.findMany({ columns: { httpUrl: true } });
    for (const client of clients) {
      if (typeof client.httpUrl === "string" && client.httpUrl !== "") addOrigin(origins, client.httpUrl);
    }
  } catch {
    // DB unavailable: fall through to env-configured origins only.
  }
  const githubAppUrl = process.env.GITHUB_APP_HTTP_URL;
  if (typeof githubAppUrl === "string" && githubAppUrl !== "") addOrigin(origins, githubAppUrl);
  return origins;
}

function addOrigin(set: Set<string>, url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") set.add(`${parsed.protocol}//${parsed.host}`);
  } catch {
    // ignore malformed configured URLs
  }
}

async function resolveHost(hostname: string): Promise<string[] | null> {
  try {
    const result = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<null>((resolvePromise): void => {
        setTimeout(() => resolvePromise(null), DNS_TIMEOUT_MS);
      }),
    ]);
    if (result === null) return null;
    return result.map((entry): string => entry.address);
  } catch {
    return null;
  }
}

/** Returns an error string when the destination must not be fetched. */
export async function assertSafeAvatarDestination(url: string, trusted: ReadonlySet<string>): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid avatar URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Only http and https avatar URLs are allowed";
  if (parsed.username !== "" || parsed.password !== "") return "Avatar URLs must not contain credentials";
  const origin = `${parsed.protocol}//${parsed.host}`;
  if (trusted.has(origin)) return null; // admin-configured VCS integration
  const addresses = await resolveHost(parsed.hostname);
  if (addresses === null) return null; // DNS failure: fetch will surface it; nothing was reached
  for (const address of addresses) {
    if (isPrivateIp(address)) return "Avatar URL resolves to a private or loopback address";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------
function sniffImageKind(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes);
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
export async function fetchAndCacheAvatar(meta: AvatarMeta): Promise<AvatarFetchResult> {
  const trusted = await trustedAvatarOrigins();
  const violation = await assertSafeAvatarDestination(meta.url, trusted);
  if (violation !== null) {
    return { ok: false, status: 422, message: violation, meta };
  }

  const headers: Record<string, string> = {};
  if (meta.etag !== null) headers["If-None-Match"] = meta.etag;
  if (meta.lastModified !== null) headers["If-Modified-Since"] = meta.lastModified;

  let response: Response;
  try {
    response = await fetch(meta.url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : "fetch failed", meta };
  }

  const now = Date.now();
  if (response.status === 304 && hasCachedImage(meta.key)) {
    const refreshed: AvatarMeta = { ...meta, state: "fetched", fetchedAt: now, expiresAt: now + AVATAR_REVALIDATE_MS };
    await saveAvatarMeta(refreshed);
    return { ok: true, status: 304, message: null, meta: refreshed };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, message: `upstream returned ${response.status}`, meta };
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("image/")) {
    return { ok: false, status: 415, message: "upstream returned a non-image content type", meta };
  }
  if (response.body === null) {
    return { ok: false, status: 0, message: "upstream returned no body", meta };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_AVATAR_BYTES) {
      await reader.cancel();
      return { ok: false, status: 413, message: "avatar exceeds the 2 MiB limit", meta };
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  const kind = sniffImageKind(new Uint8Array(bytes));
  if (kind === null) {
    return { ok: false, status: 415, message: "upstream bytes are not a recognized image", meta };
  }
  const mime = IMAGE_KIND_TO_MIME[kind] ?? "image/png";
  await mkdir(join(avatarDir(), meta.key.slice(0, 2)), { recursive: true, mode: 0o700 });
  await writeFile(imgPath(meta.key), bytes, { mode: 0o600 });
  const refreshed: AvatarMeta = {
    ...meta,
    state: "fetched",
    contentType: mime,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    fetchedAt: now,
    expiresAt: now + AVATAR_REVALIDATE_MS,
    bytes: total,
  };
  await saveAvatarMeta(refreshed);
  return { ok: true, status: response.status, message: null, meta: refreshed };
}

export async function readCachedImageBytes(key: string): Promise<Buffer | null> {
  try {
    return await readFile(imgPath(key));
  } catch {
    return null;
  }
}

export { avatarDir, metaPath, imgPath };