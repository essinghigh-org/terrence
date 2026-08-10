import { useEffect, useRef } from "react";

/**
 * Registry of active navigation guards. A guard returns true when navigation
 * may proceed. Every active dirty-form guard must consent before the URL
 * actually changes.
 */
type NavGuard = (nextUrl: string) => boolean;

const activeGuards = new Set<NavGuard>();

let historyPatched = false;

function installHistoryPatch(): void {
  if (historyPatched) return;
  historyPatched = true;

  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);

  const guardUrl = (url: string | URL | null | undefined): string => {
    if (url === undefined || url === null) return window.location.href;
    try {
      return new URL(String(url), window.location.href).href;
    } catch {
      return window.location.href;
    }
  };

  const runGuards = (target: string): boolean => {
    if (target === window.location.href) return true;
    for (const guard of activeGuards) {
      if (!guard(target)) return false;
    }
    return true;
  };

  window.history.pushState = function (
    this: History,
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    if (!runGuards(guardUrl(url))) return;
    originalPushState.call(this, data, unused, url);
  };

  window.history.replaceState = function (
    this: History,
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    if (!runGuards(guardUrl(url))) return;
    originalReplaceState.call(this, data, unused, url);
  };
}

/**
 * Warn before navigating away from a form with unsaved changes.
 *
 * Covers in-app navigation (guarded via a window.history.pushState /
 * replaceState patch, so it works with the app's declarative BrowserRouter —
 * react-router's data-router `useBlocker` would require converting the whole
 * route tree and would break every MemoryRouter-based unit test) and
 * full-page unloads (beforeunload).
 *
 * The history patch is installed once and consults a registry of active
 * guards, so it is completely inert while no form is dirty. Under
 * MemoryRouter (tests) the patch never fires, which keeps existing suites
 * passing unchanged.
 *
 * @param active true while the form has unsaved changes
 * @param message optional confirm() text for in-app navigation attempts
 */
export function useUnsavedChangesWarning(active: boolean, message?: string): void {
  installHistoryPatch();

  const messageRef = useRef(message);
  messageRef.current = message;

  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!active) return;

    const guard: NavGuard = (): boolean => {
      const text = messageRef.current ?? "You have unsaved changes. Leave anyway?";
      return window.confirm(text);
    };

    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      // Required by the spec for the browser to show its own confirmation
      // dialog on unload; the exact message is ignored by modern browsers.
      event.preventDefault();
    };

    activeGuards.add(guard);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      activeGuards.delete(guard);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [active]);
}