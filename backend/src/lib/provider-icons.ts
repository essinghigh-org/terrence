// Provider icons (registry.terraform.io -> dedicated same-origin image route)
//
// TFE shows a provider logo left of each resource in the plan. The public
// registry's supported provider collection API is the source:
// `GET /v2/providers?filter[namespace]=...&filter[name]=...` returns JSON:API
// attributes including `logo-url`. We reuse the hardened AvatarService
// internally for the image fetch and cache so the browser never loads a
// third-party URL and no new CSP host is needed. The browser-facing URL remains
// /api/v2/provider-icons/<hostname>/<ns>/<name>; it must not expose the generic
// avatar endpoint as the provider icon API.
//
// Flow: parse the provider source (two-part sources use Terraform's documented
// default registry; explicit hostnames are retained) -> Terraform Registry v2
// API (4s timeout, persistent one-year memo) -> exact provider's absolute logo URL ->
// AvatarService cache. The provider-icon image handler delegates to that cache
// without changing the public route identity.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { discover } from "./discovery-queue";
import { readTextWithLimit } from "./body-limit";
import { AvatarService, metaPath } from "./avatars";
import {
  DEFAULT_PROVIDER_REGISTRY_HOST,
  normalizeProviderSource,
  parseProviderSource,
  type ProviderSource,
} from "./provider-source";

const REGISTRY = `https://${DEFAULT_PROVIDER_REGISTRY_HOST}`;
const FETCH_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000; // transient fetch failures: retry soon
const MAX_CACHE_ENTRIES = 512;
type CacheEntry = Readonly<{ url: string | null; expiresAt: number }>;
const cache = new Map<string, CacheEntry>();
const negativeCache = new Map<string, CacheEntry>();
const inflightByKey = new Map<string, Promise<string | null>>();
function providerCacheKey(source: ProviderSource): string {
  return `${source.hostname}/${source.namespace}/${source.name}`;
}

function setCache(key: string, url: string | null, ttlMs: number): void {
  const target = url === null ? negativeCache : cache;
  if (target.size >= MAX_CACHE_ENTRIES && !target.has(key)) {
    const first = target.keys().next().value;
    if (first !== undefined) target.delete(first);
  }
  target.set(key, { url, expiresAt: Date.now() + ttlMs });
}

function providerCachePath(key: string): string {
  const directory = resolve(process.env["STORAGE_DIR"] ?? join(import.meta.dir, "../../storage"), "provider-icons");
  return join(directory, `${createHash("sha256").update(key).digest("hex")}.json`);
}

async function persistProviderCache(key: string, url: string, expiresAt: number): Promise<void> {
  const path = providerCachePath(key);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ url, expiresAt }), { mode: 0o600 });
    await rename(temporary, path);
  } catch {
    await unlink(temporary).catch((): void => undefined);
    // A read-only or unavailable cache must not prevent icon discovery.
  }
}

function readPersistedProviderCache(key: string): CacheEntry | undefined {
  try {
    const entry = JSON.parse(readFileSync(providerCachePath(key), "utf8")) as Partial<CacheEntry>;
    const version = providerIconVersion(entry.url);
    if (version === null || typeof entry.expiresAt !== "number" || Date.now() >= entry.expiresAt) return undefined;
    // Metadata may have been evicted independently; rediscover in that case.
    if (!existsSync(metaPath(version))) return undefined;
    const hit = { url: entry.url ?? null, expiresAt: entry.expiresAt };
    setCache(key, hit.url, hit.expiresAt - Date.now());
    return hit;
  } catch {
    return undefined;
  }
}

/** Public compatibility name retained for the provider-icons route/tests. */
export function normalizeProvider(providerName: string | null | undefined): string | null {
  return normalizeProviderSource(providerName);
}

/** Extract the opaque avatar key used as the browser cache version. */
export function providerIconVersion(avatarUrl: string | null | undefined): string | null {
  if (typeof avatarUrl !== "string") return null;
  return /^\/api\/v2\/avatars\/([0-9a-f]{64})$/.exec(avatarUrl)?.[1] ?? null;
}

