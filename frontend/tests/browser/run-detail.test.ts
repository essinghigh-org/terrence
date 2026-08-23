import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { createBrowser, type BrowserPage } from "./helpers/browser";
import { startTestServer, type TestServer } from "./helpers/server";
import { injectAuth } from "./helpers/auth";
import { TEST_PATHS } from "./helpers/fixture";

let server: TestServer;
let page: BrowserPage;

const ADMIN_TOKEN = process.env.TERRENCE_E2E_ADMIN_TOKEN;

describe("run-detail smoke tests", () => {
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

  test("run detail page does not crash", async (): Promise<void> => {
    if (!ADMIN_TOKEN) {
      console.warn("Skipping run-detail smoke test: TERRENCE_E2E_ADMIN_TOKEN not set");
      return;
    }
    await page.goto(`${server.baseUrl}${TEST_PATHS.runDetail}`, { waitUntil: "networkidle", timeout: 15000 });
    expect(new URL(page.url).pathname).toBe(TEST_PATHS.runDetail);
    await page.waitForTimeout(3000);
    expect(page.pageErrors).toEqual([]);
  });

  test("workspace page loads without crash", async (): Promise<void> => {
    if (!ADMIN_TOKEN) {
      console.warn("Skipping workspace smoke test: TERRENCE_E2E_ADMIN_TOKEN not set");
      return;
    }
    await page.goto(`${server.baseUrl}${TEST_PATHS.workspace}`, { waitUntil: "networkidle", timeout: 15000 });
    expect(new URL(page.url).pathname).toBe(TEST_PATHS.workspace);
    await page.waitForTimeout(3000);
    expect(page.pageErrors).toEqual([]);
  });
});
