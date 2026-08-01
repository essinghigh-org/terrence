export type ThemeMode = "light" | "dark";
export type ThemeId = string;

export type ThemeDefinition = Readonly<{
  readonly id: ThemeId;
  readonly label: string;
  readonly mode: ThemeMode;
  readonly colors: Readonly<Record<string, string>>;
}>;

type ThemeInput = Readonly<{
  readonly background: string;
  readonly foreground: string;
  readonly primary: string;
  readonly primaryForeground: string;
  readonly secondary: string;
  readonly secondaryForeground: string;
  readonly muted: string;
  readonly mutedForeground: string;
  readonly accent: string;
  readonly accentForeground: string;
  readonly destructive: string;
  readonly destructiveForeground: string;
  readonly border: string;
  readonly input: string;
  readonly success: string;
  readonly warning: string;
  readonly codeBackground: string;
  readonly codeForeground: string;
  readonly card?: string;
  readonly cardForeground?: string;
  readonly popover?: string;
  readonly popoverForeground?: string;
  readonly ring?: string;
}>;

function createTheme(
  id: string,
  label: string,
  mode: ThemeMode,
  input: ThemeInput,
): ThemeDefinition {
  const card = input.card ?? input.background;
  const cardForeground = input.cardForeground ?? input.foreground;
  const popover = input.popover ?? card;
  const popoverForeground = input.popoverForeground ?? cardForeground;

  return {
    id,
    label,
    mode,
    colors: {
      background: input.background,
      foreground: input.foreground,
      card,
      "card-foreground": cardForeground,
      popover,
      "popover-foreground": popoverForeground,
      primary: input.primary,
      "primary-foreground": input.primaryForeground,
      secondary: input.secondary,
      "secondary-foreground": input.secondaryForeground,
      muted: input.muted,
      "muted-foreground": input.mutedForeground,
      accent: input.accent,
      "accent-foreground": input.accentForeground,
      destructive: input.destructive,
      "destructive-foreground": input.destructiveForeground,
      border: input.border,
      input: input.input,
      ring: input.ring ?? input.primary,
      success: input.success,
      warning: input.warning,
      "code-background": input.codeBackground,
      "code-foreground": input.codeForeground,
    },
  };
}

