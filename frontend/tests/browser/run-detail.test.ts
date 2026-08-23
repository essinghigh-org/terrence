import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createBrowser, type BrowserPage } from "./helpers/browser";
import { startTestServer, type TestServer } from "./helpers/server";
import { authInitStorage } from "./helpers/auth";
import { TEST_PATHS } from "./helpers/fixture";

let server: TestServer;
let page: BrowserPage;

describe("run-detail smoke tests", () => {
  beforeAll(async (): Promise<void> => {
    server = await startTestServer();
    page = await createBrowser();
  });

  afterAll(async (): Promise<void> => {
    page?.close();
    await server?.close();
  });

  test("run detail page does not crash", async (): Promise<void> => {
    await page.goto(`${server.baseUrl}${TEST_PATHS.runDetail}`, {
      initStorage: authInitStorage(),
      waitUntil: "networkidle",
      timeout: 15000,
    });
    await page.waitForAppReady();
    expect(new URL(page.url).pathname).toBe(TEST_PATHS.runDetail);
    await page.collectErrors();
    expect(page.pageErrors).toEqual([]);
    expect(page.consoleErrors).toEqual([]);
  }, 15000);

  test("workspace page loads without crash", async (): Promise<void> => {
    await page.goto(`${server.baseUrl}${TEST_PATHS.workspace}`, {
      initStorage: authInitStorage(),
      waitUntil: "networkidle",
      timeout: 15000,
    });
    await page.waitForAppReady();
    expect(new URL(page.url).pathname).toBe(TEST_PATHS.workspace);
    await page.collectErrors();
    expect(page.pageErrors).toEqual([]);
    expect(page.consoleErrors).toEqual([]);
  }, 15000);
});
