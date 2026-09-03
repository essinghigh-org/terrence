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
// API (4s timeout, 24h memo) -> exact provider's absolute logo URL ->
// AvatarService cache. The provider-icon image handler delegates to that cache
// without changing the public route identity.
import { AvatarService } from "./avatars";
import {
  DEFAULT_PROVIDER_REGISTRY_HOST,
  normalizeProviderSource,
  parseProviderSource,
  type ProviderSource,
} from "./provider-source";

const REGISTRY = `https://${DEFAULT_PROVIDER_REGISTRY_HOST}`;
const FETCH_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 10 * 60 * 1000; // transient fetch failures: retry soon
const MAX_CACHE_ENTRIES = 512;
type CacheEntry = Readonly<{ url: string | null; expiresAt: number }>;
const cache = new Map<string, CacheEntry>();
const inflightByKey = new Map<string, Promise<string | null>>();
const MAX_REGISTRY_CONCURRENCY = 8;
let registryInFlight = 0;
const registryQueue: (() => void)[] = [];

async function acquireRegistrySlot(): Promise<void> {
  if (registryInFlight < MAX_REGISTRY_CONCURRENCY) {
    registryInFlight += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => { registryQueue.push(resolve); });
}

function releaseRegistrySlot(): void {
  registryInFlight -= 1;
  const next = registryQueue.shift();
  if (next !== undefined) {
    registryInFlight += 1;
    next();
  }
}

function setCache(key: string, url: string | null, ttlMs: number): void {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, { url, expiresAt: Date.now() + ttlMs });
  // Remove expired entries opportunistically
  if (cache.size > MAX_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now >= v.expiresAt) cache.delete(k);
      if (cache.size <= MAX_CACHE_ENTRIES) break;
    }
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

async function fetchGithubOwnerAvatarUrl(login: string): Promise<string | null> {
  const url = new URL(`/github/users/${encodeURIComponent(login)}`, `${REGISTRY}/`);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Accept: "application/json", "User-Agent": "terrence/provider-icons" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const avatarUrl = asRecord(body)?.["avatar_url"];
  return typeof avatarUrl === "string" ? absoluteLogoUrl(avatarUrl) : null;
}

async function resolveRegistryLogoUrl(attributes: Readonly<Record<string, unknown>>, source: ProviderSource): Promise<string | null> {
  const logoUrl = attributes["logo-url"];
  if (typeof logoUrl !== "string") return null;
  // The v2 record can retain the Registry's legacy GitHub slug URL. GitHub
  // serves that form as its default Octocat, while the Registry UI resolves
  // the provider namespace through /github/users/:login first.
  if (isLegacyGithubSlugAvatar(logoUrl)) return fetchGithubOwnerAvatarUrl(source.namespace);
  return absoluteLogoUrl(logoUrl);
}

async function fetchLogoUrl(source: ProviderSource): Promise<string | null> {
  if (source.hostname !== DEFAULT_PROVIDER_REGISTRY_HOST) return null;
  await acquireRegistrySlot();
  try {
    const url = new URL("/v2/providers", REGISTRY);
    url.searchParams.set("filter[namespace]", source.namespace);
    url.searchParams.set("filter[name]", source.name);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Accept: "application/vnd.api+json", "User-Agent": "terrence/provider-icons" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    const attributes = exactRegistryProviderAttributes(body, source);
    if (attributes === null) return null;
    return await resolveRegistryLogoUrl(attributes, source);
  } finally {
    releaseRegistrySlot();
  }
}

export async function resolveProviderIconUrl(providerName: string | null | undefined): Promise<string | null> {
  const source = parseProviderSource(providerName);
  if (source === null || source.hostname !== DEFAULT_PROVIDER_REGISTRY_HOST) return null;
  const key = `${source.hostname}/${source.namespace}/${source.name}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit !== undefined && now < hit.expiresAt) {
    return hit.url;
  }
  if (hit !== undefined && now >= hit.expiresAt) cache.delete(key);
  const existing = inflightByKey.get(key);
  if (existing !== undefined) return existing;
  const run = (async (): Promise<string | null> => {
    const logoUrl = await fetchLogoUrl(source);
    const avatarUrl = logoUrl === null ? null : AvatarService.resolveUrl("provider-icon", logoUrl);
    // Transient miss (fetch failed / no logo) gets a short TTL so we retry soon.
    const ttl = avatarUrl === null && logoUrl === null ? NEGATIVE_TTL_MS : CACHE_TTL_MS;
    setCache(key, avatarUrl, ttl);
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

// Test-only helpers
/** @public Intentional surface: benchmark/test hook or cross-module API. */
export function clearProviderIconCache(): void {
  cache.clear();
  inflightByKey.clear();
  registryInFlight = 0;
  registryQueue.length = 0;
}

/** @public Intentional surface: benchmark/test hook or cross-module API. */
export function primeProviderIconCache(key: string, url: string | null): void {
  const source = parseProviderSource(key);
  if (source === null) return;
  setCache(`${source.hostname}/${source.namespace}/${source.name}`, url, CACHE_TTL_MS);
}
