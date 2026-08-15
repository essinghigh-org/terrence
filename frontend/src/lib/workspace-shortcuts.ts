/**
 * Recent and pinned workspace shortcuts (kanban 26.11, 26.12).
 *
 * Both are operator-local conveniences (like theme/timezone preferences):
 * recent visits and pinned workspaces are kept in localStorage so the
 * sidebar can offer one-click navigation. They are deliberately not
 * server-side: there is no per-user settings table for cross-device sync.
 */
export type WorkspaceVisit = Readonly<{
  orgName: string;
  workspaceName: string;
  visitedAt: number;
}>;

const RECENT_KEY = "terrence-recent-workspaces";
const PINNED_KEY = "terrence-pinned-workspaces";
const MAX_RECENT = 8;

type ShortcutListener = () => void;
const listeners = new Set<ShortcutListener>();

/** Subscribe to recent/pinned shortcut changes (Layout refreshes its sidebar). */
export function subscribeWorkspaceShortcuts(listener: ShortcutListener): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

function notifyShortcutChange(): void {
  for (const listener of listeners) listener();
}

/** True when the localStorage entry carries the three WorkspaceVisit fields. */
function isWorkspaceVisit(entry: unknown): entry is WorkspaceVisit {
  if (typeof entry !== "object" || entry === null) return false;
  // SAFETY: only the checked fields are read; the object may carry arbitrary
  // extra fields written by older app versions or other tabs.
  const visit = entry as { orgName?: unknown; workspaceName?: unknown; visitedAt?: unknown };
  return typeof visit.orgName === "string"
    && typeof visit.workspaceName === "string"
    && typeof visit.visitedAt === "number";
}

export function getRecentWorkspaces(): WorkspaceVisit[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (raw === null || raw === "") return [];
    // SAFETY: localStorage content is untrusted; Array.isArray plus
    // isWorkspaceVisit validate the shape before any field is used.
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isWorkspaceVisit)
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** Record a workspace visit; the most recent visit moves to the front. */
export function recordWorkspaceVisit(orgName: string, workspaceName: string): void {
  try {
    const entries = getRecentWorkspaces().filter(
      (entry): boolean => entry.orgName !== orgName || entry.workspaceName !== workspaceName,
    );
    entries.unshift({ orgName, workspaceName, visitedAt: Date.now() });
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(entries.slice(0, MAX_RECENT)));
    notifyShortcutChange();
  } catch {
    // localStorage unavailable; shortcuts are a convenience.
  }
}

export function getPinnedWorkspaces(): WorkspaceVisit[] {
  try {
    const raw = window.localStorage.getItem(PINNED_KEY);
    if (raw === null || raw === "") return [];
    // SAFETY: localStorage content is untrusted; Array.isArray plus
    // isWorkspaceVisit validate the shape before any field is used.
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isWorkspaceVisit)
      .map((entry): WorkspaceVisit => ({ ...entry, visitedAt: 0 }));
  } catch {
    return [];
  }
}

export function isWorkspacePinned(orgName: string, workspaceName: string): boolean {
  return getPinnedWorkspaces().some(
    (entry): boolean => entry.orgName === orgName && entry.workspaceName === workspaceName,
  );
}

export function setWorkspacePinned(orgName: string, workspaceName: string, pinned: boolean): void {
  try {
    const entries = getPinnedWorkspaces().filter(
      (entry): boolean => entry.orgName !== orgName || entry.workspaceName !== workspaceName,
    );
    if (pinned) entries.push({ orgName, workspaceName, visitedAt: 0 });
    window.localStorage.setItem(PINNED_KEY, JSON.stringify(entries));
    notifyShortcutChange();
  } catch {
    // localStorage unavailable; shortcuts are a convenience.
  }
}