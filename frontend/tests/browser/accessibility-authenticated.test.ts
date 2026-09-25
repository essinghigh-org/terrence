import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createBrowser, type BrowserPage } from "./helpers/browser";
import { startTestServer, type TestServer } from "./helpers/server";
import { expectNoA11yViolations } from "./helpers/axe";
import { authInitStorage } from "./helpers/auth";
import { TEST_PATHS } from "./helpers/fixture";

let server: TestServer;
let page: BrowserPage;

const ACCESSIBILITY_TEST_TIMEOUT_MS = 30_000;

describe("accessibility-authenticated", () => {
  beforeAll(async (): Promise<void> => {
    server = await startTestServer();
    page = await createBrowser();
  });

  afterAll(async (): Promise<void> => {
    page?.close();
    await server?.close();
  });

  test(
    "login page has no detectable accessibility violations",
    async (): Promise<void> => {
      await page.goto(`${server.baseUrl}/login`, { waitUntil: "networkidle", timeout: 15000 });
      await page.waitForAppReady();
      expect(new URL(page.url).pathname).toBe("/login");
      await expectNoA11yViolations(page, { filterInputPlaceholderContrast: true });
    },
    ACCESSIBILITY_TEST_TIMEOUT_MS,
  );

  test(
    "workspace page has no detectable accessibility violations",
    async (): Promise<void> => {
      await page.goto(`${server.baseUrl}${TEST_PATHS.workspace}`, {
        initStorage: authInitStorage(),
        waitUntil: "networkidle",
        timeout: 15000,
      });
      await page.waitForAppReady();
      expect(new URL(page.url).pathname).toBe(TEST_PATHS.workspace);
      await expectNoA11yViolations(page, { filterInputPlaceholderContrast: true });
    },
    ACCESSIBILITY_TEST_TIMEOUT_MS,
  );

  test(
    "run detail page has no detectable accessibility violations",
    async (): Promise<void> => {
      await page.goto(`${server.baseUrl}${TEST_PATHS.runDetail}`, {
        initStorage: authInitStorage(),
        waitUntil: "networkidle",
        timeout: 15000,
      });
      await page.waitForAppReady();
      expect(new URL(page.url).pathname).toBe(TEST_PATHS.runDetail);
      await expectNoA11yViolations(page, { filterInputPlaceholderContrast: true });
    },
    ACCESSIBILITY_TEST_TIMEOUT_MS,
  );
});
