import { test, expect } from "@playwright/test";
import type { Page, ConsoleMessage } from "@playwright/test";

// kanban 22.x: smoke-test that the run-detail and workspace pages render
// without uncaught errors against the local TEST-only systemd box on :3001
// (see playwright.config.ts).
//
// Authentication uses the box's sandbox-only admin session token. Supply it
// via TERRENCE_E2E_ADMIN_TOKEN — never commit a real token. Without it the
// tests cannot authenticate and fail fast with a clear message.
const ADMIN_TOKEN = process.env.TERRENCE_E2E_ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  throw new Error(
    "TERRENCE_E2E_ADMIN_TOKEN is not set. Export the local test-box admin " +
      "session token (e.g. from your .env.local) before running e2e specs.",
  );
}

const RUN_PATH = "/app/essinghigh-org/workspaces/tf-deploy-github-repository/runs/423b4c6e-3b0b-4707-94c6-678d80c43f09";
const WORKSPACE_PATH = "/app/essinghigh-org/workspaces/tf-deploy-github-repository";

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  // Inject auth token so the page is authenticated.
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.evaluate((token: string): void => {
    localStorage.setItem("tfe_token", token);
    localStorage.setItem("tfe_refreshable_session", "true");
  }, ADMIN_TOKEN);
});

test("run detail page does not crash", async ({ page }: { page: Page }): Promise<void> => {
  const errors: string[] = [];
  page.on("pageerror", (err: Error): void => { errors.push(err.message); });
  page.on("console", (msg: ConsoleMessage): void => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto(RUN_PATH, { waitUntil: "networkidle", timeout: 15000 });
  // The target must load; a redirect to /login (bad token / missing run)
  // is itself a failure, not a benign console error.
  expect(new URL(page.url()).pathname).toBe(RUN_PATH);
  await page.waitForTimeout(3000);

  expect(errors, errors.join("\n")).toEqual([]);
});

test("workspace page loads without crash", async ({ page }: { page: Page }): Promise<void> => {
  const errors: string[] = [];
  page.on("pageerror", (err: Error): void => { errors.push(err.message); });
  page.on("console", (msg: ConsoleMessage): void => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto(WORKSPACE_PATH, { waitUntil: "networkidle", timeout: 15000 });
  expect(new URL(page.url()).pathname).toBe(WORKSPACE_PATH);
  await page.waitForTimeout(3000);
  expect(errors, errors.join("\n")).toEqual([]);
});
