/**
 * Storage identity and organization scope mapping (UI-30).
 *
 * Scopes user-specific local preferences (recent workspaces, pinned workspaces,
 * saved views, and last organization) to the signed-in user identity and stable
 * organization IDs so multi-tenant/shared browser sessions do not leak
 * resource metadata across sessions or lose views on organization renames.
 */

const ACTIVE_USER_KEY = "terrence-active-user-id";

let inMemoryUserId: string | null = null;
const orgNameToId = new Map<string, string>();
const orgIdToName = new Map<string, string>();

type IdentityListener = () => void;
const identityListeners = new Set<IdentityListener>();

export function subscribeStorageIdentity(listener: IdentityListener): () => void {
  identityListeners.add(listener);
  return (): void => {
    identityListeners.delete(listener);
  };
}

function notifyIdentityChange(): void {
  for (const listener of identityListeners) {
    listener();
  }
}

/**
 * Returns the currently active user ID if signed in, or null when logged out.
 * Reads from in-memory cache first, then falls back to sessionStorage for tab continuity.
 */
export function getActiveUserId(): string | null {
  if (inMemoryUserId !== null && inMemoryUserId !== "") {
    return inMemoryUserId;
  }
  try {
    const fromSession = window.sessionStorage.getItem(ACTIVE_USER_KEY);
    if (typeof fromSession === "string" && fromSession.trim() !== "") {
      inMemoryUserId = fromSession.trim();
      return inMemoryUserId;
    }
  } catch {
    // sessionStorage unavailable
  }
  return null;
}

/**
 * Set the currently active signed-in user ID.
 */
export function setActiveUserId(userId: string | null | undefined): void {
  const normalized = typeof userId === "string" && userId.trim() !== "" ? userId.trim() : null;
  if (inMemoryUserId === normalized) return;

  inMemoryUserId = normalized;
  try {
    if (normalized !== null) {
      window.sessionStorage.setItem(ACTIVE_USER_KEY, normalized);
    } else {
      window.sessionStorage.removeItem(ACTIVE_USER_KEY);
    }
  } catch {
    // sessionStorage unavailable
  }
  notifyIdentityChange();
}

/**
 * Clear the active user identity on logout.
 */
export function clearActiveUserIdentity(): void {
  setActiveUserId(null);
  clearOrganizationScopes();
}

/**
 * Clear cached organization mappings (useful during tests or full state reset).
 */
export function clearOrganizationScopes(): void {
  orgNameToId.clear();
  orgIdToName.clear();
}

/**
 * Register a known organization mapping between its stable ID and mutable display name.
 */
export function registerOrganizationScope(orgId: string, orgName: string): void {
  if (typeof orgId === "string" && orgId !== "" && typeof orgName === "string" && orgName !== "") {
    orgNameToId.set(orgName, orgId);
    orgIdToName.set(orgId, orgName);
  }
}

/**
 * Resolve an organization name to its stable ID if known, otherwise return the identifier.
 */
export function resolveOrgId(orgNameOrId: string): string {
  if (typeof orgNameOrId !== "string" || orgNameOrId === "") return "";
  return orgNameToId.get(orgNameOrId) ?? orgNameOrId;
}

/**
 * Resolve a stable organization ID to its display name if known, otherwise return the identifier.
 */
export function resolveOrgName(orgIdOrName: string): string {
  if (typeof orgIdOrName !== "string" || orgIdOrName === "") return "";
  return orgIdToName.get(orgIdOrName) ?? orgIdOrName;
}
