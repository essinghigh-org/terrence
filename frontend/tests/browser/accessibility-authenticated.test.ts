import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { createBrowser, type BrowserPage } from "./helpers/browser";
import { startTestServer, type TestServer } from "./helpers/server";
import { expectNoA11yViolations } from "./helpers/axe";
import { injectAuth, getAdminToken } from "./helpers/auth";
import { TEST_PATHS } from "./helpers/fixture";

let server: TestServer;
let page: BrowserPage;

const ADMIN_TOKEN = process.env.TERRENCE_E2E_ADMIN_TOKEN;

describe("accessibility-authenticated", () => {
  beforeAll(async (): Promise<void> => {
    server = await startTestServer();
    page = await createBrowser();
  });

  afterAll(async (): Promise<void> => {
    page?.close();
    await server?.close();
  });

  beforeEach(async (): Promise<void> => {
    if (!ADMIN_TOKEN) return;
    await page.goto(`${server.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await injectAuth(page, ADMIN_TOKEN);
  });

  test("login page has no detectable accessibility violations", async (): Promise<void> => {
    await page.goto(`${server.baseUrl}/login`, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(1000);
    expect(new URL(page.url).pathname).toBe("/login");
    await expectNoA11yViolations(page, { filterInputPlaceholderContrast: true });
  });

  test("workspace page has no detectable accessibility violations", async (): Promise<void> => {
    if (!ADMIN_TOKEN) {
      console.warn("Skipping authenticated workspace a11y test: TERRENCE_E2E_ADMIN_TOKEN not set");
      return;
    }
    await page.goto(`${server.baseUrl}${TEST_PATHS.workspace}`, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(2000);
    expect(new URL(page.url).pathname).toBe(TEST_PATHS.workspace);
    await expectNoA11yViolations(page, { filterInputPlaceholderContrast: true });
  });

  test("run detail page has no detectable accessibility violations", async (): Promise<void> => {
    if (!ADMIN_TOKEN) {
      console.warn("Skipping authenticated run detail a11y test: TERRENCE_E2E_ADMIN_TOKEN not set");
      return;
    }
    await page.goto(`${server.baseUrl}${TEST_PATHS.runDetail}`, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(2000);
    expect(new URL(page.url).pathname).toBe(TEST_PATHS.runDetail);
    await expectNoA11yViolations(page, { filterInputPlaceholderContrast: true });
  });
});
