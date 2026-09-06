import { afterAll, beforeAll, expect, test } from "bun:test";
import { createBrowser, type BrowserPage } from "./helpers/browser";
import { startTestServer, type TestServer } from "./helpers/server";
import { authInitStorage } from "./helpers/auth";
import { expectNoA11yViolations } from "./helpers/axe";
import { TEST_PATHS } from "./helpers/fixture";

let server: TestServer;
let page: BrowserPage;
beforeAll(async () => { server = await startTestServer(); page = await createBrowser(); });
afterAll(async () => { page?.close(); await server?.close(); });

async function typeComment(): Promise<void> {
  await page.waitForSelector("#run-comment");
  await page.evaluate(`(() => {
    const input = document.querySelector('#run-comment');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Unsaved browser regression comment');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.waitForSelector('form button[type="submit"]:not([disabled])');
}
async function choose(label: string): Promise<void> {
  await page.waitForSelector('[role="dialog"]');
  await page.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(button => button.textContent === ${JSON.stringify(label)}).click()`);
  await page.waitForSelector('[role="dialog"]', { state: "hidden" });
}

test("built app preserves comments across canceled Back/Forward and discards only after confirmation", async () => {
  await page.goto(`${server.baseUrl}${TEST_PATHS.workspace}`, { initStorage: authInitStorage(), waitUntil: "networkidle", timeout: 15000 });
  await page.waitForSelector(`a[href="${TEST_PATHS.runDetail}"]`);
  await page.click(`a[href="${TEST_PATHS.runDetail}"]`);
  await typeComment();
  await page.evaluate("history.back()");
  await page.waitForSelector('[role="dialog"]');
  await expectNoA11yViolations(page, { filterInputPlaceholderContrast: true });
  await choose("Stay");
  await page.waitForURL(TEST_PATHS.runDetail);
  expect(await page.evaluate<string>("document.querySelector('#run-comment').value")).toBe("Unsaved browser regression comment");
  await page.click(`a[href="${TEST_PATHS.workspace}"]`);
  await choose("Discard and leave");
  await page.waitForSelector("#run-comment", { state: "hidden" });
  expect(await page.evaluate<string>("location.pathname")).toBe(TEST_PATHS.workspace);
  await page.evaluate("history.back()");
  await typeComment();
  await page.evaluate("history.forward()");
  await choose("Stay");
  await page.waitForURL(TEST_PATHS.runDetail);
  expect(await page.evaluate<string>("document.querySelector('#run-comment').value")).toBe("Unsaved browser regression comment");
  await page.evaluate("history.forward()");
  await choose("Discard and leave");
  await page.waitForSelector("#run-comment", { state: "hidden" });
  expect(await page.evaluate<string>("location.pathname")).toBe(TEST_PATHS.workspace);
  await page.collectErrors();
  expect(page.pageErrors).toEqual([]);
}, 30000);
