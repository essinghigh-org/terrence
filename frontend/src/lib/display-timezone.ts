/**
 * Display timezone preference (review item 14.24). Operators can pin the UI
 * to UTC timestamps instead of the browser's local timezone. The preference
 * is device-local (localStorage), like the theme override, so it applies
 * immediately without a server round-trip.
 */

export type DisplayTimezone = "local" | "utc";

const TIMEZONE_STORAGE_KEY = "terrence-display-timezone";

const STORED_TIMEZONES: ReadonlySet<string> = new Set(["local", "utc"]);

let currentTimezone: DisplayTimezone = readStoredTimezone();

function readStoredTimezone(): DisplayTimezone {
  try {
    const stored = window.localStorage.getItem(TIMEZONE_STORAGE_KEY);
    return stored !== null && STORED_TIMEZONES.has(stored)
      ? (stored as DisplayTimezone)
      : "local";
  } catch {
    // Storage unavailable (privacy mode, SSR): default to local timezone.
    return "local";
  }
}

const listeners = new Set<() => void>();

/** The IANA timezone to pass to Intl formatting, or undefined for browser-local. */
export function resolveDisplayTimeZone(): string | undefined {
  return currentTimezone === "utc" ? "UTC" : undefined;
}

export function getDisplayTimezone(): DisplayTimezone {
  return currentTimezone;
}

export function setDisplayTimezone(timezone: DisplayTimezone): void {
  if (!STORED_TIMEZONES.has(timezone)) return;
  currentTimezone = timezone;
  try {
    window.localStorage.setItem(TIMEZONE_STORAGE_KEY, timezone);
  } catch {
    // Preference still applies for this session when storage is unavailable.
  }
  for (const listener of listeners) listener();
}

export function subscribeDisplayTimezone(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}