export const THEMES: readonly ThemeDefinition[] = [
  createTheme("original-light", "Original", "light", {
    background: "0 0% 100%", foreground: "220 7% 13%", primary: "217 100% 53%", primaryForeground: "0 0% 100%",
    secondary: "220 10% 95%", secondaryForeground: "220 7% 13%", muted: "220 9% 96%", mutedForeground: "220 7% 40%",
    accent: "216 100% 96%", accentForeground: "217 100% 42%", destructive: "358 78% 51%", destructiveForeground: "0 0% 100%",
    border: "225 8% 88%", input: "223 8% 68%", success: "142 60% 38%", warning: "38 92% 50%",
    codeBackground: "220 7% 13%", codeForeground: "220 20% 92%",
  }),
  createTheme("catppuccin-latte", "Catppuccin Latte", "light", {
    background: "220 23% 95%", foreground: "234 16% 35%", card: "220 22% 98%", primary: "220 91% 54%", primaryForeground: "220 23% 95%",
    secondary: "220 22% 91%", secondaryForeground: "234 16% 35%", muted: "220 22% 91%", mutedForeground: "233 13% 53%",
    accent: "221 100% 94%", accentForeground: "220 91% 44%", destructive: "347 87% 44%", destructiveForeground: "220 23% 95%",
    border: "220 17% 84%", input: "233 13% 65%", success: "109 58% 40%", warning: "22 99% 52%",
    codeBackground: "234 16% 20%", codeForeground: "220 23% 95%",
  }),
  createTheme("tokyo-day", "Tokyo Day", "light", {
    background: "220 13% 94%", foreground: "229 25% 28%", card: "0 0% 100%", primary: "211 80% 55%", primaryForeground: "0 0% 100%",
    secondary: "220 17% 88%", secondaryForeground: "229 25% 28%", muted: "220 14% 91%", mutedForeground: "229 20% 45%",
    accent: "211 80% 93%", accentForeground: "211 80% 42%", destructive: "349 90% 57%", destructiveForeground: "0 0% 100%",
    border: "222 12% 84%", input: "222 15% 62%", success: "100 45% 42%", warning: "35 80% 48%",
    codeBackground: "229 25% 18%", codeForeground: "220 13% 94%",
  }),
  createTheme("nord-light", "Nord Light", "light", {
    background: "220 16% 92%", foreground: "220 16% 22%", card: "218 27% 96%", popover: "0 0% 100%", primary: "213 32% 52%", primaryForeground: "220 16% 98%",
    secondary: "218 27% 86%", secondaryForeground: "220 16% 22%", muted: "218 27% 91%", mutedForeground: "220 16% 36%",
    accent: "213 32% 90%", accentForeground: "213 32% 42%", destructive: "354 42% 56%", destructiveForeground: "220 16% 98%",
    border: "218 27% 86%", input: "220 16% 52%", success: "92 28% 45%", warning: "40 63% 50%",
    codeBackground: "220 16% 22%", codeForeground: "218 27% 94%",
  }),
  createTheme("rose-pine-dawn", "Rosé Pine Dawn", "light", {
    background: "35 45% 95%", foreground: "248 19% 40%", card: "35 67% 98%", primary: "267 22% 57%", primaryForeground: "35 45% 95%",
    secondary: "35 36% 90%", secondaryForeground: "248 19% 40%", muted: "35 36% 90%", mutedForeground: "249 12% 52%",
    accent: "4 53% 67%", accentForeground: "248 19% 30%", destructive: "343 36% 55%", destructiveForeground: "35 67% 98%",
    border: "30 18% 86%", input: "249 12% 55%", success: "197 53% 34%", warning: "35 77% 50%",
    codeBackground: "248 19% 25%", codeForeground: "35 45% 95%",
  }),
  createTheme("solarized-light", "Solarized Light", "light", {
    background: "44 80% 94%", foreground: "194 14% 45%", card: "45 43% 89%", primary: "205 69% 49%", primaryForeground: "44 80% 97%",
    secondary: "45 43% 89%", secondaryForeground: "192 81% 14%", muted: "45 43% 89%", mutedForeground: "194 14% 56%",
    accent: "45 100% 35%", accentForeground: "44 80% 97%", destructive: "1 71% 52%", destructiveForeground: "44 80% 97%",
    border: "44 37% 80%", input: "194 14% 45%", success: "68 100% 30%", warning: "18 80% 44%",
    codeBackground: "192 81% 14%", codeForeground: "44 80% 94%",
  }),
  createTheme("original-dark", "Original", "dark", {
    background: "222 15% 11%", foreground: "210 20% 96%", card: "222 15% 14%", popover: "222 15% 16%", primary: "217 100% 65%", primaryForeground: "222 30% 10%",
    secondary: "220 14% 22%", secondaryForeground: "210 20% 96%", muted: "220 13% 20%", mutedForeground: "220 10% 68%",
    accent: "217 70% 24%", accentForeground: "214 100% 78%", destructive: "0 72% 60%", destructiveForeground: "0 0% 100%",
    border: "220 12% 25%", input: "220 12% 34%", success: "142 60% 52%", warning: "38 92% 62%",
    codeBackground: "222 30% 7%", codeForeground: "210 20% 92%",
  }),
  createTheme("catppuccin-mocha", "Catppuccin Mocha", "dark", {
    background: "240 21% 15%", foreground: "227 68% 88%", card: "240 21% 18%", popover: "240 21% 23%", primary: "217 92% 76%", primaryForeground: "240 21% 15%",
    secondary: "240 21% 23%", secondaryForeground: "227 68% 88%", muted: "240 21% 23%", mutedForeground: "231 15% 56%",
    accent: "189 71% 73%", accentForeground: "240 21% 15%", destructive: "343 81% 75%", destructiveForeground: "240 21% 15%",
    border: "240 21% 28%", input: "231 15% 56%", success: "115 54% 76%", warning: "41 86% 83%",
    codeBackground: "240 23% 10%", codeForeground: "227 68% 88%",
  }),
  createTheme("tokyo-night", "Tokyo Night", "dark", {
    background: "235 21% 15%", foreground: "229 73% 86%", card: "240 13% 10%", popover: "228 21% 18%", primary: "218 89% 72%", primaryForeground: "235 21% 15%",
    secondary: "226 22% 21%", secondaryForeground: "229 73% 86%", muted: "228 21% 18%", mutedForeground: "228 24% 57%",
    accent: "187 72% 52%", accentForeground: "235 21% 15%", destructive: "349 89% 72%", destructiveForeground: "235 21% 15%",
    border: "226 25% 31%", input: "226 25% 44%", success: "90 54% 61%", warning: "35 67% 64%",
    codeBackground: "240 13% 10%", codeForeground: "229 73% 86%",
  }),
  createTheme("dracula", "Dracula", "dark", {
    background: "231 15% 18%", foreground: "60 30% 96%", card: "232 18% 15%", popover: "232 19% 31%", primary: "265 89% 78%", primaryForeground: "231 15% 18%",
    secondary: "232 19% 31%", secondaryForeground: "60 30% 96%", muted: "231 17% 25%", mutedForeground: "233 15% 73%",
    accent: "191 97% 77%", accentForeground: "231 15% 18%", destructive: "0 100% 67%", destructiveForeground: "231 15% 18%",
    border: "232 19% 36%", input: "225 27% 52%", success: "135 94% 65%", warning: "31 100% 71%",
    codeBackground: "231 15% 10%", codeForeground: "60 30% 96%",
  }),
  createTheme("nord-dark", "Nord Dark", "dark", {
    background: "220 16% 22%", foreground: "218 27% 94%", card: "220 16% 28%", popover: "220 16% 32%", primary: "193 43% 67%", primaryForeground: "220 16% 22%",
    secondary: "220 16% 32%", secondaryForeground: "218 27% 94%", muted: "220 16% 28%", mutedForeground: "218 27% 89%",
    accent: "213 32% 63%", accentForeground: "220 16% 22%", destructive: "354 42% 56%", destructiveForeground: "218 27% 94%",
    border: "220 16% 36%", input: "220 16% 52%", success: "92 28% 64%", warning: "40 63% 73%",
    codeBackground: "220 16% 16%", codeForeground: "218 27% 94%",
  }),
  createTheme("rose-pine", "Rosé Pine", "dark", {
    background: "249 22% 15%", foreground: "245 50% 91%", card: "249 22% 18%", popover: "248 15% 23%", primary: "267 57% 78%", primaryForeground: "249 22% 15%",
    secondary: "248 15% 23%", secondaryForeground: "245 50% 91%", muted: "248 15% 23%", mutedForeground: "249 12% 61%",
    accent: "4 59% 83%", accentForeground: "249 22% 15%", destructive: "343 74% 68%", destructiveForeground: "249 22% 15%",
    border: "249 18% 29%", input: "249 12% 50%", success: "197 49% 49%", warning: "35 88% 73%",
    codeBackground: "249 22% 10%", codeForeground: "245 50% 91%",
  }),
  createTheme("gruvbox-dark", "Gruvbox Dark", "dark", {
    background: "0 0% 16%", foreground: "43 59% 81%", card: "20 7% 22%", popover: "21 9% 30%", primary: "187 39% 58%", primaryForeground: "0 0% 16%",
    secondary: "21 9% 30%", secondaryForeground: "43 59% 81%", muted: "20 7% 22%", mutedForeground: "35 28% 67%",
    accent: "40 66% 49%", accentForeground: "0 0% 16%", destructive: "6 93% 59%", destructiveForeground: "0 0% 16%",
    border: "35 28% 35%", input: "35 28% 45%", success: "61 66% 44%", warning: "39 80% 55%",
    codeBackground: "0 0% 10%", codeForeground: "43 59% 81%",
  }),
  createTheme("solarized-dark", "Solarized Dark", "dark", {
    background: "192 100% 11%", foreground: "194 14% 56%", card: "192 81% 14%", popover: "192 81% 18%", primary: "205 69% 49%", primaryForeground: "192 100% 11%",
    secondary: "192 81% 18%", secondaryForeground: "44 80% 94%", muted: "192 81% 14%", mutedForeground: "194 14% 64%",
    accent: "45 100% 35%", accentForeground: "44 80% 94%", destructive: "1 71% 52%", destructiveForeground: "44 80% 94%",
    border: "194 14% 35%", input: "194 14% 45%", success: "68 100% 30%", warning: "18 80% 44%",
    codeBackground: "192 100% 8%", codeForeground: "44 80% 94%",
  }),
];

