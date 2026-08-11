/**
 * cached-lookups.ts — per-request memoization for immutable identifier
 * lookups (kanban 10.13).
 *
 * Routes resolve the same organization over and over within one request:
 * the workspace list resolves the org by name, the permission helpers
 * re-resolve it by id, nested serializers resolve it once per item. Org
 * rows are read-only facts for the lifetime of a request (they cannot
 * change mid-flight), so memoizing them in the request-scoped cache (see
 * request-scope.ts) turns N duplicate SQL reads into one.
 *
 * The IN-FLIGHT promise is cached (same pattern as loadMembershipFacts in
 * utils.ts) so concurrent callers inside a Promise.all share one query
 * instead of racing each other.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { organizations } from "../db/schema";
import { requestCacheGet, requestCacheSet } from "./request-scope";

type OrgRow = typeof organizations.$inferSelect;

async function orgByNameUncached(name: string): Promise<OrgRow | undefined> {
  return db.query.organizations.findFirst({ where: eq(organizations.name, name) });
}

async function orgByIdUncached(id: string): Promise<OrgRow | undefined> {
  return db.query.organizations.findFirst({ where: eq(organizations.id, id) });
}

/** Organization row by exact name, memoized for the current request. */
export function cachedOrgByName(name: string): Promise<OrgRow | undefined> {
  const key = `org:name:${name}`;
  const cached = requestCacheGet<Promise<OrgRow | undefined>>(key);
  if (cached !== undefined) return cached;
  const value = orgByNameUncached(name);
  requestCacheSet(key, value);
  return value;
}

/** Organization row by id, memoized for the current request. */
export function cachedOrgById(id: string): Promise<OrgRow | undefined> {
  const key = `org:id:${id}`;
  const cached = requestCacheGet<Promise<OrgRow | undefined>>(key);
  if (cached !== undefined) return cached;
  const value = orgByIdUncached(id);
  requestCacheSet(key, value);
  return value;
}
