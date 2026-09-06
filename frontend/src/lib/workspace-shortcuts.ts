import { isNumber, isRecord, isString } from "../lib/type-guards";
import { getActiveUserId, subscribeStorageIdentity } from "./storage-identity";

/**
 * Recent and pinned workspace shortcuts (kanban 26.11, 26.12, UI-30).
 *
 * Recent visits and pinned workspaces are scoped to the active signed-in user
 * identity so multi-tenant/shared browsers do not leak workspace names across
 * accounts. When logged out, shortcuts default to empty.
 */
export type WorkspaceVisit = Readonly<{
  orgName: string;
  workspaceName: string;
  visitedAt: number;
}>;

const LEGACY_RECENT_KEY = "terrence-recent-workspaces";
const LEGACY_PINNED_KEY = "terrence-pinned-workspaces";
const SINGLE_KEY_SHORTCUTS_KEY = "terrence-single-key-shortcuts";
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

/** Optional one-key navigation is enabled by default and can be disabled for
 * operators who use assistive technology or type non-US keyboard layouts. */
export function getSingleKeyShortcutsEnabled(): boolean {
  try {
    return window.localStorage.getItem(SINGLE_KEY_SHORTCUTS_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setSingleKeyShortcutsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(SINGLE_KEY_SHORTCUTS_KEY, String(enabled));
  } catch {
    // The preference remains at its default for this session when storage is unavailable.
  }
  notifyShortcutChange();
}

// Re-notify shortcut listeners whenever the active user identity changes (e.g. login/logout).
subscribeStorageIdentity((): void => {
  notifyShortcutChange();
});

function getRecentKey(): string {
  const userId = getActiveUserId();
  return userId !== null ? `${LEGACY_RECENT_KEY}:${userId}` : LEGACY_RECENT_KEY;
}

function getPinnedKey(): string {
  const userId = getActiveUserId();
  return userId !== null ? `${LEGACY_PINNED_KEY}:${userId}` : LEGACY_PINNED_KEY;
}

/** True when the localStorage entry carries the three WorkspaceVisit fields. */
function isWorkspaceVisit(entry: unknown): entry is WorkspaceVisit {
  if (!isRecord(entry)) return false;
  // SAFETY: only the checked fields are read; the object may carry arbitrary
  // extra fields written by older app versions or other tabs.
  const visit = entry as { orgName?: unknown; workspaceName?: unknown; visitedAt?: unknown };
  return isString(visit.orgName)
    && isString(visit.workspaceName)
    && isNumber(visit.visitedAt);
}

function parseVisits(raw: string | null): WorkspaceVisit[] {
  if (raw === null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWorkspaceVisit);
  } catch {
    return [];
  }
}

export function getRecentWorkspaces(): WorkspaceVisit[] {
  try {
    const key = getRecentKey();
    let raw = window.localStorage.getItem(key);
    if ((raw === null || raw === "") && key !== LEGACY_RECENT_KEY) {
      // Legacy migration: if user is active but no user-scoped recents exist yet,
      // migrate from legacy un-namespaced key once.
      const legacyRaw = window.localStorage.getItem(LEGACY_RECENT_KEY);
      if (legacyRaw !== null && legacyRaw !== "") {
        window.localStorage.setItem(key, legacyRaw);
        window.localStorage.removeItem(LEGACY_RECENT_KEY);
        raw = legacyRaw;
      }
    }
    return parseVisits(raw).slice(0, MAX_RECENT);
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
    window.localStorage.setItem(getRecentKey(), JSON.stringify(entries.slice(0, MAX_RECENT)));
    notifyShortcutChange();
  } catch {
    // localStorage unavailable; shortcuts are a convenience.
  }
}

export function getPinnedWorkspaces(): WorkspaceVisit[] {
  try {
    const key = getPinnedKey();
    let raw = window.localStorage.getItem(key);
    if ((raw === null || raw === "") && key !== LEGACY_PINNED_KEY) {
      const legacyRaw = window.localStorage.getItem(LEGACY_PINNED_KEY);
      if (legacyRaw !== null && legacyRaw !== "") {
        window.localStorage.setItem(key, legacyRaw);
        window.localStorage.removeItem(LEGACY_PINNED_KEY);
        raw = legacyRaw;
      }
    }
    return parseVisits(raw).map((entry): WorkspaceVisit => ({ ...entry, visitedAt: 0 }));
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
    const key = getPinnedKey();
    const entries = getPinnedWorkspaces().filter(
      (entry): boolean => entry.orgName !== orgName || entry.workspaceName !== workspaceName,
    );
    if (pinned) entries.push({ orgName, workspaceName, visitedAt: 0 });
    window.localStorage.setItem(key, JSON.stringify(entries));
    notifyShortcutChange();
  } catch {
    // localStorage unavailable; shortcuts are a convenience.
  }
}
