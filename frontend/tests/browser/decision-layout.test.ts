import { expect, test } from "bun:test";
import { createBrowser } from "./helpers/browser";
import { startTestServer } from "./helpers/server";
import { authInitStorage } from "./helpers/auth";
import { TEST_PATHS } from "./helpers/fixture";

test("confirmation sidebar keeps text readable and scrolls with its context", async () => {
  const server = await startTestServer();
  const page = await createBrowser({ width: 1440, height: 900 });
  try {
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args);
        const url = new URL(args[0] instanceof Request ? args[0].url : args[0], window.location.origin);
        if (!/^\/api\/v2\/runs\/[^/]+$/.test(url.pathname)) return response;
        const body = await response.clone().json();
        body.data.attributes.status = "planned";
        body.data.attributes.actions["is-confirmable"] = true;
        body.data.attributes.actions["is-discardable"] = true;
        return new Response(JSON.stringify(body), { headers: response.headers });
      }, original);
    });
    await page.goto(`${server.baseUrl}${TEST_PATHS.runDetail}`, { initStorage: authInitStorage(), waitUntil: "networkidle" });
    await page.waitForSelector("[data-decision-rail]");
    const layout = await page.evaluate<{ textWidth: number; buttonsBelow: boolean; sticky: boolean; overflows: boolean }>(`(() => {
      const panel = document.querySelector('[data-decision-rail]');
      const heading = panel.querySelector('h2');
      const detail = heading.nextElementSibling;
      const button = panel.querySelector('button');
      return {
        textWidth: heading.getBoundingClientRect().width,
        buttonsBelow: button.getBoundingClientRect().top >= detail.getBoundingClientRect().bottom,
        sticky: getComputedStyle(panel.parentElement).position === 'sticky',
        overflows: panel.scrollWidth > panel.clientWidth,
      };
    })()`);
    expect(layout.textWidth).toBeGreaterThan(180);
    expect(layout.buttonsBelow).toBe(true);
    expect(layout.sticky).toBe(false);
    expect(layout.overflows).toBe(false);
    await Bun.write("/tmp/terrence-run-layout.png", await page.screenshot());
  } finally {
    page.close();
    await server.close();
  }
}, 30000);
