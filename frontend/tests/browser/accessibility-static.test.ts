import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { createBrowser, type BrowserPage } from "./helpers/browser";
import { startStaticServer, type TestServer } from "./helpers/server";
import { expectNoA11yViolations } from "./helpers/axe";
import { THEMES } from "../../src/lib/theme";

// Static CI gate: runs against a token-free static preview of the built frontend.
// Every theme is checked on public routes (/login, /register) to prevent contrast regressions.

let server: TestServer;
let page: BrowserPage;

beforeAll(async (): Promise<void> => {
  server = await startStaticServer();
  page = await createBrowser();
});

afterAll(async (): Promise<void> => {
  page?.close();
  await server?.close();
});

afterEach(async (): Promise<void> => {
  await page.clearInitScripts();
});

describe("accessibility-static: public routes across themes", () => {
  for (const theme of THEMES) {
    test(`login has no detectable wcag2a/aa violations — ${theme.id} (static preview)`, async (): Promise<void> => {
      await page.goto(`${server.baseUrl}/login`, {
        initStorage: { "terrence-theme": theme.id },
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      await page.waitForAppReady();

      const activeTheme = await page.evaluate<string>("document.documentElement.dataset.theme");
      expect(activeTheme).toBe(theme.id);

      const currentPath = new URL(page.url).pathname;
      expect(currentPath).toBe("/login");
      await expectNoA11yViolations(page, { filterInputPlaceholderContrast: true });
    }, 15000);

    test(`register has no detectable wcag2a/aa violations — ${theme.id} (static preview)`, async (): Promise<void> => {
      await page.goto(`${server.baseUrl}/register`, {
        initStorage: { "terrence-theme": theme.id },
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      await page.waitForAppReady();

      const activeTheme = await page.evaluate<string>("document.documentElement.dataset.theme");
      expect(activeTheme).toBe(theme.id);

      const currentPath = new URL(page.url).pathname;
      expect(["/login", "/register"].includes(currentPath)).toBe(true);
      await expectNoA11yViolations(page, { filterInputPlaceholderContrast: true });
    }, 15000);
  }
});


test("standalone 404 stays accessible and fits a mobile viewport", async (): Promise<void> => {
  const mobile = await createBrowser({ width: 390, height: 844 });
  try {
    await mobile.goto(`${server.baseUrl}/404.html`);
    expect(await mobile.evaluate<string>("document.querySelector('h1')?.textContent")).toBe("Page not found");
    expect(await mobile.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    expect(await mobile.evaluate<number>("document.querySelectorAll('script').length")).toBe(0);
    await expectNoA11yViolations(mobile);
  } finally {
    mobile.close();
  }
}, 15000);
