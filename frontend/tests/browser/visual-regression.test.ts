import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { resolve } from "node:path";
import { createBrowser, type BrowserPage } from "./helpers/browser";
import { startTestServer, type TestServer } from "./helpers/server";
import { injectAuth } from "./helpers/auth";
import { compareScreenshots } from "./helpers/image-diff";

let server: TestServer;
let page: BrowserPage;

const ADMIN_TOKEN = process.env.TERRENCE_E2E_ADMIN_TOKEN;

const PAGES: readonly { name: string; path: string }[] = [
  { name: "admin-security", path: "/app/admin" },
  { name: "admin-operations", path: "/app/admin/operations" },
  { name: "org-workspaces", path: "/app/essinghigh-org/workspaces" },
  { name: "org-change-calendar", path: "/app/essinghigh-org/calendar" },
  { name: "account-settings", path: "/app/account" },
];

describe("visual regression tests", () => {
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

  for (const { name, path } of PAGES) {
    test(`snapshot ${name}`, async (): Promise<void> => {
      if (!ADMIN_TOKEN) {
        console.warn(`Skipping visual regression snapshot for ${name}: TERRENCE_E2E_ADMIN_TOKEN not set`);
        return;
      }

      await page.goto(`${server.baseUrl}${path}`, { waitUntil: "networkidle", timeout: 20000 });
      expect(new URL(page.url).pathname).toBe(path);

      // Let client-side rendering and data fetches settle
      await page.waitForTimeout(2500);

      // Mask relative timestamps
      await page.evaluate(`
        (() => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          const regex = /^(ago|\\d+[sSmMhHdD])\\s+(ago|from now)$/;
          const toHide = [];
          while ((node = walker.nextNode())) {
            if (regex.test(node.textContent ? node.textContent.trim() : "")) {
              if (node.parentElement) toHide.push(node.parentElement);
            }
          }
          toHide.forEach((el) => {
            el.style.visibility = "hidden";
          });
        })()
      `);

      const screenshotBuffer = await page.screenshot();
      const baselinePath = resolve(import.meta.dir, `./baselines/${name}-linux.png`);

      const diffResult = await compareScreenshots(page, screenshotBuffer, baselinePath, {
        maxDiffPercentage: 0.1,
      });

      expect(diffResult.match).toBe(true, `Visual regression detected for ${name}: ${diffResult.diffPercentage.toFixed(2)}% pixel mismatch (${diffResult.diffPixels}/${diffResult.totalPixels} pixels)`);
    });
  }
});
