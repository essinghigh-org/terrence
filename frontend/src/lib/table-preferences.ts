import type { TableDensity } from "@/components/ui/table";
import { isRecord, isString } from "../lib/type-guards";
import { getActiveUserId } from "./storage-identity";

/**
 * Per-view table preferences (kanban 14.22, UI-30). Column visibility and density
 * choices are stored per view id so operators do not have to reset their
 * layout on every visit. Preferences are namespaced by the active user identity
 * with fallback to device-local preferences.
 */
export type TablePreferences = Readonly<{
  density: TableDensity;
  visibleColumns: readonly string[];
}>;

export const TABLE_PREFS_PREFIX = "terrence-table-prefs:";

function storeKey(viewId: string): string {
  const userId = getActiveUserId();
  return userId !== null ? `${TABLE_PREFS_PREFIX}${userId}:${viewId}` : `${TABLE_PREFS_PREFIX}${viewId}`;
}

export function getTablePreferences(viewId: string): TablePreferences | null {
  try {
    const key = storeKey(viewId);
    let raw = window.localStorage.getItem(key);
    if ((raw === null || raw === "") && key !== `${TABLE_PREFS_PREFIX}${viewId}`) {
      const legacyRaw = window.localStorage.getItem(`${TABLE_PREFS_PREFIX}${viewId}`);
      if (legacyRaw !== null && legacyRaw !== "") {
        window.localStorage.setItem(key, legacyRaw);
        window.localStorage.removeItem(`${TABLE_PREFS_PREFIX}${viewId}`);
        raw = legacyRaw;
      }
    }
    if (raw === null || raw === "") return null;
    // SAFETY: localStorage content is untrusted; the parsed object is
    // field-validated below before any value is used.
    const parsed = JSON.parse(raw) as Partial<TablePreferences>;
    if (!isRecord(parsed)) return null;
    const density: TableDensity = parsed["density"] === "dense" ? "dense" : "comfortable";
    const rawVisibleColumns = parsed["visibleColumns"];
    const visibleColumns = Array.isArray(rawVisibleColumns)
      ? rawVisibleColumns.filter((value): value is string => isString(value))
      : [];
    if (visibleColumns.length === 0 && parsed["density"] === undefined) return null;
    return { density, visibleColumns };
  } catch {
    return null;
  }
}

export function setTablePreferences(viewId: string, preferences: Readonly<TablePreferences>): void {
  try {
    window.localStorage.setItem(storeKey(viewId), JSON.stringify(preferences));
  } catch {
    // localStorage can be unavailable (private mode / storage disabled);
    // preferences are a convenience, not a requirement.
  }
}