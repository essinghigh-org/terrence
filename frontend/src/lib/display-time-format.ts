/**
 * Display time format preference. Operators can choose 12-hour or 24-hour
 * timestamps; the default is 24-hour so times are never ambiguous (the
 * browser's default 12-hour cycle can render without an AM/PM suffix).
 * The preference is device-local (localStorage), like the display-timezone
 * and theme overrides, so it applies immediately without a server round-trip.
 */

export type DisplayTimeFormat = "12" | "24";

const TIME_FORMAT_STORAGE_KEY = "terrence-display-time-format";

const STORED_FORMATS: ReadonlySet<string> = new Set(["12", "24"]);

let currentFormat: DisplayTimeFormat = readStoredFormat();

function readStoredFormat(): DisplayTimeFormat {
  try {
    const stored = window.localStorage.getItem(TIME_FORMAT_STORAGE_KEY);
    // SAFETY: the stored preference is validated by the fallback below.
    return stored !== null && STORED_FORMATS.has(stored)
      ? (stored as DisplayTimeFormat)
      : "24";
  } catch {
    // Storage unavailable (privacy mode, SSR): default to 24-hour.
    return "24";
  }
}

const listeners = new Set<() => void>();

/** The hour-cycle flag to pass to Intl formatting, or undefined for the locale default. */
export function resolveDisplayTimeFormat(): "12" | "24" {
  return currentFormat;
}

export function getDisplayTimeFormat(): DisplayTimeFormat {
  return currentFormat;
}

export function setDisplayTimeFormat(format: DisplayTimeFormat): void {
  if (!STORED_FORMATS.has(format)) return;
  currentFormat = format;
  try {
    window.localStorage.setItem(TIME_FORMAT_STORAGE_KEY, format);
  } catch {
    // Preference still applies for this session when storage is unavailable.
  }
  for (const listener of listeners) listener();
}

export function subscribeDisplayTimeFormat(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}