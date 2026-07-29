export type ThemeMode = "light";

export function getStoredThemeMode(): ThemeMode {
  return "light";
}

export function applyThemeMode(_mode?: unknown): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.remove("dark");
  try {
    window.localStorage.removeItem("terrence-theme-mode");
  } catch {}
}
