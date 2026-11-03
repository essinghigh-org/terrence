import { afterAll, beforeAll, expect, test } from "bun:test";
import { createBrowser, type BrowserPage } from "./helpers/browser";
import { startTestServer, type TestServer } from "./helpers/server";
import { authInitStorage } from "./helpers/auth";
import { expectNoA11yViolations } from "./helpers/axe";

let server: TestServer;
let page: BrowserPage;
beforeAll(async () => {
  server = await startTestServer();
  page = await createBrowser();
  await page.addInitScript(`(() => {
    const originalFetch = window.fetch.bind(window);
    let banner = null;
    let customization = { footer: 'Instance footer', 'login-help': 'Contact your administrator', 'avatar-sources': [{ source: 'gravatar', enabled: false }] };
    window.fetch = async (input, options = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.origin).pathname;
      const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/vnd.api+json' } });
      if (path === '/api/v2/site-presentation') return json({ data: { attributes: { ...customization, 'gravatar-enabled': false, banner } } });
      if (path === '/api/v2/admin/customization-settings') {
        if (options.method === 'PATCH') customization = JSON.parse(options.body).data.attributes;
        return json({ data: { attributes: customization } });
      }
      if (path.startsWith('/api/v2/admin/banners')) {
        if (options.method === 'POST' || options.method === 'PATCH') {
          banner = { id: 'banner-browser', attributes: JSON.parse(options.body).data.attributes };
          return json({ data: banner });
        }
        if (options.method === 'DELETE') { banner = null; return new Response(null, { status: 204 }); }
        return json({ data: banner === null ? [] : [banner] });
      }
      return originalFetch(input, options);
    };
  })()`);
}, 25_000);
afterAll(async () => {
  page?.close();
  await server?.close();
});

test("appearance changes render in the built application with accessible controls", async () => {
  await page.goto(`${server.baseUrl}/app/admin/appearance`, {
    initStorage: authInitStorage(),
    waitUntil: "networkidle",
    timeout: 15000,
  });
  await page.waitForSelector("#banner-title");
  await page.fill("#banner-title", "Maintenance notice");
  await page.fill("#banner-body", "<strong>Saved announcement</strong>");
  await expectNoA11yViolations(page, { filterInputPlaceholderContrast: true });
  await page.evaluate(
    `Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Save announcement').click()`,
  );
  await page.waitForSelector('[aria-label="Site announcement"]');
  expect(
    await page.evaluate<string>(`document.querySelector('[aria-label="Site announcement"]').textContent`),
  ).toContain("Maintenance notice");
  expect(
    await page.evaluate<string>(
      `document.querySelector('[aria-label="Site announcement"] strong:last-child').textContent`,
    ),
  ).toBe("Saved announcement");
  await page.fill("#customization-footer", "Updated footer");
  await page.evaluate(
    `Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Save customization').click()`,
  );
  await page.waitForSelector("footer");
  // Saving invalidates the presentation cache without requiring a reload.
  await page.evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () => {
      if (document.querySelector('footer')?.textContent.includes('Updated footer')) return resolve(true);
      if (Date.now() >= deadline) return reject(new Error('Footer did not update'));
      setTimeout(check, 25);
    };
    check();
  })`);
  await page.collectErrors();
  expect(page.pageErrors).toEqual([]);
}, 30_000);
