import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { createBrowser, type BrowserPage } from "./helpers/browser";
import { startTestServer, type TestServer } from "./helpers/server";
import { authInitStorage } from "./helpers/auth";
import { TEST_PATHS } from "./helpers/fixture";
import { compareScreenshots } from "./helpers/image-diff";

let server: TestServer;
let page: BrowserPage;

const PAGES: readonly { name: string; path: string }[] = [
  { name: "admin-security", path: TEST_PATHS.adminSecurity },
  { name: "admin-operations", path: TEST_PATHS.adminOperations },
  { name: "org-workspaces", path: TEST_PATHS.orgWorkspaces },
  { name: "org-change-calendar", path: TEST_PATHS.orgCalendar },
  { name: "account-settings", path: TEST_PATHS.accountSettings },
];

describe("visual regression tests", () => {
  beforeAll(async (): Promise<void> => {
    server = await startTestServer();
    page = await createBrowser({ width: 1280, height: 807 });
  });

  afterAll(async (): Promise<void> => {
    page?.close();
    await server?.close();
  });

  for (const { name, path } of PAGES) {
    test(`snapshot ${name}`, async (): Promise<void> => {
      await page.goto(`${server.baseUrl}${path}`, {
        initStorage: authInitStorage(),
        waitUntil: "networkidle",
        timeout: 20000,
      });
      await page.waitForAppReady();
      expect(new URL(page.url).pathname).toBe(path);

      // Mask dynamic relative timestamps
      await page.evaluate(`
        (async () => {
          const style = document.createElement("style");
          style.textContent = '* { font-family: "DejaVu Sans" !important; }';
          document.head.append(style);
          await document.fonts.ready;

          window.__terrence_masked_ts = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const txt = (node.textContent || "").trim();
            if (txt.includes("ago") || txt.includes("from now") || txt.includes("seconds") || txt.includes("minutes")) {
              if (node.parentElement) {
                window.__terrence_masked_ts.push({
                  el: node.parentElement,
                  prev: node.parentElement.style.visibility
                });
                node.parentElement.style.visibility = "hidden";
              }
            }
          }
        })()
      `);

      let screenshotBuffer: Buffer;
      try {
        screenshotBuffer = await page.screenshot();
      } finally {
        await page.evaluate(`
          (() => {
            if (window.__terrence_masked_ts) {
              window.__terrence_masked_ts.forEach(({ el, prev }) => {
                el.style.visibility = prev;
              });
              delete window.__terrence_masked_ts;
            }
          })()
        `).catch((): undefined => undefined);
      }

      const baselinePath = resolve(import.meta.dir, `./baselines/${name}-${process.platform}.png`);

      const diffResult = await compareScreenshots(page, screenshotBuffer, baselinePath, {
        maxDiffPercentage: 0.1,
        snapshotName: name,
      });

      if (!diffResult.match) {
        throw new Error(
          `Visual regression detected for ${name}: ${diffResult.diffPercentage.toFixed(2)}% pixel mismatch (${diffResult.diffPixels}/${diffResult.totalPixels} pixels)`
        );
      }

      expect(diffResult.match).toBe(true);
    }, 25000);
  }
});
