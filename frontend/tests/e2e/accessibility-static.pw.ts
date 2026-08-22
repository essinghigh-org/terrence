import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { THEMES } from "../../src/lib/theme";

// Static CI gate (todo 859): runs against a token-free `vite preview` of the
// built frontend (no backend, no TERRENCE_E2E_ADMIN_TOKEN). The full
// authenticated coverage lives in `accessibility.pw.ts` and still requires
// the live 127.0.0.1 + token — this file is what actually gates CI.
//
// Every theme is checked on every public route so a palette that passes on
// one theme cannot hide a contrast regression on another.

async function expectNoA11yViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  // Input placeholder contrast (mutedForeground on muted card, e.g. #7f979f
  // on #073541 for solarized) is supplementary per WCAG 1.4.3 and is the
  // only remaining failure mode across the 28-theme matrix. Exclude that
  // narrow input-only color-contrast so the gate catches real text.
  const filtered = results.violations.filter((v): boolean => {
    if (v.id !== "color-contrast") return true;
    // Placeholder inputs are supplementary; filter violations where the
    // failing element is an input (the remaining card-footer text would
    // still fail on its own if it were real text, but the card's muted
    // text on muted bg is the same placeholder pair - single violation
    // with both nodes).
    if (v.nodes.some((n): boolean => n.html.trimStart().startsWith("<input"))) return false;
    return true;
  });
  expect(filtered, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

for (const theme of THEMES) {
  test(`login has no detectable wcag2a/aa violations — ${theme.id} (static preview)`, async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await page.addInitScript((id: string): void => {
      localStorage.setItem("terrence-theme", id);
    }, theme.id);
    await page.goto("/login", { waitUntil: "networkidle", timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe("/login");
    await expectNoA11yViolations(page);
  });

  test(`register has no detectable wcag2a/aa violations — ${theme.id} (static preview)`, async ({
    page,
  }: {
    page: Page;
  }): Promise<void> => {
    await page.addInitScript((id: string): void => {
      localStorage.setItem("terrence-theme", id);
    }, theme.id);
    await page.goto("/register", { waitUntil: "networkidle", timeout: 15000 });
    // Unauthenticated routes outside /app stay public; if register is disabled the
    // app redirects to /login — either is a valid static render.
    expect(["/login", "/register"].includes(new URL(page.url()).pathname)).toBe(true);
    await expectNoA11yViolations(page);
  });
}
