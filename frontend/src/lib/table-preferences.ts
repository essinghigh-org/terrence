import type { TableDensity } from "@/components/ui/table";
import { isRecord, isString } from "../lib/type-guards";

/**
 * Per-view table preferences (kanban 14.22). Column visibility and density
 * choices are stored per view id so operators do not have to reset their
 * layout on every visit. Local-only, same as the other UI preferences
 * (theme, timezone, sidebar collapse); there is deliberately no server-side
 * settings table for this.
 */
export type TablePreferences = Readonly<{
  density: TableDensity;
  visibleColumns: readonly string[];
}>;

const TABLE_PREFS_PREFIX = "terrence-table-prefs:";

function storeKey(viewId: string): string {
  return `${TABLE_PREFS_PREFIX}${viewId}`;
}

export function getTablePreferences(viewId: string): TablePreferences | null {
  try {
    const raw = window.localStorage.getItem(storeKey(viewId));
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