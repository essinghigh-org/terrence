import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

// kanban 22.14: automated accessibility checks using the axe-core engine.
//
// axe resolves aria-labelledby references, applies the real accessible-name
// computation, and correctly classifies tabindex="-1" (programmatically
// focusable) vs. tabindex="0" (keyboard focusable) — which a hand-rolled
// scanner gets wrong.
//
// Run from the frontend directory:
//   npx playwright test tests/e2e/accessibility.pw.ts

// Test-box admin token. Supply TERRENCE_E2E_ADMIN_TOKEN from the environment;
// it is a local sandbox-only credential for the test instance on
// 127.0.0.1:3001, never a production secret. Never commit a literal token.
const ADMIN_TOKEN = process.env.TERRENCE_E2E_ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  throw new Error(
    "TERRENCE_E2E_ADMIN_TOKEN is not set. Export the local test-box admin " +
      "session token (e.g. from your .env.local) before running e2e specs.",
  );
}

const RUN_ID = "423b4c6e-3b0b-4707-94c6-678d80c43f09";

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.evaluate((token: string): void => {
    localStorage.setItem("tfe_token", token);
    localStorage.setItem("tfe_refreshable_session", "true");
  }, ADMIN_TOKEN);
});

async function expectNoA11yViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test("login page has no detectable accessibility violations", async ({ page }: { page: Page }): Promise<void> => {
  await page.goto("/login", { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForTimeout(1000);
  expect(new URL(page.url()).pathname).toBe("/login");
  await expectNoA11yViolations(page);
});

test("workspace page has no detectable accessibility violations", async ({ page }: { page: Page }): Promise<void> => {
  const target = "/app/essinghigh-org/workspaces/tf-deploy-github-repository";
  await page.goto(target, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForTimeout(2000);
  // A redirect to /login would mean auth failed — that is a failure, not a
  // clean page. Assert we actually reached the workspace.
  expect(new URL(page.url()).pathname).toBe(target);
  await expectNoA11yViolations(page);
});

test("run detail page has no detectable accessibility violations", async ({ page }: { page: Page }): Promise<void> => {
  const target = `/app/essinghigh-org/workspaces/tf-deploy-github-repository/runs/${RUN_ID}`;
  await page.goto(target, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForTimeout(2000);
  expect(new URL(page.url()).pathname).toBe(target);
  await expectNoA11yViolations(page);
});
