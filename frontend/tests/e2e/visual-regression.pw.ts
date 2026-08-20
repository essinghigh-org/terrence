import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// kanban 22.15: visual regression snapshots for the settings/admin pages.
// Baselines live next to this file in visual-regression.pw.ts-snapshots/;
// regenerate intentionally with: bunx playwright test --update-snapshots
//
// Runs against the TEST-only systemd box on :3001 (see playwright.config.ts).
// Dynamic regions (relative timestamps, run statuses) are masked so the
// baselines stay stable across runs.
//
// Authentication uses TERRENCE_E2E_ADMIN_TOKEN — a local sandbox-only
// credential for the test instance on 127.0.0.1:3001. Never commit a
// literal token; the specs fail fast if it is unset.

const ADMIN_TOKEN = process.env.TERRENCE_E2E_ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  throw new Error(
    "TERRENCE_E2E_ADMIN_TOKEN is not set. Export the local test-box admin " +
      "session token (e.g. from your .env.local) before running e2e specs.",
  );
}

const PAGES: ReadonlyArray<{ name: string; path: string }> = [
  { name: "admin-security", path: "/app/admin" },
  { name: "admin-operations", path: "/app/admin/operations" },
  { name: "org-workspaces", path: "/app/essinghigh-org/workspaces" },
  { name: "org-change-calendar", path: "/app/essinghigh-org/calendar" },
  { name: "account-settings", path: "/app/account" },
];

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.evaluate((token: string): void => {
    localStorage.setItem("tfe_token", token);
    localStorage.setItem("tfe_refreshable_session", "true");
  }, ADMIN_TOKEN);
});

for (const { name, path } of PAGES) {
  test(`snapshot ${name}`, async ({ page }: { page: Page }): Promise<void> => {
    await page.goto(path, { waitUntil: "networkidle", timeout: 20000 });
    // If auth failed the page redirects to /login; that is a real failure,
    // not a valid admin baseline. Assert we reached the intended page.
    expect(new URL(page.url()).pathname).toBe(path);
    // Let client-side data fetches settle before capturing.
    await page.waitForTimeout(2500);
    await expect(page).toHaveScreenshot(`${name}.png`, {
      // Mask relative-time widgets that shift every minute.
      mask: [
        page.getByText(/^(ago|\d+[sSmMhHdD])\s+(ago|from now)$/).first(),
      ],
    });
  });
}
