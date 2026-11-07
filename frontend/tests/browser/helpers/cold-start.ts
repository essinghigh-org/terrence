import { createBrowser, type BrowserPage } from "./browser";
import { WEBVIEW_STARTUP_TITLE, WEBVIEW_STARTUP_URL } from "./webview-lifecycle";

// Run in a fresh Bun process: WebView.close() only closes a tab, and closeAll()
// does not wait for shared Chrome retirement before a new view can be created.
const startedAt = performance.now();
let page: BrowserPage | undefined;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (): Response =>
    new Response("<!doctype html><title>Cold startup fixture</title>", { headers: { "Content-Type": "text/html" } }),
});
try {
  page = await createBrowser();
  if (page.url !== WEBVIEW_STARTUP_URL || (await page.evaluate("document.title")) !== WEBVIEW_STARTUP_TITLE)
    throw new Error("Cold startup did not reach the handshake document");
  await page.addInitScript("window.__terrence_cold_start = true");
  if ((await page.evaluate("window.__terrence_cold_start")) !== undefined)
    throw new Error("Application init script ran on the startup document");
  await page.goto(server.url.toString());
  if ((await page.evaluate("document.title")) !== "Cold startup fixture")
    throw new Error("Cold browser could not navigate to the application fixture");
  if ((await page.evaluate("window.__terrence_cold_start")) !== true)
    throw new Error("Application init script did not run after navigation");
  console.log(
    `Cold browser startup and application navigation passed in ${Math.round(performance.now() - startedAt)}ms`,
  );
} finally {
  page?.close();
  await server.stop(true);
}
