/** The browser-test entrypoint owns Chrome; WebViews own only their individual tabs. */
export function chromeBackend(): {
  type: "chrome";
  url: string | false;
  argv?: string[];
  stderr?: "inherit";
} {
  const endpoint = process.env["TERRENCE_TEST_CHROME_URL"];
  if (endpoint) return { type: "chrome", url: endpoint };
  return { type: "chrome", url: false, argv: ["--disable-dev-shm-usage"], stderr: "inherit" };
}