export const DEFAULT_THEME_ID = "original-light";
const THEME_STORAGE_KEY = "terrence-theme";
const LEGACY_THEME_STORAGE_KEY = "terrence-theme-mode";
const themesById = new Map(THEMES.map((theme): [string, ThemeDefinition] => [theme.id, theme]));
let themeRevision = 0;
const defaultTheme = ((): ThemeDefinition => {
  const theme = THEMES.find((candidate): boolean => candidate.id === DEFAULT_THEME_ID);
  if (theme === undefined) throw new Error("Default theme is missing");
  return theme;
})();

const color = (name: string): string => `hsl(var(--${name}))`;
const tint = (name: string, amount: number): string =>
  `color-mix(in srgb, ${color(name)} ${amount}%, ${color("background")})`;

// The older UI uses Tailwind's gray/status palette directly. These aliases keep it
// in the selected theme until those components are moved to semantic classes.
const legacyPalette: Readonly<Record<string, string>> = {
  "color-white": color("card"),
  "color-black": color("code-background"),
  "color-gray-50": color("background"),
  "color-gray-100": color("muted"),
  "color-gray-200": color("border"),
  "color-gray-300": color("input"),
  "color-gray-400": color("muted-foreground"),
  "color-gray-500": color("muted-foreground"),
  "color-gray-600": color("foreground"),
  "color-gray-700": color("foreground"),
  "color-gray-800": color("foreground"),
  "color-gray-900": color("foreground"),
  "color-gray-950": color("foreground"),
  "color-slate-50": color("background"),
  "color-slate-100": color("code-foreground"),
  "color-slate-200": color("border"),
  "color-slate-700": color("foreground"),
  "color-slate-900": color("code-background"),
  "color-neutral-100": color("code-foreground"),
  "color-neutral-300": color("code-foreground"),
  "color-neutral-500": color("muted-foreground"),
  "color-neutral-700": color("code-background"),
  "color-neutral-800": color("code-background"),
  "color-neutral-900": color("code-background"),
  "color-neutral-950": color("code-background"),
  "color-red-50": tint("destructive", 8),
  "color-red-100": tint("destructive", 14),
  "color-red-200": tint("destructive", 24),
  "color-red-300": tint("destructive", 38),
  "color-red-600": color("destructive"),
  "color-red-700": color("destructive"),
  "color-red-800": color("destructive"),
  "color-red-900": color("destructive"),
  "color-amber-50": tint("warning", 8),
  "color-amber-200": tint("warning", 24),
  "color-amber-300": tint("warning", 38),
  "color-amber-400": color("warning"),
  "color-amber-500": color("warning"),
  "color-amber-600": color("warning"),
  "color-amber-700": color("warning"),
  "color-amber-800": color("warning"),
  "color-amber-900": color("warning"),
  "color-amber-950": tint("warning", 60),
  "color-blue-50": tint("primary", 8),
  "color-blue-100": tint("primary", 14),
  "color-blue-200": tint("primary", 24),
  "color-blue-300": tint("primary", 38),
  "color-blue-400": color("primary"),
  "color-blue-500": color("primary"),
  "color-blue-600": color("primary"),
  "color-blue-700": color("primary"),
  "color-blue-800": color("primary"),
  "color-green-50": tint("success", 8),
  "color-green-200": tint("success", 24),
  "color-green-700": color("success"),
  "color-green-800": color("success"),
  "color-emerald-50": tint("success", 8),
  "color-emerald-100": tint("success", 14),
  "color-emerald-300": tint("success", 38),
  "color-emerald-400": color("success"),
  "color-emerald-500": color("success"),
  "color-emerald-600": color("success"),
  "color-emerald-700": color("success"),
  "color-emerald-800": color("success"),
  "color-emerald-950": tint("success", 60),
  "color-purple-50": tint("accent", 8),
  "color-purple-200": tint("accent", 24),
  "color-purple-700": color("accent"),
  "color-sky-300": color("primary"),
  "color-sky-400": color("primary"),
};

