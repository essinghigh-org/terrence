import { isRecord, isString } from "../lib/type-guards";
import { getActiveUserId, resolveOrgId } from "./storage-identity";

/**
 * Named saved views for the workspace explorer (kanban 14.10, UI-30).
 *
 * Operators can pin useful filter combinations as named views (e.g.
 * "Production attention", "Errored infra"). Views are scoped by user identity
 * and stable organization ID so organization renames preserve views and
 * different user accounts on the same browser do not collide.
 */
export type SavedView = Readonly<{
  name: string;
  search: string;
  statusFilter: string;
  projectFilter: string;
}>;

const SAVED_VIEWS_PREFIX = "terrence-saved-views:";

function storeKey(orgIdentifier: string): string {
  const orgId = resolveOrgId(orgIdentifier) || orgIdentifier;
  const userId = getActiveUserId();
  return userId !== null ? `${SAVED_VIEWS_PREFIX}${userId}:${orgId}` : `${SAVED_VIEWS_PREFIX}${orgId}`;
}

/** True when the localStorage entry carries the SavedView fields. */
function isSavedView(view: unknown): view is SavedView {
  if (!isRecord(view)) return false;
  // SAFETY: only the checked fields are read; the object may carry arbitrary
  // extra fields written by older app versions or other tabs.
  const candidate = view as { name?: unknown; search?: unknown; statusFilter?: unknown; projectFilter?: unknown };
  return isString(candidate.name)
    && isString(candidate.search)
    && isString(candidate.statusFilter)
    && isString(candidate.projectFilter);
}

function parseViews(raw: string | null): SavedView[] {
  if (raw === null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedView);
  } catch {
    return [];
  }
}

export function getSavedViews(orgIdentifier: string): SavedView[] {
  try {
    const key = storeKey(orgIdentifier);
    let raw = window.localStorage.getItem(key);
    if (raw === null || raw === "") {
      // Legacy migration checks:
      // 1. Un-namespaced key with resolved orgId
      // 2. Un-namespaced key with orgIdentifier (legacy orgName key)
      const orgId = resolveOrgId(orgIdentifier) || orgIdentifier;
      const candidates = [
        `${SAVED_VIEWS_PREFIX}${orgId}`,
        `${SAVED_VIEWS_PREFIX}${orgIdentifier}`,
      ];
      for (const legacyKey of candidates) {
        if (legacyKey !== key) {
          const legacyRaw = window.localStorage.getItem(legacyKey);
          if (legacyRaw !== null && legacyRaw !== "") {
            window.localStorage.setItem(key, legacyRaw);
            window.localStorage.removeItem(legacyKey);
            raw = legacyRaw;
            break;
          }
        }
      }
    }
    return parseViews(raw);
  } catch {
    return [];
  }
}

export function saveView(orgIdentifier: string, view: SavedView): SavedView[] {
  const views = [...getSavedViews(orgIdentifier).filter((existing): boolean => existing.name !== view.name), view];
  try {
    window.localStorage.setItem(storeKey(orgIdentifier), JSON.stringify(views));
  } catch {
    // localStorage unavailable; views are a convenience.
  }
  return views;
}

export function deleteView(orgIdentifier: string, name: string): SavedView[] {
  const views = getSavedViews(orgIdentifier).filter((view): boolean => view.name !== name);
  try {
    window.localStorage.setItem(storeKey(orgIdentifier), JSON.stringify(views));
  } catch {
    // localStorage unavailable; views are a convenience.
  }
  return views;
}