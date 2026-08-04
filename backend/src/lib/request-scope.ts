import { AsyncLocalStorage } from "node:async_hooks";
import type { TokenScopes } from "./token-scopes";

/**
 * Request-scoped storage for the active token's fine-grained scopes.
 *
 * The auth plugin resolves the bearer token during its global derive, then an
 * `onBeforeHandle` hook stores the parsed scopes here. Permission helpers
 * (checkOrgPermission, checkWorkspacePermission, workspaceIdsForPermission,
 * findAuthorizedWorkspace) read the scopes from this store, so every route
 * that goes through those helpers is automatically scope-enforced without
 * threading a new parameter through ~350 call sites.
 *
 * AsyncLocalStorage propagates through the async chain of a single request
 * (derive → beforeHandle → handler → downstream db awaits), and is isolated
 * per request — concurrent requests each carry their own store.
 */
const tokenScopesStorage = new AsyncLocalStorage<TokenScopes | null>();

/**
 * Per-request memoization store. Handlers and permission helpers frequently
 * re-derive the SAME read-only access facts for a principal within one request
 * (membership, team rosters, team-workspace grants). Caching these for the
 * lifetime of the request — which is exactly the AsyncLocalStorage boundary —
 * turns N duplicate SQL reads into one, with no cross-request reuse.
 *
 * Bound to the request the same way token scopes are: initialized once per
 * request and discarded when the request's async context ends. Values are only
 * ever read-only access facts derived from rows that cannot change mid-request.
 */
const requestCacheStorage = new AsyncLocalStorage<Map<string, unknown>>();

export function requestCacheGet<T>(key: string): T | undefined {
  return requestCacheStorage.getStore()?.get(key) as T | undefined;
}

export function requestCacheSet<T>(key: string, value: T): T {
  requestCacheStorage.getStore()?.set(key, value);
  return value;
}

/** Set the scopes for the current request. Called by the auth plugin. */
export function setRequestTokenScopes(scopes: TokenScopes | null): void {
  tokenScopesStorage.enterWith(scopes);
  if (requestCacheStorage.getStore() === undefined) {
    requestCacheStorage.enterWith(new Map());
  }
}

/**
 * Publish the authenticated user's isSiteAdmin flag into the request cache.
 * The auth plugin already loads the full user row (via the joined token
 * lookup), so permission helpers can skip re-reading users.is_site_admin.
 * Only applies to the authenticated principal's own userId.
 */
export function setRequestSiteAdmin(userId: string | null, isSiteAdmin: boolean): void {
  requestCacheSet("userIsSiteAdminFor", userId);
  requestCacheSet("userIsSiteAdmin", isSiteAdmin);
}

/** The authenticated user's isSiteAdmin flag, or undefined when unknown. */
export function currentSiteAdmin(userId: string | null): boolean | undefined {
  if (requestCacheGet<string | null>("userIsSiteAdminFor") !== userId) return undefined;
  return requestCacheGet<boolean>("userIsSiteAdmin");
}

/**
 * The fine-grained scopes of the token authenticating the current request.
 * Returns null when the request is unauthenticated or the token is a legacy
 * full-permission token.
 */
export function currentTokenScopes(): TokenScopes | null {
  return tokenScopesStorage.getStore() ?? null;
}