export function getTheme(themeId: unknown): ThemeDefinition {
  return typeof themeId === "string" ? themesById.get(themeId) ?? defaultTheme : defaultTheme;
}

export function getThemeRevision(): number {
  return themeRevision;
}

export function getStoredThemeId(): ThemeId {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored !== null) return getTheme(stored).id;
    return window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY) === "dark"
      ? "original-dark"
      : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function applyTheme(themeId?: unknown): ThemeId {
  const theme = getTheme(themeId ?? getStoredThemeId());
  themeRevision += 1;
  if (typeof document === "undefined") return theme.id;

  const root = document.documentElement;
  root.dataset["theme"] = theme.id;
  root.classList.toggle("dark", theme.mode === "dark");
  root.style.colorScheme = theme.mode;
  for (const [name, value] of Object.entries(theme.colors)) root.style.setProperty(`--${name}`, value);
  for (const [name, value] of Object.entries(legacyPalette)) root.style.setProperty(`--${name}`, value);

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme.id);
    window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
  } catch {
    // Themes still apply when storage is unavailable.
  }
  return theme.id;
}

export function applyThemeIfUnchanged(themeId: unknown, revision: number): boolean {
  if (revision !== themeRevision) return false;
  applyTheme(themeId);
  return true;
}

// Kept as a small compatibility wrapper for callers that only know light/dark.
export function applyThemeMode(mode?: unknown): void {
  applyTheme(mode === "dark" ? "original-dark" : mode === "light" ? "original-light" : undefined);
}
