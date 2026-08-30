// Provider icons (registry.terraform.io -> dedicated same-origin image route)
//
// TFE shows a provider logo left of each resource in the plan. The public
// registry is the source: `GET /v1/providers/{ns}/{name}` returns
// `logo_url` (often `/images/providers/aws.png` or an absolute github avatar
// URL). We reuse the hardened AvatarService internally for the image fetch and
// cache so the browser never loads a third-party URL and no new CSP host is
// needed. The browser-facing URL remains /api/v2/provider-icons/<ns>/<name>;
// it must not expose the generic avatar endpoint as the provider icon API.
//
// Flow: normalize provider_name ("registry.terraform.io/hashicorp/aws" ->
// "hashicorp/aws") -> registry API (4s timeout, 24h memo) -> absolute logo
// URL -> AvatarService cache. The provider-icon image handler delegates to
// that cache without changing the public route identity.
import { AvatarService } from "./avatars";
import { normalizeProviderSource } from "./provider-source";

const REGISTRY = "https://registry.terraform.io";
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

/** Build the browser-facing URL for one canonical provider source. */
export function providerIconPath(providerName: string | null | undefined): string | null {
  const key = normalizeProvider(providerName);
  if (key === null) return null;
  const [namespace, name] = key.split("/");
  if (namespace === undefined || name === undefined) return null;
  return `/api/v2/provider-icons/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
}

function absoluteLogoUrl(logoUrl: string): string | null {
  if (typeof logoUrl !== "string" || logoUrl === "") return null;
  const trimmed = logoUrl.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("/")) return `${REGISTRY}${trimmed}`;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function fetchLogoUrl(nsName: string): Promise<string | null> {
  await acquireRegistrySlot();
  try {
    const [ns, name] = nsName.split("/") as [string, string];
    const url = `${REGISTRY}/v1/providers/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`;
    let res: Response;
    try {
      res = await fetch(url, {
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
    if (body === null || typeof body !== "object") return null;
    const rec = body as Record<string, unknown>;
    const raw = rec.logo_url ?? rec["logo-url"];
    if (typeof raw !== "string") return null;
    return absoluteLogoUrl(raw);
  } finally {
    releaseRegistrySlot();
  }
}

export async function resolveProviderIconUrl(providerName: string | null | undefined): Promise<string | null> {
  const key = normalizeProvider(providerName);
  if (key === null) return null;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit !== undefined && now < hit.expiresAt) {
    return hit.url;
  }
  if (hit !== undefined && now >= hit.expiresAt) cache.delete(key);
  const existing = inflightByKey.get(key);
  if (existing !== undefined) return existing;
  const run = (async (): Promise<string | null> => {
    const logoUrl = await fetchLogoUrl(key);
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
  setCache(key.toLowerCase(), url, CACHE_TTL_MS);
}
