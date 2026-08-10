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

export function getRecentWorkspaces(): WorkspaceVisit[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (raw === null || raw === "") return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is WorkspaceVisit =>
        typeof entry === "object"
        && entry !== null
        && typeof (entry as WorkspaceVisit).orgName === "string"
        && typeof (entry as WorkspaceVisit).workspaceName === "string"
        && typeof (entry as WorkspaceVisit).visitedAt === "number")
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
  } catch {
    // localStorage unavailable; shortcuts are a convenience.
  }
}

export function getPinnedWorkspaces(): WorkspaceVisit[] {
  try {
    const raw = window.localStorage.getItem(PINNED_KEY);
    if (raw === null || raw === "") return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is WorkspaceVisit =>
        typeof entry === "object"
        && entry !== null
        && typeof (entry as WorkspaceVisit).orgName === "string"
        && typeof (entry as WorkspaceVisit).workspaceName === "string")
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
  } catch {
    // localStorage unavailable; shortcuts are a convenience.
  }
}