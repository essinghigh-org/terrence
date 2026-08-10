/**
 * Named saved views for the workspace explorer (kanban 14.10).
 *
 * Operators can pin useful filter combinations as named views (e.g.
 * "Production attention", "Errored infra"). Views are org-scoped and kept
 * locally, mirroring the other UI preferences (theme, timezone, table
 * density); there is deliberately no server-side settings table.
 */
export type SavedView = Readonly<{
  name: string;
  search: string;
  statusFilter: string;
  projectFilter: string;
}>;

const SAVED_VIEWS_PREFIX = "terrence-saved-views:";

function storeKey(orgName: string): string {
  return `${SAVED_VIEWS_PREFIX}${orgName}`;
}

export function getSavedViews(orgName: string): SavedView[] {
  try {
    const raw = window.localStorage.getItem(storeKey(orgName));
    if (raw === null || raw === "") return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((view): view is SavedView =>
        typeof view === "object"
        && view !== null
        && typeof (view as SavedView).name === "string"
        && typeof (view as SavedView).search === "string"
        && typeof (view as SavedView).statusFilter === "string"
        && typeof (view as SavedView).projectFilter === "string");
  } catch {
    return [];
  }
}

export function saveView(orgName: string, view: SavedView): SavedView[] {
  const views = [...getSavedViews(orgName).filter((existing): boolean => existing.name !== view.name), view];
  try {
    window.localStorage.setItem(storeKey(orgName), JSON.stringify(views));
  } catch {
    // localStorage unavailable; views are a convenience.
  }
  return views;
}

export function deleteView(orgName: string, name: string): SavedView[] {
  const views = getSavedViews(orgName).filter((view): boolean => view.name !== name);
  try {
    window.localStorage.setItem(storeKey(orgName), JSON.stringify(views));
  } catch {
    // localStorage unavailable; views are a convenience.
  }
  return views;
}