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
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
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
