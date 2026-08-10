/**
 * Small TTL metadata cache (kanban 10.14).
 *
 * Serialized responses embed organization names and other slowly-changing
 * lookup values; without a cache, every serialized resource with an org
 * reference issues its own `organizations` SELECT. This module caches
 * org-name lookups for a short TTL (60s), so burst reads (lists, run
 * timelines, registries) hit memory instead of SQLite, while writes still
 * observe fresh values within the TTL window. The cache is deliberately
 * tiny, process-local, and invalidated by short TTL instead of event
 * wiring: a stale org name for up to 60 seconds after a rename is
 * acceptable for generated response payloads (the canonical read paths
 * never go through this cache).
 */
const TTL_MS = 60_000;

type CacheEntry = Readonly<{ value: string | null; expiresAt: number }>;

const store = new Map<string, CacheEntry>();

function get(key: string): string | null | undefined {
  const entry = store.get(key);
  if (entry === undefined) return undefined;
  if (Date.now() >= entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

function set(key: string, value: string | null): void {
  store.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

/** Read a cached org name (null when absent or expired). */
export function cachedOrganizationName(orgId: string): string | null | undefined {
  return get(`org:${orgId}`);
}

/** Record an org name lookup result. */
export function cacheOrganizationName(orgId: string, name: string | null): void {
  set(`org:${orgId}`, name);
}

/** Drop cached values after a rename so subsequent responses reflect it. */
export function invalidateOrganizationName(orgId: string): void {
  store.delete(`org:${orgId}`);
}

/** Test hook: clears the whole cache. */
export function clearMetadataCache(): void {
  store.clear();
}