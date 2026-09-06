import { getActiveUserId } from "./storage-identity";

/**
 * Persisted "last selected organization" (kanban 26.10, UI-30).
 *
 * Scoped to the active signed-in user so switching accounts on a shared browser
 * does not resume another user's private organization.
 */
export const LAST_ORG_STORAGE_KEY = "terrence-last-org";

function storeKey(): string {
  const userId = getActiveUserId();
  return userId !== null ? `${LAST_ORG_STORAGE_KEY}:${userId}` : LAST_ORG_STORAGE_KEY;
}

export function getLastOrganization(): string {
  try {
    const key = storeKey();
    const stored = window.localStorage.getItem(key);
    if (stored !== null && stored !== "") return stored;
    if (key !== LAST_ORG_STORAGE_KEY) {
      const legacy = window.localStorage.getItem(LAST_ORG_STORAGE_KEY);
      if (legacy !== null && legacy !== "") {
        window.localStorage.setItem(key, legacy);
        window.localStorage.removeItem(LAST_ORG_STORAGE_KEY);
        return legacy;
      }
    }
    return "";
  } catch {
    return "";
  }
}

export function setLastOrganization(orgName: string): void {
  try {
    window.localStorage.setItem(storeKey(), orgName);
  } catch {
    // localStorage can be unavailable (private mode / storage disabled);
    // the preference is a convenience, not a requirement.
  }
}