/** Build the browser-facing URL for one canonical provider source. */
export function providerIconPath(providerName: string | null | undefined, version?: string | null): string | null {
  const source = parseProviderSource(providerName);
  if (source === null || source.hostname !== DEFAULT_PROVIDER_REGISTRY_HOST) return null;
  const path = `/api/v2/provider-icons/${encodeURIComponent(source.hostname)}/${encodeURIComponent(source.namespace)}/${encodeURIComponent(source.name)}`;
  return typeof version === "string" && /^[0-9a-f]{64}$/.test(version) ? `${path}?v=${version}` : path;
}

function readProviderCache(key: string): CacheEntry | undefined {
  const hit = cache.get(key) ?? negativeCache.get(key) ?? readPersistedProviderCache(key);
  if (hit === undefined) return undefined;
  if (Date.now() < hit.expiresAt) return hit;
  cache.delete(key);
  negativeCache.delete(key);
  return undefined;
}

/** Return a positive cache hit without admitting new network work. */
export function cachedProviderIconUrl(providerName: string | null | undefined): string | null {
  const source = parseProviderSource(providerName);
  if (source === null || source.hostname !== DEFAULT_PROVIDER_REGISTRY_HOST) return null;
  const hit = readProviderCache(providerCacheKey(source));
  return hit?.url ?? null;
}

/** Start optional discovery and deliberately do not make the caller wait. */
export function scheduleProviderIconDiscovery(providerName: string | null | undefined): void {
  const source = parseProviderSource(providerName);
  if (source === null || source.hostname !== DEFAULT_PROVIDER_REGISTRY_HOST) return;
  const key = providerCacheKey(source);
  if (readProviderCache(key) !== undefined || inflightByKey.has(key)) return;
  void resolveProviderIconUrl(source.source).catch((): null => null);
}

/**
 * Resolve the browser-facing path synchronously. A positive cache hit gets a
 * content version; a miss gets a stable provider route while discovery runs
 * in the background. The route serves a deterministic SVG until metadata is
 * available, so a registry outage never blocks a response.
 */
export function providerIconResponsePath(providerName: string | null | undefined): string | null {
  const source = parseProviderSource(providerName);
  if (source === null || source.hostname !== DEFAULT_PROVIDER_REGISTRY_HOST) return null;
  const key = providerCacheKey(source);
  const hit = readProviderCache(key);
  if (hit?.url !== undefined && hit.url !== null) return providerIconPath(source.source, providerIconVersion(hit.url));
  scheduleProviderIconDiscovery(source.source);
  return providerIconPath(source.source);
}

