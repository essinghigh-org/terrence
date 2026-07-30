import { test, expect } from "@playwright/test";
import type { Page, ConsoleMessage } from "@playwright/test";

const ADMIN_TOKEN = "terrence-test-pVhq8jdDKeWxwGCotTEMRNdnwsjpg9RU";
const RUN_ID = "423b4c6e-3b0b-4707-94c6-678d80c43f09";

test.beforeEach(async ({ page }: { page: Page }): Promise<void> => {
  // Inject auth token so the page is authenticated
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

  await page.goto(
    `/app/essinghigh-org/workspaces/tf-deploy-github-repository/runs/${RUN_ID}`,
    { waitUntil: "networkidle", timeout: 15000 },
  );

  await page.waitForTimeout(3000);

  expect(errors.filter((e: string): boolean =>
    !e.includes("Failed to load") && !e.includes("404") && !e.includes("Not Found") && !e.includes("ApiError")
  )).toEqual([]);
});

test("workspace page loads without crash", async ({ page }: { page: Page }): Promise<void> => {
  const errors: string[] = [];
  page.on("pageerror", (err: Error): void => { errors.push(err.message); });
  page.on("console", (msg: ConsoleMessage): void => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto(
    "/app/essinghigh-org/workspaces/tf-deploy-github-repository",
    { waitUntil: "networkidle", timeout: 15000 },
  );

  await page.waitForTimeout(3000);
  expect(errors.filter((e: string): boolean =>
    !e.includes("Failed to load") && !e.includes("404") && !e.includes("Not Found") && !e.includes("ApiError")
  )).toEqual([]);
});
