export type ThemeMode = "light" | "dark" | "system";

const THEME_STORAGE_KEY = "terrence-theme-mode";

export function getStoredThemeMode(): ThemeMode {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") {
      return value;
    }
  } catch {
    // Return system when localStorage is disabled
  }
  return "system";
}

export function applyThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Ignore storage errors
  }

  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const isSystemDark =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;

  const isDark = mode === "dark" || (mode === "system" && isSystemDark);

  if (isDark) {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}
