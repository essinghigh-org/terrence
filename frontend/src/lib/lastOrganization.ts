/**
 * Persisted "last selected organization" (kanban 26.10).
 *
 * Layout writes the currently active organization name whenever an org-scoped
 * route is rendered, and Dashboard reads it to resume the operator's last
 * organization on a fresh page load (it never overrides an explicit picker
 * navigation).
 */
export const LAST_ORG_STORAGE_KEY = "terrence-last-org";

export function getLastOrganization(): string {
  try {
    return window.localStorage.getItem(LAST_ORG_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setLastOrganization(orgName: string): void {
  try {
    window.localStorage.setItem(LAST_ORG_STORAGE_KEY, orgName);
  } catch {
    // localStorage can be unavailable (private mode / storage disabled);
    // the preference is a convenience, not a requirement.
  }
}