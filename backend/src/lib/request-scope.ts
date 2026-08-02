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

/** Set the scopes for the current request. Called by the auth plugin. */
export function setRequestTokenScopes(scopes: TokenScopes | null): void {
  tokenScopesStorage.enterWith(scopes);
}

/**
 * The fine-grained scopes of the token authenticating the current request.
 * Returns null when the request is unauthenticated or the token is a legacy
 * full-permission token.
 */
export function currentTokenScopes(): TokenScopes | null {
  return tokenScopesStorage.getStore() ?? null;
}

/**
 * Run a function with token scopes temporarily suspended (treated as null).
 * Used to compute a principal's BASE access (membership/team/org-owner)
 * before intersecting with fine-grained scope restrictions — the base access
 * must reflect the user's underlying permissions, not the token's grants.
 */
export async function withoutTokenScopes<T>(fn: () => Promise<T>): Promise<T> {
  const previous = tokenScopesStorage.getStore() ?? null;
  tokenScopesStorage.enterWith(null);
  try {
    return await fn();
  } finally {
    tokenScopesStorage.enterWith(previous);
  }
}