/** Build a safe, stable placeholder for an icon that is still discovering. */
export function providerIconFallbackSvg(providerName: string | null | undefined): Readonly<{ body: string; etag: string }> | null {
  const source = parseProviderSource(providerName);
  if (source === null || source.hostname !== DEFAULT_PROVIDER_REGISTRY_HOST) return null;
  const digest = createHash("sha256").update(providerCacheKey(source)).digest("hex");
  const initials = `${source.namespace.slice(0, 1)}${source.name.slice(0, 1)}`.toUpperCase();
  const hue = Number.parseInt(digest.slice(0, 6), 16) % 360;
  const body = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="${initials} provider"><rect width="32" height="32" rx="6" fill="hsl(${hue} 45% 42%)"/><text x="16" y="17" dominant-baseline="middle" text-anchor="middle" fill="white" font-family="sans-serif" font-size="11" font-weight="700">${initials}</text></svg>`;
  return { body, etag: `"provider-fallback-${digest}"` };
}

function absoluteLogoUrl(logoUrl: string): string | null {
  if (typeof logoUrl !== "string" || logoUrl === "") return null;
  const trimmed = logoUrl.trim();
  if (trimmed === "") return null;
  try {
    const parsed = new URL(trimmed, `${REGISTRY}/`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function matchesOptionalProviderAttribute(value: unknown, expected: string): boolean {
  return value === undefined || (typeof value === "string" && value.toLowerCase() === expected);
}

function hasExactProviderParts(namespace: unknown, name: unknown, source: ProviderSource): boolean {
  return typeof namespace === "string"
    && typeof name === "string"
    && namespace.toLowerCase() === source.namespace
    && name.toLowerCase() === source.name;
}

function hasExactProviderFullName(value: unknown, source: ProviderSource): boolean {
  if (typeof value !== "string") return false;
  const lower = value.toLowerCase();
  const expectedShortName = `${source.namespace}/${source.name}`;
  const expectedFullName = `${source.hostname}/${expectedShortName}`;
  return lower === expectedShortName || lower === expectedFullName;
}

function exactProviderAttributes(value: unknown, source: ProviderSource): Record<string, unknown> | null {
  const entry = asRecord(value);
  const attributes = asRecord(entry?.["attributes"]);
  if (attributes === null) return null;

  const namespace = attributes["namespace"];
  const name = attributes["name"];
  const fullName = attributes["full-name"];
  if (!matchesOptionalProviderAttribute(namespace, source.namespace)) return null;
  if (!matchesOptionalProviderAttribute(name, source.name)) return null;
  const hasExactParts = hasExactProviderParts(namespace, name, source);
  const hasExactFullName = hasExactProviderFullName(fullName, source);
  if (fullName !== undefined && !hasExactFullName) return null;
  return hasExactParts || hasExactFullName ? attributes : null;
}

function exactRegistryProviderAttributes(body: unknown, source: ProviderSource): Record<string, unknown> | null {
  const response = asRecord(body);
  const data = response?.["data"];
  if (!Array.isArray(data)) return null;
  for (const entry of data) {
    const attributes = exactProviderAttributes(entry, source);
    if (attributes !== null) return attributes;
  }
  return null;
}

function isLegacyGithubSlugAvatar(logoUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(logoUrl);
  } catch {
    return false;
  }
  return parsed.protocol === "https:"
    && /^avatars\d*\.githubusercontent\.com$/i.test(parsed.hostname)
    && /^\/[A-Za-z0-9-]+\/?$/.test(parsed.pathname);
}

async function fetchGithubOwnerAvatarUrl(login: string, signal: Readonly<AbortSignal>): Promise<string | null> {
  const url = new URL(`/github/users/${encodeURIComponent(login)}`, `${REGISTRY}/`);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Accept: "application/json", "User-Agent": "terrence/provider-icons" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    });
  } catch {
    return null;
  }
  if (!res.ok) { await res.body?.cancel().catch((): void => undefined); return null; }
  let body: unknown;
  try {
    body = JSON.parse(await readTextWithLimit(res, 1024 * 1024));
  } catch {
    return null;
  }
  const avatarUrl = asRecord(body)?.["avatar_url"];
  return typeof avatarUrl === "string" ? absoluteLogoUrl(avatarUrl) : null;
}

async function resolveRegistryLogoUrl(attributes: Readonly<Record<string, unknown>>, source: ProviderSource, signal: Readonly<AbortSignal>): Promise<string | null> {
  const logoUrl = attributes["logo-url"];
  if (typeof logoUrl !== "string") return null;
  // The v2 record can retain the Registry's legacy GitHub slug URL. GitHub
  // serves that form as its default Octocat, while the Registry UI resolves
  // the provider namespace through /github/users/:login first.
  if (isLegacyGithubSlugAvatar(logoUrl)) return fetchGithubOwnerAvatarUrl(source.namespace, signal);
  return absoluteLogoUrl(logoUrl);
}

async function fetchLogoUrl(source: ProviderSource, signal: Readonly<AbortSignal>): Promise<string | null> {
  if (source.hostname !== DEFAULT_PROVIDER_REGISTRY_HOST) return null;
  const url = new URL("/v2/providers", REGISTRY);
  url.searchParams.set("filter[namespace]", source.namespace);
  url.searchParams.set("filter[name]", source.name);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Accept: "application/vnd.api+json", "User-Agent": "terrence/provider-icons" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    });
  } catch {
    return null;
  }
  if (!res.ok) { await res.body?.cancel().catch((): void => undefined); return null; }
  let body: unknown;
  try {
    body = JSON.parse(await readTextWithLimit(res, 1024 * 1024));
  } catch {
    return null;
  }
  const attributes = exactRegistryProviderAttributes(body, source);
  if (attributes === null) return null;
  return await resolveRegistryLogoUrl(attributes, source, signal);
}

export async function resolveProviderIconUrl(providerName: string | null | undefined): Promise<string | null> {
  const source = parseProviderSource(providerName);
  if (source === null || source.hostname !== DEFAULT_PROVIDER_REGISTRY_HOST) return null;
  const key = providerCacheKey(source);
  const now = Date.now();
  const hit = cache.get(key) ?? negativeCache.get(key) ?? readPersistedProviderCache(key);
  if (hit !== undefined && now < hit.expiresAt) {
    return hit.url;
  }
  if (hit !== undefined && now >= hit.expiresAt) { cache.delete(key); negativeCache.delete(key); }
  const existing = inflightByKey.get(key);
  if (existing !== undefined) return existing;
  const discovery = discover(source.hostname, async (signal): Promise<string | null> => fetchLogoUrl(source, signal));
  if (discovery === null) { setCache(key, null, 5_000); return null; }
  const run = (async (): Promise<string | null> => {
    const logoUrl = await discovery;
    const avatarUrl = logoUrl === null ? null : AvatarService.resolveUrl("provider-icon", logoUrl);
    // Transient miss (fetch failed / no logo) gets a short TTL so we retry soon.
    const ttl = avatarUrl === null ? NEGATIVE_TTL_MS : CACHE_TTL_MS;
    setCache(key, avatarUrl, ttl);
    if (avatarUrl !== null) {
      const version = providerIconVersion(avatarUrl);
      if (version !== null) await AvatarService.readMeta(version);
      await persistProviderCache(key, avatarUrl, Date.now() + ttl);
    }
    return avatarUrl;
  })();
  inflightByKey.set(key, run);
  try {
    return await run;
  } finally {
    if (inflightByKey.get(key) === run) inflightByKey.delete(key);
  }
}

export async function batchResolveProviderIconUrls(providerNames: readonly string[]): Promise<Readonly<Record<string, string | null>>> {
  const unique = [...new Set(providerNames.map((p): string | null => normalizeProvider(p)).filter((p): p is string => p !== null))];
  const entries = await Promise.all(unique.map(async (k): Promise<[string, string | null]> => [k, await resolveProviderIconUrl(k)]));
  return Object.fromEntries(entries);
}

/** Return stable provider paths and schedule misses without awaiting them. */
export function batchResolveProviderIconPaths(providerNames: readonly string[]): Readonly<Record<string, string | null>> {
  const unique = [...new Set(providerNames.map((p): string | null => normalizeProvider(p)).filter((p): p is string => p !== null))];
  return Object.fromEntries(unique.map((key): [string, string | null] => [key, providerIconResponsePath(key)]));
}

// Test-only helpers
/** @public Intentional surface: benchmark/test hook or cross-module API. */
export function clearProviderIconCache(): void {
  cache.clear();
  negativeCache.clear();
  inflightByKey.clear();
}

/** @public Intentional surface: benchmark/test hook or cross-module API. */
export function primeProviderIconCache(key: string, url: string | null): void {
  const source = parseProviderSource(key);
  if (source === null) return;
  setCache(providerCacheKey(source), url, url === null ? NEGATIVE_TTL_MS : CACHE_TTL_MS);
}
