import { describe, expect, test, beforeAll, afterAll } from "bun:test";
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

describe("accessibility-static: public routes across themes", () => {
  for (const theme of THEMES) {
    test(`login has no detectable wcag2a/aa violations — ${theme.id} (static preview)`, async (): Promise<void> => {
      await page.addInitScript((id: string): void => {
        localStorage.setItem("terrence-theme", id);
      }, theme.id);

      await page.goto(`${server.baseUrl}/login`, { waitUntil: "networkidle", timeout: 15000 });
      const currentPath = new URL(page.url).pathname;
      expect(currentPath).toBe("/login");
      await expectNoA11yViolations(page, { filterInputPlaceholderContrast: true });
    });

    test(`register has no detectable wcag2a/aa violations — ${theme.id} (static preview)`, async (): Promise<void> => {
      await page.addInitScript((id: string): void => {
        localStorage.setItem("terrence-theme", id);
      }, theme.id);

      await page.goto(`${server.baseUrl}/register`, { waitUntil: "networkidle", timeout: 15000 });
      const currentPath = new URL(page.url).pathname;
      expect(["/login", "/register"].includes(currentPath)).toBe(true);
      await expectNoA11yViolations(page, { filterInputPlaceholderContrast: true });
    });
  }
});
